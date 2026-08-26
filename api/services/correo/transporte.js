"use strict";

/**
 * Transporte SMTP compartido por todo el backend.
 *
 * Se crea una sola vez (pool de conexiones) porque la casilla vive en un
 * hosting compartido: abrir una conexión por mensaje hace que el servidor
 * empiece a rechazar por "too many connections". El pool además serializa los
 * envíos y respeta el techo de mensajes por minuto configurado.
 */

const nodemailer = require("nodemailer");
const { configuracionCorreo, describirConfiguracion } = require("./config");

let transporteActual = null;
let firmaActual = "";

function firmaDeConfiguracion(config) {
  return [
    config.host,
    config.puerto,
    config.seguro,
    config.usuario,
    config.password,
    config.nombreHelo,
    config.tlsEstricto,
    config.maxPorMinuto,
    config.maxConexiones,
    config.depurar,
  ].join("|");
}

function opcionesDeTransporte(config) {
  return {
    host: config.host,
    port: config.puerto,
    secure: config.seguro,
    auth: { user: config.usuario, pass: config.password },
    // Nombre con el que nos presentamos en EHLO. Sin esto nodemailer manda
    // "[127.0.0.1]" (cuando el hostname no tiene punto) y el filtro de salida
    // del hosting descarta el mensaje en silencio: 250 OK, pero nunca llega.
    ...(config.nombreHelo ? { name: config.nombreHelo } : {}),
    pool: true,
    maxConnections: config.maxConexiones,
    maxMessages: config.maxMensajesPorConexion,
    rateDelta: 60000,
    rateLimit: config.maxPorMinuto,
    connectionTimeout: config.tiemposEspera.conexion,
    greetingTimeout: config.tiemposEspera.saludo,
    socketTimeout: config.tiemposEspera.socket,
    // El certificado del hosting es válido; se exige verificación salvo que
    // se desactive expresamente con MAIL_TLS_ESTRICTO=false.
    tls: {
      rejectUnauthorized: config.tlsEstricto,
      minVersion: "TLSv1.2",
      servername: config.host,
    },
    logger: config.depurar,
    debug: config.depurar,
  };
}

/**
 * Devuelve el transporte vigente, recreándolo si cambió la configuración.
 * Devuelve null si faltan datos de conexión.
 */
function obtenerTransporte(config = configuracionCorreo()) {
  if (!config.configurado) return null;

  const firma = firmaDeConfiguracion(config);
  if (transporteActual && firma === firmaActual) return transporteActual;

  cerrarTransporte();
  transporteActual = nodemailer.createTransport(opcionesDeTransporte(config));
  firmaActual = firma;
  return transporteActual;
}

/** Cierra el pool (apagado ordenado del proceso o cambio de credenciales). */
function cerrarTransporte() {
  if (transporteActual) {
    try {
      transporteActual.close();
    } catch (_error) {
      // Cerrar un pool ya cerrado no es un problema.
    }
  }
  transporteActual = null;
  firmaActual = "";
}

/**
 * Prueba credenciales y conectividad sin enviar nada (SMTP EHLO + AUTH).
 * Útil para el arranque del servidor y para diagnosticar en producción.
 */
async function verificarConexion(config = configuracionCorreo()) {
  const detalle = describirConfiguracion(config);

  if (!config.configurado) {
    return { conectado: false, motivo: "sin_configurar", detalle };
  }

  try {
    await obtenerTransporte(config).verify();
    return { conectado: true, detalle };
  } catch (error) {
    return {
      conectado: false,
      motivo: "error_smtp",
      error: error?.message || String(error),
      codigo: error?.code || error?.responseCode || null,
      detalle,
    };
  }
}

module.exports = {
  cerrarTransporte,
  obtenerTransporte,
  opcionesDeTransporte,
  verificarConexion,
};
