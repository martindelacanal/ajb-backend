"use strict";

// Página pública que abre el QR del dorso: con el código vigente muestra quién es
// el titular (nombre, foto y DNI) para compararlo con la persona; con un código
// expirado o inexistente no devuelve ningún dato personal.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { S3Client } = require("@aws-sdk/client-s3");

process.env.JWT_SECRET = "credencial-digital-verificacion-test-secret";

let databaseHandler = async (sql) => {
  throw new Error(`Consulta inesperada: ${sql}`);
};

const fakeConnection = {
  promise() {
    return { query: (sql, params) => databaseHandler(sql, params), execute: (sql, params) => databaseHandler(sql, params) };
  },
};

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: fakeConnection };

const userRouter = require("../api/routes/user");
const app = express();
app.use("/api", userRouter);

const HASH = "a1".repeat(25);
const FOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const consoleLogOriginal = console.log;
const enviarOriginal = S3Client.prototype.send;
const clavesS3 = [];
test.before(() => {
  console.log = () => {};
  S3Client.prototype.send = async (comando) => {
    clavesS3.push(comando.input?.Key);
    return { Body: FOTO, ContentType: "image/jpeg" };
  };
});
test.after(() => {
  console.log = consoleLogOriginal;
  S3Client.prototype.send = enviarOriginal;
});

function usuario(fechaValidez) {
  return {
    id: 9,
    hash_credencial: HASH,
    fecha_validez: fechaValidez,
    fecha_actual: "2026-11-04",
    nombre: "Rosa",
    apellido: "Benítez",
    documento: 28123456,
    foto_archivo: "usuarios/9/foto.jpg",
  };
}

function preparar(filas) {
  clavesS3.length = 0;
  databaseHandler = async (sql, params) => {
    if (/FROM usuario\s+WHERE hash_credencial = \?/i.test(sql)) {
      assert.deepEqual(params, [HASH]);
      return [filas];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

async function verificar(hash = HASH) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/credencial-digital/verificacion/${hash}`);
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text, cache: response.headers.get("cache-control") };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("con el código vigente devuelve nombre, apellido, DNI y la foto en base64", async () => {
  preparar([usuario("2026-11-04")]);

  const respuesta = await verificar();

  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.estado, "Vigente");
  assert.deepEqual(respuesta.body.titular, {
    nombre: "Rosa",
    apellido: "Benítez",
    dni: "28123456",
    foto_data: `data:image/jpeg;base64,${FOTO.toString("base64")}`,
  });
  assert.deepEqual(clavesS3, ["usuarios/9/foto.jpg"]);
  assert.equal(respuesta.cache, "no-store");
});

test("sin foto cargada, el titular vigente llega sin foto y no se consulta S3", async () => {
  preparar([{ ...usuario("2026-11-04"), foto_archivo: null }]);

  const respuesta = await verificar();

  assert.equal(respuesta.body.estado, "Vigente");
  assert.equal(respuesta.body.titular.foto_data, null);
  assert.equal(clavesS3.length, 0);
});

test("un código de otro día es Expirada y no lleva ningún dato del titular", async () => {
  preparar([usuario("2026-11-03")]);

  const respuesta = await verificar();

  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.estado, "Expirada");
  assert.equal("titular" in respuesta.body, false);
  for (const dato of ["Rosa", "Benítez", "28123456", "base64"]) assert.equal(respuesta.text.includes(dato), false, dato);
  assert.equal(clavesS3.length, 0);
});

test("un código que no existe es Inexistente y no lleva ningún dato", async () => {
  preparar([]);

  const respuesta = await verificar();

  assert.equal(respuesta.status, 404);
  assert.equal(respuesta.body.estado, "Inexistente");
  assert.equal("titular" in respuesta.body, false);
  assert.equal(clavesS3.length, 0);
});

test("un código mal formado se rechaza sin consultar la base", async () => {
  databaseHandler = async (sql) => {
    throw new Error(`No debía consultar: ${sql}`);
  };

  const respuesta = await verificar("corto");

  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body.estado, "Inexistente");
  assert.equal("titular" in respuesta.body, false);
});
