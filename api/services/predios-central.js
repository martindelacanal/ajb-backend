"use strict";

// Lado central de los Predios: réplica MySQL de los datos de cada camping, órdenes
// remotas, paquetes para pendrive, instalador y datos de afiliados con reserva.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const os = require("node:os");
const crypto = require("node:crypto");

const DIR_PREDIOS = path.join(__dirname, "..", "..", "predios");
const U = require("../../predios/lib/util");
const { NOMBRES_TABLAS, columnasDe, TABLAS, tablasDeInstantanea } = require("../../predios/lib/esquema");
const { crearMysql } = require("../../predios/lib/db-mysql");
const { armarPaquete } = require("../../predios/lib/paquete");
const { aplicarMaestros } = require("../../predios/lib/maestros");
const { sembrarPredio, PREDIOS } = require("../../predios/lib/semilla");
const firma = require("../../predios/lib/firma");
const { nuevosAvisos, entregarAvisos } = require("./predios-avisos");
const { exigirPropietario } = require("./predios-propietario");

// Estados de reserva que NO cuentan como estadía (rechazada, solicitud de sorteo,
// no adjudicada, convenio rechazado, cancelada).
const ESTADOS_EXCLUIDOS = [4, 6, 8, 12, 13];

// Clave privada Ed25519 del sistema general (PREDIOS_FIRMA_PRIVADA: PEM o PEM en base64).
// Sin variable, se genera una vez y se guarda en .cache/predios (sólo para desarrollo).
let claveCache = null;
function claveFirma() {
  if (claveCache) return claveCache;
  let privada = String(process.env.PREDIOS_FIRMA_PRIVADA || "").trim();
  if (privada && !privada.includes("BEGIN")) privada = Buffer.from(privada, "base64").toString("utf8");
  if (!privada) {
    const archivo = path.join(rutaCache(), "firma-privada.pem");
    if (!fs.existsSync(archivo)) fs.writeFileSync(archivo, firma.generarPar().privada, { mode: 0o600 });
    privada = fs.readFileSync(archivo, "utf8");
  }
  claveCache = { privada, publica: firma.publicaDe(privada) };
  return claveCache;
}

let paqueteCache = null;
function claveLan(predioId) {
  return crypto.createHmac("sha256", claveFirma().privada).update(`predio-lan:${Number(predioId)}`).digest("hex");
}

function paqueteCodigo() {
  if (!paqueteCache) {
    paqueteCache = armarPaquete(DIR_PREDIOS);
    paqueteCache.firma = firma.firmar(paqueteCache.buffer, claveFirma().privada);
  }
  return paqueteCache;
}

// Envuelve un paquete para pendrive con la firma del sistema general.
function paqueteFirmado(datos) {
  const contenido = JSON.stringify(datos);
  return zlib.gzipSync(Buffer.from(JSON.stringify({
    tipo: "predio-paquete-firmado", firma: firma.firmar(Buffer.from(contenido), claveFirma().privada), contenido,
  })));
}

function enLinea(predio) {
  if (!predio?.ultima_conexion) return false;
  const t = new Date(String(predio.ultima_conexion).replace(" ", "T") + "-03:00").getTime();
  return Date.now() - t < 30000;
}

function serviciosDe(predio) {
  try {
    const lista = JSON.parse(predio.servicio_codigos || "[]");
    return Array.isArray(lista) ? lista.map(String) : [];
  } catch (_e) {
    return [];
  }
}

async function obtenerPredio(db, codigo) {
  const [filas] = await db.query("SELECT * FROM predio WHERE codigo = ? LIMIT 1", [String(codigo || "").toUpperCase()]);
  return filas[0] ? normalizar(filas[0]) : null;
}

function normalizar(fila) {
  const salida = {};
  for (const [k, v] of Object.entries(fila)) salida[k] = v instanceof Date ? U.fechaHora(v) : v;
  return salida;
}

