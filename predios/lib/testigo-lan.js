"use strict";

// Un árbitro durable único. No contiene datos comerciales ni decide autoridad
// por mera ausencia de paquetes: sólo concede leases sobre la última revisión.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { verificarAckReplica, crearVerificador } = require("./protocolo-lan");
const LEASE_MS = 15000, USO_MS = 5000, CUARENTENA_MS = 20000;
function revisionValida(r) { return r && Number.isSafeInteger(r.indice) && r.indice >= 0 && /^[a-f0-9]{64}$/.test(r.sha256); }
function misma(a, b) { return a?.indice === b?.indice && a?.sha256 === b?.sha256; }
function proteger(base) {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 }); fs.chmodSync(base, 0o700);
  if (process.platform !== "win32") return;
  const cuenta = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const sid = /S-1-\d+(?:-\d+)+/.exec(cuenta)?.[0];
  if (!sid) throw new Error("No se pudo proteger el estado privado del testigo");
  execFileSync("icacls.exe", [base, "/inheritance:r", "/grant:r", ...new Set([`*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]), "/Q"], { windowsHide: true, stdio: "pipe", timeout: 15000 });
}
function persistir(archivo, datos) {
  const temporal = `${archivo}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try { fd = fs.openSync(temporal, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify(datos)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporal, archivo);
    // También vacía el archivo bajo su nombre definitivo (FlushFileBuffers en
    // Windows), antes de acreditar el término o el commit a otro equipo.
    fd = fs.openSync(archivo, "r+"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    let directorio;
    try { directorio = fs.openSync(path.dirname(archivo), "r"); fs.fsyncSync(directorio); }
    catch (e) { if (process.platform !== "win32" || !["EPERM", "EISDIR", "EINVAL", "EBADF"].includes(e.code)) throw e; }
    finally { if (directorio !== undefined) fs.closeSync(directorio); }
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporal)) fs.unlinkSync(temporal); }
}
function vivo(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } }
function tomarCandado(base) {
  const archivo = path.join(base, "testigo.lock"), reclamo = path.join(base, "testigo.reclamando"), token = crypto.randomBytes(24).toString("hex");
  if (fs.existsSync(reclamo)) throw new Error("El testigo tiene una recuperación de proceso pendiente");
  function crear() { const fd = fs.openSync(archivo, "wx", 0o600); try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  try { crear(); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let anterior;
    try { anterior = JSON.parse(fs.readFileSync(archivo, "utf8")); } catch (_e) { throw new Error("El candado del testigo requiere revisión antes de iniciar"); }
    if (!Number.isSafeInteger(anterior.pid) || anterior.pid <= 0 || vivo(anterior.pid)) throw new Error("Ya hay un proceso de testigo usando esta carpeta");
    let fd;
    try {
      fd = fs.openSync(reclamo, "wx", 0o600);
      const actual = JSON.parse(fs.readFileSync(archivo, "utf8"));
      if (actual.token !== anterior.token || vivo(actual.pid)) throw new Error("Otro proceso tomó el control del testigo");
      fs.unlinkSync(archivo); crear();
    } finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(reclamo); } }
  }
  return () => { try { const actual = JSON.parse(fs.readFileSync(archivo, "utf8")); if (actual.token === token) fs.unlinkSync(archivo); } catch (_e) { /* ya cerrado */ } };
}
function validarConfig(config) {
  if (!config || typeof config.grupoId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(config.grupoId) || !Array.isArray(config.miembros) || config.miembros.length < 1 || config.miembros.length > 20 || !revisionValida(config.revisionInicial)) throw new Error("La configuración explícita del grupo del testigo no es válida");
  const ids = new Set(), urls = new Set(), claves = new Set();
  for (const m of config.miembros) {
    let url; try { url = new URL(m.url); } catch (_e) { throw new Error("Un miembro del testigo no tiene una URL válida"); }
    if (m.caPublica !== undefined && m.caPublica !== null) {
      try { if (typeof m.caPublica !== "string" || m.caPublica.length > 32768 || !m.caPublica.includes("-----BEGIN CERTIFICATE-----") || !new crypto.X509Certificate(m.caPublica).ca || m.caPublica.includes("PRIVATE KEY")) throw new Error(); }
      catch (_e) { throw new Error("La autoridad HTTPS pública de un miembro no es válida"); }
    }
    if (typeof m.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(m.id) || ids.has(m.id) || typeof m.nombre !== "string" || !m.nombre.trim() || typeof m.clave !== "string" || m.clave.length < 16 || claves.has(m.clave) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search || (url.pathname !== "/" && url.pathname !== "") || urls.has(url.origin)) throw new Error("Los miembros del testigo deben tener identidades, URLs y credenciales únicas");
    ids.add(m.id); urls.add(url.origin); claves.add(m.clave);
  }
  if (config.miembros.filter((m) => m.preferido).length > 1) throw new Error("Sólo puede haber un equipo preferido");
}
function crearTestigo({ base, config, ahora = Date.now, monotono = () => Number(process.hrtime.bigint() / 1000000n) }) {
  validarConfig(config);
  if (typeof base !== "string" || !base.trim()) throw new Error("Falta la carpeta privada del testigo");
  base = path.resolve(base); proteger(base);
  const cerrarCandado = tomarCandado(base);
  try {
    const archivo = path.join(base, "testigo-estado.json"), firmaArchivo = path.join(base, "testigo-firma.json");
    let miembros = config.miembros.map((m) => ({ ...m }));
    let preferido = miembros.find((m) => m.preferido)?.id || miembros[0].id;
    let permitirDegradado = config.permitirDegradado === true;
    function huellaConfiguracion(lista, favorito, degradado) { return crypto.createHash("sha256").update(JSON.stringify({ grupoId: config.grupoId, miembros: lista.map(({ id, nombre, url, clave, caPublica }) => ({ id, nombre, url, caPublica: caPublica || null, clave_hash: crypto.createHash("sha256").update(clave).digest("hex") })), preferido: favorito, permitirDegradado: degradado })).digest("hex"); }
    let durable;
    const existiaEstado = fs.existsSync(archivo);
    if (existiaEstado) {
      durable = JSON.parse(fs.readFileSync(archivo, "utf8"));
      if (!Array.isArray(durable.miembros)) throw new Error("Falta la membresía durable del testigo");
      validarConfig({ grupoId: config.grupoId, miembros: durable.miembros, revisionInicial: durable.ultimo });
      miembros = durable.miembros.map((m) => ({ ...m })); preferido = durable.preferido; permitirDegradado = durable.permitirDegradado === true;
      if (durable.formato !== 1 || durable.grupoId !== config.grupoId || !miembros.some((m) => m.id === preferido) || durable.configuracion !== huellaConfiguracion(miembros, preferido, permitirDegradado) || !Number.isSafeInteger(durable.termino) || durable.termino < 0 || !revisionValida(durable.ultimo) || (durable.escritor !== null && !miembros.some((m) => m.id === durable.escritor))) throw new Error("El estado durable del testigo no coincide con el grupo configurado");
    } else { durable = { formato: 1, grupoId: config.grupoId, configuracion: huellaConfiguracion(miembros, preferido, permitirDegradado), miembros, preferido, permitirDegradado, revision_miembros: 1, termino: 0, escritor: null, ultimo_escritor: null, ultimo: { ...config.revisionInicial }, degradado: false, ultimo_commit: null }; persistir(archivo, durable); }
    let par;
    if (fs.existsSync(firmaArchivo)) par = JSON.parse(fs.readFileSync(firmaArchivo, "utf8"));
    else { if (existiaEstado) throw new Error("Falta la identidad de firma del testigo existente: no se reemplaza automáticamente"); const p = crypto.generateKeyPairSync("ed25519"); par = { privada: p.privateKey.export({ type: "pkcs8", format: "pem" }), publica: p.publicKey.export({ type: "spki", format: "pem" }) }; persistir(firmaArchivo, par); }
    const privada = crypto.createPrivateKey(par.privada), publica = crypto.createPublicKey(privada).export({ type: "spki", format: "pem" });
    if (privada.asymmetricKeyType !== "ed25519" || publica !== par.publica) throw new Error("La identidad de firma del testigo no coincide");
    let ultimoMono = monotono(), inicio = ultimoMono, leaseHasta = 0, cerrado = false, falloReloj = false, falloDisco = false, retorno = null;
    const autenticar = crearVerificador({ grupoId: config.grupoId, miembros: () => miembros, ahora });
    function configuracionPublica() { return { grupoId: config.grupoId, preferidoId: preferido, permitirDegradado, revisionMiembros: durable.revision_miembros || 1, miembros: miembros.map(({ id, nombre, url, caPublica }) => ({ id, nombre, url, preferido: id === preferido, ...(caPublica ? { caPublica } : {}) })) }; }
    function reloj() { if (cerrado) throw new Error("El testigo está cerrado"); const n = monotono(); if (!Number.isFinite(n) || n < ultimoMono) { falloReloj = true; leaseHasta = 0; } ultimoMono = n; return n; }
    function miembro(id) { const m = miembros.find((m) => m.id === id); if (!m) throw new Error("El equipo no pertenece a este grupo"); return m; }
    function guardar(cambios) { const nuevo = { ...durable, ...cambios }; try { persistir(archivo, nuevo); durable = nuevo; } catch (e) { falloDisco = true; leaseHasta = 0; throw e; } }
    function activo(n) { return !falloReloj && !falloDisco && n - inicio >= CUARENTENA_MS && durable.escritor !== null && n < leaseHasta; }
    function retornoListo(n) { return retorno && retorno.hasta > n && misma(retorno.revision, durable.ultimo) && preferido !== durable.escritor; }
    function respuesta(n, autorizado = false) { return { autorizado, termino: durable.termino, escritor: activo(n) ? durable.escritor : null, vence_en_ms: activo(n) ? Math.max(0, Math.floor(leaseHasta - n)) : 0, uso_maximo_ms: USO_MS, ultimo: { ...durable.ultimo }, preferido_id: preferido, drenar: !!retornoListo(n), hacia_preferido: retornoListo(n) ? preferido : null, cuarentena_ms: Math.max(0, CUARENTENA_MS - (n - inicio)), bloqueado: falloReloj || falloDisco, degradado: durable.degradado === true }; }
    function exigirEscritor(id, termino, n) { miembro(id); if (!activo(n) || durable.escritor !== id || durable.termino !== termino) throw new Error("El equipo no conserva un permiso vigente de escritura"); }
    return {
      estado({ desafio = null, compacto = false } = {}) { const n = reloj(), r = respuesta(n); const m = r.escritor ? miembro(r.escritor) : null, fecha = ahora();
        const estado = { tipo: "AJB_TESTIGO_ESTADO", formato: 1, grupo_id: config.grupoId, termino: r.termino, escritor: m ? { id: m.id, nombre: m.nombre, url: m.url } : null, ultimo_escritor: durable.ultimo_escritor, ultimo: r.ultimo, preferido_id: preferido, drenar: r.drenar, hacia_preferido: r.hacia_preferido, cuarentena_ms: r.cuarentena_ms, bloqueado: r.bloqueado, degradado: r.degradado, ultimo_commit: durable.ultimo_commit, revision_miembros: durable.revision_miembros || 1, miembros: configuracionPublica().miembros, emitido_ms: fecha, vence_ms: fecha + (m ? Math.min(USO_MS, r.vence_en_ms) : USO_MS), desafio };
        if (compacto === true) { delete estado.miembros; estado.compacto = true; estado.miembro_autorizado = !!m; }
        return { estado, firma: crypto.sign(null, Buffer.from(JSON.stringify(estado)), privada).toString("base64"), clave_publica: publica };
      },
      solicitar({ nodoId, revision }) { const n = reloj(); miembro(nodoId); if (!revisionValida(revision)) throw new Error("La revisión del equipo no es válida");
        if (falloReloj || falloDisco || n - inicio < CUARENTENA_MS || !misma(revision, durable.ultimo)) return respuesta(n);
        if (activo(n)) {
          if (durable.escritor === nodoId) { leaseHasta = n + LEASE_MS; return respuesta(n, true); }
          if (nodoId === preferido) retorno = { revision: { ...revision }, hasta: n + 30000 };
          return respuesta(n);
        }
        if (retornoListo(n) && nodoId !== preferido) return respuesta(n);
        guardar({ termino: durable.termino + 1, escritor: nodoId, ultimo_escritor: nodoId }); leaseHasta = n + LEASE_MS; retorno = null;
        return respuesta(n, true);
      },
      renovar({ nodoId, termino, revision }) { const n = reloj(); exigirEscritor(nodoId, termino, n); if (!misma(revision, durable.ultimo)) throw new Error("El escritor no acredita la última revisión confirmada"); leaseHasta = n + LEASE_MS; return respuesta(n, true); },
      confirmar({ nodoId, termino, indice, sha256, replicas = [], modoDegradado = false }) { const n = reloj(); exigirEscritor(nodoId, termino, n); const revision = { indice, sha256 };
        if (!revisionValida(revision)) throw new Error("La revisión a confirmar no es válida");
        if (!misma(revision, durable.ultimo) && indice !== durable.ultimo.indice + 1) throw new Error("La confirmación no sigue al último índice confirmado");
        if (!Array.isArray(replicas) || replicas.length > miembros.length) throw new Error("Los acuses de las réplicas no son válidos");
        const copias = new Set(replicas.map((a) => verificarAckReplica(a, { grupoId: config.grupoId, escritorId: nodoId, termino, indice, sha256, miembros })));
        if (misma(revision, durable.ultimo)) {
          if (durable.degradado && copias.size) guardar({ degradado: false, ultimo_commit: { ...durable.ultimo_commit, replicas: [...copias], degradado: false, recuperado_ms: ahora() } });
          return { ...respuesta(n, true), confirmado: true };
        }
        if (miembros.length > 1 && !copias.size && !(permitirDegradado && modoDegradado === true)) throw new Error("Falta la copia durable de un respaldo antes de confirmar");
        const degradado = miembros.length > 1 && !copias.size;
        guardar({ ultimo: revision, degradado, ultimo_commit: { ...revision, escritor: nodoId, termino, replicas: [...copias], degradado, confirmado_ms: ahora() } }); return { ...respuesta(n, true), confirmado: true };
      },
      autenticarPeticion(datos) { reloj(); return autenticar(datos); },
      configuracionPublica,
      inicializarRevision(revision) { const n = reloj(); if (falloDisco || falloReloj) throw new Error("El testigo está bloqueado y necesita reiniciarse");
        if (!revisionValida(revision) || revision.indice !== 0) throw new Error("La revisión inicial debe tener índice cero y una huella válida");
        if (durable.termino !== 0 || durable.escritor !== null || durable.ultimo_commit !== null) throw new Error("La revisión inicial no se puede cambiar después del primer permiso de escritura");
        guardar({ ultimo: { indice: 0, sha256: revision.sha256 } });
        return { ...respuesta(n), inicializado: true };
      },
      actualizarMiembros(lista) { reloj(); if (falloDisco || falloReloj) throw new Error("El testigo está bloqueado y necesita reiniciarse");
        validarConfig({ grupoId: config.grupoId, miembros: lista, revisionInicial: durable.ultimo });
        if (!lista.some((m) => m.id === preferido) || (durable.escritor && !lista.some((m) => m.id === durable.escritor))) throw new Error("No se puede retirar al escritor actual ni al equipo preferido");
        for (const m of lista) { const previo = miembros.find((p) => p.id === m.id); if ((previo && (previo.clave !== m.clave || (previo.caPublica || null) !== (m.caPublica || null))) || (m.preferido && m.id !== preferido)) throw new Error("No se rotan credenciales, autoridades HTTPS existentes ni el equipo preferido en esta actualización"); }
        const nuevos = lista.map((m) => ({ ...m, preferido: m.id === preferido }));
        guardar({ miembros: nuevos, revision_miembros: (durable.revision_miembros || 1) + 1, configuracion: huellaConfiguracion(nuevos, preferido, permitirDegradado) }); miembros = nuevos;
        return configuracionPublica();
      },
      liberar({ nodoId, termino }) { const n = reloj(); exigirEscritor(nodoId, termino, n); guardar({ escritor: null }); leaseHasta = 0; return respuesta(n); },
      cerrar() { if (!cerrado) { cerrado = true; leaseHasta = 0; cerrarCandado(); } },
    };
  } catch (e) { cerrarCandado(); throw e; }
}
module.exports = { crearTestigo, protegerCarpetaTestigo: proteger, LEASE_MS, USO_MS, CUARENTENA_MS };
