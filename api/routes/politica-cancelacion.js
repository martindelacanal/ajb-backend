"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { esAdministradorTurismo, tieneAreaTurismo, normalizarIdPositivo } = require("../services/turismo-catalogo");
const { validarTransicionTurismo } = require("../services/reservas-turismo");
const { obtenerFechaCivilArgentina, normalizarFechaCivil } = require("../services/valores-dominio");
const { registrarErrorRuta } = require("../services/errores");
const {
  ZONA_HORARIA, errorPolitica, obtenerPoliticaVigente, listarPoliticas, crearVersionPolitica, cotizarCancelacion,
} = require("../services/politica-cancelacion");

const router = express.Router();

function verifyToken(req, res, next) {
  return verificarTokenConAutorizacionActual({
    req, res, next, jwt, jwtSecret: process.env.JWT_SECRET, db: mysqlConnection.promise(), mensajeAuthorization: "No autorizado",
  });
}

function actorDe(req) { return JSON.parse(req.data.data); }

function responderError(res, error) {
  if (error?.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message, codigo: error.codigo });
  registrarErrorRuta(error);
  return res.status(500).json({ success: false, message: "No se pudo procesar la política de cancelación" });
}

function puedeLeerPolitica(actor) {
  if (actor?.rol === "familiar") return actor.modulo_turismo == null || Number(actor.modulo_turismo) === 1;
  return tieneAreaTurismo(actor);
}

router.get("/turismo/politica-cancelacion", verifyToken, async (req, res) => {
  try {
    if (!puedeLeerPolitica(actorDe(req))) throw errorPolitica("No autorizado", 403, "POLITICA_NO_AUTORIZADA");
    const politica = await obtenerPoliticaVigente(mysqlConnection.promise());
    // El motivo de los cambios y la identidad de sus autores son de auditoría.
    const { motivo, creada_por, autor_nombre, ...publica } = politica;
    return res.json({ politica: publica, fecha_actual: obtenerFechaCivilArgentina(), zona_horaria: ZONA_HORARIA });
  } catch (error) { return responderError(res, error); }
});

router.get("/admin/turismo/politicas-cancelacion", verifyToken, async (req, res) => {
  try {
    if (!esAdministradorTurismo(actorDe(req))) throw errorPolitica("Sólo un administrador de Turismo puede consultar la auditoría", 403, "POLITICA_NO_AUTORIZADA");
    return res.json(await listarPoliticas(mysqlConnection.promise()));
  } catch (error) { return responderError(res, error); }
});

router.post("/admin/turismo/politicas-cancelacion", verifyToken, async (req, res) => {
  let connection;
  try {
    const actor = actorDe(req);
    if (!esAdministradorTurismo(actor)) throw errorPolitica("Sólo un administrador de Turismo puede modificar la política", 403, "POLITICA_NO_AUTORIZADA");
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const politica = await crearVersionPolitica(connection, {
      versionActual: req.body?.version_actual,
      titulo: req.body?.titulo,
      motivo: req.body?.motivo,
      reglas: req.body?.reglas,
      usuarioId: actor.id,
    });
    await connection.commit();
    return res.status(201).json({ success: true, politica });
  } catch (error) {
    if (connection) await connection.rollback().catch(registrarErrorRuta);
    return responderError(res, error);
  } finally { if (connection) connection.release(); }
});

router.get("/reserva/:id(\\d+)/cancelacion-cotizacion", verifyToken, async (req, res) => {
  try {
    const actor = actorDe(req);
    if (!puedeLeerPolitica(actor)) throw errorPolitica("No autorizado", 403, "RESERVA_NO_AUTORIZADA");
    const reservaId = normalizarIdPositivo(req.params.id);
    if (!reservaId) throw errorPolitica("Reserva inválida");
    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT r.*, er.nombre AS estado_nombre, u.departamental_id AS usuario_departamental_id
         FROM reserva r INNER JOIN usuario u ON u.id = r.usuario_id
         LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id WHERE r.id = ?`, [reservaId]
    );
    const reserva = rows[0];
    if (!reserva) throw errorPolitica("Reserva no encontrada", 404, "RESERVA_NO_ENCONTRADA");
    if (actor.rol === "departamental" && (!normalizarIdPositivo(actor.departamental_id)
      || normalizarIdPositivo(actor.departamental_id) !== normalizarIdPositivo(reserva.usuario_departamental_id))) {
      throw errorPolitica("No puedes gestionar reservas de otra departamental", 403, "RESERVA_OTRA_DEPARTAMENTAL");
    }
    const transicion = validarTransicionTurismo({
      rol: actor.rol, usuarioId: actor.id, propietarioId: reserva.usuario_id,
      estadoActual: reserva.estado_nombre, estadoSolicitado: "Cancelada", modalidad: reserva.modalidad,
    });
    if (!transicion.valido) throw errorPolitica(transicion.mensaje, transicion.statusCode, transicion.codigo);
    if (normalizarFechaCivil(reserva.fecha_inicio) < obtenerFechaCivilArgentina()) {
      throw errorPolitica("No se puede cancelar una reserva cuya fecha de ingreso ya pasó", 409, "RESERVA_FECHA_VENCIDA");
    }
    const cotizacion = await cotizarCancelacion(db, { reserva });
    const { motivo, creada_por, autor_nombre, ...politica } = cotizacion.politica;
    return res.json({ ...cotizacion, politica });
  } catch (error) { return responderError(res, error); }
});

module.exports = router;
