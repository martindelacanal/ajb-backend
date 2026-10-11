"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { limitar } = require("../security/recuperacion-password");
const { crearServicioAccesoUsuarios } = require("../services/usuarios-acceso");

function crearRouterAccesoUsuarios({ db = mysqlConnection.promise(), jwtSecret = process.env.JWT_SECRET, enviar } = {}) {
  const router = express.Router();
  const servicio = crearServicioAccesoUsuarios({ db, enviar });
  const verificar = (req, res, next) => verificarTokenConAutorizacionActual({ req, res, next, db, jwt, jwtSecret });
  const ejecutar = (operacion) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const actorId = JSON.parse(req.data.data).id;
      if (["resetear", "cambiarObligatoria"].includes(operacion)) await limitar(db, `acceso:${operacion}:${actorId}`, 15, 900, jwtSecret);
      const args = operacion === "cambiarObligatoria" ? { usuarioId: actorId, passwordActual: req.body?.passwordActual, password: req.body?.password }
        : { actorId, usuarioId: req.params.id, body: req.body };
      res.json(await servicio[operacion](args));
    } catch (error) {
      if (error.statusCode) {
        if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
        return res.status(error.statusCode).json({ success: false, mensaje: error.message, message: error.message });
      }
      console.error("[usuarios-acceso] Operación no disponible:", error?.code || "error_interno");
      res.status(500).json({ mensaje: "No pudimos actualizar el acceso. Volvé a intentar." });
    }
  };
  router.patch("/usuarios/:id/bloqueo", verificar, ejecutar("bloquear"));
  router.delete("/usuarios/:id/bloqueo", verificar, ejecutar("desbloquear"));
  router.post("/usuarios/:id/reset-password", verificar, ejecutar("resetear"));
  router.post("/auth/password/cambiar-obligatoria", verificar, ejecutar("cambiarObligatoria"));
  return router;
}
module.exports = crearRouterAccesoUsuarios();
module.exports.crearRouterAccesoUsuarios = crearRouterAccesoUsuarios;
