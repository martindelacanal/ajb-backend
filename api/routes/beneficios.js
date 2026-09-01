/**
 * MÓDULO BENEFICIOS (convenios con empresas e instituciones)
 *
 * El staff (departamental / admin / admin-central) carga beneficios. Lo que carga una
 * departamental queda Pendiente hasta que administración lo aprueba; en el medio puede
 * quedar Observado, con un hilo de mensajes entre ambos. La publicación se segmenta por
 * departamentales. El afiliado ve tarjetas, se inscribe (correo + notificación con el
 * mensaje predefinido del beneficio) y la inscripción aparece en "Mis gestiones" con el
 * código B-<inscripción>. Si el beneficio tiene correo de aviso, la entidad recibe los
 * datos del afiliado; si ese aviso falla, la inscripción queda marcada con error de
 * comunicación para reenviar o resolver desde el back-office. Todo queda en
 * beneficio_historial.
 *
 * Flujo de estados del beneficio:
 *  1 Pendiente de aprobación -> propuesta de una departamental
 *  2 Observado               -> administración pidió ajustes (chat)
 *  3 Aprobado                -> publicado (si está habilitado y vigente)
 *  4 Rechazado
 *
 * Inscripción: 1 Inscripto / 2 Cancelada (libera cupo y permite reinscribirse).
 */
const express = require("express");
const router = express.Router();
const mysqlConnection = require("../connection/connection");
const { registrarErrorRuta } = require("../services/errores");
const jwt = require("jsonwebtoken");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const multer = require("multer");
const crypto = require("crypto");
const sharp = require("sharp");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { normalizarFechaCivil } = require("../services/valores-dominio");
const { esDniValido, DNI_MENSAJE } = require("../security/dni");
const { esCorreoValido } = require("../services/correo/config");
const {
  construirCorreoHtml,
  enviarCorreo,
  enviarCorreoPlantilla,
  textoPlanoDesdeHtml,
  urlAplicacion,
} = require("../services/correo");

// ---------------------------------------------------------------------------
// S3 (prefijo beneficios/)
// ---------------------------------------------------------------------------
const bucketName = process.env.BUCKET_NAME;
const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  region: process.env.BUCKET_REGION,
});
const s3SignedUrlExpiresConfigurado = Number(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || "3600");
const S3_SIGNED_URL_EXPIRES_SECONDS = Number.isSafeInteger(s3SignedUrlExpiresConfigurado)
  && s3SignedUrlExpiresConfigurado >= 60
  && s3SignedUrlExpiresConfigurado <= 86400
  ? s3SignedUrlExpiresConfigurado
  : 3600;
// Las imágenes embebidas en el correo de inscripción se firman por un día entero
const EXPIRACION_URL_CORREO_SEGUNDOS = 86400;

async function uploadBufferToS3({ key, buffer, contentType }) {
  await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: buffer, ContentType: contentType }));
}

async function deleteFileFromS3(key) {
  if (!key) return;
  await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

async function eliminarObjetosS3Seguro(keys) {
  for (const key of [...new Set((keys || []).filter(Boolean))]) {
    try {
      await deleteFileFromS3(key);
    } catch (error) {
      console.error("No se pudo eliminar un archivo de beneficios en S3", {
        key,
        code: error?.name || error?.code || "UNKNOWN",
      });
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

async function getSignedFileUrlFromS3(key, expiresIn = S3_SIGNED_URL_EXPIRES_SECONDS) {
  if (!key) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: key }), {
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : S3_SIGNED_URL_EXPIRES_SECONDS,
  });
}

// Firma tolerante: una key rota nunca tumba un listado
function firmarSeguro(key, expiresIn) {
  return getSignedFileUrlFromS3(key, expiresIn).catch(() => null);
}

const EXTENSION_POR_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MIMES_IMAGEN = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
// El formulario de adhesión firmado puede llegar como PDF, Word o como foto (JPG/PNG/WebP).
const MIMES_CONVENIO = new Set(["application/pdf", MIME_DOCX, "image/jpeg", "image/jpg", "image/png", "image/webp"]);

function normalizarMimeImagen(mime) {
  if (mime === "image/jpg") return "image/jpeg";
  return MIMES_IMAGEN.has(mime) ? mime : null;
}

// Patrón contenidoCoincideConMime (noticias.js): el contenido real tiene que
// coincidir con el tipo declarado por el navegador.
function contenidoCoincideConMime(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  switch (file.mimetype) {
    case "image/jpeg":
    case "image/jpg":
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/png":
      return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    case "application/pdf":
      return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    case MIME_DOCX:
      return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    default:
      return false;
  }
}

async function subirArchivoBeneficio({ buffer, contentType, extension }, prefijo) {
  const key = `beneficios/${prefijo}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${extension}`;
  await uploadBufferToS3({ key, buffer, contentType });
  return key;
}

function extensionSegura(nombre, mime) {
  if (EXTENSION_POR_MIME[mime]) return EXTENSION_POR_MIME[mime];
  const partes = String(nombre || "").split(".");
  const ext = partes.length > 1 ? partes.pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  return ext || "bin";
}

// ---------------------------------------------------------------------------
// Imágenes: validación y redimensión con sharp (conserva el formato original)
// ---------------------------------------------------------------------------
const MAX_PIXELES_ENTRADA = 25_000_000;
const ANCHO_MINIMO_GALERIA = 400;
const ANCHO_MAXIMO_GALERIA = 1920;
const ANCHO_MAXIMO_LOGO = 640;
const ANCHO_MAXIMO_PIN = 160;
const ANCHO_MAXIMO_EDITOR = 1600;

const FORMATOS_IMAGEN = Object.freeze({
  "image/jpeg": Object.freeze({ extension: "jpg", sharpFormat: "jpeg" }),
  "image/png": Object.freeze({ extension: "png", sharpFormat: "png" }),
  "image/webp": Object.freeze({ extension: "webp", sharpFormat: "webp" }),
});

function crearErrorHttp(mensaje, statusCode = 400) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  return error;
}

function aplicarFormato(pipeline, mime) {
  if (mime === "image/jpeg") return pipeline.jpeg({ quality: 84, mozjpeg: true });
  if (mime === "image/png") return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  return pipeline.webp({ quality: 84, effort: 4 });
}

/**
 * Valida una imagen subida y, si supera el ancho máximo, la reduce conservando
 * el formato. Devuelve { buffer, contentType, extension } listo para subir.
 * Lanza errores con statusCode 400/422 y mensaje apto para el usuario.
 */
async function procesarImagenBeneficio(file, { anchoMinimo = 0, anchoMaximo = null, etiqueta = "La imagen" } = {}) {
  const mime = normalizarMimeImagen(file?.mimetype);
  if (!mime || !Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) {
    throw crearErrorHttp(`${etiqueta} no tiene un formato permitido (JPG, PNG o WebP)`);
  }
  let metadata;
  try {
    metadata = await sharp(file.buffer, {
      failOn: "error",
      limitInputPixels: MAX_PIXELES_ENTRADA,
      sequentialRead: true,
    }).metadata();
  } catch (_error) {
    throw crearErrorHttp(`${etiqueta} está dañada o excede el límite de píxeles`);
  }
  if ((metadata.pages || 1) !== 1) throw crearErrorHttp(`${etiqueta}: no se admiten imágenes animadas o multipágina`);
  if (FORMATOS_IMAGEN[mime].sharpFormat !== metadata.format) {
    throw crearErrorHttp(`${etiqueta}: el contenido no coincide con el formato declarado`);
  }
  // Con orientación EXIF 5..8 la foto se ve rotada: el ancho visible es el alto del archivo
  const rotada = [5, 6, 7, 8].includes(Number(metadata.orientation));
  const ancho = Number(rotada ? metadata.height : metadata.width) || 0;
  if (anchoMinimo > 0 && ancho < anchoMinimo) {
    throw crearErrorHttp(`${etiqueta} tiene ${ancho}px de ancho: se necesitan al menos ${anchoMinimo}px`);
  }

  let buffer = file.buffer;
  if (anchoMaximo && ancho > anchoMaximo) {
    try {
      buffer = await aplicarFormato(
        sharp(file.buffer, { failOn: "error", limitInputPixels: MAX_PIXELES_ENTRADA, sequentialRead: true })
          .rotate()
          .resize({ width: anchoMaximo, withoutEnlargement: true }),
        mime
      ).toBuffer();
    } catch (_error) {
      throw crearErrorHttp(`${etiqueta} no se pudo procesar`, 422);
    }
  }
  return { buffer, contentType: mime, extension: FORMATOS_IMAGEN[mime].extension };
}

// ---------------------------------------------------------------------------
// Multer (memoria). Formulario del beneficio: logo + galería + convenio + pines.
// ---------------------------------------------------------------------------
const MAX_ARCHIVO_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_IMAGENES_GALERIA_POR_GUARDADO = 8;
const MAX_PINES_POR_GUARDADO = 20;
const MAX_IMAGENES_GALERIA = 24;

const uploadBeneficio = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1 + MAX_IMAGENES_GALERIA_POR_GUARDADO + 1 + MAX_PINES_POR_GUARDADO, fileSize: MAX_ARCHIVO_BYTES },
  fileFilter: (req, file, cb) => {
    if (["logo", "galeria", "pines_imagenes"].includes(file.fieldname)) {
      if (!MIMES_IMAGEN.has(file.mimetype)) return cb(new Error("Las imágenes tienen que ser JPG, PNG o WebP"));
      return cb(null, true);
    }
    if (file.fieldname === "convenio") {
      if (!MIMES_CONVENIO.has(file.mimetype)) return cb(new Error("El convenio tiene que ser un PDF, un Word (.docx) o una foto (JPG, PNG o WebP)"));
      return cb(null, true);
    }
    return cb(new Error("Campo de archivo no esperado"));
  },
}).fields([
  { name: "logo", maxCount: 1 },
  { name: "galeria", maxCount: MAX_IMAGENES_GALERIA_POR_GUARDADO },
  { name: "convenio", maxCount: 1 },
  { name: "pines_imagenes", maxCount: MAX_PINES_POR_GUARDADO },
]);

const uploadImagenEditor = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_ARCHIVO_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.fieldname !== "imagen") return cb(new Error("Campo de archivo no esperado"));
    if (!MIMES_IMAGEN.has(file.mimetype)) return cb(new Error("La imagen tiene que ser JPG, PNG o WebP"));
    return cb(null, true);
  },
}).single("imagen");

function archivosSubidos(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === "object") return Object.values(req.files).flat();
  return [];
}

function mensajeErrorMulter(error, porDefecto) {
  if (error?.code === "LIMIT_FILE_SIZE") return `Cada archivo puede pesar hasta ${Math.floor(MAX_ARCHIVO_BYTES / 1024 / 1024)} MB`;
  if (error?.code === "LIMIT_FILE_COUNT" || error?.code === "LIMIT_UNEXPECTED_FILE") {
    return "Se superó la cantidad de archivos permitida para un guardado";
  }
  return error?.message || porDefecto;
}

function validarContenidoArchivos(req, res, next) {
  const archivos = archivosSubidos(req);
  if (!archivos.every(contenidoCoincideConMime)) {
    return res.status(400).json("El contenido de un archivo no coincide con el formato declarado");
  }
  const totalBytes = archivos.reduce((total, file) => total + (Buffer.isBuffer(file?.buffer) ? file.buffer.length : 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return res.status(413).json(`Los archivos superan el límite total de ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)} MB`);
  }
  return next();
}

function manejarUploadBeneficio(req, res, next) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_BYTES + (2 * 1024 * 1024)) {
    return res.status(413).json("La solicitud supera el límite total permitido para archivos");
  }
  uploadBeneficio(req, res, (error) => {
    if (error) return res.status(400).json(mensajeErrorMulter(error, "No se pudieron procesar los archivos"));
    return validarContenidoArchivos(req, res, next);
  });
}

function manejarUploadImagenEditor(req, res, next) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVO_BYTES + (1024 * 1024)) {
    return res.status(413).json(`La imagen puede pesar hasta ${Math.floor(MAX_ARCHIVO_BYTES / 1024 / 1024)} MB`);
  }
  uploadImagenEditor(req, res, (error) => {
    if (error) return res.status(400).json(mensajeErrorMulter(error, "No se pudo procesar la imagen"));
    return validarContenidoArchivos(req, res, next);
  });
}

// ---------------------------------------------------------------------------
// Auth (sin gate por rol: el módulo lo usan staff y afiliados)
// ---------------------------------------------------------------------------
function verifyToken(req, res, next) {
  return verificarTokenConAutorizacionActual({
    req,
    res,
    next,
    jwt,
    jwtSecret: process.env.JWT_SECRET,
    db: mysqlConnection.promise(),
    mensajeAuthorization: "Se requiere Authorization: Bearer <token>",
  });
}

function getCabecera(req) {
  return JSON.parse(req.data.data);
}

const ROLES_STAFF = ["admin", "admin-central", "departamental"];
const ROLES_SUPERIORES = ["admin", "admin-central"];

// ---------------------------------------------------------------------------
// Estados y permisos
// ---------------------------------------------------------------------------
const ESTADO = {
  PENDIENTE: 1,
  OBSERVADO: 2,
  APROBADO: 3,
  RECHAZADO: 4,
};

const ESTADO_INSCRIPCION = {
  INSCRIPTO: 1,
  CANCELADA: 2,
};

const ESTADOS_AVISO_ENTIDAD = ["NO_APLICA", "ENVIADO", "ERROR", "RESUELTO"];

function esSuperior(cabecera) {
  return ROLES_SUPERIORES.includes(cabecera?.rol);
}

// Departamental dueña: la que propuso el beneficio (beneficio.departamental_id)
function esDepartamentalDuenia(cabecera, beneficio) {
  if (cabecera?.rol !== "departamental") return false;
  return idsPositivosIguales(beneficio?.departamental_id, cabecera.departamental_id);
}

// La fila tiene que traer `incluye_departamental` (EXISTS sobre beneficio_departamental
// para la departamental del usuario) cuando quien consulta es una departamental.
// Una departamental que no es dueña solo ve (en modo lectura) los beneficios ya APROBADOS
// que la incluyen: las propuestas de otras departamentales son privadas hasta publicarse.
function puedeVerBeneficio(cabecera, beneficio) {
  if (esSuperior(cabecera)) return true;
  if (cabecera?.rol !== "departamental") return false;
  if (esDepartamentalDuenia(cabecera, beneficio)) return true;
  if (Number(beneficio?.estado_id) !== ESTADO.APROBADO) return false;
  return normalizarBooleano(beneficio?.alcance_todas) === 1 || normalizarBooleano(beneficio?.incluye_departamental) === 1;
}

// Acceso completo (datos internos, chat, historial, convenio): superiores y la dueña
function puedeVerDatosInternos(cabecera, beneficio) {
  return esSuperior(cabecera) || esDepartamentalDuenia(cabecera, beneficio);
}

function puedeEditarBeneficio(cabecera, beneficio) {
  if (esSuperior(cabecera)) return true;
  return esDepartamentalDuenia(cabecera, beneficio)
    && [ESTADO.PENDIENTE, ESTADO.OBSERVADO].includes(Number(beneficio?.estado_id));
}

function puedeEliminarBeneficio(cabecera, beneficio) {
  if (esSuperior(cabecera)) return true;
  return esDepartamentalDuenia(cabecera, beneficio)
    && [ESTADO.PENDIENTE, ESTADO.OBSERVADO, ESTADO.RECHAZADO].includes(Number(beneficio?.estado_id));
}

// El chat del flujo de aprobación es entre administración y la departamental dueña
function puedeObservarBeneficio(cabecera, beneficio) {
  return esSuperior(cabecera) || esDepartamentalDuenia(cabecera, beneficio);
}

