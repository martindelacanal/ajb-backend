"use strict";

// Cambios de datos de familiares pedidos por el afiliado, con aprobación de la
// departamental (services/familiares-cambios.js).
//
// Afiliado:
//   POST   /familiares/:id/cambios          → crea (o reemplaza) el pedido PENDIENTE. 202 {pendiente:true, solicitud_id}
//   DELETE /familiares/cambios/:id          → retira su pedido PENDIENTE (→ CANCELADA)
//   GET    /familiares/cambios/:id          → su pedido (sin advertencias)
// Staff (admin y admin-central: todo; departamental: su departamental, mientras
// siga siendo la del titular):
//   GET    /familiares/cambios              → bandeja con filtros y conteos por estado
//   GET    /familiares/cambios/:id          → detalle con advertencias para decidir (+ version)
//   POST   /familiares/cambios/:id/resolucion {accion:'APROBAR'|'RECHAZAR', motivo, forzar?, version}
//          (version distinta de la actual → 409 SOLICITUD_MODIFICADA)
//
// Los cambios de vínculo ("Sumar/Quitar del grupo familiar") llegan por
// PUT /familiares/:id/vinculo y POST /familiares (routes/user.js) y se resuelven acá.
// Los :id van con (\d+) para no chocar con /familiares/:id/vinculo (routes/user.js).

const express = require("express");
const jwt = require("jsonwebtoken");

const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { registrarErrorRuta } = require("../services/errores");
const { contextoDesdeRequest, resumenResultado } = require("../services/usuarios-datos");
const {
  cancelarSolicitud,
  cuerpoErrorCambio,
  detalleSolicitud,
  extraerDatosSolicitados,
  listarSolicitudes,
  resolverSolicitud,
  solicitarCambioFamiliar,
} = require("../services/familiares-cambios");

const router = express.Router();

function verifyToken(req, res, next) {
  return verificarTokenConAutorizacionActual({
    req,
    res,
    next,
    jwt,
    jwtSecret: process.env.JWT_SECRET,
    db: mysqlConnection.promise(),
    mensajeAuthorization: "No autorizado",
  });
}

function cabeceraDe(req) {
  return JSON.parse(req.data.data);
}

function responderError(res, error, mensaje500) {
  if (error?.statusCode) return res.status(error.statusCode).json(cuerpoErrorCambio(error));
  registrarErrorRuta(error);
  return res.status(500).json({ success: false, message: mensaje500 });
}

async function enTransaccion(trabajo) {
  let connection;
  try {
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const resultado = await trabajo(connection);
    await connection.commit();
    return resultado;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        registrarErrorRuta(rollbackError);
      }
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

function mensajeSolicitudEnviada(resultado) {
  const base = resultado.reemplazada
    ? "Actualizamos tu pedido de cambios."
    : "Enviamos los cambios a tu departamental.";
  return `${base} Quedan en revisión hasta que los apruebe; mientras tanto se usan los datos actuales.`;
}

// POST /familiares/:id/cambios — el afiliado pide cambiar datos de un familiar
// o acompañante de su universo (el mismo de POST /tabla/acompaniantes).
router.post("/familiares/:id(\\d+)/cambios", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    if (cabecera.rol !== "afiliado") {
      return res.status(403).json({ success: false, message: "Sólo el afiliado puede pedir cambios de datos de su grupo" });
    }
    const resultado = await enTransaccion((connection) => solicitarCambioFamiliar(connection, {
      actor: cabecera,
      personaId: req.params.id,
      datos: extraerDatosSolicitados(req.body),
    }));
    return res.status(202).json({
      success: true,
      pendiente: true,
      message: mensajeSolicitudEnviada(resultado),
      ...resultado,
    });
  } catch (error) {
    return responderError(res, error, "No se pudo enviar el pedido de cambio");
  }
});

// GET /familiares/cambios — bandeja del staff.
router.get("/familiares/cambios", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    const resultado = await listarSolicitudes(mysqlConnection.promise(), { actor: cabecera, query: req.query });
    return res.status(200).json({ success: true, ...resultado });
  } catch (error) {
    return responderError(res, error, "No se pudieron obtener los pedidos de cambio");
  }
});

// GET /familiares/cambios/:id — detalle (staff con advertencias; afiliado dueño sin ellas).
router.get("/familiares/cambios/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    const data = await detalleSolicitud(mysqlConnection.promise(), { actor: cabecera, solicitudId: req.params.id });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return responderError(res, error, "No se pudo obtener el pedido de cambio");
  }
});

// POST /familiares/cambios/:id/resolucion — aprobar (aplica los datos) o rechazar (con motivo).
router.post("/familiares/cambios/:id(\\d+)/resolucion", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    const body = req.body || {};
    const resultado = await enTransaccion((connection) => resolverSolicitud(connection, {
      actor: cabecera,
      solicitudId: req.params.id,
      accion: body.accion,
      motivo: body.motivo,
      forzar: body.forzar,
      version: body.version,
      contexto: contextoDesdeRequest(req),
    }));
    const aprobada = resultado.estado === "APROBADA";
    return res.status(200).json({
      success: true,
      message: aprobada
        ? "Cambio aprobado: los datos nuevos ya están vigentes y avisamos al afiliado"
        : "Pedido rechazado: le avisamos al afiliado con el motivo",
      solicitud_id: resultado.solicitud_id,
      codigo: resultado.codigo,
      estado: resultado.estado,
      forzada: Boolean(resultado.forzada),
      motivo_rechazo: resultado.motivo_rechazo ?? null,
      campos: resultado.campos,
      cambio_vinculo: resultado.cambio_vinculo ?? null,
      ...resumenResultado(resultado.resultado),
    });
  } catch (error) {
    return responderError(res, error, "No se pudo resolver el pedido de cambio");
  }
});

// DELETE /familiares/cambios/:id — el afiliado retira su pedido pendiente.
router.delete("/familiares/cambios/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    const resultado = await enTransaccion((connection) => cancelarSolicitud(connection, {
      actor: cabecera,
      solicitudId: req.params.id,
    }));
    return res.status(200).json({
      success: true,
      message: "Retiramos tu pedido de cambio: los datos quedan como estaban",
      ...resultado,
    });
  } catch (error) {
    return responderError(res, error, "No se pudo retirar el pedido de cambio");
  }
});

module.exports = router;
