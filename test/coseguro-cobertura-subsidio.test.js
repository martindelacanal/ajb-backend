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

async function pedir(metodo, body) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify({ id: 100, rol: rolActual }) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/coseguro/cobertura`, {
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

test("PUT /coseguro/cobertura conserva es_subsidio si no viene y lo guarda si viene", async () => {
  llamadas.length = 0;
  const respuesta = await pedir("PUT", {
    tipos: [
      { id: 6, nombre: "Bono", modo_cobertura: "MANUAL" },
      { id: 7, nombre: "Obsequio por nacimiento", modo_cobertura: "MANUAL", es_subsidio: false },
      { id: 8, nombre: "Psicología", modo_cobertura: "MANUAL", es_subsidio: "1" },
    ],
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  const [bono, nacimiento, psicologia] = updates();
  assert.match(bono.sql, /es_subsidio = COALESCE\(\?, es_subsidio\)/);
  assert.equal(bono.params[3], null);
  assert.equal(nacimiento.params[3], 0);
  assert.equal(psicologia.params[3], 1);
  assert.equal(typeof respuesta.body.tipos[0].es_subsidio, "boolean");
});

test("PUT /coseguro/cobertura rechaza un es_subsidio inválido sin tocar la base", async () => {
  llamadas.length = 0;
  const respuesta = await pedir("PUT", { tipos: [{ id: 7, nombre: "Obsequio por nacimiento", modo_cobertura: "MANUAL", es_subsidio: "tal vez" }] });
  assert.equal(respuesta.status, 400);
  assert.match(respuesta.body, /indicador de subsidio de "Obsequio por nacimiento" es inválido/);
  assert.equal(updates().length, 0);
});
