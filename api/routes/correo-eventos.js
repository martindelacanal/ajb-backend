"use strict";

const express = require("express");
const { verificarMensaje, confirmarSuscripcion, aplicarEvento } = require("../services/correo/eventos-ses");

function crearRouterCorreoEventos({ db, verificar = verificarMensaje, confirmar = confirmarSuscripcion } = {}) {
  const router = express.Router();
  router.post("/correo/eventos-ses", express.json({ type: ["application/json", "text/plain"], limit: "256kb" }), async (req, res) => {
    try {
      const identidad = await verificar(req.body);
      if (req.body.Type === "SubscriptionConfirmation") await confirmar(req.body, identidad.region);
      else {
        let evento;
        try { evento = JSON.parse(req.body.Message); } catch (_) { return res.status(400).json({ mensaje: "Evento inválido" }); }
        if (evento?.mail?.sendingAccountId !== identidad.accountId) return res.status(403).json({ mensaje: "Origen inválido" });
        await aplicarEvento(db, evento);
      }
      res.json({ recibido: true });
    } catch (error) {
      if (!error.statusCode) console.error("[correo-eventos] Notificación no procesada:", error?.code || "error_interno");
      res.status(error.statusCode || 500).json({ mensaje: "No se pudo procesar la notificación" });
    }
  });
  return router;
}
module.exports = { crearRouterCorreoEventos };
