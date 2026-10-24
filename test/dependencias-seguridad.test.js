const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const nodemailer = require("nodemailer");
const http = require("node:http");
const { once } = require("node:events");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const multer = require("../api/security/multipart");
const zlib = require("node:zlib");

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

test("Nodemailer no convierte comentarios anidados en destinatarios", async () => {
  const transporte = nodemailer.createTransport({ streamTransport: true, buffer: true });
  for (const to of [
    "Afiliado (x(y) <intruso@example.test>) <afiliado@example.test>",
    "Afiliado (comentario) <afiliado@example.test>",
  ]) {
    const resultado = await transporte.sendMail({ from: "ajb@example.test", to, subject: "Constancia", text: "Prueba" });
    assert.deepEqual(resultado.envelope.to, ["afiliado@example.test"]);
  }
});

test("body-parser termina peticiones comprimidas con bytes posteriores sin caerse", async (t) => {
  // GHSA-27r3-jxmh-p828: entregar el resto solo cuando el decoder ya terminó.
  for (const encoding of ["deflate", "gzip"]) {
    let cliente;
    const app = express();
    const parser = bodyParser.json({ limit: "2mb" });
    const cola = Buffer.alloc(1024);
    const json = Buffer.from('{"a":1}');
    const comprimido = encoding === "gzip" ? zlib.gzipSync(json) : zlib.deflateSync(json);
    const comienzo = Buffer.concat([comprimido, Buffer.from([0])]);
    app.post("/", (req, res, next) => {
      parser(req, res, (error) => {
        if (error) return next(error);
        req.once("end", () => res.json(req.body));
        cliente.end(cola);
      });
    });
    app.get("/health", (_req, res) => res.sendStatus(200));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    await once(server, "listening");
    const puerto = server.address().port;
    const respuesta = await new Promise((resolve, reject) => {
      cliente = http.request({ host: "127.0.0.1", port: puerto, method: "POST", path: "/", agent: false,
        headers: { "Content-Type": "application/json", "Content-Encoding": encoding, "Content-Length": comienzo.length + cola.length },
      }, (res) => {
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { texto += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, texto }));
      });
      cliente.on("error", reject);
      cliente.setTimeout(5000, () => cliente.destroy(new Error("La petición comprimida quedó pendiente")));
      cliente.write(comienzo);
    });
    assert.deepEqual(respuesta, { status: 200, texto: '{"a":1}' }, encoding);
    assert.equal((await fetch(`http://127.0.0.1:${puerto}/health`, { signal: AbortSignal.timeout(5000) })).status, 200);
  }
});

test("Multer rechaza campos multipart abusivos y sigue aceptando archivos válidos", async (t) => {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024, fields: 4, files: 1 } }).single("archivo");
  app.post("/", (req, res) => upload(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.code || error.message });
    res.json({ nombre: req.file?.originalname, contenido: req.file?.buffer.toString("utf8") });
  }));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/`;
  for (const nombre of ["campo" + "[x]".repeat(100), "campo[999999999]"]) {
    const form = new FormData();
    form.append(nombre, "valor");
    const respuesta = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    assert.equal(respuesta.status, 400);
    assert.ok((await respuesta.json()).error);
  }
  const valido = new FormData();
  valido.append("archivo", new Blob(["documento"], { type: "text/plain" }), "prueba.txt");
  const respuesta = await fetch(url, { method: "POST", body: valido, signal: AbortSignal.timeout(5000) });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(await respuesta.json(), { nombre: "prueba.txt", contenido: "documento" });
});