function transicionesDisponibles(cabecera, estadoId, esPropia) {
  const estado = Number(estadoId);
  switch (cabecera?.rol) {
    case "admin":
    case "admin-central":
      return ({
        [ESTADO.PENDIENTE]: [ESTADO.APROBADO, ESTADO.OBSERVADO, ESTADO.RECHAZADO],
        [ESTADO.OBSERVADO]: [ESTADO.APROBADO, ESTADO.RECHAZADO],
        [ESTADO.APROBADO]: [ESTADO.OBSERVADO],
        [ESTADO.RECHAZADO]: [ESTADO.PENDIENTE],
      })[estado] || [];
    case "departamental":
      // Reenviar a aprobación después de ajustar lo observado
      return esPropia && estado === ESTADO.OBSERVADO ? [ESTADO.PENDIENTE] : [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizarTexto(valor) {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  return texto.length > 0 ? texto : null;
}

function normalizarIdPositivo(valor) {
  if (typeof valor === "string") {
    const texto = valor.trim();
    if (!/^\d+$/.test(texto)) return null;
    valor = texto;
  } else if (typeof valor !== "number") {
    return null;
  }
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

function idsPositivosIguales(izquierda, derecha) {
  const idIzquierda = normalizarIdPositivo(izquierda);
  const idDerecha = normalizarIdPositivo(derecha);
  return idIzquierda !== null && idDerecha !== null && idIzquierda === idDerecha;
}

function normalizarEnteroPositivo(valor, { porDefecto, maximo } = {}) {
  if (valor === undefined || valor === null || valor === "") return porDefecto ?? null;
  const numero = normalizarIdPositivo(valor);
  if (numero === null || (Number.isSafeInteger(maximo) && numero > maximo)) return null;
  return numero;
}

function normalizarBooleano(valor) {
  return valor === true || valor === 1 || String(valor) === "1" || String(valor).toLowerCase() === "true" ? 1 : 0;
}

function normalizarBooleanoEntrada(valor) {
  if (valor === true || valor === 1 || valor === "1" || valor === "true") return 1;
  if (valor === false || valor === 0 || valor === "0" || valor === "false") return 0;
  return null;
}

// Flag opcional del formulario: ausente => valor por defecto; presente pero inválido => null
function normalizarFlag(valor, porDefecto) {
  if (valor === undefined || valor === null || valor === "") return porDefecto;
  return normalizarBooleanoEntrada(valor);
}

function normalizarFecha(texto) {
  return normalizarFechaCivil(texto);
}

function parseJsonSeguro(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "object") return valor;
  try {
    return JSON.parse(valor);
  } catch (e) {
    return null;
  }
}

function valorInformado(valor) {
  return valor !== undefined && valor !== null && !(typeof valor === "string" && valor.trim() === "");
}

// Lista de ids (array JSON, array nativo o CSV) -> ids únicos positivos; null si es inválida
function normalizarListaIds(valor, { maximoItems = 100 } = {}) {
  if (!valorInformado(valor)) return [];
  let items = valor;
  if (typeof valor === "string") {
    const parseado = parseJsonSeguro(valor);
    items = Array.isArray(parseado) ? parseado : valor.split(",");
  }
  if (!Array.isArray(items) || items.length > maximoItems) return null;
  const ids = items.map(normalizarIdPositivo);
  if (ids.some((id) => id === null)) return null;
  return [...new Set(ids)];
}

// DNI de titulares: texto libre ("12.345.678, 23456789 / 3456789") -> "12345678, 23456789, 3456789"
function normalizarDniTitulares(valor) {
  const texto = normalizarTexto(valor);
  if (!texto) return { value: null };
  if (texto.length > 200) return { error: "Los DNI de titulares son demasiado largos (máximo 200 caracteres)" };
  const sinPuntosDeMiles = texto.replace(/(?<=\d)\.(?=\d)/g, "");
  const partes = sinPuntosDeMiles.split(/[^0-9]+/).filter(Boolean);
  if (partes.length === 0) return { error: "Indicá los DNI de los titulares separados por coma" };
  if (partes.length > 10) return { error: "Se admiten hasta 10 DNI de titulares" };
  const invalidos = partes.filter((dni) => !esDniValido(dni));
  if (invalidos.length > 0) return { error: `DNI de titular inválido (${invalidos.join(", ")}): ${DNI_MENSAJE}` };
  return { value: [...new Set(partes)].join(", ") };
}

function normalizarEmailOpcional(valor, nombre) {
  const texto = normalizarTexto(valor);
  if (!texto) return { value: null };
  const email = texto.toLowerCase();
  if (email.length > 120 || !esCorreoValido(email)) return { error: `${nombre} no es un correo válido` };
  return { value: email };
}

function normalizarSitioWeb(valor) {
  const texto = normalizarTexto(valor);
  if (!texto) return { value: null };
  const conEsquema = /^https?:\/\//i.test(texto) ? texto : `https://${texto}`;
  if (conEsquema.length > 300) return { error: "El sitio web es demasiado largo (máximo 300 caracteres)" };
  try {
    const url = new URL(conEsquema);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) throw new Error("inválida");
  } catch (_error) {
    return { error: "El sitio web no es una dirección válida" };
  }
  return { value: conEsquema };
}

function normalizarCoordenada(valor, minimo, maximo) {
  if (!valorInformado(valor)) return { value: null };
  const numero = typeof valor === "number" ? valor : Number(String(valor).trim().replace(",", "."));
  if (!Number.isFinite(numero) || numero < minimo || numero > maximo) return { error: true };
  return { value: Number(numero.toFixed(8)) };
}

/**
 * Sucursales del formulario: JSON `[{id?, direccion, latitud?, longitud?, etiqueta?, imagen_index?, quitar_imagen?}]`.
 * imagen_index apunta al array `pines_imagenes` del multipart.
 */
function normalizarSucursales(valor, { cantidadPines = 0, maximo = 50 } = {}) {
  if (!valorInformado(valor)) return { value: [] };
  const lista = Array.isArray(valor) ? valor : parseJsonSeguro(valor);
  if (!Array.isArray(lista)) return { error: "La lista de sucursales es inválida" };
  if (lista.length > maximo) return { error: `Se admiten hasta ${maximo} sucursales` };
  const salida = [];
  const indicesUsados = new Set();
  const idsUsados = new Set();
  for (let i = 0; i < lista.length; i++) {
    const item = lista[i] && typeof lista[i] === "object" ? lista[i] : {};
    const posicion = i + 1;
    const direccion = normalizarTexto(item.direccion);
    if (!direccion) return { error: `La sucursal ${posicion} necesita una dirección` };
    if (direccion.length > 200) return { error: `La dirección de la sucursal ${posicion} es demasiado larga (máximo 200 caracteres)` };
    const latitud = normalizarCoordenada(item.latitud, -90, 90);
    const longitud = normalizarCoordenada(item.longitud, -180, 180);
    if (latitud.error || longitud.error) return { error: `Las coordenadas de la sucursal ${posicion} están fuera de rango` };
    if ((latitud.value === null) !== (longitud.value === null)) {
      return { error: `La sucursal ${posicion} necesita latitud y longitud (o ninguna de las dos)` };
    }
    const etiqueta = normalizarTexto(item.etiqueta);
    if (etiqueta && etiqueta.length > 160) return { error: `La etiqueta del pin de la sucursal ${posicion} es demasiado larga (máximo 160 caracteres)` };
    let id = null;
    if (valorInformado(item.id)) {
      id = normalizarIdPositivo(item.id);
      if (id === null || idsUsados.has(id)) return { error: `El identificador de la sucursal ${posicion} es inválido` };
      idsUsados.add(id);
    }
    let imagenIndex = null;
    if (valorInformado(item.imagen_index)) {
      const indice = Number(item.imagen_index);
      if (!Number.isSafeInteger(indice) || indice < 0 || indice >= cantidadPines || indicesUsados.has(indice)) {
        return { error: `La imagen del pin de la sucursal ${posicion} no coincide con los archivos enviados` };
      }
      indicesUsados.add(indice);
      imagenIndex = indice;
    }
    salida.push({
      id,
      direccion,
      latitud: latitud.value,
      longitud: longitud.value,
      etiqueta,
      imagen_index: imagenIndex,
      quitar_imagen: normalizarBooleano(item.quitar_imagen),
      orden: i,
    });
  }
  return { value: salida };
}

function describirVigencia(beneficio) {
  const desde = beneficio?.fecha_vigencia_desde ? formatearFechaCivil(beneficio.fecha_vigencia_desde) : null;
  const hasta = beneficio?.fecha_vigencia_hasta ? formatearFechaCivil(beneficio.fecha_vigencia_hasta) : null;
  if (desde && hasta) return `Del ${desde} al ${hasta}`;
  if (hasta) return `Hasta el ${hasta}`;
  if (desde) return `Desde el ${desde}`;
  return null;
}

// 'YYYY-MM-DD' (dateStrings del pool) -> 'DD/MM/YYYY'
function formatearFechaCivil(valor) {
  const fecha = normalizarFechaCivil(valor);
  if (!fecha) return null;
  const [anio, mes, dia] = fecha.split("-");
  return `${dia}/${mes}/${anio}`;
}

function calcularCupo(cupoMaximo, inscriptos) {
  const maximo = normalizarIdPositivo(cupoMaximo);
  const cantidad = Number(inscriptos) || 0;
  if (maximo === null) return { maximo: null, inscriptos: cantidad, restantes: null, pocos: false, completo: false };
  const restantes = Math.max(0, maximo - cantidad);
  return {
    maximo,
    inscriptos: cantidad,
    restantes,
    pocos: restantes > 0 && restantes <= Math.max(5, Math.ceil(maximo * 0.15)),
    completo: restantes === 0,
  };
}

// ---------------------------------------------------------------------------
// Sanitizado del HTML del editor (promocion_html y mensaje_inscripcion_html)
// Lista blanca de etiquetas; los atributos se descartan salvo los enumerados.
// Las imágenes se guardan solo con su key S3 (data-archivo): la URL firmada se
// agrega al renderizar. Los div[data-embed] los transforma el front en iframes.
// ---------------------------------------------------------------------------
const MAX_LARGO_HTML = 200 * 1024;
const ETIQUETAS_HTML_PERMITIDAS = new Set([
  "p", "br", "h2", "h3", "strong", "b", "em", "i", "u", "s",
  "ul", "ol", "li", "a", "span", "img", "div", "blockquote",
]);
const ETIQUETAS_SIN_CIERRE = new Set(["br", "img"]);
const COLOR_CSS_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\))$/i;
const ALINEACIONES_PERMITIDAS = new Set(["left", "center", "right", "justify"]);
const KEY_IMAGEN_EDITOR_RE = /^beneficios\/[A-Za-z0-9_./-]{1,240}$/;
const EMBEDS_PERMITIDOS = new Set(["youtube", "instagram"]);
const REF_EMBED_RE = /^[A-Za-z0-9_-]{1,60}$/;

function leerAtributo(interior, nombre) {
  const re = new RegExp(`(?:^|\\s)${nombre}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const coincidencia = re.exec(interior);
  if (!coincidencia) return null;
  return (coincidencia[1] ?? coincidencia[2] ?? coincidencia[3] ?? "").trim();
}

// Escapa para atributo sin duplicar entidades ya presentes
function escaparAtributo(valor) {
  return String(valor ?? "")
    .replace(/&(?!(?:amp|lt|gt|quot|#\d+);)/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function estilosPermitidos(style, propiedades) {
  const salida = [];
  for (const declaracion of String(style || "").split(";")) {
    const separador = declaracion.indexOf(":");
    if (separador < 0) continue;
    const propiedad = declaracion.slice(0, separador).trim().toLowerCase();
    const valor = declaracion.slice(separador + 1).trim().toLowerCase();
    if (!propiedades.includes(propiedad)) continue;
    const valido = propiedad === "text-align" ? ALINEACIONES_PERMITIDAS.has(valor) : COLOR_CSS_RE.test(valor);
    if (valido) salida.push(`${propiedad}:${valor.replace(/\s+/g, "")}`);
  }
  return salida.length > 0 ? ` style="${salida.join(";")}"` : "";
}

function sanitizarHtmlBeneficio(html) {
  if (typeof html !== "string") return null;
  let limpio = html.replace(
    /<\s*(script|style|iframe|object|embed|form|svg|math|template|textarea|noscript)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    ""
  );
  limpio = limpio.replace(/<!--[\s\S]*?-->/g, "");
  limpio = limpio.replace(/<([^>]*)>/g, (coincidencia, interior) => {
    const esCierre = /^\s*\//.test(interior);
    const nombre = interior.replace(/^\s*\/?\s*/, "").split(/[\s/>]/)[0].toLowerCase();
    if (!ETIQUETAS_HTML_PERMITIDAS.has(nombre)) return "";
    if (esCierre) return ETIQUETAS_SIN_CIERRE.has(nombre) ? "" : `</${nombre}>`;
    switch (nombre) {
      case "br":
        return "<br>";
      case "a": {
        const url = leerAtributo(interior, "href") || "";
        if (/^(https?:\/\/|mailto:)/i.test(url)) {
          return `<a href="${escaparAtributo(url)}" target="_blank" rel="noopener noreferrer">`;
        }
        return "<a>";
      }
      case "span":
        return `<span${estilosPermitidos(leerAtributo(interior, "style"), ["color", "background-color"])}>`;
      case "p":
      case "h2":
      case "h3":
        return `<${nombre}${estilosPermitidos(leerAtributo(interior, "style"), ["text-align"])}>`;
      case "img": {
        const key = leerAtributo(interior, "data-archivo") || "";
        if (!KEY_IMAGEN_EDITOR_RE.test(key)) return "";
        const alt = (leerAtributo(interior, "alt") || "").slice(0, 200);
        return `<img data-archivo="${escaparAtributo(key)}" alt="${escaparAtributo(alt)}">`;
      }
      case "div": {
        const embed = (leerAtributo(interior, "data-embed") || "").toLowerCase();
        const ref = leerAtributo(interior, "data-ref") || "";
        if (EMBEDS_PERMITIDOS.has(embed) && REF_EMBED_RE.test(ref)) {
          return `<div data-embed="${embed}" data-ref="${ref}">`;
        }
        return "<div>";
      }
      default:
        return `<${nombre}>`;
    }
  });
  // Un "<" que no cierra (p. ej. `<a href=... style=...` al final, sin ">") no es un tag
  // para la pasada anterior pero sí lo sería para el navegador o el cliente de correo:
  // se escapa para que quede como texto.
  limpio = limpio.replace(/<(?![^<]*>)/g, "&lt;");
  const texto = limpio.trim();
  return texto.length > 0 ? texto : null;
}

// Valida largo + sanea. Devuelve { value } o { error }.
function normalizarHtmlBeneficio(valor, nombre) {
  if (!valorInformado(valor)) return { value: null };
  if (typeof valor !== "string") return { error: `${nombre} es inválido` };
  if (valor.length > MAX_LARGO_HTML) return { error: `${nombre} es demasiado largo (máximo 200 KB)` };
  const limpio = sanitizarHtmlBeneficio(valor);
  // Un HTML que quedó sin texto ni imágenes ni embebidos se guarda como vacío
  if (!limpio || (!textoPlanoDesdeHtml(limpio) && !/<(img|div data-embed)\b/i.test(limpio))) return { value: null };
  return { value: limpio };
}

// Keys S3 de las imágenes embebidas (para vincular beneficio_editor_imagen)
function extraerArchivosEditor(html) {
  const keys = new Set();
  const re = /<img\b[^>]*\bdata-archivo="([^"]+)"/gi;
  let coincidencia;
  while ((coincidencia = re.exec(String(html || "")))) {
    if (KEY_IMAGEN_EDITOR_RE.test(coincidencia[1])) keys.add(coincidencia[1]);
  }
  return [...keys];
}

/**
 * Render: reemplaza cada <img data-archivo="k"> por <img src="<firmada>" data-archivo="k">.
 * En modo correo, además convierte los embebidos en un link (los clientes de
 * correo no muestran iframes) y le da estilo en línea a las imágenes.
 */
async function renderizarHtmlBeneficio(html, { expiresIn = S3_SIGNED_URL_EXPIRES_SECONDS, paraCorreo = false } = {}) {
  if (!html) return null;
  const urls = new Map();
  for (const key of extraerArchivosEditor(html)) urls.set(key, await firmarSeguro(key, expiresIn));
  let salida = String(html).replace(/<img\b([^>]*)\bdata-archivo="([^"]+)"([^>]*)>/gi, (etiqueta, antes, key, despues) => {
    const url = urls.get(key);
    if (!url) return "";
    const alt = leerAtributo(`${antes} ${despues}`, "alt") || "";
    const estilo = paraCorreo ? ' style="max-width:100%;height:auto;display:block;margin:8px 0;"' : "";
    return `<img src="${escaparAtributo(url)}" data-archivo="${escaparAtributo(key)}" alt="${escaparAtributo(alt)}"${estilo}>`;
  });
  if (paraCorreo) {
    salida = salida.replace(
      /<div data-embed="(youtube|instagram)" data-ref="([A-Za-z0-9_-]{1,60})">[\s\S]*?<\/div>/gi,
      (etiqueta, tipo, ref) => {
        const url = tipo === "youtube" ? `https://www.youtube.com/watch?v=${ref}` : `https://www.instagram.com/p/${ref}/`;
        const texto = tipo === "youtube" ? "Ver el video en YouTube" : "Ver la publicación en Instagram";
        return `<p><a href="${url}" target="_blank" rel="noopener noreferrer">${texto}</a></p>`;
      }
    );
  }
  return salida;
}

// Resumen de texto plano (para historial y notificaciones)
function resumenHtml(html, maximo = 120) {
  const texto = textoPlanoDesdeHtml(html || "").replace(/\s+/g, " ").trim();
  if (!texto) return null;
  return texto.length > maximo ? `${texto.slice(0, maximo - 1)}…` : texto;
}

