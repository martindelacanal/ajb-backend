const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const nodemailer = require("nodemailer");
const http = require("node:http");
const { once } = require("node:events");
const { Server } = require("socket.io");

function ipCliente(confianza, direccion, reenviada) {
  const app = express();
  app.set("trust proxy", confianza);
  const req = Object.create(express.request);
  req.app = app;
  req.connection = { remoteAddress: direccion };
  req.headers = { "x-forwarded-for": reenviada };
  return req.ip;
}

test("Express no confia en IPv4 por subredes IPv6 con prefijos ambiguos", () => {
  // GHSA-jqcg-44mw-7w3h: el prefijo corto no debe permitir falsificar req.ip.
  for (const confianza of ["::ffff:10.0.0.0/8", "::/1", ["::/1", "loopback"]]) {
    for (const direccion of ["203.0.113.10", "::ffff:203.0.113.10"]) {
      assert.equal(ipCliente(confianza, direccion, "10.0.0.1"), direccion);
    }
  }
});

test("Express conserva las IP reenviadas por proxies autorizados", () => {
  for (const direccion of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(ipCliente("loopback", direccion, "203.0.113.20"), "203.0.113.20");
  }
  assert.equal(ipCliente("::ffff:10.0.0.0/104", "10.1.2.3", "203.0.113.20"), "203.0.113.20");
});

test("Socket.IO rechaza cambiar la revision del protocolo de una sesion activa", async (t) => {
  const servidor = http.createServer();
  const io = new Server(servidor);
  t.after(() => new Promise((resolve) => io.close(resolve)));
  servidor.listen(0, "127.0.0.1");
  await once(servidor, "listening");
  const base = `http://127.0.0.1:${servidor.address().port}/socket.io/`;
  const abrir = () => fetch(`${base}?EIO=4&transport=polling`, { signal: AbortSignal.timeout(5000) });
  const inicial = await abrir();
  assert.equal(inicial.status, 200);
  const sesion = JSON.parse((await inicial.text()).slice(1));
  assert.ok(sesion.sid);

  // GHSA-2gc4-cqfq-p2gv: no se debe actualizar una sesion EIO4 a EIO3.
  const estado = await new Promise((resolve, reject) => {
    const req = http.get(`${base}?EIO=3&transport=websocket&sid=${encodeURIComponent(sesion.sid)}`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
      },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("Se acepto un cambio de protocolo incompatible"));
    });
    req.once("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Timeout de prueba Socket.IO")));
  });
  assert.equal(estado, 400);
  const posterior = await abrir();
  assert.equal(posterior.status, 200);
  assert.ok(JSON.parse((await posterior.text()).slice(1)).sid);
});

test("Nodemailer compone correo con destinatario y adjunto sin usar SMTP", async () => {
  const transporte = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const resultado = await transporte.sendMail({
    from: { name: "Mi AJB", address: "remitente@example.test" },
    to: { name: "Afiliación AJB", address: "afiliado@example.test" },
    subject: "Constancia de inscripción",
    text: "Tu inscripción está confirmada.",
    attachments: [{ filename: "constancia.txt", content: Buffer.from("Constancia AJB", "utf8") }],
  });
  assert.deepEqual(resultado.envelope.to, ["afiliado@example.test"]);
  assert.equal(resultado.envelope.from, "remitente@example.test");
  const mensaje = resultado.message.toString("utf8");
  assert.match(mensaje, /multipart\/mixed/);
  assert.match(mensaje, /filename=constancia\.txt/);
  assert.match(mensaje, /Q29uc3RhbmNpYSBBSkI=/);
});
