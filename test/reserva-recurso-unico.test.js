"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recursoUnico } = require("../api/services/reserva-recurso-unico");
const { operar } = require("../api/services/recepcion");

test("acepta el recurso escalar y los clientes anteriores con arreglo unitario coincidente", () => {
  assert.equal(recursoUnico({ recurso_id: 12 }), 12);
  assert.equal(recursoUnico({ recurso_id: "12", recursos_ids: [12] }), 12);
  assert.equal(recursoUnico({ recurso_id: 12, recursos_ids: ["12"] }), 12);
  assert.equal(recursoUnico({}, false), null);
  assert.equal(recursoUnico({ recurso_id: "", recursos_ids: [] }, false), null);
});

test("no descarta silenciosamente recursos adicionales ni selecciones inconsistentes", () => {
  for (const datos of [
    { recurso_id: 12, recursos_ids: [12, 13] },
    { recurso_id: 12, recursos_ids: [12, 12] },
    { recurso_id: 12, recursos_ids: [13] },
    { recurso_id: 12, recursos_ids: [] },
    { recurso_id: 12, recursos_ids: "12,13" },
    { recurso_id: 12, recursos_ids: [[12]] },
    { recurso_id: [12] },
    { recurso_id: 0 },
    { recurso_id: 12.5 },
    { recurso_id: true },
    { recursos_ids: [12] },
  ]) assert.throws(() => recursoUnico(datos), { statusCode: 400 });
  assert.throws(() => recursoUnico({ recursos_ids: [12] }, false), { statusCode: 400 });
});

test("recepción rechaza cotizar y guardar varios recursos sin crear personas ni reservas", async () => {
  const predio = { id: 1, servicio_codigos: '["MIRAMAR_CABANAS"]' };
  const actor = { id: 1, rol: "ADMIN" };
  for (const accion of ["guardar", "cotizar"]) {
    const consultas = [];
    const db = { query: async sql => { consultas.push(sql); return [[]]; } };
    await assert.rejects(operar(db, predio, actor, accion, {
      recurso_id: 12, recursos_ids: [12, 13], tipo: "GENERAL"
    }), { status: 400 });
    assert.deepEqual(consultas, accion === "guardar" ? [] : [
      "SAVEPOINT recepcion_previa", "ROLLBACK TO SAVEPOINT recepcion_previa", "RELEASE SAVEPOINT recepcion_previa"
    ]);
  }
});
