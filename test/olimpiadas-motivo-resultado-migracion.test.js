"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { migrar } = require("../scripts/migrar-olimpiadas-motivo-resultado");

test("el motivo del resultado agrega sólo una columna nullable y la migración se puede repetir", async () => {
  let columna;
  let cambios = 0;
  const db = { async query(sql) {
    if (sql.includes("information_schema.COLUMNS")) return [columna ? [columna] : []];
    assert.match(sql, /^ALTER TABLE olimpiada_partido ADD COLUMN motivo_resultado VARCHAR\(300\) NULL /);
    cambios++;
    columna = { tipo: "varchar", maximo: 300, anulable: "YES", defecto: null };
  } };
  assert.deepEqual(await migrar(db), { agregarColumna: true });
  assert.equal(cambios, 0);
  assert.deepEqual(await migrar(db, true), { agregarColumna: true });
  assert.deepEqual(await migrar(db, true), { agregarColumna: false });
  assert.equal(cambios, 1);
  columna.anulable = "NO";
  await assert.rejects(migrar(db, true), /difiere de la esperada/);
  assert.equal(cambios, 1);
});
