"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const { textoFirma, verificarMensaje, confirmarSuscripcion, parsearEvento, aplicarEvento } = require("../api/services/correo/eventos-ses");
const { crearRouterCorreoEventos } = require("../api/routes/correo-eventos");

const topicArn = "arn:aws:sns:sa-east-1:337909740711:miajb-correo-eventos";
const ahora = Date.parse("2026-10-11T12:00:00Z");
const id = "a7749a30-d227-421f-9b4b-713fc75397ca";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" });
const opciones = { topicArn, ahora, obtenerCertificado: async () => pem };

function evento(tipo = "Delivery", cambios = {}) {
  return { eventType: tipo, mail: { sendingAccountId: "337909740711", messageId: "ses-message-1",
    tags: { bienvenida_id: [id] }, destination: ["ana@example.test"] },
    delivery: { recipients: ["ana@example.test"] }, bounce: { bouncedRecipients: [{ emailAddress: "ana@example.test" }] },
    complaint: { complainedRecipients: [{ emailAddress: "ana@example.test" }] }, ...cambios };
}

function firmado(cambios = {}) {
  const mensaje = { Type: "Notification", MessageId: "sns-notification-1", TopicArn: topicArn,
    Message: JSON.stringify(evento()), Timestamp: new Date(ahora).toISOString(), SignatureVersion: "2",
    SigningCertURL: "https://sns.sa-east-1.amazonaws.com/SimpleNotificationService-abc123.pem", ...cambios };
  // Construcción independiente del orden canónico: no firma usando textoFirma.
  const canonico = mensaje.Type === "Notification"
    ? `Message\n${mensaje.Message}\nMessageId\n${mensaje.MessageId}\n${mensaje.Subject === undefined ? "" : `Subject\n${mensaje.Subject}\n`}Timestamp\n${mensaje.Timestamp}\nTopicArn\n${mensaje.TopicArn}\nType\n${mensaje.Type}\n`
    : `Message\n${mensaje.Message}\nMessageId\n${mensaje.MessageId}\nSubscribeURL\n${mensaje.SubscribeURL}\nTimestamp\n${mensaje.Timestamp}\nToken\n${mensaje.Token}\nTopicArn\n${mensaje.TopicArn}\nType\n${mensaje.Type}\n`;
  mensaje.Signature = crypto.sign(mensaje.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256", Buffer.from(canonico), privateKey).toString("base64");
  return mensaje;
}

test("valida firmas SNS RSA SHA256 y SHA1 con y sin Subject", async () => {
  for (const SignatureVersion of ["1", "2"]) for (const Subject of [undefined, "Amazon SES Email Event Notification"]) {
    const mensaje = firmado({ SignatureVersion, ...(Subject ? { Subject } : {}) });
    assert.deepEqual(await verificarMensaje(mensaje, opciones), { region: "sa-east-1", accountId: "337909740711" });
    assert.match(textoFirma(mensaje), /Message\n.+\nMessageId\nsns-notification-1\n/);
  }
});

test("rechaza firma alterada, topic ajeno, tipos no admitidos y versión no admitida", async () => {
  for (const cambio of [{ Message: "{}" }, { TopicArn: topicArn + "-otro" }, { Type: "UnsubscribeConfirmation" }, { SignatureVersion: "3" }, { Signature: "A".repeat(344) }]) {
    await assert.rejects(verificarMensaje({ ...firmado(), ...cambio }, opciones), { statusCode: 403 });
  }
});

test("rechaza certificados fuera del origen SNS exacto antes de descargar", async () => {
  for (const SigningCertURL of [
    "http://sns.sa-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    "https://sns.sa-east-1.amazonaws.com.attacker.test/SimpleNotificationService-abc123.pem",
    "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    "https://127.0.0.1/SimpleNotificationService-abc123.pem",
    "https://sns.sa-east-1.amazonaws.com@attacker.test/SimpleNotificationService-abc123.pem",
    "https://usuario@sns.sa-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    "https://sns.sa-east-1.amazonaws.com:444/SimpleNotificationService-abc123.pem",
    "https://sns.sa-east-1.amazonaws.com/SimpleNotificationService-abc123.pem?host=evil",
    "https://sns.sa-east-1.amazonaws.com/SimpleNotificationService-abc123.pem#x",
    "https://sns.sa-east-1.amazonaws.com/otra-ruta.pem",
  ]) {
    await assert.rejects(verificarMensaje(firmado({ SigningCertURL }), { ...opciones,
      obtenerCertificado: () => assert.fail("no debe descargar") }), { statusCode: 403 });
  }
});

test("limita replay viejo y reloj futuro; permite reintentos legítimos dentro de siete días", async () => {
  for (const desfase of [-7 * 86400000 - 1, 300001]) {
    await assert.rejects(verificarMensaje(firmado({ Timestamp: new Date(ahora + desfase).toISOString() }), opciones), { statusCode: 403 });
  }
  assert.ok(await verificarMensaje(firmado({ Timestamp: new Date(ahora - 6 * 86400000).toISOString() }), opciones));
  const confirmacion = { Type: "SubscriptionConfirmation", Token: "token", SubscribeURL: "https://attacker.test/no-seguir" };
  assert.ok(await verificarMensaje(firmado(confirmacion), opciones));
  await assert.rejects(verificarMensaje(firmado({ ...confirmacion, Timestamp: new Date(ahora - 1800001).toISOString() }), opciones), { statusCode: 403 });
});

test("confirma suscripción en SNS reconstruyendo URL y sin seguir SubscribeURL arbitrario", async () => {
  let destino;
  await confirmarSuscripcion({ TopicArn: topicArn, Token: "token&Action=DeleteTopic", SubscribeURL: "https://attacker.test" }, "sa-east-1", async url => { destino = new URL(url); });
  assert.equal(destino.origin, "https://sns.sa-east-1.amazonaws.com");
  assert.equal(destino.searchParams.get("Action"), "ConfirmSubscription");
  assert.equal(destino.searchParams.get("TopicArn"), topicArn);
  assert.equal(destino.searchParams.get("Token"), "token&Action=DeleteTopic");
});

test("correlaciona destinatario del rebote y distingue todos los estados de SES", () => {
  for (const [tipo, estado] of [["Delivery", "entregado"], ["Bounce", "rebotado"], ["Complaint", "queja"],
    ["Reject", "error"], ["Rendering Failure", "error"], ["RenderingFailure", "error"]]) {
    assert.equal(parsearEvento(evento(tipo)).estado, estado);
  }
  const parsed = parsearEvento(evento("Bounce", { bounce: { bouncedRecipients: [{ emailAddress: " ANA@EXAMPLE.TEST " }] } }));
  assert.deepEqual(parsed.recipients, ["ana@example.test"]);
  assert.equal(parsearEvento(evento("Open")), null);
  assert.equal(parsearEvento(evento("Delivery", { delivery: { recipients: [] } })), null);
  assert.equal(parsearEvento({ eventType: "Bounce" }), null);
});

function almacenamiento(estado = "enviado", messageId = "ses-message-1") {
  const fila = { id, email: "ana@example.test", estado, message_id: messageId };
  const llamadas = [];
  return { fila, llamadas, async query(sql, params) {
    llamadas.push({ sql, params });
    const conId = /WHERE id=\?/.test(sql);
    const cantidad = /LOWER\(email\) IN \(([^)]+)\)/.exec(sql)[1].split(",").length;
    const destinatarios = params.slice(4, 4 + cantidad);
    const verificaMensaje = /AND \(message_id IS NULL OR message_id=\?\)/.test(sql);
    const anteriores = params.slice(4 + cantidad + (verificaMensaje ? 1 : 0));
    if ((conId ? params[3] !== fila.id : params[3] !== fila.message_id) || !destinatarios.includes(fila.email)
      || (verificaMensaje && fila.message_id !== null && fila.message_id !== params[4 + cantidad])
      || !anteriores.includes(fila.estado)) return [{ affectedRows: 0 }];
    fila.estado = params[0]; fila.message_id ??= params[2]; return [{ affectedRows: 1 }];
  } };
}

