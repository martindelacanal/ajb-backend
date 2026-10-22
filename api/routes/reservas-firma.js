"use strict";

// «Pendiente de firma»: la persona afiliada firma (o no acepta) la reserva que
// le cargó el staff, y el staff la firma en pantalla o le vuelve a avisar. La lógica vive
// en api/services/reservas-firma.js; acá sólo hay sesión, transacción, S3 y respuesta.
// Se monta en app.js antes de userRoute.
//
//   GET /reservas/firmas-pendientes          afiliado (también la cuenta de un familiar invitado)
//   PUT /reserva/:id/firma-afiliado          { accion: FIRMAR | RECHAZAR | FIRMAR_EN_PANTALLA | REENVIAR, … }

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { ErrorRestriccionCuenta, cuerpoRestriccion } = require("../security/restricciones-cuenta");
const { tieneAreaTurismo, normalizarIdPositivo } = require("../services/turismo-catalogo");
const { crearEventoInvalidacionHold } = require("../services/turismo-reserva-holds");
const { registrarErrorRuta } = require("../services/errores");
const { listarFirmasPendientes, responderFirma } = require("../services/reservas-firma");

const router = express.Router();

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

function actorDe(req) {
  return JSON.parse(req.data.data);
}

function contextoDe(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.get("User-Agent") || null,
  };
}

function responderError(res, error, mensajePorDefecto) {
  if (error instanceof ErrorRestriccionCuenta) return res.status(error.statusCode).json(cuerpoRestriccion(error));
  if (error?.statusCode) {
    return res.status(error.statusCode).json({
      success: false, message: error.message, codigo: error.codigo || null, ...(error.detalles || {}),
    });
  }
  registrarErrorRuta(error);
  // La firma bloquea persona → reserva; un cambio de estado del staff sobre la misma persona
  // (PUT /reserva/:id/estado) bloquea reserva → persona. Si se cruzan, InnoDB revierte una
  // (deadlock): no quedó nada a medias, así que se responde como «la reserva cambió» (el
  // detalle la vuelve a cargar) en vez de un error genérico.
  if (error?.code === "ER_LOCK_DEADLOCK" || error?.errno === 1213) {
    return res.status(409).json({
      success: false, codigo: "RESERVA_MODIFICADA",
      message: "La reserva cambió mientras se guardaba. Volvé a abrirla e intentalo de nuevo.",
    });
  }
  return res.status(500).json({ success: false, message: mensajePorDefecto });
}

// Mismo nombre que las firmas del alta: el detalle firma la URL de reserva.firma_archivo.
async function subirFirmaS3(buffer) {
  const clave = `firma_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.png`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME, Key: clave, Body: buffer, ContentType: "image/png",
  }));
  return clave;
}

async function borrarFirmaS3(clave) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: clave }));
  } catch (error) {
    registrarErrorRuta(error);
  }
}

function emitirInvalidacionDisponibilidad(req, evento, motivo) {
  const datos = crearEventoInvalidacionHold(evento, motivo);
  if (datos) req.app.get("io")?.emit("servicios:disponibilidad:invalidada", datos);
}

router.get("/reservas/firmas-pendientes", verifyToken, async (req, res) => {
  try {
    const actor = actorDe(req);
    if (actor.rol !== "afiliado" || !tieneAreaTurismo(actor)) {
      return res.status(403).json({ success: false, message: "No autorizado", codigo: "FIRMA_NO_AUTORIZADA" });
    }
    const reservas = await listarFirmasPendientes(mysqlConnection.promise(), actor.id);
    return res.json({ reservas });
  } catch (error) {
    return responderError(res, error, "No se pudieron cargar las reservas para firmar");
  }
});

router.put("/reserva/:id(\\d+)/firma-afiliado", verifyToken, async (req, res) => {
  let connection;
  const subidas = [];
  try {
    const actor = actorDe(req);
    if (!tieneAreaTurismo(actor)) {
      return res.status(403).json({ success: false, message: "No autorizado", codigo: "FIRMA_NO_AUTORIZADA" });
    }
    const reservaId = normalizarIdPositivo(req.params.id);
    if (!reservaId) return res.status(400).json({ success: false, message: "Reserva inválida" });

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const resultado = await responderFirma(connection, {
      reservaId,
      actor,
      accion: req.body?.accion,
      body: req.body || {},
      contexto: contextoDe(req),
      subirFirma: async (buffer) => {
        const clave = await subirFirmaS3(buffer);
        subidas.push(clave);
        return clave;
      },
    });
    await connection.commit();
    subidas.length = 0;

    if (resultado.invalidacion) {
      emitirInvalidacionDisponibilidad(req, resultado.invalidacion, resultado.vencida ? "RESERVA_FIRMA_VENCIDA" : "RESERVA_FIRMA_RECHAZADA");
    }
    if (resultado.vencida) {
      return res.status(409).json({
        success: false,
        codigo: "FIRMA_VENCIDA",
        message: "El plazo para firmar venció: la reserva se dio de baja y se liberó el lugar.",
        estado: resultado.estado,
        reserva: resultado.reserva,
      });
    }
    const { invalidacion, ...respuesta } = resultado;
    return res.json({ success: true, ...respuesta });
  } catch (error) {
    if (connection) await connection.rollback().catch(registrarErrorRuta);
    // Si la transacción no se confirmó, la firma subida no quedó en ninguna reserva.
    for (const clave of subidas) await borrarFirmaS3(clave);
    return responderError(res, error, "No se pudo responder la firma de la reserva");
  } finally {
    if (connection) connection.release();
  }
});

router.__test = Object.freeze({ s3 });

module.exports = router;
