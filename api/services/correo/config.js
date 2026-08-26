"use strict";

/**
 * Configuración del correo saliente (SMTP).
 *
 * Todo sale de variables de entorno para que la casilla y la contraseña nunca
 * queden versionadas (.env está en .gitignore):
 *
 *   MAIL_HOST         = servidor SMTP (ej: mail.ajb.org.ar)
 *   MAIL_PORT         = 465 (SSL/TLS implícito) o 587 (STARTTLS)
 *   MAIL_SECURE       = true para 465, false para 587. Si se omite se deduce del puerto.
 *   MAIL_USER         = casilla completa que autentica
 *   MAIL_PASSWORD     = contraseña de esa casilla
 *   MAIL_FROM         = dirección del remitente (por defecto, MAIL_USER)
 *   MAIL_FROM_NAME    = nombre visible del remitente
 *   MAIL_REPLY_TO     = casilla a la que contesta el afiliado (opcional)
 *   MAIL_ENABLED      = false para apagar el envío sin tocar código
 *   MAIL_REDIRECT_TO  = en desarrollo, desvía TODO a esa casilla (nunca en producción)
 *   MAIL_APP_URL      = URL pública del sistema, usada en los botones de las plantillas
 *   MAIL_HELO_NAME    = nombre con el que el backend se presenta al servidor (EHLO). Debe ser un
 *                       nombre de dominio real (por defecto, el dominio del remitente). Si se omite,
 *                       nodemailer se presenta como "[127.0.0.1]" cuando el hostname de la máquina
 *                       no tiene punto, y el filtro de salida del hosting descarta esos mensajes
 *                       sin generar rebote (verificado el 26/08/2026 contra verifier.port25.com).
 *   MAIL_MAX_POR_MINUTO / MAIL_MAX_CONEXIONES = techos del hosting compartido
 *   MAIL_TLS_ESTRICTO = false solo si el hosting presenta un certificado que no valida
 *   MAIL_DEBUG        = true para volcar el diálogo SMTP en consola
 */

const PUERTO_PREDETERMINADO = 465;
const MAX_POR_MINUTO_PREDETERMINADO = 20;
const MAX_CONEXIONES_PREDETERMINADO = 2;
const MAX_MENSAJES_POR_CONEXION = 50;

const TIEMPOS_ESPERA = Object.freeze({
  conexion: 20000,
  saludo: 15000,
  socket: 30000,
});

const VERDADEROS = Object.freeze(["1", "true", "si", "sí", "yes", "on"]);
const FALSOS = Object.freeze(["0", "false", "no", "off"]);

