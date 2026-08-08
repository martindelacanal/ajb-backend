/**
 * MÓDULO OLIMPIADAS (encuentro recreativo para afiliados)
 *
 * Entidades:
 *  - olimpiada: edición del evento con ventana de inscripción propia
 *  - olimpiada_disciplina / olimpiada_disciplina_tipo: catálogo administrable
 *  - olimpiada_disciplina_config: disciplinas habilitadas por olimpiada + cupo por departamental
 *  - olimpiada_inscripcion: formulario del afiliado (sanitario + firma + certificado + foto)
 *  - olimpiada_inscripcion_observacion: chat afiliado <-> revisor (mismo patrón que coseguro)
 *  - olimpiada_historial: auditoría de todas las acciones del módulo
 *  - olimpiada_mensaje_general: comunicados a todos los inscriptos (via tabla notificacion)
 *  - olimpiada_config: firma del Secretario de Acción Social para la constancia (solo admin)
 */
const express = require("express");
const router = express.Router();
const mysqlConnection = require("../connection/connection");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { normalizarFechaCivil } = require("../services/valores-dominio");

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------
const bucketName = process.env.BUCKET_NAME;
const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  region: process.env.BUCKET_REGION,
});
const S3_SIGNED_URL_EXPIRES_SECONDS = Number.parseInt(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || "3600", 10);
const MAX_ARCHIVO_OLIMPIADAS_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_OLIMPIADAS_BYTES = 30 * 1024 * 1024;
const MAX_FIRMA_BYTES = 2 * 1024 * 1024;
const MIME_IMAGEN_PERMITIDO = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

function detectarMimeArchivo(buffer, { permitePdf = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const marcas = buffer.toString("ascii", 8, Math.min(buffer.length, 40));
    if (/(heic|heix|hevc|hevx|mif1|msf1)/.test(marcas)) return "image/heic";
  }
  if (permitePdf && buffer.length >= 5 && buffer.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

function permitePdfEnSlot(fieldname) {
  return String(fieldname || "").toUpperCase() === "CERTIFICADO";
}

function validarContenidoArchivo(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0 || file.buffer.length > MAX_ARCHIVO_OLIMPIADAS_BYTES) {
    return { error: "El archivo está vacío o supera el máximo de 10 MB" };
  }
  const permitePdf = permitePdfEnSlot(file.fieldname);
  const mimeDetectado = detectarMimeArchivo(file.buffer, { permitePdf });
  const mimeDeclarado = file.mimetype === "image/jpg" ? "image/jpeg" : file.mimetype;
  if (!mimeDetectado || (!MIME_IMAGEN_PERMITIDO.has(mimeDetectado) && !(permitePdf && mimeDetectado === "application/pdf"))) {
    return { error: permitePdf ? "El certificado debe ser JPEG, PNG, WebP, HEIC o PDF" : "El archivo debe ser JPEG, PNG, WebP o HEIC" };
  }
  if (mimeDetectado !== mimeDeclarado) return { error: "El contenido del archivo no coincide con el tipo declarado" };
  file.mimetype = mimeDetectado;
  return { mime: mimeDetectado };
}

function decodificarFirmaBase64(firmaBase64) {
  const match = /^data:(image\/(?:jpeg|jpg|png|webp|heic));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(firmaBase64 || ""));
  if (!match || match[2].length % 4 !== 0 || match[2].length > Math.ceil(MAX_FIRMA_BYTES / 3) * 4) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > MAX_FIRMA_BYTES || buffer.toString("base64") !== match[2]) return null;
  const mimeDeclarado = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  const mimeDetectado = detectarMimeArchivo(buffer);
  if (!mimeDetectado || mimeDetectado !== mimeDeclarado || !MIME_IMAGEN_PERMITIDO.has(mimeDetectado)) return null;
  return { buffer, mime: mimeDetectado };
}

async function uploadBufferToS3({ key, buffer, contentType }) {
  await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: buffer, ContentType: contentType }));
}

async function getObjectBufferFromS3(key) {
  try {
    const respuesta = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    const chunks = [];
    for await (const chunk of respuesta.Body) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), contentType: respuesta.ContentType || "application/octet-stream" };
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") return null;
    throw error;
  }
}

async function getSignedFileUrlFromS3(key) {
  if (!key) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: key }), {
    expiresIn: Number.isFinite(S3_SIGNED_URL_EXPIRES_SECONDS) ? S3_SIGNED_URL_EXPIRES_SECONDS : 3600,
  });
}

const EXTENSION_POR_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

function extensionSegura(nombre, mime) {
  const extension = EXTENSION_POR_MIME[mime === "image/jpg" ? "image/jpeg" : mime];
  if (!extension) throw crearErrorHttp("Formato de archivo no permitido", 400);
  return extension;
}

async function subirArchivoOlimpiadas(file, prefijo) {
  const validacion = validarContenidoArchivo(file);
  if (validacion.error) throw crearErrorHttp(validacion.error, 400);
  const extension = extensionSegura(file.originalname, file.mimetype);
  const key = `olimpiadas/${prefijo}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${extension}`;
  await uploadBufferToS3({ key, buffer: file.buffer, contentType: file.mimetype });
  return key;
}

async function subirFirmaBase64(firmaBase64, prefijo) {
  const firma = decodificarFirmaBase64(firmaBase64);
  if (!firma) throw crearErrorHttp("La firma debe ser una imagen JPEG, PNG, WebP o HEIC válida de hasta 2 MB", 400);
  const extension = extensionSegura(null, firma.mime);
  const key = `olimpiadas/${prefijo}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${extension}`;
  await uploadBufferToS3({ key, buffer: firma.buffer, contentType: firma.mime });
  return key;
}

// ---------------------------------------------------------------------------
// Multer (memoria). Slots: CERTIFICADO (imagen o pdf), FOTO (imagen), FIRMA_SECRETARIO (imagen)
// ---------------------------------------------------------------------------
const uploadOlimpiadas = multer({
  storage: multer.memoryStorage(),
  limits: { files: 4, fileSize: MAX_ARCHIVO_OLIMPIADAS_BYTES, fieldSize: Math.ceil(MAX_FIRMA_BYTES / 3) * 4 + 256 },
  fileFilter: (req, file, cb) => {
    const mime = file.mimetype === "image/jpg" ? "image/jpeg" : file.mimetype;
    const esImagen = MIME_IMAGEN_PERMITIDO.has(mime);
    const esPdf = permitePdfEnSlot(file.fieldname) && file.mimetype === "application/pdf";
    if (!esImagen && !esPdf) return cb(new Error("Solo se permiten JPEG, PNG, WebP, HEIC y PDF únicamente para certificados"));
    return cb(null, true);
  },
});

function manejarUploadOlimpiadas(req, res, next) {
  uploadOlimpiadas.any()(req, res, (error) => {
    if (error) return res.status(400).json(error.message || "No se pudieron procesar los archivos");
    const totalBytes = (req.files || []).reduce((total, file) => total + (file.buffer?.length || 0), 0);
    if (totalBytes > MAX_TOTAL_OLIMPIADAS_BYTES) return res.status(400).json("Los archivos superan el máximo total de 30 MB");
    for (const file of req.files || []) {
      const validacion = validarContenidoArchivo(file);
      if (validacion.error) return res.status(400).json(validacion.error);
    }
    return next();
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function verifyToken(req, res, next) {
  const coincidencia = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ""));
  if (!coincidencia) return res.status(401).json("Se requiere Authorization: Bearer <token>");
  jwt.verify(coincidencia[1], process.env.JWT_SECRET, (error, authData) => {
    if (error) return res.status(403).json("Error en el token");
    req.data = authData;
    return next();
  });
}

function getCabecera(req) {
  return JSON.parse(req.data.data);
}

// Gestión del módulo: admin (total) y departamental (limitado a su departamental)
const ROLES_GESTION = ["admin", "departamental"];

function esStaff(cabecera) {
  return ROLES_GESTION.includes(cabecera.rol);
}

function esAdmin(cabecera) {
  return cabecera.rol === "admin";
}

// El staff departamental solo ve inscripciones de su departamental
function puedeVerInscripcion(cabecera, inscripcion) {
  if (cabecera.rol === "admin") return true;
  if (cabecera.rol === "departamental") return idsPositivosIguales(inscripcion.departamental_id, cabecera.departamental_id);
  if (cabecera.rol === "afiliado") return idsPositivosIguales(inscripcion.usuario_id, cabecera.id);
  return false;
}

// ---------------------------------------------------------------------------
// Helpers de negocio
// ---------------------------------------------------------------------------
function normalizarTexto(valor) {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  return texto.length > 0 ? texto : null;
}

function normalizarIdPositivo(valor) {
  if (typeof valor === "number") {
    return Number.isSafeInteger(valor) && valor > 0 ? valor : null;
  }
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (!/^\d+$/.test(texto)) return null;
  const numero = Number(texto);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

function idsPositivosIguales(a, b) {
  const idA = normalizarIdPositivo(a);
  const idB = normalizarIdPositivo(b);
  return idA !== null && idB !== null && idA === idB;
}

function normalizarCupo(valor) {
  if (valor === undefined || valor === null || valor === "") return { value: null };
  if (typeof valor !== "string" && typeof valor !== "number") {
    return { error: "El cupo debe ser un entero mayor a 0" };
  }
  const texto = String(valor).trim();
  if (!/^\d+$/.test(texto)) return { error: "El cupo debe ser un entero mayor a 0" };
  const numero = Number(texto);
  if (!Number.isSafeInteger(numero) || numero <= 0) return { error: "El cupo debe ser un entero mayor a 0" };
  return { value: numero };
}

function crearErrorHttp(mensaje, statusCode = 400) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  return error;
}

function fechaHoyBuenosAires(fecha = new Date()) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(fecha);
  const porTipo = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return `${porTipo.year}-${porTipo.month}-${porTipo.day}`;
}

function estaVentanaInscripcionAbierta(olimpiada, hoy = fechaHoyBuenosAires()) {
  const inicio = normalizarFechaCivil(olimpiada?.fecha_inicio_inscripcion);
  const fin = normalizarFechaCivil(olimpiada?.fecha_fin_inscripcion);
  const fechaActual = normalizarFechaCivil(hoy);
  return Boolean(inicio && fin && fechaActual && inicio <= fechaActual && fechaActual <= fin);
}

