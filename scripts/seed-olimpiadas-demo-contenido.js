"use strict";

// Dataset explícito de demostración: sólo Olimpiadas 2026 / Demo, id 1.
// La API no se invoca: no se generan correos ni notificaciones a inscriptos.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const sharp = require("sharp");
const { S3Client, HeadObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

const SEED_ID = "20261020_olimpiadas_demo_contenido";
const PREFIJO = "olimpiadas/1/demo-contenido-20261020";
const FUENTE = "https://ajb.org.ar/mas-de-mil-companeros-y-companeras-participaron-de-las-xxvi-olimpiadas-judiciales-de-la-ajb/";
const FOTOS = [
  ["basquet-futbol", "13.57.34-1", "Básquet y fútbol", "2026-09-23", "Deporte"],
  ["pool-voley", "13.57.36-1", "Pool y vóley", "2026-09-24", "Deporte"],
  ["futbol-maraton", "13.57.36", "Fútbol y maratón", "2026-09-24", "Encuentro"],
  ["ping-pong-pesca", "13.57.37-1", "Ping-pong y pesca", "2026-09-25", "Encuentro"],
  ["natacion-padel", "13.57.37", "Natación y pádel", "2026-09-25", "Deporte"],
  ["tenis-voley", "13.57.38-1", "Tenis y vóley", "2026-09-26", "Deporte"],
].map(([clave, archivo, tema, fecha, etiqueta], orden) => ({
  clave, url: `https://ajb.org.ar/wp-content/uploads/2025/12/WhatsApp-Image-2025-12-02-at-${archivo}.jpeg`,
  archivo: `${PREFIJO}/${clave}.webp`, miniatura_archivo: `${PREFIJO}/${clave}-miniatura.webp`,
  epigrafe: `${tema} · Archivo AJB 2025 · imagen de ejemplo para esta edición de prueba.`,
  fecha, etiqueta, orden: orden + 1,
}));
const NOVEDADES = [
  { titulo: "[Ejemplo] Un encuentro para volver a vivir", fijada: 1, fecha_publicacion: "2026-09-26 19:00:00",
    cuerpo: "Esta edición de prueba reúne deporte, encuentro y compañerismo. Recorré el cronograma, consultá los resultados y abrí la galería desde el inicio de la edición.\n\nContenido de demostración: las imágenes corresponden al archivo institucional de la AJB de 2025.",
    imagen_archivo: FOTOS[2].archivo },
  { titulo: "[Ejemplo] La agenda de las cuatro jornadas", fijada: 0, fecha_publicacion: "2026-09-23 08:00:00",
    cuerpo: "Del 23 al 26 de septiembre, este cronograma de demostración muestra cómo consultar la acreditación, las actividades deportivas y el cierre en un mismo lugar.\n\nLos horarios y lugares son datos de ejemplo para probar la navegación.",
    imagen_archivo: null },
  { titulo: "[Ejemplo] Deporte y compañerismo", fijada: 0, fecha_publicacion: "2026-09-24 19:00:00",
    cuerpo: "Cancha, pileta y espacios de encuentro: distintas disciplinas conviven en esta muestra de las Olimpiadas. El fixture permite recorrer los partidos y sus resultados.\n\nNovedad de ejemplo. Imagen de archivo AJB 2025, utilizada para ilustrar esta edición de prueba.",
    imagen_archivo: FOTOS[4].archivo },
  { titulo: "[Ejemplo] Galería: recuerdos de las Olimpiadas", fijada: 0, fecha_publicacion: "2026-09-26 18:00:00",
    cuerpo: "La galería de demostración ya tiene seis imágenes. Podés ampliarlas y probar los filtros por fecha o etiqueta.\n\nSon fotografías del archivo público de las XXVI Olimpiadas Judiciales de la AJB, realizadas en 2025; no documentan la edición de prueba 2026.",
    imagen_archivo: FOTOS[5].archivo },
];
const EVENTOS = [
  ["GENERAL", "2026-09-23", "09:00:00", "11:00:00", "Acreditación y recepción", "Punto de recepción de demostración"],
  ["ACTIVIDAD", "2026-09-23", "12:00:00", "12:30:00", "Bienvenida a las delegaciones", "Espacio de encuentro de demostración"],
  ["GENERAL", "2026-09-24", "09:00:00", "12:30:00", "Primera jornada deportiva", "Predio deportivo de demostración"],
  ["GENERAL", "2026-09-24", "13:00:00", "14:00:00", "Almuerzo compartido", "Comedor de demostración"],
  ["GENERAL", "2026-09-25", "09:00:00", "12:00:00", "Continuación de los torneos", "Predio deportivo de demostración"],
  ["ACTIVIDAD", "2026-09-25", "17:00:00", "18:00:00", "Encuentro recreativo", "Espacio de encuentro de demostración"],
  ["GENERAL", "2026-09-26", "09:00:00", "12:00:00", "Finales y últimos encuentros", "Predio deportivo de demostración"],
  ["GENERAL", "2026-09-26", "16:00:00", "17:00:00", "Premiación y cierre", "Escenario de demostración"],
].map(([tipo, fecha, hora_inicio, hora_fin, titulo, lugar], orden) => ({
  tipo, fecha, hora_inicio, hora_fin, titulo: `[Ejemplo] ${titulo}`, lugar, orden: orden + 1,
  descripcion: "Actividad de ejemplo de la edición de prueba. El horario y el lugar son ilustrativos y no corresponden a una convocatoria vigente.",
  imagen_archivo: tipo === "ACTIVIDAD" ? FOTOS[orden === 1 ? 2 : 3].archivo : null,
}));
const CHECKSUM = crypto.createHash("sha256").update(JSON.stringify({ SEED_ID, FOTOS, NOVEDADES, EVENTOS })).digest("hex");
const TABLAS = ["olimpiada_novedad", "olimpiada_evento", "olimpiada_foto"];

function validarEdicion(edicion, hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date())) {
  if (!edicion || Number(edicion.id) !== 1 || edicion.nombre !== "Olimpiadas 2026" || edicion.edicion !== "Demo"
      || edicion.fecha_inicio !== "2026-09-23" || edicion.fecha_fin !== "2026-09-26"
      || edicion.fecha_fin >= hoy || edicion.habilitado !== "Y" || Number(edicion.eliminado) !== 0
      || Number(edicion.publicada_publico) !== 1) {
    throw new Error("El seed sólo admite la edición de prueba id 1, Olimpiadas 2026 / Demo, finalizada y pública");
  }
}

