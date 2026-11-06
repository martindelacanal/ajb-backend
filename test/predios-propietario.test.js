"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { identidad, exigirPropietario, saludarPredio, tomarControl } = require("../api/services/predios-propietario");
const equipoA = "a".repeat(64);
const equipoB = "b".repeat(64);

function escenario(t, { escritor = "CENTRAL", instancia = null, equipo = null } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE predio (id INTEGER PRIMARY KEY, escritor TEXT, instancia_id TEXT, equipo_id TEXT,
    equipo TEXT, ultima_conexion TEXT, version_local TEXT, pendientes_local INTEGER, ultima_escritura_central TEXT);
    CREATE TABLE predio_evento (id INTEGER PRIMARY KEY, predio_id INTEGER, tipo TEXT, detalle TEXT);`);
  db.prepare("INSERT INTO predio(id,escritor,instancia_id,equipo_id,equipo) VALUES (1,?,?,?,'Servidor original')").run(escritor, instancia, equipo);
  let cola = Promise.resolve();
  const pool = { async getConnection() {
    let liberar;
    const anterior = cola;
    cola = new Promise(r => { liberar = r; });
    return {
      async beginTransaction() { await anterior; db.exec("BEGIN IMMEDIATE"); },
      async query(sql, params = []) {
        const portable = sql.replace(/ FOR UPDATE$/, "").replace(/NOW\(\)/g, "datetime('now')");
        const s = db.prepare(portable);
        return /^SELECT/i.test(sql) ? [s.all(...params)] : [s.run(...params)];
      },
      async commit() { db.exec("COMMIT"); },
      async rollback() { db.exec("ROLLBACK"); },
      release() { liberar(); },
    };
  } };
  return { pool, fila: () => ({ ...db.prepare("SELECT * FROM predio WHERE id=1").get() }) };
}

test("dos instalaciones que piden control simultáneo sólo habilitan un servidor", async t => {
  const { pool, fila } = escenario(t);
  const resultados = await Promise.allSettled([
    tomarControl(pool, 1, { instancia_id: "servidor-a", equipo_id: equipoA }),
    tomarControl(pool, 1, { instancia_id: "servidor-b", equipo_id: equipoB }),
  ]);
  assert.equal(resultados.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(resultados.find(r => r.status === "rejected").reason.codigo, "OTRA_INSTALACION");
  assert.equal(fila().instancia_id, "servidor-a");
  assert.equal(fila().equipo_id, equipoA);
});

test("la instalación existente se vincula al equipo y una copia no sobrescribe su estado", async t => {
  const { pool, fila } = escenario(t, { escritor: "LOCAL", instancia: "servidor-a" });
  await assert.rejects(saludarPredio(pool, 1, { instancia_id: "servidor-a", equipo_id: equipoB, equipo: "Copia" }), { codigo: "OTRO_EQUIPO" });
  const saludo = await saludarPredio(pool, 1, { instancia_id: "servidor-a", equipo_id: equipoA, equipo: "Servidor original", version: "nueva" });
  assert.equal(saludo.autoriza_escritura, true);
  assert.equal(fila().equipo_id, equipoA);
  await assert.rejects(saludarPredio(pool, 1, { instancia_id: "servidor-a", equipo_id: equipoB, equipo: "Copia", version: "incorrecta" }), { codigo: "OTRO_EQUIPO" });
  assert.equal(fila().equipo, "Servidor original");
  assert.equal(fila().version_local, "nueva");
  await assert.rejects(tomarControl(pool, 1, { instancia_id: "servidor-b", equipo_id: equipoB }), { codigo: "OTRA_INSTALACION" });
});

test("una instalación vacía no toma otro servidor; el instalador previo puede activarse y actualizarse sin robar control", async t => {
  const { pool } = escenario(t, { escritor: "LOCAL", instancia: "servidor-a", equipo: equipoA });
  await assert.rejects(saludarPredio(pool, 1, { instancia_id: "servidor-b", equipo_id: equipoB, vacia: true, bootstrap: "instalador" }), { codigo: "OTRA_INSTALACION" });
  const nuevo = escenario(t);
  await tomarControl(nuevo.pool, 1, { instancia_id: "servidor-b" });
  assert.equal(nuevo.fila().escritor, "LOCAL");
  assert.equal(nuevo.fila().equipo_id, null);
  await assert.rejects(tomarControl(nuevo.pool, 1, { instancia_id: "servidor-c" }), { codigo: "OTRA_INSTALACION" });
  await saludarPredio(nuevo.pool, 1, { instancia_id: "servidor-b", equipo_id: equipoB, equipo: "Servidor original" });
  assert.equal(nuevo.fila().equipo_id, equipoB);
});

test("validación de push rechaza escritor central, falta de equipo vinculado e identificadores inválidos", () => {
  assert.throws(() => identidad({ instancia_id: "a", equipo_id: "no-es-hash" }), { status: 400 });
  assert.throws(() => exigirPropietario({ escritor: "CENTRAL" }, { instancia_id: "a" }, { exigirLocal: true }), { codigo: "SIN_CONTROL" });
  assert.throws(() => exigirPropietario({ escritor: "LOCAL", instancia_id: "a", equipo_id: equipoA }, { instancia_id: "a" }), { codigo: "OTRO_EQUIPO" });
  assert.equal(exigirPropietario({ escritor: "LOCAL", instancia_id: "a" }, { instancia_id: "a" }).equipo_id, null);
});