function parseJsonSeguro(valor, porDefecto) {
  if (valor === undefined || valor === null || valor === "") return porDefecto;
  if (typeof valor !== "string") return valor;
  try {
    return JSON.parse(valor);
  } catch (error) {
    return porDefecto;
  }
}

async function registrarHistorial(connection, datos) {
  await connection.query(
    `INSERT INTO olimpiada_historial
       (entidad, entidad_id, olimpiada_id, inscripcion_id, usuario_id, usuario_rol,
        tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, observacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      datos.entidad,
      datos.entidad_id || null,
      datos.olimpiada_id || null,
      datos.inscripcion_id || null,
      datos.usuario_id || null,
      datos.usuario_rol || null,
      datos.tipo_operacion,
      datos.campo_modificado || null,
      datos.valor_anterior !== undefined && datos.valor_anterior !== null ? String(datos.valor_anterior) : null,
      datos.valor_nuevo !== undefined && datos.valor_nuevo !== null ? String(datos.valor_nuevo) : null,
      datos.observacion || null,
    ]
  );
}

async function insertarNotificacion(connection, usuarioId, tipo, titulo, mensaje, payload) {
  await connection.query(
    `INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)`,
    [usuarioId, tipo, titulo, mensaje, JSON.stringify(payload || {})]
  );
}

// Staff que gestiona olimpiadas de una departamental (departamentales de esa sede + admins)
async function notificarStaffOlimpiadas(connection, departamentalId, tipo, titulo, mensaje, payload) {
  const [usuarios] = await connection.query(
    `SELECT u.id
     FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
     WHERE u.habilitado = 'Y'
       AND (r.nombre = 'admin' OR (r.nombre = 'departamental' AND u.departamental_id = ?))`,
    [departamentalId || 0]
  );
  for (const u of usuarios) {
    await insertarNotificacion(connection, u.id, tipo, titulo, mensaje, payload);
  }
}

// Olimpiada con inscripción abierta hoy (la más próxima a terminar)
const SQL_OLIMPIADA_VIGENTE = `
  SELECT o.*
  FROM olimpiada o
  WHERE o.eliminado = 0 AND o.habilitado = 'Y'
    AND CURDATE() BETWEEN o.fecha_inicio_inscripcion AND o.fecha_fin_inscripcion
  ORDER BY o.fecha_fin_inscripcion ASC, o.id DESC
  LIMIT 1`;

// Agrega la URL firmada del ícono a una lista de disciplinas
async function firmarIconosDisciplinas(disciplinas) {
  return Promise.all(
    disciplinas.map(async (d) => ({
      ...d,
      icono_url: await getSignedFileUrlFromS3(d.icono_archivo).catch(() => null),
    }))
  );
}

// Disciplinas de una olimpiada con cupo y ocupación por departamental
async function obtenerDisciplinasOlimpiada(db, olimpiadaId, departamentalId) {
  const [disciplinas] = await db.query(
    `SELECT c.disciplina_id AS id, d.nombre, d.tipo_id, t.nombre AS tipo_nombre, d.icono_archivo,
            c.max_por_departamental,
            (SELECT COUNT(*)
             FROM olimpiada_inscripcion_disciplina idp
             INNER JOIN olimpiada_inscripcion i ON i.id = idp.inscripcion_id
             WHERE idp.disciplina_id = c.disciplina_id AND i.olimpiada_id = c.olimpiada_id
               AND i.eliminado = 0 AND i.estado = 'VALIDADO'
               AND (? IS NULL OR i.departamental_id = ?)) AS inscriptos_departamental
     FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     INNER JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
     WHERE c.olimpiada_id = ? AND d.habilitado = 'Y'
     ORDER BY t.nombre ASC, d.nombre ASC`,
    [departamentalId ?? null, departamentalId ?? null, olimpiadaId]
  );
  return firmarIconosDisciplinas(disciplinas.map((d) => ({
    ...d,
    cupo_disponible: d.max_por_departamental === null ? null : Math.max(0, d.max_por_departamental - d.inscriptos_departamental),
  })));
}

// ===========================================================================
// CATÁLOGOS (grupos sanguíneos, datos sanitarios, tipos, disciplinas)
// ===========================================================================
router.get("/olimpiadas/catalogos", verifyToken, async (req, res) => {
  try {
    const db = mysqlConnection.promise();
    const [gruposSanguineos] = await db.query("SELECT id, nombre FROM olimpiada_grupo_sanguineo ORDER BY orden, id");
    const [datosSanitarios] = await db.query("SELECT id, nombre FROM olimpiada_dato_sanitario ORDER BY orden, id");
    const [tipos] = await db.query("SELECT id, nombre FROM olimpiada_disciplina_tipo WHERE habilitado = 'Y' ORDER BY nombre");
    const [disciplinas] = await db.query(
      `SELECT d.id, d.nombre, d.tipo_id, t.nombre AS tipo_nombre, d.max_por_departamental, d.icono_archivo
       FROM olimpiada_disciplina d INNER JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
       WHERE d.habilitado = 'Y' ORDER BY t.nombre, d.nombre`
    );
    res.status(200).json({
      grupos_sanguineos: gruposSanguineos,
      datos_sanitarios: datosSanitarios,
      tipos,
      disciplinas: await firmarIconosDisciplinas(disciplinas),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los catálogos de olimpiadas");
  }
});

// ===========================================================================
// TIPOS DE DISCIPLINA (ABM admin)
// ===========================================================================
router.get("/olimpiadas/tipos-disciplina", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const [tipos] = await db.query(
      `SELECT t.id, t.nombre, t.fecha_creacion,
              (SELECT COUNT(*) FROM olimpiada_disciplina d WHERE d.tipo_id = t.id AND d.habilitado = 'Y') AS disciplinas
       FROM olimpiada_disciplina_tipo t
       WHERE t.habilitado = 'Y'
       ORDER BY t.nombre`
    );
    res.status(200).json(tipos);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los tipos de disciplina");
  }
});

router.post("/olimpiadas/tipos-disciplina", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const nombre = normalizarTexto(req.body.nombre);
    if (!nombre) return res.status(400).json("El nombre es obligatorio");
    const db = mysqlConnection.promise();
    const [resultado] = await db.query("INSERT INTO olimpiada_disciplina_tipo (nombre) VALUES (?)", [nombre]);
    await registrarHistorial(db, {
      entidad: "TIPO_DISCIPLINA", entidad_id: resultado.insertId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE", valor_nuevo: nombre,
    });
    res.status(201).json({ success: true, id: resultado.insertId, message: "Tipo de disciplina creado" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al crear el tipo de disciplina");
  }
});

router.put("/olimpiadas/tipos-disciplina/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const tipoId = normalizarIdPositivo(req.params.id);
    const nombre = normalizarTexto(req.body.nombre);
    if (!tipoId || !nombre) return res.status(400).json("El nombre es obligatorio");
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_disciplina_tipo WHERE id = ? AND habilitado = 'Y'", [tipoId]);
    if (rows.length === 0) return res.status(404).json("Tipo de disciplina no encontrado");
    await db.query("UPDATE olimpiada_disciplina_tipo SET nombre = ? WHERE id = ?", [nombre, tipoId]);
    await registrarHistorial(db, {
      entidad: "TIPO_DISCIPLINA", entidad_id: tipoId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "UPDATE", campo_modificado: "nombre",
      valor_anterior: rows[0].nombre, valor_nuevo: nombre,
    });
    res.status(200).json({ success: true, message: "Tipo de disciplina actualizado" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al actualizar el tipo de disciplina");
  }
});

router.delete("/olimpiadas/tipos-disciplina/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const tipoId = normalizarIdPositivo(req.params.id);
    if (!tipoId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_disciplina_tipo WHERE id = ? AND habilitado = 'Y'", [tipoId]);
    if (rows.length === 0) return res.status(404).json("Tipo de disciplina no encontrado");
    const [[uso]] = await db.query(
      "SELECT COUNT(*) AS total FROM olimpiada_disciplina WHERE tipo_id = ? AND habilitado = 'Y'", [tipoId]
    );
    if (uso.total > 0) return res.status(409).json("No se puede eliminar: hay disciplinas que usan este tipo");
    await db.query("UPDATE olimpiada_disciplina_tipo SET habilitado = 'N' WHERE id = ?", [tipoId]);
    await registrarHistorial(db, {
      entidad: "TIPO_DISCIPLINA", entidad_id: tipoId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE", valor_anterior: rows[0].nombre,
    });
    res.status(200).json({ success: true, message: "Tipo de disciplina eliminado" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al eliminar el tipo de disciplina");
  }
});

// ===========================================================================
// DISCIPLINAS (ABM admin)
// ===========================================================================
router.get("/olimpiadas/disciplinas", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const [disciplinas] = await db.query(
      `SELECT d.id, d.nombre, d.tipo_id, t.nombre AS tipo_nombre, d.max_por_departamental, d.icono_archivo, d.fecha_creacion
       FROM olimpiada_disciplina d INNER JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
       WHERE d.habilitado = 'Y'
       ORDER BY d.nombre, d.id`
    );
    res.status(200).json(await firmarIconosDisciplinas(disciplinas));
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las disciplinas");
  }
});

// Ícono de disciplina: JPEG/PNG/WebP/HEIC adjunto en el slot ICONO (opcional)
function obtenerArchivoIcono(req, res) {
  const archivo = (req.files || []).find((f) => f.fieldname === "ICONO");
  if (!archivo) return { archivo: null };
  if (!archivo.mimetype?.startsWith("image/")) {
    res.status(400).json("El ícono debe ser una imagen JPEG, PNG, WebP o HEIC");
    return { error: true };
  }
  return { archivo };
}

router.post("/olimpiadas/disciplinas", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const nombre = normalizarTexto(req.body.nombre);
    const tipoId = normalizarIdPositivo(req.body.tipo_id);
    const cupo = normalizarCupo(req.body.max_por_departamental);
    if (!nombre || !tipoId) return res.status(400).json("Nombre y tipo son obligatorios");
    if (cupo.error) return res.status(400).json(cupo.error);
    const max = cupo.value;

    const icono = obtenerArchivoIcono(req, res);
    if (icono.error) return;
    let iconoArchivo = null;
    if (icono.archivo) iconoArchivo = await subirArchivoOlimpiadas(icono.archivo, "disciplinas/icono");

    const db = mysqlConnection.promise();
    const [resultado] = await db.query(
      "INSERT INTO olimpiada_disciplina (nombre, tipo_id, max_por_departamental, icono_archivo) VALUES (?, ?, ?, ?)",
      [nombre, tipoId, max, iconoArchivo]
    );
    await registrarHistorial(db, {
      entidad: "DISCIPLINA", entidad_id: resultado.insertId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE",
      valor_nuevo: `${nombre} (tipo ${tipoId}, máx ${max === null ? "ilimitado" : max}${iconoArchivo ? ", con ícono" : ""})`,
    });
    res.status(201).json({ success: true, id: resultado.insertId, message: "Disciplina creada" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al crear la disciplina");
  }
});

router.put("/olimpiadas/disciplinas/:id", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const disciplinaId = normalizarIdPositivo(req.params.id);
    const nombre = normalizarTexto(req.body.nombre);
    const tipoId = normalizarIdPositivo(req.body.tipo_id);
    const cupo = normalizarCupo(req.body.max_por_departamental);
    if (!disciplinaId || !nombre || !tipoId) return res.status(400).json("Nombre y tipo son obligatorios");
    if (cupo.error) return res.status(400).json(cupo.error);
    const max = cupo.value;
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_disciplina WHERE id = ? AND habilitado = 'Y'", [disciplinaId]);
    if (rows.length === 0) return res.status(404).json("Disciplina no encontrada");
    const anterior = rows[0];

    const icono = obtenerArchivoIcono(req, res);
    if (icono.error) return;
    let iconoArchivo = anterior.icono_archivo;
    if (icono.archivo) {
      iconoArchivo = await subirArchivoOlimpiadas(icono.archivo, "disciplinas/icono");
    } else if (String(req.body.quitar_icono) === "1") {
      iconoArchivo = null;
    }

    await db.query(
      "UPDATE olimpiada_disciplina SET nombre = ?, tipo_id = ?, max_por_departamental = ?, icono_archivo = ? WHERE id = ?",
      [nombre, tipoId, max, iconoArchivo, disciplinaId]
    );
    const cambios = [];
    if (anterior.nombre !== nombre) cambios.push({ campo: "nombre", anterior: anterior.nombre, nuevo: nombre });
    if (Number(anterior.tipo_id) !== tipoId) cambios.push({ campo: "tipo_id", anterior: anterior.tipo_id, nuevo: tipoId });
    if ((anterior.icono_archivo ?? null) !== (iconoArchivo ?? null)) {
      cambios.push({ campo: "icono_archivo", anterior: anterior.icono_archivo, nuevo: iconoArchivo });
    }
    if ((anterior.max_por_departamental ?? null) !== max) {
      cambios.push({
        campo: "max_por_departamental",
        anterior: anterior.max_por_departamental === null ? "ilimitado" : anterior.max_por_departamental,
        nuevo: max === null ? "ilimitado" : max,
      });
    }
    for (const cambio of cambios) {
      await registrarHistorial(db, {
        entidad: "DISCIPLINA", entidad_id: disciplinaId,
        usuario_id: cabecera.id, usuario_rol: cabecera.rol,
        tipo_operacion: "UPDATE", campo_modificado: cambio.campo,
        valor_anterior: cambio.anterior, valor_nuevo: cambio.nuevo,
      });
    }
    res.status(200).json({ success: true, message: "Disciplina actualizada" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al actualizar la disciplina");
  }
});

router.delete("/olimpiadas/disciplinas/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const disciplinaId = normalizarIdPositivo(req.params.id);
    if (!disciplinaId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_disciplina WHERE id = ? AND habilitado = 'Y'", [disciplinaId]);
    if (rows.length === 0) return res.status(404).json("Disciplina no encontrada");
    const [[uso]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM olimpiada_inscripcion_disciplina WHERE disciplina_id = ?) +
              (SELECT COUNT(*) FROM olimpiada_disciplina_config c
               INNER JOIN olimpiada o ON o.id = c.olimpiada_id
               WHERE c.disciplina_id = ? AND o.eliminado = 0) AS total`,
      [disciplinaId, disciplinaId]
    );
    if (uso.total > 0) return res.status(409).json("No se puede eliminar: la disciplina está usada en olimpiadas o inscripciones");
    await db.query("UPDATE olimpiada_disciplina SET habilitado = 'N' WHERE id = ?", [disciplinaId]);
    await registrarHistorial(db, {
      entidad: "DISCIPLINA", entidad_id: disciplinaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE", valor_anterior: rows[0].nombre,
    });
    res.status(200).json({ success: true, message: "Disciplina eliminada" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al eliminar la disciplina");
  }
});