// ---------------------------------------------------------------------------
// Validación del formulario del beneficio (POST y PUT comparten)
// ---------------------------------------------------------------------------
async function validarDatosBeneficio(db, body, { cantidadPines = 0 } = {}) {
  const errores = [];
  const datos = {};
  body = body && typeof body === "object" ? body : {};

  datos.nombre = normalizarTexto(body.nombre);
  if (!datos.nombre || datos.nombre.length < 2) errores.push("El nombre del beneficio es obligatorio (mínimo 2 caracteres)");
  else if (datos.nombre.length > 160) errores.push("El nombre es demasiado largo (máximo 160 caracteres)");

  datos.razon_social = normalizarTexto(body.razon_social);
  if (datos.razon_social && datos.razon_social.length > 160) errores.push("La razón social es demasiado larga (máximo 160 caracteres)");

  datos.rubro_id = normalizarIdPositivo(body.rubro_id);
  if (!datos.rubro_id) {
    errores.push("Elegí un rubro");
  } else {
    const [rubros] = await db.query("SELECT id, nombre FROM beneficio_rubro WHERE id = ? AND habilitado = 1", [datos.rubro_id]);
    if (rubros.length === 0) errores.push("El rubro elegido no existe");
    else datos.rubro_nombre = rubros[0].nombre;
  }

  datos.descripcion_corta = normalizarTexto(body.descripcion_corta);
  if (datos.descripcion_corta && datos.descripcion_corta.length > 300) errores.push("La descripción corta es demasiado larga (máximo 300 caracteres)");

  const promocion = normalizarHtmlBeneficio(body.promocion_html, "El texto de la promoción");
  if (promocion.error) errores.push(promocion.error);
  datos.promocion_html = promocion.value ?? null;

  datos.telefono = normalizarTexto(body.telefono);
  if (datos.telefono && datos.telefono.length > 30) errores.push("El teléfono es demasiado largo (máximo 30 caracteres)");
  datos.telefono_visible = normalizarFlag(body.telefono_visible, 0);
  if (datos.telefono_visible === null) errores.push("El indicador de teléfono visible es inválido");

  const sitioWeb = normalizarSitioWeb(body.sitio_web);
  if (sitioWeb.error) errores.push(sitioWeb.error);
  datos.sitio_web = sitioWeb.value ?? null;
  datos.sitio_web_visible = normalizarFlag(body.sitio_web_visible, 1);
  if (datos.sitio_web_visible === null) errores.push("El indicador de sitio web visible es inválido");

  const emailContacto = normalizarEmailOpcional(body.email_contacto, "El email de contacto");
  if (emailContacto.error) errores.push(emailContacto.error);
  datos.email_contacto = emailContacto.value ?? null;
  datos.email_contacto_visible = normalizarFlag(body.email_contacto_visible, 0);
  if (datos.email_contacto_visible === null) errores.push("El indicador de email visible es inválido");

  const dniTitulares = normalizarDniTitulares(body.dni_titulares);
  if (dniTitulares.error) errores.push(dniTitulares.error);
  datos.dni_titulares = dniTitulares.value ?? null;

  datos.cupo_maximo = null;
  if (valorInformado(body.cupo_maximo)) {
    datos.cupo_maximo = normalizarEnteroPositivo(body.cupo_maximo, { maximo: 1_000_000 });
    if (datos.cupo_maximo === null) errores.push("El cupo máximo tiene que ser un número entero mayor a cero");
  }

  datos.mostrar_mapa = normalizarFlag(body.mostrar_mapa, 0);
  if (datos.mostrar_mapa === null) errores.push("El indicador de mostrar mapa es inválido");

  datos.fecha_vigencia_desde = null;
  if (valorInformado(body.fecha_vigencia_desde)) {
    datos.fecha_vigencia_desde = normalizarFecha(body.fecha_vigencia_desde);
    if (!datos.fecha_vigencia_desde) errores.push("La fecha de vigencia desde es inválida");
  }
  datos.fecha_vigencia_hasta = null;
  if (valorInformado(body.fecha_vigencia_hasta)) {
    datos.fecha_vigencia_hasta = normalizarFecha(body.fecha_vigencia_hasta);
    if (!datos.fecha_vigencia_hasta) errores.push("La fecha de vigencia hasta es inválida");
  }
  if (datos.fecha_vigencia_desde && datos.fecha_vigencia_hasta && datos.fecha_vigencia_desde > datos.fecha_vigencia_hasta) {
    errores.push("La vigencia desde no puede ser posterior a la vigencia hasta");
  }

  datos.habilitado = normalizarFlag(body.habilitado, 1);
  if (datos.habilitado === null) errores.push("El indicador de habilitado es inválido");
  datos.tarjeta_usa_logo = normalizarFlag(body.tarjeta_usa_logo, 0);
  if (datos.tarjeta_usa_logo === null) errores.push("Indicá qué muestra la tarjeta (galería o logo)");

  const emailAviso = normalizarEmailOpcional(body.email_aviso_inscripcion, "El email de aviso a la entidad");
  if (emailAviso.error) errores.push(emailAviso.error);
  datos.email_aviso_inscripcion = emailAviso.value ?? null;

  const mensajeInscripcion = normalizarHtmlBeneficio(body.mensaje_inscripcion_html, "El mensaje automático de inscripción");
  if (mensajeInscripcion.error) errores.push(mensajeInscripcion.error);
  datos.mensaje_inscripcion_html = mensajeInscripcion.value ?? null;

  datos.alcance_todas = normalizarFlag(body.alcance_todas, 0);
  if (datos.alcance_todas === null) errores.push("El indicador de alcance es inválido");

  datos.departamentales = normalizarListaIds(body.departamentales, { maximoItems: 100 });
  if (datos.departamentales === null) {
    errores.push("La lista de departamentales es inválida");
    datos.departamentales = [];
  } else if (datos.departamentales.length > 0) {
    const [deps] = await db.query(
      `SELECT id FROM departamental WHERE habilitado = 'Y' AND id IN (${datos.departamentales.map(() => "?").join(",")})`,
      datos.departamentales
    );
    if (deps.length !== datos.departamentales.length) errores.push("Alguna de las departamentales elegidas no existe");
  }

  // Departamental dueña opcional (solo la usan admin / admin-central)
  datos.departamental_id = null;
  if (valorInformado(body.departamental_id)) {
    datos.departamental_id = normalizarIdPositivo(body.departamental_id);
    if (!datos.departamental_id) {
      errores.push("La departamental dueña es inválida");
    } else {
      const [deps] = await db.query("SELECT id FROM departamental WHERE id = ? AND habilitado = 'Y'", [datos.departamental_id]);
      if (deps.length === 0) errores.push("La departamental dueña no existe");
    }
  }

  const sucursales = normalizarSucursales(body.sucursales, { cantidadPines });
  if (sucursales.error) errores.push(sucursales.error);
  datos.sucursales = sucursales.value || [];

  return { errores, datos };
}

// ---------------------------------------------------------------------------
// Historial y notificaciones
// ---------------------------------------------------------------------------
const ETIQUETAS_CAMPOS = {
  nombre: "Nombre",
  razon_social: "Razón social",
  rubro_id: "Rubro",
  descripcion_corta: "Descripción corta",
  promocion_html: "Texto de la promoción",
  telefono: "Teléfono",
  telefono_visible: "Teléfono visible para el afiliado",
  sitio_web: "Sitio web",
  sitio_web_visible: "Sitio web visible para el afiliado",
  email_contacto: "Email de contacto",
  email_contacto_visible: "Email de contacto visible para el afiliado",
  dni_titulares: "DNI de titulares",
  cupo_maximo: "Cupo máximo",
  mostrar_mapa: "Mostrar mapa",
  fecha_vigencia_desde: "Vigencia desde",
  fecha_vigencia_hasta: "Vigencia hasta",
  habilitado: "Habilitado",
  tarjeta_usa_logo: "La tarjeta muestra el logo",
  email_aviso_inscripcion: "Email de aviso a la entidad",
  mensaje_inscripcion_html: "Mensaje automático de inscripción",
  alcance_todas: "Todas las departamentales",
  departamental_id: "Departamental dueña",
  departamentales: "Departamentales con acceso",
  sucursales: "Sucursales",
  logo: "Logo",
  convenio: "Convenio firmado",
  galeria: "Galería",
};

const CAMPOS_TEXTO_DIFF = [
  "nombre", "razon_social", "descripcion_corta", "telefono", "sitio_web", "email_contacto",
  "dni_titulares", "cupo_maximo", "fecha_vigencia_desde", "fecha_vigencia_hasta", "email_aviso_inscripcion",
];
const CAMPOS_BOOLEANOS_DIFF = [
  "telefono_visible", "sitio_web_visible", "email_contacto_visible", "mostrar_mapa", "habilitado",
  "tarjeta_usa_logo", "alcance_todas",
];
const CAMPOS_HTML_DIFF = ["promocion_html", "mensaje_inscripcion_html"];

