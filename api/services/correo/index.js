"use strict";

/**
 * Envío de correo automático de Mi AJB.
 *
 * Uso típico desde una ruta o un servicio:
 *
 *   const { enviarCorreoPlantilla } = require("../services/correo");
 *
 *   await enviarCorreoPlantilla({
 *     para: usuario.email,
 *     asunto: "Tu reserva fue confirmada",
 *     titulo: "Reserva confirmada",
 *     saludo: `Hola, ${usuario.nombre}`,
 *     parrafos: ["Te confirmamos la reserva del complejo."],
 *     datos: [{ etiqueta: "Expediente", valor: "TU-2026-0031" }],
 *     boton: { texto: "Ver mis gestiones", url: urlAplicacion("/mis-gestiones") },
 *   });
 *
 * Reglas de la casa:
 *  - Ninguna función lanza por un fallo de SMTP. Siempre devuelven un objeto
 *    { enviado, motivo, error } para que un servidor de correo caído nunca
 *    tumbe una operación de negocio (una reserva no debe fallar porque el mail
 *    no salió). Quien necesite reaccionar, mira `enviado`.
 *  - Todo pasa por el mismo pool de conexiones (ver transporte.js).
 *  - MAIL_REDIRECT_TO permite trabajar en desarrollo sin escribirle a afiliados.
 */

const { configuracionCorreo, describirConfiguracion, esCorreoValido } = require("./config");
const { cerrarTransporte, obtenerTransporte, verificarConexion } = require("./transporte");
const { construirCorreoHtml, textoPlanoDesdeHtml } = require("./plantilla");

const MAX_DESTINATARIOS = 50;
const MAX_LARGO_ASUNTO = 200;

/**
 * Acepta "a@b.com", ["a@b.com", "c@d.com"] o "a@b.com, c@d.com" y devuelve
 * solo las direcciones válidas, sin repetidos.
 */
function normalizarDestinatarios(valor) {
  const crudos = Array.isArray(valor) ? valor : [valor];
  const vistos = new Set();

  for (const item of crudos) {
    if (item === null || item === undefined) continue;
    const texto = typeof item === "object" ? item.address || item.email || "" : String(item);
    for (const parte of texto.split(/[,;]/)) {
      const direccion = parte.trim().toLowerCase();
      if (esCorreoValido(direccion)) vistos.add(direccion);
      if (vistos.size >= MAX_DESTINATARIOS) break;
    }
  }

  return [...vistos];
}

function normalizarAsunto(valor) {
  // Un CR/LF en el asunto permitiría inyectar cabeceras arbitrarias.
  return String(valor ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, MAX_LARGO_ASUNTO);
}

/** Arma una URL absoluta del sistema a partir de MAIL_APP_URL. */
function urlAplicacion(ruta = "", config = configuracionCorreo()) {
  const base = config.urlAplicacion;
  const camino = String(ruta ?? "").trim();
  if (!camino) return base;
  return `${base}/${camino.replace(/^\/+/, "")}`;
}

function registrarFallo(contexto, error) {
  console.error(
    `[correo] ${contexto}:`,
    error?.responseCode || error?.code || "",
    error?.message || String(error)
  );
}

/**
 * Envía un correo ya compuesto.
 *
 * @param {object} opciones
 * @param {string|string[]} opciones.para
 * @param {string} opciones.asunto
 * @param {string} [opciones.html]
 * @param {string} [opciones.texto]      Si falta y hay HTML, se deriva automáticamente.
 * @param {string|string[]} [opciones.cc]
 * @param {string|string[]} [opciones.cco]
 * @param {string} [opciones.responderA]
 * @param {object[]} [opciones.adjuntos] Formato de adjuntos de nodemailer.
 * @param {object} [opciones.encabezados]
 * @returns {Promise<{enviado:boolean, motivo?:string, messageId?:string, error?:string}>}
 */
