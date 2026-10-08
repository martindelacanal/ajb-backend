const express = require("express");
const router = express.Router();
const mysqlConnection = require("../connection/connection");
const jwt = require("jsonwebtoken");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const multer = require("multer");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  crearServicioNoticiaMedia,
  descriptorPersistible,
  MAX_TOTAL_UPLOAD_BYTES,
  normalizarBasePublica,
  validarLoteImagenes,
} = require("../services/noticia-media");

// ═══════════════════════════════════════════════════════════════════════════
// NOTICIAS · Portada institucional pública + administración de la redacción.
// Público: /noticias/publicas* (sin token). Gestión: /admin/noticias* (roles admin y prensa).
// Portal departamental del afiliado: /noticias/departamental* (rol afiliado): las noticias
// de su departamental más las que van a todas las departamentales (alcance_todas = 1).
// ═══════════════════════════════════════════════════════════════════════════

// S3 INICIO
const bucketName = process.env.BUCKET_NAME;
const bucketRegion = process.env.BUCKET_REGION;
const accessKey = process.env.ACCESS_KEY;
const secretAccessKey = process.env.SECRET_ACCESS_KEY;
const PUBLIC_NEWS_MEDIA_BASE_URL = normalizarBasePublica(process.env.PUBLIC_NEWS_MEDIA_BASE_URL);

const s3SignedUrlExpiresConfigurado = Number(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || "3600");
const S3_SIGNED_URL_EXPIRES_SECONDS = Number.isSafeInteger(s3SignedUrlExpiresConfigurado)
  && s3SignedUrlExpiresConfigurado >= 60
  && s3SignedUrlExpiresConfigurado <= 86400
  ? s3SignedUrlExpiresConfigurado
  : 3600;

const s3 = new S3Client({
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretAccessKey,
  },
  region: bucketRegion,
});

const MIME_IMAGEN_NOTICIA_PERMITIDO = new Set(["image/jpeg", "image/png", "image/webp"]);

function contenidoCoincideConMime(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;

  switch (file.mimetype) {
    case "image/jpeg":
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/png":
      return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    default:
      return false;
  }
}

function archivosSubidos(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === "object") return Object.values(req.files).flat();
  return [];
}

function validarContenidoArchivos(req, res, next) {
  const archivos = archivosSubidos(req);
  if (!archivos.every(contenidoCoincideConMime)) {
    res.status(400).json("El contenido del archivo no coincide con un formato permitido");
    return;
  }
  try {
    validarLoteImagenes(archivos);
    next();
  } catch (error) {
    res.status(error.statusCode || 400).json(error.message);
  }
}

async function uploadBufferToS3({ key, buffer, contentType, cacheControl }) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ...(cacheControl ? { CacheControl: cacheControl } : {}),
    })
  );
}

async function getSignedFileUrlFromS3(key) {
  if (!key) {
    return null;
  }

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    }),
    { expiresIn: S3_SIGNED_URL_EXPIRES_SECONDS }
  );
}

async function deleteFileFromS3(key) {
  if (!key) {
    return;
  }

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    })
  );
}

const noticiaMedia = crearServicioNoticiaMedia({
  subirObjeto: uploadBufferToS3,
  eliminarObjeto: deleteFileFromS3,
  firmarObjeto: getSignedFileUrlFromS3,
  publicBaseUrl: PUBLIC_NEWS_MEDIA_BASE_URL,
});
// S3 FIN

const uploadImagenesNoticia = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 9,
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const campoValido = file.fieldname === "imagen" || file.fieldname === "galeria";
    if (campoValido && MIME_IMAGEN_NOTICIA_PERMITIDO.has(file.mimetype)) {
      return cb(null, true);
    }
    return cb(new Error("Solo se permiten imágenes JPG, PNG o WebP"));
  },
}).fields([
  { name: "imagen", maxCount: 1 },
  { name: "galeria", maxCount: 8 },
]);

function manejarUploadNoticia(req, res, next) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_UPLOAD_BYTES + (2 * 1024 * 1024)) {
    return res.status(413).json("La solicitud supera el límite total permitido para imágenes");
  }
  uploadImagenesNoticia(req, res, (error) => {
    if (error) {
      // Multer arma los errores de límite en inglés ("File too large", "Unexpected field"…):
      // se traducen por código; los del fileFilter ya vienen en español.
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") return res.status(400).json("Cada imagen puede pesar hasta 10 MB");
        if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json("Podés subir una imagen de portada y hasta 8 en la galería");
        }
        return res.status(400).json("No se pudo procesar la imagen");
      }
      return res.status(400).json(error.message || "No se pudo procesar la imagen");
    }
    return validarContenidoArchivos(req, res, next);
  });
}

function verifyToken(req, res, next) {
  return verificarTokenConAutorizacionActual({
    req,
    res,
    next,
    jwt,
    jwtSecret: process.env.JWT_SECRET,
    db: mysqlConnection.promise(),
    mensajeAuthorization: "Tu sesión no es válida. Volvé a iniciar sesión.",
  });
}

function getCabecera(req) {
  return JSON.parse(req.data.data);
}

const puedeGestionarNoticias = (cabecera) => (
  cabecera?.rol === "admin" || cabecera?.rol === "prensa"
);

const ESTADOS_NOTICIA = ["BORRADOR", "PUBLICADA", "ARCHIVADA"];
const MAX_IMAGENES_GALERIA = 12;
const MAX_LARGO_CUERPO = 120000;
// Las destacadas rotan en el carrusel de la portada pública.
const MAX_NOTICIAS_DESTACADAS = 5;
const LOCK_NOTICIAS_DESTACADAS_TIMEOUT_SEGUNDOS = 5;
const EXPRESION_NOMBRE_LOCK_DESTACADAS = "CONCAT('noticias_destacadas:', DATABASE())";

// La condición de visibilidad pública se reutiliza en todos los listados sin token.
const CONDICION_PUBLICA = "n.eliminado = 0 AND n.estado = 'PUBLICADA' AND (n.fecha_publicacion IS NULL OR n.fecha_publicacion <= NOW())";
const ORDEN_FEED = "n.orden DESC, COALESCE(n.fecha_publicacion, n.fecha_creacion) DESC, n.id DESC";

// ── Alcance por departamental ────────────────────────────────────────────────
// Una noticia se ve en el portal de todas las departamentales (alcance_todas = 1) o sólo en
// las de la tabla puente noticia_departamental. La columna heredada noticia.departamental_id
// guarda el id cuando hay EXACTAMENTE una departamental elegida; NULL en cualquier otro caso.
const MAX_DEPARTAMENTALES_NOTICIA = 50;
const MENSAJE_ALCANCE_SIN_DEPARTAMENTALES = "Elegí al menos una departamental o marcá «Todas las departamentales»";
const MENSAJE_DEPARTAMENTALES_INVALIDAS = "Hay departamentales inválidas en el alcance";
// Se ve en el portal de una departamental (param: su id; 0 = sólo las de todas).
const CONDICION_ALCANCE_PORTAL = "(n.alcance_todas = 1 OR EXISTS (SELECT 1 FROM noticia_departamental nd WHERE nd.noticia_id = n.id AND nd.departamental_id = ?))";
// Elegida específicamente para una departamental (param: su id).
const CONDICION_SOLO_DEPARTAMENTAL = "(n.alcance_todas = 0 AND EXISTS (SELECT 1 FROM noticia_departamental nd WHERE nd.noticia_id = n.id AND nd.departamental_id = ?))";
const COLADOR_ES = new Intl.Collator("es", { sensitivity: "base", numeric: true });

// ── Portal departamental del afiliado ────────────────────────────────────────
const MENSAJE_SOLO_AFILIADOS = "Sólo los afiliados ven el portal de su departamental";
const CONDICION_PORTAL = `${CONDICION_PUBLICA} AND ${CONDICION_ALCANCE_PORTAL}`;
const MAX_PAGINA_PORTAL = 30;
const DIAS_RESUMEN_POR_DEFECTO = 14;
const TOPE_RESUMEN_NUEVAS = 99;
const ORIGENES_PORTAL = new Set(["propias", "generales"]);

const SQL_GALERIA_NOTICIA = "SELECT id, archivo, epigrafe, orden, ancho, alto, mime, variantes FROM noticia_imagen WHERE noticia_id = ? ORDER BY orden ASC, id ASC";

function normalizarTexto(valor) {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  return texto.length ? texto : null;
}

function normalizarIdPositivo(valor) {
  if (typeof valor === "number" && Number.isSafeInteger(valor) && valor > 0) return valor;
  if (typeof valor === "string" && /^\d+$/.test(valor.trim())) {
    const numero = Number(valor.trim());
    if (Number.isSafeInteger(numero) && numero > 0) return numero;
  }
  return null;
}

