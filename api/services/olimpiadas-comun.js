/**
 * Helpers compartidos del módulo Olimpiadas.
 *
 * Los usan api/routes/olimpiadas.js (edición, catálogo, inscripciones), olimpiadas-bonos.js
 * (bonos contribución, bloques, sorteo) y olimpiadas-contenido.js (novedades, cronograma,
 * sedes, fixture, medallero, fotos). Todo lo que sea auth, normalización, S3, imágenes,
 * historial, notificaciones y reglas de bonos vive acá para que los tres routers hablen igual.
 */
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const mysqlConnection = require("../connection/connection");
const { registrarErrorRuta } = require("./errores");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { normalizarFechaCivil } = require("./valores-dominio");
const { TRAMOS_BONOS_INICIALES, SECCIONES_INICIALES } = require("../data/olimpiadas-plantillas");

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
const EXPIRACION_FIRMA = Number.isFinite(S3_SIGNED_URL_EXPIRES_SECONDS) ? S3_SIGNED_URL_EXPIRES_SECONDS : 3600;

async function uploadBufferToS3({ key, buffer, contentType, cacheControl }) {
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ...(cacheControl ? { CacheControl: cacheControl } : {}),
  }));
}

async function deleteFromS3(key) {
  if (!key) return;
  await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

// Nunca lanza: una key rota en S3 no debe tumbar una baja lógica ni un rollback.
async function eliminarObjetosS3Seguro(keys) {
  for (const key of keys || []) {
    try {
      await deleteFromS3(key);
    } catch (error) {
      registrarErrorRuta(error, `olimpiadas:s3-delete ${key}`);
    }
  }
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

async function getSignedFileUrlFromS3(key, expiresIn = EXPIRACION_FIRMA) {
  if (!key) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: key }), { expiresIn });
}

