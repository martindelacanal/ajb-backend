"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const protocolo = require("../predios/lib/protocolo-lan");
const httpLan = require("../predios/lib/http-lan");

const fuente = fs.readFileSync(require.resolve("../api/services/predios-miramar-diagnostico"), "utf8");
const ruta = "/lan/diagnostico-acceso-miramar";
const ip = "192.168.1.99";
const claveDatos = "credencial-de-prueba-sin-acceso";
const grupoId = "grupo-de-prueba";
const principal = { id: "principal", nombre: "ajbmiramar", url: "https://" + ip + ":8443", preferido: true };
const propio = { id: "respaldo", nombre: "desktop-mn7m56l", url: "https://192.168.1.122:8443", preferido: false };
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

function simular({ nombrePc = propio.nombre, codigo = "MIRAMAR", fallaCorto = false, firmaValida = true } = {}) {
  const modulo = { exports: {} };
  const consultas = [];
  const requests = [];
  const dependencies = {
    "node:os": { hostname: () => nombrePc },
    "node:dns/promises": {
      async lookup(nombre, opciones) {
        consultas.push(nombre);
        assert.equal(opciones.family, 4);
        if (fallaCorto && nombre === "ajbmiramar") throw Object.assign(new Error("DNS no resuelve"), { code: "ENOTFOUND" });
        return [{ address: ip, family: 4 }];
      },
    },
    "node:http": {
      get(opciones, callback) {
        requests.push(opciones);
        const req = new EventEmitter();
        req.destroy = error => req.emit("error", error);
        queueMicrotask(() => {
          const res = Object.assign(new EventEmitter(), {
            statusCode: 200,
            headers: { "content-type": opciones.path === "/" ? "text/html; charset=utf-8" : "application/json" },
            destroy() {},
          });
          callback(res);
          let datos = { escritura: { autorizado: true } };
          if (opciones.path.startsWith("/lan/quorum/estado?")) {
            const estado = {
              tipo: "AJB_TESTIGO_ESTADO", formato: 1, grupo_id: grupoId, termino: 1,
              emitido_ms: Date.now(), vence_ms: Date.now() + 2000,
              desafio: new URL(opciones.path, "http://ajbmiramar").searchParams.get("desafio"),
              escritor: { id: principal.id, nombre: principal.nombre }, preferido_id: principal.id,
              solo_principal: true, regreso_automatico: false, votantes: [principal.id],
            };
            datos = { estado, firma: firmaValida ? crypto.sign(null, Buffer.from(JSON.stringify(estado)), privateKey).toString("base64") : "incorrecta" };
          }
          res.emit("data", Buffer.from(JSON.stringify(datos)));
          res.emit("end");
        });
        return req;
      },
    },
    "./protocolo-lan": protocolo,
    "./http-lan": httpLan,
  };
  vm.runInNewContext(fuente, {
    module: modulo, require: id => dependencies[id] || require(id), process: { platform: "win32" },
    Buffer, AbortSignal, clearTimeout,
    setTimeout: (fn, ms) => ms === 8000 ? setImmediate(fn) : setTimeout(fn, ms),
  });
  const diagnostico = modulo.exports.crearDiagnosticoAccesoMiramar({
    config: { predio_codigo: codigo },
    ha: {
      habilitado: true, rolInstalacion: "Respaldo", nodoId: propio.id, equipoId: propio.id,
      grupoId, claveDatos, clavePublicaTestigo: publicKey, quorum: {}, miembros: [principal, propio],
    },
  });
  return { diagnostico, consultas, requests };
}

function firma(nodoId = principal.id) {
  return protocolo.firmarPeticion({ grupoId, nodoId, metodo: "GET", ruta, cuerpo: Buffer.alloc(0), clave: claveDatos });
}

function reporte(diagnostico, cabeceras = firma(), origen = ip) {
  let status, resultado;
  const res = { writeHead: codigo => { status = codigo; }, end: contenido => { resultado = JSON.parse(contenido); } };
  assert.equal(diagnostico.manejar({ method: "GET", url: ruta, headers: cabeceras }, res, ruta, origen), true);
  return { status, resultado };
}

async function esperarPruebas() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

test("limita el diagnóstico a los dos respaldos de Miramar", () => {
  assert.equal(simular({ nombrePc: "ajbmiramar" }).diagnostico, null);
  assert.equal(simular({ codigo: "OTRO" }).diagnostico, null);
});

test("prueba el nombre corto y entrega el resultado al principal autenticado una vez por firma", async () => {
  const { diagnostico, consultas, requests } = simular();
  await esperarPruebas();
  assert.deepEqual(consultas, ["ajbmiramar"]);
  assert.equal(requests.length, 3);
  assert(requests.every(({ hostname, port }) => hostname === "ajbmiramar" && port === 8080));
  assert.equal(requests.at(-1).path, "/");
  const cabeceras = firma();
  assert.equal(reporte(diagnostico, cabeceras, "192.168.1.69").status, 403);
  assert.equal(reporte(diagnostico, firma(propio.id)).status, 403);
  assert.equal(reporte(diagnostico, {}).status, 403);
  const { status, resultado } = reporte(diagnostico, cabeceras);
  assert.equal(status, 200);
  assert.equal(resultado.finalizado, true);
  assert.equal(resultado.corto.codigo, "OK");
  assert.deepEqual(resultado.corto.dns, [ip]);
  assert.equal(resultado.corto.http, 200);
  assert.equal(resultado.corto.http_inicio, 200);
  assert.equal(resultado.alternativo, null);
  assert.equal(reporte(diagnostico, cabeceras).status, 403);
});

test("distingue el fallo DNS del nombre corto y verifica el nombre alternativo sin cambiar la resolución", async () => {
  const { diagnostico, consultas, requests } = simular({ fallaCorto: true });
  await esperarPruebas();
  const { resultado } = reporte(diagnostico);
  assert.equal(resultado.finalizado, true);
  assert.equal(resultado.intento, 5);
  assert.equal(resultado.corto.codigo, "DNS_NO_RESUELVE");
  assert.equal(resultado.alternativo.codigo, "OK");
  assert.equal(resultado.alternativo.http_inicio, 200);
  assert.equal(consultas.length, 10);
  assert(requests.every(({ hostname }) => hostname === "ajbmiramar.lan"));
  assert.equal(requests.filter(({ path }) => path === "/").length, 5);
});

test("rechaza un HTTP 200 sin prueba firmada del servidor", async () => {
  const { diagnostico, requests } = simular({ firmaValida: false });
  await esperarPruebas();
  const { resultado } = reporte(diagnostico);
  assert.equal(resultado.finalizado, true);
  assert.equal(resultado.corto.codigo, "FIRMA_NO_VALIDA");
  assert.equal(resultado.corto.http, null);
  assert.equal(resultado.corto.http_inicio, null);
  assert(requests.every(({ path }) => path.startsWith("/lan/quorum/estado?")));
});