function normalizarPaginacion(query, tamanioPorDefecto = 10, tamanioMaximo = 100) {
  const page = query?.page === undefined || query?.page === "" ? 1 : normalizarIdPositivo(query.page);
  const pageSize = query?.pageSize === undefined || query?.pageSize === "" ? tamanioPorDefecto : normalizarIdPositivo(query.pageSize);
  if (page === null || pageSize === null || page > 1_000_000 || pageSize > tamanioMaximo) return null;
  return { page, pageSize, start: (page - 1) * pageSize };
}

function normalizarIdsExcluidos(valor) {
  if (valor === undefined || valor === null || valor === "") return [];
  if (typeof valor !== "string") return null;
  const partes = valor.split(",");
  if (partes.length > MAX_NOTICIAS_DESTACADAS) return null;

  const ids = [];
  for (const parte of partes) {
    const id = normalizarIdPositivo(parte);
    if (!id) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizarBooleanoBinario(valor, porDefecto = 0) {
  if (valor === undefined || valor === null || valor === "") return porDefecto;
  if (valor === 1 || valor === "1" || valor === true || valor === "true") return 1;
  if (valor === 0 || valor === "0" || valor === false || valor === "false") return 0;
  return null;
}

function valorPresente(valor) {
  return valor !== undefined && valor !== null && !(typeof valor === "string" && valor.trim() === "");
}

// Departamentales elegidas para una noticia: string JSON ("[1,7,9]"), CSV ("1,7,9"),
// campo multipart repetido (multer arma un array) o array nativo. Devuelve los ids en el
// orden recibido; null si hay ids inválidos, repetidos o más de MAX_DEPARTAMENTALES_NOTICIA.
function normalizarListaDepartamentales(valor) {
  if (valor === undefined || valor === null) return [];
  let items;
  if (Array.isArray(valor)) {
    items = valor;
  } else if (typeof valor === "number") {
    items = [valor];
  } else if (typeof valor === "string") {
    const texto = valor.trim();
    if (!texto) return [];
    if (texto.startsWith("[")) {
      try {
        items = JSON.parse(texto);
      } catch (_error) {
        return null;
      }
      if (!Array.isArray(items)) return null;
    } else {
      items = texto.split(",");
    }
  } else {
    return null;
  }

  if (items.length > MAX_DEPARTAMENTALES_NOTICIA) return null;
  const ids = [];
  for (const item of items) {
    // También se acepta { id } por si el cliente reenvía los objetos que devuelve la API.
    const id = item !== null && typeof item === "object" && !Array.isArray(item)
      ? normalizarIdPositivo(item.id)
      : normalizarIdPositivo(item);
    if (!id || ids.includes(id)) return null;
    ids.push(id);
  }
  return ids;
}

// Alcance de la noticia: { alcanceTodas: 1, departamentales: [] } o
// { alcanceTodas: 0, departamentales: [ids] }.
// Compatibilidad: el editor anterior no manda alcance_todas sino departamental_id
// ("" / ausente = todas; un id = sólo esa departamental).
function normalizarAlcanceNoticia(body = {}) {
  if (!valorPresente(body.alcance_todas)) {
    if (valorPresente(body.departamentales)) {
      const lista = normalizarListaDepartamentales(body.departamentales);
      if (lista === null) return { error: MENSAJE_DEPARTAMENTALES_INVALIDAS };
      if (lista.length > 0) return { value: { alcanceTodas: 0, departamentales: lista } };
    }
    if (!valorPresente(body.departamental_id)) return { value: { alcanceTodas: 1, departamentales: [] } };
    const departamentalId = normalizarIdPositivo(body.departamental_id);
    if (!departamentalId) return { error: "La departamental es inválida" };
    return { value: { alcanceTodas: 0, departamentales: [departamentalId] } };
  }

  const alcanceTodas = normalizarBooleanoBinario(
    typeof body.alcance_todas === "string" ? body.alcance_todas.trim() : body.alcance_todas
  );
  if (alcanceTodas === null) return { error: "El alcance de la noticia es inválido" };
  // Con «Todas las departamentales» la lista no se usa (el editor puede conservarla en el form).
  if (alcanceTodas === 1) return { value: { alcanceTodas: 1, departamentales: [] } };

  const lista = normalizarListaDepartamentales(body.departamentales);
  if (lista === null) return { error: MENSAJE_DEPARTAMENTALES_INVALIDAS };
  if (lista.length === 0) return { error: MENSAJE_ALCANCE_SIN_DEPARTAMENTALES };
  return { value: { alcanceTodas: 0, departamentales: lista } };
}

// Valor de la columna heredada noticia.departamental_id.
function departamentalHeredado({ alcanceTodas, departamentales } = {}) {
  return alcanceTodas === 0 && Array.isArray(departamentales) && departamentales.length === 1
    ? departamentales[0]
    : null;
}

// Sólo un 0 explícito restringe la noticia a algunas departamentales.
function esAlcanceTodas(valor) {
  return !(valor === 0 || valor === "0" || valor === false);
}

function compararDepartamentales(a, b) {
  return COLADOR_ES.compare(a.nombre, b.nombre) || a.id - b.id;
}

// Resumen para chips y tarjetas: "La Plata" · "Azul y La Plata" · "3 departamentales".
function resumirDepartamentales(departamentales) {
  const lista = Array.isArray(departamentales) ? departamentales : [];
  if (lista.length === 0) return null;
  if (lista.length === 1) return lista[0].nombre;
  if (lista.length === 2) return `${lista[0].nombre} y ${lista[1].nombre}`;
  return `${lista.length} departamentales`;
}

// Campos de alcance de una noticia serializada (orden alfabético en español).
function serializarAlcanceNoticia(alcanceTodas, departamentales = []) {
  if (esAlcanceTodas(alcanceTodas)) {
    return { alcance_todas: true, departamentales: [], departamental_id: null, departamental_nombre: null };
  }
  const lista = (Array.isArray(departamentales) ? departamentales : [])
    .map((departamental) => ({
      id: Number(departamental.id),
      nombre: departamental.nombre || `Departamental ${departamental.id}`,
    }))
    .sort(compararDepartamentales);
  return {
    alcance_todas: false,
    departamentales: lista,
    departamental_id: lista.length === 1 ? lista[0].id : null,
    departamental_nombre: resumirDepartamentales(lista),
  };
}

// Departamentales de varias noticias en UNA consulta (nada de N+1). Las noticias para
// todas las departamentales no tienen filas puente: ni se consultan.
async function cargarDepartamentalesDeNoticias(db, filas) {
  const ids = [];
  for (const fila of filas || []) {
    const id = Number(fila?.id);
    if (!esAlcanceTodas(fila?.alcance_todas) && Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) {
      ids.push(id);
    }
  }
  const mapa = new Map();
  if (ids.length === 0) return mapa;

  const [filasPuente] = await db.query(
    `SELECT nd.noticia_id, d.id, d.nombre
     FROM noticia_departamental nd
     INNER JOIN departamental d ON d.id = nd.departamental_id
     WHERE nd.noticia_id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
  for (const fila of filasPuente || []) {
    const noticiaId = Number(fila.noticia_id);
    if (!mapa.has(noticiaId)) mapa.set(noticiaId, []);
    mapa.get(noticiaId).push({ id: Number(fila.id), nombre: fila.nombre });
  }
  return mapa;
}

// Cada id tiene que existir habilitado o, al editar, ya estar asignado a esa noticia
// (una departamental dada de baja después no traba la edición).
async function validarDepartamentalesAlcance(db, departamentales, noticiaId = null) {
  if (!Array.isArray(departamentales) || departamentales.length === 0) return true;
  const marcadores = departamentales.map(() => "?").join(",");
  const [filas] = noticiaId
    ? await db.query(
      `SELECT d.id FROM departamental d
       WHERE d.id IN (${marcadores})
         AND (d.habilitado = 'Y' OR EXISTS (
           SELECT 1 FROM noticia_departamental nd WHERE nd.noticia_id = ? AND nd.departamental_id = d.id))`,
      [...departamentales, noticiaId]
    )
    : await db.query(
      `SELECT d.id FROM departamental d WHERE d.id IN (${marcadores}) AND d.habilitado = 'Y'`,
      departamentales
    );
  const validas = new Set((filas || []).map((fila) => Number(fila.id)));
  return departamentales.every((id) => validas.has(id));
}

// Reemplaza las filas puente dentro de la transacción de la noticia.
async function guardarDepartamentalesNoticia(connection, noticiaId, departamentales, { reemplazar = true } = {}) {
  if (reemplazar) {
    await connection.query("DELETE FROM noticia_departamental WHERE noticia_id = ?", [noticiaId]);
  }
  if (!Array.isArray(departamentales) || departamentales.length === 0) return;
  await connection.query(
    `INSERT INTO noticia_departamental (noticia_id, departamental_id)
     VALUES ${departamentales.map(() => "(?, ?)").join(", ")}`,
    departamentales.flatMap((departamentalId) => [noticiaId, departamentalId])
  );
}

// ── Portal departamental del afiliado ────────────────────────────────────────

// El familiar invitado ya queda afuera en verifyToken (sólo turismo); se vuelve a mirar acá.
const esAfiliadoDelPortal = (cabecera) => (
  cabecera?.rol === "afiliado" && !cabecera?.acceso_familiar_turismo
);

// La cabecera trae la departamental refrescada desde la base en cada pedido.
function departamentalDeCabecera(cabecera) {
  return normalizarIdPositivo(cabecera?.departamental_id) || 0;
}

function normalizarOrigenPortal(valor) {
  if (valor === undefined || valor === null) return { value: null };
  if (typeof valor !== "string") return { error: "El origen de las noticias es inválido" };
  const origen = valor.trim().toLowerCase();
  if (!origen || origen === "todas") return { value: null };
  if (!ORIGENES_PORTAL.has(origen)) return { error: "El origen de las noticias es inválido" };
  return { value: origen };
}

// WHERE + parámetros del listado del portal (el primer parámetro es la departamental).
function construirConsultaPortal({
  departamentalId = 0,
  origen = null,
  categoria = null,
  busqueda = null,
  idsExcluidos = [],
} = {}) {
  const condiciones = [CONDICION_PORTAL];
  const params = [departamentalId];
  // Visible + alcance_todas = 0 implica que incluye la departamental del afiliado.
  if (origen === "propias") condiciones.push("n.alcance_todas = 0");
  if (origen === "generales") condiciones.push("n.alcance_todas = 1");
  if (categoria) {
    condiciones.push("n.categoria = ?");
    params.push(categoria);
  }
  if (busqueda) {
    condiciones.push("(n.titulo LIKE ? OR n.bajada LIKE ?)");
    params.push(`%${busqueda}%`, `%${busqueda}%`);
  }
  if (idsExcluidos.length > 0) {
    condiciones.push(`n.id NOT IN (${idsExcluidos.map(() => "?").join(",")})`);
    params.push(...idsExcluidos);
  }
  return { where: condiciones.join(" AND "), params };
}

function coordenadaOpcional(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

// coordenadas es POINT(lng, lat): lng = ST_X, lat = ST_Y.
async function obtenerDepartamentalPortal(db, departamentalId) {
  if (!departamentalId) return null;
  const [filas] = await db.query(
    `SELECT d.id, d.nombre, d.direccion, d.localidad,
            ST_Y(d.coordenadas) AS lat, ST_X(d.coordenadas) AS lng
     FROM departamental d
     WHERE d.id = ?
     LIMIT 1`,
    [departamentalId]
  );
  const fila = filas?.[0];
  if (!fila) return null;
  let lat = coordenadaOpcional(fila.lat);
  let lng = coordenadaOpcional(fila.lng);
  // POINT(0 0) es un marcador vacío, no una sede en el golfo de Guinea.
  if (lat === null || lng === null || (lat === 0 && lng === 0)) {
    lat = null;
    lng = null;
  }
  return {
    id: Number(fila.id),
    nombre: fila.nombre || null,
    direccion: fila.direccion || null,
    localidad: fila.localidad || null,
    lat,
    lng,
  };
}

// ISO 8601 estricto ("2026-10-08", "2026-10-08T09:30", "…:15.123Z", "…-03:00"). Sin zona
// horaria se interpreta en hora argentina (como el resto de la API). Si falta o es inválida:
// los últimos DIAS_RESUMEN_POR_DEFECTO días.
const PATRON_FECHA_ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

function normalizarDesdeResumen(valor, ahora = new Date()) {
  const porDefecto = new Date(ahora.getTime() - DIAS_RESUMEN_POR_DEFECTO * 24 * 60 * 60 * 1000);
  if (typeof valor !== "string") return porDefecto;
  const coincidencia = PATRON_FECHA_ISO_8601.exec(valor.trim());
  if (!coincidencia) return porDefecto;

  const [, anio, mes, dia, hora = "00", minuto = "00", segundo = "00", fraccion = "", zona] = coincidencia;
  const diasDelMes = new Date(Date.UTC(Number(anio), Number(mes), 0)).getUTCDate();
  if (
    Number(anio) < 1970
    || Number(mes) < 1 || Number(mes) > 12
    || Number(dia) < 1 || Number(dia) > diasDelMes
    || Number(hora) > 23 || Number(minuto) > 59 || Number(segundo) > 59
  ) {
    return porDefecto;
  }

  let desplazamiento = "-03:00";
  if (zona) {
    if (zona.toUpperCase() === "Z") {
      desplazamiento = "Z";
    } else {
      const compacta = zona.replace(":", "");
      const horas = compacta.slice(1, 3);
      const minutos = compacta.slice(3, 5) || "00";
      if (Number(horas) > 14 || Number(minutos) > 59) return porDefecto;
      desplazamiento = `${compacta[0]}${horas}:${minutos}`;
    }
  }
  const milisegundos = `${fraccion}000`.slice(0, 3);
  const fecha = new Date(`${anio}-${mes}-${dia}T${hora}:${minuto}:${segundo}.${milisegundos}${desplazamiento}`);
  return Number.isNaN(fecha.getTime()) ? porDefecto : fecha;
}

// Acepta el formato de <input type="datetime-local"> y variantes con segundos.
function normalizarFechaPublicacion(valor) {
  const texto = normalizarTexto(valor);
  if (!texto) return { value: null };
  const coincidencia = /^(\d{4})-(\d{2})-(\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(texto);
  if (!coincidencia) return { error: "La fecha de publicación es inválida" };
  const [, anio, mes, dia, hora, minuto, segundo] = coincidencia;
  const fecha = new Date(Number(anio), Number(mes) - 1, Number(dia), Number(hora), Number(minuto));
  if (Number.isNaN(fecha.getTime()) || fecha.getMonth() !== Number(mes) - 1 || fecha.getDate() !== Number(dia)) {
    return { error: "La fecha de publicación es inválida" };
  }
  return { value: `${anio}-${mes}-${dia} ${hora}:${minuto}:${segundo || "00"}` };
}

// El cuerpo llega como HTML del editor del panel. Se reduce a una lista blanca
// de etiquetas de texto; los atributos se descartan salvo href http(s)/mailto.
// En el frontend Angular vuelve a sanearse al render con [innerHTML].
const ETIQUETAS_CUERPO_PERMITIDAS = new Set([
  "p", "br", "strong", "b", "em", "i", "u", "s",
  "h2", "h3", "ul", "ol", "li", "blockquote", "a", "hr",
]);

function sanitizarCuerpoNoticia(html) {
  if (typeof html !== "string") return null;
  let limpio = html.replace(
    /<\s*(script|style|iframe|object|embed|form|svg|math|template|textarea)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    ""
  );
  limpio = limpio.replace(/<!--[\s\S]*?-->/g, "");
  limpio = limpio.replace(/<([^>]*)>/g, (coincidencia, interior) => {
    const esCierre = /^\s*\//.test(interior);
    const nombre = interior.replace(/^\s*\/?\s*/, "").split(/[\s/>]/)[0].toLowerCase();
    if (!ETIQUETAS_CUERPO_PERMITIDAS.has(nombre)) return "";
    if (esCierre) return `</${nombre}>`;
    if (nombre === "br" || nombre === "hr") return `<${nombre}>`;
    if (nombre === "a") {
      const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(interior);
      const url = href ? (href[1] || href[2] || "").trim() : "";
      if (/^(https?:\/\/|mailto:)/i.test(url)) {
        return `<a href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">`;
      }
      return "<a>";
    }
    return `<${nombre}>`;
  });
  const texto = limpio.trim();
  return texto.length ? texto : null;
}

