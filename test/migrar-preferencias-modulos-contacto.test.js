"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  COLUMNAS,
  CONFIRMACION,
  main,
} = require("../scripts/migrar-preferencias-modulos-contacto");

const entornoValido = {
  DB_HOST: "db.test",
  DB_USER: "usuario",
  DB_PASSWORD: "secreto",
  DB_DATABASE: "ajb_test",
};

function crearPoolFalso(columnas = []) {
  const llamadas = [];
  let liberada = false;
  let cerrado = false;
  let promiseInvocado = false;

  const connection = {
    async query(sql, params = []) {
      llamadas.push({ sql, params });
      if (/information_schema\.COLUMNS/i.test(sql)) {
        return [columnas.map((COLUMN_NAME) => ({ COLUMN_NAME }))];
      }
      if (/^\s*ALTER TABLE usuario ADD COLUMN/i.test(sql)) {
        return [{ affectedRows: 0 }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    release() {
      liberada = true;
    },
  };

  const promisePool = {
    async getConnection() {
      return connection;
    },
    async end() {
      cerrado = true;
    },
  };

  return {
    pool: {
      promise() {
        promiseInvocado = true;
        return promisePool;
      },
    },
    estado() {
      return { llamadas, liberada, cerrado, promiseInvocado };
    },
  };
}

test("la migracion reutiliza la conexion compartida con TLS y zona horaria", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "scripts", "migrar-preferencias-modulos-contacto.js"),
    "utf8"
  );

  assert.match(source, /require\("\.\.\/api\/connection\/connection"\)/);
  assert.doesNotMatch(source, /require\(["']mysql2\/promise["']\)/);
  assert.doesNotMatch(source, /\.createConnection\s*\(/);
});

test("el dry-run inspecciona el esquema sin ejecutar ALTER y cierra el pool", async () => {
  const falso = crearPoolFalso([]);
  const logs = [];

  await main({
    argv: ["node", "migracion"],
    env: entornoValido,
    pool: falso.pool,
    logger: { log: (mensaje) => logs.push(mensaje) },
  });

  const estado = falso.estado();
  assert.equal(estado.promiseInvocado, true);
  assert.equal(estado.liberada, true);
  assert.equal(estado.cerrado, true);
  assert.equal(estado.llamadas.length, 1);
  assert.match(estado.llamadas[0].sql, /information_schema\.COLUMNS/i);
  assert.deepEqual(estado.llamadas[0].params, ["ajb_test"]);
  assert.equal(estado.llamadas.some(({ sql }) => /ALTER TABLE/i.test(sql)), false);
  assert.match(logs.join("\n"), /dry-run-read-only/);
});

test("--apply exige confirmacion antes de abrir una conexion", async () => {
  const falso = crearPoolFalso([]);

  await assert.rejects(
    main({
      argv: ["node", "migracion", "--apply"],
      env: entornoValido,
      pool: falso.pool,
      logger: { log() {} },
    }),
    new RegExp(`--confirm=${CONFIRMACION}`)
  );

  assert.equal(falso.estado().promiseInvocado, false);
});

test("--apply es idempotente cuando todas las columnas ya existen", async () => {
  const falso = crearPoolFalso(COLUMNAS.map(({ nombre }) => nombre));

  await main({
    argv: ["node", "migracion", "--apply", `--confirm=${CONFIRMACION}`],
    env: entornoValido,
    pool: falso.pool,
    logger: { log() {} },
  });

  const estado = falso.estado();
  assert.equal(estado.llamadas.length, 1);
  assert.equal(estado.llamadas.some(({ sql }) => /ALTER TABLE/i.test(sql)), false);
  assert.equal(estado.liberada, true);
  assert.equal(estado.cerrado, true);
});
