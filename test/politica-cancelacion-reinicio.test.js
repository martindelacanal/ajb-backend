"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MIGRATION_ID, MIGRATION_LOCK, prepararReinicio, indicesUnicosVersion, ejecutarReinicio } = require("../scripts/reiniciar-historial-politicas-cancelacion");

test("el nombre del lock cumple el límite de 64 caracteres de MySQL", () => {
  assert.ok(MIGRATION_LOCK.length > 0 && MIGRATION_LOCK.length <= 64);
});

const hospedaje = [{ dias_desde: 0, dias_hasta: 6, porcentaje_reintegro: 0 },
  { dias_desde: 7, dias_hasta: 14, porcentaje_reintegro: 50 }, { dias_desde: 15, dias_hasta: null, porcentaje_reintegro: 100 }];
const convenio = [{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro: 0 }];

function estadoInicial() {
  return { tablas: {
    politica_cancelacion_vigente: [{ id: 1, politica_id: 2 }],
    politica_cancelacion_servicio_vigente: [{ servicio_id: 1, politica_id: 1 }, { servicio_id: 5, politica_id: 2 }],
    politica_cancelacion: [
      { id: 1, version: 1, titulo: "Hospedajes", reglas_json: JSON.stringify(hospedaje), creada_por: 8, creada_en: "2026-10-07 10:00:00" },
      { id: 2, version: 2, titulo: "Convenios", reglas_json: JSON.stringify(convenio), creada_por: 8, creada_en: "2026-10-08 10:00:00" },
    ],
    politica_cancelacion_servicio: [{ politica_id: 1, servicio_id: 1 }, { politica_id: 1, servicio_id: 5 }, { politica_id: 2, servicio_id: 5 }],
    politica_cancelacion_autoria_auditoria: [{ id: 1, politica_id: 1, accion: "CORRECCION_AUTORIA_INICIAL" }],
    reserva_politica_cancelacion: [{ reserva_id: 36, politica_id: 1, version: 1, snapshot_json: JSON.stringify({ id: 1, version: 1, reglas: hospedaje }) }],
    reserva_politica_cancelacion_historica: [],
    reserva_cancelacion_politica: [],
    politica_cancelacion_migracion: [{ id: "migracion_previa", detalle_json: "{}" }],
  }, reservasSinAceptacion: [{ reserva_id: 15, servicio_id: 1, politica_historica_id: 1, politica_reinicio_id: 1 }], tablaHistoricaExiste: false };
}