function crearErrorHttp(mensaje, statusCode = 400) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  return error;
}

async function adquirirLockNoticiasDestacadas(connection) {
  const [filas] = await connection.query(
    `SELECT GET_LOCK(${EXPRESION_NOMBRE_LOCK_DESTACADAS}, ?) AS adquirido`,
    [LOCK_NOTICIAS_DESTACADAS_TIMEOUT_SEGUNDOS]
  );
  const adquirido = filas?.[0]?.adquirido;
  if (adquirido === null || adquirido === undefined) {
    throw crearErrorHttp("No se pudo coordinar la actualización de noticias destacadas", 500);
  }
  if (Number(adquirido) !== 1) {
    throw crearErrorHttp(
      "Hay otra actualización de noticias destacadas en curso. Intentá nuevamente.",
      409
    );
  }
}

async function liberarLockNoticiasDestacadas(connection) {
  const [filas] = await connection.query(
    `SELECT RELEASE_LOCK(${EXPRESION_NOMBRE_LOCK_DESTACADAS}) AS liberado`
  );
  return Number(filas?.[0]?.liberado) === 1;
}

async function liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, contexto) {
  if (!connection) return;

  let reutilizable = true;
  if (lockDestacadasAdquirido) {
    try {
      reutilizable = await liberarLockNoticiasDestacadas(connection);
      if (!reutilizable) {
        console.error(`No se pudo liberar el lock de noticias destacadas (${contexto})`);
      }
    } catch (error) {
      reutilizable = false;
      console.error(`No se pudo liberar el lock de noticias destacadas (${contexto}):`, error);
    }
  }

  try {
    if (reutilizable) {
      connection.release();
    } else {
      // Un advisory lock vive mientras viva la conexión. Si no pudimos liberarlo,
      // se destruye la conexión para que nunca vuelva al pool reteniendo el lock.
      connection.destroy();
    }
  } catch (error) {
    console.error(`No se pudo devolver la conexión de noticias al pool (${contexto}):`, error);
    try {
      connection.destroy();
    } catch (destroyError) {
      console.error(`No se pudo destruir la conexión de noticias (${contexto}):`, destroyError);
    }
  }
}

