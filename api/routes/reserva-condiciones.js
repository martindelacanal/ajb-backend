"use strict";

// Constancia de las condiciones de cancelación de una reserva. Las dos
// son OPCIONALES: la reserva no necesita ninguna para seguir su trámite.
//   GET    /reserva/:id/condiciones/constancia                     → PDF para imprimir y firmar en papel
//   POST   /reserva/:id/condiciones/constancia-firmada             → adjunta la constancia firmada (1 a 3 archivos)
//   DELETE /reserva/:id/condiciones/constancia-firmada/:archivoId  → la quita (borrado lógico: es prueba)
// Sólo el staff de Turismo (admin, admin-central y la departamental de la
// reserva). La persona afiliada ve la constancia adjunta en el detalle.

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { registrarErrorRuta } = require("../services/errores");
const { normalizarIdPositivo, tieneAreaTurismo } = require("../services/turismo-catalogo");
const {
  MAX_ARCHIVOS_CONSTANCIA, obtenerCargaReserva, obtenerCondicionesReserva,
} = require("../services/politica-cancelacion");
const { generarConstanciaCondiciones } = require("../services/reserva-condiciones-constancia");

const router = express.Router();

const ROLES_STAFF = new Set(["admin", "admin-central", "departamental"]);
const ESTADOS_CERRADOS = new Set(["Cancelada", "Rechazada", "Utilizada", "No adjudicada", "Convenio rechazado"]);
const MAX_BYTES_ARCHIVO = 10 * 1024 * 1024;
const MAX_ARCHIVOS_POR_CARGA = 3;
const MIME_CONSTANCIA = new Map([
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
]);
const CARACTER_INVALIDO_UTF8 = "�";
const S3_EXPIRES = Math.min(86400, Math.max(60, Number(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || 3600)));

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  region: process.env.BUCKET_REGION,
});

function verifyToken(req, res, next) {
  return verificarTokenConAutorizacionActual({
    req, res, next, jwt, jwtSecret: process.env.JWT_SECRET, db: mysqlConnection.promise(), mensajeAuthorization: "No autorizado",
  });
}

function cabeceraDe(req) {
  return JSON.parse(req.data.data);
}

function errorCondiciones(message, statusCode = 400, codigo = null) {
  return Object.assign(new Error(message), { statusCode, codigo });
}

function responderError(res, error, mensaje = "No se pudo completar la operación") {
  if (error?.statusCode) {
    return res.status(error.statusCode).json({ success: false, message: error.message, codigo: error.codigo || null });
  }
  registrarErrorRuta(error);
  return res.status(500).json({ success: false, message: mensaje });
}

function esStaffTurismo(cabecera) {
  return ROLES_STAFF.has(cabecera?.rol) && tieneAreaTurismo(cabecera);
}

// Antes de recibir archivos: la persona afiliada y los demás roles no suben nada.
function exigirStaffTurismo(req, res, next) {
  try {
    if (!esStaffTurismo(cabeceraDe(req))) {
      return res.status(403).json({ success: false, codigo: "CONSTANCIA_NO_AUTORIZADA", message: "Sólo el personal de Turismo maneja la constancia de condiciones." });
    }
    return next();
  } catch (error) {
    return responderError(res, error);
  }
}

// multer entrega el nombre en latin1: se repara a UTF-8 (como en olimpiadas).
function nombreArchivoOriginal(nombre) {
  let limpio = String(nombre ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!limpio) return null;
  if (/^[\x00-\xff]*$/.test(limpio)) {
    const reparado = Buffer.from(limpio, "latin1").toString("utf8");
    if (!reparado.includes(CARACTER_INVALIDO_UTF8)) limpio = reparado;
  }
  return Array.from(limpio).slice(0, 255).join("");
}

function contenidoCoincideConMime(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  switch (file.mimetype) {
    case "image/jpeg":
    case "image/jpg":
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/png":
      return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    case "application/pdf":
      return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    default:
      return false;
  }
}