function conexion(estado, { backupPath, cambiarTrasDdl = false, fallarUpdate = false } = {}) {
  const consultas = [];
  let guardado;
  let indices = [{ Key_name: "PRIMARY", Non_unique: 0, Column_name: "id" },
    { Key_name: "uq_politica_cancelacion_version", Non_unique: 0, Column_name: "version" }];
  const db = {
    consultas,
    beginTransaction: async () => { consultas.push("BEGIN"); guardado = structuredClone(estado); },
    commit: async () => { consultas.push("COMMIT"); guardado = undefined; },
    rollback: async () => { consultas.push("ROLLBACK"); Object.assign(estado, guardado); guardado = undefined; },
    escapeId: nombre => `\`${nombre}\``,
    query: async (sql, params = []) => {
      consultas.push(sql);
      if (sql.includes("GET_LOCK")) return [[{ adquirido: 1 }]];
      if (sql.includes("RELEASE_LOCK")) return [[{ liberado: 1 }]];
      if (sql.includes("FROM information_schema.TABLES")) return [estado.tablaHistoricaExiste ? [{ TABLE_NAME: "reserva_politica_cancelacion_historica" }] : []];
      const tabla = sql.match(/^SELECT \* FROM (\w+) ORDER BY /)?.[1];
      if (tabla) return [structuredClone(estado.tablas[tabla])];
      if (sql.startsWith("SELECT r.id AS reserva_id")) return [structuredClone(estado.reservasSinAceptacion)];
      if (sql === "SHOW INDEX FROM politica_cancelacion") return [structuredClone(indices)];
      if (sql.startsWith("SELECT DATABASE")) return [[{ base_de_datos: "prueba" }]];
      assert.ok(fs.existsSync(backupPath), "Toda mutación debe tener una copia previa");
      if (sql.startsWith("ALTER TABLE")) {
        assert.ok(!guardado, "DDL no debe mezclarse con la transacción de datos");
        indices = [{ Key_name: "PRIMARY", Non_unique: 0, Column_name: "id" },
          { Key_name: "idx_politica_cancelacion_version", Non_unique: 1, Column_name: "version" },
          { Key_name: "idx_politica_cancelacion_version", Non_unique: 1, Column_name: "id" }];
        if (cambiarTrasDdl) estado.tablas.reserva_politica_cancelacion.push({ reserva_id: 40, politica_id: 2, version: 2, snapshot_json: "{}" });
      } else if (sql.startsWith("CREATE TABLE IF NOT EXISTS reserva_politica_cancelacion_historica")) {
        assert.ok(!guardado, "DDL no debe mezclarse con la transacción de datos");
        estado.tablaHistoricaExiste = true;
      } else if (sql.startsWith("INSERT INTO reserva_politica_cancelacion_historica")) {
        estado.tablas.reserva_politica_cancelacion_historica.push({ reserva_id: params[0], snapshot_json: params[1], registrada_en: "2026-10-15 12:00:00" });
      } else if (sql === "DELETE FROM politica_cancelacion_autoria_auditoria") {
        estado.tablas.politica_cancelacion_autoria_auditoria = [];
      } else if (sql.startsWith("DELETE ps FROM")) {
        estado.tablas.politica_cancelacion_servicio = estado.tablas.politica_cancelacion_servicio.filter(ps =>
          estado.tablas.politica_cancelacion_servicio_vigente.some(v => v.servicio_id === ps.servicio_id && v.politica_id === ps.politica_id));
      } else if (sql.startsWith("DELETE FROM politica_cancelacion WHERE")) {
        estado.tablas.politica_cancelacion = estado.tablas.politica_cancelacion.filter(p => params[0].includes(p.id));
      } else if (sql.startsWith("UPDATE politica_cancelacion SET")) {
        if (fallarUpdate) throw new Error("Fallo simulado de renumeración");
        for (const p of estado.tablas.politica_cancelacion) p.version = 1;
      } else if (sql.startsWith("INSERT INTO politica_cancelacion_migracion")) {
        estado.tablas.politica_cancelacion_migracion.push({ id: params[0], detalle_json: params[1] });
      } else assert.fail(`SQL inesperado: ${sql}`);
      return [{ affectedRows: 1 }];
    },
  };
  return db;
}

function rutaBackup(t) {
  const directorio = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-politicas-reset-"));
  t.after(() => fs.rmSync(directorio, { recursive: true, force: true }));
  return path.join(directorio, "backup.json");
}

test("check conserva distintas condiciones vigentes y no escribe ni abre transacciones", async () => {
  const estado = estadoInicial();
  const db = conexion(estado);
  const resultado = await ejecutarReinicio(db, { log() {} });
  assert.deepEqual(resultado.politicasConservadas, [{ id: 1, versionAnterior: 1, version: 1 }, { id: 2, versionAnterior: 2, version: 1 }]);
  assert.deepEqual(resultado.indicesUnicosAEliminar, ["uq_politica_cancelacion_version"]);
  assert.ok(db.consultas.every(sql => /^(SELECT|SHOW) /.test(sql)));
});

test("apply guarda backup, elimina asignaciones anteriores y conserva snapshots y contenido vigente", async t => {
  const estado = estadoInicial();
  estado.tablas.politica_cancelacion.push({ ...estado.tablas.politica_cancelacion[0], id: 3, version: 3 });
  const original = structuredClone(estado);
  const backupPath = rutaBackup(t);
  const db = conexion(estado, { backupPath });
  const resultado = await ejecutarReinicio(db, { checkOnly: false, backupPath, log() {} });
  assert.equal(resultado.aplicada, true);
  assert.deepEqual(resultado.politicasEliminadas, [3]);
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  assert.deepEqual(backup.tablas, original.tablas);
  assert.deepEqual(estado.tablas.politica_cancelacion, original.tablas.politica_cancelacion.slice(0, 2).map(p => ({ ...p, version: 1 })));
  assert.deepEqual(estado.tablas.politica_cancelacion_servicio, [{ politica_id: 1, servicio_id: 1 }, { politica_id: 2, servicio_id: 5 }]);
  assert.deepEqual(estado.tablas.politica_cancelacion_servicio_vigente, original.tablas.politica_cancelacion_servicio_vigente);
  assert.deepEqual(estado.tablas.politica_cancelacion_vigente, original.tablas.politica_cancelacion_vigente);
  assert.deepEqual(estado.tablas.reserva_politica_cancelacion, original.tablas.reserva_politica_cancelacion);
  assert.deepEqual(estado.tablas.reserva_cancelacion_politica, original.tablas.reserva_cancelacion_politica);
  assert.deepEqual(estado.tablas.politica_cancelacion_autoria_auditoria, []);
  assert.ok(estado.tablas.politica_cancelacion_migracion.some(m => m.id === MIGRATION_ID));
  assert.ok(!db.consultas.some(sql => /FOREIGN_KEY_CHECKS|TRUNCATE/.test(sql)));
});