// Validación deliberadamente conservadora: alcanza para descartar basura antes
// de abrir la conexión, sin pretender implementar el RFC 5322 completo.
const CORREO_VALIDO = /^[^\s@,;<>"]+@[^\s@,;<>".]+\.[^\s@,;<>"]{2,}$/;

function leerTexto(valor, porDefecto = "") {
  const limpio = String(valor ?? "").trim();
  return limpio || porDefecto;
}

function leerBooleano(valor, porDefecto) {
  const limpio = String(valor ?? "").trim().toLowerCase();
  if (!limpio) return porDefecto;
  if (VERDADEROS.includes(limpio)) return true;
  if (FALSOS.includes(limpio)) return false;
  return porDefecto;
}

function leerEntero(valor, porDefecto, { minimo = 1, maximo = Number.MAX_SAFE_INTEGER } = {}) {
  const numero = Number.parseInt(String(valor ?? "").trim(), 10);
  if (!Number.isFinite(numero)) return porDefecto;
  return Math.min(Math.max(numero, minimo), maximo);
}

// Nombre de host tal como lo exige EHLO: etiquetas alfanuméricas separadas por puntos.
const NOMBRE_HOST_VALIDO = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function esNombreHostValido(valor) {
  return NOMBRE_HOST_VALIDO.test(String(valor ?? "").trim());
}

/** Dominio de una casilla ("a@ajb.org.ar" -> "ajb.org.ar"), o "" si no es válida. */
function dominioDeCorreo(valor) {
  const limpio = String(valor ?? "").trim().toLowerCase();
  return esCorreoValido(limpio) ? limpio.slice(limpio.lastIndexOf("@") + 1) : "";
}

function esCorreoValido(valor) {
  const limpio = String(valor ?? "").trim();
  return limpio.length <= 254 && CORREO_VALIDO.test(limpio);
}

/**
 * Arma la configuración efectiva a partir del entorno.
 * `configurado` indica si hay datos suficientes para abrir una conexión SMTP;
 * `habilitado` suma el interruptor MAIL_ENABLED.
 */
function configuracionCorreo(env = process.env) {
  const host = leerTexto(env.MAIL_HOST);
  const usuario = leerTexto(env.MAIL_USER);
  const password = String(env.MAIL_PASSWORD ?? "");
  const puerto = leerEntero(env.MAIL_PORT, PUERTO_PREDETERMINADO, { minimo: 1, maximo: 65535 });
  const seguro = leerBooleano(env.MAIL_SECURE, puerto === 465);

  const remitenteEmail = leerTexto(env.MAIL_FROM, usuario);
  const remitenteNombre = leerTexto(env.MAIL_FROM_NAME, "Mi AJB");
  const responderA = leerTexto(env.MAIL_REPLY_TO);
  const redirigirA = leerTexto(env.MAIL_REDIRECT_TO);

  // EHLO: si no se define, se usa el dominio del remitente (siempre es un nombre real).
  const heloConfigurado = leerTexto(env.MAIL_HELO_NAME);
  const nombreHelo = esNombreHostValido(heloConfigurado) ? heloConfigurado : dominioDeCorreo(remitenteEmail);

  const configurado = Boolean(host && usuario && password && esCorreoValido(remitenteEmail));
  const habilitado = configurado && leerBooleano(env.MAIL_ENABLED, true);

  return Object.freeze({
    host,
    puerto,
    seguro,
    usuario,
    password,
    remitenteEmail,
    remitenteNombre,
    nombreHelo,
    remitente: remitenteNombre ? { name: remitenteNombre, address: remitenteEmail } : remitenteEmail,
    responderA: esCorreoValido(responderA) ? responderA : "",
    redirigirA: esCorreoValido(redirigirA) ? redirigirA : "",
    urlAplicacion: leerTexto(env.MAIL_APP_URL, "https://d2bnjhvusxwgza.cloudfront.net").replace(/\/+$/, ""),
    maxPorMinuto: leerEntero(env.MAIL_MAX_POR_MINUTO, MAX_POR_MINUTO_PREDETERMINADO, { minimo: 1, maximo: 600 }),
    maxConexiones: leerEntero(env.MAIL_MAX_CONEXIONES, MAX_CONEXIONES_PREDETERMINADO, { minimo: 1, maximo: 10 }),
    maxMensajesPorConexion: MAX_MENSAJES_POR_CONEXION,
    tlsEstricto: leerBooleano(env.MAIL_TLS_ESTRICTO, true),
    depurar: leerBooleano(env.MAIL_DEBUG, false),
    tiemposEspera: TIEMPOS_ESPERA,
    configurado,
    habilitado,
  });
}

/** Resumen apto para logs: nunca incluye la contraseña. */
function describirConfiguracion(config = configuracionCorreo()) {
  return {
    host: config.host || "(sin definir)",
    puerto: config.puerto,
    seguro: config.seguro,
    usuario: config.usuario || "(sin definir)",
    remitente: config.remitenteEmail || "(sin definir)",
    helo: config.nombreHelo || "(por defecto de nodemailer)",
    redirigirA: config.redirigirA || null,
    configurado: config.configurado,
    habilitado: config.habilitado,
  };
}

module.exports = {
  CORREO_VALIDO,
  TIEMPOS_ESPERA,
  configuracionCorreo,
  describirConfiguracion,
  dominioDeCorreo,
  esCorreoValido,
  esNombreHostValido,
  leerBooleano,
  leerEntero,
  leerTexto,
};