async function validarCupoNoticiasDestacadas(connection, destacada, noticiaId = null) {
  if (destacada !== 1) return;

  const params = [];
  let excluirActual = "";
  if (noticiaId !== null) {
    excluirActual = " AND id <> ?";
    params.push(noticiaId);
  }

  const [filas] = await connection.query(
    `SELECT COUNT(*) AS total
     FROM noticia
     WHERE eliminado = 0 AND destacada = 1${excluirActual}`,
    params
  );
  if (Number(filas?.[0]?.total || 0) >= MAX_NOTICIAS_DESTACADAS) {
    throw crearErrorHttp(
      `Solo se pueden destacar hasta ${MAX_NOTICIAS_DESTACADAS} noticias`,
      409
    );
  }
}

function validarDatosNoticia(body) {
  const titulo = normalizarTexto(body.titulo);
  if (!titulo) return { error: "El título es obligatorio" };
  if (titulo.length > 160) return { error: "El título no puede superar los 160 caracteres" };

  const bajada = normalizarTexto(body.bajada);
  if (bajada && bajada.length > 300) return { error: "La bajada no puede superar los 300 caracteres" };

  const categoria = normalizarTexto(body.categoria) || "Institucional";
  if (categoria.length > 60) return { error: "La categoría no puede superar los 60 caracteres" };

  const estado = normalizarTexto(body.estado) || "BORRADOR";
  if (!ESTADOS_NOTICIA.includes(estado)) return { error: "El estado de la noticia es inválido" };

  const destacada = normalizarBooleanoBinario(body.destacada, 0);
  if (destacada === null) return { error: "El valor de destacada es inválido" };

  let orden = 0;
  if (body.orden !== undefined && body.orden !== null && body.orden !== "") {
    const ordenNumero = Number(String(body.orden).trim());
    if (!Number.isSafeInteger(ordenNumero) || ordenNumero < 0 || ordenNumero > 1000) {
      return { error: "La prioridad debe ser un entero entre 0 y 1000" };
    }
    orden = ordenNumero;
  }

  const alcance = normalizarAlcanceNoticia(body);
  if (alcance.error) return { error: alcance.error };

  if (typeof body.cuerpo === "string" && body.cuerpo.length > MAX_LARGO_CUERPO) {
    return { error: "El cuerpo de la noticia es demasiado largo" };
  }
  const cuerpo = sanitizarCuerpoNoticia(body.cuerpo);

  const fechaPublicacion = normalizarFechaPublicacion(body.fecha_publicacion);
  if (fechaPublicacion.error) return { error: fechaPublicacion.error };

  return {
    value: {
      titulo,
      bajada,
      categoria,
      estado,
      destacada,
      orden,
      alcanceTodas: alcance.value.alcanceTodas,
      departamentales: alcance.value.departamentales,
      // Columna heredada: el id si hay exactamente una departamental; si no, NULL.
      departamentalId: departamentalHeredado(alcance.value),
      cuerpo,
      fechaPublicacion: fechaPublicacion.value,
    },
  };
}

function serializarVariantesDb(media) {
  const variantes = descriptorPersistible(media).variantes;
  return variantes.length > 0 ? JSON.stringify(variantes) : null;
}

function descriptorDesdeNoticia(fila) {
  return descriptorPersistible({
    archivo: fila?.imagen_archivo,
    ancho: fila?.imagen_ancho,
    alto: fila?.imagen_alto,
    mime: fila?.imagen_mime,
    variantes: fila?.imagen_variantes,
  });
}

function descriptorDesdeGaleria(fila) {
  return descriptorPersistible({
    archivo: fila?.archivo,
    ancho: fila?.ancho,
    alto: fila?.alto,
    mime: fila?.mime,
    variantes: fila?.variantes,
  });
}

async function eliminarMediaSinReferencias(db, media) {
  const descriptor = descriptorPersistible(media);
  if (!descriptor.archivo) return false;
  const [[fila]] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM noticia WHERE imagen_archivo = ?) +
       (SELECT COUNT(*) FROM noticia_imagen WHERE archivo = ?) AS totalReferencias`,
    [descriptor.archivo, descriptor.archivo]
  );
  if (Number(fila.totalReferencias) > 0) return false;
  await noticiaMedia.eliminar(descriptor);
  return true;
}

function habilitarCachePublica(res) {
  res.removeHeader("Pragma");
  res.set(
    "Cache-Control",
    PUBLIC_NEWS_MEDIA_BASE_URL
      ? "public, max-age=60, s-maxage=300, stale-while-revalidate=600"
      : "public, max-age=15, s-maxage=30, must-revalidate"
  );
}

// departamentalesPorNoticia: Map noticia_id → [{ id, nombre }] (cargarDepartamentalesDeNoticias).
async function firmarNoticia(fila, { conCuerpo = false, departamentalesPorNoticia = null } = {}) {
  const descriptor = descriptorDesdeNoticia(fila);
  const mediaResuelta = await noticiaMedia.resolver(descriptor);
  const alcance = serializarAlcanceNoticia(
    fila.alcance_todas,
    departamentalesPorNoticia?.get(Number(fila.id)) || []
  );

  const noticia = {
    id: Number(fila.id),
    titulo: fila.titulo,
    bajada: fila.bajada || null,
    categoria: fila.categoria,
    alcance_todas: alcance.alcance_todas,
    departamentales: alcance.departamentales,
    departamental_id: alcance.departamental_id,
    departamental_nombre: alcance.departamental_nombre,
    destacada: fila.destacada === 1 || fila.destacada === true,
    orden: Number(fila.orden || 0),
    estado: fila.estado,
    fecha_publicacion: fila.fecha_publicacion || null,
    fecha_creacion: fila.fecha_creacion,
    fecha_modificacion: fila.fecha_modificacion,
    imagen_archivo: fila.imagen_archivo || null,
    imagen_url: mediaResuelta.url,
    imagen_ancho: descriptor.ancho,
    imagen_alto: descriptor.alto,
    imagen_mime: descriptor.mime,
    imagen_variantes: mediaResuelta.variantes,
  };

  if (conCuerpo) {
    noticia.cuerpo = fila.cuerpo || null;
  }
  if (fila.autor_nombre !== undefined) {
    noticia.autor = [fila.autor_nombre, fila.autor_apellido].filter(Boolean).join(" ") || null;
  }
  return noticia;
}

// Serializa una lista con las departamentales cargadas en una sola consulta.
async function firmarNoticias(db, filas, opciones = {}) {
  const departamentalesPorNoticia = await cargarDepartamentalesDeNoticias(db, filas);
  return Promise.all((filas || []).map((fila) => firmarNoticia(fila, { ...opciones, departamentalesPorNoticia })));
}

function marcarParaMiDepartamental(noticia, departamentalId) {
  noticia.para_mi_departamental = departamentalId > 0
    && noticia.alcance_todas === false
    && noticia.departamentales.some((departamental) => departamental.id === departamentalId);
  return noticia;
}

async function firmarNoticiasDelPortal(db, filas, departamentalId, opciones = {}) {
  const noticias = await firmarNoticias(db, filas, opciones);
  return noticias.map((noticia) => marcarParaMiDepartamental(noticia, departamentalId));
}

async function firmarGaleria(filas) {
  const resultado = [];
  for (const fila of filas || []) {
    const descriptor = descriptorDesdeGaleria(fila);
    const mediaResuelta = await noticiaMedia.resolver(descriptor);
    resultado.push({
      id: Number(fila.id),
      archivo: fila.archivo,
      epigrafe: fila.epigrafe || null,
      orden: Number(fila.orden || 0),
      imagen_url: mediaResuelta.url,
      ancho: descriptor.ancho,
      alto: descriptor.alto,
      mime: descriptor.mime,
      variantes: mediaResuelta.variantes,
    });
  }
  return resultado;
}

// Las departamentales (y el resumen departamental_nombre) salen de noticia_departamental.
const CAMPOS_NOTICIA = `
  n.id, n.titulo, n.bajada, n.categoria, n.alcance_todas,
  n.destacada, n.orden, n.estado, n.fecha_publicacion, n.fecha_creacion, n.fecha_modificacion,
  n.imagen_archivo, n.imagen_ancho, n.imagen_alto, n.imagen_mime, n.imagen_variantes