async function registrarHistorial(connection, datos) {
  await connection.query(
    `INSERT INTO beneficio_historial
       (beneficio_id, inscripcion_id, usuario_id, usuario_rol, tipo_operacion, estado_anterior_id, estado_nuevo_id,
        campo_modificado, valor_anterior, valor_nuevo, observacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      datos.beneficio_id,
      datos.inscripcion_id || null,
      datos.usuario_id || null,
      datos.usuario_rol || null,
      datos.tipo_operacion,
      datos.estado_anterior_id || null,
      datos.estado_nuevo_id || null,
      datos.campo_modificado || null,
      datos.valor_anterior !== undefined && datos.valor_anterior !== null ? String(datos.valor_anterior) : null,
      datos.valor_nuevo !== undefined && datos.valor_nuevo !== null ? String(datos.valor_nuevo) : null,
      datos.observacion || null,
    ]
  );
}

// notificacion.titulo es VARCHAR(180): con nombres de beneficio largos (hasta 160) el
// título armado lo supera y, en modo estricto, tumbaría la transacción entera.
const TITULO_NOTIFICACION_MAX = 180;
function acotarTituloNotificacion(titulo) {
  const texto = String(titulo || "").trim();
  return texto.length > TITULO_NOTIFICACION_MAX ? `${texto.slice(0, TITULO_NOTIFICACION_MAX - 1)}…` : texto;
}

async function insertarNotificacion(connection, usuarioId, tipo, titulo, mensaje, payload) {
  await connection.query(
    `INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)`,
    [usuarioId, tipo, acotarTituloNotificacion(titulo), mensaje, JSON.stringify(payload || {})]
  );
}

// Equipo de una departamental (rol departamental, habilitados), salvo el autor
async function notificarUsuariosDepartamental(connection, departamentalId, tipo, titulo, mensaje, payload, excluirUsuarioId) {
  if (!normalizarIdPositivo(departamentalId)) return;
  const [usuarios] = await connection.query(
    `SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
     WHERE r.nombre = 'departamental' AND u.departamental_id = ? AND u.habilitado = 'Y'`,
    [normalizarIdPositivo(departamentalId)]
  );
  for (const u of usuarios) {
    if (idsPositivosIguales(u.id, excluirUsuarioId)) continue;
    await insertarNotificacion(connection, u.id, tipo, titulo, mensaje, payload);
  }
}

// admin + admin-central habilitados, salvo el autor
async function notificarSuperiores(connection, tipo, titulo, mensaje, payload, excluirUsuarioId) {
  const [usuarios] = await connection.query(
    `SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
     WHERE r.nombre IN (${ROLES_SUPERIORES.map(() => "?").join(",")}) AND u.habilitado = 'Y'`,
    ROLES_SUPERIORES
  );
  for (const u of usuarios) {
    if (idsPositivosIguales(u.id, excluirUsuarioId)) continue;
    await insertarNotificacion(connection, u.id, tipo, titulo, mensaje, payload);
  }
}

// Nombre de la departamental (para títulos de notificaciones)
async function nombreDepartamental(connection, departamentalId) {
  if (!normalizarIdPositivo(departamentalId)) return null;
  const [rows] = await connection.query("SELECT nombre FROM departamental WHERE id = ?", [normalizarIdPositivo(departamentalId)]);
  return rows.length > 0 ? rows[0].nombre : null;
}

// Vincula las imágenes del editor presentes en los HTML con el beneficio (no borra nada)
async function vincularImagenesEditor(connection, beneficioId, htmls) {
  const keys = [...new Set(htmls.flatMap((html) => extraerArchivosEditor(html)))];
  if (keys.length === 0) return;
  await connection.query(
    `UPDATE beneficio_editor_imagen SET beneficio_id = ?
     WHERE archivo IN (${keys.map(() => "?").join(",")}) AND (beneficio_id IS NULL OR beneficio_id = ?)`,
    [beneficioId, ...keys, beneficioId]
  );
}

// ---------------------------------------------------------------------------
// Correo (siempre POST-commit; enviarCorreo / enviarCorreoPlantilla nunca lanzan)
// ---------------------------------------------------------------------------
const MARCADOR_MENSAJE_CORREO = "%%MENSAJE_BENEFICIO%%";
const FUENTE_CORREO = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MENSAJE_INSCRIPCION_POR_DEFECTO = "Tu inscripción quedó registrada. La institución fue notificada de tu interés.";

function describirMotivoCorreo(resultado) {
  switch (resultado?.motivo) {
    case "sin_configurar": return "El correo saliente no está configurado en el servidor";
    case "deshabilitado": return "El envío de correo está deshabilitado en el servidor";
    case "destino_pruebas_invalido": return "Modo de pruebas de correo sin casilla de redirección";
    case "destinatario_invalido": return "La dirección de correo de destino es inválida";
    case "asunto_invalido": return "El asunto del correo es inválido";
    case "cuerpo_vacio": return "El correo no tiene contenido";
    case "error_smtp": return `Error SMTP: ${resultado.error || "sin detalle"}`;
    default: return resultado?.motivo || resultado?.error || "Motivo desconocido";
  }
}

/**
 * Correo al afiliado que se inscribió. Si el beneficio tiene mensaje propio, el
 * HTML saneado (con imágenes firmadas a 24 h) entra en el shell de marca de la
 * plantilla reemplazando un párrafo marcador; si no, plantilla estándar.
 */
async function enviarCorreoInscripcionAfiliado({ beneficio, inscripcion, afiliado }) {
  const codigo = `B-${inscripcion.id}`;
  const asunto = `Inscripción al beneficio "${beneficio.nombre}" — Mi AJB`;
  const saludo = `Hola, ${afiliado.nombre}`;
  const datos = [
    { etiqueta: "Beneficio", valor: beneficio.nombre },
    { etiqueta: "Rubro", valor: beneficio.rubro_nombre || "—" },
    { etiqueta: "Código", valor: codigo },
  ];
  const vigencia = describirVigencia(beneficio);
  if (vigencia) datos.push({ etiqueta: "Vigencia", valor: vigencia });
  const boton = { texto: "Ver mis gestiones", url: urlAplicacion("/mis-gestiones") };
  const parrafoRegistro = `Tu inscripción al beneficio ${beneficio.nombre} quedó registrada con el código ${codigo}.`;

  if (!beneficio.mensaje_inscripcion_html) {
    return enviarCorreoPlantilla({
      para: afiliado.email,
      asunto,
      titulo: "Inscripción registrada",
      previsualizacion: parrafoRegistro,
      saludo,
      parrafos: [
        parrafoRegistro,
        "La institución fue notificada de tu interés y puede ponerse en contacto con vos.",
      ],
      datos,
      boton,
    });
  }

  const mensajeHtml = await renderizarHtmlBeneficio(beneficio.mensaje_inscripcion_html, {
    expiresIn: EXPIRACION_URL_CORREO_SEGUNDOS,
    paraCorreo: true,
  });
  const { html, texto, adjuntos } = construirCorreoHtml({
    titulo: "Inscripción registrada",
    previsualizacion: parrafoRegistro,
    saludo,
    parrafos: [parrafoRegistro, MARCADOR_MENSAJE_CORREO],
    datos,
    boton,
  });
  const bloqueMensaje = `<div style="margin:0 0 16px;font-family:${FUENTE_CORREO};font-size:16px;line-height:1.6;color:#3d566b;">${mensajeHtml}</div>`;
  const htmlFinal = html.replace(new RegExp(`<p[^>]*>${MARCADOR_MENSAJE_CORREO}</p>`), () => bloqueMensaje);
  const textoFinal = texto.replace(MARCADOR_MENSAJE_CORREO, () => textoPlanoDesdeHtml(mensajeHtml));
  return enviarCorreo({ para: afiliado.email, asunto, html: htmlFinal, texto: textoFinal, adjuntos });
}

// Correo a la entidad con los datos básicos del afiliado
async function enviarCorreoAvisoEntidad({ beneficio, inscripcion, afiliado, cantidadFamiliares }) {
  const parrafos = [
    `Un afiliado / una afiliada de la Asociación Judicial Bonaerense se inscribió al beneficio "${beneficio.nombre}" y quiere que se contacten.`,
  ];
  if (inscripcion.mensaje_afiliado) parrafos.push(`Mensaje: ${inscripcion.mensaje_afiliado}`);
  return enviarCorreoPlantilla({
    para: beneficio.email_aviso_inscripcion,
    asunto: `Nueva inscripción al beneficio "${beneficio.nombre}" — Mi AJB`,
    titulo: "Nueva inscripción a un beneficio",
    previsualizacion: `${afiliado.apellido}, ${afiliado.nombre} se inscribió al beneficio "${beneficio.nombre}"`,
    saludo: "Hola",
    parrafos,
    datos: [
      { etiqueta: "Nombre", valor: afiliado.nombre || "—" },
      { etiqueta: "Apellido", valor: afiliado.apellido || "—" },
      { etiqueta: "DNI", valor: afiliado.documento || "—" },
      { etiqueta: "CUIL", valor: afiliado.cuil || "—" },
      { etiqueta: "CBU", valor: afiliado.cbu || "—" },
      { etiqueta: "Teléfono", valor: afiliado.telefono || "—" },
      { etiqueta: "Email", valor: afiliado.email || "—" },
      { etiqueta: "Fecha de nacimiento", valor: formatearFechaCivil(afiliado.fecha_nacimiento) || "—" },
      { etiqueta: "Cantidad de familiares", valor: String(Number(cantidadFamiliares) || 0) },
    ],
    aviso: "Este correo se envió automáticamente desde Mi AJB por el convenio vigente con AJB. Ante dudas, respondé a este correo o contactá a la departamental correspondiente.",
  });
}

// Inscripción + beneficio + afiliado, con todo lo que necesitan los correos
async function obtenerInscripcionParaCorreo(db, inscripcionId) {
  const [rows] = await db.query(
    `SELECT bi.id, bi.beneficio_id, bi.usuario_id, bi.estado_id, bi.mensaje_afiliado,
            bi.aviso_entidad_estado, bi.aviso_entidad_error, bi.aviso_entidad_fecha,
            b.nombre AS beneficio_nombre, b.email_aviso_inscripcion, b.mensaje_inscripcion_html,
            b.fecha_vigencia_desde, b.fecha_vigencia_hasta, b.departamental_id AS beneficio_departamental_id,
            r.nombre AS rubro_nombre,
            u.nombre, u.apellido, u.documento, u.cuil, u.cbu, u.telefono, u.email, u.fecha_nacimiento,
            (SELECT COUNT(*) FROM usuario f WHERE f.usuario_familiar_id = u.id AND f.es_familiar = 'S') AS cantidad_familiares
     FROM beneficio_inscripcion bi
     INNER JOIN beneficio b ON b.id = bi.beneficio_id
     LEFT JOIN beneficio_rubro r ON r.id = b.rubro_id
     INNER JOIN usuario u ON u.id = bi.usuario_id
     WHERE bi.id = ?`,
    [inscripcionId]
  );
  if (rows.length === 0) return null;
  const fila = rows[0];
  return {
    inscripcion: {
      id: fila.id,
      beneficio_id: fila.beneficio_id,
      usuario_id: fila.usuario_id,
      estado_id: fila.estado_id,
      mensaje_afiliado: fila.mensaje_afiliado,
      aviso_entidad_estado: fila.aviso_entidad_estado,
    },
    beneficio: {
      id: fila.beneficio_id,
      nombre: fila.beneficio_nombre,
      rubro_nombre: fila.rubro_nombre,
      email_aviso_inscripcion: fila.email_aviso_inscripcion,
      mensaje_inscripcion_html: fila.mensaje_inscripcion_html,
      fecha_vigencia_desde: fila.fecha_vigencia_desde,
      fecha_vigencia_hasta: fila.fecha_vigencia_hasta,
      departamental_id: fila.beneficio_departamental_id,
    },
    afiliado: {
      id: fila.usuario_id,
      nombre: fila.nombre,
      apellido: fila.apellido,
      documento: fila.documento,
      cuil: fila.cuil,
      cbu: fila.cbu,
      telefono: fila.telefono,
      email: fila.email,
      fecha_nacimiento: fila.fecha_nacimiento,
    },
    cantidadFamiliares: fila.cantidad_familiares,
  };
}

/**
 * Envía el aviso a la entidad y persiste el resultado (ENVIADO / ERROR + motivo).
 * Ante error: notificación BENEFICIO_AVISO_ERROR al equipo de la departamental
 * dueña y a los superiores + historial AVISO. Nunca lanza.
 * Devuelve { enviado, motivo? }.
 */
async function enviarYRegistrarAvisoEntidad(db, contexto, { reenvio = false, autor = null } = {}) {
  const { beneficio, inscripcion, afiliado, cantidadFamiliares } = contexto;
  const resultado = await enviarCorreoAvisoEntidad({ beneficio, inscripcion, afiliado, cantidadFamiliares });
  const destino = beneficio.email_aviso_inscripcion;
  try {
    if (resultado.enviado) {
      await db.query(
        `UPDATE beneficio_inscripcion
         SET aviso_entidad_estado = 'ENVIADO', aviso_entidad_error = NULL, aviso_entidad_fecha = NOW()
         WHERE id = ?`,
        [inscripcion.id]
      );
      await registrarHistorial(db, {
        beneficio_id: beneficio.id,
        inscripcion_id: inscripcion.id,
        usuario_id: autor?.id || null,
        usuario_rol: autor?.rol || null,
        tipo_operacion: "AVISO",
        observacion: reenvio
          ? `Reenvío correcto del aviso a la entidad (${destino}) por la inscripción B-${inscripcion.id}`
          : `Aviso enviado a la entidad (${destino}) por la inscripción B-${inscripcion.id}`,
      });
      return { enviado: true };
    }

    const motivo = describirMotivoCorreo(resultado).slice(0, 300);
    await db.query(
      `UPDATE beneficio_inscripcion
       SET aviso_entidad_estado = 'ERROR', aviso_entidad_error = ?, aviso_entidad_fecha = NOW()
       WHERE id = ?`,
      [motivo, inscripcion.id]
    );
    await registrarHistorial(db, {
      beneficio_id: beneficio.id,
      inscripcion_id: inscripcion.id,
      usuario_id: autor?.id || null,
      usuario_rol: autor?.rol || null,
      tipo_operacion: "AVISO",
      observacion: `${reenvio ? "Falló el reenvío del aviso" : "No se pudo avisar"} a la entidad (${destino}) por la inscripción B-${inscripcion.id}: ${motivo}`,
    });
    const payload = { beneficio_id: beneficio.id, inscripcion_id: inscripcion.id };
    const titulo = `Falló el aviso a la entidad del beneficio "${beneficio.nombre}"`;
    const mensaje = `La inscripción B-${inscripcion.id} de ${afiliado.apellido}, ${afiliado.nombre} no pudo comunicarse a ${destino}: ${motivo}. Reenviá el aviso o marcá la comunicación como resuelta desde Inscripciones.`;
    await notificarUsuariosDepartamental(db, beneficio.departamental_id, "BENEFICIO_AVISO_ERROR", titulo, mensaje, payload, autor?.id);
    await notificarSuperiores(db, "BENEFICIO_AVISO_ERROR", titulo, mensaje, payload, autor?.id);
    return { enviado: false, motivo };
  } catch (error) {
    registrarErrorRuta(error, "beneficios:aviso-entidad");
    return { enviado: resultado.enviado, motivo: resultado.enviado ? undefined : describirMotivoCorreo(resultado) };
  }
}

// Correos posteriores a una inscripción nueva: afiliado + entidad (si corresponde). Nunca lanza.
async function procesarCorreosInscripcion(db, inscripcionId) {
  try {
    const contexto = await obtenerInscripcionParaCorreo(db, inscripcionId);
    if (!contexto) return;
    const { beneficio, inscripcion, afiliado } = contexto;

    if (afiliado.email) {
      const resultado = await enviarCorreoInscripcionAfiliado({ beneficio, inscripcion, afiliado });
      await db.query(
        "UPDATE beneficio_inscripcion SET correo_afiliado_enviado = ?, correo_afiliado_motivo = ? WHERE id = ?",
        [resultado.enviado ? 1 : 0, resultado.enviado ? null : describirMotivoCorreo(resultado).slice(0, 120), inscripcion.id]
      );
    } else {
      await db.query(
        "UPDATE beneficio_inscripcion SET correo_afiliado_enviado = 0, correo_afiliado_motivo = ? WHERE id = ?",
        ["El afiliado no tiene email cargado", inscripcion.id]
      );
    }

    if (beneficio.email_aviso_inscripcion) {
      await enviarYRegistrarAvisoEntidad(db, contexto, { reenvio: false, autor: { id: afiliado.id, rol: "afiliado" } });
    }
  } catch (error) {
    registrarErrorRuta(error, "beneficios:correos-inscripcion");
  }
}

// ---------------------------------------------------------------------------
// Consultas compartidas
// ---------------------------------------------------------------------------
// Lo que ve el afiliado: aprobado, habilitado, vigente y segmentado a su departamental
// (param: departamental del afiliado, 0 si no tiene => solo alcance_todas).
const CONDICION_PUBLICABLE = `b.eliminado = 0 AND b.estado_id = ${ESTADO.APROBADO} AND b.habilitado = 1
  AND (b.fecha_vigencia_desde IS NULL OR b.fecha_vigencia_desde <= CURDATE())
  AND (b.fecha_vigencia_hasta IS NULL OR b.fecha_vigencia_hasta >= CURDATE())
  AND (b.alcance_todas = 1 OR EXISTS (
    SELECT 1 FROM beneficio_departamental bd_pub WHERE bd_pub.beneficio_id = b.id AND bd_pub.departamental_id = ?))`;

const SELECT_INSCRIPTOS = "(SELECT COUNT(*) FROM beneficio_inscripcion bi_c WHERE bi_c.beneficio_id = b.id AND bi_c.activa = 1)";
const SELECT_INCLUYE_DEPARTAMENTAL = "EXISTS (SELECT 1 FROM beneficio_departamental bd_inc WHERE bd_inc.beneficio_id = b.id AND bd_inc.departamental_id = ?)";

function departamentalDeCabecera(cabecera) {
  return normalizarIdPositivo(cabecera?.departamental_id) || 0;
}

// Beneficio vivo con la marca de "incluye a mi departamental" (para puedeVerBeneficio)
async function obtenerBeneficioStaff(connection, beneficioId, cabecera, { forUpdate = false } = {}) {
  const departamentalId = cabecera.rol === "departamental" ? departamentalDeCabecera(cabecera) : 0;
  const [rows] = await connection.query(
    `SELECT b.*, ${SELECT_INCLUYE_DEPARTAMENTAL} AS incluye_departamental
     FROM beneficio b WHERE b.id = ? AND b.eliminado = 0${forUpdate ? " FOR UPDATE" : ""}`,
    [departamentalId, beneficioId]
  );
  return rows.length > 0 ? rows[0] : null;
}

async function firmarImagenes(filas) {
  const salida = [];
  for (const fila of filas || []) {
    salida.push({ id: fila.id, archivo: fila.archivo, orden: Number(fila.orden || 0), url: await firmarSeguro(fila.archivo) });
  }
  return salida;
}

async function firmarSucursales(filas) {
  const salida = [];
  for (const fila of filas || []) {
    salida.push({
      id: fila.id,
      direccion: fila.direccion,
      latitud: fila.latitud === null || fila.latitud === undefined ? null : Number(fila.latitud),
      longitud: fila.longitud === null || fila.longitud === undefined ? null : Number(fila.longitud),
      etiqueta: fila.etiqueta || null,
      orden: Number(fila.orden || 0),
      imagen_url: fila.imagen_archivo ? await firmarSeguro(fila.imagen_archivo) : null,
    });
  }
  return salida;
}

function describirSucursales(lista) {
  if (!lista || lista.length === 0) return "—";
  const texto = lista.map((s) => [s.direccion, s.etiqueta].filter(Boolean).join(" · ")).join("; ");
  return texto.length > 500 ? `${texto.slice(0, 499)}…` : texto;
}

function firmaSucursal(s) {
  const lat = s.latitud === null || s.latitud === undefined ? "" : Number(s.latitud).toFixed(6);
  const lng = s.longitud === null || s.longitud === undefined ? "" : Number(s.longitud).toFixed(6);
  return `${s.direccion}|${lat}|${lng}|${s.etiqueta || ""}`;
}

function responderError(res, error, mensajePorDefecto) {
  registrarErrorRuta(error);
  if (res.headersSent) return;
  if (error && error.statusCode) return res.status(error.statusCode).json(error.message);
  return res.status(500).json(mensajePorDefecto);
}

// ---------------------------------------------------------------------------
// GET /beneficios/catalogos — estados + rubros + departamentales (cualquier rol logueado)
// ---------------------------------------------------------------------------
router.get("/beneficios/catalogos", verifyToken, async (req, res) => {
  try {
    const db = mysqlConnection.promise();
    const [estados] = await db.query("SELECT id, nombre, color, color_texto, orden FROM beneficio_estado ORDER BY orden");
    const [estadosInscripcion] = await db.query(
      "SELECT id, nombre, color, color_texto, orden FROM beneficio_inscripcion_estado ORDER BY orden"
    );
    const [rubros] = await db.query(
      "SELECT id, nombre FROM beneficio_rubro WHERE habilitado = 1 ORDER BY nombre COLLATE utf8mb4_es_0900_ai_ci"
    );
    const [departamentales] = await db.query(
      "SELECT id, nombre FROM departamental WHERE habilitado = 'Y' ORDER BY nombre"
    );
    res.status(200).json({ estados, estados_inscripcion: estadosInscripcion, rubros, departamentales });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los catálogos de beneficios");
  }
});

// ---------------------------------------------------------------------------
// POST /beneficios/rubros — alta rápida de rubro desde el editor (staff)
// ---------------------------------------------------------------------------
router.post("/beneficios/rubros", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const nombre = normalizarTexto(req.body?.nombre);
    if (!nombre || nombre.length < 2) return res.status(400).json("El nombre del rubro es obligatorio (mínimo 2 caracteres)");
    if (nombre.length > 80) return res.status(400).json("El nombre del rubro es demasiado largo (máximo 80 caracteres)");

    const [resultado] = await mysqlConnection.promise().query(
      "INSERT INTO beneficio_rubro (nombre, creado_por_usuario_id) VALUES (?, ?)",
      [nombre, cabecera.id]
    );
    res.status(201).json({ id: resultado.insertId, nombre });
  } catch (error) {
    // uq_ben_rubro_nombre (collation ai_ci: también atrapa mayúsculas/acentos)
    if (error && error.code === "ER_DUP_ENTRY") return res.status(409).json("Ese rubro ya existe");
    registrarErrorRuta(error);
    res.status(500).json("Error al crear el rubro");
  }
});

// ---------------------------------------------------------------------------
// GET /beneficios/inscripciones — tabla de inscriptos (staff)
// ---------------------------------------------------------------------------
const COLUMNAS_ORDEN_INSCRIPCIONES = {
  id: "bi.id",
  fecha_creacion: "bi.fecha_creacion",
  beneficio: "b.nombre",
  afiliado: "u.apellido",
  departamental: "d.nombre",
  estado: "be.orden",
  aviso: "bi.aviso_entidad_estado",
};

router.get("/beneficios/inscripciones", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();

    const page = normalizarEnteroPositivo(req.query.page, { porDefecto: 1, maximo: 1_000_000 });
    const pageSize = normalizarEnteroPositivo(req.query.pageSize, { porDefecto: 20, maximo: 100 });
    if (page === null || pageSize === null) return res.status(400).json("La paginación es inválida");
    const orderBy = COLUMNAS_ORDEN_INSCRIPCIONES[req.query.orderBy] || "bi.fecha_creacion";
    const orderType = String(req.query.orderType).toUpperCase() === "ASC" ? "ASC" : "DESC";

    // Condiciones base (scope + filtros) separadas del filtro de aviso para el resumen
    const condiciones = ["bi.eliminado = 0", "b.eliminado = 0"];
    const params = [];
    if (cabecera.rol === "departamental") {
      const propia = departamentalDeCabecera(cabecera);
      if (!propia) return res.status(401).json("No autorizado");
      condiciones.push("(b.departamental_id = ? OR u.departamental_id = ?)");
      params.push(propia, propia);
    }
    if (valorInformado(req.query.beneficio_id)) {
      const beneficioId = normalizarIdPositivo(req.query.beneficio_id);
      if (beneficioId === null) return res.status(400).json("El filtro de beneficio es inválido");
      condiciones.push("bi.beneficio_id = ?");
      params.push(beneficioId);
    }
    if (valorInformado(req.query.estado_id)) {
      const estadoId = normalizarIdPositivo(req.query.estado_id);
      if (estadoId === null || !Object.values(ESTADO_INSCRIPCION).includes(estadoId)) {
        return res.status(400).json("El filtro de estado es inválido");
      }
      condiciones.push("bi.estado_id = ?");
      params.push(estadoId);
    }
    if (valorInformado(req.query.departamental_id)) {
      const departamentalId = normalizarIdPositivo(req.query.departamental_id);
      if (departamentalId === null) return res.status(400).json("El filtro de departamental es inválido");
      condiciones.push("u.departamental_id = ?");
      params.push(departamentalId);
    }
    const fechaDesde = normalizarFecha(req.query.fecha_desde);
    if (valorInformado(req.query.fecha_desde) && fechaDesde === null) return res.status(400).json("La fecha desde es inválida");
    const fechaHasta = normalizarFecha(req.query.fecha_hasta);
    if (valorInformado(req.query.fecha_hasta) && fechaHasta === null) return res.status(400).json("La fecha hasta es inválida");
    if (fechaDesde && fechaHasta && fechaDesde > fechaHasta) {
      return res.status(400).json("La fecha desde no puede ser posterior a la fecha hasta");
    }
    if (fechaDesde) {
      condiciones.push("DATE(bi.fecha_creacion) >= ?");
      params.push(fechaDesde);
    }
    if (fechaHasta) {
      condiciones.push("DATE(bi.fecha_creacion) <= ?");
      params.push(fechaHasta);
    }
    const search = normalizarTexto(req.query.search);
    if (search && search.length > 200) return res.status(400).json("La búsqueda es demasiado larga");
    if (search) {
      condiciones.push(`(CONCAT('B-', bi.id) LIKE ? OR CONCAT('B-', b.id) LIKE ? OR b.nombre LIKE ?
        OR u.nombre LIKE ? OR u.apellido LIKE ? OR CONCAT(u.apellido, ', ', u.nombre) LIKE ?
        OR CAST(u.documento AS CHAR) LIKE ? OR u.email LIKE ?)`);
      params.push(...Array(8).fill(`%${search}%`));
    }

    const condicionesFinal = [...condiciones];
    const paramsFinal = [...params];
    const aviso = normalizarTexto(req.query.aviso);
    if (aviso) {
      const avisoNormalizado = aviso.toUpperCase();
      if (!ESTADOS_AVISO_ENTIDAD.includes(avisoNormalizado)) return res.status(400).json("El filtro de comunicación es inválido");
      condicionesFinal.push("bi.aviso_entidad_estado = ?");
      paramsFinal.push(avisoNormalizado);
    }

    const from = `FROM beneficio_inscripcion bi
       INNER JOIN beneficio b ON b.id = bi.beneficio_id
       INNER JOIN beneficio_inscripcion_estado be ON be.id = bi.estado_id
       INNER JOIN usuario u ON u.id = bi.usuario_id
       LEFT JOIN departamental d ON d.id = u.departamental_id`;
    const where = condicionesFinal.join(" AND ");

    const [countRows] = await db.query(`SELECT COUNT(*) AS total ${from} WHERE ${where}`, paramsFinal);
    const totalItems = Number(countRows[0].total);

    const [rows] = await db.query(
      `SELECT bi.id, bi.fecha_creacion, bi.fecha_modificacion, bi.beneficio_id, b.nombre AS beneficio_nombre,
              CONCAT('B-', bi.id) AS codigo, CONCAT('B-', b.id) AS beneficio_codigo,
              u.id AS afiliado_id, u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento AS afiliado_documento,
              u.email AS afiliado_email, u.telefono AS afiliado_telefono,
              u.departamental_id AS afiliado_departamental_id, d.nombre AS afiliado_departamental,
              be.id AS estado_id, be.nombre AS estado, be.color AS estado_color, be.color_texto AS estado_color_texto,
              bi.mensaje_afiliado, bi.correo_afiliado_enviado, bi.correo_afiliado_motivo,
              bi.aviso_entidad_estado, bi.aviso_entidad_error, bi.aviso_entidad_fecha,
              b.email_aviso_inscripcion
       ${from}
       WHERE ${where}
       ORDER BY ${orderBy} ${orderType}, bi.id DESC
       LIMIT ? OFFSET ?`,
      [...paramsFinal, pageSize, (page - 1) * pageSize]
    );

    const [resumen] = await db.query(
      `SELECT bi.aviso_entidad_estado, COUNT(*) AS cantidad ${from} WHERE ${condiciones.join(" AND ")} GROUP BY bi.aviso_entidad_estado`,
      params
    );

    const results = rows.map((row) => ({
      ...row,
      puede_reenviar: row.aviso_entidad_estado === "ERROR" && Boolean(row.email_aviso_inscripcion),
    }));
    res.status(200).json({ results, totalItems, page, pageSize, resumen });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener las inscripciones");
  }
});

// Inscripción con lo necesario para el scope del staff
async function obtenerInscripcionStaff(db, inscripcionId, cabecera) {
  const [rows] = await db.query(
    `SELECT bi.id, bi.beneficio_id, bi.usuario_id, bi.aviso_entidad_estado, bi.aviso_entidad_error,
            b.nombre AS beneficio_nombre, b.email_aviso_inscripcion, b.departamental_id AS beneficio_departamental_id,
            u.departamental_id AS afiliado_departamental_id
     FROM beneficio_inscripcion bi
     INNER JOIN beneficio b ON b.id = bi.beneficio_id
     INNER JOIN usuario u ON u.id = bi.usuario_id
     WHERE bi.id = ? AND bi.eliminado = 0 AND b.eliminado = 0`,
    [inscripcionId]
  );
  if (rows.length === 0) return { error: crearErrorHttp("Inscripción no encontrada", 404) };
  const inscripcion = rows[0];
  if (cabecera.rol === "departamental") {
    const propia = departamentalDeCabecera(cabecera);
    if (!propia
      || (!idsPositivosIguales(inscripcion.beneficio_departamental_id, propia)
        && !idsPositivosIguales(inscripcion.afiliado_departamental_id, propia))) {
      return { error: crearErrorHttp("No autorizado", 401) };
    }
  }
  return { inscripcion };
}

// ---------------------------------------------------------------------------
// PUT /beneficios/inscripciones/:id/reenviar-aviso — reintenta el correo a la entidad
// ---------------------------------------------------------------------------
router.put("/beneficios/inscripciones/:id(\\d+)/reenviar-aviso", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    const { error, inscripcion } = await obtenerInscripcionStaff(db, inscripcionId, cabecera);
    if (error) return res.status(error.statusCode).json(error.message);
    if (!inscripcion.email_aviso_inscripcion) {
      return res.status(400).json("El beneficio no tiene configurado un correo de aviso a la entidad");
    }

    const contexto = await obtenerInscripcionParaCorreo(db, inscripcionId);
    if (!contexto) return res.status(404).json("Inscripción no encontrada");
    const resultado = await enviarYRegistrarAvisoEntidad(db, contexto, { reenvio: true, autor: cabecera });
    res.status(200).json({
      success: true,
      enviado: resultado.enviado,
      motivo: resultado.enviado ? undefined : resultado.motivo,
      message: resultado.enviado
        ? `Aviso reenviado a ${inscripcion.email_aviso_inscripcion}`
        : `No se pudo reenviar el aviso: ${resultado.motivo}`,
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al reenviar el aviso a la entidad");
  }
});

// ---------------------------------------------------------------------------
// PUT /beneficios/inscripciones/:id/resolver-aviso — marca la comunicación como resuelta a mano
// ---------------------------------------------------------------------------
router.put("/beneficios/inscripciones/:id(\\d+)/resolver-aviso", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID inválido");
    const observacion = normalizarTexto(req.body?.observacion);
    if (observacion && observacion.length > 5000) {
      return res.status(400).json("La observación es demasiado larga (máximo 5000 caracteres)");
    }
    const db = mysqlConnection.promise();

    const { error, inscripcion } = await obtenerInscripcionStaff(db, inscripcionId, cabecera);
    if (error) return res.status(error.statusCode).json(error.message);
    if (inscripcion.aviso_entidad_estado !== "ERROR") {
      return res.status(400).json("La comunicación con la entidad no está marcada con error");
    }

    await db.query(
      "UPDATE beneficio_inscripcion SET aviso_entidad_estado = 'RESUELTO', aviso_entidad_fecha = NOW() WHERE id = ?",
      [inscripcionId]
    );
    await registrarHistorial(db, {
      beneficio_id: inscripcion.beneficio_id,
      inscripcion_id: inscripcionId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "AVISO",
      observacion: `Comunicación resuelta manualmente (inscripción B-${inscripcionId})${observacion ? `: ${observacion}` : ""}`,
    });
    res.status(200).json({ success: true, message: "Comunicación marcada como resuelta" });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al resolver la comunicación");
  }
});

// ---------------------------------------------------------------------------
// GET /beneficios/publicados — vidriera del afiliado (sin paginar, tope 200)
// ---------------------------------------------------------------------------
router.get("/beneficios/publicados", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (cabecera.rol !== "afiliado") return res.status(401).json("No autorizado");
    const usuarioId = normalizarIdPositivo(cabecera.id);
    if (!usuarioId) return res.status(401).json("No autorizado");
    const departamentalId = departamentalDeCabecera(cabecera);
    const db = mysqlConnection.promise();

    const condiciones = [CONDICION_PUBLICABLE];
    const params = [departamentalId];
    const search = normalizarTexto(req.query.search);
    if (search && search.length > 200) return res.status(400).json("La búsqueda es demasiado larga");
    if (search) {
      condiciones.push("(b.nombre LIKE ? OR b.descripcion_corta LIKE ? OR r.nombre LIKE ?)");
      params.push(...Array(3).fill(`%${search}%`));
    }
    if (valorInformado(req.query.rubro_id)) {
      const rubroId = normalizarIdPositivo(req.query.rubro_id);
      if (rubroId === null) return res.status(400).json("El rubro es inválido");
      condiciones.push("b.rubro_id = ?");
      params.push(rubroId);
    }
    const conMapa = String(req.query.con_mapa || "") === "1";
    if (conMapa) {
      condiciones.push(`b.mostrar_mapa = 1 AND EXISTS (
        SELECT 1 FROM beneficio_sucursal s_m WHERE s_m.beneficio_id = b.id AND s_m.latitud IS NOT NULL AND s_m.longitud IS NOT NULL)`);
    }

    const [rows] = await db.query(
      `SELECT b.id, b.nombre, b.rubro_id, r.nombre AS rubro_nombre, b.descripcion_corta, b.tarjeta_usa_logo,
              b.logo_archivo, b.fecha_vigencia_desde, b.fecha_vigencia_hasta, b.cupo_maximo, b.mostrar_mapa, b.fecha_creacion,
              ${SELECT_INSCRIPTOS} AS inscriptos,
              EXISTS (SELECT 1 FROM beneficio_inscripcion bi_u WHERE bi_u.beneficio_id = b.id AND bi_u.usuario_id = ? AND bi_u.activa = 1) AS inscripto
       FROM beneficio b
       INNER JOIN beneficio_rubro r ON r.id = b.rubro_id
       WHERE ${condiciones.join(" AND ")}
       ORDER BY b.fecha_creacion DESC, b.id DESC
       LIMIT 200`,
      [usuarioId, ...params]
    );

    const ids = rows.map((row) => row.id);
    const imagenesPorBeneficio = new Map();
    const sucursalesPorBeneficio = new Map();
    if (ids.length > 0) {
      const marcadores = ids.map(() => "?").join(",");
      const [imagenes] = await db.query(
        `SELECT id, beneficio_id, archivo, orden FROM beneficio_imagen WHERE beneficio_id IN (${marcadores}) ORDER BY beneficio_id, orden, id`,
        ids
      );
      for (const imagen of imagenes) {
        if (!imagenesPorBeneficio.has(imagen.beneficio_id)) imagenesPorBeneficio.set(imagen.beneficio_id, []);
        imagenesPorBeneficio.get(imagen.beneficio_id).push(imagen);
      }
      const idsConMapa = rows.filter((row) => normalizarBooleano(row.mostrar_mapa) === 1).map((row) => row.id);
      if (idsConMapa.length > 0) {
        const [sucursales] = await db.query(
          `SELECT id, beneficio_id, direccion, latitud, longitud, etiqueta, imagen_archivo, orden
           FROM beneficio_sucursal WHERE beneficio_id IN (${idsConMapa.map(() => "?").join(",")})
           ORDER BY beneficio_id, orden, id`,
          idsConMapa
        );
        for (const sucursal of sucursales) {
          if (!sucursalesPorBeneficio.has(sucursal.beneficio_id)) sucursalesPorBeneficio.set(sucursal.beneficio_id, []);
          sucursalesPorBeneficio.get(sucursal.beneficio_id).push(sucursal);
        }
      }
    }

    const results = [];
    for (const row of rows) {
      const imagenes = await firmarImagenes(imagenesPorBeneficio.get(row.id) || []);
      const sucursales = normalizarBooleano(row.mostrar_mapa) === 1
        ? await firmarSucursales(sucursalesPorBeneficio.get(row.id) || [])
        : undefined;
      results.push({
        id: row.id,
        nombre: row.nombre,
        rubro_id: row.rubro_id,
        rubro_nombre: row.rubro_nombre,
        descripcion_corta: row.descripcion_corta,
        tarjeta_usa_logo: normalizarBooleano(row.tarjeta_usa_logo),
        logo_url: await firmarSeguro(row.logo_archivo),
        imagenes: imagenes.map((imagen) => ({ id: imagen.id, url: imagen.url, orden: imagen.orden })),
        fecha_vigencia_desde: row.fecha_vigencia_desde,
        fecha_vigencia_hasta: row.fecha_vigencia_hasta,
        cupo: calcularCupo(row.cupo_maximo, row.inscriptos),
        inscripto: normalizarBooleano(row.inscripto) === 1,
        mostrar_mapa: normalizarBooleano(row.mostrar_mapa),
        ...(sucursales ? { sucursales } : {}),
      });
    }

    const [rubrosDisponibles] = await db.query(
      `SELECT r.id, r.nombre, COUNT(*) AS cantidad
       FROM beneficio b INNER JOIN beneficio_rubro r ON r.id = b.rubro_id
       WHERE ${CONDICION_PUBLICABLE}
       GROUP BY r.id, r.nombre
       ORDER BY r.nombre COLLATE utf8mb4_es_0900_ai_ci`,
      [departamentalId]
    );

    res.status(200).json({
      results,
      rubros_disponibles: rubrosDisponibles.map((r) => ({ id: r.id, nombre: r.nombre, cantidad: Number(r.cantidad) })),
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los beneficios");
  }
});

// ---------------------------------------------------------------------------
// GET /beneficios/publicados/:id — detalle público (solo lo visible para el afiliado)
// ---------------------------------------------------------------------------
router.get("/beneficios/publicados/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (cabecera.rol !== "afiliado") return res.status(401).json("No autorizado");
    const usuarioId = normalizarIdPositivo(cabecera.id);
    const beneficioId = normalizarIdPositivo(req.params.id);
    if (!usuarioId) return res.status(401).json("No autorizado");
    if (!beneficioId) return res.status(400).json("ID inválido");
    const departamentalId = departamentalDeCabecera(cabecera);
    const db = mysqlConnection.promise();

    const [rows] = await db.query(
      `SELECT b.*, r.nombre AS rubro_nombre, ${SELECT_INSCRIPTOS} AS inscriptos
       FROM beneficio b
       INNER JOIN beneficio_rubro r ON r.id = b.rubro_id
       WHERE b.id = ? AND ${CONDICION_PUBLICABLE}`,
      [beneficioId, departamentalId]
    );
    if (rows.length === 0) return res.status(404).json("El beneficio no está disponible");
    const beneficio = rows[0];

    const [imagenes] = await db.query(
      "SELECT id, archivo, orden FROM beneficio_imagen WHERE beneficio_id = ? ORDER BY orden, id",
      [beneficioId]
    );
    const [sucursales] = await db.query(
      `SELECT id, direccion, latitud, longitud, etiqueta, imagen_archivo, orden
       FROM beneficio_sucursal WHERE beneficio_id = ? ORDER BY orden, id`,
      [beneficioId]
    );
    const [inscripciones] = await db.query(
      `SELECT bi.id, bi.fecha_creacion, be.nombre AS estado
       FROM beneficio_inscripcion bi
       INNER JOIN beneficio_inscripcion_estado be ON be.id = bi.estado_id
       WHERE bi.usuario_id = ? AND bi.beneficio_id = ? AND bi.activa = 1
       LIMIT 1`,
      [usuarioId, beneficioId]
    );
    const inscripcion = inscripciones.length > 0
      ? { id: inscripciones[0].id, fecha_creacion: inscripciones[0].fecha_creacion, estado: inscripciones[0].estado, codigo: `B-${inscripciones[0].id}` }
      : null;

    res.status(200).json({
      id: beneficio.id,
      nombre: beneficio.nombre,
      rubro_id: beneficio.rubro_id,
      rubro_nombre: beneficio.rubro_nombre,
      descripcion_corta: beneficio.descripcion_corta,
      promocion_html_render: await renderizarHtmlBeneficio(beneficio.promocion_html),
      telefono: normalizarBooleano(beneficio.telefono_visible) === 1 ? beneficio.telefono : null,
      sitio_web: normalizarBooleano(beneficio.sitio_web_visible) === 1 ? beneficio.sitio_web : null,
      email_contacto: normalizarBooleano(beneficio.email_contacto_visible) === 1 ? beneficio.email_contacto : null,
      tarjeta_usa_logo: normalizarBooleano(beneficio.tarjeta_usa_logo),
      logo_url: await firmarSeguro(beneficio.logo_archivo),
      imagenes: (await firmarImagenes(imagenes)).map((imagen) => ({ id: imagen.id, url: imagen.url, orden: imagen.orden })),
      mostrar_mapa: normalizarBooleano(beneficio.mostrar_mapa),
      sucursales: await firmarSucursales(sucursales),
      fecha_vigencia_desde: beneficio.fecha_vigencia_desde,
      fecha_vigencia_hasta: beneficio.fecha_vigencia_hasta,
      cupo: calcularCupo(beneficio.cupo_maximo, beneficio.inscriptos),
      inscripto: inscripcion !== null,
      inscripcion,
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el beneficio");
  }
});

// ---------------------------------------------------------------------------
// POST /beneficios/publicados/:id/inscripcion — el afiliado se inscribe
// Cupo con bloqueo del beneficio; la doble inscripción concurrente la frena
// uq_ben_insc_activa (ER_DUP_ENTRY -> 409). Correos siempre después del commit.
// ---------------------------------------------------------------------------
router.post("/beneficios/publicados/:id(\\d+)/inscripcion", verifyToken, async (req, res) => {
  let connection;
  let transaccionConfirmada = false;
  try {
    const cabecera = getCabecera(req);
    if (cabecera.rol !== "afiliado") return res.status(401).json("No autorizado");
    const usuarioId = normalizarIdPositivo(cabecera.id);
    const beneficioId = normalizarIdPositivo(req.params.id);
    if (!usuarioId) return res.status(401).json("No autorizado");
    if (!beneficioId) return res.status(400).json("ID inválido");
    const departamentalId = departamentalDeCabecera(cabecera);
    const mensaje = normalizarTexto(req.body?.mensaje);
    if (mensaje && mensaje.length > 2000) return res.status(400).json("El mensaje es demasiado largo (máximo 2000 caracteres)");

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [beneficios] = await connection.query(
      `SELECT b.* FROM beneficio b WHERE b.id = ? AND ${CONDICION_PUBLICABLE} FOR UPDATE`,
      [beneficioId, departamentalId]
    );
    if (beneficios.length === 0) {
      await connection.rollback();
      return res.status(404).json("El beneficio no está disponible para inscribirse");
    }
    const beneficio = beneficios[0];

    const [usuarios] = await connection.query(
      "SELECT id, nombre, apellido, email FROM usuario WHERE id = ? AND habilitado = 'Y'",
      [usuarioId]
    );
    if (usuarios.length === 0) {
      await connection.rollback();
      return res.status(401).json("No autorizado");
    }
    if (!normalizarTexto(usuarios[0].email)) {
      // El front abre el diálogo para cargar el email y reintenta
      await connection.rollback();
      return res.status(428).json("SIN_EMAIL");
    }

    const [activas] = await connection.query(
      "SELECT id FROM beneficio_inscripcion WHERE usuario_id = ? AND beneficio_id = ? AND activa = 1 FOR UPDATE",
      [usuarioId, beneficioId]
    );
    if (activas.length > 0) {
      await connection.rollback();
      return res.status(409).json("Ya estás inscripto");
    }

    if (normalizarIdPositivo(beneficio.cupo_maximo) !== null) {
      const [[{ total }]] = await connection.query(
        "SELECT COUNT(*) AS total FROM beneficio_inscripcion WHERE beneficio_id = ? AND activa = 1",
        [beneficioId]
      );
      if (Number(total) >= normalizarIdPositivo(beneficio.cupo_maximo)) {
        await connection.rollback();
        return res.status(409).json("No quedan cupos disponibles");
      }
    }

    // Si hay aviso a la entidad, nace en ERROR "pendiente": si el proceso se cae
    // antes de mandar el correo, el back-office lo ve y lo reenvía.
    const tieneAviso = Boolean(beneficio.email_aviso_inscripcion);
    const [resultado] = await connection.query(
      `INSERT INTO beneficio_inscripcion
         (beneficio_id, usuario_id, estado_id, mensaje_afiliado, aviso_entidad_estado, aviso_entidad_error)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        beneficioId, usuarioId, ESTADO_INSCRIPCION.INSCRIPTO, mensaje,
        tieneAviso ? "ERROR" : "NO_APLICA", tieneAviso ? "Envío pendiente" : null,
      ]
    );
    const inscripcionId = resultado.insertId;

    await registrarHistorial(connection, {
      beneficio_id: beneficioId,
      inscripcion_id: inscripcionId,
      usuario_id: usuarioId,
      usuario_rol: cabecera.rol,
      tipo_operacion: "INSCRIPCION",
      observacion: `Inscripción B-${inscripcionId} registrada por el afiliado${mensaje ? ` — Mensaje: ${mensaje}` : ""}`,
    });
    await insertarNotificacion(
      connection, usuarioId, "BENEFICIO_INSCRIPCION",
      `Inscripción a "${beneficio.nombre}"`,
      resumenHtml(beneficio.mensaje_inscripcion_html, 600) || MENSAJE_INSCRIPCION_POR_DEFECTO,
      { beneficio_id: beneficioId, inscripcion_id: inscripcionId }
    );

    await connection.commit();
    transaccionConfirmada = true;
    // Se libera la conexión antes de los correos: el SMTP no retiene un lugar del pool
    connection.release();
    connection = null;

    // Post-commit: correo al afiliado + aviso a la entidad (nunca lanza). Se espera antes
    // de responder para que el detalle que el front recarga ya traiga el resultado.
    await procesarCorreosInscripcion(mysqlConnection.promise(), inscripcionId);

    res.status(201).json({ success: true, id: inscripcionId, codigo: `B-${inscripcionId}`, message: "Inscripción registrada" });
  } catch (error) {
    if (connection && !transaccionConfirmada) await connection.rollback();
    if (res.headersSent) {
      registrarErrorRuta(error);
      return;
    }
    if (error && error.code === "ER_DUP_ENTRY") return res.status(409).json("Ya estás inscripto");
    registrarErrorRuta(error);
    res.status(500).json("Error al registrar la inscripción");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /beneficios/publicados/:id/inscripcion/cancelar — libera el cupo
// ---------------------------------------------------------------------------
router.put("/beneficios/publicados/:id(\\d+)/inscripcion/cancelar", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (cabecera.rol !== "afiliado") return res.status(401).json("No autorizado");
    const usuarioId = normalizarIdPositivo(cabecera.id);
    const beneficioId = normalizarIdPositivo(req.params.id);
    if (!usuarioId) return res.status(401).json("No autorizado");
    if (!beneficioId) return res.status(400).json("ID inválido");

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const [activas] = await connection.query(
      `SELECT bi.id FROM beneficio_inscripcion bi
       WHERE bi.usuario_id = ? AND bi.beneficio_id = ? AND bi.activa = 1 FOR UPDATE`,
      [usuarioId, beneficioId]
    );
    if (activas.length === 0) {
      await connection.rollback();
      return res.status(404).json("No tenés una inscripción activa en este beneficio");
    }
    const inscripcionId = activas[0].id;
    await connection.query(
      "UPDATE beneficio_inscripcion SET estado_id = ? WHERE id = ?",
      [ESTADO_INSCRIPCION.CANCELADA, inscripcionId]
    );
    await registrarHistorial(connection, {
      beneficio_id: beneficioId,
      inscripcion_id: inscripcionId,
      usuario_id: usuarioId,
      usuario_rol: cabecera.rol,
      tipo_operacion: "INSCRIPCION",
      observacion: `Inscripción B-${inscripcionId} cancelada por el afiliado`,
    });
    await connection.commit();
    res.status(200).json({ success: true, message: "Inscripción cancelada" });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    res.status(500).json("Error al cancelar la inscripción");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// POST /beneficios/editor/imagenes — imagen embebida del texto enriquecido (staff)
// Queda con beneficio_id NULL hasta que se guarde el beneficio que la contiene.
// ---------------------------------------------------------------------------
router.post("/beneficios/editor/imagenes", verifyToken, manejarUploadImagenEditor, async (req, res) => {
  let key = null;
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    if (!req.file) return res.status(400).json("Adjuntá una imagen");

    const imagen = await procesarImagenBeneficio(req.file, { anchoMaximo: ANCHO_MAXIMO_EDITOR, etiqueta: "La imagen" });
    key = await subirArchivoBeneficio(imagen, "editor");
    await mysqlConnection.promise().query(
      "INSERT INTO beneficio_editor_imagen (beneficio_id, usuario_id, archivo) VALUES (NULL, ?, ?)",
      [cabecera.id, key]
    );
    const url = await getSignedFileUrlFromS3(key);
    res.status(201).json({ archivo: key, url });
  } catch (error) {
    if (key) await eliminarObjetosS3Seguro([key]);
    responderError(res, error, "Error al subir la imagen");
  }
});

// ---------------------------------------------------------------------------
// GET /beneficios — tabla del back-office con filtros, paginado, orden y resumen por estado
// ---------------------------------------------------------------------------
const COLUMNAS_ORDEN = {
  id: "b.id",
  nombre: "b.nombre",
  rubro: "r.nombre",
  departamental: "d.nombre",
  estado: "e.orden",
  fecha_creacion: "b.fecha_creacion",
  vigencia: "b.fecha_vigencia_hasta",
  cupo: "b.cupo_maximo",
  inscriptos: "inscriptos",
  habilitado: "b.habilitado",
};

router.get("/beneficios", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();

    const page = normalizarEnteroPositivo(req.query.page, { porDefecto: 1, maximo: 1_000_000 });
    const pageSize = normalizarEnteroPositivo(req.query.pageSize, { porDefecto: 20, maximo: 100 });
    if (page === null || pageSize === null) return res.status(400).json("La paginación es inválida");
    const orderBy = COLUMNAS_ORDEN[req.query.orderBy] || "b.id";
    const orderType = String(req.query.orderType).toUpperCase() === "ASC" ? "ASC" : "DESC";

    // Condiciones base (scope + filtros) y, aparte, el filtro de estados (el resumen no lo usa)
    const condiciones = ["b.eliminado = 0"];
    const params = [];
    if (cabecera.rol === "departamental") {
      const propia = departamentalDeCabecera(cabecera);
      if (!propia) return res.status(401).json("No autorizado");
      // Propias + las ya aprobadas que la incluyen en su segmentación (solo lectura si no es dueña)
      condiciones.push(`(b.departamental_id = ? OR (b.estado_id = ? AND (b.alcance_todas = 1 OR EXISTS (
        SELECT 1 FROM beneficio_departamental bd_s WHERE bd_s.beneficio_id = b.id AND bd_s.departamental_id = ?))))`);
      params.push(propia, ESTADO.APROBADO, propia);
    }
    if (valorInformado(req.query.rubro_id)) {
      const rubroId = normalizarIdPositivo(req.query.rubro_id);
      if (rubroId === null) return res.status(400).json("El filtro de rubro es inválido");
      condiciones.push("b.rubro_id = ?");
      params.push(rubroId);
    }
    if (valorInformado(req.query.departamental_id)) {
      const departamentalId = normalizarIdPositivo(req.query.departamental_id);
      if (departamentalId === null) return res.status(400).json("El filtro de departamental es inválido");
      condiciones.push("b.departamental_id = ?");
      params.push(departamentalId);
    }
    const vigencia = normalizarTexto(req.query.vigencia);
    if (vigencia === "vigentes") {
      condiciones.push("(b.fecha_vigencia_desde IS NULL OR b.fecha_vigencia_desde <= CURDATE()) AND (b.fecha_vigencia_hasta IS NULL OR b.fecha_vigencia_hasta >= CURDATE())");
    } else if (vigencia === "vencidos") {
      condiciones.push("b.fecha_vigencia_hasta IS NOT NULL AND b.fecha_vigencia_hasta < CURDATE()");
    } else if (vigencia) {
      return res.status(400).json("El filtro de vigencia es inválido");
    }
    if (valorInformado(req.query.habilitado)) {
      if (!["0", "1"].includes(String(req.query.habilitado))) return res.status(400).json("El filtro de habilitado es inválido");
      condiciones.push("b.habilitado = ?");
      params.push(String(req.query.habilitado) === "1" ? 1 : 0);
    }
    const search = normalizarTexto(req.query.search);
    if (search && search.length > 200) return res.status(400).json("La búsqueda es demasiado larga");
    if (search) {
      condiciones.push(`(CONCAT('B-', b.id) LIKE ? OR b.nombre LIKE ? OR b.razon_social LIKE ? OR b.descripcion_corta LIKE ?
        OR r.nombre LIKE ? OR d.nombre LIKE ? OR e.nombre LIKE ?)`);
      params.push(...Array(7).fill(`%${search}%`));
    }

    const condicionesFinal = [...condiciones];
    const paramsFinal = [...params];
    if (valorInformado(req.query.estados)) {
      const estados = normalizarListaIds(req.query.estados, { maximoItems: 10 });
      if (estados === null || estados.length === 0 || estados.some((estado) => !Object.values(ESTADO).includes(estado))) {
        return res.status(400).json("El filtro de estado es inválido");
      }
      condicionesFinal.push(`b.estado_id IN (${estados.map(() => "?").join(",")})`);
      paramsFinal.push(...estados);
    }

    const from = `FROM beneficio b
       INNER JOIN beneficio_rubro r ON r.id = b.rubro_id
       INNER JOIN beneficio_estado e ON e.id = b.estado_id
       LEFT JOIN departamental d ON d.id = b.departamental_id`;
    const where = condicionesFinal.join(" AND ");

    const [countRows] = await db.query(`SELECT COUNT(*) AS total ${from} WHERE ${where}`, paramsFinal);
    const totalItems = Number(countRows[0].total);

    const [rows] = await db.query(
      `SELECT b.id, b.nombre, b.rubro_id, r.nombre AS rubro_nombre, b.departamental_id, d.nombre AS departamental_nombre,
              b.alcance_todas, b.estado_id, e.nombre AS estado, e.color AS estado_color, e.color_texto AS estado_color_texto,
              b.habilitado, b.fecha_vigencia_desde, b.fecha_vigencia_hasta, b.cupo_maximo, b.mostrar_mapa,
              b.tarjeta_usa_logo, b.logo_archivo, b.fecha_creacion, b.fecha_modificacion,
              ${SELECT_INSCRIPTOS} AS inscriptos,
              (SELECT COUNT(*) FROM beneficio_observacion o WHERE o.beneficio_id = b.id) AS mensajes,
              (SELECT COUNT(*) FROM beneficio_departamental bd_n WHERE bd_n.beneficio_id = b.id) AS cantidad_departamentales
       ${from}
       WHERE ${where}
       ORDER BY ${orderBy} ${orderType}, b.id DESC
       LIMIT ? OFFSET ?`,
      [...paramsFinal, pageSize, (page - 1) * pageSize]
    );

    const results = [];
    for (const row of rows) {
      const cantidad = Number(row.cantidad_departamentales) || 0;
      results.push({
        id: row.id,
        codigo: `B-${row.id}`,
        nombre: row.nombre,
        rubro_id: row.rubro_id,
        rubro_nombre: row.rubro_nombre,
        departamental_id: row.departamental_id,
        departamental_nombre: row.departamental_nombre || "Provincial",
        alcance_todas: normalizarBooleano(row.alcance_todas),
        alcance_resumen: normalizarBooleano(row.alcance_todas) === 1
          ? "Todas"
          : `${cantidad} ${cantidad === 1 ? "departamental" : "departamentales"}`,
        estado_id: row.estado_id,
        estado: row.estado,
        estado_color: row.estado_color,
        estado_color_texto: row.estado_color_texto,
        habilitado: normalizarBooleano(row.habilitado),
        fecha_vigencia_desde: row.fecha_vigencia_desde,
        fecha_vigencia_hasta: row.fecha_vigencia_hasta,
        cupo_maximo: row.cupo_maximo,
        inscriptos: Number(row.inscriptos) || 0,
        mensajes: Number(row.mensajes) || 0,
        logo_url: await firmarSeguro(row.logo_archivo),
        tarjeta_usa_logo: normalizarBooleano(row.tarjeta_usa_logo),
        mostrar_mapa: normalizarBooleano(row.mostrar_mapa),
        fecha_creacion: row.fecha_creacion,
        fecha_modificacion: row.fecha_modificacion,
        puede_editar: puedeEditarBeneficio(cabecera, row),
        puede_eliminar: puedeEliminarBeneficio(cabecera, row),
        transiciones: transicionesDisponibles(cabecera, row.estado_id, esDepartamentalDuenia(cabecera, row)),
      });
    }

    // Resumen por estado con el mismo scope pero sin el filtro de estados
    const [resumen] = await db.query(
      `SELECT b.estado_id, COUNT(*) AS cantidad ${from} WHERE ${condiciones.join(" AND ")} GROUP BY b.estado_id`,
      params
    );

    res.status(200).json({ results, totalItems, page, pageSize, resumen });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los beneficios");
  }
});

