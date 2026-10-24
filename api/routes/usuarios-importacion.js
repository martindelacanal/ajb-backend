"use strict";

const express = require("express");
const multer = require("../security/multipart");
const jwt = require("jsonwebtoken");
const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { limitar } = require("../security/recuperacion-password");
const { MAX_BYTES, autorizarImportacion, crearServicioImportacionUsuarios } = require("../services/usuarios-importacion");

function crearRouterImportacionUsuarios({ db = mysqlConnection.promise(), jwtSecret = process.env.JWT_SECRET, encolar } = {}) {
  const router = express.Router();
  const servicio = crearServicioImportacionUsuarios({ db, jwtSecret, encolar });
  const verificar = (req, res, next) => verificarTokenConAutorizacionActual({ req, res, next, db, jwt, jwtSecret });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 4, fieldSize: 4096, parts: 5 } }).single("archivo");
  function responderError(res, error) {
    if (error.statusCode) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      return res.status(error.statusCode).json({ success: false, mensaje: error.message, message: error.message, ...error.detalles });
    }
    console.error("[usuarios-importacion] Operación no disponible:", error?.code || "error_interno");
    return res.status(500).json({ success: false, mensaje: "No pudimos completar la importación. Volvé a intentar." });
  }
  async function autorizar(req, res, next) {
    try {
      const actor = JSON.parse(req.data.data);
      autorizarImportacion(actor);
      await limitar(db, `importacion:${actor.id}`, 20, 900, jwtSecret);
      next();
    } catch (error) { responderError(res, error); }
  }
  function cargar(req, res, next) {
    upload(req, res, (error) => {
      if (!error) return next();
      const grande = error.code === "LIMIT_FILE_SIZE";
      return res.status(grande ? 413 : 400).json({ success: false,
        mensaje: grande ? "El archivo supera el máximo de 2 MB." : "Adjuntá un único Excel (.xlsx) o CSV en el campo archivo." });
    });
  }
  const ejecutar = (operacion) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const actorId = JSON.parse(req.data.data).id;
      const resultado = await servicio[operacion]({ actorId, archivo: req.file, departamentalId: req.body?.departamental_id,
        token: req.body?.token, enviarBienvenida: req.body?.enviarBienvenida });
      res.status(operacion === "confirmar" ? 201 : 200).json(resultado);
    } catch (error) { responderError(res, error); }
  };
  router.post("/usuarios/importacion/preview", verificar, autorizar, cargar, ejecutar("preview"));
  router.post("/usuarios/importacion/confirmar", verificar, autorizar, cargar, ejecutar("confirmar"));
  return router;
}

module.exports = crearRouterImportacionUsuarios();
module.exports.crearRouterImportacionUsuarios = crearRouterImportacionUsuarios;