// ===========================================================================
// CONFIG (firma del Secretario para la constancia; sube solo admin)
// ===========================================================================
router.get("/olimpiadas/config", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_config WHERE id = 1");
    const config = rows[0] || {};
    res.status(200).json({
      firma_secretario_nombre: config.firma_secretario_nombre || null,
      firma_secretario_cargo: config.firma_secretario_cargo || null,
      firma_secretario_url: await getSignedFileUrlFromS3(config.firma_secretario_archivo).catch(() => null),
      tiene_firma: !!config.firma_secretario_archivo,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener la configuración de olimpiadas");
  }
});

router.put("/olimpiadas/config", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    // La migración crea esta fila única. El upsert defensivo también materializa
    // la clave antes del FOR UPDATE si una instalación antigua no ejecutó el seed.
    await connection.query(
      "INSERT INTO olimpiada_config (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id"
    );
    const [rows] = await connection.query("SELECT * FROM olimpiada_config WHERE id = 1 FOR UPDATE");
    const anterior = rows[0] || {};

    const nombre = normalizarTexto(req.body.firma_secretario_nombre) || anterior.firma_secretario_nombre;
    const cargo = normalizarTexto(req.body.firma_secretario_cargo) || anterior.firma_secretario_cargo;
    let firmaArchivo = anterior.firma_secretario_archivo || null;

    const archivoFirma = (req.files || []).find((f) => f.fieldname === "FIRMA_SECRETARIO");
    if (archivoFirma) {
      if (!archivoFirma.mimetype?.startsWith("image/")) return res.status(400).json("La firma debe ser una imagen");
      firmaArchivo = await subirArchivoOlimpiadas(archivoFirma, "config/firma_secretario");
    }

    await connection.query(
      `UPDATE olimpiada_config
       SET firma_secretario_archivo = ?, firma_secretario_nombre = ?, firma_secretario_cargo = ?
       WHERE id = 1`,
      [firmaArchivo, nombre, cargo]
    );
    await registrarHistorial(connection, {
      entidad: "CONFIG", entidad_id: 1,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "UPDATE",
      campo_modificado: archivoFirma ? "firma_secretario" : "datos_secretario",
      valor_nuevo: `${nombre} - ${cargo}${archivoFirma ? " (nueva imagen de firma)" : ""}`,
    });
    await connection.commit();
    res.status(200).json({ success: true, message: "Configuración guardada" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al guardar la configuración de olimpiadas");
  } finally {
    if (connection) connection.release();
  }
});

// ===========================================================================
// OLIMPIADAS (ABM admin + vista del afiliado)
// ===========================================================================

// Vista del afiliado: olimpiada con inscripción abierta (o la próxima) + su inscripción
router.get("/olimpiadas/actual", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const db = mysqlConnection.promise();

    const [vigentes] = await db.query(SQL_OLIMPIADA_VIGENTE);
    let olimpiada = vigentes[0] || null;
    let proxima = null;

    if (!olimpiada) {
      const [proximas] = await db.query(
        `SELECT * FROM olimpiada
         WHERE eliminado = 0 AND habilitado = 'Y' AND fecha_inicio_inscripcion > CURDATE()
         ORDER BY fecha_inicio_inscripcion ASC LIMIT 1`
      );
      proxima = proximas[0] || null;
    }

    let disciplinas = [];
    let inscripcion = null;
    const referencia = olimpiada || proxima;
    if (referencia) {
      disciplinas = await obtenerDisciplinasOlimpiada(db, referencia.id, cabecera.departamental_id ?? null);
      const [inscripciones] = await db.query(
        `SELECT i.id, i.estado, i.fecha_creacion,
                (SELECT COUNT(*) FROM olimpiada_inscripcion_observacion o WHERE o.inscripcion_id = i.id) AS mensajes
         FROM olimpiada_inscripcion i
         WHERE i.olimpiada_id = ? AND i.usuario_id = ? AND i.eliminado = 0
         ORDER BY i.id DESC LIMIT 1`,
        [referencia.id, cabecera.id]
      );
      inscripcion = inscripciones[0] || null;
    }

    res.status(200).json({
      olimpiada,
      proxima,
      disciplinas,
      inscripcion,
      inscripcion_abierta: !!olimpiada,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener la olimpiada vigente");
  }
});

// Listado staff con métricas
router.get("/olimpiadas", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const filtroDepartamental = cabecera.rol === "departamental" ? Number(cabecera.departamental_id) || 0 : null;
    const [olimpiadas] = await db.query(
      `SELECT o.id, o.nombre, o.edicion, o.localidad, o.descripcion,
              o.fecha_inicio, o.fecha_fin, o.fecha_inicio_inscripcion, o.fecha_fin_inscripcion,
              o.texto_licencia, o.habilitado, o.fecha_creacion,
              (SELECT COUNT(*) FROM olimpiada_inscripcion i
               WHERE i.olimpiada_id = o.id AND i.eliminado = 0
                 AND (? IS NULL OR i.departamental_id = ?)) AS inscriptos,
              (SELECT COUNT(*) FROM olimpiada_disciplina_config c WHERE c.olimpiada_id = o.id) AS disciplinas
       FROM olimpiada o
       WHERE o.eliminado = 0
       ORDER BY o.fecha_inicio DESC, o.id DESC`,
      [filtroDepartamental, filtroDepartamental]
    );
    res.status(200).json(olimpiadas);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las olimpiadas");
  }
});

router.get("/olimpiadas/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    if (!olimpiadaId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada WHERE id = ? AND eliminado = 0", [olimpiadaId]);
    if (rows.length === 0) return res.status(404).json("Olimpiada no encontrada");
    const disciplinas = await obtenerDisciplinasOlimpiada(
      db, olimpiadaId, cabecera.rol === "departamental" ? cabecera.departamental_id : null
    );
    res.status(200).json({ ...rows[0], disciplinas });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener la olimpiada");
  }
});