// Procesa (valida + redimensiona) todas las imágenes del multipart antes de tocar S3 o la base
async function procesarImagenesFormulario(archivos) {
  const logo = archivos.logo?.[0]
    ? await procesarImagenBeneficio(archivos.logo[0], { anchoMaximo: ANCHO_MAXIMO_LOGO, etiqueta: "El logo" })
    : null;
  const galeria = [];
  for (let i = 0; i < (archivos.galeria || []).length; i++) {
    galeria.push(await procesarImagenBeneficio(archivos.galeria[i], {
      anchoMinimo: ANCHO_MINIMO_GALERIA,
      anchoMaximo: ANCHO_MAXIMO_GALERIA,
      etiqueta: `La imagen ${i + 1} de la galería`,
    }));
  }
  const pines = [];
  for (let i = 0; i < (archivos.pines_imagenes || []).length; i++) {
    pines.push(await procesarImagenBeneficio(archivos.pines_imagenes[i], {
      anchoMaximo: ANCHO_MAXIMO_PIN,
      etiqueta: `La imagen del pin ${i + 1}`,
    }));
  }
  return { logo, galeria, pines };
}

function archivoConvenio(archivos) {
  const file = archivos.convenio?.[0];
  if (!file) return null;
  return {
    buffer: file.buffer,
    contentType: file.mimetype,
    extension: extensionSegura(file.originalname, file.mimetype),
    nombre_original: String(file.originalname || "").slice(0, 260) || null,
  };
}

