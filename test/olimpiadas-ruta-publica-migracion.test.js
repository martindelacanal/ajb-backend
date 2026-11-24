"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { migrar } = require("../scripts/migrar-olimpiadas-ruta-publica");
const { INDICE_RUTA, esRutaDuplicada } = require("../api/services/olimpiadas-ruta-publica");

function base() {
  return {
    esquema: false, ruta: null, auditorias: 0, transaccion: false,
    beginTransaction() { this.transaccion = true; },
    commit() { this.transaccion = false; },
    rollback() { this.transaccion = false; },
    async query(sql, params = []) {
      if (sql.includes("information_schema.COLUMNS")) return [this.esquema ? [{ tipo: "varchar(80)", anulable: "YES", colacion: "ascii_bin" }] : []];
      if (sql.includes("information_schema.STATISTICS")) return [this.esquema ? [{ columna: "ruta_publica", noUnico: 0, prefijo: null }] : []];
      if (sql.startsWith("ALTER TABLE")) {
        assert.match(sql, /ADD COLUMN ruta_publica VARCHAR\(80\).* NULL, ADD UNIQUE KEY uq_olimpiada_ruta_publica \(ruta_publica\)/);
        this.esquema = true;
      } else if (sql.includes("WHERE id = 2 AND fecha_inicio")) {
        return [[{ id: 2, ruta_publica: this.ruta }]];
      } else if (sql.includes("id <> 2")) {
        return [[]];
      } else if (sql.startsWith("UPDATE olimpiada SET ruta_publica")) {
        assert.equal(this.transaccion, true);
        assert.deepEqual(params, ["olimpiadas2026", 2]);
        this.ruta = params[0];
      } else if (sql.startsWith("INSERT INTO olimpiada_historial")) {
        assert.equal(this.transaccion, true);
        this.auditorias++;
      } else {
        assert.fail(sql);
      }
      return [{}];
    },
  };
}

test("la migración permite planificar antes de asignar Miramar y repetir sin duplicar el historial", async () => {
  const db = base();
  const check = await migrar(db, { apply: false, asignarMiramar: true });
  assert.equal(check.cambios.length, 2);
  assert.equal(db.esquema, false);
  assert.equal(db.ruta, null);
  await migrar(db, { apply: true, asignarMiramar: false });
  assert.equal(db.ruta, null);
  for (let i = 0; i < 2; i++) {
    const resultado = await migrar(db, { apply: true, asignarMiramar: true });
    assert.deepEqual(resultado.cambios, []);
    assert.equal(resultado.edicion.ruta_publica, "olimpiadas2026");
  }
  assert.equal(db.auditorias, 1);
  db.ruta = "cambiada-por-el-admin";
  await assert.rejects(migrar(db, { apply: true, asignarMiramar: true }), /ya tiene otra ruta/);
  assert.equal(db.ruta, "cambiada-por-el-admin");
});

test("sólo la colisión del índice de rutas se traduce a ruta ocupada", () => {
  const duplicado = key => ({ code: "ER_DUP_ENTRY", sqlMessage: `Duplicate entry 'x' for key '${key}'` });
  assert.equal(esRutaDuplicada(duplicado(INDICE_RUTA)), true);
  assert.equal(esRutaDuplicada(duplicado("olimpiada." + INDICE_RUTA)), true);
  assert.equal(esRutaDuplicada(duplicado("otro_indice")), false);
});