function validarDatosOlimpiada(body) {
  const nombre = normalizarTexto(body.nombre);
  const fechaInicio = normalizarFechaCivil(body.fecha_inicio);
  const fechaFin = normalizarFechaCivil(body.fecha_fin);
  const inscInicio = normalizarFechaCivil(body.fecha_inicio_inscripcion);
  const inscFin = normalizarFechaCivil(body.fecha_fin_inscripcion);
  if (!nombre || !fechaInicio || !fechaFin || !inscInicio || !inscFin) {
    return { error: "Nombre y las cuatro fechas civiles válidas (YYYY-MM-DD) son obligatorios" };
  }
  if (fechaFin < fechaInicio) return { error: "La fecha de fin no puede ser anterior a la de inicio" };
  if (inscFin < inscInicio) return { error: "El cierre de inscripción no puede ser anterior a su apertura" };
  if (inscFin > fechaInicio) return { error: "La inscripción debe cerrar antes o el mismo día de inicio de la olimpiada" };
  const disciplinas = Array.isArray(body.disciplinas) ? body.disciplinas : parseJsonSeguro(body.disciplinas, []);
  if (!Array.isArray(disciplinas) || disciplinas.length === 0) {
    return { error: "Elegí al menos una disciplina para la olimpiada" };
  }
  const disciplinasNormalizadas = [];
  const disciplinasVistas = new Set();
  for (const d of disciplinas) {
    const disciplinaId = normalizarIdPositivo(d.disciplina_id ?? d.id);
    if (!disciplinaId) return { error: "Hay una disciplina inválida en la lista" };
    if (disciplinasVistas.has(disciplinaId)) return { error: "No se puede repetir una disciplina" };
    disciplinasVistas.add(disciplinaId);
    const cupo = normalizarCupo(d.max_por_departamental);
    if (cupo.error) return { error: `Cupo inválido para la disciplina #${disciplinaId}: ${cupo.error}` };
    disciplinasNormalizadas.push({ disciplina_id: disciplinaId, max_por_departamental: cupo.value });
  }
  return {
    value: {
      nombre,
      edicion: normalizarTexto(body.edicion),
      localidad: normalizarTexto(body.localidad),
      descripcion: normalizarTexto(body.descripcion),
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      fecha_inicio_inscripcion: inscInicio,
      fecha_fin_inscripcion: inscFin,
      texto_licencia: normalizarTexto(body.texto_licencia),
      disciplinas: disciplinasNormalizadas,
    },
  };
}

async function bloquearOlimpiada(connection, olimpiadaId, { requiereHabilitada = false } = {}) {
  const [rows] = await connection.query(
    `SELECT * FROM olimpiada
     WHERE id = ? AND eliminado = 0${requiereHabilitada ? " AND habilitado = 'Y'" : ""}
     FOR UPDATE`,
    [olimpiadaId]
  );
  return rows[0] || null;
}

async function validarDisciplinasCatalogo(connection, disciplinas) {
  const ids = disciplinas.map((disciplina) => disciplina.disciplina_id);
  const [rows] = await connection.query(
    "SELECT id FROM olimpiada_disciplina WHERE id IN (?) AND habilitado = 'Y' FOR UPDATE",
    [ids]
  );
  const existentes = new Set(rows.map((row) => Number(row.id)));
  if (ids.some((id) => !existentes.has(id))) {
    throw crearErrorHttp("Una de las disciplinas no existe o está deshabilitada", 400);
  }
}

async function validarConfiguracionContraInscripciones(connection, olimpiadaId, disciplinas) {
  const configuracion = new Map(disciplinas.map((disciplina) => [disciplina.disciplina_id, disciplina]));
  const [usos] = await connection.query(
    `SELECT idp.disciplina_id, i.departamental_id,
            COUNT(*) AS inscripciones,
            SUM(CASE WHEN i.estado = 'VALIDADO' THEN 1 ELSE 0 END) AS validadas
     FROM olimpiada_inscripcion_disciplina idp
     INNER JOIN olimpiada_inscripcion i ON i.id = idp.inscripcion_id
     WHERE i.olimpiada_id = ? AND i.eliminado = 0
     GROUP BY idp.disciplina_id, i.departamental_id`,
    [olimpiadaId]
  );

  for (const uso of usos) {
    const disciplinaId = Number(uso.disciplina_id);
    const nuevaConfiguracion = configuracion.get(disciplinaId);
    if (!nuevaConfiguracion) {
      throw crearErrorHttp(`No se puede quitar la disciplina #${disciplinaId}: tiene inscripciones asociadas`, 409);
    }
    const cupo = nuevaConfiguracion.max_por_departamental;
    if (cupo !== null && Number(uso.validadas) > cupo) {
      const sede = uso.departamental_id === null ? "sin departamental" : `departamental #${uso.departamental_id}`;
      throw crearErrorHttp(
        `El cupo de la disciplina #${disciplinaId} no puede bajar de ${uso.validadas} para ${sede}`,
        409
      );
    }
  }
}

