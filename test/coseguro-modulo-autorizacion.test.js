"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "coseguro-modulo-test-secret";

const databaseCalls = [];
let sesionActual;
let databaseHandler = async (sql) => {
  throw new Error(`Consulta inesperada: ${sql}`);
};

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

async function consultar(sql, params = []) {
  databaseCalls.push({ sql, params });
  if (esConsultaAutorizacion(sql)) {
    return [[{ ...sesionActual }]];
  }
  return databaseHandler(sql, params);
}

const fakeConnection = {
  promise() {
    return {
      query: consultar,
      execute: consultar,
    };
  },
};

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: fakeConnection,
};

const coseguroRouter = require("../api/routes/coseguro");
const app = express();
app.use(express.json());
app.use("/api", coseguroRouter);

function usuarioSesion(overrides = {}) {
  return {
    id: 9,
    rol_id: 3,
    rol: "afiliado",
    departamental_id: 7,
    habilitado: "Y",
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 1,
    ...overrides,
  };
}

function preparar({ sesion, handler } = {}) {
  databaseCalls.length = 0;
  sesionActual = usuarioSesion(sesion);
  databaseHandler = handler || (async (sql) => {
    throw new Error(`Consulta inesperada: ${sql}`);
  });
}

function consultasDeNegocio() {
  return databaseCalls.filter(({ sql }) => !esConsultaAutorizacion(sql));
}

function token() {
  return jwt.sign({ data: JSON.stringify({ id: 9, rol: "afiliado" }) }, process.env.JWT_SECRET);
}

async function request(path, { method = "GET" } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token()}` },
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("catalogos y perfil rechazan al afiliado con Coseguro deshabilitado antes de leer datos", async (t) => {
  for (const path of ["/api/coseguro/catalogos", "/api/coseguro/perfil"]) {
    await t.test(path, async () => {
      preparar({ sesion: { modulo_coseguro: 0 } });

      const response = await request(path);

      assert.equal(response.status, 401);
      assert.equal(response.body, "No autorizado");
      assert.equal(consultasDeNegocio().length, 0);
    });
  }
});

test("perfil conserva el acceso del afiliado con Coseguro habilitado", async () => {
  preparar({
    sesion: { modulo_coseguro: 1 },
    handler: async (sql) => {
      if (/FROM usuario u LEFT JOIN departamental d/i.test(sql)) {
        return [[{ id: 9, nombre: "Ana", apellido: "Perez", departamental_id: 7 }]];
      }
      if (/WHERE u\.usuario_familiar_id = \?/i.test(sql)) return [[]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  const response = await request("/api/coseguro/perfil");

  assert.equal(response.status, 200);
  assert.equal(response.body.usuario.id, 9);
});

test("lectura del subsidio propio rechaza al afiliado con Coseguro deshabilitado", async () => {
  preparar({ sesion: { modulo_coseguro: 0 } });

  const response = await request("/api/coseguro/subsidios-salud/5");

  assert.equal(response.status, 401);
  assert.equal(response.body, "No autorizado");
  assert.equal(consultasDeNegocio().length, 0);
});

test("carga de certificados rechaza el modulo apagado antes de consultar el subsidio", async () => {
  preparar({ sesion: { modulo_coseguro: 0 } });

  const response = await request("/api/coseguro/subsidios-salud/5/archivos", { method: "POST" });

  assert.equal(response.status, 401);
  assert.equal(response.body, "No autorizado");
  assert.equal(consultasDeNegocio().length, 0);
});

test("catalogos conserva la regla de area del staff", async () => {
  preparar({
    sesion: { rol_id: 2, rol: "departamental", area_coseguro: 0 },
  });
  const sinArea = await request("/api/coseguro/catalogos");
  assert.equal(sinArea.status, 401);
  assert.equal(consultasDeNegocio().length, 0);

  preparar({
    sesion: { rol_id: 2, rol: "departamental", area_coseguro: 1 },
    handler: async () => [[]],
  });
  const conArea = await request("/api/coseguro/catalogos");
  assert.equal(conArea.status, 200);
  assert.ok(consultasDeNegocio().length > 0);
});
