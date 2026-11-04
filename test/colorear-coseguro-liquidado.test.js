"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ESTADO_LIQUIDADO, colorear } = require("../scripts/colorear-coseguro-liquidado");

function conexionFalsa(fila) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql, params });
      if (sql.startsWith("SELECT")) return [fila ? [{ ...fila }] : []];
      if (sql.startsWith("UPDATE")) return [{ affectedRows: 1 }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
}

const updates = (conexion) => conexion.consultas.filter(({ sql }) => sql.startsWith("UPDATE"));

test("«Liquidado» pasa del gris al verde de los finales felices", async () => {
  const conexion = conexionFalsa({ id: 10, nombre: "Liquidado", color: "#E5E7EB", color_texto: "#374151" });

  const resultado = await colorear(conexion);

  assert.equal(resultado.aplicado, true);
  assert.deepEqual(updates(conexion)[0].params, ["#D1FAE5", "#047857", 10, "Liquidado"]);
  assert.deepEqual({ ...ESTADO_LIQUIDADO }, { id: 10, nombre: "Liquidado", color: "#D1FAE5", color_texto: "#047857" });
});

test("es idempotente: con el verde (aunque en minúsculas) no escribe nada", async () => {
  const conexion = conexionFalsa({ id: 10, nombre: "Liquidado", color: "#d1fae5", color_texto: "#047857" });

  const resultado = await colorear(conexion);

  assert.equal(resultado.cambio, false);
  assert.equal(updates(conexion).length, 0);
});

test("--check informa sin escribir", async () => {
  const conexion = conexionFalsa({ id: 10, nombre: "Liquidado", color: "#E5E7EB", color_texto: "#374151" });

  const resultado = await colorear(conexion, { checkOnly: true });

  assert.equal(resultado.cambio, true);
  assert.equal(resultado.aplicado, false);
  assert.equal(updates(conexion).length, 0);
});

test("frena si el id 10 no es «Liquidado» o no existe", async () => {
  await assert.rejects(colorear(conexionFalsa({ id: 10, nombre: "Otro estado", color: "#E5E7EB", color_texto: "#374151" })), /no se toca/);
  await assert.rejects(colorear(conexionFalsa(null)), /No existe/);
});
