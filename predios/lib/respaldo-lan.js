"use strict";

// Réplicas completas de SQLite bajo autoridad de un testigo persistente. Este
// módulo nunca reemplaza una base abierta ni considera un heartbeat una elección.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { performance } = require("node:perf_hooks");
const { NOMBRES_TABLAS } = require("./esquema");
const { normalizarBusqueda } = require("./util");
const { firmarAckReplica } = require("./protocolo-lan");

const MAGIC = Buffer.from("AJBLAN01");
const MAX_DB = 300 * 1024 * 1024;
const USO_MS = 5000;
const LOCALES = ["predio_meta", "predio_outbox", "predio_secuencia", "predio_sesion", "predio_comando_ejecutado", "predio_peticion"];
const META_FISICA = ["equipo_propietario_id", "control_confirmado", "control_conflicto", "restauracion_pendiente"];
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
// Cambiar el formato de recuperación también cambia el modelo aunque las tablas
// comerciales permanezcan iguales. CSS y otras versiones de código no lo alteran.
function modeloDeEsquema(contenido) { return sha("AJB_LAN_MODELO_1\n" + String(contenido).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")); }
const MODELO_ACTUAL = modeloDeEsquema(fs.readFileSync(require.resolve("./esquema"), "utf8"));
const MENSAJE_MODELO = "Actualizá esta PC para que el respaldo automático pueda usar la última copia. Su modelo de datos no coincide con el del servidor actual.";
const igual = (a, b) => !!a && !!b && a.indice === b.indice && a.sha256 === b.sha256;
const revision = m => ({ indice: m.indice, sha256: m.sha256 });
const valido = r => r && Number.isSafeInteger(r.indice) && r.indice >= 0 && /^[a-f0-9]{64}$/.test(r.sha256 || "");
const jsonCanonico = x => JSON.stringify(x, Object.keys(x).sort());

function error(mensaje, codigo = "RESPALDO_LAN_NO_DISPONIBLE") {
  return Object.assign(new Error(mensaje), { status: 503, codigo });
}
function configuracion(base, config) {
  let c = config?.respaldo_lan;
  if (!c && fs.existsSync(path.join(base, "predio-ha.json"))) c = JSON.parse(fs.readFileSync(path.join(base, "predio-ha.json"), "utf8").replace(/^\uFEFF/, ""));
  if (!c?.habilitado) return { habilitado: false };
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(c.grupoId || "") || !/^[a-zA-Z0-9._-]{1,128}$/.test(c.nodoId || "")
    || !/^[a-f0-9]{64}$/.test(c.clave || "") || !/^[a-f0-9]{64}$/.test(c.claveDatos || "")) throw error("La identidad o las claves del grupo LAN no son válidas");
  if (!Array.isArray(c.miembros) || !c.miembros.some(m => m.id === c.nodoId) || new Set(c.miembros.map(m => m.id)).size !== c.miembros.length) throw error("El nodo no pertenece al grupo LAN configurado");
  if (c.miembros.some(m => !/^[a-zA-Z0-9._-]{1,128}$/.test(m.id || ""))) throw error("Hay un miembro LAN inválido");
  return { ...c, predioId: Number(config.predio_id) };
}
function carpeta(base) { return path.join(base, "ha"); }
function sincronizarDirectorio(dir) {
  if (process.platform === "win32") return; // Windows no admite fsync de directorios vía fs.
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function escribirDurable(archivo, buffer, reemplazar = false) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true, mode: 0o700 });
  const temporal = reemplazar ? archivo + ".tmp-" + crypto.randomBytes(8).toString("hex") : archivo;
  let fd;
  try {
    fd = fs.openSync(temporal, "wx", 0o600);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (reemplazar) fs.renameSync(temporal, archivo);
    sincronizarDirectorio(path.dirname(archivo));
  } catch (e) {
    if (fd !== undefined) fs.closeSync(fd);
    if (reemplazar) try { fs.unlinkSync(temporal); } catch (_e) { /* no creado */ }
    throw e;
  }
}
function leerEstado(base, c) {
  const archivo = path.join(carpeta(base), "estado.json");
  if (!fs.existsSync(archivo)) return { formato: 1, grupoId: c.grupoId, nodoId: c.nodoId, confirmada: null, instalada: null };
  const s = JSON.parse(fs.readFileSync(archivo, "utf8"));
  if (s.grupoId !== c.grupoId || s.nodoId !== c.nodoId) throw error("El estado LAN pertenece a otro nodo: no se activa una carpeta copiada");
  return s;
}
function guardarEstado(base, s) { escribirDurable(path.join(carpeta(base), "estado.json"), Buffer.from(JSON.stringify(s)), true); }
function leerFisicos(conexion) {
  return Object.fromEntries(META_FISICA.map(clave => [clave, conexion.prepare("SELECT valor FROM predio_meta WHERE clave=?").get(clave)?.valor ?? null]));
}
function guardarFisicos(base, c, meta) {
  escribirDurable(path.join(carpeta(base), "identidad-local.json"), Buffer.from(JSON.stringify({ grupoId: c.grupoId, nodoId: c.nodoId, meta })), true);
}
function fisicosGuardados(base, c) {
  const archivo = path.join(carpeta(base), "identidad-local.json");
  if (!fs.existsSync(archivo)) return null;
  const r = JSON.parse(fs.readFileSync(archivo, "utf8"));
  if (r.grupoId !== c.grupoId || r.nodoId !== c.nodoId || !r.meta) throw error("La identidad física guardada pertenece a otro nodo");
  return Object.fromEntries(META_FISICA.map(k => [k, typeof r.meta[k] === "string" ? r.meta[k] : null]));
}
function nombreSnapshot(r) {
  if (!valido(r)) throw error("La revisión del respaldo no es válida");
  return `${r.indice}-${r.sha256}.ajblan`;
}
function archivoSnapshot(base, r) { return path.join(carpeta(base), "copias", nombreSnapshot(r)); }
function inspeccionar(archivo, predioId, compatible = true) {
  const { DatabaseSync } = require("node:sqlite");
  const d = new DatabaseSync(archivo, { readOnly: true });
  try {
    d.function("norm", { deterministic: true }, v => v == null ? null : normalizarBusqueda(v));
    const check = d.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw error("La copia LAN no supera la verificación SQLite");
    const tablas = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
    if (compatible) for (const t of [...NOMBRES_TABLAS, ...LOCALES]) if (!tablas.has(t)) throw error("La copia LAN está incompleta: falta " + t);
    // Otro modelo se puede custodiar sin entender sus tablas. Se comprueba su
    // integridad y pertenencia, pero nunca se instala hasta tener código compatible.
    for (const t of tablas) {
      const nombre = '"' + t.replace(/"/g, '""') + '"';
      if (d.prepare(`PRAGMA table_info(${nombre})`).all().some(c => c.name === "predio_id")
        && d.prepare(`SELECT predio_id FROM ${nombre} WHERE predio_id <> ? LIMIT 1`).get(predioId)) throw error("La copia LAN contiene datos de otro predio");
    }
  } finally { d.close(); }
}
function validarManifest(m, c) {
  if (!m || m.formato !== 1 || m.grupoId !== c.grupoId || m.predioId !== c.predioId || !c.miembros.some(n => n.id === m.nodoId)
    || !/^[a-f0-9]{64}$/.test(m.modelo || "") || !Number.isSafeInteger(m.termino) || m.termino < 0 || !valido(m) || !Number.isSafeInteger(m.bytes) || m.bytes <= 0 || m.bytes > MAX_DB) throw error("El manifiesto LAN no corresponde al grupo y al predio");
}
function cifrar(dbBuffer, manifest, c) {
  const header = Buffer.from(jsonCanonico(manifest));
  const longitud = Buffer.alloc(4); longitud.writeUInt32BE(header.length);
  const iv = crypto.randomBytes(12), aad = Buffer.concat([MAGIC, longitud, header]);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(c.claveDatos, "hex"), iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(zlib.gzipSync(dbBuffer)), cipher.final()]);
  return Buffer.concat([aad, iv, cipher.getAuthTag(), encrypted]);
}
function abrir(buffer, c, externo) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64 || buffer.length > MAX_DB + 1024 * 1024 || !buffer.subarray(0, 8).equals(MAGIC)) throw error("El archivo LAN no es válido");
  const n = buffer.readUInt32BE(8), offset = 12 + n;
  if (n > 8192 || offset + 28 >= buffer.length) throw error("La cabecera LAN no es válida");
  let manifest, data;
  try {
    manifest = JSON.parse(buffer.subarray(12, offset).toString("utf8"));
    validarManifest(manifest, c);
    if (externo && jsonCanonico(externo) !== jsonCanonico(manifest)) throw error("El manifiesto no coincide con la copia cifrada");
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(c.claveDatos, "hex"), buffer.subarray(offset, offset + 12));
    decipher.setAAD(buffer.subarray(0, offset));
    decipher.setAuthTag(buffer.subarray(offset + 12, offset + 28));
    const gzip = Buffer.concat([decipher.update(buffer.subarray(offset + 28)), decipher.final()]);
    data = zlib.gunzipSync(gzip, { maxOutputLength: MAX_DB });
  } catch (e) { throw error("La copia LAN no se pudo autenticar o descifrar"); }
  if (data.length !== manifest.bytes || sha(data) !== manifest.sha256) throw error("La copia LAN no coincide con su índice y hash");
  return { manifest, data };
}
function guardarCopia(base, c, packet) {
  const decoded = abrir(packet.buffer, c, packet.manifest);
  const tmp = path.join(carpeta(base), ".validar-" + crypto.randomBytes(12).toString("hex") + ".db");
  fs.mkdirSync(carpeta(base), { recursive: true, mode: 0o700 });
  try {
    escribirDurable(tmp, decoded.data);
    inspeccionar(tmp, c.predioId, decoded.manifest.modelo === MODELO_ACTUAL);
    const final = archivoSnapshot(base, decoded.manifest);
    if (fs.existsSync(final)) {
      const existente = abrir(fs.readFileSync(final), c);
      if (!igual(existente.manifest, decoded.manifest) || existente.manifest.modelo !== decoded.manifest.modelo) throw error("Ya existe una copia distinta para esa revisión y modelo");
    } else escribirDurable(final, packet.buffer);
  } finally { try { fs.unlinkSync(tmp); } catch (_e) { /* no creado */ } }
  return decoded.manifest;
}

