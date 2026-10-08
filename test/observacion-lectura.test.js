"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "observacion-lectura-test-secret";
let usuarioActual;
const lecturas = new Map();
const consultas = [];
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true,
  exports: { promise: () => ({ async query(sql, params) {
    if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql)) {
      return [[usuarioActual]];
    }
    consultas.push({ sql, params });
    const clave = params.slice(0, 3).join(":");
    if (sql.startsWith("SELECT ultima_observacion_id")) {
      return [lecturas.has(clave) ? [{ ultima_observacion_id: lecturas.get(clave) }] : []];
    }
    if (sql.startsWith("INSERT INTO observacion_lectura")) {
      lecturas.set(clave, Math.max(lecturas.get(clave) || 0, params[3]));
      return [{ affectedRows: 1 }];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  } }) },
};

const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/user"));
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/observaciones`;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
test.beforeEach(() => { lecturas.clear(); consultas.length = 0; });

async function solicitar({ id = 9, rol = "departamental", modulo = "turismo-gestion", entidadId = 31,
  method = "GET", body, query = "", anonimo = false } = {}) {
  usuarioActual = { id, rol, rol_id: 1, habilitado: "Y", departamental_id: 7, area_turismo: 1,
    area_coseguro: 1, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1 };
  const token = jwt.sign({ data: JSON.stringify(usuarioActual) }, process.env.JWT_SECRET);
  const respuesta = await fetch(`${baseUrl}/${modulo}/${entidadId}/lectura${query}`, {
    method, headers: { ...(anonimo ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: respuesta.status, body: await respuesta.json() };
}

test("departamental y administración conservan su lectura del chat de servicios", async () => {
  for (const rol of ["departamental", "admin-central", "admin"]) {
    lecturas.clear();
    assert.deepEqual(await solicitar({ rol }), { status: 200, body: { ultima_observacion_id: 0 } });
    assert.deepEqual(await solicitar({ rol, method: "PUT", body: { ultima_observacion_id: 42 } }),
      { status: 200, body: { success: true } });
    assert.deepEqual(await solicitar({ rol }), { status: 200, body: { ultima_observacion_id: 42 } });
    await solicitar({ rol, method: "PUT", body: { ultima_observacion_id: 12 } });
    assert.equal((await solicitar({ rol })).body.ultima_observacion_id, 42);
  }
  assert.match(consultas.find(({ sql }) => sql.startsWith("INSERT")).sql, /GREATEST/);
});

test("GET y PUT usan la cuenta de sesión y aíslan otros usuarios, entidades y módulos", async () => {
  await solicitar({ method: "PUT", query: "?usuario_id=10",
    body: { ultima_observacion_id: 42, usuario_id: 10 } });
  assert.deepEqual(consultas[0].params, [9, "turismo-gestion", 31, 42]);
  assert.equal((await solicitar({ query: "?usuario_id=10" })).body.ultima_observacion_id, 42);
  assert.deepEqual(consultas[1].params, [9, "turismo-gestion", 31]);
  assert.equal((await solicitar({ id: 10 })).body.ultima_observacion_id, 0);
  assert.equal((await solicitar({ entidadId: 32 })).body.ultima_observacion_id, 0);
  assert.equal((await solicitar({ modulo: "turismo" })).body.ultima_observacion_id, 0);
  await solicitar({ id: 10, method: "PUT", body: { ultima_observacion_id: 77 } });
  assert.equal((await solicitar()).body.ultima_observacion_id, 42);
  assert.equal((await solicitar({ id: 10 })).body.ultima_observacion_id, 77);
});

test("los parámetros inválidos y las sesiones anónimas no consultan ni guardan lecturas", async () => {
  for (const options of [{ modulo: "inexistente" }, { entidadId: 0 }]) {
    assert.equal((await solicitar(options)).status, 400);
    assert.equal((await solicitar({ ...options, method: "PUT", body: { ultima_observacion_id: 42 } })).status, 400);
  }
  assert.equal((await solicitar({ method: "PUT", body: { ultima_observacion_id: 0 } })).status, 400);
  for (const method of ["GET", "PUT"]) {
    const respuesta = await solicitar({ method, anonimo: true,
      ...(method === "PUT" ? { body: { ultima_observacion_id: 42 } } : {}) });
    assert.ok([401, 403].includes(respuesta.status));
  }
  assert.equal(consultas.length, 0);
  assert.equal(lecturas.size, 0);
});