`;

// ─────────────────────────────────────────────────────────────────────────────
// PÚBLICO · Portada institucional (sin token)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/noticias/publicas", async (req, res) => {
  try {
    const db = mysqlConnection.promise();
    const paginacion = normalizarPaginacion(req.query, 9);
    if (!paginacion) return res.status(400).json("La paginación es inválida");
    const { page, pageSize } = paginacion;

    const condiciones = [CONDICION_PUBLICA];
    const params = [];

    const idsExcluidos = normalizarIdsExcluidos(req.query.exclude_ids);
    if (idsExcluidos === null) return res.status(400).json("Los IDs excluidos son inválidos");
    if (idsExcluidos.length > 0) {
      condiciones.push(`n.id NOT IN (${idsExcluidos.map(() => "?").join(",")})`);
      params.push(...idsExcluidos);
    }

    const categoria = normalizarTexto(req.query.categoria);
    if (categoria) {
      condiciones.push("n.categoria = ?");
      params.push(categoria);
    }
    // Noticias elegidas específicamente para esa departamental (no las de todas).
    const departamentalId = normalizarIdPositivo(req.query.departamental_id);
    if (departamentalId) {
      condiciones.push(CONDICION_SOLO_DEPARTAMENTAL);
      params.push(departamentalId);
    }
    const busqueda = normalizarTexto(req.query.q);
    if (busqueda) {
      condiciones.push("(n.titulo LIKE ? OR n.bajada LIKE ?)");
      params.push(`%${busqueda}%`, `%${busqueda}%`);
    }
    const where = condiciones.join(" AND ");

    const [[{ totalItems }]] = await db.query(
      `SELECT COUNT(*) AS totalItems FROM noticia n WHERE ${where}`,
      params
    );

    const [filas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}
       FROM noticia n
       WHERE ${where}
       ORDER BY ${ORDEN_FEED}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    const results = await firmarNoticias(db, filas);
    habilitarCachePublica(res);
    res.status(200).json({ results, totalItems, page, pageSize });
  } catch (error) {
    console.error("Error al obtener las noticias públicas:", error);
    res.status(500).json("Error al obtener las noticias");
  }
});

router.get("/noticias/publicas/destacadas", async (req, res) => {
  try {
    const db = mysqlConnection.promise();
    const [filas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}
       FROM noticia n
       WHERE ${CONDICION_PUBLICA} AND n.destacada = 1
       ORDER BY ${ORDEN_FEED}
       LIMIT ${MAX_NOTICIAS_DESTACADAS}`
    );
    const destacadas = await firmarNoticias(db, filas);
    habilitarCachePublica(res);
    res.status(200).json(destacadas);
  } catch (error) {
    console.error("Error al obtener las noticias destacadas:", error);
    res.status(500).json("Error al obtener las noticias destacadas");
  }
});

// Categorías y departamentales con noticias publicadas, para los filtros del feed.
// Una departamental cuenta las noticias elegidas específicamente para ella.
router.get("/noticias/publicas/filtros", async (req, res) => {
  try {
    const db = mysqlConnection.promise();
    const [categorias] = await db.query(
      `SELECT n.categoria, COUNT(*) AS total
       FROM noticia n
       WHERE ${CONDICION_PUBLICA}
       GROUP BY n.categoria
       ORDER BY total DESC, n.categoria ASC`
    );
    const [departamentales] = await db.query(
      `SELECT d.id, d.nombre, COUNT(n.id) AS total
       FROM departamental d
       INNER JOIN noticia_departamental nd ON nd.departamental_id = d.id
       INNER JOIN noticia n ON n.id = nd.noticia_id AND n.alcance_todas = 0 AND ${CONDICION_PUBLICA}
       WHERE d.habilitado = 'Y'
       GROUP BY d.id, d.nombre
       ORDER BY d.nombre ASC`
    );
    habilitarCachePublica(res);
    res.status(200).json({
      categorias: categorias.map((fila) => ({ categoria: fila.categoria, total: Number(fila.total) })),
      departamentales: departamentales.map((fila) => ({ id: Number(fila.id), nombre: fila.nombre, total: Number(fila.total) })),
    });
  } catch (error) {
    console.error("Error al obtener los filtros de noticias:", error);
    res.status(500).json("Error al obtener los filtros de noticias");
  }
});

