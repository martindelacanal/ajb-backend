"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// PLACAS DE TURISMO · administración (/api/admin/turismo/placas*)
// Flyers de ofertas (convenios con agencias, promos de temporada) que se ven en el
// carrusel de /turismo y en la página pública de turismo. Los gestiona admin y
// admin-central con el área Turismo. La lectura pública está en routes/publico.js.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { registrarErrorRuta } = require("../services/errores");
const { esAdministradorTurismo, normalizarBooleano, normalizarIdPositivo } = require("../services/turismo-catalogo");
const {
  MAX_IMAGEN_BYTES,
  MIMES_PERMITIDOS,
  PREFIJO_S3,
  combinarOrden,
  contenidoCoincideConMime,
  fechaHoyArgentina,
  mapearPlacaAdmin,
  normalizarIdsOrden,
  procesarImagenPlaca,
  validarDatosPlaca,
} = require("../services/turismo-placas");

const router = express.Router();

// ── S3 ─────────────────────────────────────────────────────────────────────
const s3SignedUrlExpiresConfigurado = Number(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || "3600");
const S3_SIGNED_URL_EXPIRES_SECONDS = Number.isSafeInteger(s3SignedUrlExpiresConfigurado)
  && s3SignedUrlExpiresConfigurado >= 60
  && s3SignedUrlExpiresConfigurado <= 86400
  ? s3SignedUrlExpiresConfigurado
  : 3600;

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  region: process.env.BUCKET_REGION,
});

async function firmarSeguro(key) {
  if (!key) return null;
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }),
      { expiresIn: S3_SIGNED_URL_EXPIRES_SECONDS }
    );
  } catch (error) {
    console.error("No se pudo firmar la imagen de una placa", { key, code: error?.name || error?.code });
    return null;
  }
}

async function subirImagenPlaca(imagen) {
  const key = `${PREFIJO_S3}/${crypto.randomUUID()}.webp`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: key,
    Body: imagen.buffer,
    ContentType: imagen.contentType,
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return key;
}

// Sólo para deshacer una subida cuando falla la base: las bajas son lógicas y conservan S3.
async function eliminarImagenSubidaSeguro(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
  } catch (error) {
    console.error("No se pudo limpiar la imagen subida de una placa", { key, code: error?.name || error?.code });
  }
}

// ── Sesión y permisos ──────────────────────────────────────────────────────
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

function cabeceraDe(req) {
  return JSON.parse(req.data.data);
}

// Antes de leer el multipart: si no tiene permiso, ni se procesa la imagen.
function exigirAdministradorTurismo(req, res, next) {
  let cabecera;
  try {
    cabecera = cabeceraDe(req);
  } catch (_error) {
    return res.status(401).json("Tu sesión no es válida. Volvé a iniciar sesión.");
  }
  if (!esAdministradorTurismo(cabecera)) {
    return res.status(403).json("No tenés permiso para administrar las placas de turismo");
  }
  req.cabeceraPlacas = cabecera;
  return next();
}

// ── Carga de la imagen ─────────────────────────────────────────────────────
const uploadImagenPlaca = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGEN_BYTES, files: 1, fields: 20, fieldSize: 16 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (file.fieldname === "imagen" && MIMES_PERMITIDOS.has(file.mimetype)) return callback(null, true);
    const error = new Error("La imagen tiene que ser JPG, PNG o WebP");
    error.statusCode = 400;
    return callback(error);
  },
}).single("imagen");

function manejarUploadPlaca(req, res, next) {
  uploadImagenPlaca(req, res, (error) => {
    if (error) {
      // Multer arma los errores de límite en inglés: se traducen por código.
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") return res.status(400).json("La imagen puede pesar hasta 8 MB");
        if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json("Subí una sola imagen en el campo «imagen»");
        }
        return res.status(400).json("No se pudo leer el formulario de la placa");
      }
      return res.status(error.statusCode || 400).json(error.message || "No se pudo procesar la imagen");
    }
    if (req.file && !contenidoCoincideConMime(req.file)) {
      return res.status(400).json("El contenido del archivo no coincide con un formato de imagen permitido");
    }
    return next();
  });
}

// ── Consultas ──────────────────────────────────────────────────────────────
const CAMPOS_PLACA = `id, titulo, descripcion, imagen_archivo, imagen_ancho, imagen_alto, enlace_url, enlace_texto,
  vigencia_desde, vigencia_hasta, publicado, orden, fecha_modificacion`;

async function listarPlacasAdmin(db) {
  const [filas] = await db.query(
    `SELECT ${CAMPOS_PLACA} FROM turismo_placa WHERE eliminado = 0 ORDER BY orden ASC, id ASC`
  );
  const hoy = fechaHoyArgentina();
  return Promise.all(filas.map(async (fila) => mapearPlacaAdmin(fila, await firmarSeguro(fila.imagen_archivo), hoy)));
}

