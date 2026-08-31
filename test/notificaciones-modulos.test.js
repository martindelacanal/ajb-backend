"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { condicionModuloNotificacion } = require("../api/services/notificaciones-modulos");

test("Turismo incluye todos los tipos de reserva y convenio salvo Reserva Salud", () => {
  const condicion = condicionModuloNotificacion("turismo");

  assert.match(condicion.sql, /n\.tipo LIKE \?/);
  assert.match(condicion.sql, /n\.tipo NOT LIKE \?/);
  assert.deepEqual(condicion.params, [
    "RESERVA_%",
    "CONVENIO_%",
    "TURISMO_%",
    "SORTEO_ADJUDICADO",
    "RESERVA_SALUD%",
  ]);
});

test("Salud conserva prioridad propia y otras excluye todos los modulos", () => {
  assert.deepEqual(condicionModuloNotificacion("salud").params, ["RESERVA_SALUD%"]);
  const otras = condicionModuloNotificacion("otras");
  assert.match(otras.sql, /^NOT \(/);
  assert.ok(otras.params.includes("RESERVA_%"));
  assert.ok(otras.params.includes("RESERVA_SALUD%"));
  assert.equal(condicionModuloNotificacion("constructor"), null);
});