test("no reinicia cuando la condición histórica depende de una política que se eliminaría", async t => {
  const estado = estadoInicial();
  estado.tablas.politica_cancelacion.push({ ...estado.tablas.politica_cancelacion[0], id: 3, version: 3 });
  estado.reservasSinAceptacion.push({ reserva_id: 99, servicio_id: 5, politica_historica_id: 3, politica_reinicio_id: 2 });
  const backupPath = rutaBackup(t);
  const db = conexion(estado, { backupPath });
  await assert.rejects(ejecutarReinicio(db, { checkOnly: false, backupPath, log() {} }), /cambiaría condiciones.*99/);
  assert.equal(fs.existsSync(backupPath), false);
  assert.ok(!db.consultas.some(sql => /^(DELETE|UPDATE|INSERT|ALTER)/.test(sql)));
  assert.ok(db.consultas.includes("ROLLBACK"));
});

test("congela el fallback de una reserva previa de convenio sin inventar una aceptación", async t => {
  const estado = estadoInicial();
  estado.reservasSinAceptacion.push({ reserva_id: 31, servicio_id: 5, politica_historica_id: 1, politica_reinicio_id: 2 });
  const aceptacionesAntes = structuredClone(estado.tablas.reserva_politica_cancelacion);
  const backupPath = rutaBackup(t);
  const db = conexion(estado, { backupPath });
  const resultado = await ejecutarReinicio(db, { checkOnly: false, backupPath, log() {} });
  assert.equal(resultado.reservasHistoricasACongelar.length, 1);
  const congelada = estado.tablas.reserva_politica_cancelacion_historica[0];
  assert.equal(congelada.reserva_id, 31);
  const snapshot = JSON.parse(congelada.snapshot_json);
  assert.equal(snapshot.id, 1);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.servicio_id, 5);
  assert.deepEqual(snapshot.reglas, hospedaje);
  assert.equal(snapshot.creada_en, "2026-10-07 10:00:00");
  assert.equal(snapshot.creada_por, 8);
  assert.deepEqual(estado.tablas.reserva_politica_cancelacion, aceptacionesAntes);
  assert.ok(!db.consultas.some(sql => /^INSERT INTO reserva_politica_cancelacion\s/.test(sql)));
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  assert.equal(backup.tablaHistoricaExiste, false);
  assert.deepEqual(backup.tablas.reserva_politica_cancelacion_historica, []);
});

test("conserva snapshots históricos existentes sin regenerarlos", async t => {
  const estado = estadoInicial();
  estado.tablaHistoricaExiste = true;
  estado.reservasSinAceptacion.push({ reserva_id: 31, servicio_id: 5, politica_historica_id: 1, politica_reinicio_id: 2 });
  estado.tablas.reserva_politica_cancelacion_historica.push({ reserva_id: 31,
    snapshot_json: JSON.stringify({ id: 1, version: 1, servicio_id: 5, reglas: hospedaje }), registrada_en: "2026-10-14 12:00:00" });
  const originales = structuredClone(estado.tablas.reserva_politica_cancelacion_historica);
  const backupPath = rutaBackup(t);
  const resultado = await ejecutarReinicio(conexion(estado, { backupPath }), { checkOnly: false, backupPath, log() {} });
  assert.equal(resultado.reservasHistoricasACongelar.length, 0);
  assert.equal(resultado.reservasHistoricasConservadas, 1);
  assert.deepEqual(estado.tablas.reserva_politica_cancelacion_historica, originales);
});

