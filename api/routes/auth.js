"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mysqlConnection = require("../connection/connection");
const { enviarCorreoPlantilla } = require("../services/correo");
const { crearServicioRecuperacion, ErrorRecuperacion, MENSAJE_SOLICITUD } = require("../security/recuperacion-password");
const { renovarSesion, cerrarSesion, ErrorAutenticacion } = require("../security/sesiones-persistentes");

async function enviarCodigo({ para, codigo }) {
  return enviarCorreoPlantilla({
    para, autenticacion: true,
    asunto: "Tu código para recuperar el acceso a Mi AJB",
    titulo: "Recuperá tu acceso",
    previsualizacion: "Tu código de seguridad vence en 10 minutos.",
    saludo: "Hola,",
    parrafos: ["Ingresá este código en la pantalla de recuperación de Mi AJB para elegir una nueva contraseña.",
      "El código vence en 10 minutos y solo se puede usar una vez. No lo compartas con nadie.",
      "Si no pediste recuperar tu contraseña, ignorá este correo: tu cuenta no cambia."],
    datos: [{ etiqueta: "Tu código de seguridad", valor: codigo }],
  });
}

function crearRouterAuth({ db = mysqlConnection.promise(), jwtSecret = process.env.JWT_SECRET, enviar = enviarCodigo } = {}) {
  const router = express.Router();
  const recuperacion = crearServicioRecuperacion({ db, jwtSecret, enviarCodigo: enviar });
  const responderError = (res, error) => {
    if (error instanceof ErrorRecuperacion || error instanceof ErrorAutenticacion) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      return res.status(error.statusCode).json({ mensaje: error.message,
        ...(error instanceof ErrorAutenticacion ? { code: "SESSION_REVOKED" } : {}) });
    }
    console.error("[auth] Operación no disponible:", error?.code || "error_interno");
    return res.status(503).json({ mensaje: "No pudimos completar la operación. Volvé a intentar en unos minutos." });
  };

  router.post("/sesion/renovar", async (req, res) => {
    try { res.json(await renovarSesion({ db, refreshToken: req.body?.refreshToken, jwtSecret })); }
    catch (error) { responderError(res, error); }
  });
  router.post("/sesion/cerrar", async (req, res) => {
    try {
      const bearer = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || "");
      let sid;
      if (bearer) {
        try { sid = jwt.verify(bearer[1], jwtSecret, { ignoreExpiration: true }).sid; }
        catch (_error) { /* Cerrar es idempotente incluso sin credenciales válidas. */ }
      }
      await cerrarSesion({ db, refreshToken: req.body?.refreshToken, sid, jwtSecret });
      res.status(204).end();
    } catch (error) { responderError(res, error); }
  });

  router.post("/auth/recuperacion/solicitar", async (req, res) => {
    const inicio = Date.now();
    try {
      const envio = await recuperacion.solicitar({ identificador: req.body?.identificador, ip: req.ip });
      // El SMTP se ejecuta después de la misma respuesta para todas las cuentas;
      // su latencia y rechazo no permiten descubrir qué documentos existen.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 350 - (Date.now() - inicio))));
      res.json({ mensaje: MENSAJE_SOLICITUD, reintentarEn: 60 });
      void recuperacion.entregar(envio).catch(() => console.error("[auth] Falló la entrega del correo de recuperación."));
    } catch (error) { responderError(res, error); }
  });
  router.post("/auth/recuperacion/verificar", async (req, res) => {
    try { res.json(await recuperacion.verificar({ ...req.body, ip: req.ip })); }
    catch (error) { responderError(res, error); }
  });
  router.post("/auth/recuperacion/restablecer", async (req, res) => {
    try { res.json(await recuperacion.restablecer({ ...req.body, ip: req.ip })); }
    catch (error) { responderError(res, error); }
  });
  return router;
}

module.exports = crearRouterAuth();
module.exports.crearRouterAuth = crearRouterAuth;
module.exports.enviarCodigo = enviarCodigo;