async function leerEstado(db, bloquear = false) {
  const [[edicion]] = await db.query(`SELECT id, nombre, edicion, fecha_inicio, fecha_fin, habilitado, eliminado, publicada_publico
    FROM olimpiada WHERE id = 1${bloquear ? " FOR UPDATE" : ""}`);
  validarEdicion(edicion);
  const [[registro]] = await db.query("SELECT estado, checksum, detalle FROM ajb_schema_migration WHERE migration_id = ?", [SEED_ID]);
  if (registro && registro.checksum !== CHECKSUM) throw new Error("El seed registrado tiene un checksum diferente");
  const existentes = {};
  for (const tabla of TABLAS) {
    const [rows] = await db.query(`SELECT * FROM ${tabla} WHERE olimpiada_id = 1`);
    existentes[tabla] = rows;
  }
  return { edicion, aplicado: registro?.estado === "APLICADA", existentes };
}

function resumir(estado) {
  const pendientes = (tabla, datos, campo) => estado.aplicado ? [] : datos.filter(d => !estado.existentes[tabla].some(e => e[campo] === d[campo]));
  return { edicion: estado.edicion, aplicado: estado.aplicado,
    existentes: Object.fromEntries(TABLAS.map(t => [t, estado.existentes[t].length])),
    novedades: pendientes("olimpiada_novedad", NOVEDADES, "titulo"),
    eventos: pendientes("olimpiada_evento", EVENTOS, "titulo"),
    fotos: pendientes("olimpiada_foto", FOTOS, "archivo") };
}

async function prepararFotos(s3, bucket) {
  const fotos = [];
  for (const foto of FOTOS) {
    const response = await fetch(foto.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`No se pudo descargar ${foto.clave}: HTTP ${response.status}`);
    const original = Buffer.from(await response.arrayBuffer());
    if (original.length > 10 * 1024 * 1024) throw new Error("La imagen supera el límite de tamaño");
    const sourceHash = crypto.createHash("sha256").update(original).digest("hex");
    const web = await sharp(original).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 86 }).toBuffer({ resolveWithObject: true });
    const miniatura = await sharp(original).rotate().resize({ width: 420, height: 420, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    for (const [key, buffer] of [[foto.archivo, web.data], [foto.miniatura_archivo, miniatura]]) {
      // PUT condicional funciona sin ListBucket y nunca reemplaza un objeto.
      // HEAD sobre una key inexistente puede devolver 403 si no hay ListBucket.
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: "image/webp",
          IfNoneMatch: "*", Metadata: { "source-sha256": sourceHash, seed: SEED_ID } }));
      } catch (error) { if (error.$metadata?.httpStatusCode !== 412) throw error; }
      const verificado = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (verificado.Metadata?.["source-sha256"] !== sourceHash) throw new Error(`El objeto ${key} existe con otro origen; no se reemplaza`);
      if (!verificado.ContentLength || verificado.ContentType !== "image/webp") throw new Error(`No se pudo verificar ${key}`);
    }
    fotos.push({ ...foto, ancho: web.info.width, alto: web.info.height, mime: "image/webp", sourceHash });
  }
  return fotos;
}