// ---------------------------------------------------------------------------
// POST /beneficios — alta (staff, multipart)
// Departamental: nace Pendiente, con su departamental como dueña e incluida en la
// segmentación, y el convenio firmado es obligatorio. Admin / admin-central: nace Aprobado.
// ---------------------------------------------------------------------------
router.post("/beneficios", verifyToken, manejarUploadBeneficio, async (req, res) => {
  let connection;
  let transaccionConfirmada = false;
  const objetosSubidos = [];
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const archivos = req.files && typeof req.files === "object" ? req.files : {};
    const db = mysqlConnection.promise();

    const { errores, datos } = await validarDatosBeneficio(db, req.body, {
      cantidadPines: (archivos.pines_imagenes || []).length,
    });
    let departamentalId = null;
    if (cabecera.rol === "departamental") {
      departamentalId = departamentalDeCabecera(cabecera);
      if (!departamentalId) return res.status(401).json("No autorizado");
      if (!archivos.convenio?.[0]) errores.push("Adjuntá el formulario de adhesión firmado");
      if (!datos.departamentales.includes(departamentalId)) datos.departamentales.push(departamentalId);
    } else {
      departamentalId = datos.departamental_id;
    }
    if (datos.alcance_todas === 0 && datos.departamentales.length === 0) {
      errores.push("Elegí al menos una departamental o marcá todas las departamentales");
    }
    if (errores.length > 0) return res.status(400).json(errores.join(" | "));

    const { logo, galeria, pines } = await procesarImagenesFormulario(archivos);
    const convenio = archivoConvenio(archivos);
    const estadoInicial = cabecera.rol === "departamental" ? ESTADO.PENDIENTE : ESTADO.APROBADO;

    connection = await db.getConnection();
    await connection.beginTransaction();

    let logoKey = null;
    if (logo) {
      logoKey = await subirArchivoBeneficio(logo, "logo");
      objetosSubidos.push(logoKey);
    }
    let convenioKey = null;
    if (convenio) {
      convenioKey = await subirArchivoBeneficio(convenio, "convenio");
      objetosSubidos.push(convenioKey);
    }

    const [resultado] = await connection.query(
      `INSERT INTO beneficio
         (nombre, razon_social, rubro_id, descripcion_corta, promocion_html,
          telefono, telefono_visible, sitio_web, sitio_web_visible, email_contacto, email_contacto_visible,
          dni_titulares, cupo_maximo, mostrar_mapa, fecha_vigencia_desde, fecha_vigencia_hasta, habilitado,
          tarjeta_usa_logo, logo_archivo, convenio_archivo, convenio_nombre_original, convenio_mime,
          email_aviso_inscripcion, mensaje_inscripcion_html, alcance_todas, departamental_id,
          creado_por_usuario_id, estado_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datos.nombre, datos.razon_social, datos.rubro_id, datos.descripcion_corta, datos.promocion_html,
        datos.telefono, datos.telefono_visible, datos.sitio_web, datos.sitio_web_visible, datos.email_contacto, datos.email_contacto_visible,
        datos.dni_titulares, datos.cupo_maximo, datos.mostrar_mapa, datos.fecha_vigencia_desde, datos.fecha_vigencia_hasta, datos.habilitado,
        datos.tarjeta_usa_logo, logoKey, convenioKey, convenio ? convenio.nombre_original : null, convenio ? convenio.contentType : null,
        datos.email_aviso_inscripcion, datos.mensaje_inscripcion_html, datos.alcance_todas, departamentalId,
        cabecera.id, estadoInicial,
      ]
    );
    const beneficioId = resultado.insertId;

    for (const sucursal of datos.sucursales) {
      let imagenKey = null;
      if (sucursal.imagen_index !== null) {
        imagenKey = await subirArchivoBeneficio(pines[sucursal.imagen_index], "pin");
        objetosSubidos.push(imagenKey);
      }
      await connection.query(
        `INSERT INTO beneficio_sucursal (beneficio_id, direccion, latitud, longitud, etiqueta, imagen_archivo, orden)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [beneficioId, sucursal.direccion, sucursal.latitud, sucursal.longitud, sucursal.etiqueta, imagenKey, sucursal.orden]
      );
    }

    for (let i = 0; i < galeria.length; i++) {
      const key = await subirArchivoBeneficio(galeria[i], "galeria");
      objetosSubidos.push(key);
      await connection.query(
        "INSERT INTO beneficio_imagen (beneficio_id, archivo, orden) VALUES (?, ?, ?)",
        [beneficioId, key, i]
      );
    }

    for (const depId of datos.departamentales) {
      await connection.query(
        "INSERT INTO beneficio_departamental (beneficio_id, departamental_id) VALUES (?, ?)",
        [beneficioId, depId]
      );
    }

    await vincularImagenesEditor(connection, beneficioId, [datos.promocion_html, datos.mensaje_inscripcion_html]);

    await registrarHistorial(connection, {
      beneficio_id: beneficioId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE",
      estado_nuevo_id: estadoInicial,
      observacion: cabecera.rol === "departamental"
        ? "Propuesta de beneficio cargada por la departamental"
        : `Beneficio cargado por ${cabecera.rol} (publicación directa)`,
    });

    if (cabecera.rol === "departamental") {
      const nombreDep = (await nombreDepartamental(connection, departamentalId)) || "una departamental";
      await notificarSuperiores(
        connection, "BENEFICIO_NUEVO",
        `Nueva propuesta de beneficio "${datos.nombre}" de ${nombreDep}`,
        `${nombreDep} propuso el beneficio "${datos.nombre}" (${datos.rubro_nombre}). Revisalo para aprobarlo, observarlo o rechazarlo.`,
        { beneficio_id: beneficioId, estado_id: estadoInicial },
        cabecera.id
      );
    }

    await connection.commit();
    transaccionConfirmada = true;
    res.status(201).json({
      success: true,
      id: beneficioId,
      message: estadoInicial === ESTADO.APROBADO
        ? "Beneficio creado y publicado"
        : "Propuesta enviada: queda pendiente de aprobación",
    });
  } catch (error) {
    if (connection && !transaccionConfirmada) await connection.rollback();
    if (!transaccionConfirmada) await eliminarObjetosS3Seguro(objetosSubidos);
    responderError(res, error, "Error al crear el beneficio");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// GET /beneficios/:id — detalle completo del back-office
// ---------------------------------------------------------------------------
router.get("/beneficios/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const beneficioId = normalizarIdPositivo(req.params.id);
    if (!beneficioId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    const departamentalConsulta = cabecera.rol === "departamental" ? departamentalDeCabecera(cabecera) : 0;

    const [rows] = await db.query(
      `SELECT b.*, r.nombre AS rubro_nombre, d.nombre AS departamental_nombre,
              e.nombre AS estado, e.color AS estado_color, e.color_texto AS estado_color_texto,
              CONCAT(cr.apellido, ', ', cr.nombre) AS creado_por_nombre,
              ${SELECT_INCLUYE_DEPARTAMENTAL} AS incluye_departamental,
              ${SELECT_INSCRIPTOS} AS inscriptos
       FROM beneficio b
       INNER JOIN beneficio_rubro r ON r.id = b.rubro_id
       INNER JOIN beneficio_estado e ON e.id = b.estado_id
       LEFT JOIN departamental d ON d.id = b.departamental_id
       LEFT JOIN usuario cr ON cr.id = b.creado_por_usuario_id
       WHERE b.id = ? AND b.eliminado = 0`,
      [departamentalConsulta, beneficioId]
    );
    if (rows.length === 0) return res.status(404).json("Beneficio no encontrado");
    const beneficio = rows[0];
    if (!puedeVerBeneficio(cabecera, beneficio)) return res.status(401).json("No autorizado");

    const [imagenes] = await db.query(
      "SELECT id, archivo, orden FROM beneficio_imagen WHERE beneficio_id = ? ORDER BY orden, id",
      [beneficioId]
    );
    const [sucursales] = await db.query(
      `SELECT id, direccion, latitud, longitud, etiqueta, imagen_archivo, orden
       FROM beneficio_sucursal WHERE beneficio_id = ? ORDER BY orden, id`,
      [beneficioId]
    );
    const [departamentales] = await db.query(
      "SELECT departamental_id FROM beneficio_departamental WHERE beneficio_id = ? ORDER BY departamental_id",
      [beneficioId]
    );
    const [observaciones] = await db.query(
      `SELECT o.id, o.usuario_id, o.usuario_rol, o.mensaje, o.estado_id, o.fecha_creacion,
              u.nombre AS usuario_nombre, u.apellido AS usuario_apellido, e.nombre AS estado_nombre
       FROM beneficio_observacion o
       LEFT JOIN usuario u ON u.id = o.usuario_id
       LEFT JOIN beneficio_estado e ON e.id = o.estado_id
       WHERE o.beneficio_id = ?
       ORDER BY o.fecha_creacion ASC, o.id ASC`,
      [beneficioId]
    );
    const [historial] = await db.query(
      `SELECT h.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido,
              CASE WHEN u.id IS NULL THEN NULL ELSE CONCAT(u.apellido, ', ', u.nombre) END AS modificador_nombre,
              ea.nombre AS estado_anterior, en.nombre AS estado_nuevo
       FROM beneficio_historial h
       LEFT JOIN usuario u ON u.id = h.usuario_id
       LEFT JOIN beneficio_estado ea ON ea.id = h.estado_anterior_id
       LEFT JOIN beneficio_estado en ON en.id = h.estado_nuevo_id
       WHERE h.beneficio_id = ?
       ORDER BY h.fecha DESC, h.id DESC`,
      [beneficioId]
    );

    const { convenio_archivo: convenioArchivo, incluye_departamental: _incluye, ...datos } = beneficio;
    const accesoCompleto = puedeVerDatosInternos(cabecera, beneficio);
    const respuesta = {
      ...datos,
      codigo: `B-${beneficio.id}`,
      departamental_nombre: beneficio.departamental_nombre || null,
      inscriptos: Number(beneficio.inscriptos) || 0,
      logo_url: await firmarSeguro(beneficio.logo_archivo),
      tiene_convenio: Boolean(convenioArchivo),
      promocion_html_render: await renderizarHtmlBeneficio(beneficio.promocion_html),
      mensaje_inscripcion_html_render: await renderizarHtmlBeneficio(beneficio.mensaje_inscripcion_html),
      imagenes: await firmarImagenes(imagenes),
      sucursales: await firmarSucursales(sucursales),
      departamentales: departamentales.map((fila) => fila.departamental_id),
      observaciones_hilo: observaciones,
      historial,
      cupo: calcularCupo(beneficio.cupo_maximo, beneficio.inscriptos),
      puede_editar: puedeEditarBeneficio(cabecera, beneficio),
      puede_eliminar: puedeEliminarBeneficio(cabecera, beneficio),
      puede_observar: puedeObservarBeneficio(cabecera, beneficio),
      transiciones: transicionesDisponibles(cabecera, beneficio.estado_id, esDepartamentalDuenia(cabecera, beneficio)),
    };
    if (!accesoCompleto) {
      // Departamental incluida pero no dueña: proyección de solo lectura, sin lo interno
      // del convenio ni el hilo administración↔dueña ni el historial.
      Object.assign(respuesta, {
        razon_social: null,
        dni_titulares: null,
        email_aviso_inscripcion: null,
        mensaje_inscripcion_html: null,
        mensaje_inscripcion_html_render: null,
        convenio_nombre_original: null,
        convenio_mime: null,
        tiene_convenio: false,
        observaciones_hilo: [],
        historial: [],
      });
    }
    res.status(200).json(respuesta);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el detalle del beneficio");
  }
});

