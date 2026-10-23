"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { consultarIngresoMiAjb } = require("../api/services/reservas-firma");

test("antes de «Se la envío…» se sabe si la persona entró alguna vez a Mi AJB", async () => {
  const conn = (fila) => ({ async query(sql, params) {
    assert.match(sql, /primer_ingreso IS NOT NULL OR ultimo_ingreso IS NOT NULL/);
    assert.deepEqual(params, [5]);
    return [fila ? [fila] : []];
  } });
  assert.equal(await consultarIngresoMiAjb(conn({ ingreso: 1 }), 5), true);
  assert.equal(await consultarIngresoMiAjb(conn({ ingreso: 0 }), 5), false);
  assert.equal(await consultarIngresoMiAjb(conn(null), 5), null);
  // Una base sin las columnas de ingreso no frena la carga: no se sabe.
  const sinColumnas = { query: async () => { throw Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" }); } };
  assert.equal(await consultarIngresoMiAjb(sinColumnas, 5), null);
  const caida = { query: async () => { throw Object.assign(new Error("se cayó"), { code: "PROTOCOL_CONNECTION_LOST" }); } };
  await assert.rejects(consultarIngresoMiAjb(caida, 5), /se cayó/);
});