// Firma "segura": una key inexistente devuelve null en vez de romper un listado.
async function firmarSeguro(key, expiresIn = EXPIRACION_FIRMA) {
  if (!key) return null;
  try {
    return await getSignedFileUrlFromS3(key, expiresIn);
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Archivos: detección de tipo por contenido, validación y subida
// ---------------------------------------------------------------------------
const MAX_ARCHIVO_OLIMPIADAS_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_OLIMPIADAS_BYTES = 30 * 1024 * 1024;
const MAX_FIRMA_BYTES = 2 * 1024 * 1024;
const MAX_PIXELES_ENTRADA = 40_000_000;
const MIME_IMAGEN_PERMITIDO = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
const EXTENSION_POR_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

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

function extensionSegura(nombre, mime) {
  const extension = EXTENSION_POR_MIME[mime === "image/jpg" ? "image/jpeg" : mime];
  if (!extension) throw crearErrorHttp("Formato de archivo no permitido", 400);
  return extension;
}

function claveAleatoria(prefijo, extension) {
  return `olimpiadas/${prefijo}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${extension}`;
}

// Sube el archivo tal cual (certificados, firmas, íconos). Devuelve la key.
async function subirArchivoOlimpiadas(file, prefijo) {
  const validacion = validarContenidoArchivo(file);
  if (validacion.error) throw crearErrorHttp(validacion.error, 400);
  const extension = extensionSegura(file.originalname, file.mimetype);
  const key = claveAleatoria(prefijo, extension);
  await uploadBufferToS3({ key, buffer: file.buffer, contentType: file.mimetype });
  return key;
}

async function subirFirmaBase64(firmaBase64, prefijo) {
  const firma = decodificarFirmaBase64(firmaBase64);
  if (!firma) throw crearErrorHttp("La firma debe ser una imagen JPEG, PNG, WebP o HEIC válida de hasta 2 MB", 400);
  const extension = extensionSegura(null, firma.mime);
  const key = claveAleatoria(prefijo, extension);
  await uploadBufferToS3({ key, buffer: firma.buffer, contentType: firma.mime });
  return key;
}

/**
 * Procesa una imagen con sharp: corrige orientación EXIF, limita el ancho y la convierte a WebP.
 * HEIC no siempre está soportado por el binario de sharp: si falla se informa 422.
 * Devuelve { buffer, mime: 'image/webp', extension: 'webp', ancho, alto }.
 */
async function procesarImagenWeb(buffer, { anchoMaximo = 1600, calidad = 82 } = {}) {
  try {
    const pipeline = sharp(buffer, { failOn: "error", limitInputPixels: MAX_PIXELES_ENTRADA, sequentialRead: true })
      .rotate()
      .resize({ width: anchoMaximo, height: anchoMaximo, fit: "inside", withoutEnlargement: true })
      .webp({ quality: calidad, effort: 4 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { buffer: data, mime: "image/webp", extension: "webp", ancho: info.width, alto: info.height };
  } catch (error) {
    throw crearErrorHttp("La imagen está dañada o tiene un formato que no se pudo procesar", 422);
  }
}

/**
 * Sube una imagen optimizada (WebP, ancho máximo) y devuelve { key, ancho, alto, mime }.
 * Con `miniatura: true` sube además una versión chica y devuelve también { miniatura_key }.
 */
async function subirImagenOptimizada(file, prefijo, { anchoMaximo = 1600, miniatura = false, anchoMiniatura = 420 } = {}) {
  const validacion = validarContenidoArchivo(file);
  if (validacion.error) throw crearErrorHttp(validacion.error, 400);
  if (!file.mimetype.startsWith("image/")) throw crearErrorHttp("El archivo debe ser una imagen", 400);
  const web = await procesarImagenWeb(file.buffer, { anchoMaximo });
  const key = claveAleatoria(prefijo, web.extension);
  const subidas = [];
  try {
    await uploadBufferToS3({ key, buffer: web.buffer, contentType: web.mime, cacheControl: "public, max-age=31536000, immutable" });
    subidas.push(key);
    let miniaturaKey = null;
    if (miniatura) {
      const chica = await procesarImagenWeb(file.buffer, { anchoMaximo: anchoMiniatura, calidad: 76 });
      miniaturaKey = claveAleatoria(`${prefijo}_min`, chica.extension);
      await uploadBufferToS3({ key: miniaturaKey, buffer: chica.buffer, contentType: chica.mime, cacheControl: "public, max-age=31536000, immutable" });
      subidas.push(miniaturaKey);
    }
    return { key, miniatura_key: miniaturaKey, ancho: web.ancho, alto: web.alto, mime: web.mime, keys: subidas };
  } catch (error) {
    await eliminarObjetosS3Seguro(subidas);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Multer (memoria). Cualquier slot; el contenido se valida por magic bytes.
// ---------------------------------------------------------------------------
function crearUploadOlimpiadas({ maxFiles = 4, maxTotalBytes = MAX_TOTAL_OLIMPIADAS_BYTES } = {}) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: maxFiles, fileSize: MAX_ARCHIVO_OLIMPIADAS_BYTES, fieldSize: Math.ceil(MAX_FIRMA_BYTES / 3) * 4 + 256 },
    fileFilter: (req, file, cb) => {
      const mime = file.mimetype === "image/jpg" ? "image/jpeg" : file.mimetype;
      const esImagen = MIME_IMAGEN_PERMITIDO.has(mime);
      const esPdf = permitePdfEnSlot(file.fieldname) && file.mimetype === "application/pdf";
      if (!esImagen && !esPdf) return cb(new Error("Solo se permiten JPEG, PNG, WebP, HEIC y PDF únicamente para certificados"));
      return cb(null, true);
    },
  });
  return function manejarUpload(req, res, next) {
    upload.any()(req, res, (error) => {
      if (error) {
        if (error.code === "LIMIT_FILE_COUNT") return res.status(400).json(`Se pueden subir hasta ${maxFiles} archivos por vez`);
        if (error.code === "LIMIT_FILE_SIZE") return res.status(400).json("Cada archivo puede pesar hasta 10 MB");
        return res.status(400).json(error.message || "No se pudieron procesar los archivos");
      }
      const totalBytes = (req.files || []).reduce((total, file) => total + (file.buffer?.length || 0), 0);
      if (totalBytes > maxTotalBytes) {
        return res.status(400).json(`Los archivos superan el máximo total de ${Math.floor(maxTotalBytes / 1024 / 1024)} MB`);
      }
      for (const file of req.files || []) {
        const validacion = validarContenidoArchivo(file);
        if (validacion.error) return res.status(400).json(validacion.error);
      }
      return next();
    });
  };
}

const manejarUploadOlimpiadas = crearUploadOlimpiadas({ maxFiles: 4 });

// ---------------------------------------------------------------------------
// Auth y roles
// ---------------------------------------------------------------------------
function verifyToken(req, res, next) {
  return verificarTokenConAutorizacionActual({
    req,
    res,
    next: () => {
      const cabecera = JSON.parse(req.data.data);
      if (cabecera.rol === "afiliado" && Number(cabecera.modulo_olimpiadas) !== 1) {
        return res.status(403).json("El módulo de Olimpiadas no está habilitado para este usuario");
      }
      return next();
    },
    jwt,
    jwtSecret: process.env.JWT_SECRET,
    db: mysqlConnection.promise(),
    mensajeAuthorization: "Se requiere Authorization: Bearer <token>",
  });
}

function getCabecera(req) {
  return JSON.parse(req.data.data);
}

// Gestión del módulo: administración provincial (admin + admin-central) y departamentales.
const ROLES_SUPERIORES = ["admin", "admin-central"];
const ROLES_GESTION = [...ROLES_SUPERIORES, "departamental"];

function esStaff(cabecera) {
  return ROLES_GESTION.includes(cabecera.rol);
}

// Administración provincial: ve y gestiona todo (contenido, bonos de todas las departamentales, sorteo).
function esSuperior(cabecera) {
  return ROLES_SUPERIORES.includes(cabecera.rol);
}

// Solo admin: catálogo de disciplinas, firma del secretario, eliminaciones e historial global.
function esAdmin(cabecera) {
  return cabecera.rol === "admin";
}

function departamentalDe(cabecera) {
  return normalizarIdPositivo(cabecera.departamental_id) || 0;
}

// El staff departamental solo ve inscripciones de su departamental
function puedeVerInscripcion(cabecera, inscripcion) {
  if (esSuperior(cabecera)) return true;
  if (cabecera.rol === "departamental") return idsPositivosIguales(inscripcion.departamental_id, cabecera.departamental_id);
  if (cabecera.rol === "afiliado") return idsPositivosIguales(inscripcion.usuario_id, cabecera.id);
  return false;
}

// ---------------------------------------------------------------------------
// Normalización y errores
// ---------------------------------------------------------------------------
function crearErrorHttp(mensaje, statusCode = 400) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  return error;
}

// Responde el error de negocio con su código o 500 con el mensaje por defecto (respuestas string).
function responderError(res, error, mensajePorDefecto) {
  registrarErrorRuta(error);
  if (res.headersSent) return;
  if (error?.statusCode) return res.status(error.statusCode).json(error.message);
  return res.status(500).json(mensajePorDefecto);
}

function normalizarTexto(valor, maximo = null) {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (texto.length === 0) return null;
  return maximo ? texto.slice(0, maximo) : texto;
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

// Entero >= 0 (acepta number o string de dígitos). null si inválido.
function normalizarEnteroNoNegativo(valor) {
  if (typeof valor === "number") return Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (!/^\d+$/.test(texto)) return null;
  const numero = Number(texto);
  return Number.isSafeInteger(numero) ? numero : null;
}

// Monto decimal >= 0 con hasta 2 decimales (acepta "40000", "40000.50", "40000,50"). null si inválido.
function normalizarMonto(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const texto = String(valor).trim().replace(",", ".");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(texto)) return null;
  return Number(texto);
}

// 1/0 desde "1", "0", true, false, "true", "false", "Y", "N". null si no viene.
function normalizarBooleano01(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  if (valor === true || valor === 1 || valor === "1" || valor === "true" || valor === "Y" || valor === "S") return 1;
  if (valor === false || valor === 0 || valor === "0" || valor === "false" || valor === "N") return 0;
  return null;
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

function parseJsonSeguro(valor, porDefecto) {
  if (valor === undefined || valor === null || valor === "") return porDefecto;
  if (typeof valor !== "string") return valor;
  try {
    return JSON.parse(valor);
  } catch (error) {
    return porDefecto;
  }
}

// Lista de IDs positivos desde array nativo o JSON string. [] si vacío, null si algo es inválido.
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

// Hora "HH:MM" o "HH:MM:SS" → "HH:MM:SS". null si vacío; undefined si inválido.
function normalizarHora(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(valor).trim());
  if (!match) return undefined;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3] || 0);
  if (h > 23 || m > 59 || s > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// URL http(s) válida o null. undefined si inválida.
function normalizarUrl(valor, maximo = 600) {
  const texto = normalizarTexto(valor, maximo);
  if (!texto) return null;
  try {
    const url = new URL(texto);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return texto;
  } catch (error) {
    return undefined;
  }
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

// ---------------------------------------------------------------------------
// Estados de inscripción
// ---------------------------------------------------------------------------
const ESTADOS_INSCRIPCION = ["PENDIENTE", "VALIDADO", "CANCELADO"];
// Ocupan cupo: las pendientes también, hasta que se rechacen.
const ESTADOS_ACTIVOS = ["PENDIENTE", "VALIDADO"];
const SQL_ESTADOS_ACTIVOS = "('PENDIENTE','VALIDADO')";

// ---------------------------------------------------------------------------
// Historial y notificaciones
// ---------------------------------------------------------------------------
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

const TITULO_NOTIFICACION_MAX = 180;
function acotarTituloNotificacion(titulo) {
  const texto = String(titulo || "").trim();
  return texto.length <= TITULO_NOTIFICACION_MAX ? texto : `${texto.slice(0, TITULO_NOTIFICACION_MAX - 1)}…`;
}

async function insertarNotificacion(connection, usuarioId, tipo, titulo, mensaje, payload) {
  await connection.query(
    `INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)`,
    [usuarioId, tipo, acotarTituloNotificacion(titulo), mensaje, JSON.stringify(payload || {})]
  );
}

// Staff que gestiona olimpiadas de una departamental: administración provincial + departamentales de esa sede
async function notificarStaffOlimpiadas(connection, departamentalId, tipo, titulo, mensaje, payload, excluirUsuarioId = null) {
  const [usuarios] = await connection.query(
    `SELECT u.id
     FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
     WHERE u.habilitado = 'Y'
       AND (r.nombre IN ('admin', 'admin-central') OR (r.nombre = 'departamental' AND u.departamental_id = ?))`,
    [departamentalId || 0]
  );
  for (const u of usuarios) {
    if (excluirUsuarioId && Number(u.id) === Number(excluirUsuarioId)) continue;
    await insertarNotificacion(connection, u.id, tipo, titulo, mensaje, payload);
  }
}

// Todos los inscriptos activos de una olimpiada (opcionalmente de una departamental)
async function notificarInscriptosOlimpiada(connection, olimpiadaId, tipo, titulo, mensaje, payload, { departamentalId = null } = {}) {
  const [inscriptos] = await connection.query(
    `SELECT DISTINCT i.usuario_id
     FROM olimpiada_inscripcion i
     WHERE i.olimpiada_id = ? AND i.eliminado = 0 AND i.estado IN ${SQL_ESTADOS_ACTIVOS}
       AND (? IS NULL OR i.departamental_id = ?)`,
    [olimpiadaId, departamentalId, departamentalId]
  );
  for (const inscripto of inscriptos) {
    await insertarNotificacion(connection, inscripto.usuario_id, tipo, titulo, mensaje, payload);
  }
  return inscriptos.length;
}

// ---------------------------------------------------------------------------
// Olimpiada: lectura básica y siembra de contenido inicial
// ---------------------------------------------------------------------------
async function obtenerOlimpiada(db, olimpiadaId, { forUpdate = false } = {}) {
  const [rows] = await db.query(
    `SELECT * FROM olimpiada WHERE id = ? AND eliminado = 0${forUpdate ? " FOR UPDATE" : ""}`,
    [olimpiadaId]
  );
  return rows[0] || null;
}

// Al crear una olimpiada: tramos de bonos por edad y secciones informativas de base (editables).
async function sembrarContenidoInicialOlimpiada(connection, olimpiadaId) {
  for (const [indice, tramo] of TRAMOS_BONOS_INICIALES.entries()) {
    await connection.query(
      `INSERT INTO olimpiada_bono_tramo (olimpiada_id, edad_desde, edad_hasta, bonos, etiqueta, orden)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [olimpiadaId, tramo.edad_desde, tramo.edad_hasta, tramo.bonos, tramo.etiqueta, indice + 1]
    );
  }
  for (const seccion of SECCIONES_INICIALES) {
    await connection.query(
      `INSERT INTO olimpiada_seccion (olimpiada_id, clave, ubicacion, titulo, contenido, orden)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [olimpiadaId, seccion.clave, seccion.ubicacion, seccion.titulo, seccion.contenido, seccion.orden]
    );
  }
}

// ---------------------------------------------------------------------------
// Bonos contribución: reglas puras (testeables sin BD)
// ---------------------------------------------------------------------------

// Edad cumplida en `fechaReferencia` (YYYY-MM-DD). null si la fecha de nacimiento es inválida.
function calcularEdad(fechaNacimiento, fechaReferencia) {
  const nac = normalizarFechaCivil(fechaNacimiento);
  const ref = normalizarFechaCivil(fechaReferencia) || fechaHoyBuenosAires();
  if (!nac) return null;
  const [an, mn, dn] = nac.split("-").map(Number);
  const [ar, mr, dr] = ref.split("-").map(Number);
  let edad = ar - an;
  if (mr < mn || (mr === mn && dr < dn)) edad -= 1;
  return edad < 0 ? 0 : edad;
}

// Bonos según el tramo de edad. Si ninguno matchea, devuelve el tramo abierto (edad_hasta NULL) o 0.
function bonosPorEdad(tramos, edad) {
  if (edad === null || edad === undefined) return null;
  const lista = Array.isArray(tramos) ? tramos : [];
  const exacto = lista.find((t) => Number(t.edad_desde) <= edad && (t.edad_hasta === null || t.edad_hasta === undefined || Number(t.edad_hasta) >= edad));
  if (exacto) return Number(exacto.bonos) || 0;
  const abierto = lista.find((t) => t.edad_hasta === null || t.edad_hasta === undefined);
  return abierto ? Number(abierto.bonos) || 0 : 0;
}

/**
 * Bonos que paga un acompañante.
 *  - es_afiliado = 1 → paga como afiliado (bonos_afiliado de la olimpiada).
 *  - bonos_manual = 1 → respeta el valor cargado por el staff.
 *  - si no, por edad al inicio del evento (tramos); sin fecha de nacimiento → tramo abierto (adulto).
 */
function calcularBonosAcompaniante(acompaniante, { tramos, bonosAfiliado, fechaReferencia }) {
  if (Number(acompaniante.bonos_manual) === 1 && Number.isSafeInteger(Number(acompaniante.bonos))) {
    return Math.max(0, Number(acompaniante.bonos));
  }
  if (Number(acompaniante.es_afiliado) === 1) return Math.max(0, Number(bonosAfiliado) || 0);
  const edad = calcularEdad(acompaniante.fecha_nacimiento, fechaReferencia);
  if (edad === null) return bonosPorEdad(tramos, Number.MAX_SAFE_INTEGER) ?? 0;
  return bonosPorEdad(tramos, edad) ?? 0;
}

// Valida una lista de tramos: enteros, sin solapamientos, a lo sumo un tramo abierto.
function validarTramos(tramos) {
  if (!Array.isArray(tramos) || tramos.length === 0) return { error: "Cargá al menos un tramo de edad" };
  const normalizados = [];
  for (const t of tramos) {
    const desde = normalizarEnteroNoNegativo(t.edad_desde);
    const hasta = t.edad_hasta === null || t.edad_hasta === undefined || t.edad_hasta === "" ? null : normalizarEnteroNoNegativo(t.edad_hasta);
    const bonos = normalizarEnteroNoNegativo(t.bonos);
    if (desde === null || hasta === undefined || bonos === null || (hasta !== null && hasta < desde)) {
      return { error: "Hay un tramo con edades o bonos inválidos" };
    }
    if (desde > 130 || (hasta !== null && hasta > 130) || bonos > 999) return { error: "Hay un tramo con valores fuera de rango" };
    normalizados.push({
      id: normalizarIdPositivo(t.id) || null,
      edad_desde: desde,
      edad_hasta: hasta,
      bonos,
      etiqueta: normalizarTexto(t.etiqueta, 60),
    });
  }
  normalizados.sort((a, b) => a.edad_desde - b.edad_desde);
  for (let i = 1; i < normalizados.length; i += 1) {
    const anterior = normalizados[i - 1];
    if (anterior.edad_hasta === null || anterior.edad_hasta >= normalizados[i].edad_desde) {
      return { error: `Los tramos se solapan alrededor de los ${normalizados[i].edad_desde} años` };
    }
  }
  return { value: normalizados.map((t, indice) => ({ ...t, orden: indice + 1 })) };
}

// Cantidad de dígitos para mostrar un número de bono (mínimo 4: "0460").
function digitosBono(olimpiada) {
  return Math.max(4, String(Number(olimpiada?.bono_numero_hasta) || 0).length);
}

function formatearNumeroBono(numero, olimpiada) {
  return String(numero).padStart(digitosBono(olimpiada), "0");
}

/**
 * Parsea números de bono desde texto libre: "12, 15-18 0460" → [12, 15, 16, 17, 18, 460].
 * Devuelve { value: number[] } (únicos, ordenados) o { error }.
 */
function parsearNumerosBono(texto, { maximo = 500 } = {}) {
  const fuente = Array.isArray(texto) ? texto.join(",") : String(texto ?? "");
  const partes = fuente.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  const numeros = new Set();
  for (const parte of partes) {
    const rango = /^(\d{1,6})\s*[-–]\s*(\d{1,6})$/.exec(parte);
    if (rango) {
      const desde = Number(rango[1]);
      const hasta = Number(rango[2]);
      if (hasta < desde) return { error: `El rango ${parte} está invertido` };
      if (hasta - desde + 1 > maximo) return { error: `El rango ${parte} supera los ${maximo} números por operación` };
      for (let n = desde; n <= hasta; n += 1) numeros.add(n);
    } else if (/^\d{1,6}$/.test(parte)) {
      numeros.add(Number(parte));
    } else {
      return { error: `"${parte}" no es un número de bono válido` };
    }
    if (numeros.size > maximo) return { error: `Se pueden cargar hasta ${maximo} números por operación` };
  }
  if (numeros.size === 0) return { error: "Indicá al menos un número de bono" };
  return { value: [...numeros].sort((a, b) => a - b) };
}

// Bloques: { departamental_id, numero_desde, numero_hasta }. Detecta solapamientos entre sí.
function bloquesSeSolapan(a, b) {
  return Number(a.numero_desde) <= Number(b.numero_hasta) && Number(b.numero_desde) <= Number(a.numero_hasta);
}

function bloqueDeNumero(bloques, numero) {
  return (bloques || []).find((b) => Number(b.numero_desde) <= numero && numero <= Number(b.numero_hasta)) || null;
}

/**
 * Resultado del sorteo: para cada premio con número, busca el bono vendido. Un número repetido
 * en un premio posterior queda vacante ("por repetirse"); un número sin bono vendido queda vacante.
 * premios: [{ id, orden, descripcion, sorteo, numero_ganador }], bonosPorNumero: Map<numero, bono>
 */
function calcularGanadores(premios, bonosPorNumero) {
  const vistos = new Set();
  return [...(premios || [])]
    .sort((a, b) => Number(a.orden) - Number(b.orden) || Number(a.id) - Number(b.id))
    .map((premio) => {
      const numero = premio.numero_ganador === null || premio.numero_ganador === undefined ? null : Number(premio.numero_ganador);
      if (numero === null || Number.isNaN(numero)) {
        return { ...premio, numero_ganador: null, estado: "SIN_SORTEAR", bono: null, motivo_vacante: null };
      }
      if (vistos.has(numero)) {
        return { ...premio, numero_ganador: numero, estado: "VACANTE", bono: null, motivo_vacante: "Número repetido" };
      }
      vistos.add(numero);
      const bono = bonosPorNumero instanceof Map ? bonosPorNumero.get(numero) : (bonosPorNumero || {})[numero];
      if (!bono) {
        return { ...premio, numero_ganador: numero, estado: "VACANTE", bono: null, motivo_vacante: "Bono no vendido" };
      }
      return { ...premio, numero_ganador: numero, estado: "GANADO", bono, motivo_vacante: null };
    });
}

/**
 * Resumen de bonos de una inscripción (con BD): requeridos (manual o calculado), asignados,
 * faltantes, monto faltante y si está cubierta (bonos completos o planilla de descuento).
 */
async function resumenBonosInscripcion(db, inscripcion, olimpiada) {
  const [tramos] = await db.query(
    "SELECT id, edad_desde, edad_hasta, bonos, etiqueta FROM olimpiada_bono_tramo WHERE olimpiada_id = ? ORDER BY edad_desde",
    [olimpiada.id]
  );
  const [acompaniantes] = await db.query(
    `SELECT id, nombre, apellido, documento, fecha_nacimiento, vinculo, es_afiliado, bonos, bonos_manual, observacion
     FROM olimpiada_inscripcion_acompaniante WHERE inscripcion_id = ? ORDER BY id`,
    [inscripcion.id]
  );
  const [bonos] = await db.query(
    `SELECT b.id, b.numero, b.comprador_nombre, b.comprador_documento, b.a_nombre_departamental, b.departamental_id,
            d.nombre AS departamental_nombre, b.fecha_venta
     FROM olimpiada_bono b LEFT JOIN departamental d ON d.id = b.departamental_id
     WHERE b.inscripcion_id = ? ORDER BY b.numero`,
    [inscripcion.id]
  );
  const bonosAfiliado = Number(olimpiada.bonos_afiliado) || 0;
  const detalleAcompaniantes = acompaniantes.map((a) => ({
    ...a,
    edad: calcularEdad(a.fecha_nacimiento, olimpiada.fecha_inicio),
    bonos: calcularBonosAcompaniante(a, { tramos, bonosAfiliado, fechaReferencia: olimpiada.fecha_inicio }),
  }));
  const calculados = bonosAfiliado + detalleAcompaniantes.reduce((total, a) => total + a.bonos, 0);
  const manual = inscripcion.bonos_requeridos_manual === null || inscripcion.bonos_requeridos_manual === undefined
    ? null
    : Number(inscripcion.bonos_requeridos_manual);
  const requeridos = manual !== null ? manual : calculados;
  const asignados = bonos.length;
  const faltantes = Math.max(0, requeridos - asignados);
  const valorBono = Number(olimpiada.valor_bono) || 0;
  const planilla = Number(inscripcion.planilla_descuento) === 1;
  return {
    valor_bono: valorBono,
    bonos_afiliado: bonosAfiliado,
    requeridos,
    requeridos_calculados: calculados,
    requeridos_manual: manual,
    asignados,
    faltantes,
    monto_total: requeridos * valorBono,
    monto_faltante: faltantes * valorBono,
    planilla_descuento: planilla,
    planilla_monto: inscripcion.planilla_monto === null || inscripcion.planilla_monto === undefined ? null : Number(inscripcion.planilla_monto),
    planilla_cuotas: inscripcion.planilla_cuotas ?? null,
    planilla_observacion: inscripcion.planilla_observacion ?? null,
    cubiertos: faltantes === 0 || planilla,
    exigir_bonos_para_validar: Number(olimpiada.exigir_bonos_para_validar) === 1,
    lista: bonos.map((b) => ({ ...b, numero_texto: formatearNumeroBono(b.numero, olimpiada) })),
    acompaniantes: detalleAcompaniantes,
    tramos,
  };
}

module.exports = {
  // s3 / archivos
  s3,
  bucketName,
  uploadBufferToS3,
  deleteFromS3,
  eliminarObjetosS3Seguro,
  getObjectBufferFromS3,
  getSignedFileUrlFromS3,
  firmarSeguro,
  detectarMimeArchivo,
  validarContenidoArchivo,
  decodificarFirmaBase64,
  extensionSegura,
  subirArchivoOlimpiadas,
  subirFirmaBase64,
  procesarImagenWeb,
  subirImagenOptimizada,
  crearUploadOlimpiadas,
  manejarUploadOlimpiadas,
  MIME_IMAGEN_PERMITIDO,
  MAX_ARCHIVO_OLIMPIADAS_BYTES,
  // auth
  verifyToken,
  getCabecera,
  ROLES_GESTION,
  ROLES_SUPERIORES,
  esStaff,
  esSuperior,
  esAdmin,
  departamentalDe,
  puedeVerInscripcion,
  // normalización
  crearErrorHttp,
  responderError,
  normalizarTexto,
  normalizarIdPositivo,
  normalizarEnteroNoNegativo,
  normalizarMonto,
  normalizarBooleano01,
  idsPositivosIguales,
  normalizarCupo,
  parseJsonSeguro,
  normalizarIds,
  normalizarHora,
  normalizarUrl,
  fechaHoyBuenosAires,
  estaVentanaInscripcionAbierta,
  // estados
  ESTADOS_INSCRIPCION,
  ESTADOS_ACTIVOS,
  SQL_ESTADOS_ACTIVOS,
  // historial / notificaciones
  registrarHistorial,
  insertarNotificacion,
  notificarStaffOlimpiadas,
  notificarInscriptosOlimpiada,
  // olimpiada
  obtenerOlimpiada,
  sembrarContenidoInicialOlimpiada,
  // bonos
  calcularEdad,
  bonosPorEdad,
  calcularBonosAcompaniante,
  validarTramos,
  digitosBono,
  formatearNumeroBono,
  parsearNumerosBono,
  bloquesSeSolapan,
  bloqueDeNumero,
  calcularGanadores,
  resumenBonosInscripcion,
};