async function validarCapacidadDisciplinas(connection, {
  olimpiadaId,
  departamentalId,
  disciplinaIds,
  excluirInscripcionId = null,
  controlarCapacidad = true,
}) {
  const [configs] = await connection.query(
    `SELECT c.disciplina_id, c.max_por_departamental, d.nombre
     FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     WHERE c.olimpiada_id = ? AND d.habilitado = 'Y'
     FOR UPDATE`,
    [olimpiadaId]
  );
  const porDisciplina = new Map(configs.map((config) => [Number(config.disciplina_id), config]));

  for (const disciplinaId of disciplinaIds) {
    const config = porDisciplina.get(disciplinaId);
    if (!config) throw crearErrorHttp("Una de las disciplinas elegidas no pertenece a esta olimpiada", 400);
    if (!controlarCapacidad || config.max_por_departamental === null) continue;

    const params = [disciplinaId, olimpiadaId, departamentalId];
    const excluir = excluirInscripcionId ? " AND i.id <> ?" : "";
    if (excluirInscripcionId) params.push(excluirInscripcionId);
    const [[ocupacion]] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM olimpiada_inscripcion_disciplina idp
       INNER JOIN olimpiada_inscripcion i ON i.id = idp.inscripcion_id
       WHERE idp.disciplina_id = ? AND i.olimpiada_id = ? AND i.eliminado = 0
         AND i.estado = 'VALIDADO' AND i.departamental_id <=> ?${excluir}`,
      params
    );
    if (Number(ocupacion.total) >= Number(config.max_por_departamental)) {
      throw crearErrorHttp(`No quedan cupos de "${config.nombre}" para la departamental`, 409);
    }
  }
}

async function validarReferenciasSanitarias(connection, grupoSanguineoId, datosSanitarioIds) {
  const [grupos] = await connection.query(
    "SELECT id FROM olimpiada_grupo_sanguineo WHERE id = ? FOR UPDATE",
    [grupoSanguineoId]
  );
  if (grupos.length === 0) throw crearErrorHttp("El grupo sanguíneo seleccionado no existe", 400);
  if (datosSanitarioIds.length === 0) return;
  const [datos] = await connection.query(
    "SELECT id FROM olimpiada_dato_sanitario WHERE id IN (?) FOR UPDATE",
    [datosSanitarioIds]
  );
  const existentes = new Set(datos.map((dato) => Number(dato.id)));
  if (datosSanitarioIds.some((id) => !existentes.has(id))) {
    throw crearErrorHttp("Uno de los datos sanitarios seleccionados no existe", 400);
  }
}

router.post("/olimpiadas", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const parseo = validarDatosOlimpiada(req.body);
    if (parseo.error) return res.status(400).json(parseo.error);
    const datos = parseo.value;

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    await validarDisciplinasCatalogo(connection, datos.disciplinas);

    const [resultado] = await connection.query(
      `INSERT INTO olimpiada
         (nombre, edicion, localidad, descripcion, fecha_inicio, fecha_fin,
          fecha_inicio_inscripcion, fecha_fin_inscripcion, texto_licencia)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datos.nombre, datos.edicion, datos.localidad, datos.descripcion,
        datos.fecha_inicio, datos.fecha_fin,
        datos.fecha_inicio_inscripcion, datos.fecha_fin_inscripcion, datos.texto_licencia,
      ]
    );
    const olimpiadaId = resultado.insertId;

    for (const d of datos.disciplinas) {
      await connection.query(
        `INSERT INTO olimpiada_disciplina_config (olimpiada_id, disciplina_id, max_por_departamental) VALUES (?, ?, ?)`,
        [olimpiadaId, d.disciplina_id, d.max_por_departamental]
      );
    }

    await registrarHistorial(connection, {
      entidad: "OLIMPIADA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE",
      valor_nuevo: `${datos.nombre} (${datos.fecha_inicio} a ${datos.fecha_fin}, ${datos.disciplinas.length} disciplinas)`,
    });

    await connection.commit();
    res.status(201).json({ success: true, id: olimpiadaId, message: "Olimpiada creada" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al crear la olimpiada");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/olimpiadas/:id(\\d+)", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    if (!olimpiadaId) return res.status(400).json("ID inválido");
    const parseo = validarDatosOlimpiada(req.body);
    if (parseo.error) return res.status(400).json(parseo.error);
    const datos = parseo.value;

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    const anterior = await bloquearOlimpiada(connection, olimpiadaId);
    if (!anterior) throw crearErrorHttp("Olimpiada no encontrada", 404);
    await connection.query(
      "SELECT disciplina_id FROM olimpiada_disciplina_config WHERE olimpiada_id = ? FOR UPDATE",
      [olimpiadaId]
    );
    await validarDisciplinasCatalogo(connection, datos.disciplinas);
    await validarConfiguracionContraInscripciones(connection, olimpiadaId, datos.disciplinas);

    await connection.query(
      `UPDATE olimpiada
       SET nombre = ?, edicion = ?, localidad = ?, descripcion = ?, fecha_inicio = ?, fecha_fin = ?,
           fecha_inicio_inscripcion = ?, fecha_fin_inscripcion = ?, texto_licencia = ?
       WHERE id = ?`,
      [
        datos.nombre, datos.edicion, datos.localidad, datos.descripcion,
        datos.fecha_inicio, datos.fecha_fin,
        datos.fecha_inicio_inscripcion, datos.fecha_fin_inscripcion, datos.texto_licencia,
        olimpiadaId,
      ]
    );

    // Reemplazo de la configuración de disciplinas (mantiene inscripciones existentes)
    await connection.query("DELETE FROM olimpiada_disciplina_config WHERE olimpiada_id = ?", [olimpiadaId]);
    for (const d of datos.disciplinas) {
      await connection.query(
        `INSERT INTO olimpiada_disciplina_config (olimpiada_id, disciplina_id, max_por_departamental) VALUES (?, ?, ?)`,
        [olimpiadaId, d.disciplina_id, d.max_por_departamental]
      );
    }

    const formatearFecha = (fecha) => normalizarFechaCivil(fecha) || "";
    const camposComparables = [
      ["nombre", anterior.nombre, datos.nombre],
      ["edicion", anterior.edicion, datos.edicion],
      ["localidad", anterior.localidad, datos.localidad],
      ["descripcion", anterior.descripcion, datos.descripcion],
      ["fecha_inicio", formatearFecha(anterior.fecha_inicio), datos.fecha_inicio],
      ["fecha_fin", formatearFecha(anterior.fecha_fin), datos.fecha_fin],
      ["fecha_inicio_inscripcion", formatearFecha(anterior.fecha_inicio_inscripcion), datos.fecha_inicio_inscripcion],
      ["fecha_fin_inscripcion", formatearFecha(anterior.fecha_fin_inscripcion), datos.fecha_fin_inscripcion],
      ["texto_licencia", anterior.texto_licencia, datos.texto_licencia],
    ];
    for (const [campo, valorAnterior, valorNuevo] of camposComparables) {
      if ((valorAnterior ?? "") !== (valorNuevo ?? "")) {
        await registrarHistorial(connection, {
          entidad: "OLIMPIADA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId,
          usuario_id: cabecera.id, usuario_rol: cabecera.rol,
          tipo_operacion: "UPDATE", campo_modificado: campo,
          valor_anterior: valorAnterior, valor_nuevo: valorNuevo,
        });
      }
    }
    await registrarHistorial(connection, {
      entidad: "OLIMPIADA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "UPDATE", campo_modificado: "disciplinas",
      valor_nuevo: datos.disciplinas
        .map((d) => `#${d.disciplina_id}:${d.max_por_departamental === null ? "ilimitado" : d.max_por_departamental}`)
        .join(", "),
    });

    await connection.commit();
    res.status(200).json({ success: true, message: "Olimpiada actualizada" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al actualizar la olimpiada");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/olimpiadas/:id(\\d+)", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    if (!olimpiadaId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    const olimpiada = await bloquearOlimpiada(connection, olimpiadaId);
    if (!olimpiada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    await connection.query("UPDATE olimpiada SET eliminado = 1 WHERE id = ? AND eliminado = 0", [olimpiadaId]);
    await registrarHistorial(connection, {
      entidad: "OLIMPIADA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE", valor_anterior: olimpiada.nombre,
    });
    await connection.commit();
    res.status(200).json({ success: true, message: "Olimpiada eliminada" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al eliminar la olimpiada");
  } finally {
    if (connection) connection.release();
  }
});

// ===========================================================================
// MENSAJES GENERALES a los inscriptos
// ===========================================================================
router.get("/olimpiadas/:id(\\d+)/mensajes", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    const db = mysqlConnection.promise();
    const [mensajes] = await db.query(
      `SELECT m.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido
       FROM olimpiada_mensaje_general m
       LEFT JOIN usuario u ON u.id = m.usuario_id
       WHERE m.olimpiada_id = ?
       ORDER BY m.fecha_creacion DESC, m.id DESC`,
      [olimpiadaId]
    );
    res.status(200).json(mensajes);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los mensajes");
  }
});

router.post("/olimpiadas/:id(\\d+)/mensajes", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    const titulo = normalizarTexto(req.body.titulo);
    const mensaje = normalizarTexto(req.body.mensaje);
    if (!olimpiadaId || !titulo || !mensaje) return res.status(400).json("Título y mensaje son obligatorios");

    const db = mysqlConnection.promise();
    const [olimpiadas] = await db.query("SELECT * FROM olimpiada WHERE id = ? AND eliminado = 0", [olimpiadaId]);
    if (olimpiadas.length === 0) return res.status(404).json("Olimpiada no encontrada");

    // El admin escribe a todos los inscriptos; una departamental, solo a los suyos
    const filtroDepartamental = cabecera.rol === "departamental" ? Number(cabecera.departamental_id) || 0 : null;
    const [inscriptos] = await db.query(
      `SELECT DISTINCT i.usuario_id
       FROM olimpiada_inscripcion i
       WHERE i.olimpiada_id = ? AND i.eliminado = 0 AND i.estado = 'VALIDADO'
         AND (? IS NULL OR i.departamental_id = ?)`,
      [olimpiadaId, filtroDepartamental, filtroDepartamental]
    );
    if (inscriptos.length === 0) return res.status(400).json("La olimpiada todavía no tiene inscriptos para notificar");

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [resultado] = await connection.query(
      `INSERT INTO olimpiada_mensaje_general (olimpiada_id, usuario_id, usuario_rol, titulo, mensaje, destinatarios)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [olimpiadaId, cabecera.id, cabecera.rol, titulo, mensaje, inscriptos.length]
    );

    for (const inscripto of inscriptos) {
      await insertarNotificacion(connection, inscripto.usuario_id, "OLIMPIADA_MENSAJE", titulo, mensaje, {
        olimpiada_id: olimpiadaId,
        mensaje_id: resultado.insertId,
      });
    }

    await registrarHistorial(connection, {
      entidad: "MENSAJE_GENERAL", entidad_id: resultado.insertId, olimpiada_id: olimpiadaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "MENSAJE_GENERAL",
      valor_nuevo: `${titulo} (${inscriptos.length} destinatarios)`,
      observacion: mensaje,
    });

    await connection.commit();
    res.status(201).json({ success: true, message: `Mensaje enviado a ${inscriptos.length} inscriptos` });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al enviar el mensaje");
  } finally {
    if (connection) connection.release();
  }
});

// ===========================================================================
// INSCRIPCIONES
// ===========================================================================

function normalizarIds(valor) {
  if (valor === undefined || valor === null || valor === "") return [];
  let lista = valor;
  if (!Array.isArray(lista) && typeof valor === "string") {
    try {
      lista = JSON.parse(valor);
    } catch (error) {
      return null;
    }
  }
  if (!Array.isArray(lista)) return null;
  const normalizados = lista.map(normalizarIdPositivo);
  if (normalizados.some((id) => !id)) return null;
  return [...new Set(normalizados)];
}

// Alta (afiliado; el staff también puede cargar en nombre de un afiliado propio)
router.post("/olimpiadas/:id(\\d+)/inscripciones", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    if (!olimpiadaId) return res.status(400).json("ID de olimpiada inválido");
    if (!["afiliado", ...ROLES_GESTION].includes(cabecera.rol)) return res.status(401).json("No autorizado");

    const db = mysqlConnection.promise();
    const [olimpiadas] = await db.query("SELECT * FROM olimpiada WHERE id = ? AND eliminado = 0 AND habilitado = 'Y'", [olimpiadaId]);
    if (olimpiadas.length === 0) return res.status(404).json("Olimpiada no encontrada");
    let olimpiada = olimpiadas[0];

    // Afiliado destinatario de la inscripción
    let usuarioId = normalizarIdPositivo(cabecera.id);
    if (cabecera.rol !== "afiliado") usuarioId = normalizarIdPositivo(req.body.usuario_id);
    if (!usuarioId) return res.status(400).json("Afiliado inválido");
    const [usuarios] = await db.query(
      `SELECT u.*, r.nombre AS rol_nombre FROM usuario u INNER JOIN rol r ON r.id = u.rol_id WHERE u.id = ?`,
      [usuarioId]
    );
    if (usuarios.length === 0) return res.status(404).json("Afiliado no encontrado");
    let afiliado = usuarios[0];
    if (afiliado.rol_nombre !== "afiliado" || afiliado.habilitado !== "Y" || afiliado.usuario_familiar_id !== null) {
      return res.status(422).json("El destinatario debe ser un afiliado principal habilitado");
    }
    if (cabecera.rol === "departamental" && !idsPositivosIguales(afiliado.departamental_id, cabecera.departamental_id)) {
      return res.status(401).json("No autorizado");
    }

    const [existentes] = await db.query(
      "SELECT id FROM olimpiada_inscripcion WHERE olimpiada_id = ? AND usuario_id = ? AND eliminado = 0",
      [olimpiadaId, usuarioId]
    );
    if (existentes.length > 0) return res.status(409).json("El afiliado ya tiene una inscripción en esta olimpiada");

    const disciplinaIds = normalizarIds(req.body.disciplinas);
    if (!disciplinaIds || disciplinaIds.length === 0) return res.status(400).json("Elegí al menos una disciplina con IDs válidos");

    const datosSanitarioIds = normalizarIds(req.body.datos_sanitarios);
    if (!datosSanitarioIds) return res.status(400).json("La lista de datos sanitarios contiene IDs inválidos");
    const tensionArterial = normalizarTexto(req.body.tension_arterial);
    const grupoSanguineoId = normalizarIdPositivo(req.body.grupo_sanguineo_id);
    if (!tensionArterial) return res.status(400).json("Indicá tu presión arterial habitual");
    if (!grupoSanguineoId) return res.status(400).json("Elegí tu grupo sanguíneo");

    const archivos = req.files || [];
    const archivoCertificado = archivos.find((f) => f.fieldname === "CERTIFICADO");
    const archivoFoto = archivos.find((f) => f.fieldname === "FOTO");
    const firmaBase64 = req.body.firma || null;
    if (!archivoCertificado) return res.status(400).json("Adjuntá el certificado médico");
    if (!archivoFoto) return res.status(400).json("Adjuntá una foto del afiliado");
    if (archivoFoto && !archivoFoto.mimetype?.startsWith("image/")) return res.status(400).json("La foto debe ser una imagen");
    if (!firmaBase64) return res.status(400).json("Falta la firma");

    // Cupos por departamental (dentro de la transacción para evitar sobrecupo)
    connection = await db.getConnection();
    await connection.beginTransaction();

    const olimpiadaBloqueada = await bloquearOlimpiada(connection, olimpiadaId, { requiereHabilitada: true });
    if (!olimpiadaBloqueada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    olimpiada = olimpiadaBloqueada;
    if (cabecera.rol !== "admin" && !estaVentanaInscripcionAbierta(olimpiada)) {
      throw crearErrorHttp("La inscripción a esta olimpiada no está abierta", 409);
    }

    const [usuariosBloqueados] = await connection.query(
      `SELECT u.*, r.nombre AS rol_nombre
       FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
       WHERE u.id = ? FOR UPDATE`,
      [usuarioId]
    );
    if (usuariosBloqueados.length === 0) throw crearErrorHttp("Afiliado no encontrado", 404);
    afiliado = usuariosBloqueados[0];
    if (afiliado.rol_nombre !== "afiliado" || afiliado.habilitado !== "Y" || afiliado.usuario_familiar_id !== null) {
      throw crearErrorHttp("El destinatario debe ser un afiliado principal habilitado", 422);
    }
    if (cabecera.rol === "departamental" && (
      !normalizarIdPositivo(afiliado.departamental_id) ||
      normalizarIdPositivo(afiliado.departamental_id) !== normalizarIdPositivo(cabecera.departamental_id)
    )) {
      throw crearErrorHttp("No autorizado", 403);
    }

    const [existentesBloqueadas] = await connection.query(
      `SELECT id FROM olimpiada_inscripcion
       WHERE olimpiada_id = ? AND usuario_id = ? AND eliminado = 0
       FOR UPDATE`,
      [olimpiadaId, usuarioId]
    );
    if (existentesBloqueadas.length > 0) {
      throw crearErrorHttp("El afiliado ya tiene una inscripción en esta olimpiada", 409);
    }

    await validarReferenciasSanitarias(connection, grupoSanguineoId, datosSanitarioIds);
    await validarCapacidadDisciplinas(connection, {
      olimpiadaId,
      departamentalId: afiliado.departamental_id,
      disciplinaIds,
    });

    // Archivos a S3
    const firmaArchivo = await subirFirmaBase64(firmaBase64, "inscripciones/firma");
    if (!firmaArchivo) {
      await connection.rollback();
      return res.status(400).json("La firma es inválida");
    }
    const certificadoArchivo = await subirArchivoOlimpiadas(archivoCertificado, "inscripciones/certificado");
    const fotoArchivo = await subirArchivoOlimpiadas(archivoFoto, "inscripciones/foto");

    const [resultado] = await connection.query(
      `INSERT INTO olimpiada_inscripcion
         (olimpiada_id, usuario_id, departamental_id, creado_por_usuario_id, estado,
          tension_arterial, grupo_sanguineo_id, detalle_medico, detalle_alimentario, observaciones,
          lugar_trabajo, firma_archivo, certificado_archivo, certificado_nombre_original, certificado_mime, foto_archivo)
       VALUES (?, ?, ?, ?, 'VALIDADO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        olimpiadaId, usuarioId, afiliado.departamental_id, cabecera.id,
        tensionArterial, grupoSanguineoId,
        normalizarTexto(req.body.detalle_medico), normalizarTexto(req.body.detalle_alimentario),
        normalizarTexto(req.body.observaciones), normalizarTexto(req.body.lugar_trabajo),
        firmaArchivo, certificadoArchivo, archivoCertificado.originalname || null,
        archivoCertificado.mimetype || null, fotoArchivo,
      ]
    );
    const inscripcionId = resultado.insertId;

    for (const disciplinaId of disciplinaIds) {
      await connection.query(
        "INSERT INTO olimpiada_inscripcion_disciplina (inscripcion_id, disciplina_id) VALUES (?, ?)",
        [inscripcionId, disciplinaId]
      );
    }
    for (const datoId of datosSanitarioIds) {
      await connection.query(
        "INSERT INTO olimpiada_inscripcion_dato_sanitario (inscripcion_id, dato_sanitario_id) VALUES (?, ?)",
        [inscripcionId, datoId]
      );
    }

    await registrarHistorial(connection, {
      entidad: "INSCRIPCION", entidad_id: inscripcionId,
      olimpiada_id: olimpiadaId, inscripcion_id: inscripcionId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE",
      valor_nuevo: `Inscripción de ${afiliado.apellido}, ${afiliado.nombre} (${disciplinaIds.length} disciplinas)`,
    });

    await notificarStaffOlimpiadas(connection, afiliado.departamental_id, "OLIMPIADA_NUEVA",
      `Nueva inscripción a ${olimpiada.nombre}`,
      `${afiliado.apellido}, ${afiliado.nombre} se inscribió a las olimpiadas.`,
      { inscripcion_id: inscripcionId, olimpiada_id: olimpiadaId });

    await connection.commit();
    res.status(201).json({ success: true, id: inscripcionId, message: "¡Inscripción enviada! Nos vemos en las olimpiadas" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al enviar la inscripción");
  } finally {
    if (connection) connection.release();
  }
});

// Tabla de inscriptos de una olimpiada (staff)
router.get("/olimpiadas/:id(\\d+)/inscripciones", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    const filtroDepartamental = cabecera.rol === "departamental" ? Number(cabecera.departamental_id) || 0 : null;
    const db = mysqlConnection.promise();
    const [inscripciones] = await db.query(
      `SELECT i.id, i.estado, i.fecha_creacion, i.departamental_id,
              dep.nombre AS departamental_nombre,
              u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido,
              u.legajo, u.documento,
              i.detalle_medico IS NOT NULL AND i.detalle_medico <> '' AS tiene_detalle_medico,
              i.detalle_alimentario IS NOT NULL AND i.detalle_alimentario <> '' AS tiene_detalle_alimentario,
              (SELECT GROUP_CONCAT(d.nombre ORDER BY d.nombre SEPARATOR ', ')
               FROM olimpiada_inscripcion_disciplina idp
               INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
               WHERE idp.inscripcion_id = i.id) AS disciplinas
       FROM olimpiada_inscripcion i
       INNER JOIN usuario u ON u.id = i.usuario_id
       LEFT JOIN departamental dep ON dep.id = i.departamental_id
       WHERE i.olimpiada_id = ? AND i.eliminado = 0
         AND (? IS NULL OR i.departamental_id = ?)
       ORDER BY i.fecha_creacion DESC, i.id DESC`,
      [olimpiadaId, filtroDepartamental, filtroDepartamental]
    );
    res.status(200).json(inscripciones);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las inscripciones");
  }
});

// Inscripciones propias del afiliado
router.get("/olimpiadas/mis-inscripciones", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const db = mysqlConnection.promise();
    const [inscripciones] = await db.query(
      `SELECT i.id, i.estado, i.fecha_creacion, i.olimpiada_id,
              o.nombre AS olimpiada_nombre, o.edicion, o.localidad, o.fecha_inicio, o.fecha_fin,
              (SELECT GROUP_CONCAT(d.nombre ORDER BY d.nombre SEPARATOR ', ')
               FROM olimpiada_inscripcion_disciplina idp
               INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
               WHERE idp.inscripcion_id = i.id) AS disciplinas
       FROM olimpiada_inscripcion i
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.usuario_id = ? AND i.eliminado = 0 AND o.eliminado = 0
       ORDER BY o.fecha_inicio DESC, i.id DESC`,
      [cabecera.id]
    );
    res.status(200).json(inscripciones);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener tus inscripciones");
  }
});