async function aplicar(db, { respaldar, preparar } = {}) {
  const [[lock]] = await db.query("SELECT GET_LOCK(?, 15) AS tomado", [SEED_ID]);
  if (Number(lock.tomado) !== 1) throw new Error("Otro seed está en curso");
  let transaccion = false;
  try {
    const inicial = await leerEstado(db);
    if (inicial.aplicado) return { ...resumir(inicial), agregados: { novedades: 0, eventos: 0, fotos: 0 } };
    if (typeof respaldar !== "function" || typeof preparar !== "function") throw new Error("Se requiere respaldo y preparación de imágenes");
    const fotos = await preparar();
    if (fotos.length !== FOTOS.length || fotos.some((f, i) => f.archivo !== FOTOS[i].archivo || !f.ancho || !f.alto)) throw new Error("Las imágenes no están completas");
    await db.beginTransaction(); transaccion = true;
    const actual = await leerEstado(db, true);
    const respaldo = await respaldar({ seed: SEED_ID, fuente: FUENTE, ...actual, fotos_preparadas: fotos });
    const plan = resumir(actual);
    const agregados = { novedades: 0, eventos: 0, fotos: 0 };
    for (const [grupo, tabla, datos] of [
      ["novedades", "olimpiada_novedad", plan.novedades.map(n => ({ ...n, publicada: 1, notificada: 0 }))],
      ["eventos", "olimpiada_evento", plan.eventos],
      ["fotos", "olimpiada_foto", fotos.filter(f => plan.fotos.some(p => p.archivo === f.archivo)).map(({ clave, url, sourceHash, ...f }) => f)],
    ]) {
      for (const dato of datos) {
        const columnas = ["olimpiada_id", ...Object.keys(dato)];
        const [result] = await db.query(`INSERT INTO ${tabla} (${columnas.join(", ")}) VALUES (${columnas.map(() => "?").join(", ")})`, [1, ...Object.values(dato)]);
        await db.query(`INSERT INTO olimpiada_historial (entidad, entidad_id, olimpiada_id, tipo_operacion, valor_nuevo, observacion)
          VALUES (?, ?, 1, 'CREATE', ?, ?)`, [grupo.toUpperCase(), result.insertId, dato.titulo || dato.epigrafe, `Contenido de ejemplo sin notificaciones (${SEED_ID})`]);
        agregados[grupo]++;
      }
    }
    await db.query(`INSERT INTO ajb_schema_migration
      (migration_id, checksum, revision, estado, etapa, detalle, trigger_sql_mode, finalizada_en)
      VALUES (?, ?, 1, 'APLICADA', 'completa', ?, '', NOW())`,
    [SEED_ID, CHECKSUM, JSON.stringify({ agregados, respaldo, fuente: FUENTE })]);
    await db.commit(); transaccion = false;
    return { aplicado: true, edicion: actual.edicion, agregados, respaldo, fuente: FUENTE };
  } catch (error) {
    if (transaccion) await db.rollback();
    throw error;
  } finally { await db.query("SELECT RELEASE_LOCK(?)", [SEED_ID]); }
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  if (opciones.target === "all") throw new Error("Elegí un único entorno para el seed");
  if (opciones.target === "production" && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "CARGAR_DEMO_OLIMPIADAS_2026") throw new Error("Aplicar requiere --confirm=CARGAR_DEMO_OLIMPIADAS_2026");
  require("dotenv").config({ path: opciones.envFile });
  const contenido = fs.readFileSync(opciones.envFile, "utf8");
  const [entorno] = obtenerEntornos(opciones, contenido, opciones.target === "production" ? process.env : { DB_SSL_MODE: "disabled" });
  const db = await mysql.createConnection(crearOpcionesConexion(entorno.config));
  try {
    if (!opciones.apply) return console.log(JSON.stringify({ entorno: entorno.nombre, modo: "check", ...resumir(await leerEstado(db)) }, null, 2));
    for (const key of ["BUCKET_REGION", "BUCKET_NAME", "ACCESS_KEY", "SECRET_ACCESS_KEY"]) if (!process.env[key]) throw new Error(`Falta ${key}`);
    const s3 = new S3Client({ region: process.env.BUCKET_REGION, credentials: { accessKeyId: process.env.ACCESS_KEY, secretAccessKey: process.env.SECRET_ACCESS_KEY } });
    const resultado = await aplicar(db, {
      preparar: () => prepararFotos(s3, process.env.BUCKET_NAME),
      respaldar: async datos => {
        const directorio = path.resolve(__dirname, "../../output/olimpiadas-demo-contenido");
        fs.mkdirSync(directorio, { recursive: true });
        const archivo = path.join(directorio, `respaldo-${entorno.nombre}-${Date.now()}.json`);
        fs.writeFileSync(archivo, JSON.stringify(datos, null, 2), { flag: "wx" });
        return archivo;
      },
    });
    console.log(JSON.stringify({ entorno: entorno.nombre, modo: "apply", ...resultado }, null, 2));
  } finally { await db.end(); }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { SEED_ID, CHECKSUM, FOTOS, NOVEDADES, EVENTOS, validarEdicion, resumir, aplicar };
