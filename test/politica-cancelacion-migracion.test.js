"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ejecutarMigracion, resolverNahuel, DETALLE_CORRECCION } = require("../scripts/migrar-politicas-cancelacion-servicios");

test("la corrección de autoría exige identidad única y no presupone un ID", async () => {
  for (const rows of [[], [{ id: 1, nombre: "Otro" }], [{ id: 1, nombre: "Nahuel" }, { id: 2, nombre: "Otro" }]]) {
    await assert.rejects(resolverNahuel({ query: async () => [rows] }), /único usuario con rol admin y nombre Nahuel/);
  }
  assert.equal(await resolverNahuel({ query: async () => [[{ id: 8, nombre: " NAHUEL " }]] }), 8);
  assert.match(DETALLE_CORRECCION, /generada automáticamente sin autor/);
  assert.match(DETALLE_CORRECCION, /no representa una publicación/);
});

test("check de esquema nuevo no escribe ni inicia transacción; informa también prerequisitos v1", async () => {
  const consultas = [];
  const db = { query: async sql => {
    consultas.push(sql);
    if (sql.includes("FROM usuario u")) return [[{ id: 1, nombre: "Nahuel" }]];
    if (sql.includes("information_schema")) return [[]];
    assert.fail(`Consulta inesperada ${sql}`);
  }, beginTransaction() { assert.fail("check no debe abrir transacción"); } };
  const resultado = await ejecutarMigracion(db, { log() {} });
  assert.equal(resultado.tablasFaltantes.length, 4);
  assert.equal(resultado.columnasFaltantes.length, 3);
  assert.equal(resultado.tablasBaseFaltantes.length, 4);
  assert.equal(resultado.aplicada, false);
  assert.equal(resultado.nahuelId, 1);
  assert.ok(consultas.every(sql => sql.trim().startsWith("SELECT")));
});

test("apply se detiene antes de DDL si no puede verificar el administrador", async () => {
  const consultas = [];
  await assert.rejects(ejecutarMigracion({ query: async sql => {
    consultas.push(sql);
    return [[]];
  } }, { checkOnly: false, log() {} }), /único usuario/);
  assert.equal(consultas.length, 1);
  assert.ok(consultas[0].startsWith("SELECT"));
});