async function evento(db, predioId, tipo, detalle, usuarioId = null) {
  await db.query("INSERT INTO predio_evento (predio_id, tipo, detalle, usuario_id) VALUES (?, ?, ?, ?)",
    [predioId, tipo, detalle === undefined || detalle === null ? null : (typeof detalle === "string" ? detalle : JSON.stringify(detalle)).slice(0, 60000), usuarioId]);
}

// ------------------------------------------------------------------ réplica

const cacheColumnas = new Map();
async function columnasMysql(db, tabla) {
  if (!cacheColumnas.has(tabla)) {
    const [r] = await db.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?", [tabla]);
    cacheColumnas.set(tabla, new Set(r.map((f) => f.c || f.C || f.COLUMN_NAME)));
  }
  return cacheColumnas.get(tabla);
}

function valorColumna(tipo, v) {
  if (v === undefined) return null;
  if (v === "" && /^(dt|date|int|money|qty|pct|bool)/.test(tipo)) return null;
  return v;
}

async function upsertFilas(conexion, predioId, tabla, filas) {
  if (!filas.length) return;
  const definicion = columnasDe(tabla);
  const existentes = await columnasMysql(conexion, tabla);
  const disponibles = Object.keys(definicion).filter(c => existentes.has(c));
  const presentes = (f, c) => c === "predio_id" || Object.hasOwn(f, c);
  // Una notebook anterior puede omitir columnas nuevas. Conservar los valores
  // de la réplica al actualizar y usar el default de la tabla al insertar.
  if (filas.some(f => disponibles.some(c => presentes(f, c) !== presentes(filas[0], c)))) {
    for (const f of filas) await upsertFilas(conexion, predioId, tabla, [f]);
    return;
  }
  const cols = disponibles.filter(c => presentes(filas[0], c));
  const valores = [];
  for (const f of filas) {
    for (const c of cols) valores.push(c === "predio_id" ? predioId : valorColumna(definicion[c], f[c]));
  }
  const filaSql = `(${cols.map(() => "?").join(", ")})`;
  const actualizar = cols.filter((c) => c !== "predio_id" && c !== "id").map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ") || "id=VALUES(id)";
  await conexion.query(
    `INSERT INTO \`${tabla}\` (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES ${filas.map(() => filaSql).join(", ")}
     ON DUPLICATE KEY UPDATE ${actualizar}`, valores);
}

