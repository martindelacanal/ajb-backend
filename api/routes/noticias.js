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
    return cb(new Error("Solo se permiten imagenes JPG, PNG o WebP"));
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
    mensajeAuthorization: "Se requiere Authorization: Bearer <token>",
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

// La condición de visibilidad pública se reutiliza en todos los listados sin token.
const CONDICION_PUBLICA = "n.eliminado = 0 AND n.estado = 'PUBLICADA' AND (n.fecha_publicacion IS NULL OR n.fecha_publicacion <= NOW())";
const ORDEN_FEED = "n.orden DESC, COALESCE(n.fecha_publicacion, n.fecha_creacion) DESC, n.id DESC";

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

function normalizarPaginacion(query, tamanioPorDefecto = 10) {
  const page = query?.page === undefined || query?.page === "" ? 1 : normalizarIdPositivo(query.page);
  const pageSize = query?.pageSize === undefined || query?.pageSize === "" ? tamanioPorDefecto : normalizarIdPositivo(query.pageSize);
  if (page === null || pageSize === null || page > 1_000_000 || pageSize > 100) return null;
  return { page, pageSize, start: (page - 1) * pageSize };
}

function normalizarIdsExcluidos(valor) {
  if (valor === undefined || valor === null || valor === "") return [];
  if (typeof valor !== "string") return null;
  const partes = valor.split(",");
  if (partes.length > 6) return null;

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

  let departamentalId = null;
  if (body.departamental_id !== undefined && body.departamental_id !== null && body.departamental_id !== "") {
    departamentalId = normalizarIdPositivo(body.departamental_id);
    if (!departamentalId) return { error: "La departamental es inválida" };
  }

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
      departamentalId,
      cuerpo,
      fechaPublicacion: fechaPublicacion.value,
    },
  };
}

async function validarDepartamentalExistente(db, departamentalId) {
  if (!departamentalId) return true;
  const [filas] = await db.query(
    "SELECT id FROM departamental WHERE id = ? AND habilitado = 'Y'",
    [departamentalId]
  );
  return filas.length > 0;
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

async function firmarNoticia(fila, { conCuerpo = false } = {}) {
  const descriptor = descriptorDesdeNoticia(fila);
  const mediaResuelta = await noticiaMedia.resolver(descriptor);

  const noticia = {
    id: Number(fila.id),
    titulo: fila.titulo,
    bajada: fila.bajada || null,
    categoria: fila.categoria,
    departamental_id: fila.departamental_id === null || fila.departamental_id === undefined ? null : Number(fila.departamental_id),
    departamental_nombre: fila.departamental_nombre || null,
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

const CAMPOS_NOTICIA = `
  n.id, n.titulo, n.bajada, n.categoria, n.departamental_id, d.nombre AS departamental_nombre,
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
    const departamentalId = normalizarIdPositivo(req.query.departamental_id);
    if (departamentalId) {
      condiciones.push("n.departamental_id = ?");
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
       LEFT JOIN departamental d ON d.id = n.departamental_id
       WHERE ${where}
       ORDER BY ${ORDEN_FEED}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    const results = await Promise.all(filas.map((fila) => firmarNoticia(fila)));
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
       LEFT JOIN departamental d ON d.id = n.departamental_id
       WHERE ${CONDICION_PUBLICA} AND n.destacada = 1
       ORDER BY ${ORDEN_FEED}
       LIMIT 6`
    );
    const destacadas = await Promise.all(filas.map((fila) => firmarNoticia(fila)));
    habilitarCachePublica(res);
    res.status(200).json(destacadas);
  } catch (error) {
    console.error("Error al obtener las noticias destacadas:", error);
    res.status(500).json("Error al obtener las noticias destacadas");
  }
});