test("SNS temprano correlaciona UUID y receptor antes de conocer messageId; un mensaje distinto no cambia el estado", async () => {
  const db = almacenamiento("pendiente", null);
  assert.equal(await aplicarEvento(db, evento()), true);
  assert.equal(db.fila.estado, "entregado"); assert.equal(db.fila.message_id, "ses-message-1");
  const ajeno = evento("Bounce"); ajeno.mail.messageId = "otro-mensaje";
  assert.equal(await aplicarEvento(db, ajeno), false); assert.equal(db.fila.estado, "entregado");
});

test("sin tag solo actualiza el messageId exacto y el destinatario exacto", async () => {
  const db = almacenamiento(); const sinTag = evento("Bounce"); delete sinTag.mail.tags;
  sinTag.mail.messageId = "otro";
  assert.equal(await aplicarEvento(db, sinTag), false);
  sinTag.mail.messageId = "ses-message-1"; sinTag.bounce.bouncedRecipients[0].emailAddress = "otro@example.test";
  assert.equal(await aplicarEvento(db, sinTag), false);
  sinTag.bounce.bouncedRecipients[0].emailAddress = "ana@example.test";
  assert.equal(await aplicarEvento(db, sinTag), true); assert.equal(db.fila.estado, "rebotado");
});

test("reintentos y entregas fuera de orden no revierten rebotes ni quejas", async () => {
  const db = almacenamiento();
  assert.equal(await aplicarEvento(db, evento("Bounce")), true);
  assert.equal(await aplicarEvento(db, evento("Bounce")), false);
  assert.equal(await aplicarEvento(db, evento("Delivery")), false);
  assert.equal(await aplicarEvento(db, evento("Complaint")), true);
  assert.equal(await aplicarEvento(db, evento("Bounce")), false);
  assert.equal(await aplicarEvento(db, evento("Reject")), false);
  assert.equal(db.fila.estado, "queja");
});