// Se invoca después de COMMIT, con el candado SQLite YA tomado. No usa exclusivo.
function crearSnapshotDirecta({ db, base, config, indice, termino = 0, nodoId }) {
  const c = configuracion(base, config);
  if (!c.habilitado) throw error("El grupo LAN está deshabilitado");
  fs.mkdirSync(carpeta(base), { recursive: true, mode: 0o700 });
  const tmp = path.join(carpeta(base), ".snapshot-" + crypto.randomBytes(12).toString("hex") + ".db");
  try {
    db.conexion.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    inspeccionar(tmp, c.predioId);
    const raw = fs.readFileSync(tmp);
    if (raw.length > MAX_DB) throw error("La base LAN excede el límite permitido");
    const manifest = { formato: 1, modelo: MODELO_ACTUAL, grupoId: c.grupoId, predioId: c.predioId, nodoId: nodoId || c.nodoId, termino, indice, sha256: sha(raw), bytes: raw.length, generado: new Date().toISOString() };
    validarManifest(manifest, c);
    return { manifest, buffer: cifrar(raw, manifest, c) };
  } finally { try { fs.unlinkSync(tmp); } catch (_e) { /* no creado */ } }
}

function crearRespaldoLan({ base, config, db, transporte = {}, alActivar = () => {}, alCambio = () => {}, log = () => {}, ahora = Date.now, monotono = () => performance.now(), snapshotDirecta } = {}) {
  const c = configuracion(base, config);
  if (!c.habilitado) return { estado: () => ({ habilitado: false, escritor: true }), antesTransaccion: async () => {}, antesCommit() {}, despuesTransaccion: async () => {}, abortarTransaccion() {}, iniciar() {}, detener() {}, sondear: async () => {} };
  if (!fisicosGuardados(base, c)) guardarFisicos(base, c, leerFisicos(db.conexion));
  let disco = leerEstado(base, c), permiso = null, enCurso = false, drenando = false, fenced = false, detenido = false, timer = null, sondeo = null;
  let ultimoTestigo = null, errorActual = null, activando = false;
  const modelos = new Map();
  let otros = c.miembros.filter(m => m.id !== c.nodoId);
  const snapshot = snapshotDirecta || (datos => crearSnapshotDirecta({ db, base, config, ...datos }));
  function emitir(tipo, extra = {}) { Promise.resolve().then(() => alCambio({ tipo, grupoId: c.grupoId, nodoId: c.nodoId, ...extra })).catch(e => log(e.message)); }
  function guardar() { guardarEstado(base, disco); }
  function vivo() { return !!permiso && monotono() >= permiso.inicioMono && monotono() - permiso.inicioMono < permiso.duracion && ahora() >= permiso.inicioWall && ahora() - permiso.inicioWall < permiso.duracion; }
  function bloquear(e) {
    permiso = null; fenced = true; errorActual = e.message;
    emitir("ESCRITURA_BLOQUEADA", { motivo: e.message });
    return e;
  }
  function exigirModelo(rev) {
    if (modeloDe(rev) !== MODELO_ACTUAL) throw error(MENSAJE_MODELO, "RESPALDO_LAN_MODELO_INCOMPATIBLE");
  }
  function modeloDe(rev) {
    if (!valido(rev)) return null;
    const clave = `${rev.indice}:${rev.sha256}`;
    if (!modelos.has(clave)) obtenerSnapshot(rev);
    return modelos.get(clave);
  }
  function custodiar(packet) {
    const m = guardarCopia(base, c, packet);
    modelos.set(`${m.indice}:${m.sha256}`, m.modelo);
    return m;
  }
  function exigir() {
    exigirModelo(disco.confirmada);
    if (fenced || detenido || !vivo()) throw bloquear(error("El permiso del testigo venció o la copia necesaria no está disponible"));
  }
  async function testigo(accion, payload = {}) {
    if (typeof transporte.testigo !== "function") throw error("Falta conectar el testigo LAN");
    const enviado = monotono();
    const recibida = await transporte.testigo(accion, payload);
    const estado = recibida?.estado || recibida;
    const r = estado && typeof estado.escritor === "object" ? { ...estado, escritor: estado.escritor?.id || null,
      vence_en_ms: estado.escritor ? Math.max(0, Number(estado.vence_ms) - Number(estado.emitido_ms) - (monotono() - enviado)) : 0 } : estado;
    if (accion === "estado" && monotono() - enviado >= USO_MS) throw error("La respuesta del testigo llegó demasiado tarde");
    if (!r || !valido(r.ultimo) || !Number.isSafeInteger(r.termino)) throw error("El testigo devolvió un estado inválido");
    if (accion === "estado" && Array.isArray(r.miembros)) {
      // El transporte ya verificó firma y desafío del testigo. La lista pública
      // puede incorporar respaldos nuevos sin publicar sus claves en el líder.
      const ids = new Set();
      const lista = r.miembros.map(m => {
        const u = new URL(m.url);
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(m.id || "") || ids.has(m.id) || !["http:", "https:"].includes(u.protocol) || u.username || u.password || u.hash || u.search || !["", "/"].includes(u.pathname)) throw error("El testigo devolvió miembros no válidos");
        ids.add(m.id);
        let caPublica;
        if (m.caPublica) {
          if (typeof m.caPublica !== "string" || m.caPublica.length > 65536) throw error("El certificado público del respaldo no es válido");
          try { caPublica = new crypto.X509Certificate(m.caPublica).toString(); }
          catch (_e) { throw error("El certificado público del respaldo no es válido"); }
        }
        return { id: m.id, nombre: String(m.nombre || m.id), url: u.origin, preferido: m.id === r.preferido_id, ...(caPublica ? { caPublica } : {}) };
      });
      if (!lista.length || lista.length > 20 || !ids.has(c.nodoId)) throw bloquear(error("Este nodo ya no pertenece al grupo LAN"));
      c.miembros = lista;
      otros = lista.filter(m => m.id !== c.nodoId);
    }
    ultimoTestigo = r;
    return r;
  }
  async function pedirPermiso(accion, rev) {
    exigirModelo(rev);
    const inicioMono = monotono(), inicioWall = ahora();
    const r = await testigo(accion, { nodoId: c.nodoId, termino: permiso?.termino, revision: rev });
    const duracion = Math.min(USO_MS, Number(r.uso_maximo_ms) || USO_MS);
    if (!r.autorizado || r.escritor !== c.nodoId || monotono() - inicioMono >= duracion || ahora() - inicioWall >= duracion || !igual(r.ultimo, rev)) throw error("El testigo no autorizó esta revisión como escritor");
    permiso = { termino: r.termino, inicioMono, inicioWall, duracion };
    return r;
  }
  async function asegurarPermiso() {
    if (fenced || detenido || !permiso) exigir();
    if (!vivo()) {
      // Renovar sólo el término existente mientras el testigo aún lo reconoce.
      // Nunca solicitar una autoridad nueva para rescatar un COMMIT pendiente.
      const termino = permiso.termino;
      await pedirPermiso("renovar", disco.confirmada);
      if (permiso.termino !== termino) throw bloquear(error("La autoridad cambió mientras se renovaba la operación"));
    }
    exigir();
  }
  function obtenerSnapshot(rev) {
    const buffer = fs.readFileSync(archivoSnapshot(base, rev));
    const decoded = abrir(buffer, c);
    if (!igual(decoded.manifest, rev)) throw error("La revisión guardada no coincide con la pedida");
    modelos.set(`${rev.indice}:${rev.sha256}`, decoded.manifest.modelo);
    return { manifest: decoded.manifest, buffer };
  }
  function copiaDelEscritor(rev) {
    const packet = obtenerSnapshot(rev);
    const decoded = abrir(packet.buffer, c);
    const manifest = { ...decoded.manifest, nodoId: c.nodoId, termino: permiso.termino };
    return { manifest, buffer: cifrar(decoded.data, manifest, c) };
  }
  function tiene(rev) { try { obtenerSnapshot(rev); return true; } catch (_e) { return false; } }
  async function consultarCopia(rev, consultar) {
    let packet;
    try { packet = obtenerSnapshot(rev); }
    catch (_e) { throw error("La caja no puede leer la última copia confirmada. El relevo sigue bloqueado."); }
    exigirModelo(rev);
    const archivo = path.join(carpeta(base), "relevo-manual", ".consultar-" + crypto.randomBytes(12).toString("hex") + ".db");
    const { DatabaseSync } = require("node:sqlite");
    let copia;
    try {
      escribirDurable(archivo, abrir(packet.buffer, c).data);
      copia = new DatabaseSync(archivo, { readOnly: true });
      return await consultar({ get: (sql, parametros) => copia.prepare(sql).get(...parametros), tx: async () => {} });
    } finally {
      copia?.close();
      fs.rmSync(archivo, { force: true });
    }
  }
  function confirmarLocal(rev) {
    if (!tiene(rev)) throw error("Falta la copia durable exacta de la revisión del testigo");
    if (disco.confirmada && (rev.indice < disco.confirmada.indice || (rev.indice === disco.confirmada.indice && rev.sha256 !== disco.confirmada.sha256))) throw error("La revisión confirmada del nodo no puede retroceder ni cambiar de hash");
    if (igual(disco.confirmada, rev)) return;
    disco.confirmada = { ...revision(rev) };
    if (!disco.pendiente || disco.pendiente.indice <= rev.indice) disco.pendiente = null;
    guardar();
  }
  function registrarInicial(packet) {
    if (enCurso || permiso || (disco.confirmada?.indice || 0) > 0 || (disco.pendiente?.indice || 0) > 0) throw error("No se puede reinicializar un grupo que ya operó");
    const m = packet?.manifest;
    if (!m || m.indice !== 0 || m.termino !== 0 || m.nodoId !== c.nodoId) throw error("La copia inicial debe provenir de la base congelada de este nodo");
    if (m.modelo !== MODELO_ACTUAL) throw error(MENSAJE_MODELO, "RESPALDO_LAN_MODELO_INCOMPATIBLE");
    custodiar(packet);
    disco.confirmada = revision(m); disco.instalada = revision(m); disco.pendiente = null; disco.activacionPendiente = null; disco.degradado = false;
    guardar();
    fenced = false; errorActual = null;
    return { registrado: true, revision: revision(m) };
  }
  async function recibirInicial(packet, { remitenteId } = {}) {
    const decoded = abrir(packet.buffer, c, packet.manifest), m = decoded.manifest;
    // Un equipo preparado para el grupo espera la semilla antes de iniciar Raft.
    const w = config.respaldo_lan?.quorumPendiente
      ? { preferido_id: c.miembros.find(n => n.preferido)?.id, termino: 0, escritor: null, ultimo: { indice: 0, sha256: "0".repeat(64) } }
      : await testigo("estado");
    const repetida = igual(disco.confirmada, m) && (!disco.pendiente || igual(disco.pendiente, m));
    if (m.indice !== 0 || m.termino !== 0 || m.nodoId !== remitenteId || m.nodoId !== w.preferido_id || m.nodoId === c.nodoId
      || w.termino !== 0 || w.escritor !== null || w.ultimo.indice !== 0 || (w.ultimo.sha256 !== "0".repeat(64) && !(repetida && igual(w.ultimo, m)))
      || (disco.confirmada && !repetida) || disco.pendiente?.indice > 0 || permiso || enCurso) throw error("El testigo no acredita la preparación inicial de este respaldo");
    custodiar(packet);
    disco.confirmada = revision(m); disco.pendiente = null; guardar();
    // La copia no corresponde a la SQLite abierta del receptor: instalada queda
    // intacta. La activación requiere observar después la huella real del testigo.
    return { guardado: true, inicial: true, revision: revision(m) };
  }
  async function recibirSnapshot(packet, { remitenteId } = {}) {
    const decoded = abrir(packet.buffer, c, packet.manifest), m = decoded.manifest;
    const w = await testigo("estado");
    const actual = igual(m, w.ultimo);
    if (remitenteId && (!c.miembros.some(n => n.id === remitenteId) || (!actual && remitenteId !== m.nodoId))) throw error("El remitente no coincide con el escritor acreditado de la copia");
    if (!actual && (m.indice !== w.ultimo.indice + 1 || m.termino !== w.termino || m.nodoId !== w.escritor || Number(w.vence_en_ms) <= 0)) throw error("El testigo no acredita ese escritor, término e índice");
    custodiar(packet);
    if (actual) confirmarLocal(m); else {
      if (c.relevoManual && tiene(w.ultimo)) confirmarLocal(w.ultimo);
      disco.pendiente = revision(m); guardar();
    }
    if (c.relevoManual && disco.confirmada) {
      try { limpiarCopias(); } catch (e) { log("No se pudo limpiar una copia antigua: " + e.message); }
    }
    if (m.termino < 1) return { guardado: true, revision: revision(m) };
    return firmarAckReplica({ grupoId: c.grupoId, nodoId: c.nodoId, escritorId: m.nodoId, termino: m.termino, indice: m.indice, sha256: m.sha256 }, c.clave);
  }
  function recibirCopiaQuorum(packet, ultimo) {
    if (!config.respaldo_lan?.quorumPendiente || permiso || !igual(packet.manifest, ultimo)) throw error("La copia de incorporación no corresponde a la revisión confirmada");
    custodiar(packet);
    confirmarLocal(ultimo);
  }
  async function recuperar(rev) {
    if (tiene(rev)) return;
    if (typeof transporte.obtenerSnapshot === "function") {
      for (const miembro of otros) {
        try {
          const packet = await transporte.obtenerSnapshot(miembro, rev);
          const m = custodiar(packet);
          if (igual(m, rev)) return;
        } catch (_e) { /* probar otra copia explícitamente registrada */ }
      }
    }
    // Primer arranque del escritor original: el grupo debe haberse creado con
    // el hash de esta copia inicial, nunca con un comodín que acepte datos viejos.
    if (rev.indice === 0 && !disco.confirmada) {
      const packet = await snapshot({ indice: 0, termino: 0, nodoId: c.nodoId });
      if (igual(packet.manifest, rev)) { custodiar(packet); disco.instalada = revision(rev); guardar(); return; }
    }
    throw error("Este respaldo está atrasado: falta la última copia confirmada por el testigo");
  }
  async function antesTransaccion() {
    if (enCurso || drenando || fenced || detenido || activando) throw error("El servidor LAN no está disponible para iniciar otra escritura");
    try {
      exigirModelo(disco.confirmada);
      if (!disco.confirmada || !igual(disco.instalada, disco.confirmada)) throw error("La base abierta todavía no es la revisión confirmada");
      if (!vivo()) await pedirPermiso("renovar", disco.confirmada);
      exigir(); enCurso = true;
    } catch (e) { throw bloquear(e); }
  }
  async function antesCommit() { if (!enCurso) throw error("No hay una transacción LAN autorizada"); await asegurarPermiso(); }
  function limpiarCopias() {
    const conservar = Math.max(2, Math.min(20, Number(c.conservarCopias) || 3));
    const dir = path.join(carpeta(base), "copias");
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)-[a-f0-9]{64}\.ajblan$/.exec(f);
      if (m && Number(m[1]) < disco.confirmada.indice - conservar + 1) fs.unlinkSync(path.join(dir, f));
    }
  }
  async function replicarQuorum(packet, termino) {
    const w = await testigo("estado");
    if (w.escritor !== c.nodoId || w.termino !== termino || !igual(w.ultimo, disco.confirmada) || !w.votantes?.includes(c.nodoId)) {
      throw error("La mayoría ya no acredita a esta PC para confirmar la operación");
    }
    const votos = new Set(w.votantes), necesarias = Math.floor(votos.size / 2);
    const peticiones = otros.map(m => ({
      vota: votos.has(m.id),
      acuse: Promise.resolve().then(() => transporte.replicar(m, packet)),
    }));
    const votantes = peticiones.filter(p => p.vota).map(p => p.acuse);
    for (const p of peticiones) if (!p.vota) p.acuse.catch(() => {});
    if (!necesarias) return [];
    return new Promise((resolve, reject) => {
      const acuses = [];
      let pendientes = votantes.length;
      const contar = acuse => {
        pendientes--;
        if (acuse) acuses.push(acuse);
        if (acuses.length === necesarias) resolve(acuses.slice());
        else if (acuses.length + pendientes < necesarias) reject(error("Falta guardar la operación en una mayoría de PCs"));
      };
      if (pendientes < necesarias) reject(error("Faltan PCs con voto para confirmar la operación"));
      for (const p of votantes) p.then(contar, () => contar());
    });
  }
  async function despuesTransaccion() {
    try {
      if (!enCurso) throw error("La transacción no estaba acreditada por el testigo");
      await asegurarPermiso();
      const indice = disco.confirmada.indice + 1, termino = permiso.termino;
      const packet = await snapshot({ indice, termino, nodoId: c.nodoId });
      if (packet.manifest.indice !== indice || packet.manifest.termino !== termino || packet.manifest.nodoId !== c.nodoId) throw error("El snapshot no corresponde a la transacción LAN");
      if (packet.manifest.modelo !== MODELO_ACTUAL) throw error(MENSAJE_MODELO, "RESPALDO_LAN_MODELO_INCOMPATIBLE");
      custodiar(packet);
      disco.pendiente = revision(packet.manifest); guardar();
      await asegurarPermiso();
      let acks = [], degradado = Boolean(c.relevoManual && c.nodoId === c.relevoManual.cajaId && disco.degradado);
      if (c.quorum) acks = await replicarQuorum(packet, termino);
      else if (otros.length && !degradado) {
        try { acks = [await Promise.any(otros.map(async miembro => {
          if (typeof transporte.replicar !== "function") throw error("No hay transporte de réplicas LAN");
          return transporte.replicar(miembro, packet);
        }))]; }
        catch (e) {
          if (c.permitirDegradado !== true) throw e;
          degradado = true;
        }
      }
      await asegurarPermiso();
      const w = await testigo("confirmar", { nodoId: c.nodoId, termino, indice, sha256: packet.manifest.sha256, replicas: acks, modoDegradado: degradado });
      if (!w.autorizado || w.escritor !== c.nodoId || w.termino !== termino || !igual(w.ultimo, packet.manifest)) throw error("El testigo no confirmó la copia de esta operación");
      exigir();
      disco.instalada = revision(packet.manifest);
      if (Boolean(disco.degradado) !== degradado) emitir(degradado ? "REDUNDANCIA_REDUCIDA" : "REDUNDANCIA_RESTABLECIDA", { revision: revision(packet.manifest) });
      disco.degradado = degradado;
      confirmarLocal(packet.manifest);
      try { limpiarCopias(); } catch (e) { log("No se pudo limpiar una copia antigua: " + e.message); }
      exigir();
    } catch (e) { throw bloquear(error("La operación no se confirmó: falló el respaldo o el permiso LAN. " + e.message)); }
    finally { enCurso = false; }
  }
  function abortarTransaccion() { enCurso = false; }
  async function prepararActivacion(rev, w, conservarConsenso = false) {
    exigirModelo(rev);
    if (activando) return;
    activando = true;
    disco.activacionPendiente = { ...revision(rev), termino: w.termino };
    guardar();
    permiso = null;
    emitir("ACTIVACION_PREPARADA", { termino: w.termino, revision: rev, anterior: w.anterior || null });
    if (conservarConsenso && typeof db.reabrirConCopia === "function") {
      try {
        const resultado = db.reabrirConCopia(() => aplicarPendiente({ base, config }));
        if (!resultado.aplicado || !igual(resultado.revision, rev)) throw error("No se instaló la revisión elegida por el grupo");
        disco = leerEstado(base, c);
        activando = false;
        return;
      } catch (e) { log("No se pudo abrir la copia sin reiniciar: " + e.message); }
    }
    await alActivar({ revision: rev, termino: w.termino, reiniciar: true });
  }
  async function sondearInterno() {
    if (detenido || enCurso || drenando || activando) return;
    const w = await testigo("estado");
    if (fenced) {
      // Una operación pudo hacer COMMIT sin conseguir el ACK final. Se recupera
      // sólo la revisión que el testigo acredita ahora, y se reinicia antes de
      // volver a abrir escrituras. Sin testigo/copia se sigue detenido y se reintenta.
      await recuperar(w.ultimo);
      confirmarLocal(w.ultimo);
      exigirModelo(w.ultimo);
      await prepararActivacion(w.ultimo, w);
      return;
    }
    if (vivo() && w.escritor === c.nodoId && permiso.termino === w.termino) {
      if (!igual(w.ultimo, disco.confirmada)) throw bloquear(error("La revisión del testigo cambió fuera del escritor"));
      await pedirPermiso("renovar", disco.confirmada);
      // En relevo manual la principal solicita la copia al volver y acredita
      // su recepción durante el traspaso. La caja no espera una PC apagada.
      if (!c.relevoManual && (w.degradado || disco.degradado) && otros.length && typeof transporte.replicar === "function") {
        let ack;
        try { ack = await Promise.any(otros.map(m => transporte.replicar(m, copiaDelEscritor(w.ultimo)))); }
        catch (_e) { return; } // Sigue explícitamente degradado, sin falsificar copias.
        exigir();
        const recuperado = await testigo("confirmar", { nodoId: c.nodoId, termino: permiso.termino, ...revision(w.ultimo), replicas: [ack], modoDegradado: false });
        if (!recuperado.autorizado || recuperado.degradado || !igual(recuperado.ultimo, w.ultimo)) throw bloquear(error("El testigo no acreditó la recuperación de la copia"));
        disco.degradado = false; guardar(); emitir("REDUNDANCIA_RESTABLECIDA", { revision: w.ultimo });
      }
      return;
    }
    permiso = null;
    await recuperar(w.ultimo);
    confirmarLocal(w.ultimo);
    exigirModelo(w.ultimo);
    disco.degradado = w.degradado === true; guardar();
    if (w.escritor && w.escritor !== c.nodoId && Number(w.vence_en_ms) > 0) {
      if (w.preferido_id !== c.nodoId) return;
      const escritor = otros.find(m => m.id === w.escritor);
      if (!escritor) return;
      if (c.quorum) {
        if (typeof transporte.solicitarRetorno !== "function" || !w.votantes?.includes(c.nodoId)) return;
        const acuse = firmarAckReplica({ grupoId: c.grupoId, nodoId: c.nodoId, escritorId: w.escritor,
          termino: w.termino, ...revision(w.ultimo) }, c.clave);
        await transporte.solicitarRetorno(escritor, { haciaId: c.nodoId, revision: w.ultimo, acuse });
      } else if (typeof transporte.drenar === "function") {
        const retorno = await testigo("solicitar", { nodoId: c.nodoId, revision: w.ultimo });
        if (retorno.drenar && retorno.hacia_preferido === c.nodoId) await transporte.drenar(escritor, { haciaId: c.nodoId, revision: w.ultimo });
      }
      return;
    }
    if (c.quorum && w.candidato === c.nodoId && !igual(disco.instalada, w.ultimo)) {
      // Si reinicia toda la aplicación, también pierde la elección recién
      // ganada y otra PC puede volver a tomar el control antes de que arranque.
      await prepararActivacion(w.ultimo, w, true);
      return;
    }
    if (c.relevoManual && w.manual_activo !== (c.nodoId === c.relevoManual.cajaId)) return;
    const concedido = await pedirPermiso("solicitar", w.ultimo);
    if (!igual(disco.instalada, w.ultimo)) { await prepararActivacion(w.ultimo, concedido); return; }
    errorActual = null;
    emitir("ESCRITOR_ACTIVO", { termino: concedido.termino, revision: w.ultimo });
  }
  function sondear() {
    if (!sondeo) sondeo = db.exclusivo(sondearInterno).catch(e => { errorActual = e.message; permiso = null; throw e; }).finally(() => { sondeo = null; });
    return sondeo;
  }
  async function drenar({ haciaId, revision: recibida, acuse } = {}) {
    exigirModelo(disco.confirmada);
    if (drenando || fenced || detenido) throw error("El escritor ya está detenido o drenando");
    const hacia = c.miembros.find(m => m.id === haciaId && m.id !== c.nodoId && m.preferido === true);
    if (!hacia) throw error("La entrega automática sólo corresponde al equipo preferido configurado");
    if (c.quorum) return db.exclusivo(async () => {
      if (fenced || detenido || activando || drenando || !vivo() || !igual(recibida, disco.confirmada)) {
        throw error("La PC principal todavía no tiene la última revisión confirmada");
      }
      drenando = true;
      try {
        await transporte.transferirAlPrincipal(haciaId, disco.confirmada, permiso.termino, acuse);
        permiso = null;
        emitir("CONTROL_ENTREGADO", { haciaId, revision: disco.confirmada });
        return { entregado: true, revision: disco.confirmada };
      } finally { drenando = false; }
    });
    drenando = true;
    return db.exclusivo(async () => {
      try {
        if (enCurso) throw error("Quedó una transacción en curso al drenar");
        await pedirPermiso("renovar", disco.confirmada);
        const w = await testigo("estado");
        if (w.escritor !== c.nodoId || !igual(w.ultimo, disco.confirmada)) throw error("El escritor no puede entregar una revisión distinta");
        const ack = await transporte.replicar(hacia, copiaDelEscritor(w.ultimo));
        exigir();
        if (w.degradado || disco.degradado) {
          const recuperado = await testigo("confirmar", { nodoId: c.nodoId, termino: permiso.termino, ...revision(w.ultimo), replicas: [ack], modoDegradado: false });
          if (!recuperado.autorizado || recuperado.degradado || !igual(recuperado.ultimo, w.ultimo)) throw error("El testigo no acreditó la copia del preferido");
          disco.degradado = false; guardar(); emitir("REDUNDANCIA_RESTABLECIDA", { revision: w.ultimo });
        }
        exigir();
        const liberado = await testigo("liberar", { nodoId: c.nodoId, termino: permiso.termino, ...(c.relevoManual ? { replica: ack } : {}) });
        if (liberado.escritor !== null || !igual(liberado.ultimo, w.ultimo)) throw error("El testigo no liberó al escritor");
        permiso = null;
        emitir("CONTROL_ENTREGADO", { haciaId, revision: w.ultimo });
        return { entregado: true, revision: w.ultimo };
      } catch (e) { throw bloquear(e); }
      finally { drenando = false; }
    });
  }
  function estado() {
    let modelo = null, errorModelo = null;
    if (disco.confirmada) {
      try { modelo = modeloDe(disco.confirmada); if (modelo !== MODELO_ACTUAL) errorModelo = MENSAJE_MODELO; }
      catch (e) { errorModelo = e.message; }
    }
    return { habilitado: true, grupoId: c.grupoId, nodoId: c.nodoId, escritor: !errorModelo && !fenced && !detenido && !drenando && !activando && vivo(), termino: permiso?.termino || ultimoTestigo?.termino || 0,
      confirmada: disco.confirmada, instalada: disco.instalada, pendiente: disco.pendiente || null, degradado: Boolean(disco.degradado), drenando, bloqueado: fenced || !!errorModelo, activando, error: errorModelo || errorActual, modelo, modeloActual: MODELO_ACTUAL, modeloCompatible: !errorModelo, testigo: ultimoTestigo,
      miembros: c.miembros.map(({ id, nombre, url, preferido, caPublica }) => ({ id, nombre, url, preferido, ...(caPublica ? { caPublica } : {}) })) };
  }
  return {
    estado, antesTransaccion, antesCommit, despuesTransaccion, abortarTransaccion, recibirInicial, recibirSnapshot, recibirCopiaQuorum, obtenerSnapshot, copiaDelEscritor, consultarCopia, registrarInicial, sondear, drenar,
    iniciar() { if (!timer) timer = setInterval(() => sondear().catch(e => log(e.message)), 1500); timer.unref?.(); return sondear(); },
    detener() { detenido = true; permiso = null; clearInterval(timer); timer = null; },
    prepararInicial: () => db.exclusivo(() => snapshot({ indice: 0, termino: 0, nodoId: c.nodoId })),
  };
}

