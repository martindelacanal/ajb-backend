"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once, EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { spawn } = require("node:child_process");
const { setTimeout: esperar } = require("node:timers/promises");
const { iniciarConsenso } = require("../lib/quorum-lan");

const dirApp = path.join(__dirname, "..");
const ejecutable = process.platform === "win32" && fs.existsSync(path.join(dirApp, "windows", "ajb-quorum.exe"));

async function hasta(fn, ms = 5000) {
  for (const limite = Date.now() + ms; Date.now() < limite;) {
    const resultado = await fn();
    if (resultado) return resultado;
    await esperar(20);
  }
  assert.fail("No ocurrió la recuperación esperada del coordinador");
}

function simularCoordinador(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-quorum-vigilancia-"));
  const app = path.join(base, "app"), procesos = [], mensajes = [];
  fs.mkdirSync(path.join(app, "windows"), { recursive: true });
  fs.writeFileSync(path.join(app, "windows", "ajb-quorum.exe"), "simulado");
  const registro = { version: 42, data: { ultimaVenta: "confirmada" } };
  const config = { nodoId: "a".repeat(64), quorum: {
    puerto: 29001, direccion: "127.0.0.1:29001", secreto: "e".repeat(64), bootstrap: [],
  } };
  const consenso = iniciarConsenso({ base, dirApp: app, config, log: m => mensajes.push(m),
    intervaloVigilancia: 30, esperaVigilancia: 90,
    crearProceso() {
      assert.ok(procesos.every(p => p.cerrado), "no se superponen procesos usando el diario");
      const p = new EventEmitter(), sockets = new Set();
      p.stdout = new PassThrough(); p.stderr = new PassThrough();
      p.sondeos = 0; p.muertes = 0; p.modo = "normal"; p.estadoHTTP = 200;
      const server = http.createServer((req, res) => {
        assert.equal(req.headers.authorization, "Bearer " + p.config.localKey);
        if (req.url === "/local") p.sondeos++;
        if (p.modo === "colgado") return;
        if (p.modo === "parcial") { res.writeHead(200); res.write('{"version":'); return; }
        res.writeHead(req.url === "/state" ? p.estadoHTTP : p.sondeoHTTP || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(registro));
      });
      server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
      p.cerrar = () => {
        if (p.cerrando) return;
        p.cerrando = true;
        for (const socket of sockets) socket.destroy();
        server.close(() => { p.cerrado = true; p.emit("close", 0); });
      };
      p.kill = () => { p.muertes++; if (!p.demorarCierre) p.cerrar(); return true; };
      p.stdin = new Writable({
        write(chunk, _encoding, callback) { p.config = JSON.parse(String(chunk)); callback(); },
        final(callback) { p.cerrar(); callback(); },
      });
      server.listen(0, "127.0.0.1", () => p.stdout.write(`127.0.0.1:${server.address().port}\n`));
      procesos.push(p);
      return p;
    },
  });
  const journal = path.join(base, "ha", "quorum", "raft.db");
  fs.writeFileSync(journal, "registro persistente previo");
  t.after(async () => {
    consenso.detener();
    for (const p of procesos) p.cerrar();
    await hasta(() => procesos.every(p => p.cerrado));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { consenso, procesos, mensajes, journal, registro };
}

test("reinicia un coordinador vivo sin respuesta completa, espera close y conserva su identidad y diario", { timeout: 10000 }, async t => {
  const { consenso, procesos, mensajes, journal, registro } = simularCoordinador(t);
  const original = procesos[0];
  assert.deepEqual(await consenso.pedir("/local"), registro);
  original.demorarCierre = true;
  original.modo = "parcial";
  await hasta(() => original.muertes === 1);
  await assert.rejects(consenso.pedir("/local"), /recuperando/);
  await esperar(1200);
  assert.equal(procesos.length, 1, "no relanza hasta cerrar el helper anterior");
  assert.equal(original.muertes, 1);
  original.cerrar();
  await hasta(() => procesos.length === 2);
  assert.deepEqual(await consenso.pedir("/local"), registro);
  const nuevo = procesos[1];
  for (const campo of ["id", "directory", "secret", "advertise", "listen", "bootstrap"]) {
    assert.deepEqual(nuevo.config[campo], original.config[campo]);
  }
  assert.notEqual(nuevo.config.localKey, original.config.localKey);
  assert.equal(fs.readFileSync(journal, "utf8"), "registro persistente previo");
  assert.equal(mensajes.filter(m => m.includes("dejó de responder")).length, 1);
});

test("la vigilancia tolera un sondeo perdido y los 409/503 de un grupo sin mayoría", { timeout: 10000 }, async t => {
  const { consenso, procesos } = simularCoordinador(t);
  const p = procesos[0];
  await consenso.pedir("/local");
  p.modo = "colgado";
  await hasta(() => p.sondeos >= 2);
  await esperar(100);
  p.modo = "normal";
  const antes = p.sondeos;
  await hasta(() => p.sondeos >= antes + 3);
  assert.equal(p.muertes, 0);
  for (const status of [409, 503]) {
    p.estadoHTTP = status; p.sondeoHTTP = status;
    await assert.rejects(consenso.pedir("/state"), e => e.status === status);
    const antes = p.sondeos;
    await hasta(() => p.sondeos >= antes + 4);
    assert.equal(p.muertes, 0, `HTTP ${status} acredita un helper vivo`);
  }
  assert.equal(procesos.length, 1);
});

test("detener cancela el sondeo colgado y no reinicia ni mata después del cierre", { timeout: 10000 }, async t => {
  const { consenso, procesos, mensajes } = simularCoordinador(t);
  const p = procesos[0];
  await consenso.pedir("/local");
  const antes = p.sondeos;
  p.modo = "colgado";
  await hasta(() => p.sondeos > antes);
  consenso.detener();
  await hasta(() => p.cerrado);
  await esperar(1300);
  assert.equal(p.muertes, 0);
  assert.equal(procesos.length, 1);
  assert.ok(!mensajes.some(m => m.includes("dejó de responder")));
});

test("el coordinador se recupera tras terminar, conserva el registro y respeta la detención", {
  skip: !ejecutable, timeout: 30000,
}, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-quorum-reinicio-"));
  const nodos = [];
  t.after(async () => {
    for (const n of nodos) n.consenso.detener();
    await esperar(300);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  });
  const reservas = Array.from({ length: 3 }, () => http.createServer());
  const puertos = [];
  for (const servidor of reservas) {
    servidor.listen(0, "127.0.0.1");
    await once(servidor, "listening");
    puertos.push(servidor.address().port);
  }
  await Promise.all(reservas.map(s => new Promise(resolve => s.close(resolve))));
  const peers = ["a", "b", "c"].map((letra, i) => ({ id: letra.repeat(64), address: `127.0.0.1:${puertos[i]}` }));
  for (const [i, p] of peers.entries()) {
    const procesos = [];
    const consenso = iniciarConsenso({
      base: path.join(base, p.id[0]), dirApp, log() {},
      config: { nodoId: p.id, quorum: { puerto: puertos[i], direccion: p.address, secreto: "e".repeat(64), bootstrap: peers } },
      crearProceso(...args) { const proceso = spawn(...args); procesos.push(proceso); return proceso; },
    });
    nodos.push({ consenso, procesos });
  }
  async function hasta(fn) {
    for (const limite = Date.now() + 10000; Date.now() < limite;) {
      try { const resultado = await fn(); if (resultado) return resultado; } catch (_e) { /* recuperando */ }
      await esperar(100);
    }
    assert.fail("El coordinador no se recuperó automáticamente");
  }
  const elegido = await hasta(() => Promise.any(nodos.map(async nodo => ({ nodo, estado: await nodo.consenso.pedir("/state") }))));
  const registro = await elegido.nodo.consenso.pedir("/state", {
    expected: elegido.estado.register.version, term: elegido.estado.term, configuration: elegido.estado.configuration,
    data: { revision: 42, ultimaVenta: "confirmada" },
  });
  const victima = elegido.nodo;
  const cerrada = once(victima.procesos[0], "close");
  victima.procesos[0].kill();
  await cerrada;
  await assert.rejects(victima.consenso.pedir("/local"), /recuperando/);
  const recuperada = await hasta(async () => {
    if (victima.procesos.length < 2) return null;
    const local = await victima.consenso.pedir("/local");
    return local.version === registro.version && local;
  });
  assert.deepEqual(recuperada.data, registro.data);
  assert.equal(victima.procesos.length, 2);
  const final = once(victima.procesos[1], "close");
  victima.procesos[1].kill();
  await final;
  victima.consenso.detener();
  await esperar(2200);
  assert.equal(victima.procesos.length, 2, "detener cancela el relanzamiento pendiente");
});
