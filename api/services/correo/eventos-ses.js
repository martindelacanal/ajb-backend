"use strict";

const crypto = require("crypto");
const https = require("https");
const certificados = new Map();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function errorEvento() { return Object.assign(new Error("Notificación de correo no válida"), { statusCode: 403 }); }

function textoFirma(mensaje) {
  const campos = mensaje.Type === "Notification"
    ? ["Message", "MessageId", ...(mensaje.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
    : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return campos.map(campo => {
    if (typeof mensaje[campo] !== "string") throw errorEvento();
    return `${campo}\n${mensaje[campo]}\n`;
  }).join("");
}

function descargar(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(errorEvento()); return; }
      let texto = "";
      res.setEncoding("utf8");
      res.on("data", parte => { texto += parte; if (texto.length > 16384) req.destroy(errorEvento()); });
      res.on("end", () => resolve(texto));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(errorEvento()));
    req.on("error", reject);
  });
}

async function certificado(url) {
  const cached = certificados.get(url);
  if (cached && cached.hasta > Date.now()) return cached.valor;
  // Se comparte también la petición en curso.
  const valor = descargar(url);
  certificados.set(url, { hasta: Date.now() + 3600000, valor });
  while (certificados.size > 8) certificados.delete(certificados.keys().next().value);
  try { return await valor; } catch (e) { certificados.delete(url); throw e; }
}

async function verificarMensaje(mensaje, { topicArn = process.env.MAIL_SNS_TOPIC_ARN, obtenerCertificado = certificado, ahora = Date.now() } = {}) {
  const topic = /^arn:aws:sns:([a-z]{2}-[a-z]+-\d):([0-9]{12}):[A-Za-z0-9_-]+$/.exec(topicArn || "");
  if (!topic || !mensaje || mensaje.TopicArn !== topicArn
    || !["Notification", "SubscriptionConfirmation"].includes(mensaje.Type)
    || !["1", "2"].includes(mensaje.SignatureVersion)) throw errorEvento();
  const timestamp = Date.parse(mensaje.Timestamp);
  const maxEdad = mensaje.Type === "SubscriptionConfirmation" ? 30 * 60000 : 7 * 86400000;
  if (!Number.isFinite(timestamp) || timestamp > ahora + 300000 || timestamp < ahora - maxEdad) throw errorEvento();
  let url;
  try { url = new URL(mensaje.SigningCertURL); } catch (_) { throw errorEvento(); }
  if (url.protocol !== "https:" || url.hostname !== `sns.${topic[1]}.amazonaws.com`
    || url.username || url.password || url.port || url.search || url.hash
    || !/^\/SimpleNotificationService-[a-f0-9]+\.pem$/i.test(url.pathname)) throw errorEvento();
  if (typeof mensaje.Signature !== "string" || !/^[A-Za-z0-9+/=]{128,2048}$/.test(mensaje.Signature)) throw errorEvento();
  const pem = await obtenerCertificado(url.href);
  const valido = crypto.verify(mensaje.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1",
    Buffer.from(textoFirma(mensaje)), pem, Buffer.from(mensaje.Signature, "base64"));
  if (!valido) throw errorEvento();
  return { region: topic[1], accountId: topic[2] };
}

async function confirmarSuscripcion(mensaje, region, obtener = descargar) {
  // No se sigue una URL arbitraria contenida en el mensaje.
  if (typeof mensaje.Token !== "string" || mensaje.Token.length > 4096) throw errorEvento();
  const url = new URL(`https://sns.${region}.amazonaws.com/`);
  url.searchParams.set("Action", "ConfirmSubscription");
  url.searchParams.set("TopicArn", mensaje.TopicArn);
  url.searchParams.set("Token", mensaje.Token);
  await obtener(url.href);
}

function parsearEvento(evento) {
  const tipo = evento?.eventType || evento?.notificationType;
  const tipos = {
    Delivery: ["entregado", "El servidor del destinatario confirmó la entrega."],
    Bounce: ["rebotado", "El correo rebotó. Revisá la dirección declarada antes de volver a contactarlo."],
    Complaint: ["queja", "El destinatario marcó el correo como no deseado."],
    Reject: ["error", "El proveedor rechazó el correo."],
    RenderingFailure: ["error", "El proveedor no pudo generar el correo."],
    "Rendering Failure": ["error", "El proveedor no pudo generar el correo."],
  };
  const estado = tipos[tipo];
  if (!estado || typeof evento?.mail?.messageId !== "string" || evento.mail.messageId.length > 255) return null;
  const id = evento.mail.tags?.bienvenida_id?.[0];
  const recipients = tipo === "Bounce" ? evento.bounce?.bouncedRecipients?.map(r => r.emailAddress)
    : tipo === "Complaint" ? evento.complaint?.complainedRecipients?.map(r => r.emailAddress)
      : tipo === "Delivery" ? evento.delivery?.recipients : evento.mail.destination;
  if (!Array.isArray(recipients) || !recipients.length || recipients.some(r => typeof r !== "string")) return null;
  return { id: UUID.test(id || "") ? id : null, messageId: evento.mail.messageId,
    estado: estado[0], detalle: estado[1], recipients: recipients.map(r => r.trim().toLowerCase()).slice(0, 50) };
}

async function aplicarEvento(db, evento) {
  const datos = parsearEvento(evento);
  if (!datos) return false;
  // Correlaciona mensaje Y destinatario. Nunca se altera una cuenta solo por email.
  // Los estados terminales no retroceden si SNS reintenta o entrega fuera de orden.
  const anteriores = datos.estado === "queja" ? ["pendiente", "enviado", "entregado", "error", "rebotado"]
    : datos.estado === "rebotado" ? ["pendiente", "enviado", "entregado", "error"]
      : datos.estado === "entregado" ? ["pendiente", "enviado", "error"] : ["pendiente", "enviado"];
  const [resultado] = await db.query(`UPDATE correo_bienvenida SET estado=?, detalle=?, message_id=COALESCE(message_id,?), evento_en=NOW(6)
    WHERE ${datos.id ? "id=?" : "message_id=?"} AND LOWER(email) IN (${datos.recipients.map(() => "?").join(",")})
      ${datos.id ? "AND (message_id IS NULL OR message_id=?)" : ""}
      AND estado IN (${anteriores.map(() => "?").join(",")})`,
    [datos.estado, datos.detalle, datos.messageId, datos.id || datos.messageId, ...datos.recipients,
      ...(datos.id ? [datos.messageId] : []), ...anteriores]);
  return Number(resultado.affectedRows) > 0;
}

module.exports = { textoFirma, verificarMensaje, confirmarSuscripcion, parsearEvento, aplicarEvento };