async function enviarCorreo({
  para,
  asunto,
  html = "",
  texto = "",
  cc = null,
  cco = null,
  responderA = "",
  adjuntos = [],
  encabezados = {},
} = {}) {
  const config = configuracionCorreo();

  if (!config.configurado) {
    console.warn("[correo] Falta configuración SMTP (MAIL_HOST / MAIL_USER / MAIL_PASSWORD): no se envía nada.");
    return { enviado: false, motivo: "sin_configurar" };
  }
  if (!config.habilitado) {
    return { enviado: false, motivo: "deshabilitado" };
  }

  const asuntoLimpio = normalizarAsunto(asunto);
  if (!asuntoLimpio) {
    return { enviado: false, motivo: "asunto_invalido" };
  }

  const destinatarios = normalizarDestinatarios(para);
  if (destinatarios.length === 0) {
    return { enviado: false, motivo: "destinatario_invalido" };
  }

  const copias = normalizarDestinatarios(cc);
  const copiasOcultas = normalizarDestinatarios(cco);

  const cuerpoTexto = texto || (html ? textoPlanoDesdeHtml(html) : "");
  if (!html && !cuerpoTexto) {
    return { enviado: false, motivo: "cuerpo_vacio" };
  }

  const mensaje = {
    from: config.remitente,
    to: destinatarios,
    subject: asuntoLimpio,
    text: cuerpoTexto,
    headers: {
      // Marca el mensaje como generado por un sistema: evita respuestas
      // automáticas (fuera de oficina) que reboten contra la casilla.
      "Auto-Submitted": "auto-generated",
      ...encabezados,
    },
  };

  if (html) mensaje.html = html;
  if (copias.length) mensaje.cc = copias;
  if (copiasOcultas.length) mensaje.bcc = copiasOcultas;
  if (Array.isArray(adjuntos) && adjuntos.length) mensaje.attachments = adjuntos;

  const respuestaA = String(responderA || config.responderA || "").trim();
  if (esCorreoValido(respuestaA)) mensaje.replyTo = respuestaA;

  // Desvío de desarrollo: nada sale hacia direcciones reales de afiliados.
  if (config.redirigirA) {
    const originales = [...destinatarios, ...copias, ...copiasOcultas].join(", ");
    mensaje.to = [config.redirigirA];
    delete mensaje.cc;
    delete mensaje.bcc;
    mensaje.subject = `[DESARROLLO -> ${originales}] ${mensaje.subject}`.slice(0, MAX_LARGO_ASUNTO);
    mensaje.headers["X-Destinatarios-Originales"] = originales;
  }

  try {
    const info = await obtenerTransporte(config).sendMail(mensaje);
    return {
      enviado: true,
      messageId: info?.messageId || "",
      aceptados: info?.accepted || [],
      rechazados: info?.rejected || [],
      respuesta: info?.response || "",
    };
  } catch (error) {
    registrarFallo(`fallo el envio a ${destinatarios.join(", ")}`, error);
    return {
      enviado: false,
      motivo: "error_smtp",
      error: error?.message || String(error),
      codigo: error?.code || error?.responseCode || null,
    };
  }
}

/**
 * Envía un correo con la identidad visual de Mi AJB (logo embebido, botón,
 * ficha de datos y pie legal). Acepta las mismas opciones de contenido que
 * `construirCorreoHtml` más las de envío de `enviarCorreo`.
 */
async function enviarCorreoPlantilla({
  para,
  asunto,
  cc = null,
  cco = null,
  responderA = "",
  adjuntos = [],
  encabezados = {},
  ...contenido
} = {}) {
  const { html, texto, adjuntos: adjuntosPlantilla } = construirCorreoHtml({
    titulo: contenido.titulo || normalizarAsunto(asunto),
    previsualizacion: contenido.previsualizacion || "",
    ...contenido,
  });

  return enviarCorreo({
    para,
    asunto,
    html,
    texto,
    cc,
    cco,
    responderA,
    encabezados,
    adjuntos: [...adjuntosPlantilla, ...(Array.isArray(adjuntos) ? adjuntos : [])],
  });
}

/** Estado de la configuración, sin exponer la contraseña. */
function estadoCorreo() {
  return describirConfiguracion(configuracionCorreo());
}

/** Prueba conexión y credenciales contra el servidor SMTP, sin enviar nada. */
async function verificarCorreo() {
  return verificarConexion(configuracionCorreo());
}

module.exports = {
  cerrarTransporte,
  construirCorreoHtml,
  enviarCorreo,
  enviarCorreoPlantilla,
  estadoCorreo,
  normalizarAsunto,
  normalizarDestinatarios,
  textoPlanoDesdeHtml,
  urlAplicacion,
  verificarCorreo,
};
