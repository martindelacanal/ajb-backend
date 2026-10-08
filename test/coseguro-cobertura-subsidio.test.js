"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "coseguro-cobertura-subsidio-test-secret";

const llamadas = [];
let rolActual = "admin";

async function consultar(sql, params = []) {
  llamadas.push({ sql, params });
  if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r/.test(sql)) {
    return [[{ id: 100, rol: rolActual, rol_id: 1, departamental_id: null, habilitado: "Y", area_coseguro: 1 }]];
  }
  if (/UPDATE coseguro_tipo_reintegro/.test(sql)) return [{ affectedRows: 1 }];
  if (/INSERT INTO coseguro_cobertura_historial/.test(sql)) return [{ affectedRows: 1 }];
  if (/FROM coseguro_cobertura_historial/.test(sql)) return [[{ id: 1, tipo_reintegro_id: 7, modo_nuevo: "MANUAL", origen: "INICIAL" }]];
  if (/FROM coseguro_tipo_reintegro[\s\S]+FOR UPDATE/.test(sql)) {
    return [[{ id: params[0], modo_cobertura: "MANUAL", porcentaje_cobertura: null, tope_reintegro: null, es_subsidio: params[0] === 7 ? 1 : 0 }]];
  }
  if (/FROM coseguro_tipo_reintegro/.test(sql)) {
    return [[
      { id: 6, nombre: "Bono", modo_cobertura: "MANUAL", porcentaje_cobertura: null, tope_reintegro: null, es_subsidio: 0, activo: 1, orden: 6, solicitudes: 0 },
      { id: 7, nombre: "Obsequio por nacimiento", modo_cobertura: "MANUAL", porcentaje_cobertura: null, tope_reintegro: null, es_subsidio: 1, activo: 1, orden: 7, solicitudes: 2 },
    ]];
  }
  throw new Error(`Consulta inesperada: ${sql}`);
}

const conexion = {
  query: consultar,
  async beginTransaction() {},
  async commit() {},
  async rollback() {},
  release() {},
};
const db = { query: consultar, async getConnection() { return conexion; } };

function reemplazarModulo(ruta, exports) {
  const filename = require.resolve(ruta);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
reemplazarModulo("../api/connection/connection", { promise: () => db });

const router = require("../api/routes/coseguro");
const app = express();
app.use(express.json());
app.use("/api", router);

async function pedir(metodo, body, ruta = "/coseguro/cobertura") {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify({ id: 100, rol: rolActual }) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${ruta}`, {
      method: metodo,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function updates() {
  return llamadas.filter(({ sql }) => /UPDATE coseguro_tipo_reintegro/.test(sql));
}

test("GET /coseguro/cobertura devuelve es_subsidio como booleano", async () => {
  llamadas.length = 0;
  const respuesta = await pedir("GET");
  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.body.tipos.map((tipo) => [tipo.id, tipo.es_subsidio]), [[6, false], [7, true]]);
  assert.ok(llamadas.some(({ sql }) => /t\.es_subsidio/.test(sql)));
});

test("PUT /coseguro/cobertura omite cambios vacíos y audita el subsidio que cambia", async () => {
  llamadas.length = 0;
  const respuesta = await pedir("PUT", {
    tipos: [
      { id: 6, nombre: "Bono", modo_cobertura: "MANUAL" },
      { id: 7, nombre: "Obsequio por nacimiento", modo_cobertura: "MANUAL", es_subsidio: false },
      { id: 8, nombre: "Psicología", modo_cobertura: "MANUAL", es_subsidio: "1" },
    ],
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  const [nacimiento, psicologia] = updates();
  assert.equal(updates().length, 2);
  assert.match(nacimiento.sql, /es_subsidio = COALESCE\(\?, es_subsidio\)/);
  assert.equal(nacimiento.params[3], 0);
  assert.equal(psicologia.params[3], 1);
  assert.equal(typeof respuesta.body.tipos[0].es_subsidio, "boolean");
  const historial = llamadas.filter(({ sql }) => /INSERT INTO coseguro_cobertura_historial/.test(sql));
  assert.equal(historial.length, 2);
  assert.deepEqual(historial[0].params, [7, 100, "admin", "MANUAL", "MANUAL", null, null, null, null, 1, 0]);
});

test("PUT audita porcentaje y tope anteriores junto con actor", async () => {
  llamadas.length = 0;
  const respuesta = await pedir("PUT", { tipos: [{ id: 6, modo_cobertura: "PORCENTAJE", porcentaje_cobertura: 65, tope_reintegro: 5000 }] });
  assert.equal(respuesta.status, 200);
  const historial = llamadas.find(({ sql }) => /INSERT INTO coseguro_cobertura_historial/.test(sql));
  assert.deepEqual(historial.params, [6, 100, "admin", "MANUAL", "PORCENTAJE", null, 65, null, 5000, 0, 0]);
});

test("PUT /coseguro/cobertura rechaza un es_subsidio inválido sin tocar la base", async () => {
  llamadas.length = 0;
  const respuesta = await pedir("PUT", { tipos: [{ id: 7, nombre: "Obsequio por nacimiento", modo_cobertura: "MANUAL", es_subsidio: "tal vez" }] });
  assert.equal(respuesta.status, 400);
  assert.match(respuesta.body, /indicador de subsidio de "Obsequio por nacimiento" es inválido/);
  assert.equal(updates().length, 0);
});

test("historial de cobertura filtra tipo y rechaza filtros o roles fuera de gestión central", async () => {
  llamadas.length = 0;
  const respuesta = await pedir("GET", null, "/coseguro/cobertura/historial?tipo_reintegro_id=7");
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.historial[0].origen, "INICIAL");
  const consulta = llamadas.find(({sql}) => /FROM coseguro_cobertura_historial/.test(sql));
  assert.deepEqual(consulta.params, [7]);
  assert.match(consulta.sql, /WHERE h\.tipo_reintegro_id = \?/);
  assert.equal((await pedir("GET", null, "/coseguro/cobertura/historial?tipo_reintegro_id=1e3")).status, 400);
  rolActual = "departamental";
  try { assert.equal((await pedir("GET", null, "/coseguro/cobertura/historial")).status, 401); }
  finally { rolActual = "admin"; }
});
