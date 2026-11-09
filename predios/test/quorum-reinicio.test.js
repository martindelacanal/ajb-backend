"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { setTimeout: esperar } = require("node:timers/promises");
const { iniciarConsenso } = require("../lib/quorum-lan");

const dirApp = path.join(__dirname, "..");
const ejecutable = process.platform === "win32" && fs.existsSync(path.join(dirApp, "windows", "ajb-quorum.exe"));

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