test("rechaza referencias aceptadas o canceladas a políticas que se eliminarían", () => {
  for (const tabla of ["reserva_politica_cancelacion", "reserva_cancelacion_politica"]) {
    const estado = estadoInicial();
    estado.tablas.politica_cancelacion.push({ ...estado.tablas.politica_cancelacion[0], id: 3, version: 3 });
    estado.tablas[tabla].push({ reserva_id: 99, politica_id: 3, version: 3 });
    assert.throws(() => prepararReinicio(estado), /referencia políticas que serían eliminadas/);
  }
});

test("un snapshot aceptado sobre vigente mantiene su versión original al renumerar", async t => {
  const estado = estadoInicial();
  const aceptacion = { reserva_id: 88, politica_id: 2, version: 2, snapshot_json: JSON.stringify({ id: 2, version: 2, reglas: convenio }) };
  estado.tablas.reserva_politica_cancelacion.push(aceptacion);
  const backupPath = rutaBackup(t);
  await ejecutarReinicio(conexion(estado, { backupPath }), { checkOnly: false, backupPath, log() {} });
  assert.deepEqual(estado.tablas.reserva_politica_cancelacion.at(-1), aceptacion);
  assert.equal(estado.tablas.politica_cancelacion[1].version, 1);
});

test("se detiene si hay actividad entre backup y cambio de índice", async t => {
  const estado = estadoInicial();
  const backupPath = rutaBackup(t);
  const db = conexion(estado, { backupPath, cambiarTrasDdl: true });
  await assert.rejects(ejecutarReinicio(db, { checkOnly: false, backupPath, log() {} }), /Hubo actividad/);
  assert.ok(!db.consultas.some(sql => /^(DELETE|UPDATE|INSERT)/.test(sql)));
  assert.equal(estado.tablas.politica_cancelacion[1].version, 2);
  assert.equal(estado.tablas.reserva_politica_cancelacion.length, 2);
});

test("un fallo de renumeración revierte todos los cambios de datos", async t => {
  const estado = estadoInicial();
  const original = structuredClone(estado);
  const backupPath = rutaBackup(t);
  await assert.rejects(ejecutarReinicio(conexion(estado, { backupPath, fallarUpdate: true }),
    { checkOnly: false, backupPath, log() {} }), /Fallo simulado/);
  assert.deepEqual(estado.tablas, original.tablas);
  assert.deepEqual(estado.reservasSinAceptacion, original.reservasSinAceptacion);
  assert.equal(estado.tablaHistoricaExiste, true, "La creación de tabla no revierte con DML");
  assert.ok(fs.existsSync(backupPath));
});

test("la marca idempotente protege publicaciones posteriores y no sobrescribe backup", async t => {
  const estado = estadoInicial();
  const backupPath = rutaBackup(t);
  const db = conexion(estado, { backupPath });
  await ejecutarReinicio(db, { checkOnly: false, backupPath, log() {} });
  estado.tablas.politica_cancelacion[1].version = 5;
  const original = structuredClone(estado);
  const backupAntes = fs.readFileSync(backupPath, "utf8");
  const resultado = await ejecutarReinicio(db, { checkOnly: false, backupPath, log() {} });
  assert.equal(resultado.yaAplicada, true);
  assert.deepEqual(estado, original);
  assert.equal(fs.readFileSync(backupPath, "utf8"), backupAntes);
});

test("un archivo backup existente impide cualquier DDL o mutación", async t => {
  const estado = estadoInicial();
  const backupPath = rutaBackup(t);
  fs.writeFileSync(backupPath, "conservar");
  const db = conexion(estado, { backupPath });
  await assert.rejects(ejecutarReinicio(db, { checkOnly: false, backupPath, log() {} }), { code: "EEXIST" });
  assert.equal(fs.readFileSync(backupPath, "utf8"), "conservar");
  assert.ok(!db.consultas.some(sql => /^(ALTER|DELETE|UPDATE|INSERT)/.test(sql)));
});

test("sólo elimina índices únicos de version, no la PK ni compuestos", () => {
  assert.deepEqual(indicesUnicosVersion([
    { Key_name: "PRIMARY", Non_unique: 0, Column_name: "id" },
    { Key_name: "uq_version", Non_unique: 0, Column_name: "version" },
    { Key_name: "uq_compuesto", Non_unique: 0, Column_name: "version" },
    { Key_name: "uq_compuesto", Non_unique: 0, Column_name: "id" },
  ]), ["uq_version"]);
});