const uploadConstancia = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_ARCHIVOS_POR_CARGA, fileSize: MAX_BYTES_ARCHIVO },
  fileFilter: (_req, file, callback) => {
    if (!MIME_CONSTANCIA.has(file.mimetype)) {
      return callback(errorCondiciones("Sólo se aceptan fotos (JPG, PNG o WebP) o PDF.", 400, "CONSTANCIA_TIPO_INVALIDO"));
    }
    return callback(null, true);
  },
});

function procesarArchivos(req, res, next) {
  uploadConstancia.array("archivos", MAX_ARCHIVOS_POR_CARGA)(req, res, (error) => {
    if (!error) {
      for (const file of req.files || []) {
        if (!contenidoCoincideConMime(file)) {
          return res.status(400).json({ success: false, codigo: "CONSTANCIA_CONTENIDO_INVALIDO", message: "El archivo no es una foto ni un PDF válido." });
        }
      }
      return next();
    }
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "Cada archivo puede pesar hasta 10 MB."
        : error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE"
          ? `Podés adjuntar hasta ${MAX_ARCHIVOS_POR_CARGA} archivos por vez (campo «archivos»).`
          : "La carga de archivos no es válida.";
      return res.status(400).json({ success: false, codigo: error.code, message });
    }
    return responderError(res, error, "No se pudo procesar la constancia");
  });
}

