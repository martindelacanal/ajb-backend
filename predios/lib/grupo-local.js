"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { leerMeta } = require("./db-sqlite");
const { identidadEquipo } = require("./control-equipo");
const tlsLocal = require("./tls-local");
const { armarInstaladorApoyo } = require("./instalador-apoyo");
const { crearSnapshotDirecta } = require("./respaldo-lan");
const httpLan = require("./http-lan");
const { crearVerificador } = require("./protocolo-lan");
const META = "ha_admin_json";
const nuevoSecreto = () => crypto.randomBytes(32).toString("hex");
const publico = ({ id, nombre, url, caPublica, preferido }) => ({ id, nombre, url, preferido: !!preferido, ...(caPublica ? { caPublica } : {}) });
function validarCA(pem) { try { if (typeof pem !== "string" || pem.length > 32768 || pem.includes("PRIVATE KEY") || !new crypto.X509Certificate(pem).ca) throw new Error(); return pem; } catch (_e) { throw new Error("La autoridad HTTPS pública no es válida"); } }
function validarUrl(valor, protocolo) { let u; try { u = new URL(valor); } catch (_e) { throw new Error("La dirección del equipo no es válida"); } if (u.protocol !== protocolo || u.username || u.password || u.search || u.hash || !["", "/"].includes(u.pathname)) throw new Error("La dirección del equipo no es válida"); return u.origin; }
function protegerArchivo(archivo) {
  fs.chmodSync(archivo, 0o600);
  if (process.platform !== "win32") return;
  const sid = /S-1-\d+(?:-\d+)+/.exec(execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10000 }))?.[0];
  if (!sid) throw new Error("No se pudo proteger la configuración privada del grupo");
  execFileSync("icacls.exe", [archivo, "/inheritance:r", "/grant:r", ...new Set([`*${sid}:F`, "*S-1-5-18:F", "*S-1-5-32-544:F"]), "/Q"], { windowsHide: true, stdio: "pipe", timeout: 15000 });
}
function guardarPrivado(archivo, contenido) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true, mode: 0o700 });
  const temporal = `${archivo}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try { fd = fs.openSync(temporal, "wx", 0o600); fs.writeFileSync(fd, contenido); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; protegerArchivo(temporal); fs.renameSync(temporal, archivo); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporal)) fs.unlinkSync(temporal); }
}
function escribirHa(base, ha) { guardarPrivado(path.join(base, "predio-ha.json"), Buffer.from(JSON.stringify(ha, null, 2))); }
function crearGrupoLocal({ base, dirApp, version, config, db, equipoId, haActual = () => null, bloquearEscritura, activarLocal, reiniciar = () => {}, deps = {} }) {
  const d = { armarInstaladorApoyo, pedir: httpLan.pedir, estadoTestigo: httpLan.estadoTestigo, crearSnapshotDirecta, leerTls: tlsLocal.leerTls, prepararTls: tlsLocal.prepararTls, identidadEquipo, ahora: Date.now, hostname: os.hostname, ...deps };
  equipoId ||= d.identidadEquipo();
  if (!/^[a-f0-9]{64}$/.test(equipoId || "") || !db || db.dialecto !== "sqlite") throw new Error("El grupo requiere la identidad física y la base local del predio");
  let cola = Promise.resolve(), congelado = fs.existsSync(path.join(base, "ha-activacion-pendiente.json"));
  const verificadores = new Map();
  function exclusivo(fn) { const r = cola.then(fn); cola = r.catch(() => {}); return r; }
  function leer() { const raw = leerMeta(db, META); if (!raw) return null; let r; try { r = JSON.parse(raw); } catch (_e) { throw new Error("El registro privado del grupo necesita revisión"); } if (r.formato !== 1 || !r.grupoId || !Array.isArray(r.miembros) || !Array.isArray(r.pendientes)) throw new Error("El registro privado del grupo no es válido"); return r; }
  async function guardar(r) { await db.tx((t) => t.run("INSERT INTO predio_meta(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor", [META, JSON.stringify(r)])); }
  async function propia() { await d.prepararTls(base); const tls = d.leerTls(base); return { id: equipoId, nombre: String(d.hostname()).toLowerCase(), url: `https://${String(d.hostname()).toLowerCase()}:${tls.puerto}`, caPublica: validarCA(new crypto.X509Certificate(tls.raiz).toString()) }; }
  function certificado(r) {
    if (!r.testigo) return null;
    const datos = { formato: 1, grupoId: r.grupoId, instanciaId: r.instanciaId, equipoOrigenId: r.principalId, clavePublicaTestigo: r.testigo.clavePublica };
    return { datos, firma: crypto.createHmac("sha256", config.token || "").update(JSON.stringify(datos)).digest("hex") };
  }
  function haPara(r, miembro) { return { habilitado: true, grupoId: r.grupoId, nodoId: miembro.id, equipoId: miembro.id, rolInstalacion: miembro.id === r.principalId ? "Principal" : "Respaldo", clave: miembro.clave, claveDatos: r.claveDatos, clavePublicaTestigo: r.testigo.clavePublica, testigo: { id: r.testigo.id, nombre: r.testigo.nombre, url: r.testigo.url }, miembros: r.miembros.map(publico), permitirDegradado: true, certificado: certificado(r), ...(miembro.id === equipoId ? { claveAdministracion: r.claveAdministracion } : {}) }; }
  async function adminTestigo(r, accion, datos) { return d.pedir(r.testigo.url, "/lan/testigo/" + accion, { grupoId: r.grupoId, nodoId: "administracion", clave: r.claveAdministracion, buffer: httpLan.cifrarJson(datos, r.claveAdministracion), timeout: 30000 }); }
  async function estado() {
    const r = leer(), actual = haActual() || {};
    let miembros = r?.miembros.map(publico) || [];
    const local = { id: equipoId, nombre: String(d.hostname()).toLowerCase(), url: `http://${String(d.hostname()).toLowerCase()}:${config.puerto || 8080}`, preferido: true };
    const principal = miembros.find((m) => m.id === r?.principalId) || local;
    let vivo = null;
    if (r?.testigo) try { vivo = await d.estadoTestigo(haPara(r, r.miembros.find((m) => m.id === equipoId) || r.miembros[0])); } catch (_e) { /* estado informativo sin degradar la autoridad */ }
    const activo = actual.habilitado === true;
    const commit = vivo?.ultimo_commit;
    const ackActual = commit?.indice === vivo?.ultimo?.indice && commit?.sha256 === vivo?.ultimo?.sha256 && Array.isArray(commit?.replicas) ? new Set(commit.replicas) : null;
    miembros = miembros.map((m) => ({ ...m, incorporado: true, ...(!activo ? { estado: "INCORPORADO" } : vivo ? { actualizado: m.id === vivo.escritor || (ackActual ? ackActual.has(m.id) : false) } : {}) }));
    const listo = !!r?.testigo && miembros.length >= 2;
    const testigo = r?.testigo ? { id: r.testigo.id, nombre: r.testigo.nombre, url: r.testigo.url, conectado: !!vivo } : null;
    return { habilitado: activo, grupoId: r?.grupoId || null, principal, testigo, miembros, escritor: vivo?.escritor ? miembros.find((m) => m.id === vivo.escritor) || null : !activo && !congelado ? principal : null, degradado: !!(vivo?.degradado || actual.degradado), estado: !r ? "SIN_CONFIGURAR" : activo ? (vivo ? "EN_MARCHA" : "SIN_TESTIGO") : "PREPARANDO", puedeActivar: !activo && !congelado && listo && !!vivo && vivo.termino === 0, puedePrepararTestigo: !r?.testigo && !r?.pendientes.some((p) => p.rol === "Testigo" && p.vence > d.ahora()), puedePrepararRespaldo: !!r?.testigo, mensaje: congelado ? "La activación está en curso o necesita completarse; las escrituras permanecen bloqueadas." : activo ? "El escritor se acredita con el testigo de la red local." : "Podés preparar los equipos mientras el servidor actual sigue trabajando. Activá el grupo cuando estén incorporados.", pendientes: r?.pendientes.map(({ id, rol, vence, respuesta }) => ({ id, rol, vence, incorporado: !!respuesta })) || [] };
  }
  function instalador(rol) { return exclusivo(async () => {
    if (!["Testigo", "Respaldo", "Acceso"].includes(rol)) throw new Error("Elegí un rol de apoyo válido");
    let r = leer();
    const yo = await propia();
    if (!r) {
      if (rol !== "Testigo") throw new Error("Primero prepará e incorporá el testigo del grupo");
      const instanciaId = leerMeta(db, "instancia_id"); if (!instanciaId) throw new Error("Primero debe iniciarse la identidad de esta instalación del predio");
      r = { formato: 1, grupoId: crypto.randomUUID(), principalId: equipoId, instanciaId, claveDatos: nuevoSecreto(), claveAdministracion: nuevoSecreto(), miembros: [{ ...yo, preferido: true, clave: nuevoSecreto() }], testigo: null, pendientes: [] };
    }
    if (!r.miembros.some((m) => m.id === equipoId)) throw new Error("Esta PC no pertenece al registro del grupo");
    if (rol === "Testigo" && (r.testigo || r.pendientes.some((p) => p.rol === rol && !p.usadoPor && p.vence > d.ahora()))) throw new Error("El grupo ya tiene un testigo o un paquete de incorporación vigente");
    if (rol !== "Testigo" && !r.testigo) throw new Error("Primero incorporá el testigo del grupo");
    const pendiente = { id: crypto.randomUUID(), rol, clave: nuevoSecreto(), vence: d.ahora() + 3600000 };
    r.pendientes = r.pendientes.filter((p) => p.vence > d.ahora() || p.usadoPor); r.pendientes.push(pendiente); await guardar(r);
    const inicial = { habilitado: true, grupoId: r.grupoId, rolInstalacion: rol, incorporacion: { id: pendiente.id, clave: pendiente.clave, principalUrl: yo.url, caPublica: yo.caPublica, vence: pendiente.vence } };
    if (rol === "Testigo") inicial.configTestigo = { grupoId: r.grupoId, miembros: r.miembros.map((m) => ({ ...m })), revisionInicial: { indice: 0, sha256: "0".repeat(64) }, permitirDegradado: true };
    try { return await d.armarInstaladorApoyo({ base, dirApp, version, configInicial: inicial, configPredio: config }); }
    catch (e) {
      // Si no se produjo el ZIP, no deja un permiso invisible que bloquee la
      // descarga del testigo durante una hora.
      r.pendientes = r.pendientes.filter(p => p.id !== pendiente.id);
      await guardar(r);
      throw e;
    }
  }); }
  function incorporar({ metodo, ruta, cabeceras, cuerpo }) { return exclusivo(async () => {
    const r = leer(); if (!r || !Buffer.isBuffer(cuerpo) || cuerpo.length > 1024 * 1024 || metodo !== "POST" || ruta !== "/lan/incorporar") throw new Error("La incorporación no es válida");
    const headers = Object.fromEntries(Object.entries(cabeceras || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const p = r.pendientes.find((p) => p.id === headers["x-ajb-incorporacion"]);
    if (!p) throw new Error("El permiso de incorporación no existe o venció");
    const nodo = headers["x-ajb-nodo"];
    if (!/^[a-f0-9]{64}$/.test(nodo || "")) throw new Error("La identidad física del equipo no es válida");
    let verificar = verificadores.get(p.id);
    if (!verificar) { verificar = crearVerificador({ grupoId: r.grupoId, miembros: () => [{ id: nodo, clave: p.clave }], ahora: d.ahora }); verificadores.set(p.id, verificar); }
    verificar({ metodo, ruta, cuerpo, cabeceras });
    let datos; try { datos = JSON.parse(cuerpo.toString("utf8")); } catch (_e) { throw new Error("La solicitud de incorporación no es válida"); }
    if (datos.nodoId !== nodo || datos.rol !== p.rol || typeof datos.nombre !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(datos.nombre)) throw new Error("La incorporación no corresponde al equipo y rol solicitados");
    const huella = crypto.createHash("sha256").update(cuerpo).digest("hex");
    if (p.usadoPor && (p.usadoPor !== nodo || p.solicitud !== huella)) throw new Error("Este permiso ya fue usado por otra incorporación");
    if (p.respuesta) return Buffer.from(p.respuesta, "base64");
    if (p.vence <= d.ahora()) throw new Error("El permiso de incorporación venció; prepará un instalador nuevo");
    if (!p.usadoPor && (nodo === equipoId || r.miembros.some((m) => m.id === nodo) || r.testigo?.id === nodo)) throw new Error("Ese equipo ya tiene un rol dentro del grupo");
    p.usadoPor = nodo; p.solicitud = huella;
    let final;
    if (p.rol === "Testigo") {
      if (r.testigo && r.testigo.id !== nodo) throw new Error("El grupo ya tiene otro testigo");
      let publica; try { const llave = crypto.createPublicKey(datos.clavePublicaTestigo); if (llave.asymmetricKeyType !== "ed25519") throw new Error(); publica = llave.export({ type: "spki", format: "pem" }); } catch (_e) { throw new Error("La firma pública del testigo no es válida"); }
      r.testigo = { id: nodo, nombre: datos.nombre, url: validarUrl(datos.url, "http:"), clavePublica: publica };
      final = { habilitado: true, grupoId: r.grupoId, rolInstalacion: "Testigo", equipoId: nodo, nodoId: nodo, claveAdministracion: r.claveAdministracion, miembros: r.miembros.map((m) => ({ ...m })), revisionInicial: { indice: 0, sha256: "0".repeat(64) }, permitirDegradado: true, testigo: { id: nodo, nombre: datos.nombre, url: r.testigo.url }, clavePublicaTestigo: publica };
    } else if (p.rol === "Respaldo") {
      if (!r.testigo) throw new Error("El grupo todavía no tiene testigo");
      const nuevo = p.miembro || { id: nodo, nombre: datos.nombre, url: validarUrl(datos.url, "https:"), caPublica: validarCA(datos.caPublica), clave: nuevoSecreto(), preferido: false };
      p.miembro = nuevo; await guardar(r);
      const miembros = [...r.miembros.filter((m) => m.id !== nodo), nuevo];
      await adminTestigo(r, "configurar", { miembros });
      r.miembros = miembros; final = haPara(r, nuevo);
    } else {
      if (!r.testigo) throw new Error("El grupo todavía no tiene testigo");
      final = { habilitado: true, grupoId: r.grupoId, rolInstalacion: "Acceso", equipoId: nodo, clavePublicaTestigo: r.testigo.clavePublica, testigo: { id: r.testigo.id, nombre: r.testigo.nombre, url: r.testigo.url }, miembros: r.miembros.map(publico) };
    }
    const respuesta = httpLan.cifrarJson({ ha: final, ...(p.rol === "Respaldo" ? { configPredio: { ...config } } : {}) }, p.clave);
    p.respuesta = respuesta.toString("base64"); await guardar(r);
    return respuesta;
  }); }
  async function activarInterno({ reanudar = false } = {}) {
    const r = leer(); if (!r?.testigo || r.miembros.length < 2) throw new Error("Incorporá el testigo y al menos un respaldo antes de activar");
    if (reanudar && !fs.existsSync(path.join(base, "ha-activacion-pendiente.json"))) throw new Error("No hay una activación autorizada pendiente para reanudar");
    if (typeof bloquearEscritura !== "function" || typeof activarLocal !== "function") throw new Error("Falta conectar el bloqueo de escritura y la activación local");
    const yo = r.miembros.find((m) => m.id === equipoId);
    if (!yo || equipoId !== r.principalId) throw new Error("La primera activación corresponde al servidor original");
    const ha = haPara(r, yo), previo = await d.estadoTestigo(ha);
    const archivoIntento = path.join(base, "ha", "activacion-grupo.json"), archivoPacket = path.join(base, "ha", "activacion-inicial.ajblan");
    let intento = null;
    if (fs.existsSync(archivoIntento)) {
      intento = JSON.parse(fs.readFileSync(archivoIntento, "utf8"));
      if (intento.grupoId !== r.grupoId || intento.nodoId !== equipoId) throw new Error("La activación pendiente pertenece a otro grupo o equipo");
    }
    const autoridadIniciada = previo.termino > 0;
    if ((autoridadIniciada && (!reanudar || !intento)) || (!autoridadIniciada && (previo.escritor || previo.ultimo.indice !== 0))) throw new Error("El testigo ya tiene una autoridad o revisión posterior: no se reinicializa");
    bloquearEscritura(); congelado = true;
    return db.exclusivo(async () => {
      // Desde este punto, cualquier fallo conserva el bloqueo. La misma copia se
      // instala localmente y en los respaldos antes de habilitarla en el testigo.
      let packet;
      if (intento) {
        const buffer = fs.readFileSync(archivoPacket);
        if (crypto.createHash("sha256").update(buffer).digest("hex") !== intento.paquete_sha256 || intento.manifest.indice !== 0 || intento.manifest.termino !== 0 || intento.manifest.nodoId !== equipoId || intento.manifest.grupoId !== r.grupoId) throw new Error("La copia inicial pendiente no coincide con la activación autorizada");
        packet = { buffer, manifest: intento.manifest };
      } else {
        packet = d.crearSnapshotDirecta({ db, base, config: { ...config, respaldo_lan: ha }, indice: 0, termino: 0, nodoId: equipoId });
        guardarPrivado(archivoPacket, packet.buffer);
        intento = { formato: 1, grupoId: r.grupoId, nodoId: equipoId, manifest: packet.manifest, paquete_sha256: crypto.createHash("sha256").update(packet.buffer).digest("hex") };
        guardarPrivado(archivoIntento, Buffer.from(JSON.stringify(intento)));
      }
      if (autoridadIniciada && previo.ultimo.indice === 0 && previo.ultimo.sha256 !== packet.manifest.sha256) throw new Error("El grupo activo no corresponde a la copia inicial autorizada");
      escribirHa(base, ha);
      await activarLocal({ ha, packet, reanudando: reanudar, autoridadIniciada });
      if (autoridadIniciada) { await reiniciar(); return { activado: true, reanudado: true, reiniciando: true, revision: previo.ultimo }; }
      for (const m of r.miembros.filter((m) => m.id !== equipoId)) {
        const resultado = await d.pedir(m.url, "/lan/replica/inicial", { grupoId: r.grupoId, nodoId: equipoId, clave: r.claveDatos, buffer: packet.buffer, ca: m.caPublica, timeout: 60000 });
        if (!resultado?.guardado || resultado.revision?.indice !== 0 || resultado.revision?.sha256 !== packet.manifest.sha256) throw new Error("El respaldo no confirmó la copia inicial exacta");
      }
      const seed = await adminTestigo(r, "inicializar", { revision: { indice: 0, sha256: packet.manifest.sha256 } });
      if (!seed?.inicializado || seed.ultimo?.sha256 !== packet.manifest.sha256) throw new Error("El testigo no confirmó la copia inicial exacta");
      await reiniciar();
      return { activado: true, reiniciando: true, revision: { indice: 0, sha256: packet.manifest.sha256 } };
    });
  }
  const activar = () => exclusivo(() => activarInterno());
  const reanudarActivacion = () => exclusivo(() => activarInterno({ reanudar: true }));
  return { estado, instalador, incorporar, activar, reanudarActivacion };
}
module.exports = { crearGrupoLocal };
