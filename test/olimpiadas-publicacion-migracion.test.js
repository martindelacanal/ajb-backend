"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CHECKSUM, consultarPlan, aplicarMigracion } = require("../scripts/migrar-olimpiadas-publicacion");

function basePrueba() {
  const estado = {
    default: "0", registro: null, historial: [], consultas: [], respaldo: null,
    ediciones: [
      { id: 1, nombre: "Olimpiadas 2026", edicion: "Demo", fecha_fin: "2026-09-26", habilitado: "Y", eliminado: 0, publicada_publico: 0 },
      { id: 2, nombre: "Próxima edición", fecha_fin: "2027-10-10", habilitado: "Y", eliminado: 0, publicada_publico: 0 },
      { id: 3, nombre: "Deshabilitada", habilitado: "N", eliminado: 0, publicada_publico: 0 },
      { id: 4, nombre: "Eliminada", habilitado: "Y", eliminado: 1, publicada_publico: 0 },
      { id: 5, nombre: "Ya publicada", habilitado: "Y", eliminado: 0, publicada_publico: 1 },
    ],
  };
  let guardado;
  const db = {
    async beginTransaction() { guardado = structuredClone({ ediciones: estado.ediciones, historial: estado.historial, registro: estado.registro }); },
    async commit() { guardado = null; },
    async rollback() { Object.assign(estado, guardado); guardado = null; estado.rollback = true; },
    async query(sql, params = []) {
      estado.consultas.push(sql);
      if (/GET_LOCK/.test(sql)) return [[{ tomado: 1 }]];
      if (/RELEASE_LOCK/.test(sql)) return [[{ liberado: 1 }]];
      if (/information_schema.COLUMNS/.test(sql)) return [[{ COLUMN_DEFAULT: estado.default }]];
      if (/information_schema.TABLES/.test(sql)) return [[{ existe: 1 }]];
      if (/SELECT estado, checksum FROM ajb_schema_migration/.test(sql)) return [estado.registro ? [estado.registro] : []];
      if (/CREATE TABLE/.test(sql)) return [{ affectedRows: 0 }];
      if (/ALTER TABLE olimpiada/.test(sql)) { estado.default = "1"; return [{ affectedRows: 0 }]; }
      if (/FROM olimpiada WHERE/.test(sql)) {
        assert.match(sql, /eliminado = 0 AND habilitado = 'Y' AND publicada_publico = 0/);
        return [structuredClone(estado.ediciones.filter(e => !e.eliminado && e.habilitado === "Y" && e.publicada_publico === 0))];
      }
      if (/UPDATE olimpiada SET/.test(sql)) {
        assert.ok(estado.respaldo, "El respaldo debe existir antes de publicar");
        estado.ediciones.find(e => e.id === params[0]).publicada_publico = 1;
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO olimpiada_historial/.test(sql)) {
        if (estado.fallarAuditoria) throw new Error("Falló la auditoría");
        estado.historial.push(params);
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO ajb_schema_migration/.test(sql)) {
        estado.registro = { estado: "APLICADA", checksum: params[1] };
        return [{ affectedRows: 1 }];
      }
      assert.fail(`Consulta no prevista: ${sql}`);
    },
  };
  return { db, estado, respaldar: async datos => { estado.respaldo = structuredClone(datos); return "/respaldo.json"; } };
}

test("publicación: check informa las ediciones habilitadas ocultas sin modificar nada", async () => {
  const { db, estado } = basePrueba();
  const plan = await consultarPlan(db);
  assert.deepEqual(plan.ediciones_a_publicar.map(e => e.id), [1, 2]);
  assert.equal(plan.cambiar_default, true);
  assert.ok(estado.consultas.every(sql => sql.startsWith("SELECT")));
  assert.equal(estado.default, "0");
  assert.equal(estado.registro, null);
});

test("publicación: aplica a pasadas y próximas, respalda y audita, y respeta posteriores ocultamientos", async () => {
  const { db, estado, respaldar } = basePrueba();
  const resultado = await aplicarMigracion(db, { respaldar });
  assert.deepEqual(resultado.publicadas, [1, 2]);
  assert.deepEqual(estado.ediciones.map(e => e.publicada_publico), [1, 1, 0, 0, 1]);
  assert.equal(estado.default, "1");
  assert.deepEqual(estado.respaldo.ediciones.map(e => e.publicada_publico), [0, 0]);
  assert.deepEqual(estado.historial.map(h => h[0]), [1, 2]);
  assert.deepEqual(estado.registro, { estado: "APLICADA", checksum: CHECKSUM });
  estado.ediciones[0].publicada_publico = 0;
  const segunda = await aplicarMigracion(db);
  assert.deepEqual(segunda.publicadas, []);
  assert.equal(estado.ediciones[0].publicada_publico, 0);
  assert.equal(estado.historial.length, 2);
  assert.deepEqual((await consultarPlan(db)).ediciones_a_publicar, []);
});

test("publicación: un fallo revierte publicaciones, auditoría y registro; permite reintentar", async () => {
  const { db, estado, respaldar } = basePrueba();
  estado.fallarAuditoria = true;
  await assert.rejects(aplicarMigracion(db, { respaldar }), /Falló la auditoría/);
  assert.equal(estado.rollback, true);
  assert.deepEqual(estado.ediciones.map(e => e.publicada_publico), [0, 0, 0, 0, 1]);
  assert.equal(estado.registro, null);
  assert.equal(estado.historial.length, 0);
  estado.fallarAuditoria = false;
  assert.deepEqual((await aplicarMigracion(db, { respaldar })).publicadas, [1, 2]);
});

test("publicación: rechaza aplicar sin respaldo o con un registro incompatible", async () => {
  const { db, estado } = basePrueba();
  await assert.rejects(aplicarMigracion(db), /respaldo/);
  assert.equal(estado.default, "0");
  estado.registro = { estado: "APLICADA", checksum: "otro" };
  await assert.rejects(consultarPlan(db), /checksum diferente/);
});