async function obtenerPlacaAdmin(db, placaId) {
  const [filas] = await db.query(
    `SELECT ${CAMPOS_PLACA} FROM turismo_placa WHERE id = ? AND eliminado = 0 LIMIT 1`,
    [placaId]
  );
  if (filas.length === 0) return null;
  return mapearPlacaAdmin(filas[0], await firmarSeguro(filas[0].imagen_archivo));
}

function responderError(res, error, mensaje) {
  registrarErrorRuta(error, "turismo-placas");
  if (res.headersSent) return undefined;
  if (error?.statusCode) return res.status(error.statusCode).json(error.message);
  return res.status(500).json(mensaje);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/turismo/placas — todas las no eliminadas, por orden
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/turismo/placas", verifyToken, exigirAdministradorTurismo, async (_req, res) => {
  try {
    res.status(200).json(await listarPlacasAdmin(mysqlConnection.promise()));
  } catch (error) {
    responderError(res, error, "Error al obtener las placas de turismo");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/turismo/placas — alta (multipart, imagen obligatoria). Queda primera.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/turismo/placas", verifyToken, exigirAdministradorTurismo, manejarUploadPlaca, async (req, res) => {
  let connection;
  let keySubida = null;
  try {
    const usuarioId = normalizarIdPositivo(req.cabeceraPlacas.id);
    const validacion = validarDatosPlaca(req.body);
    if (validacion.error) return res.status(400).json(validacion.error);
    if (!req.file) return res.status(400).json("La imagen de la placa es obligatoria");

    const imagen = await procesarImagenPlaca(req.file);
    keySubida = await subirImagenPlaca(imagen);
    const datos = validacion.datos;

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    const [[{ minimo }]] = await connection.query(
      "SELECT MIN(orden) AS minimo FROM turismo_placa WHERE eliminado = 0 FOR UPDATE"
    );
    const orden = minimo === null || minimo === undefined ? 0 : Number(minimo) - 1;
    const [resultado] = await connection.query(
      `INSERT INTO turismo_placa
         (titulo, descripcion, imagen_archivo, imagen_ancho, imagen_alto, enlace_url, enlace_texto,
          vigencia_desde, vigencia_hasta, publicado, orden, creado_por_usuario_id, modificado_por_usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datos.titulo, datos.descripcion, keySubida, imagen.ancho, imagen.alto, datos.enlace_url, datos.enlace_texto,
        datos.vigencia_desde, datos.vigencia_hasta, datos.publicado, orden, usuarioId, usuarioId,
      ]
    );
    await connection.commit();
    keySubida = null;

    res.status(201).json(await obtenerPlacaAdmin(db, resultado.insertId));
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    await eliminarImagenSubidaSeguro(keySubida);
    responderError(res, error, "Error al crear la placa de turismo");
  } finally {
    if (connection) connection.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /admin/turismo/placas/orden — { ids: number[] } → lista completa
// (definida antes que /:id; igual el :id sólo acepta dígitos)
// ─────────────────────────────────────────────────────────────────────────────
router.put("/admin/turismo/placas/orden", verifyToken, exigirAdministradorTurismo, async (req, res) => {
  let connection;
  try {
    const ids = normalizarIdsOrden(req.body?.ids);
    if (!ids) return res.status(400).json("Mandá la lista de placas a ordenar (ids sin repetir)");
    const usuarioId = normalizarIdPositivo(req.cabeceraPlacas.id);

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    const [actuales] = await connection.query(
      "SELECT id FROM turismo_placa WHERE eliminado = 0 ORDER BY orden ASC, id ASC FOR UPDATE"
    );
    const existentes = new Set(actuales.map((fila) => Number(fila.id)));
    if (ids.some((id) => !existentes.has(id))) {
      await connection.rollback();
      return res.status(400).json("Alguna de las placas a ordenar no existe o fue eliminada. Actualizá la lista.");
    }
    const ordenFinal = combinarOrden(ids, actuales);
    // Sólo se tocan las que cambian de lugar (así su fecha de modificación no se mueve en vano).
    for (const [indice, id] of ordenFinal.entries()) {
      await connection.query(
        "UPDATE turismo_placa SET orden = ?, modificado_por_usuario_id = ? WHERE id = ? AND orden <> ?",
        [indice, usuarioId, id, indice]
      );
    }
    await connection.commit();

    res.status(200).json(await listarPlacasAdmin(db));
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    responderError(res, error, "Error al ordenar las placas de turismo");
  } finally {
    if (connection) connection.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /admin/turismo/placas/:id — edición (multipart, imagen opcional)
// Los campos que no vienen conservan su valor.
// ─────────────────────────────────────────────────────────────────────────────
router.put("/admin/turismo/placas/:id(\\d+)", verifyToken, exigirAdministradorTurismo, manejarUploadPlaca, async (req, res) => {
  let connection;
  let keySubida = null;
  try {
    const placaId = normalizarIdPositivo(req.params.id);
    if (!placaId) return res.status(400).json("ID inválido");
    const usuarioId = normalizarIdPositivo(req.cabeceraPlacas.id);

    const db = mysqlConnection.promise();
    const [existentes] = await db.query(
      "SELECT * FROM turismo_placa WHERE id = ? AND eliminado = 0 LIMIT 1",
      [placaId]
    );
    if (existentes.length === 0) return res.status(404).json("La placa no existe o fue eliminada");

    const validacion = validarDatosPlaca(req.body, existentes[0]);
    if (validacion.error) return res.status(400).json(validacion.error);
    const datos = validacion.datos;

    let imagen = null;
    if (req.file) {
      imagen = await procesarImagenPlaca(req.file);
      keySubida = await subirImagenPlaca(imagen);
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    const [bloqueadas] = await connection.query(
      "SELECT id FROM turismo_placa WHERE id = ? AND eliminado = 0 FOR UPDATE",
      [placaId]
    );
    if (bloqueadas.length === 0) {
      await connection.rollback();
      await eliminarImagenSubidaSeguro(keySubida);
      keySubida = null;
      return res.status(404).json("La placa no existe o fue eliminada");
    }
    await connection.query(
      `UPDATE turismo_placa
          SET titulo = ?, descripcion = ?, enlace_url = ?, enlace_texto = ?,
              vigencia_desde = ?, vigencia_hasta = ?, publicado = ?, modificado_por_usuario_id = ?
              ${imagen ? ", imagen_archivo = ?, imagen_ancho = ?, imagen_alto = ?" : ""}
        WHERE id = ?`,
      [
        datos.titulo, datos.descripcion, datos.enlace_url, datos.enlace_texto,
        datos.vigencia_desde, datos.vigencia_hasta, datos.publicado, usuarioId,
        ...(imagen ? [keySubida, imagen.ancho, imagen.alto] : []),
        placaId,
      ]
    );
    await connection.commit();
    keySubida = null;

    res.status(200).json(await obtenerPlacaAdmin(db, placaId));
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    await eliminarImagenSubidaSeguro(keySubida);
    responderError(res, error, "Error al actualizar la placa de turismo");
  } finally {
    if (connection) connection.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /admin/turismo/placas/:id/publicado — { publicado: boolean }
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/admin/turismo/placas/:id(\\d+)/publicado", verifyToken, exigirAdministradorTurismo, async (req, res) => {
  try {
    const placaId = normalizarIdPositivo(req.params.id);
    if (!placaId) return res.status(400).json("ID inválido");
    const publicado = normalizarBooleano(req.body?.publicado);
    if (publicado === undefined || publicado === null) {
      return res.status(400).json("Indicá si la placa queda publicada (true) u oculta (false)");
    }
    const usuarioId = normalizarIdPositivo(req.cabeceraPlacas.id);

    const db = mysqlConnection.promise();
    const [resultado] = await db.query(
      "UPDATE turismo_placa SET publicado = ?, modificado_por_usuario_id = ? WHERE id = ? AND eliminado = 0",
      [publicado, usuarioId, placaId]
    );
    if (resultado.affectedRows === 0) return res.status(404).json("La placa no existe o fue eliminada");

    res.status(200).json(await obtenerPlacaAdmin(db, placaId));
  } catch (error) {
    responderError(res, error, "Error al cambiar la publicación de la placa");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/turismo/placas/:id — baja lógica (la imagen queda en S3)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/admin/turismo/placas/:id(\\d+)", verifyToken, exigirAdministradorTurismo, async (req, res) => {
  try {
    const placaId = normalizarIdPositivo(req.params.id);
    if (!placaId) return res.status(400).json("ID inválido");
    const usuarioId = normalizarIdPositivo(req.cabeceraPlacas.id);

    const [resultado] = await mysqlConnection.promise().query(
      "UPDATE turismo_placa SET eliminado = 1, modificado_por_usuario_id = ? WHERE id = ? AND eliminado = 0",
      [usuarioId, placaId]
    );
    if (resultado.affectedRows === 0) return res.status(404).json("La placa no existe o ya fue eliminada");

    res.status(200).json({ id: placaId });
  } catch (error) {
    responderError(res, error, "Error al eliminar la placa de turismo");
  }
});

router.__test = Object.freeze({
  exigirAdministradorTurismo,
  verifyToken,
});

module.exports = router;