router.get("/noticias/publicas/:id(\\d+)", async (req, res) => {
  try {
    const noticiaId = normalizarIdPositivo(req.params.id);
    if (!noticiaId) return res.status(400).json("ID inválido");

    const db = mysqlConnection.promise();
    const [filas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}, n.cuerpo
       FROM noticia n
       WHERE ${CONDICION_PUBLICA} AND n.id = ?
       LIMIT 1`,
      [noticiaId]
    );
    if (filas.length === 0) return res.status(404).json("Noticia no encontrada");

    const [galeria] = await db.query(SQL_GALERIA_NOTICIA, [noticiaId]);

    const [relacionadasFilas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}
       FROM noticia n
       WHERE ${CONDICION_PUBLICA} AND n.id <> ? AND n.categoria = ?
       ORDER BY ${ORDEN_FEED}
       LIMIT 3`,
      [noticiaId, filas[0].categoria]
    );

    // Una sola consulta para las departamentales de la noticia y de sus relacionadas.
    const departamentalesPorNoticia = await cargarDepartamentalesDeNoticias(db, [filas[0], ...relacionadasFilas]);
    const noticia = await firmarNoticia(filas[0], { conCuerpo: true, departamentalesPorNoticia });
    noticia.galeria = await firmarGaleria(galeria);
    noticia.relacionadas = await Promise.all(
      relacionadasFilas.map((fila) => firmarNoticia(fila, { departamentalesPorNoticia }))
    );

    habilitarCachePublica(res);
    res.status(200).json(noticia);
  } catch (error) {
    console.error("Error al obtener la noticia:", error);
    res.status(500).json("Error al obtener la noticia");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AFILIADO · Portal de su departamental (rol afiliado)
// Ve lo publicado para su departamental + lo publicado para todas las departamentales.
// La departamental sale de la cabecera, que verifyToken refresca desde la base.
// ─────────────────────────────────────────────────────────────────────────────

function cabeceraDelPortal(req, res) {
  res.set("Cache-Control", "private, no-store");
  const cabecera = getCabecera(req);
  if (!esAfiliadoDelPortal(cabecera)) {
    res.status(403).json(MENSAJE_SOLO_AFILIADOS);
    return null;
  }
  return cabecera;
}

router.get("/noticias/departamental", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDelPortal(req, res);
    if (!cabecera) return;

    const paginacion = normalizarPaginacion(req.query, 9, MAX_PAGINA_PORTAL);
    if (!paginacion) return res.status(400).json("La paginación es inválida");
    const { page, pageSize, start } = paginacion;

    const origen = normalizarOrigenPortal(req.query.origen);
    if (origen.error) return res.status(400).json(origen.error);
    const idsExcluidos = normalizarIdsExcluidos(req.query.exclude_ids);
    if (idsExcluidos === null) return res.status(400).json("Los IDs excluidos son inválidos");

    const departamentalId = departamentalDeCabecera(cabecera);
    const consulta = construirConsultaPortal({
      departamentalId,
      origen: origen.value,
      categoria: normalizarTexto(req.query.categoria),
      busqueda: normalizarTexto(req.query.q),
      idsExcluidos,
    });

    const db = mysqlConnection.promise();
    const departamental = await obtenerDepartamentalPortal(db, departamentalId);

    const [[{ totalItems }]] = await db.query(
      `SELECT COUNT(*) AS totalItems FROM noticia n WHERE ${consulta.where}`,
      consulta.params
    );
    const [filas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}
       FROM noticia n
       WHERE ${consulta.where}
       ORDER BY ${ORDEN_FEED}
       LIMIT ? OFFSET ?`,
      [...consulta.params, pageSize, start]
    );

    // Conteos y categorías de todo lo visible (sin los filtros de categoría, origen ni búsqueda).
    const [[conteosFila]] = await db.query(
      `SELECT COUNT(*) AS todas,
              COALESCE(SUM(n.alcance_todas = 0), 0) AS propias,
              COALESCE(SUM(n.alcance_todas = 1), 0) AS generales
       FROM noticia n
       WHERE ${CONDICION_PORTAL}`,
      [departamentalId]
    );
    const [categoriasFilas] = await db.query(
      `SELECT n.categoria, COUNT(*) AS total
       FROM noticia n
       WHERE ${CONDICION_PORTAL}
       GROUP BY n.categoria
       ORDER BY total DESC, n.categoria ASC`,
      [departamentalId]
    );

    const results = await firmarNoticiasDelPortal(db, filas, departamentalId);
    res.status(200).json({
      departamental,
      results,
      totalItems: Number(totalItems || 0),
      page,
      pageSize,
      conteos: {
        todas: Number(conteosFila?.todas || 0),
        propias: Number(conteosFila?.propias || 0),
        generales: Number(conteosFila?.generales || 0),
      },
      categorias: (categoriasFilas || []).map((fila) => ({ categoria: fila.categoria, total: Number(fila.total) })),
    });
  } catch (error) {
    console.error("Error al obtener el portal de la departamental:", error);
    res.status(500).json("Error al obtener las noticias de tu departamental");
  }
});

// Aviso de la tarjeta del panel /inicio. Va ANTES de /:id (express evalúa en orden).
router.get("/noticias/departamental/resumen", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDelPortal(req, res);
    if (!cabecera) return;

    const departamentalId = departamentalDeCabecera(cabecera);
    const desde = normalizarDesdeResumen(req.query.desde);
    const db = mysqlConnection.promise();
    const [[fila]] = await db.query(
      `SELECT COUNT(*) AS nuevas
       FROM (
         SELECT n.id
         FROM noticia n
         WHERE ${CONDICION_PORTAL} AND COALESCE(n.fecha_publicacion, n.fecha_creacion) > ?
         LIMIT ${TOPE_RESUMEN_NUEVAS}
       ) AS recientes`,
      [departamentalId, desde]
    );
    res.status(200).json({ nuevas: Math.min(TOPE_RESUMEN_NUEVAS, Number(fila?.nuevas || 0)) });
  } catch (error) {
    console.error("Error al obtener el resumen del portal de la departamental:", error);
    res.status(500).json("Error al obtener las novedades de tu departamental");
  }
});

router.get("/noticias/departamental/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDelPortal(req, res);
    if (!cabecera) return;

    const noticiaId = normalizarIdPositivo(req.params.id);
    if (!noticiaId) return res.status(400).json("ID inválido");

    const departamentalId = departamentalDeCabecera(cabecera);
    const db = mysqlConnection.promise();
    const [filas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}, n.cuerpo
       FROM noticia n
       WHERE ${CONDICION_PORTAL} AND n.id = ?
       LIMIT 1`,
      [departamentalId, noticiaId]
    );
    // Lo que no es visible para su departamental no existe para el afiliado.
    if (filas.length === 0) return res.status(404).json("Noticia no encontrada");

    const [noticia] = await firmarNoticiasDelPortal(db, filas, departamentalId, { conCuerpo: true });
    const [galeria] = await db.query(SQL_GALERIA_NOTICIA, [noticiaId]);
    noticia.galeria = await firmarGaleria(galeria);

    res.status(200).json(noticia);
  } catch (error) {
    console.error("Error al obtener la noticia del portal de la departamental:", error);
    res.status(500).json("Error al obtener la noticia");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN · Redacción de noticias (roles admin y prensa)
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNAS_ORDEN_ADMIN = {
  id: "n.id",
  titulo: "n.titulo",
  orden: "n.orden",
  fecha_creacion: "n.fecha_creacion",
  fecha_publicacion: "COALESCE(n.fecha_publicacion, n.fecha_creacion)",
};

router.get("/admin/noticias", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!puedeGestionarNoticias(cabecera)) return res.status(401).json("No autorizado");

    const db = mysqlConnection.promise();
    const paginacion = normalizarPaginacion(req.query, 10);
    if (!paginacion) return res.status(400).json("La paginación es inválida");
    const { page, pageSize } = paginacion;

    const orderBySolicitado = normalizarTexto(req.query.orderBy);
    if (orderBySolicitado && !Object.prototype.hasOwnProperty.call(COLUMNAS_ORDEN_ADMIN, orderBySolicitado)) {
      return res.status(400).json("Columna de orden inválida");
    }
    const orderBy = orderBySolicitado ? COLUMNAS_ORDEN_ADMIN[orderBySolicitado] : "COALESCE(n.fecha_publicacion, n.fecha_creacion)";
    const orderType = String(req.query.orderType).toLowerCase() === "asc" ? "ASC" : "DESC";

    const condiciones = ["n.eliminado = 0"];
    const params = [];

    const estado = normalizarTexto(req.query.estado);
    if (estado) {
      if (!ESTADOS_NOTICIA.includes(estado)) return res.status(400).json("El estado es inválido");
      condiciones.push("n.estado = ?");
      params.push(estado);
    }
    const categoria = normalizarTexto(req.query.categoria);
    if (categoria) {
      condiciones.push("n.categoria = ?");
      params.push(categoria);
    }
    const busqueda = normalizarTexto(req.query.q);
    if (busqueda) {
      condiciones.push("(n.titulo LIKE ? OR n.bajada LIKE ?)");
      params.push(`%${busqueda}%`, `%${busqueda}%`);
    }
    // "Se ve en": noticias que aparecen en el portal de esa departamental (todas + las suyas).
    if (valorPresente(req.query.visible_en)) {
      const visibleEn = normalizarIdPositivo(req.query.visible_en);
      if (!visibleEn) return res.status(400).json("La departamental del filtro es inválida");
      condiciones.push(CONDICION_ALCANCE_PORTAL);
      params.push(visibleEn);
    }
    const where = condiciones.join(" AND ");

    const [[{ totalItems }]] = await db.query(
      `SELECT COUNT(*) AS totalItems FROM noticia n WHERE ${where}`,
      params
    );

    const [filas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}, u.nombre AS autor_nombre, u.apellido AS autor_apellido
       FROM noticia n
       LEFT JOIN usuario u ON u.id = n.creado_por_usuario_id
       WHERE ${where}
       ORDER BY ${orderBy} ${orderType}, n.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    // Conteos globales (sin filtros) para las pestañas del panel.
    const [conteosFilas] = await db.query(
      `SELECT n.estado, COUNT(*) AS total, SUM(n.destacada = 1) AS destacadas
       FROM noticia n
       WHERE n.eliminado = 0
       GROUP BY n.estado`
    );
    const conteos = { BORRADOR: 0, PUBLICADA: 0, ARCHIVADA: 0, destacadas: 0 };
    conteosFilas.forEach((fila) => {
      conteos[fila.estado] = Number(fila.total);
      conteos.destacadas += Number(fila.destacadas || 0);
    });

    const results = await firmarNoticias(db, filas);
    res.status(200).json({ results, totalItems, page, pageSize, conteos });
  } catch (error) {
    console.error("Error al obtener las noticias del panel:", error);
    res.status(500).json("Error al obtener las noticias");
  }
});

// Datos de apoyo del editor: categorías ya usadas y departamentales habilitadas.
router.get("/admin/noticias/apoyos", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!puedeGestionarNoticias(cabecera)) return res.status(401).json("No autorizado");

    const db = mysqlConnection.promise();
    const [categorias] = await db.query(
      "SELECT DISTINCT categoria FROM noticia WHERE eliminado = 0 ORDER BY categoria ASC"
    );
    const [departamentales] = await db.query(
      "SELECT id, nombre FROM departamental WHERE habilitado = 'Y' ORDER BY nombre ASC"
    );
    const [[conteoDestacadas]] = await db.query(
      "SELECT COUNT(*) AS total FROM noticia WHERE eliminado = 0 AND destacada = 1"
    );
    res.status(200).json({
      categorias: categorias.map((fila) => fila.categoria),
      departamentales: departamentales.map((fila) => ({ id: Number(fila.id), nombre: fila.nombre })),
      destacadas: Number(conteoDestacadas?.total || 0),
      max_destacadas: MAX_NOTICIAS_DESTACADAS,
    });
  } catch (error) {
    console.error("Error al obtener los apoyos del editor de noticias:", error);
    res.status(500).json("Error al obtener los datos del editor");
  }
});