// Único lugar que reemplaza predio.db. Siempre se ejecuta con SQLite cerrada.
// Toda identidad/configuración de la PC queda fuera del snapshot.
function aplicarPendiente({ base, config }) {
  const c = configuracion(base, config);
  if (!c.habilitado) return { aplicado: false };
  const s = leerEstado(base, c), rev = s.activacionPendiente || s.confirmada;
  if (!valido(rev)) return { aplicado: false };
  const decoded = abrir(fs.readFileSync(archivoSnapshot(base, rev)), c);
  if (!igual(decoded.manifest, rev)) throw error("La copia pendiente no coincide con la recuperación acreditada");
  if (decoded.manifest.modelo !== MODELO_ACTUAL) return { aplicado: false, incompatible: true, modelo: decoded.manifest.modelo, modeloActual: MODELO_ACTUAL, mensaje: MENSAJE_MODELO };
  const datos = path.join(base, "datos"), final = path.join(datos, "predio.db");
  fs.mkdirSync(datos, { recursive: true, mode: 0o700 });
  const tmp = path.join(datos, "predio.db.ha-" + crypto.randomBytes(12).toString("hex"));
  const { DatabaseSync } = require("node:sqlite");
  let previo, nuevo;
  try {
    let fisicos = fisicosGuardados(base, c);
    if (fs.existsSync(final)) {
      try {
        previo = new DatabaseSync(final, { readOnly: true });
        fisicos = leerFisicos(previo);
        guardarFisicos(base, c, fisicos);
      } catch (e) {
        // Un corte durante el reemplazo puede dejar una base antigua ilegible.
        // La identidad privada del receptor está fuera de esa base y permite
        // repetir la recuperación sin adoptar la identidad del emisor.
        if (!fisicos) throw e;
      } finally { previo?.close(); previo = null; }
    }
    fisicos ||= {};
    escribirDurable(tmp, decoded.data);
    inspeccionar(tmp, c.predioId);
    nuevo = new DatabaseSync(tmp);
    nuevo.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
    for (const clave of META_FISICA) {
      if (fisicos[clave] == null) nuevo.prepare("DELETE FROM predio_meta WHERE clave=?").run(clave);
      else nuevo.prepare("INSERT INTO predio_meta(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor").run(clave, fisicos[clave]);
    }
    nuevo.exec("COMMIT"); nuevo.close(); nuevo = null;
    const fd = fs.openSync(tmp, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // No se dejan WAL de otra base junto a la copia restaurada. Esta función
    // requiere que no haya ningún proceso con la instalación abierta.
    for (const sufijo of ["-wal", "-shm"]) try { fs.unlinkSync(final + sufijo); } catch (e) { if (e.code !== "ENOENT") throw e; }
    fs.renameSync(tmp, final); sincronizarDirectorio(datos);
    s.instalada = revision(rev); s.confirmada = revision(rev); s.activacionPendiente = null; s.pendiente = null;
    guardarEstado(base, s);
    return { aplicado: true, revision: revision(rev) };
  } finally {
    previo?.close(); nuevo?.close();
    try { fs.unlinkSync(tmp); } catch (_e) { /* ya movido */ }
  }
}

module.exports = { crearRespaldoLan, crearSnapshotDirecta, aplicarPendiente, MODELO_ACTUAL, modeloDeEsquema };
