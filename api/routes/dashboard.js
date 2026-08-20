"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { crearServicioDashboard, crearServicioActividad } = require("../services/dashboard");

const router = express.Router();
const dashboard = crearServicioDashboard({ conexion: mysqlConnection });
const actividad = crearServicioActividad({ conexion: mysqlConnection });

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

function obtenerCabecera(req) {
  try {
    return JSON.parse(req.data?.data);
  } catch (_error) {
    return null;
  }
}

router.get("/admin/dashboard", verifyToken, async (req, res) => {
  const cabecera = obtenerCabecera(req);
  if (!cabecera || cabecera.rol !== "admin") {
    return res.status(401).json("No autorizado");
  }

  try {
    const respuesta = await dashboard.obtener();
    return res.status(200).json(respuesta);
  } catch (error) {
    console.error("No se pudo generar el dashboard administrativo:", error?.code || error?.message);
    return res.status(500).json("Error al obtener el dashboard");
  }
});

router.get("/admin/dashboard/actividad", verifyToken, async (req, res) => {
  const cabecera = obtenerCabecera(req);
  if (!cabecera || cabecera.rol !== "admin") {
    return res.status(401).json("No autorizado");
  }

  try {
    const respuesta = await actividad.obtener({
      granularidad: String(req.query.granularidad || ""),
      desde: String(req.query.desde || ""),
      hasta: String(req.query.hasta || ""),
    });
    if (respuesta.error) {
      return res.status(400).json({ mensaje: respuesta.error });
    }
    return res.status(200).json(respuesta);
  } catch (error) {
    console.error("No se pudo agrupar la actividad del dashboard:", error?.code || error?.message);
    return res.status(500).json("Error al obtener la actividad");
  }
});

module.exports = router;