test("errores de transporte pueden recuperarse con entrega confirmada", async () => {
  const db = almacenamiento("error");
  assert.equal(await aplicarEvento(db, evento()), true); assert.equal(db.fila.estado, "entregado");
});

async function solicitud(mensaje, { contentType = "text/plain", confirmar } = {}) {
  const db = almacenamiento(); const app = express();
  app.use("/api", crearRouterCorreoEventos({ db, verificar: value => verificarMensaje(value, opciones), confirmar }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/correo/eventos-ses`, {
      method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(mensaje),
    });
    return { status: response.status, body: await response.json(), db };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("webhook HTTP recibe SNS text/plain y JSON; firma inválida no toca la base", async () => {
  for (const contentType of ["text/plain", "application/json"]) {
    const result = await solicitud(firmado(), { contentType });
    assert.equal(result.status, 200); assert.equal(result.db.fila.estado, "entregado");
  }
  const result = await solicitud({ ...firmado(), Message: "{}" });
  assert.equal(result.status, 403); assert.equal(result.db.llamadas.length, 0);
});

test("webhook rechaza otra cuenta emisora y confirma suscripción solo luego de validar firma", async () => {
  const ajeno = evento(); ajeno.mail.sendingAccountId = "999999999999";
  const result = await solicitud(firmado({ Message: JSON.stringify(ajeno) }));
  assert.equal(result.status, 403); assert.equal(result.db.llamadas.length, 0);
  let confirmaciones = 0;
  const confirmacion = firmado({ Type: "SubscriptionConfirmation", Token: "token", SubscribeURL: "https://sns.sa-east-1.amazonaws.com" });
  const correcto = await solicitud(confirmacion, { confirmar: async () => { confirmaciones += 1; } });
  assert.equal(correcto.status, 200); assert.equal(confirmaciones, 1);
  const incorrecto = await solicitud({ ...confirmacion, Token: "otro" }, { confirmar: async () => { confirmaciones += 1; } });
  assert.equal(incorrecto.status, 403); assert.equal(confirmaciones, 1);
});