// Categorías y departamentales con noticias publicadas, para los filtros del feed.
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
       INNER JOIN noticia n ON n.departamental_id = d.id AND ${CONDICION_PUBLICA}
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
       LEFT JOIN departamental d ON d.id = n.departamental_id
       WHERE ${CONDICION_PUBLICA} AND n.id = ?
       LIMIT 1`,
      [noticiaId]
    );
    if (filas.length === 0) return res.status(404).json("Noticia no encontrada");

    const noticia = await firmarNoticia(filas[0], { conCuerpo: true });

    const [galeria] = await db.query(
      "SELECT id, archivo, epigrafe, orden, ancho, alto, mime, variantes FROM noticia_imagen WHERE noticia_id = ? ORDER BY orden ASC, id ASC",
      [noticiaId]
    );
    noticia.galeria = await firmarGaleria(galeria);

    const [relacionadasFilas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}
       FROM noticia n
       LEFT JOIN departamental d ON d.id = n.departamental_id
       WHERE ${CONDICION_PUBLICA} AND n.id <> ? AND n.categoria = ?
       ORDER BY ${ORDEN_FEED}
       LIMIT 3`,
      [noticiaId, noticia.categoria]
    );
    noticia.relacionadas = await Promise.all(relacionadasFilas.map((fila) => firmarNoticia(fila)));

    habilitarCachePublica(res);
    res.status(200).json(noticia);
  } catch (error) {
    console.error("Error al obtener la noticia:", error);
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
    const where = condiciones.join(" AND ");

    const [[{ totalItems }]] = await db.query(
      `SELECT COUNT(*) AS totalItems FROM noticia n WHERE ${where}`,
      params
    );

    const [filas] = await db.query(
      `SELECT ${CAMPOS_NOTICIA}, u.nombre AS autor_nombre, u.apellido AS autor_apellido
       FROM noticia n
       LEFT JOIN departamental d ON d.id = n.departamental_id
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

    const results = await Promise.all(filas.map((fila) => firmarNoticia(fila)));
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
    res.status(200).json({
      categorias: categorias.map((fila) => fila.categoria),
      departamentales: departamentales.map((fila) => ({ id: Number(fila.id), nombre: fila.nombre })),
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
       LEFT JOIN departamental d ON d.id = n.departamental_id
       LEFT JOIN usuario u ON u.id = n.creado_por_usuario_id
       WHERE n.eliminado = 0 AND n.id = ?
       LIMIT 1`,
      [noticiaId]
    );
    if (filas.length === 0) return res.status(404).json("Noticia no encontrada");

    const noticia = await firmarNoticia(filas[0], { conCuerpo: true });
    const [galeria] = await db.query(
      "SELECT id, archivo, epigrafe, orden, ancho, alto, mime, variantes FROM noticia_imagen WHERE noticia_id = ? ORDER BY orden ASC, id ASC",
      [noticiaId]
    );
    noticia.galeria = await firmarGaleria(galeria);

    res.status(200).json(noticia);
  } catch (error) {
    console.error("Error al obtener la noticia del panel:", error);
    res.status(500).json("Error al obtener la noticia");
  }
});