// Aplica los cambios que sube la notebook (en orden y en una transacción).
async function aplicarCambios(conexion, predio, cambios) {
  // Serializa push y archivos del mismo predio antes de comprobar los avisos
  // existentes: dos sincronizaciones simultáneas no deben entregarlos dos veces.
  await conexion.query("SELECT id FROM predio WHERE id = ? FOR UPDATE", [predio.id]);
  const nuevosPermisos = [];
  const porTabla = new Map();
  const borrar = [];
  for (const c of cambios || []) {
    if (!TABLAS[c.tabla]) continue;
    const id = Number(c.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (c.op === "D") { borrar.push({ tabla: c.tabla, id }); continue; }
    if (!c.datos || typeof c.datos !== "object") continue;
    const fila = { ...c.datos, id };
    if (!porTabla.has(c.tabla)) porTabla.set(c.tabla, []);
    porTabla.get(c.tabla).push(fila);
  }
  const permisos = porTabla.get("predio_permiso") || [];
  if (permisos.length) {
    const pendientes = permisos.filter((p) => p.estado === "PENDIENTE");
    if (pendientes.length) {
      const [previos] = await conexion.query(
        `SELECT id, estado FROM predio_permiso WHERE predio_id = ? AND id IN (${pendientes.map(() => "?").join(", ")})`,
        [predio.id, ...pendientes.map((p) => p.id)]);
      const conocidos = new Map(previos.map((p) => [Number(p.id), p.estado]));
      for (const p of pendientes) if (conocidos.get(Number(p.id)) !== "PENDIENTE") nuevosPermisos.push(p);
    }
  }
  const avisos = await nuevosAvisos(conexion, predio.id, porTabla.get("predio_aviso") || []);
  for (const [tabla, filas] of porTabla) {
    for (let i = 0; i < filas.length; i += 200) await upsertFilas(conexion, predio.id, tabla, filas.slice(i, i + 200));
  }
  for (const b of borrar) await conexion.query(`DELETE FROM \`${b.tabla}\` WHERE predio_id = ? AND id = ?`, [predio.id, b.id]);
  await entregarAvisos(conexion, predio, avisos);
  return { aplicados: cambios.length, nuevosPermisos };
}

async function instantaneaTabla(db, predioId, tabla, desdeId = 0, limite = 2000) {
  if (!TABLAS[tabla]) throw U.error("Tabla desconocida", 400);
  const [filas] = await db.query(`SELECT * FROM \`${tabla}\` WHERE predio_id = ? AND id > ? ORDER BY id LIMIT ?`, [predioId, Number(desdeId) || 0, Math.min(5000, Number(limite) || 2000)]);
  return filas.map(normalizar);
}

async function instantaneaCompleta(db, predioId) {
  const tablas = {};
  for (const t of NOMBRES_TABLAS) {
    const [filas] = await db.query(`SELECT * FROM \`${t}\` WHERE predio_id = ? ORDER BY id`, [predioId]);
    tablas[t] = filas.map(normalizar);
  }
  return tablas;
}

// Reemplaza la réplica de un predio con el archivo exportado en la notebook.
async function importarExportacion(pool, predio, datos, { forzar = false, usuarioId = null } = {}) {
  if (datos.tipo !== "predio-exportacion") throw U.error("El archivo no es una exportación del sistema del predio");
  if (Number(datos.predio_id) !== Number(predio.id)) throw U.error(`El archivo es de otro predio (${datos.predio_codigo || datos.predio_id})`);
  if (predio.escritor === "LOCAL" && predio.instancia_id && datos.instancia_id !== predio.instancia_id && !forzar) {
    throw U.error("El archivo viene de una instalación distinta a la que hoy tiene el control del predio. Si reemplazaron la notebook, confirmá para continuar.", 409, { codigo: "OTRA_INSTALACION" });
  }
  const conexion = await pool.getConnection();
  const resumen = {};
  try {
    await conexion.beginTransaction();
    const [[actual]] = await conexion.query("SELECT * FROM predio WHERE id = ? FOR UPDATE", [predio.id]);
    if (!actual) throw U.error("No encontramos el predio", 404);
    const [grupos] = await conexion.query("SELECT id FROM predio_evento WHERE predio_id = ? AND tipo = 'HA_REGISTRO' LIMIT 1", [predio.id]);
    if (grupos.length) throw U.error("Este predio tiene respaldo automático. Sincronizá desde la PC que está en servicio; un archivo de tablas no puede reemplazar la base ni el control del grupo.", 409, { codigo: "HA_IMPORTACION_NO_PERMITIDA" });
    if (!forzar) exigirPropietario(actual, datos);
    const avisos = await nuevosAvisos(conexion, predio.id, Array.isArray(datos.tablas?.predio_aviso) ? datos.tablas.predio_aviso : []);
    const tablas = tablasDeInstantanea(datos.tablas || {});
    for (const tabla of NOMBRES_TABLAS) {
      const filas = Array.isArray(tablas[tabla]) ? tablas[tabla] : null;
      if (!filas) continue;
      await conexion.query(`DELETE FROM \`${tabla}\` WHERE predio_id = ?`, [predio.id]);
      for (let i = 0; i < filas.length; i += 300) await upsertFilas(conexion, predio.id, tabla, filas.slice(i, i + 300));
      resumen[tabla] = filas.length;
    }
    await entregarAvisos(conexion, predio, avisos);
    await conexion.query(
      "UPDATE predio SET escritor = 'LOCAL', instancia_id = ?, equipo_id = COALESCE(?, equipo_id), ultimo_seq = GREATEST(ultimo_seq, ?), ultimo_push = NOW(), version_local = COALESCE(?, version_local) WHERE id = ?",
      [datos.instancia_id || predio.instancia_id, datos.equipo_id || null, Number(datos.hasta_seq) || 0, datos.version || null, predio.id]);
    await conexion.commit();
  } catch (e) {
    await conexion.rollback();
    throw e;
  } finally {
    conexion.release();
  }
  await evento(pool, predio.id, "IMPORTACION_ARCHIVO", { generado: datos.generado, filas: resumen }, usuarioId);
  return resumen;
}

// ------------------------------------------------------------------ afiliados con reservas

async function armarMaestros(db, predio, { admiteSalidas = true } = {}) {
  const hoy = U.hoy();
  const desde = U.sumarDias(hoy, -120);
  const hasta = U.sumarDias(hoy, 400);
  const servicios = serviciosDe(predio);
  const [departamentales] = await db.query("SELECT id, nombre, habilitado FROM departamental ORDER BY nombre");
  let reservas = [];
  if (servicios.length) {
    [reservas] = await db.query(
      `SELECT r.id AS reserva_id, r.usuario_id, r.fecha_inicio, r.fecha_fin, r.numero_parcela, er.nombre AS estado,
         s.nombre AS servicio, rc.nombre AS recurso,
         u.documento, u.legajo, u.nombre, u.apellido, u.departamental_id,
         (SELECT COUNT(*) FROM reserva_familiar rf WHERE rf.reserva_id = r.id) AS acompaniantes
       FROM reserva r
       JOIN servicio s ON s.id = r.servicio_id
       JOIN usuario u ON u.id = r.usuario_id
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
       LEFT JOIN recurso rc ON rc.id = r.recurso_id
       WHERE s.codigo IN (?) AND NOT EXISTS (SELECT 1 FROM recepcion_particular rp WHERE rp.usuario_id=u.id) AND r.estado_reserva_id NOT IN (?) AND r.fecha_fin >= ? AND r.fecha_inicio <= ?
       ORDER BY r.fecha_inicio`, [servicios, ESTADOS_EXCLUIDOS, desde, hasta]);
  }
  const porUsuario = new Map();
  for (const r of reservas) {
    if (!porUsuario.has(r.usuario_id)) {
      porUsuario.set(r.usuario_id, {
        usuario_id: r.usuario_id,
        documento: r.documento,
        legajo: r.legajo,
        nombre: [r.apellido, r.nombre].filter(Boolean).join(", "),
        departamental_id: r.departamental_id,
        estadias: [],
      });
    }
    porUsuario.get(r.usuario_id).estadias.push({
      reserva_id: r.reserva_id,
      servicio: r.servicio,
      unidad: r.numero_parcela ? `${r.recurso || "Parcela"} ${r.numero_parcela}` : (r.recurso || null),
      fecha_inicio: String(r.fecha_inicio).slice(0, 10),
      fecha_fin: String(r.fecha_fin).slice(0, 10),
      estado: r.estado,
      personas: 1 + Number(r.acompaniantes || 0),
    });
  }
  // Una versión anterior asienta las diferencias como deuda genérica. No se le
  // entregan eventos de la nueva cuenta ni eventos posteriores que adelanten la revisión.
  const eventosCompatibles = admiteSalidas ? "" : `AND NOT EXISTS (
    SELECT 1 FROM recepcion_reserva_evento nuevo WHERE nuevo.predio_id=e.predio_id AND nuevo.id<=e.id
      AND (JSON_TYPE(JSON_EXTRACT(IF(JSON_VALID(nuevo.actual),nuevo.actual,'{}'),'$.plan_salida'))='OBJECT'
        OR JSON_LENGTH(JSON_EXTRACT(IF(JSON_VALID(nuevo.actual),nuevo.actual,'{}'),'$.diferenciales'))>0))`;
  return {
    // Si se cortó la red después del COMMIT de Turismo, la notebook recupera
    // cada confirmación en orden. La misma clave evita duplicar cargos o saldos.
    recepcion_confirmada: predio.escritor === "LOCAL" && servicios.length ? (await db.query(
      `SELECT e.id,e.operacion,e.empleado_id,e.actor,e.motivo,e.actual FROM recepcion_reserva_evento e
       JOIN reserva r ON r.id=e.reserva_id JOIN servicio s ON s.id=r.servicio_id
       WHERE e.predio_id=? AND s.codigo IN (?) AND NOT EXISTS (SELECT 1 FROM predio_recepcion_recibo p WHERE p.predio_id=e.predio_id AND p.clave=e.operacion)
       ${eventosCompatibles}
       ORDER BY e.id LIMIT 100`,[predio.id,servicios]))[0] : [],
    generado: U.fechaHora(),
    ventana_desde: desde,
    departamentales: departamentales.map((d) => ({ id: d.id, nombre: d.nombre, activo: String(d.habilitado || "Y").toUpperCase() !== "N" })),
    afiliados: [...porUsuario.values()],
  };
}

// Mientras el predio no tenga notebook instalada, el sistema general aplica él mismo
// los afiliados a la réplica (así se ven en la pantalla remota).
async function refrescarMaestrosCentral(pool, predio) {
  if (predio.escritor !== "CENTRAL") return null;
  const maestros = await armarMaestros(pool, predio);
  const db = crearMysql(pool, { predioId: predio.id });
  return db.tx((t) => aplicarMaestros(t, { db: t, pid: predio.id, usuario: { id: null, nombre: "Sincronización" }, origen: "SISTEMA" }, maestros));
}

// ------------------------------------------------------------------ predios nuevos

async function crearPredio(pool, { codigo, nombre, servicios, usuarioId }) {
  const cod = String(codigo || "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (cod.length < 3 || cod.length > 30) throw U.error("El código tiene que tener entre 3 y 30 letras o números");
  const nom = U.texto(nombre, { max: 120, campo: "El nombre", requerido: true });
  const lista = Array.isArray(servicios) ? servicios.map((s) => String(s).slice(0, 80)) : [];
  const [dup] = await pool.query("SELECT id FROM predio WHERE codigo = ?", [cod]);
  if (dup.length) throw U.error("Ya existe un predio con ese código", 409);
  const [r] = await pool.query("INSERT INTO predio (codigo, nombre, servicio_codigos, escritor) VALUES (?, ?, ?, 'CENTRAL')", [cod, nom, JSON.stringify(lista)]);
  const predioId = r.insertId;
  const db = crearMysql(pool, { predioId });
  await db.tx(async (t) => {
    const ctx = { db: t, pid: predioId };
    if (PREDIOS[cod]) await sembrarPredio(t, ctx, cod);
    else {
      const N = require("../../predios/lib/negocio");
      const actor = { ...ctx, usuario: { id: null, nombre: "Instalación" } };
      await N.insertar(t, actor, "predio_boca", { nombre: "Almacén", es_origen: 1, es_destino: 1, es_almacen: 1, activo: 1, orden: 1 });
      await N.guardarConfig(t, actor, "nombre_predio", nom);
    }
  });
  await pool.query("UPDATE predio SET ultima_escritura_central = NOW() WHERE id = ?", [predioId]);
  await evento(pool, predioId, "ALTA", { codigo: cod, nombre: nom, servicios: lista }, usuarioId);
  return predioId;
}

// ------------------------------------------------------------------ instalador

function rutaCache() {
  const dir = path.join(__dirname, "..", "..", ".cache", "predios");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runtimeWindows() {
  const version = process.version;
  const nombre = `node-${version}-win-x64.zip`;
  const archivo = path.join(rutaCache(), nombre);
  if (fs.existsSync(archivo) && fs.statSync(archivo).size > 10 * 1024 * 1024) return { archivo, nombre, version };
  try {
    const r = await fetch(`https://nodejs.org/dist/${version}/${nombre}`, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) return null;
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length < 10 * 1024 * 1024) return null;
    fs.writeFileSync(`${archivo}.tmp`, buffer);
    fs.renameSync(`${archivo}.tmp`, archivo);
    return { archivo, nombre, version };
  } catch (_e) {
    return null;
  }
}

async function armarInstalador(pool, predio, { urlServidor, token, puerto = 8080, incluirRuntime = true }) {
  const archiver = require("archiver");
  const paquete = paqueteCodigo();
  const { leerPaquete } = require("../../predios/lib/paquete");
  const datosCodigo = leerPaquete(paquete.buffer);
  const carpetaVersion = datosCodigo.version.replace(/[^a-zA-Z0-9.+_-]/g, "_");
  const raiz = `AJB-Predio-${predio.codigo}`;
  const config = {
    predio_id: predio.id,
    predio_codigo: predio.codigo,
    predio_nombre: predio.nombre,
    servidor: urlServidor,
    token,
    puerto,
    actualizaciones_automaticas: true,
    clave_publica: claveFirma().publica,
    clave_lan: claveLan(predio.id),
  };
  const datosIniciales = zlib.gzipSync(Buffer.from(JSON.stringify({
    tipo: "predio-datos-iniciales", predio_id: predio.id, generado: U.fechaHora(), tablas: await instantaneaCompleta(pool, predio.id),
  })));
  const runtime = incluirRuntime ? await runtimeWindows() : null;
  const zip = archiver("zip", { zlib: { level: 6 } });
  for (const a of datosCodigo.archivos) {
    zip.append(Buffer.from(a.contenido, "base64"), { name: `${raiz}/app/versiones/${carpetaVersion}/${a.ruta}` });
    if (a.ruta === "lanzador.js") zip.append(Buffer.from(a.contenido, "base64"), { name: `${raiz}/arranque.js` });
    if (a.ruta.startsWith("windows/")) {
      const nombre = a.ruta.slice("windows/".length);
      const destino = nombre === "INSTALAR.bat" || nombre === "LEEME.txt" ? `${raiz}/${nombre}` : `${raiz}/instalador/${nombre}`;
      zip.append(Buffer.from(a.contenido, "base64"), { name: destino });
    }
  }
  zip.append(datosCodigo.version, { name: `${raiz}/app/versiones/${carpetaVersion}/.version` });
  zip.append(carpetaVersion, { name: `${raiz}/app/ACTUAL` });
  zip.append(JSON.stringify(config, null, 2), { name: `${raiz}/config.json` });
  zip.append(datosIniciales, { name: `${raiz}/datos-iniciales.json.gz` });
  if (runtime) zip.file(runtime.archivo, { name: `${raiz}/runtime/${runtime.nombre}` });
  zip.finalize();
  return { zip, nombreArchivo: `${raiz}-instalador.zip`, runtime: !!runtime, version: datosCodigo.version };
}

function nuevoToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: U.sha256(token) };
}

module.exports = {
  DIR_PREDIOS,
  paqueteCodigo,
  paqueteFirmado,
  claveFirma,
  claveLan,
  enLinea,
  serviciosDe,
  obtenerPredio,
  normalizar,
  evento,
  aplicarCambios,
  instantaneaTabla,
  instantaneaCompleta,
  importarExportacion,
  armarMaestros,
  refrescarMaestrosCentral,
  crearPredio,
  armarInstalador,
  nuevoToken,
  ESTADOS_EXCLUIDOS,
  hostname: os.hostname,
};
