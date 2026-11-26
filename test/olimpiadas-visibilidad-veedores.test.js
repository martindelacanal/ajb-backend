"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { migrar } = require("../scripts/migrar-olimpiadas-visibilidad-veedores");
const { filtrarVeedoresManuales } = require("../api/services/olimpiadas-visibilidad-veedores");

test("el texto manual del portal retira nombres ocultos aun con notas, puntuación o apellido primero", async () => {
  const db = { query: async () => [[{ nombre: "Ana López", nombre_vinculado: "Ana María López" }]] };
  const disciplinas = ["Responsable: Ana María López (turno tarde) / Raúl Peña", "Peña, Raúl y López, Ana", "Ana López", "Raúl Peña"];
  const lista = await filtrarVeedoresManuales(db, disciplinas.map(veedor => ({ veedor })));
  assert.deepEqual(lista.map(d => d.veedor), ["Raúl Peña", "Peña, Raúl", null, "Raúl Peña"]);
});

test("la migración identifica al veedor asignado entre homónimos, rechaza ambigüedades y tolera reintentos", async () => {
  const cuentas = [
    { id: 6, nombre: "Nahuel Staffa", visible_publico: 1 },
    { id: 7, nombre: "Staffa, NAHUEL", visible_publico: 1 },
    { id: 8, nombre: "Cuenta vinculada", nombre_vinculado: "Lucas PróFeta", visible_publico: 1 },
  ];
  const asignaciones = [{ voluntario_id: 7 }, { voluntario_id: 8 }];
  let esquema = false;
  const historial = [];
  const db = {
    beginTransaction() {}, commit() {}, rollback() {},
    async query(sql, params) {
      if (sql.includes("information_schema.COLUMNS")) return [esquema ? [{ tipo: "tinyint", anulable: "NO", defecto: 1 }] : []];
      if (sql.startsWith("SELECT id FROM olimpiada WHERE")) return [[{ id: 2 }]];
      if (sql.includes("FROM olimpiada_voluntario v")) return [cuentas];
      if (sql.includes("FROM olimpiada_voluntario_disciplina WHERE")) return [asignaciones];
      if (sql.startsWith("ALTER TABLE")) esquema = true;
      else if (sql.startsWith("UPDATE olimpiada_voluntario SET visible_publico = 0")) cuentas.find(v => v.id === params[0]).visible_publico = 0;
      else if (sql.startsWith("INSERT INTO olimpiada_historial")) historial.push(params[0]);
      else assert.fail(sql);
      return [{}];
    },
  };
  const operar = apply => migrar(db, { apply, ocultarMiramar: true });
  const plan = await operar(false);
  assert.deepEqual(plan.cuentas.map(c => c.id), [7, 8]);
  assert.deepEqual([esquema, ...cuentas.map(v => v.visible_publico)], [false, 1, 1, 1]);
  asignaciones.push({ voluntario_id: 6 });
  await assert.rejects(operar(true), /Nahuel Staffa/);
  assert.equal(esquema, false);
  asignaciones.pop();
  await operar(true);
  await operar(true);
  assert.deepEqual([esquema, ...cuentas.map(v => v.visible_publico)], [true, 1, 0, 0]);
  assert.deepEqual(historial, [7, 8]);
});