// ---------------------------------------------------------------------------
// PUT /beneficios/:id — edición completa (multipart), con diff campo a campo al historial
//  - imagenes_existentes: JSON [ids en orden]; las ausentes se borran, las nuevas de `galeria` se agregan al final
//  - sucursales: JSON completo (reemplazo total: con id = UPDATE, sin id = INSERT, ausentes = DELETE)
//  - quitar_logo / quitar_convenio = '1'
// ---------------------------------------------------------------------------
router.put("/beneficios/:id(\\d+)", verifyToken, manejarUploadBeneficio, async (req, res) => {
  let connection;
  let transaccionConfirmada = false;
  const objetosSubidos = [];
  const objetosEliminarTrasCommit = [];
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const beneficioId = normalizarIdPositivo(req.params.id);
    if (!beneficioId) return res.status(400).json("ID inválido");
    const archivos = req.files && typeof req.files === "object" ? req.files : {};
    const db = mysqlConnection.promise();

    // Permisos ANTES de validar y de procesar imágenes (sharp sobre hasta 60 MB): una
    // cuenta sin acceso no debe poder gastar CPU repitiendo PUTs contra ids ajenos.
    // Se vuelve a leer con FOR UPDATE dentro de la transacción.
    const beneficioPrevio = await obtenerBeneficioStaff(db, beneficioId, cabecera);
    if (!beneficioPrevio || (cabecera.rol === "departamental" && !puedeVerBeneficio(cabecera, beneficioPrevio))) {
      return res.status(404).json("Beneficio no encontrado");
    }
    if (!puedeEditarBeneficio(cabecera, beneficioPrevio)) {
      return res.status(401).json("El beneficio no se puede editar en su estado actual");
    }

    const { errores, datos } = await validarDatosBeneficio(db, req.body, {
      cantidadPines: (archivos.pines_imagenes || []).length,
    });
    let imagenesExistentes = null;
    if (valorInformado(req.body.imagenes_existentes)) {
      imagenesExistentes = normalizarListaIds(req.body.imagenes_existentes, { maximoItems: MAX_IMAGENES_GALERIA });
      if (imagenesExistentes === null) errores.push("La lista de imágenes de la galería es inválida");
    }
    const quitarLogo = normalizarFlag(req.body.quitar_logo, 0);
    const quitarConvenio = normalizarFlag(req.body.quitar_convenio, 0);
    if (quitarLogo === null || quitarConvenio === null) errores.push("Los indicadores de quitar archivo son inválidos");
    if (cabecera.rol === "departamental") {
      const propia = departamentalDeCabecera(cabecera);
      if (!propia) return res.status(401).json("No autorizado");
      if (!datos.departamentales.includes(propia)) datos.departamentales.push(propia);
    }
    if (datos.alcance_todas === 0 && datos.departamentales.length === 0) {
      errores.push("Elegí al menos una departamental o marcá todas las departamentales");
    }
    if (errores.length > 0) return res.status(400).json(errores.join(" | "));

    const { logo, galeria, pines } = await procesarImagenesFormulario(archivos);
    const convenio = archivoConvenio(archivos);

    connection = await db.getConnection();
    await connection.beginTransaction();
    const beneficio = await obtenerBeneficioStaff(connection, beneficioId, cabecera, { forUpdate: true });
    if (!beneficio) {
      await connection.rollback();
      return res.status(404).json("Beneficio no encontrado");
    }
    if (!puedeEditarBeneficio(cabecera, beneficio)) {
      await connection.rollback();
      return res.status(401).json("El beneficio no se puede editar en su estado actual");
    }
    // Una departamental no puede quedarse sin el convenio; para superiores es opcional
    if (cabecera.rol === "departamental" && !convenio && (quitarConvenio === 1 || !beneficio.convenio_archivo)) {
      await connection.rollback();
      return res.status(400).json("Adjuntá el formulario de adhesión firmado");
    }

    // Departamental dueña: solo la cambian los superiores y solo si la mandan explícitamente
    let departamentalId = beneficio.departamental_id;
    if (esSuperior(cabecera) && Object.prototype.hasOwnProperty.call(req.body, "departamental_id")) {
      departamentalId = datos.departamental_id;
    }

    // ---- Diff campo a campo (etiquetas humanas) ----
    const cambios = [];
    for (const campo of CAMPOS_TEXTO_DIFF) {
      const anterior = beneficio[campo] === null || beneficio[campo] === undefined ? null : String(beneficio[campo]);
      const nuevo = datos[campo] === null || datos[campo] === undefined ? null : String(datos[campo]);
      if (anterior !== nuevo) cambios.push({ campo, anterior: anterior ?? "—", nuevo: nuevo ?? "—" });
    }
    for (const campo of CAMPOS_BOOLEANOS_DIFF) {
      const anterior = normalizarBooleano(beneficio[campo]);
      if (anterior !== datos[campo]) cambios.push({ campo, anterior: anterior ? "Sí" : "No", nuevo: datos[campo] ? "Sí" : "No" });
    }
    for (const campo of CAMPOS_HTML_DIFF) {
      if ((beneficio[campo] || null) !== (datos[campo] || null)) {
        cambios.push({
          campo,
          anterior: resumenHtml(beneficio[campo]) || "(sin contenido)",
          nuevo: resumenHtml(datos[campo]) || "(sin contenido)",
        });
      }
    }
    if (!idsPositivosIguales(beneficio.rubro_id, datos.rubro_id)) {
      const [rubrosAnteriores] = await connection.query("SELECT nombre FROM beneficio_rubro WHERE id = ?", [beneficio.rubro_id]);
      cambios.push({ campo: "rubro_id", anterior: rubrosAnteriores[0]?.nombre || "—", nuevo: datos.rubro_nombre || "—" });
    }
    if ((normalizarIdPositivo(beneficio.departamental_id) || null) !== (normalizarIdPositivo(departamentalId) || null)) {
      cambios.push({
        campo: "departamental_id",
        anterior: (await nombreDepartamental(connection, beneficio.departamental_id)) || "Provincial",
        nuevo: (await nombreDepartamental(connection, departamentalId)) || "Provincial",
      });
    }
    const [departamentalesActuales] = await connection.query(
      `SELECT d.id, d.nombre FROM beneficio_departamental bd INNER JOIN departamental d ON d.id = bd.departamental_id
       WHERE bd.beneficio_id = ?`,
      [beneficioId]
    );
    const idsDepActuales = departamentalesActuales.map((d) => d.id).sort((a, b) => a - b);
    const idsDepNuevos = datos.departamentales.slice().sort((a, b) => a - b);
    if (JSON.stringify(idsDepActuales) !== JSON.stringify(idsDepNuevos)) {
      let nombresNuevos = [];
      if (idsDepNuevos.length > 0) {
        const [filas] = await connection.query(
          `SELECT nombre FROM departamental WHERE id IN (${idsDepNuevos.map(() => "?").join(",")}) ORDER BY nombre`,
          idsDepNuevos
        );
        nombresNuevos = filas.map((f) => f.nombre);
      }
      cambios.push({
        campo: "departamentales",
        anterior: departamentalesActuales.map((d) => d.nombre).sort().join(", ") || "—",
        nuevo: nombresNuevos.join(", ") || "—",
      });
    }
    const [sucursalesActuales] = await connection.query(
      "SELECT id, direccion, latitud, longitud, etiqueta, imagen_archivo, orden FROM beneficio_sucursal WHERE beneficio_id = ? ORDER BY orden, id",
      [beneficioId]
    );
    if (sucursalesActuales.map(firmaSucursal).join("||") !== datos.sucursales.map(firmaSucursal).join("||")) {
      cambios.push({ campo: "sucursales", anterior: describirSucursales(sucursalesActuales), nuevo: describirSucursales(datos.sucursales) });
    }

    // ---- Escalares ----
    await connection.query(
      `UPDATE beneficio
       SET nombre = ?, razon_social = ?, rubro_id = ?, descripcion_corta = ?, promocion_html = ?,
           telefono = ?, telefono_visible = ?, sitio_web = ?, sitio_web_visible = ?, email_contacto = ?, email_contacto_visible = ?,
           dni_titulares = ?, cupo_maximo = ?, mostrar_mapa = ?, fecha_vigencia_desde = ?, fecha_vigencia_hasta = ?, habilitado = ?,
           tarjeta_usa_logo = ?, email_aviso_inscripcion = ?, mensaje_inscripcion_html = ?, alcance_todas = ?, departamental_id = ?
       WHERE id = ?`,
      [
        datos.nombre, datos.razon_social, datos.rubro_id, datos.descripcion_corta, datos.promocion_html,
        datos.telefono, datos.telefono_visible, datos.sitio_web, datos.sitio_web_visible, datos.email_contacto, datos.email_contacto_visible,
        datos.dni_titulares, datos.cupo_maximo, datos.mostrar_mapa, datos.fecha_vigencia_desde, datos.fecha_vigencia_hasta, datos.habilitado,
        datos.tarjeta_usa_logo, datos.email_aviso_inscripcion, datos.mensaje_inscripcion_html, datos.alcance_todas, departamentalId,
        beneficioId,
      ]
    );

    const historialBase = { beneficio_id: beneficioId, usuario_id: cabecera.id, usuario_rol: cabecera.rol };

    // ---- Logo ----
    if (logo) {
      const key = await subirArchivoBeneficio(logo, "logo");
      objetosSubidos.push(key);
      if (beneficio.logo_archivo) objetosEliminarTrasCommit.push(beneficio.logo_archivo);
      await connection.query("UPDATE beneficio SET logo_archivo = ? WHERE id = ?", [key, beneficioId]);
      await registrarHistorial(connection, {
        ...historialBase,
        tipo_operacion: "ARCHIVO",
        campo_modificado: ETIQUETAS_CAMPOS.logo,
        observacion: beneficio.logo_archivo ? "Se reemplazó el logo" : "Se cargó el logo",
      });
    } else if (quitarLogo === 1 && beneficio.logo_archivo) {
      objetosEliminarTrasCommit.push(beneficio.logo_archivo);
      await connection.query("UPDATE beneficio SET logo_archivo = NULL WHERE id = ?", [beneficioId]);
      await registrarHistorial(connection, { ...historialBase, tipo_operacion: "ARCHIVO", campo_modificado: ETIQUETAS_CAMPOS.logo, observacion: "Se quitó el logo" });
    }

    // ---- Convenio ----
    if (convenio) {
      const key = await subirArchivoBeneficio(convenio, "convenio");
      objetosSubidos.push(key);
      if (beneficio.convenio_archivo) objetosEliminarTrasCommit.push(beneficio.convenio_archivo);
      await connection.query(
        "UPDATE beneficio SET convenio_archivo = ?, convenio_nombre_original = ?, convenio_mime = ? WHERE id = ?",
        [key, convenio.nombre_original, convenio.contentType, beneficioId]
      );
      await registrarHistorial(connection, {
        ...historialBase,
        tipo_operacion: "ARCHIVO",
        campo_modificado: ETIQUETAS_CAMPOS.convenio,
        observacion: `${beneficio.convenio_archivo ? "Se reemplazó" : "Se adjuntó"} el convenio "${convenio.nombre_original || "convenio"}"`,
      });
    } else if (quitarConvenio === 1 && beneficio.convenio_archivo) {
      objetosEliminarTrasCommit.push(beneficio.convenio_archivo);
      await connection.query(
        "UPDATE beneficio SET convenio_archivo = NULL, convenio_nombre_original = NULL, convenio_mime = NULL WHERE id = ?",
        [beneficioId]
      );
      await registrarHistorial(connection, {
        ...historialBase,
        tipo_operacion: "ARCHIVO",
        campo_modificado: ETIQUETAS_CAMPOS.convenio,
        observacion: `Se quitó el convenio "${beneficio.convenio_nombre_original || "convenio"}"`,
      });
    }

    // ---- Galería ----
    const [imagenesActuales] = await connection.query(
      "SELECT id, archivo, orden FROM beneficio_imagen WHERE beneficio_id = ? ORDER BY orden, id",
      [beneficioId]
    );
    let ordenSiguiente = imagenesActuales.length;
    if (imagenesExistentes !== null) {
      const idsActuales = new Set(imagenesActuales.map((imagen) => imagen.id));
      if (imagenesExistentes.some((id) => !idsActuales.has(id))) {
        await connection.rollback();
        return res.status(400).json("Alguna imagen de la galería no pertenece al beneficio");
      }
      const aEliminar = imagenesActuales.filter((imagen) => !imagenesExistentes.includes(imagen.id));
      for (const imagen of aEliminar) {
        await connection.query("DELETE FROM beneficio_imagen WHERE id = ?", [imagen.id]);
        objetosEliminarTrasCommit.push(imagen.archivo);
      }
      if (aEliminar.length > 0) {
        await registrarHistorial(connection, {
          ...historialBase,
          tipo_operacion: "ARCHIVO",
          campo_modificado: ETIQUETAS_CAMPOS.galeria,
          observacion: `Se ${aEliminar.length === 1 ? "quitó 1 imagen" : `quitaron ${aEliminar.length} imágenes`} de la galería`,
        });
      }
      for (let i = 0; i < imagenesExistentes.length; i++) {
        await connection.query("UPDATE beneficio_imagen SET orden = ? WHERE id = ?", [i, imagenesExistentes[i]]);
      }
      ordenSiguiente = imagenesExistentes.length;
    }
    if (galeria.length > 0) {
      if (ordenSiguiente + galeria.length > MAX_IMAGENES_GALERIA) {
        await connection.rollback();
        return res.status(400).json(`La galería admite hasta ${MAX_IMAGENES_GALERIA} imágenes`);
      }
      for (const imagen of galeria) {
        const key = await subirArchivoBeneficio(imagen, "galeria");
        objetosSubidos.push(key);
        await connection.query(
          "INSERT INTO beneficio_imagen (beneficio_id, archivo, orden) VALUES (?, ?, ?)",
          [beneficioId, key, ordenSiguiente++]
        );
      }
      await registrarHistorial(connection, {
        ...historialBase,
        tipo_operacion: "ARCHIVO",
        campo_modificado: ETIQUETAS_CAMPOS.galeria,
        observacion: `Se ${galeria.length === 1 ? "agregó 1 imagen" : `agregaron ${galeria.length} imágenes`} a la galería`,
      });
    }

    // ---- Sucursales (reemplazo total) ----
    const sucursalesPorId = new Map(sucursalesActuales.map((s) => [s.id, s]));
    for (const sucursal of datos.sucursales) {
      if (sucursal.id !== null && !sucursalesPorId.has(sucursal.id)) {
        await connection.rollback();
        return res.status(400).json("Alguna sucursal no pertenece al beneficio");
      }
    }
    const idsEnviados = new Set(datos.sucursales.filter((s) => s.id !== null).map((s) => s.id));
    for (const actual of sucursalesActuales) {
      if (idsEnviados.has(actual.id)) continue;
      await connection.query("DELETE FROM beneficio_sucursal WHERE id = ?", [actual.id]);
      if (actual.imagen_archivo) objetosEliminarTrasCommit.push(actual.imagen_archivo);
    }
    for (const sucursal of datos.sucursales) {
      const actual = sucursal.id !== null ? sucursalesPorId.get(sucursal.id) : null;
      let imagenKey = actual ? actual.imagen_archivo : null;
      if (sucursal.imagen_index !== null) {
        const key = await subirArchivoBeneficio(pines[sucursal.imagen_index], "pin");
        objetosSubidos.push(key);
        if (imagenKey) objetosEliminarTrasCommit.push(imagenKey);
        imagenKey = key;
      } else if (sucursal.quitar_imagen === 1 && imagenKey) {
        objetosEliminarTrasCommit.push(imagenKey);
        imagenKey = null;
      }
      if (actual) {
        await connection.query(
          `UPDATE beneficio_sucursal
           SET direccion = ?, latitud = ?, longitud = ?, etiqueta = ?, imagen_archivo = ?, orden = ?
           WHERE id = ?`,
          [sucursal.direccion, sucursal.latitud, sucursal.longitud, sucursal.etiqueta, imagenKey, sucursal.orden, sucursal.id]
        );
      } else {
        await connection.query(
          `INSERT INTO beneficio_sucursal (beneficio_id, direccion, latitud, longitud, etiqueta, imagen_archivo, orden)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [beneficioId, sucursal.direccion, sucursal.latitud, sucursal.longitud, sucursal.etiqueta, imagenKey, sucursal.orden]
        );
      }
    }

    // ---- Segmentación ----
    await connection.query("DELETE FROM beneficio_departamental WHERE beneficio_id = ?", [beneficioId]);
    for (const depId of datos.departamentales) {
      await connection.query(
        "INSERT INTO beneficio_departamental (beneficio_id, departamental_id) VALUES (?, ?)",
        [beneficioId, depId]
      );
    }

    await vincularImagenesEditor(connection, beneficioId, [datos.promocion_html, datos.mensaje_inscripcion_html]);

    for (const cambio of cambios) {
      await registrarHistorial(connection, {
        ...historialBase,
        tipo_operacion: "UPDATE",
        campo_modificado: ETIQUETAS_CAMPOS[cambio.campo] || cambio.campo,
        valor_anterior: cambio.anterior,
        valor_nuevo: cambio.nuevo,
      });
    }

    await connection.commit();
    transaccionConfirmada = true;
    await eliminarObjetosS3Seguro(objetosEliminarTrasCommit);
    res.status(200).json({ success: true, id: beneficioId, message: "Beneficio actualizado correctamente" });
  } catch (error) {
    if (connection && !transaccionConfirmada) await connection.rollback();
    if (!transaccionConfirmada) await eliminarObjetosS3Seguro(objetosSubidos);
    responderError(res, error, "Error al actualizar el beneficio");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /beneficios/:id/estado — flujo de aprobación
// ---------------------------------------------------------------------------
router.put("/beneficios/:id(\\d+)/estado", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const beneficioId = normalizarIdPositivo(req.params.id);
    const estadoNuevo = normalizarIdPositivo(req.body?.estado_id);
    const observacion = normalizarTexto(req.body?.observacion);
    if (!beneficioId || !estadoNuevo) return res.status(400).json("Datos incompletos");
    if (!Object.values(ESTADO).includes(estadoNuevo)) return res.status(400).json("Estado inválido");
    if (observacion && observacion.length > 5000) {
      return res.status(400).json("La observación es demasiado larga (máximo 5000 caracteres)");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const beneficio = await obtenerBeneficioStaff(connection, beneficioId, cabecera, { forUpdate: true });
    if (!beneficio) {
      await connection.rollback();
      return res.status(404).json("Beneficio no encontrado");
    }
    const esPropia = esDepartamentalDuenia(cabecera, beneficio);
    const transiciones = transicionesDisponibles(cabecera, beneficio.estado_id, esPropia);
    if (!puedeVerBeneficio(cabecera, beneficio) || !transiciones.includes(estadoNuevo)) {
      await connection.rollback();
      return res.status(401).json("No podés aplicar ese cambio de estado");
    }

    await connection.query("UPDATE beneficio SET estado_id = ? WHERE id = ?", [estadoNuevo, beneficioId]);
    await registrarHistorial(connection, {
      beneficio_id: beneficioId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "CAMBIO_ESTADO",
      estado_anterior_id: beneficio.estado_id,
      estado_nuevo_id: estadoNuevo,
      observacion,
    });
    if (observacion) {
      await connection.query(
        "INSERT INTO beneficio_observacion (beneficio_id, usuario_id, usuario_rol, mensaje, estado_id) VALUES (?, ?, ?, ?, ?)",
        [beneficioId, cabecera.id, cabecera.rol, observacion, estadoNuevo]
      );
    }

    const [estados] = await connection.query("SELECT nombre FROM beneficio_estado WHERE id = ?", [estadoNuevo]);
    const nombreEstado = estados.length > 0 ? estados[0].nombre : "";
    const payload = { beneficio_id: beneficioId, estado_id: estadoNuevo };
    const detalle = `Nueva situación: ${nombreEstado}.${observacion ? ` Observación: ${observacion}` : ""}`;
    const nombre = beneficio.nombre;
    const tituloDepartamental = ({
      [ESTADO.APROBADO]: `El beneficio "${nombre}" fue aprobado y ya está publicado`,
      [ESTADO.OBSERVADO]: `El beneficio "${nombre}" fue observado: revisá los mensajes`,
      [ESTADO.RECHAZADO]: `El beneficio "${nombre}" fue rechazado`,
      [ESTADO.PENDIENTE]: `El beneficio "${nombre}" volvió a Pendiente de aprobación`,
    })[estadoNuevo];
    await notificarUsuariosDepartamental(
      connection, beneficio.departamental_id, "BENEFICIO_ESTADO", tituloDepartamental, detalle, payload, cabecera.id
    );
    if (estadoNuevo === ESTADO.PENDIENTE) {
      const nombreDep = (await nombreDepartamental(connection, beneficio.departamental_id)) || "La departamental";
      await notificarSuperiores(
        connection, "BENEFICIO_ESTADO",
        cabecera.rol === "departamental"
          ? `${nombreDep} reenvió el beneficio "${nombre}" para su aprobación`
          : `El beneficio "${nombre}" volvió a Pendiente de aprobación`,
        detalle, payload, cabecera.id
      );
    }

    await connection.commit();
    res.status(200).json({ success: true, message: `El beneficio pasó a "${nombreEstado}"`, estado_id: estadoNuevo });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    res.status(500).json("Error al cambiar el estado del beneficio");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// POST /beneficios/:id/observaciones — chat administración <-> departamental dueña
// ---------------------------------------------------------------------------
router.post("/beneficios/:id(\\d+)/observaciones", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const beneficioId = normalizarIdPositivo(req.params.id);
    const mensaje = normalizarTexto(req.body?.mensaje);
    if (!beneficioId || !mensaje) return res.status(400).json("El mensaje es obligatorio");
    if (mensaje.length > 5000) return res.status(400).json("El mensaje es demasiado largo (máximo 5000 caracteres)");

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const beneficio = await obtenerBeneficioStaff(connection, beneficioId, cabecera, { forUpdate: true });
    if (!beneficio) {
      await connection.rollback();
      return res.status(404).json("Beneficio no encontrado");
    }
    if (!puedeObservarBeneficio(cabecera, beneficio)) {
      await connection.rollback();
      return res.status(401).json("No autorizado");
    }

    await connection.query(
      "INSERT INTO beneficio_observacion (beneficio_id, usuario_id, usuario_rol, mensaje, estado_id) VALUES (?, ?, ?, ?, ?)",
      [beneficioId, cabecera.id, cabecera.rol, mensaje, beneficio.estado_id]
    );
    await registrarHistorial(connection, {
      beneficio_id: beneficioId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "OBSERVACION",
      observacion: mensaje,
    });

    const payload = { beneficio_id: beneficioId, estado_id: beneficio.estado_id };
    const titulo = `Nuevo mensaje en el beneficio "${beneficio.nombre}"`;
    if (cabecera.rol === "departamental") {
      const nombreDep = (await nombreDepartamental(connection, cabecera.departamental_id)) || "La departamental";
      await notificarSuperiores(connection, "BENEFICIO_OBSERVACION", titulo, `${nombreDep} escribió: ${mensaje}`, payload, cabecera.id);
    } else {
      await notificarUsuariosDepartamental(
        connection, beneficio.departamental_id, "BENEFICIO_OBSERVACION", titulo, `Administración escribió: ${mensaje}`, payload, cabecera.id
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, message: "Mensaje enviado" });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    res.status(500).json("Error al enviar el mensaje");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /beneficios/:id/habilitado — acción rápida de la tabla
// ---------------------------------------------------------------------------
router.put("/beneficios/:id(\\d+)/habilitado", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const beneficioId = normalizarIdPositivo(req.params.id);
    const habilitado = normalizarBooleanoEntrada(req.body?.habilitado);
    if (!beneficioId) return res.status(400).json("ID inválido");
    if (habilitado === null) return res.status(400).json("El valor de habilitado es inválido");

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const beneficio = await obtenerBeneficioStaff(connection, beneficioId, cabecera, { forUpdate: true });
    if (!beneficio) {
      await connection.rollback();
      return res.status(404).json("Beneficio no encontrado");
    }
    if (!puedeEditarBeneficio(cabecera, beneficio)) {
      await connection.rollback();
      return res.status(401).json("El beneficio no se puede editar en su estado actual");
    }
    if (normalizarBooleano(beneficio.habilitado) === habilitado) {
      await connection.rollback();
      return res.status(200).json({ success: true, message: "Sin cambios", habilitado });
    }

    await connection.query("UPDATE beneficio SET habilitado = ? WHERE id = ?", [habilitado, beneficioId]);
    await registrarHistorial(connection, {
      beneficio_id: beneficioId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "UPDATE",
      campo_modificado: ETIQUETAS_CAMPOS.habilitado,
      valor_anterior: normalizarBooleano(beneficio.habilitado) ? "Sí" : "No",
      valor_nuevo: habilitado ? "Sí" : "No",
    });
    await connection.commit();
    res.status(200).json({
      success: true,
      message: habilitado ? "Beneficio habilitado" : "Beneficio deshabilitado",
      habilitado,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    res.status(500).json("Error al cambiar la habilitación del beneficio");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// DELETE /beneficios/:id — baja lógica
// ---------------------------------------------------------------------------
router.delete("/beneficios/:id(\\d+)", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const beneficioId = normalizarIdPositivo(req.params.id);
    if (!beneficioId) return res.status(400).json("ID inválido");
    const motivo = normalizarTexto(req.body?.motivo) || "Beneficio eliminado";
    if (motivo.length > 5000) return res.status(400).json("El motivo es demasiado largo (máximo 5000 caracteres)");

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const beneficio = await obtenerBeneficioStaff(connection, beneficioId, cabecera, { forUpdate: true });
    if (!beneficio) {
      await connection.rollback();
      return res.status(404).json("Beneficio no encontrado");
    }
    if (!puedeEliminarBeneficio(cabecera, beneficio)) {
      await connection.rollback();
      return res.status(401).json("No autorizado");
    }
    await connection.query("UPDATE beneficio SET eliminado = 1 WHERE id = ?", [beneficioId]);
    await registrarHistorial(connection, {
      beneficio_id: beneficioId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE",
      observacion: motivo,
    });
    await connection.commit();
    res.status(200).json({ success: true, message: "Beneficio eliminado" });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    res.status(500).json("Error al eliminar el beneficio");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// GET /beneficios/:id/convenio/descargar — convenio firmado (stream, patrón coseguro)
// ---------------------------------------------------------------------------
router.get("/beneficios/:id(\\d+)/convenio/descargar", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const beneficioId = normalizarIdPositivo(req.params.id);
    if (!beneficioId) return res.status(400).json("ID inválido");

    const beneficio = await obtenerBeneficioStaff(mysqlConnection.promise(), beneficioId, cabecera);
    if (!beneficio) return res.status(404).json("Beneficio no encontrado");
    if (!puedeVerBeneficio(cabecera, beneficio)) return res.status(401).json("No autorizado");
    // El convenio firmado es interno: solo superiores y la departamental dueña
    if (!puedeVerDatosInternos(cabecera, beneficio)) return res.status(401).json("No autorizado");
    if (!beneficio.convenio_archivo) return res.status(404).json("El beneficio no tiene convenio adjunto");

    const objeto = await getObjectBufferFromS3(beneficio.convenio_archivo);
    if (!objeto) return res.status(404).json("El archivo no está disponible");

    const nombre = beneficio.convenio_nombre_original || beneficio.convenio_archivo.split("/").pop();
    res.setHeader("Content-Type", beneficio.convenio_mime || objeto.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(nombre)}"`);
    res.status(200).send(objeto.buffer);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al descargar el convenio");
  }
});

router.__test = Object.freeze({
  verifyToken,
  ESTADO,
  ESTADO_INSCRIPCION,
  ESTADOS_AVISO_ENTIDAD,
  ETIQUETAS_CAMPOS,
  ROLES_STAFF,
  ROLES_SUPERIORES,
  CONDICION_PUBLICABLE,
  contenidoCoincideConMime,
  normalizarMimeImagen,
  procesarImagenBeneficio,
  renderizarHtmlBeneficio,
  normalizarIdPositivo,
  normalizarListaIds,
  normalizarDniTitulares,
  normalizarEmailOpcional,
  normalizarSitioWeb,
  normalizarSucursales,
  normalizarFlag,
  calcularCupo,
  formatearFechaCivil,
  describirVigencia,
  sanitizarHtmlBeneficio,
  normalizarHtmlBeneficio,
  extraerArchivosEditor,
  resumenHtml,
  describirMotivoCorreo,
  esDepartamentalDuenia,
  puedeVerBeneficio,
  puedeVerDatosInternos,
  puedeEditarBeneficio,
  puedeEliminarBeneficio,
  puedeObservarBeneficio,
  transicionesDisponibles,
  firmaSucursal,
  describirSucursales,
});

module.exports = router;