router.get("/admin/noticias/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!puedeGestionarNoticias(cabecera)) return res.status(401).json("No autorizado");

    const noticiaId = normalizarIdPositivo(req.params.id);
    if (!noticiaId) return res.status(400).json("ID inválido");

    const db = mysqlConnection.promise();
    const [filas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}, n.cuerpo, u.nombre AS autor_nombre, u.apellido AS autor_apellido
       FROM noticia n
       LEFT JOIN usuario u ON u.id = n.creado_por_usuario_id
       WHERE n.eliminado = 0 AND n.id = ?
       LIMIT 1`,
      [noticiaId]
    );
    if (filas.length === 0) return res.status(404).json("Noticia no encontrada");

    const [noticia] = await firmarNoticias(db, filas, { conCuerpo: true });
    const [galeria] = await db.query(SQL_GALERIA_NOTICIA, [noticiaId]);
    noticia.galeria = await firmarGaleria(galeria);

    res.status(200).json(noticia);
  } catch (error) {
    console.error("Error al obtener la noticia del panel:", error);
    res.status(500).json("Error al obtener la noticia");
  }
});

router.post("/admin/noticias", verifyToken, manejarUploadNoticia, async (req, res) => {
  let connection;
  let transaccionIniciada = false;
  let lockDestacadasAdquirido = false;
  let commitExitoso = false;
  const mediasSubidasS3 = [];
  try {
    const cabecera = getCabecera(req);
    if (!puedeGestionarNoticias(cabecera)) return res.status(401).json("No autorizado");

    const parseo = validarDatosNoticia(req.body);
    if (parseo.error) return res.status(400).json(parseo.error);
    const datos = parseo.value;

    const db = mysqlConnection.promise();
    if (!(await validarDepartamentalesAlcance(db, datos.departamentales))) {
      return res.status(400).json(MENSAJE_DEPARTAMENTALES_INVALIDAS);
    }

    // Publicar sin fecha explícita equivale a publicar ahora.
    if (datos.estado === "PUBLICADA" && !datos.fechaPublicacion) {
      datos.fechaPublicacion = new Date();
    }

    const mediaPortada = req.files?.imagen?.[0]
      ? await noticiaMedia.procesarYSubir(req.files.imagen[0], "portadas")
      : null;
    if (mediaPortada) mediasSubidasS3.push(mediaPortada);

    const mediasGaleria = [];
    for (const file of req.files?.galeria || []) {
      const media = await noticiaMedia.procesarYSubir(file, "galeria");
      mediasSubidasS3.push(media);
      mediasGaleria.push(media);
    }

    connection = await db.getConnection();
    if (datos.destacada === 1) {
      await adquirirLockNoticiasDestacadas(connection);
      lockDestacadasAdquirido = true;
    }
    await connection.beginTransaction();
    transaccionIniciada = true;
    await validarCupoNoticiasDestacadas(connection, datos.destacada);
    const portadaDb = descriptorPersistible(mediaPortada);
    const [resultado] = await connection.query(
      `INSERT INTO noticia
         (titulo, bajada, cuerpo, categoria, alcance_todas, departamental_id,
          imagen_archivo, imagen_ancho, imagen_alto, imagen_mime, imagen_variantes,
          destacada, orden, estado, fecha_publicacion, creado_por_usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datos.titulo, datos.bajada, datos.cuerpo, datos.categoria, datos.alcanceTodas, datos.departamentalId,
        portadaDb.archivo, portadaDb.ancho, portadaDb.alto, portadaDb.mime, serializarVariantesDb(portadaDb),
        datos.destacada, datos.orden, datos.estado, datos.fechaPublicacion,
        cabecera.id,
      ]
    );
    const noticiaId = resultado.insertId;
    await guardarDepartamentalesNoticia(connection, noticiaId, datos.departamentales, { reemplazar: false });

    for (let i = 0; i < mediasGaleria.length; i++) {
      const media = descriptorPersistible(mediasGaleria[i]);
      await connection.query(
        `INSERT INTO noticia_imagen
           (noticia_id, archivo, ancho, alto, mime, variantes, orden)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [noticiaId, media.archivo, media.ancho, media.alto, media.mime, serializarVariantesDb(media), i]
      );
    }
    await connection.commit();
    transaccionIniciada = false;
    commitExitoso = true;
    await liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, "creación");
    connection = undefined;
    lockDestacadasAdquirido = false;

    res.status(201).json({ success: true, id: noticiaId, message: "Noticia creada" });
  } catch (error) {
    if (connection && transaccionIniciada) {
      try {
        await connection.rollback();
        transaccionIniciada = false;
      } catch (rollbackError) {
        console.error("No se pudo revertir la creación de la noticia:", rollbackError);
        connection.destroy();
        connection = undefined;
        transaccionIniciada = false;
        lockDestacadasAdquirido = false;
      }
    }
    if (connection) {
      await liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, "creación fallida");
      connection = undefined;
      lockDestacadasAdquirido = false;
    }
    if (!commitExitoso) {
      for (const media of mediasSubidasS3) {
        try {
          // Si COMMIT se aplicó pero se perdió su respuesta, la referencia ya
          // existe y no debe borrarse. Si hubo rollback, se elimina normalmente.
          await eliminarMediaSinReferencias(mysqlConnection.promise(), media);
        } catch (deleteError) {
          console.error("No se pudieron limpiar todos los archivos de la noticia luego del error:", deleteError);
        }
      }
    }
    console.error("Error al crear la noticia:", error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al crear la noticia");
  } finally {
    await liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, "creación");
  }
});

router.put("/admin/noticias/:id(\\d+)", verifyToken, manejarUploadNoticia, async (req, res) => {
  let connection;
  let transaccionIniciada = false;
  let lockDestacadasAdquirido = false;
  let commitExitoso = false;
  const mediasNuevasS3 = [];
  const mediasABorrarS3 = [];
  try {
    const cabecera = getCabecera(req);
    if (!puedeGestionarNoticias(cabecera)) return res.status(401).json("No autorizado");

    const noticiaId = normalizarIdPositivo(req.params.id);
    if (!noticiaId) return res.status(400).json("ID inválido");

    const parseo = validarDatosNoticia(req.body);
    if (parseo.error) return res.status(400).json(parseo.error);
    const datos = parseo.value;

    const quitarImagen = normalizarBooleanoBinario(req.body.quitar_imagen, 0);
    let galeriaEliminar = [];
    if (req.body.galeria_eliminar !== undefined && req.body.galeria_eliminar !== "") {
      try {
        const parseada = JSON.parse(req.body.galeria_eliminar);
        if (!Array.isArray(parseada)) throw new Error("no es un array");
        galeriaEliminar = parseada.map((valor) => normalizarIdPositivo(valor)).filter(Boolean);
      } catch (parseError) {
        return res.status(400).json("El listado de imágenes a eliminar es inválido");
      }
    }

    const db = mysqlConnection.promise();
    if (!(await validarDepartamentalesAlcance(db, datos.departamentales, noticiaId))) {
      return res.status(400).json(MENSAJE_DEPARTAMENTALES_INVALIDAS);
    }

    // Las transformaciones y subidas S3 se hacen antes de tomar el advisory
    // lock. Si luego falla la transacción, el catch elimina estas variantes.
    const mediaPortadaNueva = req.files?.imagen?.[0]
      ? await noticiaMedia.procesarYSubir(req.files.imagen[0], "portadas")
      : null;
    if (mediaPortadaNueva) mediasNuevasS3.push(mediaPortadaNueva);

    const mediasGaleriaNuevas = [];
    for (const file of req.files?.galeria || []) {
      const media = await noticiaMedia.procesarYSubir(file, "galeria");
      mediasNuevasS3.push(media);
      mediasGaleriaNuevas.push(media);
    }

    connection = await db.getConnection();
    await adquirirLockNoticiasDestacadas(connection);
    lockDestacadasAdquirido = true;
    await connection.beginTransaction();
    transaccionIniciada = true;
    const [existentes] = await connection.query(
      "SELECT * FROM noticia WHERE id = ? AND eliminado = 0 LIMIT 1 FOR UPDATE",
      [noticiaId]
    );
    if (existentes.length === 0) {
      throw crearErrorHttp("Noticia no encontrada", 404);
    }
    const existente = existentes[0];
    await validarCupoNoticiasDestacadas(connection, datos.destacada, noticiaId);

    // Publicar por primera vez sin fecha explícita equivale a publicar ahora.
    if (datos.estado === "PUBLICADA" && !datos.fechaPublicacion) {
      datos.fechaPublicacion = existente.fecha_publicacion || new Date();
    }

    let mediaPortada = descriptorDesdeNoticia(existente);
    if (mediaPortadaNueva) {
      mediaPortada = mediaPortadaNueva;
      if (existente.imagen_archivo) mediasABorrarS3.push(descriptorDesdeNoticia(existente));
    } else if (quitarImagen === 1 && existente.imagen_archivo) {
      mediasABorrarS3.push(descriptorDesdeNoticia(existente));
      mediaPortada = descriptorPersistible(null);
    }

    if (galeriaEliminar.length > 0) {
      const marcadores = galeriaEliminar.map(() => "?").join(",");
      const [imagenesAEliminar] = await connection.query(
        `SELECT id, archivo, ancho, alto, mime, variantes
         FROM noticia_imagen WHERE noticia_id = ? AND id IN (${marcadores})`,
        [noticiaId, ...galeriaEliminar]
      );
      if (imagenesAEliminar.length > 0) {
        await connection.query(
          `DELETE FROM noticia_imagen WHERE noticia_id = ? AND id IN (${imagenesAEliminar.map(() => "?").join(",")})`,
          [noticiaId, ...imagenesAEliminar.map((fila) => fila.id)]
        );
        imagenesAEliminar.forEach((fila) => mediasABorrarS3.push(descriptorDesdeGaleria(fila)));
      }
    }

    if (mediasGaleriaNuevas.length > 0) {
      const [[{ totalGaleria }]] = await connection.query(
        "SELECT COUNT(*) AS totalGaleria FROM noticia_imagen WHERE noticia_id = ?",
        [noticiaId]
      );
      if (Number(totalGaleria) + mediasGaleriaNuevas.length > MAX_IMAGENES_GALERIA) {
        throw crearErrorHttp(`La galería admite hasta ${MAX_IMAGENES_GALERIA} imágenes`, 400);
      }
      const [[{ maxOrden }]] = await connection.query(
        "SELECT COALESCE(MAX(orden), -1) AS maxOrden FROM noticia_imagen WHERE noticia_id = ?",
        [noticiaId]
      );
      let ordenSiguiente = Number(maxOrden) + 1;
      for (const media of mediasGaleriaNuevas) {
        await connection.query(
          `INSERT INTO noticia_imagen
             (noticia_id, archivo, ancho, alto, mime, variantes, orden)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            noticiaId, media.archivo, media.ancho, media.alto, media.mime,
            serializarVariantesDb(media), ordenSiguiente++,
          ]
        );
      }
    }

    const portadaDb = descriptorPersistible(mediaPortada);
    await connection.query(
      `UPDATE noticia
       SET titulo = ?, bajada = ?, cuerpo = ?, categoria = ?, alcance_todas = ?, departamental_id = ?,
           imagen_archivo = ?, imagen_ancho = ?, imagen_alto = ?, imagen_mime = ?, imagen_variantes = ?,
           destacada = ?, orden = ?, estado = ?, fecha_publicacion = ?
       WHERE id = ?`,
      [
        datos.titulo, datos.bajada, datos.cuerpo, datos.categoria, datos.alcanceTodas, datos.departamentalId,
        portadaDb.archivo, portadaDb.ancho, portadaDb.alto, portadaDb.mime, serializarVariantesDb(portadaDb),
        datos.destacada, datos.orden, datos.estado, datos.fechaPublicacion,
        noticiaId,
      ]
    );
    // Mismo commit que la noticia: el alcance nunca queda a medio guardar.
    await guardarDepartamentalesNoticia(connection, noticiaId, datos.departamentales);
    await connection.commit();
    transaccionIniciada = false;
    commitExitoso = true;
    await liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, "actualización");
    connection = undefined;
    lockDestacadasAdquirido = false;

    // Recién después del commit se limpian de S3 las versiones reemplazadas.
    for (const media of mediasABorrarS3) {
      try {
        await eliminarMediaSinReferencias(db, media);
      } catch (deleteError) {
        console.error("No se pudieron borrar todas las variantes reemplazadas de la noticia:", deleteError);
      }
    }

    res.status(200).json({ success: true, id: noticiaId, message: "Noticia actualizada" });
  } catch (error) {
    if (connection && transaccionIniciada) {
      try {
        await connection.rollback();
        transaccionIniciada = false;
      } catch (rollbackError) {
        console.error("No se pudo revertir la actualización de la noticia:", rollbackError);
        connection.destroy();
        connection = undefined;
        transaccionIniciada = false;
        lockDestacadasAdquirido = false;
      }
    }
    if (connection) {
      await liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, "actualización fallida");
      connection = undefined;
      lockDestacadasAdquirido = false;
    }
    if (!commitExitoso) {
      for (const media of mediasNuevasS3) {
        try {
          // Evita borrar una variante que sí quedó referenciada si COMMIT fue
          // efectivo pero su confirmación no llegó a la aplicación.
          await eliminarMediaSinReferencias(mysqlConnection.promise(), media);
        } catch (deleteError) {
          console.error("No se pudieron limpiar todas las variantes nuevas de la noticia:", deleteError);
        }
      }
    }
    console.error("Error al actualizar la noticia:", error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al actualizar la noticia");
  } finally {
    await liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, "actualización");
  }
});