// Detalle completo de una inscripción
router.get("/olimpiadas/inscripciones/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID de inscripción inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, o.nombre AS olimpiada_nombre, o.edicion AS olimpiada_edicion, o.localidad AS olimpiada_localidad,
              o.fecha_inicio AS olimpiada_fecha_inicio, o.fecha_fin AS olimpiada_fecha_fin, o.texto_licencia,
              dep.nombre AS departamental_nombre,
              g.nombre AS grupo_sanguineo_nombre,
              u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento, u.legajo,
              u.cuil, u.email, u.telefono, u.fecha_nacimiento, u.foto_archivo AS afiliado_foto_archivo,
              tp.nombre AS tipo_persona_nombre
       FROM olimpiada_inscripcion i
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       INNER JOIN usuario u ON u.id = i.usuario_id
       LEFT JOIN departamental dep ON dep.id = i.departamental_id
       LEFT JOIN olimpiada_grupo_sanguineo g ON g.id = i.grupo_sanguineo_id
       LEFT JOIN tipo_persona tp ON tp.id = u.tipo_persona_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    const inscripcion = rows[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) return res.status(401).json("No autorizado");

    const [disciplinas] = await db.query(
      `SELECT d.id, d.nombre, t.nombre AS tipo_nombre, d.icono_archivo
       FROM olimpiada_inscripcion_disciplina idp
       INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
       INNER JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
       WHERE idp.inscripcion_id = ?
       ORDER BY d.nombre`,
      [inscripcionId]
    );
    const [datosSanitarios] = await db.query(
      `SELECT ds.id, ds.nombre
       FROM olimpiada_inscripcion_dato_sanitario ids
       INNER JOIN olimpiada_dato_sanitario ds ON ds.id = ids.dato_sanitario_id
       WHERE ids.inscripcion_id = ?
       ORDER BY ds.orden`,
      [inscripcionId]
    );
    const [observaciones] = await db.query(
      `SELECT o.id, o.usuario_id, o.usuario_rol, o.mensaje, o.fecha_creacion,
              u.nombre AS usuario_nombre, u.apellido AS usuario_apellido
       FROM olimpiada_inscripcion_observacion o
       LEFT JOIN usuario u ON u.id = o.usuario_id
       WHERE o.inscripcion_id = ?
       ORDER BY o.fecha_creacion ASC, o.id ASC`,
      [inscripcionId]
    );

    let historial = [];
    if (esStaff(cabecera)) {
      const [historialRows] = await db.query(
        `SELECT h.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido
         FROM olimpiada_historial h
         LEFT JOIN usuario u ON u.id = h.usuario_id
         WHERE h.inscripcion_id = ?
         ORDER BY h.fecha DESC, h.id DESC`,
        [inscripcionId]
      );
      historial = historialRows;
    }

    // Firma del secretario para la constancia (solo staff)
    let firmaSecretario = null;
    if (esStaff(cabecera)) {
      const [configRows] = await db.query("SELECT * FROM olimpiada_config WHERE id = 1");
      const config = configRows[0] || {};
      firmaSecretario = {
        nombre: config.firma_secretario_nombre || null,
        cargo: config.firma_secretario_cargo || null,
        url: await getSignedFileUrlFromS3(config.firma_secretario_archivo).catch(() => null),
      };
    }

    res.status(200).json({
      ...inscripcion,
      disciplinas: await firmarIconosDisciplinas(disciplinas),
      datos_sanitarios: datosSanitarios,
      observaciones_hilo: observaciones,
      historial,
      firma_secretario: firmaSecretario,
      firma_url: await getSignedFileUrlFromS3(inscripcion.firma_archivo).catch(() => null),
      certificado_url: await getSignedFileUrlFromS3(inscripcion.certificado_archivo).catch(() => null),
      foto_url: await getSignedFileUrlFromS3(inscripcion.foto_archivo).catch(() => null),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener la inscripción");
  }
});