async function subirArchivo(file, reservaId) {
  const extension = MIME_CONSTANCIA.get(file.mimetype) || "bin";
  const key = `turismo/constancias/reserva${reservaId}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.${extension}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype === "image/jpg" ? "image/jpeg" : file.mimetype,
  }));
  return key;
}

async function firmarArchivo(key) {
  if (!key) return null;
  try {
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }), { expiresIn: S3_EXPIRES });
  } catch (error) {
    registrarErrorRuta(error);
    return null;
  }
}

// Si falla el alta, el objeto recién subido no queda huérfano en S3.
async function eliminarArchivoSeguro(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
  } catch (error) {
    registrarErrorRuta(error);
  }
}

async function leerArchivoS3(key) {
  const objeto = await s3.send(new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
  const cuerpo = objeto?.Body;
  if (!cuerpo) return null;
  if (Buffer.isBuffer(cuerpo)) return cuerpo;
  if (cuerpo instanceof Uint8Array) return Buffer.from(cuerpo);
  const partes = [];
  for await (const parte of cuerpo) partes.push(Buffer.isBuffer(parte) ? parte : Buffer.from(parte));
  return Buffer.concat(partes);
}

/**
 * Reserva con lo que necesitan la constancia y la subida, autorizando al staff:
 * la departamental sólo trabaja sobre reservas de su departamental.
 */
async function cargarReservaAutorizada(db, cabecera, reservaId) {
  const [rows] = await db.query(
    `SELECT r.id, r.usuario_id, r.modalidad, r.precio_total, r.fecha_creacion, r.firma_archivo,
            DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin,
            er.nombre AS estado,
            u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento AS afiliado_documento,
            u.departamental_id AS usuario_departamental_id, d.nombre AS departamental_nombre,
            s.nombre AS servicio_nombre, rec.nombre AS recurso_nombre, ch.nombre AS convenio_nombre,
            COALESCE(NULLIF(s.lugar, ''), NULLIF(CONCAT_WS(', ', ch.ciudad, ch.provincia), '')) AS lugar,
            so.nombre AS sorteo_nombre,
            rpc.firma_archivo AS aceptacion_firma_archivo
       FROM reserva r
       INNER JOIN usuario u ON u.id = r.usuario_id
       LEFT JOIN departamental d ON d.id = u.departamental_id
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
       LEFT JOIN recurso rec ON rec.id = r.recurso_id
       LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
       LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id, ch.servicio_id)
       LEFT JOIN sorteo so ON so.id = r.sorteo_id
       LEFT JOIN reserva_politica_cancelacion rpc ON rpc.reserva_id = r.id
      WHERE r.id = ?
      LIMIT 1`,
    [reservaId]
  );
  const reserva = rows[0];
  if (!reserva) throw errorCondiciones("Reserva no encontrada", 404, "RESERVA_NO_ENCONTRADA");
  if (cabecera.rol === "departamental") {
    const departamentalActor = normalizarIdPositivo(cabecera.departamental_id);
    if (!departamentalActor || departamentalActor !== normalizarIdPositivo(reserva.usuario_departamental_id)) {
      throw errorCondiciones("No podés gestionar la constancia de reservas de otra departamental.", 403, "RESERVA_OTRA_DEPARTAMENTAL");
    }
  }
  return reserva;
}

// Serializa las altas y bajas de archivos de una misma reserva (sólo esa fila).
async function bloquearReserva(connection, reservaId) {
  const [filas] = await connection.query("SELECT id FROM reserva WHERE id = ? FOR UPDATE", [reservaId]);
  if (!filas.length) throw errorCondiciones("Reserva no encontrada", 404, "RESERVA_NO_ENCONTRADA");
}

async function contarConstanciasVigentes(db, reservaId) {
  const [conteos] = await db.query(
    "SELECT COUNT(*) AS total FROM reserva_constancia_archivo WHERE reserva_id = ? AND eliminado = 0",
    [reservaId]
  );
  return Number(conteos[0]?.total || 0);
}

function errorTopeConstancias() {
  return errorCondiciones(`Una reserva admite hasta ${MAX_ARCHIVOS_CONSTANCIA} archivos de constancia.`, 409, "CONSTANCIA_MAXIMO");
}

async function nombreUsuario(db, usuarioId) {
  const [rows] = await db.query("SELECT nombre, apellido FROM usuario WHERE id = ? LIMIT 1", [usuarioId]);
  return [rows[0]?.nombre, rows[0]?.apellido].map((valor) => String(valor ?? "").trim()).filter(Boolean).join(" ");
}

router.get("/reserva/:id(\\d+)/condiciones/constancia", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    if (!esStaffTurismo(cabecera)) {
      throw errorCondiciones("Sólo el personal de Turismo imprime la constancia de condiciones.", 403, "CONSTANCIA_NO_AUTORIZADA");
    }
    const reservaId = normalizarIdPositivo(req.params.id);
    if (!reservaId) throw errorCondiciones("Reserva inválida", 400, "RESERVA_INVALIDA");
    const db = mysqlConnection.promise();
    const reserva = await cargarReservaAutorizada(db, cabecera, reservaId);
    const carga = await obtenerCargaReserva(db, reservaId);
    const condiciones = await obtenerCondicionesReserva(db, {
      reserva, carga, rol: cabecera.rol, usuarioId: cabecera.id,
    });
    if (!condiciones) {
      throw errorCondiciones("No se pudo determinar la política de cancelación de esta reserva.", 409, "CONDICIONES_NO_DISPONIBLES");
    }
    if (condiciones.origen === "PENDIENTE_FIRMA") {
      throw errorCondiciones("La reserva todavía no tiene condiciones aceptadas.", 409, "CONDICIONES_SIN_ACEPTAR");
    }
    if (ESTADOS_CERRADOS.has(reserva.estado)) {
      throw errorCondiciones("La reserva ya está cerrada: no hace falta firmar la constancia.", 409, "RESERVA_CERRADA");
    }
    const [personas] = await db.query(
      `SELECT u.nombre, u.apellido FROM reserva_familiar rf
         INNER JOIN usuario u ON u.id = rf.usuario_id
        WHERE rf.reserva_id = ?
        ORDER BY rf.parentesco_id ASC, rf.id ASC`,
      [reservaId]
    );
    // Si ya se firmó en pantalla y se sabe quién, la firma va en su recuadro.
    let firma = null;
    if (condiciones.firma?.firmante && reserva.aceptacion_firma_archivo) {
      try {
        const imagen = await leerArchivoS3(reserva.aceptacion_firma_archivo);
        if (imagen) {
          firma = {
            imagen, firmante: condiciones.firma.firmante, firmada_en: condiciones.firma.firmada_en,
            canal: condiciones.aceptacion?.canal || null,
          };
        }
      } catch (error) {
        registrarErrorRuta(error);
      }
    }
    const pdf = await generarConstanciaCondiciones({
      reserva,
      personas,
      condiciones,
      entregadaPor: condiciones.carga ? "" : await nombreUsuario(db, cabecera.id),
      firma,
    });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="constancia_condiciones_T-${reservaId}.pdf"`,
      "Cache-Control": "private, no-store",
    });
    return res.status(200).send(pdf);
  } catch (error) {
    return responderError(res, error, "Error al generar la constancia de condiciones");
  }
});

