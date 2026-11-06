"use strict";

// Respaldo recuperable de la instalación local. No es un paquete para sincronizar
// con Mi AJB: conserva también la identidad, la cola pendiente y las tablas locales.
// La recuperación prepara otra carpeta detenida; nunca reemplaza una base abierta.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { NOMBRES_TABLAS } = require("./esquema");
const { normalizarBusqueda } = require("./util");

const MAGIC = Buffer.from("AJBRSP01");
const CABECERA = 52;
const LIMITES = Object.freeze({ paquete: 300 * 1024 * 1024, descomprimido: 600 * 1024 * 1024, archivo: 300 * 1024 * 1024, archivos: 5000 });
const LOCALES = ["predio_meta", "predio_outbox", "predio_secuencia", "predio_sesion", "predio_admin_cache", "predio_acceso_control", "predio_acceso_intento", "predio_dispositivo", "predio_comando_ejecutado", "predio_peticion"];
const IDENTIDAD = ["instancia_id", "equipo_propietario_id", "control_confirmado", "control_conflicto", "escritor", "outbox_cursor", "ultimo_contacto", "ultima_subida"];
const AUXILIARES = ["datos/tls", "datos/galeria"];

function error(mensaje) { return new Error(mensaje); }
function hash(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function objeto(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function limite(valor, defecto) { return Number.isSafeInteger(valor) && valor > 0 ? Math.min(valor, defecto) : defecto; }
function validarClave(clave) {
  if (typeof clave !== "string" || clave.length < 12 || clave.length > 1024) throw error("La clave de recuperación debe tener entre 12 y 1024 caracteres");
}
function derivar(clave, sal) { validarClave(clave); return crypto.scryptSync(clave, sal, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }

function protegerDirectorio(carpeta) {
  fs.chmodSync(carpeta, 0o700);
  if (process.platform !== "win32") return;
  // chmod no restringe las ACL de Windows. Estas ACL se aplican exclusivamente a
  // carpetas nuevas de staging/restauración; no cambian permisos de la instalación.
  const cuenta = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const sid = /S-1-\d+(?:-\d+)+/.exec(cuenta)?.[0];
  if (!sid) throw error("No se pudo identificar al usuario para proteger el respaldo");
  execFileSync("icacls.exe", [carpeta, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/Q"], { windowsHide: true, timeout: 15000, stdio: "pipe" });
}

function temporalPrivado(padre, prefijo) {
  const carpeta = fs.mkdtempSync(path.join(padre, prefijo));
  try { protegerDirectorio(carpeta); return carpeta; }
  catch (e) { fs.rmSync(carpeta, { recursive: true, force: true }); throw e; }
}

function rutaValida(ruta) {
  if (typeof ruta !== "string" || ruta.length > 240 || /[\\:\x00-\x1f]/.test(ruta)) return false;
  if (ruta !== "config.json" && ruta !== "datos/predio.db" && !AUXILIARES.some((p) => ruta.startsWith(p + "/"))) return false;
  return ruta.split("/").every((p) => p && p !== "." && p !== ".." && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}

function leerJson(archivo) {
  const datos = JSON.parse(fs.readFileSync(archivo, "utf8").replace(/^\uFEFF/, ""));
  if (!objeto(datos)) throw error("La configuración local no es válida");
  return datos;
}

function abrirSqlite(archivo, lectura = true) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(archivo, { readOnly: lectura });
  db.function("norm", { deterministic: true }, (v) => v == null ? null : normalizarBusqueda(v));
  return db;
}

function inspeccionarBase(archivo, predioId) {
  let db;
  try {
    if (fs.statSync(archivo).size > LIMITES.archivo) throw error("La base excede el tamaño máximo de respaldo");
    db = abrirSqlite(archivo);
    const integridad = db.prepare("PRAGMA quick_check").all();
    if (integridad.length !== 1 || Object.values(integridad[0])[0] !== "ok") throw error("La base del respaldo no supera la verificación de integridad");
    const tablas = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    for (const tabla of [...NOMBRES_TABLAS, ...LOCALES]) {
      if (!tablas.has(tabla)) throw error(`El respaldo no incluye la tabla local ${tabla}`);
    }
    for (const tabla of NOMBRES_TABLAS) {
      const otro = db.prepare(`SELECT predio_id FROM ${tabla} WHERE predio_id <> ? LIMIT 1`).get(predioId);
      if (otro) throw error("La base del respaldo contiene datos de otro predio");
    }
    const meta = Object.fromEntries(db.prepare("SELECT clave, valor FROM predio_meta").all().map((f) => [f.clave, f.valor]));
    const identidad = Object.fromEntries(IDENTIDAD.map((k) => [k, meta[k] ?? null]));
    const cursor = Number(meta.outbox_cursor || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw error("El cursor de sincronización del respaldo no es válido");
    const cola = db.prepare("SELECT COUNT(*) AS n, COALESCE(MIN(seq), 0) AS primera, COALESCE(MAX(seq), 0) AS ultima FROM predio_outbox WHERE seq > ?").get(cursor);
    const esquema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all();
    return { identidad, pendientes: { cantidad: Number(cola.n), primera_seq: Number(cola.primera), ultima_seq: Number(cola.ultima), cursor }, esquema_sha256: hash(Buffer.from(JSON.stringify(esquema))) };
  } catch (e) {
    if (/respaldo|predio|cursor|tabla local/.test(e.message)) throw e;
    throw error("La base del respaldo no es un SQLite local válido");
  } finally { if (db) db.close(); }
}

function recogerAuxiliares(base, ruta, agregar) {
  const absoluto = path.join(base, ...ruta.split("/"));
  if (!fs.existsSync(absoluto)) return;
  const stat = fs.lstatSync(absoluto);
  if (stat.isSymbolicLink()) throw error("No se incluyen enlaces simbólicos en el respaldo");
  if (stat.isDirectory()) {
    for (const nombre of fs.readdirSync(absoluto).sort()) recogerAuxiliares(base, `${ruta}/${nombre}`, agregar);
  } else if (stat.isFile()) {
    if (stat.size > LIMITES.archivo) throw error("Un archivo local excede el tamaño máximo de respaldo");
    agregar(ruta, fs.readFileSync(absoluto));
  } else throw error("El respaldo sólo admite archivos y carpetas regulares");
}

function cifrar(datos, clave) {
  const sal = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const prefijo = Buffer.concat([MAGIC, sal, iv]);
  const llave = derivar(clave, sal);
  try {
    const cifrador = crypto.createCipheriv("aes-256-gcm", llave, iv);
    cifrador.setAAD(prefijo);
    const contenido = Buffer.concat([cifrador.update(zlib.gzipSync(Buffer.from(JSON.stringify(datos)), { level: 6 })), cifrador.final()]);
    const buffer = Buffer.concat([prefijo, cifrador.getAuthTag(), contenido]);
    if (buffer.length > LIMITES.paquete) throw error("El respaldo excede el tamaño máximo permitido");
    return buffer;
  } finally { llave.fill(0); }
}

async function crearRespaldo({ db, base, config, clave, version = null }) {
  validarClave(clave);
  if (!db || db.dialecto !== "sqlite" || typeof db.exclusivo !== "function") throw error("El respaldo completo requiere la base SQLite local");
  if (!base || !objeto(config) || !Number.isSafeInteger(Number(config.predio_id)) || Number(config.predio_id) <= 0) throw error("Falta identificar la instalación local del respaldo");
  if (Number(db.predioId) !== Number(config.predio_id)) throw error("La configuración y la base local pertenecen a distintos predios");
  const carpeta = temporalPrivado(os.tmpdir(), "ajb-respaldo-");
  try {
    const datos = await db.exclusivo(() => {
      const snapshot = path.join(carpeta, "predio.db");
      db.conexion.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      const rutaConfig = path.join(base, "config.json");
      if (fs.existsSync(rutaConfig) && fs.lstatSync(rutaConfig).isSymbolicLink()) throw error("No se incluyen enlaces simbólicos en el respaldo");
      const configDisco = fs.existsSync(rutaConfig) ? leerJson(rutaConfig) : {};
      const configuracion = { ...configDisco, ...config };
      const predioId = Number(configuracion.predio_id);
      const resumen = inspeccionarBase(snapshot, predioId);
      const archivos = [];
      const vistos = new Set();
      let total = 0;
      function agregar(ruta, contenido) {
        const normal = ruta.toLowerCase();
        if (!rutaValida(ruta) || vistos.has(normal)) throw error("El respaldo contiene una ruta inválida o repetida");
        vistos.add(normal);
        total += contenido.length;
        if (archivos.length >= LIMITES.archivos || contenido.length > LIMITES.archivo || total > LIMITES.descomprimido / 1.4) throw error("El contenido del respaldo excede el límite permitido");
        archivos.push({ ruta, bytes: contenido.length, sha256: hash(contenido), contenido: contenido.toString("base64") });
      }
      agregar("datos/predio.db", fs.readFileSync(snapshot));
      agregar("config.json", Buffer.from(JSON.stringify(configuracion, null, 2)));
      for (const ruta of AUXILIARES) recogerAuxiliares(base, ruta, agregar);
      return { tipo: "ajb-respaldo-local", formato: 1, manifest: {
        generado: new Date().toISOString(), predio_id: predioId, predio_codigo: String(configuracion.predio_codigo || ""),
        version: version == null ? null : String(version), equipo_nombre: os.hostname(),
        ...resumen, incluye_codigo: false, archivos: archivos.length,
      }, archivos };
    });
    const buffer = cifrar(datos, clave);
    const codigo = String(datos.manifest.predio_codigo || datos.manifest.predio_id).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    return { buffer, nombre: `predio-${codigo}-${datos.manifest.generado.replace(/[:.]/g, "-")}.ajbrespaldo`, sha256: hash(buffer), manifest: datos.manifest };
  } finally { fs.rmSync(carpeta, { recursive: true, force: true }); }
}

function abrirRespaldo(buffer, { clave, predioId, maxBytes, maxDescomprimido } = {}) {
  validarClave(clave);
  if (!Buffer.isBuffer(buffer) || buffer.length <= CABECERA || buffer.length > limite(maxBytes, LIMITES.paquete) || !buffer.subarray(0, 8).equals(MAGIC)) throw error("El archivo no es un respaldo local válido o excede el límite permitido");
  let datos;
  const llave = derivar(clave, buffer.subarray(8, 24));
  try {
    const descifrador = crypto.createDecipheriv("aes-256-gcm", llave, buffer.subarray(24, 36));
    descifrador.setAAD(buffer.subarray(0, 36));
    descifrador.setAuthTag(buffer.subarray(36, 52));
    const comprimido = Buffer.concat([descifrador.update(buffer.subarray(CABECERA)), descifrador.final()]);
    datos = JSON.parse(zlib.gunzipSync(comprimido, { maxOutputLength: limite(maxDescomprimido, LIMITES.descomprimido) }).toString("utf8"));
  } catch (_e) { throw error("No se pudo abrir el respaldo: la clave es incorrecta, el archivo fue alterado o excede el límite permitido"); }
  finally { llave.fill(0); }
  if (!objeto(datos) || datos.tipo !== "ajb-respaldo-local" || datos.formato !== 1 || !objeto(datos.manifest) || !Array.isArray(datos.archivos)) throw error("El formato del respaldo no es compatible");
  const m = datos.manifest;
  if (!Number.isSafeInteger(m.predio_id) || m.predio_id <= 0 || (predioId !== undefined && Number(predioId) !== m.predio_id)) throw error("El respaldo corresponde a otro predio");
  if (typeof m.generado !== "string" || !Number.isFinite(Date.parse(m.generado)) || m.incluye_codigo !== false || m.archivos !== datos.archivos.length || !datos.archivos.length || datos.archivos.length > LIMITES.archivos) throw error("El manifiesto del respaldo no es válido");
  const vistos = new Set();
  let total = 0;
  const archivos = datos.archivos.map((a) => {
    if (!objeto(a) || !rutaValida(a.ruta) || vistos.has(a.ruta.toLowerCase()) || !Number.isSafeInteger(a.bytes) || a.bytes < 0 || a.bytes > LIMITES.archivo || typeof a.contenido !== "string" || a.contenido.length !== 4 * Math.ceil(a.bytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.contenido) || !/^[a-f0-9]{64}$/.test(a.sha256)) throw error("El respaldo contiene archivos o rutas no válidos");
    vistos.add(a.ruta.toLowerCase());
    const contenido = Buffer.from(a.contenido, "base64");
    total += contenido.length;
    if (contenido.length !== a.bytes || contenido.toString("base64") !== a.contenido || hash(contenido) !== a.sha256 || total > LIMITES.descomprimido / 1.4) throw error("El contenido del respaldo no coincide con sus verificaciones");
    return { ruta: a.ruta, contenido };
  });
  const archivoConfig = archivos.find((a) => a.ruta === "config.json");
  const archivoDb = archivos.find((a) => a.ruta === "datos/predio.db");
  if (!archivoConfig || !archivoDb) throw error("El respaldo está incompleto: faltan configuración o base local");
  let config;
  try { config = JSON.parse(archivoConfig.contenido.toString("utf8")); } catch (_e) { throw error("La configuración del respaldo no es válida"); }
  if (!objeto(config) || Number(config.predio_id) !== m.predio_id || String(config.predio_codigo || "") !== m.predio_codigo) throw error("La configuración y el predio del respaldo no coinciden");
  return { manifest: m, archivos, archivoDb };
}

function comprobarSnapshot(datos, carpeta) {
  const archivo = path.join(carpeta, "verificacion.db");
  fs.writeFileSync(archivo, datos.archivoDb.contenido, { flag: "wx", mode: 0o600 });
  const real = inspeccionarBase(archivo, datos.manifest.predio_id);
  for (const clave of ["identidad", "pendientes"]) {
    if (JSON.stringify(real[clave]) !== JSON.stringify(datos.manifest[clave])) throw error("La identidad o la cola pendiente no coinciden con el manifiesto del respaldo");
  }
  if (real.esquema_sha256 !== datos.manifest.esquema_sha256) throw error("El esquema del respaldo no coincide con su manifiesto");
}

function validarRespaldo(buffer, opciones = {}) {
  const datos = abrirRespaldo(buffer, opciones);
  const carpeta = temporalPrivado(os.tmpdir(), "ajb-validar-");
  try { comprobarSnapshot(datos, carpeta); return { ...datos.manifest, sha256: hash(buffer), modo_recuperacion: "STANDBY" }; }
  finally { fs.rmSync(carpeta, { recursive: true, force: true }); }
}

function restaurarRespaldo(buffer, { destino, ...opciones } = {}) {
  if (typeof destino !== "string" || !destino.trim()) throw error("Indicá una carpeta nueva para recuperar el respaldo");
  const final = path.resolve(destino);
  // lstat detecta también enlaces rotos. Nunca se elimina ni reemplaza un destino.
  try { fs.lstatSync(final); throw error("La carpeta de recuperación ya existe: elegí una carpeta nueva"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  const padre = path.dirname(final);
  if (!fs.statSync(padre).isDirectory()) throw error("La carpeta contenedora de la recuperación no existe");
  const datos = abrirRespaldo(buffer, opciones);
  const temporal = temporalPrivado(padre, ".ajb-restaurar-");
  let terminado = false;
  try {
    comprobarSnapshot(datos, temporal);
    fs.unlinkSync(path.join(temporal, "verificacion.db"));
    for (const a of datos.archivos) {
      const archivo = path.join(temporal, ...a.ruta.split("/"));
      fs.mkdirSync(path.dirname(archivo), { recursive: true, mode: 0o700 });
      fs.writeFileSync(archivo, a.contenido, { flag: "wx", mode: 0o600 });
    }
    const marca = { formato: 1, modo: "STANDBY", activacion_requerida: true, recuperado: new Date().toISOString(), respaldo_sha256: hash(buffer), generado: datos.manifest.generado, predio_id: datos.manifest.predio_id, predio_codigo: datos.manifest.predio_codigo, identidad_origen: datos.manifest.identidad };
    let restaurada;
    try {
      restaurada = abrirSqlite(path.join(temporal, "datos", "predio.db"), false);
      restaurada.exec("PRAGMA journal_mode = DELETE");
      restaurada.prepare("INSERT INTO predio_meta (clave, valor) VALUES ('restauracion_pendiente', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(JSON.stringify(marca));
    } finally { if (restaurada) restaurada.close(); }
    fs.writeFileSync(path.join(temporal, "runtime.json"), JSON.stringify({ autoarranque: false, detenido: true }, null, 2), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(temporal, "restauracion.json"), JSON.stringify(marca, null, 2), { flag: "wx", mode: 0o600 });
    // Verificación final de la copia modificada: la cola y la identidad de origen
    // deben seguir idénticas; sólo se añadió el bloqueo de recuperación.
    const real = inspeccionarBase(path.join(temporal, "datos", "predio.db"), datos.manifest.predio_id);
    if (JSON.stringify(real.identidad) !== JSON.stringify(datos.manifest.identidad) || JSON.stringify(real.pendientes) !== JSON.stringify(datos.manifest.pendientes)) throw error("La recuperación alteró la identidad o la cola pendiente");
    try { fs.lstatSync(final); throw error("La carpeta de recuperación ya existe: no se reemplazó"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    fs.renameSync(temporal, final);
    terminado = true;
    return { carpeta: final, manifest: datos.manifest, modo: "STANDBY", activacion_requerida: true, archivo_base: path.join(final, "datos", "predio.db") };
  } finally { if (!terminado) fs.rmSync(temporal, { recursive: true, force: true }); }
}

module.exports = { crearRespaldo, validarRespaldo, restaurarRespaldo, LIMITES };