// Acciones rápidas del listado: destacar y cambiar estado sin pasar por el editor.
router.put("/admin/noticias/:id(\\d+)/flags", verifyToken, async (req, res) => {
  let connection;
  let transaccionIniciada = false;
  let lockDestacadasAdquirido = false;
  try {
    const cabecera = getCabecera(req);
    if (!puedeGestionarNoticias(cabecera)) return res.status(401).json("No autorizado");

    const noticiaId = normalizarIdPositivo(req.params.id);
    if (!noticiaId) return res.status(400).json("ID inválido");

    const cambios = [];
    const params = [];
    let destacadaSolicitada;

    if (req.body.destacada !== undefined) {
      const destacada = normalizarBooleanoBinario(req.body.destacada);
      if (destacada === null) return res.status(400).json("El valor de destacada es inválido");
      destacadaSolicitada = destacada;
      cambios.push("destacada = ?");
      params.push(destacada);
    }
    if (req.body.estado !== undefined) {
      const estado = normalizarTexto(req.body.estado);
      if (!estado || !ESTADOS_NOTICIA.includes(estado)) return res.status(400).json("El estado es inválido");
      cambios.push("estado = ?");
      params.push(estado);
      if (estado === "PUBLICADA") {
        cambios.push("fecha_publicacion = COALESCE(fecha_publicacion, NOW())");
      }
    }
    if (cambios.length === 0) return res.status(400).json("No hay cambios para aplicar");

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    if (destacadaSolicitada !== undefined) {
      await adquirirLockNoticiasDestacadas(connection);
      lockDestacadasAdquirido = true;
    }
    await connection.beginTransaction();
    transaccionIniciada = true;

    const [existentes] = await connection.query(
      "SELECT id FROM noticia WHERE id = ? AND eliminado = 0 LIMIT 1 FOR UPDATE",
      [noticiaId]
    );
    if (existentes.length === 0) {
      await connection.rollback();
      transaccionIniciada = false;
      return res.status(404).json("Noticia no encontrada");
    }

    await validarCupoNoticiasDestacadas(connection, destacadaSolicitada, noticiaId);
    await connection.query(
      `UPDATE noticia SET ${cambios.join(", ")} WHERE id = ? AND eliminado = 0`,
      [...params, noticiaId]
    );
    await connection.commit();
    transaccionIniciada = false;
    await liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, "actualización de indicadores");
    connection = undefined;
    lockDestacadasAdquirido = false;

    res.status(200).json({ success: true, id: noticiaId, message: "Noticia actualizada" });
  } catch (error) {
    if (connection && transaccionIniciada) {
      try {
        await connection.rollback();
        transaccionIniciada = false;
      } catch (rollbackError) {
        console.error("No se pudo revertir la actualización de los indicadores de la noticia:", rollbackError);
        connection.destroy();
        connection = undefined;
        transaccionIniciada = false;
        lockDestacadasAdquirido = false;
      }
    }
    if (connection) {
      await liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, "actualización fallida de indicadores");
      connection = undefined;
      lockDestacadasAdquirido = false;
    }
    console.error("Error al actualizar los indicadores de la noticia:", error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al actualizar la noticia");
  } finally {
    await liberarConexionGestionNoticias(connection, lockDestacadasAdquirido, "actualización de indicadores");
  }
});

router.delete("/admin/noticias/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!puedeGestionarNoticias(cabecera)) return res.status(401).json("No autorizado");

    const noticiaId = normalizarIdPositivo(req.params.id);
    if (!noticiaId) return res.status(400).json("ID inválido");

    // Baja lógica: la noticia desaparece del sistema pero conserva imágenes y
    // cuerpo por si hay que recuperarla a mano desde la base.
    const db = mysqlConnection.promise();
    const [resultado] = await db.query(
      "UPDATE noticia SET eliminado = 1 WHERE id = ? AND eliminado = 0",
      [noticiaId]
    );
    if (resultado.affectedRows === 0) return res.status(404).json("Noticia no encontrada");

    res.status(200).json({ id: noticiaId });
  } catch (error) {
    console.error("Error al eliminar la noticia:", error);
    res.status(500).json("Error al eliminar la noticia");
  }
});

router.__test = Object.freeze({
  MAX_NOTICIAS_DESTACADAS,
  verifyToken,
  validarDatosNoticia,
  validarCupoNoticiasDestacadas,
  adquirirLockNoticiasDestacadas,
  liberarLockNoticiasDestacadas,
  liberarConexionGestionNoticias,
  sanitizarCuerpoNoticia,
  normalizarFechaPublicacion,
  normalizarIdPositivo,
  normalizarIdsExcluidos,
  normalizarPaginacion,
  normalizarBooleanoBinario,
  puedeGestionarNoticias,
  // Noticias por departamental
  CONDICION_ALCANCE_PORTAL,
  CONDICION_PORTAL,
  CONDICION_SOLO_DEPARTAMENTAL,
  DIAS_RESUMEN_POR_DEFECTO,
  MAX_DEPARTAMENTALES_NOTICIA,
  MAX_PAGINA_PORTAL,
  MENSAJE_ALCANCE_SIN_DEPARTAMENTALES,
  MENSAJE_DEPARTAMENTALES_INVALIDAS,
  MENSAJE_SOLO_AFILIADOS,
  TOPE_RESUMEN_NUEVAS,
  cargarDepartamentalesDeNoticias,
  construirConsultaPortal,
  departamentalDeCabecera,
  departamentalHeredado,
  esAfiliadoDelPortal,
  firmarNoticias,
  guardarDepartamentalesNoticia,
  normalizarAlcanceNoticia,
  normalizarDesdeResumen,
  normalizarListaDepartamentales,
  normalizarOrigenPortal,
  obtenerDepartamentalPortal,
  resumirDepartamentales,
  serializarAlcanceNoticia,
  validarDepartamentalesAlcance,
});

module.exports = router;