router.post(
  "/reserva/:id(\\d+)/condiciones/constancia-firmada",
  verifyToken,
  exigirStaffTurismo,
  procesarArchivos,
  async (req, res) => {
    let connection;
    const subidas = [];
    try {
      const cabecera = cabeceraDe(req);
      const reservaId = normalizarIdPositivo(req.params.id);
      if (!reservaId) throw errorCondiciones("Reserva inválida", 400, "RESERVA_INVALIDA");
      const archivos = req.files || [];
      if (!archivos.length) throw errorCondiciones("Elegí al menos un archivo de la constancia firmada.", 400, "CONSTANCIA_REQUERIDA");

      const db = mysqlConnection.promise();
      await cargarReservaAutorizada(db, cabecera, reservaId);
      const [solicitudes] = await db.query(
        `SELECT EXISTS(SELECT 1 FROM reserva_politica_cancelacion WHERE reserva_id = ?) AS aceptada,
                EXISTS(SELECT 1 FROM reserva_firma_afiliado WHERE reserva_id = ?) AS enviada_a_firmar`,
        [reservaId, reservaId]
      );
      // Mientras espera la firma (o si se dio de baja sin firmar) no hay condiciones aceptadas que probar.
      if (Number(solicitudes[0]?.enviada_a_firmar) === 1 && Number(solicitudes[0]?.aceptada) !== 1) {
        throw errorCondiciones("Esta reserva todavía no tiene condiciones aceptadas.", 409, "CONDICIONES_SIN_ACEPTAR");
      }
      if (await contarConstanciasVigentes(db, reservaId) + archivos.length > MAX_ARCHIVOS_CONSTANCIA) {
        throw errorTopeConstancias();
      }

      // Primero se suben (sin tener la reserva bloqueada mientras tanto); si
      // después algo falla, el catch borra lo subido.
      const preparados = [];
      for (const file of archivos) {
        const key = await subirArchivo(file, reservaId);
        subidas.push(key);
        preparados.push({
          key,
          nombre_original: nombreArchivoOriginal(file.originalname),
          mime: file.mimetype === "image/jpg" ? "image/jpeg" : file.mimetype,
          tamanio: file.size || null,
        });
      }

      connection = await db.getConnection();
      await connection.beginTransaction();
      // Dos cargas a la vez no pasan el tope: se vuelve a contar con la reserva bloqueada.
      await bloquearReserva(connection, reservaId);
      const vigentes = await contarConstanciasVigentes(connection, reservaId);
      if (vigentes + preparados.length > MAX_ARCHIVOS_CONSTANCIA) throw errorTopeConstancias();
      const guardados = [];
      for (const archivo of preparados) {
        const [insercion] = await connection.query(
          `INSERT INTO reserva_constancia_archivo
             (reserva_id, archivo, nombre_original, mime, tamanio, subido_por_usuario_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [reservaId, archivo.key, archivo.nombre_original, archivo.mime, archivo.tamanio, cabecera.id]
        );
        guardados.push({ ...archivo, id: Number(insercion.insertId), fecha_creacion: new Date() });
      }
      const cantidad = guardados.length;
      await connection.query(
        `INSERT INTO historial_reserva
           (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo,
            usuario_modificador_id, ip_address, user_agent, observaciones)
         VALUES (?, 'UPDATE', 'constancia_condiciones', ?, ?, ?, ?, ?, ?)`,
        [
          reservaId, String(vigentes), String(vigentes + cantidad), cabecera.id, req.ip || null,
          String(req.get("User-Agent") || "").slice(0, 255) || null,
          `Se adjuntó la constancia firmada (${cantidad} ${cantidad === 1 ? "archivo" : "archivos"})`,
        ]
      );
      await connection.commit();
      subidas.length = 0;

      const subidoPor = await nombreUsuario(db, cabecera.id).catch(() => "");
      const respuesta = [];
      for (const { key, ...archivo } of guardados) {
        respuesta.push({ ...archivo, url: await firmarArchivo(key), subido_por_nombre: subidoPor || null, puede_quitar: true });
      }
      return res.status(201).json({ success: true, archivos: respuesta });
    } catch (error) {
      if (connection) await connection.rollback().catch(registrarErrorRuta);
      for (const key of subidas) await eliminarArchivoSeguro(key);
      return responderError(res, error, "Error al adjuntar la constancia firmada");
    } finally {
      if (connection) connection.release();
    }
  }
);

router.delete("/reserva/:id(\\d+)/condiciones/constancia-firmada/:archivoId(\\d+)", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = cabeceraDe(req);
    if (!esStaffTurismo(cabecera)) {
      throw errorCondiciones("Sólo el personal de Turismo maneja la constancia de condiciones.", 403, "CONSTANCIA_NO_AUTORIZADA");
    }
    const reservaId = normalizarIdPositivo(req.params.id);
    const archivoId = normalizarIdPositivo(req.params.archivoId);
    if (!reservaId || !archivoId) throw errorCondiciones("Identificadores inválidos", 400, "IDENTIFICADORES_INVALIDOS");

    const db = mysqlConnection.promise();
    await cargarReservaAutorizada(db, cabecera, reservaId);
    connection = await db.getConnection();
    await connection.beginTransaction();
    await bloquearReserva(connection, reservaId);
    const [archivos] = await connection.query(
      `SELECT id, nombre_original, subido_por_usuario_id FROM reserva_constancia_archivo
        WHERE id = ? AND reserva_id = ? AND eliminado = 0
        LIMIT 1 FOR UPDATE`,
      [archivoId, reservaId]
    );
    const archivo = archivos[0];
    if (!archivo) throw errorCondiciones("La constancia no existe o ya se quitó.", 404, "CONSTANCIA_NO_ENCONTRADA");
    // Es prueba de lo que se firmó: la quita sólo quien la adjuntó o un administrador.
    if (cabecera.rol !== "admin" && Number(archivo.subido_por_usuario_id) !== Number(cabecera.id)) {
      throw errorCondiciones("Sólo quien adjuntó la constancia o un administrador puede quitarla.", 403, "CONSTANCIA_AJENA");
    }
    const vigentes = await contarConstanciasVigentes(connection, reservaId);
    // Borrado lógico: el objeto de S3 se conserva.
    const [baja] = await connection.query(
      `UPDATE reserva_constancia_archivo
          SET eliminado = 1, eliminado_por_usuario_id = ?, eliminado_en = NOW()
        WHERE id = ? AND reserva_id = ? AND eliminado = 0`,
      [cabecera.id, archivoId, reservaId]
    );
    if (baja.affectedRows !== 1) throw errorCondiciones("La constancia no existe o ya se quitó.", 404, "CONSTANCIA_NO_ENCONTRADA");
    await connection.query(
      `INSERT INTO historial_reserva
         (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo,
          usuario_modificador_id, ip_address, user_agent, observaciones)
       VALUES (?, 'UPDATE', 'constancia_condiciones', ?, ?, ?, ?, ?, ?)`,
      [
        reservaId, String(vigentes), String(Math.max(0, vigentes - 1)), cabecera.id, req.ip || null,
        String(req.get("User-Agent") || "").slice(0, 255) || null,
        `Se quitó «${archivo.nombre_original || `archivo ${archivoId}`}» de la constancia firmada`,
      ]
    );
    await connection.commit();
    return res.status(200).json({ success: true });
  } catch (error) {
    if (connection) await connection.rollback().catch(registrarErrorRuta);
    return responderError(res, error, "Error al quitar la constancia firmada");
  } finally {
    if (connection) connection.release();
  }
});

// Para los tests: el cliente de S3 se reemplaza sin tocar la red.
router.__test = { s3, contenidoCoincideConMime, nombreArchivoOriginal };

module.exports = router;