router.post("/admin/noticias", verifyToken, manejarUploadNoticia, async (req, res) => {
  let connection;
  let commitExitoso = false;
  const mediasSubidasS3 = [];
  try {
    const cabecera = getCabecera(req);
    if (!puedeGestionarNoticias(cabecera)) return res.status(401).json("No autorizado");

    const parseo = validarDatosNoticia(req.body);
    if (parseo.error) return res.status(400).json(parseo.error);
    const datos = parseo.value;

    const db = mysqlConnection.promise();
    if (!(await validarDepartamentalExistente(db, datos.departamentalId))) {
      return res.status(400).json("La departamental es inválida");
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
    await connection.beginTransaction();
    const portadaDb = descriptorPersistible(mediaPortada);
    const [resultado] = await connection.query(
      `INSERT INTO noticia
         (titulo, bajada, cuerpo, categoria, departamental_id,
          imagen_archivo, imagen_ancho, imagen_alto, imagen_mime, imagen_variantes,
          destacada, orden, estado, fecha_publicacion, creado_por_usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datos.titulo, datos.bajada, datos.cuerpo, datos.categoria, datos.departamentalId,
        portadaDb.archivo, portadaDb.ancho, portadaDb.alto, portadaDb.mime, serializarVariantesDb(portadaDb),
        datos.destacada, datos.orden, datos.estado, datos.fechaPublicacion,
        cabecera.id,
      ]
    );
    const noticiaId = resultado.insertId;

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
    commitExitoso = true;

    res.status(201).json({ success: true, id: noticiaId, message: "Noticia creada" });
  } catch (error) {
    if (connection && !commitExitoso) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("No se pudo revertir la creación de la noticia:", rollbackError);
      }
    }
    if (!commitExitoso) {
      for (const media of mediasSubidasS3) {
        try {
          await noticiaMedia.eliminar(media);
        } catch (deleteError) {
          console.error("No se pudieron limpiar todos los archivos de la noticia luego del error:", deleteError);
        }
      }
    }
    console.error("Error al crear la noticia:", error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al crear la noticia");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/admin/noticias/:id(\\d+)", verifyToken, manejarUploadNoticia, async (req, res) => {
  let connection;
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
    if (!(await validarDepartamentalExistente(db, datos.departamentalId))) {
      return res.status(400).json("La departamental es inválida");
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    const [existentes] = await connection.query(
      "SELECT * FROM noticia WHERE id = ? AND eliminado = 0 LIMIT 1 FOR UPDATE",
      [noticiaId]
    );
    if (existentes.length === 0) {
      await connection.rollback();
      return res.status(404).json("Noticia no encontrada");
    }
    const existente = existentes[0];

    // Publicar por primera vez sin fecha explícita equivale a publicar ahora.
    if (datos.estado === "PUBLICADA" && !datos.fechaPublicacion) {
      datos.fechaPublicacion = existente.fecha_publicacion || new Date();
    }

    let mediaPortada = descriptorDesdeNoticia(existente);
    if (req.files?.imagen?.[0]) {
      mediaPortada = await noticiaMedia.procesarYSubir(req.files.imagen[0], "portadas");
      mediasNuevasS3.push(mediaPortada);
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

    const archivosGaleriaNuevos = req.files?.galeria || [];
    if (archivosGaleriaNuevos.length > 0) {
      const [[{ totalGaleria }]] = await connection.query(
        "SELECT COUNT(*) AS totalGaleria FROM noticia_imagen WHERE noticia_id = ?",
        [noticiaId]
      );
      if (Number(totalGaleria) + archivosGaleriaNuevos.length > MAX_IMAGENES_GALERIA) {
        throw crearErrorHttp(`La galería admite hasta ${MAX_IMAGENES_GALERIA} imágenes`, 400);
      }
      const [[{ maxOrden }]] = await connection.query(
        "SELECT COALESCE(MAX(orden), -1) AS maxOrden FROM noticia_imagen WHERE noticia_id = ?",
        [noticiaId]
      );
      let ordenSiguiente = Number(maxOrden) + 1;
      for (const file of archivosGaleriaNuevos) {
        const media = await noticiaMedia.procesarYSubir(file, "galeria");
        mediasNuevasS3.push(media);
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
       SET titulo = ?, bajada = ?, cuerpo = ?, categoria = ?, departamental_id = ?,
           imagen_archivo = ?, imagen_ancho = ?, imagen_alto = ?, imagen_mime = ?, imagen_variantes = ?,
           destacada = ?, orden = ?, estado = ?, fecha_publicacion = ?
       WHERE id = ?`,
      [
        datos.titulo, datos.bajada, datos.cuerpo, datos.categoria, datos.departamentalId,
        portadaDb.archivo, portadaDb.ancho, portadaDb.alto, portadaDb.mime, serializarVariantesDb(portadaDb),
        datos.destacada, datos.orden, datos.estado, datos.fechaPublicacion,
        noticiaId,
      ]
    );
    await connection.commit();
    commitExitoso = true;

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
    if (connection && !commitExitoso) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("No se pudo revertir la actualización de la noticia:", rollbackError);
      }
    }
    if (!commitExitoso) {
      for (const media of mediasNuevasS3) {
        try {
          await noticiaMedia.eliminar(media);
        } catch (deleteError) {
          console.error("No se pudieron limpiar todas las variantes nuevas de la noticia:", deleteError);
        }
      }
    }
    console.error("Error al actualizar la noticia:", error);
    res.status(error.statusCode || 500).json(error.statusCode ? error.message : "Error al actualizar la noticia");
  } finally {
    if (connection) connection.release();
  }
});

// Acciones rápidas del listado: destacar y cambiar estado sin pasar por el editor.
router.put("/admin/noticias/:id(\\d+)/flags", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!puedeGestionarNoticias(cabecera)) return res.status(401).json("No autorizado");

    const noticiaId = normalizarIdPositivo(req.params.id);
    if (!noticiaId) return res.status(400).json("ID inválido");

    const cambios = [];
    const params = [];

    if (req.body.destacada !== undefined) {
      const destacada = normalizarBooleanoBinario(req.body.destacada);
      if (destacada === null) return res.status(400).json("El valor de destacada es inválido");
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
    const [resultado] = await db.query(
      `UPDATE noticia SET ${cambios.join(", ")} WHERE id = ? AND eliminado = 0`,
      [...params, noticiaId]
    );
    if (resultado.affectedRows === 0) return res.status(404).json("Noticia no encontrada");

    res.status(200).json({ success: true, id: noticiaId, message: "Noticia actualizada" });
  } catch (error) {
    console.error("Error al actualizar los indicadores de la noticia:", error);
    res.status(500).json("Error al actualizar la noticia");
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
  verifyToken,
  validarDatosNoticia,
  sanitizarCuerpoNoticia,
  normalizarFechaPublicacion,
  normalizarIdPositivo,
  normalizarIdsExcluidos,
  normalizarPaginacion,
  normalizarBooleanoBinario,
  puedeGestionarNoticias,
});

module.exports = router;