// Edición (staff; el afiliado puede corregir su formulario mientras la inscripción esté abierta)
router.put("/olimpiadas/inscripciones/:id(\\d+)", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID de inscripción inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, o.fecha_inicio_inscripcion, o.fecha_fin_inscripcion
       FROM olimpiada_inscripcion i INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    let inscripcion = rows[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) return res.status(401).json("No autorizado");
    if (cabecera.rol === "afiliado") {
      if (!estaVentanaInscripcionAbierta(inscripcion)) return res.status(409).json("La inscripción ya cerró: pedí los cambios por el chat de tu inscripción");
      if (inscripcion.estado === "CANCELADO") return res.status(409).json("La inscripción está cancelada");
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const olimpiadaBloqueada = await bloquearOlimpiada(connection, inscripcion.olimpiada_id);
    if (!olimpiadaBloqueada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    const [inscripcionesBloqueadas] = await connection.query(
      `SELECT i.*, o.fecha_inicio_inscripcion, o.fecha_fin_inscripcion
       FROM olimpiada_inscripcion i INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0 FOR UPDATE`,
      [inscripcionId]
    );
    if (inscripcionesBloqueadas.length === 0) throw crearErrorHttp("Inscripción no encontrada", 404);
    inscripcion = inscripcionesBloqueadas[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) throw crearErrorHttp("No autorizado", 403);
    if (cabecera.rol === "afiliado") {
      if (!estaVentanaInscripcionAbierta(inscripcion)) {
        throw crearErrorHttp("La inscripción ya cerró: pedí los cambios por el chat", 409);
      }
      if (inscripcion.estado === "CANCELADO") throw crearErrorHttp("La inscripción está cancelada", 409);
    }

    const cambios = [];
    let grupoSanguineoId = inscripcion.grupo_sanguineo_id;
    if (req.body.grupo_sanguineo_id !== undefined) {
      grupoSanguineoId = normalizarIdPositivo(req.body.grupo_sanguineo_id);
      if (!grupoSanguineoId) throw crearErrorHttp("Grupo sanguíneo inválido", 400);
    }
    const campos = {
      tension_arterial: normalizarTexto(req.body.tension_arterial) ?? inscripcion.tension_arterial,
      grupo_sanguineo_id: grupoSanguineoId,
      detalle_medico: req.body.detalle_medico !== undefined ? normalizarTexto(req.body.detalle_medico) : inscripcion.detalle_medico,
      detalle_alimentario: req.body.detalle_alimentario !== undefined ? normalizarTexto(req.body.detalle_alimentario) : inscripcion.detalle_alimentario,
      observaciones: req.body.observaciones !== undefined ? normalizarTexto(req.body.observaciones) : inscripcion.observaciones,
      lugar_trabajo: req.body.lugar_trabajo !== undefined ? normalizarTexto(req.body.lugar_trabajo) : inscripcion.lugar_trabajo,
    };
    await validarReferenciasSanitarias(connection, campos.grupo_sanguineo_id, []);
    for (const [campo, valorNuevo] of Object.entries(campos)) {
      const valorAnterior = inscripcion[campo];
      if ((valorAnterior ?? "") !== (valorNuevo ?? "")) {
        cambios.push({ campo, anterior: valorAnterior, nuevo: valorNuevo });
      }
    }

    // Archivos nuevos (opcionales)
    const archivos = req.files || [];
    const archivoCertificado = archivos.find((f) => f.fieldname === "CERTIFICADO");
    const archivoFoto = archivos.find((f) => f.fieldname === "FOTO");
    let certificadoArchivo = inscripcion.certificado_archivo;
    let certificadoNombre = inscripcion.certificado_nombre_original;
    let certificadoMime = inscripcion.certificado_mime;
    let fotoArchivo = inscripcion.foto_archivo;
    let firmaArchivo = inscripcion.firma_archivo;
    if (archivoCertificado) {
      certificadoArchivo = await subirArchivoOlimpiadas(archivoCertificado, "inscripciones/certificado");
      certificadoNombre = archivoCertificado.originalname || null;
      certificadoMime = archivoCertificado.mimetype || null;
      cambios.push({ campo: "certificado_archivo", anterior: inscripcion.certificado_archivo, nuevo: certificadoArchivo });
    }
    if (archivoFoto) {
      if (!archivoFoto.mimetype?.startsWith("image/")) {
        await connection.rollback();
        return res.status(400).json("La foto debe ser una imagen");
      }
      fotoArchivo = await subirArchivoOlimpiadas(archivoFoto, "inscripciones/foto");
      cambios.push({ campo: "foto_archivo", anterior: inscripcion.foto_archivo, nuevo: fotoArchivo });
    }
    if (req.body.firma) {
      const nuevaFirma = await subirFirmaBase64(req.body.firma, "inscripciones/firma");
      if (nuevaFirma) {
        firmaArchivo = nuevaFirma;
        cambios.push({ campo: "firma_archivo", anterior: inscripcion.firma_archivo, nuevo: nuevaFirma });
      }
    }

    const [actualizacionInscripcion] = await connection.query(
      `UPDATE olimpiada_inscripcion
       SET tension_arterial = ?, grupo_sanguineo_id = ?, detalle_medico = ?, detalle_alimentario = ?,
           observaciones = ?, lugar_trabajo = ?, firma_archivo = ?,
           certificado_archivo = ?, certificado_nombre_original = ?, certificado_mime = ?, foto_archivo = ?
       WHERE id = ? AND estado = ? AND eliminado = 0`,
      [
        campos.tension_arterial, campos.grupo_sanguineo_id, campos.detalle_medico, campos.detalle_alimentario,
        campos.observaciones, campos.lugar_trabajo, firmaArchivo,
        certificadoArchivo, certificadoNombre, certificadoMime, fotoArchivo,
        inscripcionId, inscripcion.estado,
      ]
    );
    if (actualizacionInscripcion.affectedRows !== 1) {
      throw crearErrorHttp("La inscripción cambió mientras se editaba. Recargá e intentá nuevamente.", 409);
    }

    // Disciplinas y datos sanitarios (si vienen, se reemplazan)
    if (req.body.disciplinas !== undefined) {
      const disciplinaIds = normalizarIds(req.body.disciplinas);
      if (!disciplinaIds || disciplinaIds.length === 0) throw crearErrorHttp("Elegí al menos una disciplina con IDs válidos", 400);
      await validarCapacidadDisciplinas(connection, {
        olimpiadaId: inscripcion.olimpiada_id,
        departamentalId: inscripcion.departamental_id,
        disciplinaIds,
        excluirInscripcionId: inscripcionId,
        controlarCapacidad: inscripcion.estado === "VALIDADO",
      });
      const [anteriores] = await connection.query(
        `SELECT GROUP_CONCAT(d.nombre ORDER BY d.nombre SEPARATOR ', ') AS lista
         FROM olimpiada_inscripcion_disciplina idp
         INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
         WHERE idp.inscripcion_id = ?`,
        [inscripcionId]
      );
      await connection.query("DELETE FROM olimpiada_inscripcion_disciplina WHERE inscripcion_id = ?", [inscripcionId]);
      for (const disciplinaId of disciplinaIds) {
        await connection.query(
          "INSERT INTO olimpiada_inscripcion_disciplina (inscripcion_id, disciplina_id) VALUES (?, ?)",
          [inscripcionId, disciplinaId]
        );
      }
      const [nuevas] = await connection.query(
        `SELECT GROUP_CONCAT(d.nombre ORDER BY d.nombre SEPARATOR ', ') AS lista
         FROM olimpiada_inscripcion_disciplina idp
         INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
         WHERE idp.inscripcion_id = ?`,
        [inscripcionId]
      );
      if ((anteriores[0].lista || "") !== (nuevas[0].lista || "")) {
        cambios.push({ campo: "disciplinas", anterior: anteriores[0].lista, nuevo: nuevas[0].lista });
      }
    }
    if (req.body.datos_sanitarios !== undefined) {
      const datoIds = normalizarIds(req.body.datos_sanitarios);
      if (!datoIds) throw crearErrorHttp("La lista de datos sanitarios contiene IDs inválidos", 400);
      await validarReferenciasSanitarias(connection, campos.grupo_sanguineo_id, datoIds);
      await connection.query("DELETE FROM olimpiada_inscripcion_dato_sanitario WHERE inscripcion_id = ?", [inscripcionId]);
      for (const datoId of datoIds) {
        await connection.query(
          "INSERT INTO olimpiada_inscripcion_dato_sanitario (inscripcion_id, dato_sanitario_id) VALUES (?, ?)",
          [inscripcionId, datoId]
        );
      }
    }

    for (const cambio of cambios) {
      await registrarHistorial(connection, {
        entidad: "INSCRIPCION", entidad_id: inscripcionId,
        olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
        usuario_id: cabecera.id, usuario_rol: cabecera.rol,
        tipo_operacion: "UPDATE", campo_modificado: cambio.campo,
        valor_anterior: cambio.anterior, valor_nuevo: cambio.nuevo,
      });
    }

    // Avisar a la otra parte si hubo cambios
    if (cambios.length > 0) {
      if (cabecera.rol === "afiliado") {
        await notificarStaffOlimpiadas(connection, inscripcion.departamental_id, "OLIMPIADA_ACTUALIZADA",
          `Inscripción #${inscripcionId} actualizada`,
          `El afiliado actualizó su formulario de inscripción a las olimpiadas.`,
          { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id });
      } else {
        await insertarNotificacion(connection, inscripcion.usuario_id, "OLIMPIADA_ACTUALIZADA",
          `Actualizamos tu inscripción a las olimpiadas`,
          `Nuestro equipo editó tu formulario de inscripción. Revisalo y escribinos por el chat si tenés dudas.`,
          { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id });
      }
    }

    await connection.commit();
    res.status(200).json({ success: true, message: "Inscripción actualizada" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al actualizar la inscripción");
  } finally {
    if (connection) connection.release();
  }
});

// Cambio de estado (staff valida/cancela; el afiliado puede cancelar su propia inscripción)
router.put("/olimpiadas/inscripciones/:id(\\d+)/estado", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID de inscripción inválido");
    const estadoNuevo = String(req.body.estado || "").toUpperCase();
    if (!["VALIDADO", "CANCELADO"].includes(estadoNuevo)) return res.status(400).json("Estado inválido");

    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, o.nombre AS olimpiada_nombre FROM olimpiada_inscripcion i
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    let inscripcion = rows[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) return res.status(401).json("No autorizado");
    if (cabecera.rol === "afiliado" && estadoNuevo !== "CANCELADO") return res.status(401).json("No autorizado");
    if (inscripcion.estado === estadoNuevo) return res.status(409).json("La inscripción ya está en ese estado");

    connection = await db.getConnection();
    await connection.beginTransaction();

    const olimpiadaBloqueada = await bloquearOlimpiada(connection, inscripcion.olimpiada_id);
    if (!olimpiadaBloqueada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    const [inscripcionesBloqueadas] = await connection.query(
      `SELECT i.*, o.nombre AS olimpiada_nombre
       FROM olimpiada_inscripcion i INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0 FOR UPDATE`,
      [inscripcionId]
    );
    if (inscripcionesBloqueadas.length === 0) throw crearErrorHttp("Inscripción no encontrada", 404);
    inscripcion = inscripcionesBloqueadas[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) throw crearErrorHttp("No autorizado", 403);
    if (cabecera.rol === "afiliado" && estadoNuevo !== "CANCELADO") throw crearErrorHttp("No autorizado", 403);
    if (inscripcion.estado === estadoNuevo) throw crearErrorHttp("La inscripción ya está en ese estado", 409);

    if (estadoNuevo === "VALIDADO") {
      const [disciplinas] = await connection.query(
        "SELECT disciplina_id FROM olimpiada_inscripcion_disciplina WHERE inscripcion_id = ? FOR UPDATE",
        [inscripcionId]
      );
      const disciplinaIds = disciplinas.map((disciplina) => normalizarIdPositivo(disciplina.disciplina_id));
      if (disciplinaIds.length === 0 || disciplinaIds.some((id) => !id)) {
        throw crearErrorHttp("La inscripción no tiene disciplinas válidas para reactivarse", 409);
      }
      await validarCapacidadDisciplinas(connection, {
        olimpiadaId: inscripcion.olimpiada_id,
        departamentalId: inscripcion.departamental_id,
        disciplinaIds,
        excluirInscripcionId: inscripcionId,
      });
    }

    const [actualizacionEstado] = await connection.query(
      "UPDATE olimpiada_inscripcion SET estado = ? WHERE id = ? AND estado = ? AND eliminado = 0",
      [estadoNuevo, inscripcionId, inscripcion.estado]
    );
    if (actualizacionEstado.affectedRows !== 1) {
      throw crearErrorHttp("La inscripción cambió mientras se procesaba. Recargá e intentá nuevamente.", 409);
    }
    await registrarHistorial(connection, {
      entidad: "INSCRIPCION", entidad_id: inscripcionId,
      olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CAMBIO_ESTADO",
      campo_modificado: "estado", valor_anterior: inscripcion.estado, valor_nuevo: estadoNuevo,
      observacion: normalizarTexto(req.body.motivo),
    });

    if (cabecera.rol === "afiliado") {
      await notificarStaffOlimpiadas(connection, inscripcion.departamental_id, "OLIMPIADA_ESTADO",
        `Inscripción #${inscripcionId} cancelada`,
        `El afiliado canceló su inscripción a ${inscripcion.olimpiada_nombre}.`,
        { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id, estado: estadoNuevo });
    } else {
      await insertarNotificacion(connection, inscripcion.usuario_id, "OLIMPIADA_ESTADO",
        estadoNuevo === "CANCELADO" ? "Tu inscripción fue cancelada" : "¡Tu inscripción está validada!",
        estadoNuevo === "CANCELADO"
          ? `Cancelamos tu inscripción a ${inscripcion.olimpiada_nombre}. Escribinos por el chat de tu inscripción si creés que es un error.`
          : `Tu inscripción a ${inscripcion.olimpiada_nombre} quedó validada. ¡Nos vemos en las olimpiadas!`,
        { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id, estado: estadoNuevo });
    }

    await connection.commit();
    res.status(200).json({ success: true, message: "Estado actualizado", estado: estadoNuevo });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al actualizar el estado");
  } finally {
    if (connection) connection.release();
  }
});

// Baja lógica (solo admin)
router.delete("/olimpiadas/inscripciones/:id(\\d+)", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID de inscripción inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido
       FROM olimpiada_inscripcion i INNER JOIN usuario u ON u.id = i.usuario_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");

    connection = await db.getConnection();
    await connection.beginTransaction();
    const olimpiada = await bloquearOlimpiada(connection, rows[0].olimpiada_id);
    if (!olimpiada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    const [inscripcionesBloqueadas] = await connection.query(
      `SELECT i.*, u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido
       FROM olimpiada_inscripcion i INNER JOIN usuario u ON u.id = i.usuario_id
       WHERE i.id = ? AND i.eliminado = 0 FOR UPDATE`,
      [inscripcionId]
    );
    if (inscripcionesBloqueadas.length === 0) throw crearErrorHttp("Inscripción no encontrada", 404);
    const inscripcion = inscripcionesBloqueadas[0];
    const [eliminacion] = await connection.query(
      `UPDATE olimpiada_inscripcion
       SET eliminado = 1, eliminado_usuario_id = ?, fecha_eliminacion = NOW()
       WHERE id = ? AND estado = ? AND eliminado = 0`,
      [cabecera.id, inscripcionId, inscripcion.estado]
    );
    if (eliminacion.affectedRows !== 1) throw crearErrorHttp("La inscripción cambió mientras se eliminaba", 409);
    await registrarHistorial(connection, {
      entidad: "INSCRIPCION", entidad_id: inscripcionId,
      olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE",
      valor_anterior: `Inscripción de ${inscripcion.afiliado_apellido}, ${inscripcion.afiliado_nombre}`,
      observacion: normalizarTexto(req.body?.motivo),
    });
    await connection.commit();
    res.status(200).json({ success: true, message: "Inscripción eliminada" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al eliminar la inscripción");
  } finally {
    if (connection) connection.release();
  }
});

// Chat de la inscripción (afiliado <-> staff)
router.post("/olimpiadas/inscripciones/:id(\\d+)/observaciones", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    const mensaje = normalizarTexto(req.body.mensaje);
    if (!inscripcionId || !mensaje) return res.status(400).json("El mensaje es obligatorio");

    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, o.nombre AS olimpiada_nombre FROM olimpiada_inscripcion i
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    const inscripcion = rows[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) return res.status(401).json("No autorizado");

    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.query(
      "INSERT INTO olimpiada_inscripcion_observacion (inscripcion_id, usuario_id, usuario_rol, mensaje) VALUES (?, ?, ?, ?)",
      [inscripcionId, cabecera.id, cabecera.rol, mensaje]
    );
    await registrarHistorial(connection, {
      entidad: "INSCRIPCION", entidad_id: inscripcionId,
      olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "OBSERVACION", observacion: mensaje,
    });

    if (cabecera.rol === "afiliado") {
      await notificarStaffOlimpiadas(connection, inscripcion.departamental_id, "OLIMPIADA_OBSERVACION",
        `Nuevo mensaje en la inscripción #${inscripcionId}`,
        `El afiliado escribió: ${mensaje}`,
        { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id });
    } else {
      await insertarNotificacion(connection, inscripcion.usuario_id, "OLIMPIADA_OBSERVACION",
        `Nuevo mensaje en tu inscripción a ${inscripcion.olimpiada_nombre}`, mensaje,
        { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id });
    }

    await connection.commit();
    res.status(201).json({ success: true, message: "Mensaje enviado" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al enviar el mensaje");
  } finally {
    if (connection) connection.release();
  }
});

// Descarga del certificado médico
router.get("/olimpiadas/inscripciones/:id(\\d+)/certificado", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_inscripcion WHERE id = ? AND eliminado = 0", [inscripcionId]);
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    if (!puedeVerInscripcion(cabecera, rows[0])) return res.status(401).json("No autorizado");
    if (!rows[0].certificado_archivo) return res.status(404).json("La inscripción no tiene certificado");
    const objeto = await getObjectBufferFromS3(rows[0].certificado_archivo);
    if (!objeto) return res.status(404).json("El archivo no está disponible");
    const nombre = rows[0].certificado_nombre_original || rows[0].certificado_archivo.split("/").pop();
    res.setHeader("Content-Type", objeto.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(nombre)}"`);
    res.status(200).send(objeto.buffer);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al descargar el certificado");
  }
});

// ===========================================================================
// HISTORIAL GLOBAL (auditoría, solo admin)
// ===========================================================================
router.get("/olimpiadas/historial", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const limite = req.query.limite === undefined ? 500 : normalizarIdPositivo(req.query.limite);
    if (!limite || limite > 2000) return res.status(400).json("El límite es inválido");
    const [historial] = await db.query(
      `SELECT h.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido, o.nombre AS olimpiada_nombre
       FROM olimpiada_historial h
       LEFT JOIN usuario u ON u.id = h.usuario_id
       LEFT JOIN olimpiada o ON o.id = h.olimpiada_id
       ORDER BY h.fecha DESC, h.id DESC
       LIMIT ?`,
      [limite]
    );
    res.status(200).json(historial);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener el historial");
  }
});

router.__test = Object.freeze({
  decodificarFirmaBase64,
  detectarMimeArchivo,
  estaVentanaInscripcionAbierta,
  fechaHoyBuenosAires,
  idsPositivosIguales,
  normalizarCupo,
  normalizarIdPositivo,
  normalizarIds,
  validarCapacidadDisciplinas,
  validarConfiguracionContraInscripciones,
  validarContenidoArchivo,
  validarDatosOlimpiada,
  verifyToken,
});

module.exports = router;
