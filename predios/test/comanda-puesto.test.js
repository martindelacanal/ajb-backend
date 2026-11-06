"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const api = require("../lib/api");

async function escenario(t) {
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, rol: "ADMIN", nombre: "Admin", bocas: [] }, sesion: {} };
  await db.tx(async tx => {
    await sembrarPredio(tx, ctx, "MIRAMAR");
    await N.insertar(tx, ctx, "predio_usuario", { usuario: "admin", nombre: "Admin", rol: "ADMIN", activo: 1 });
  });
  const cajas = await db.all("SELECT * FROM predio_caja ORDER BY id LIMIT 2");
  const llamar = (c, m, ruta, body = {}) => api.ejecutar({ ...c, body }, m, ruta);
  return { db, ctx, cajas, llamar };
}

test("la comanda se conserva por caja y sólo su operador o un administrador pueden cambiarla", async t => {
  const { db, ctx, cajas, llamar } = await escenario(t);
  const [a, b] = cajas;
  const cajero = { ...ctx, usuario: { id: 2, rol: "CAJERO", nombre: "Caja", bocas: [a.boca_id] }, sesion: { boca_id: a.boca_id, caja_id: a.id } };
  await llamar(cajero, "POST", `/cajas/${a.id}/comanda`, { imprimir_comanda: true });
  assert.equal((await db.get("SELECT imprimir_comanda FROM predio_caja WHERE id=?", [a.id])).imprimir_comanda, 1);
  assert.equal(Number((await db.get("SELECT imprimir_comanda FROM predio_caja WHERE id=?", [b.id])).imprimir_comanda || 0), 0);
  await assert.rejects(llamar(cajero, "POST", `/cajas/${b.id}/comanda`, { imprimir_comanda: true }), { status: 403 });
  await assert.rejects(llamar(cajero, "POST", `/cajas/${a.id}/comanda`, { imprimir_comanda: "false" }), { status: 400 });
  const respuesta = await llamar(ctx, "POST", `/cajas/${a.id}/comanda`, { imprimir_comanda: false });
  assert.equal(respuesta.imprimir_comanda, false);
});

test("salir de caja cierra sólo el turno propio y conserva sesión sin caja ni movimientos de dinero", async t => {
  const { db, ctx, cajas, llamar } = await escenario(t);
  const caja = cajas[0];
  const turno = await db.tx(tx => N.insertar(tx, ctx, "predio_turno", { usuario_id: 1, caja_id: caja.id, boca_id: caja.boca_id, inicio: "2026-11-05 09:00:00", estado: "ABIERTO" }));
  await db.run("INSERT INTO predio_sesion(token_hash,usuario_id,creada,boca_id,caja_id,turno_id) VALUES ('sesion',1,'2026-11-05',?,?,?)", [caja.boca_id, caja.id, turno]);
  const respuesta = await llamar({ ...ctx, sesion: { token_hash: "sesion", boca_id: caja.boca_id, caja_id: caja.id, turno_id: turno } }, "POST", "/sesion/salir-puesto");
  assert.equal(respuesta.puesto, null);
  assert.equal(respuesta.usuario.id, 1);
  assert.equal((await db.get("SELECT estado FROM predio_turno WHERE id=?", [turno])).estado, "CERRADO");
  const sesion = await db.get("SELECT * FROM predio_sesion WHERE token_hash='sesion'");
  assert.equal(sesion.caja_id, null); assert.equal(sesion.boca_id, null); assert.equal(sesion.turno_id, null);
  assert.equal((await db.get("SELECT COUNT(*) n FROM predio_caja_movimiento")).n, 0);
  assert.equal((await llamar(ctx, "GET", "/sesion")).puesto, null);
});

test("administrar otra caja conserva el turno del puesto y separa los movimientos de cada caja", async t => {
  const { db, ctx, cajas: [propia, otra], llamar } = await escenario(t);
  const turno = await N.insertar(db, ctx, "predio_turno", {
    usuario_id: 1, caja_id: propia.id, boca_id: propia.boca_id, inicio: "2026-11-05 09:00:00", estado: "ABIERTO",
  });
  const admin = { ...ctx, sesion: { caja_id: propia.id, boca_id: propia.boca_id, turno_id: turno } };
  await llamar(admin, "POST", "/caja/apertura", { caja_id: propia.id, importe: 100 });
  await llamar(admin, "POST", "/caja/apertura", { caja_id: otra.id, importe: 200 });
  const detalle = await llamar({ ...admin, query: { caja_id: otra.id } }, "GET", "/caja/estado");
  assert.equal(detalle.caja.id, otra.id);
  assert.equal(detalle.apertura.importe, 200);
  assert.equal(detalle.turno, null);

  const venta = await N.insertar(db, ctx, "predio_venta", {
    boca_id: otra.boca_id, caja_id: otra.id, fecha: "2026-11-05 10:00:00", forma_pago: "EFECTIVO", estado: "CONFIRMADA", total: 10,
  });
  await llamar(admin, "POST", `/ventas/${venta}/anular`, { motivo: "Error de carga" });
  await llamar(admin, "POST", "/caja/cierre", { caja_id: otra.id, efectivo_contado: 185, queda_en_caja: 40 });
  const movimientos = await db.all("SELECT caja_id, turno_id FROM predio_caja_movimiento WHERE caja_id = ?", [otra.id]);
  assert.equal(movimientos.length, 4);
  assert.ok(movimientos.every(m => m.turno_id === null));
  const listado = await llamar({ ...admin, query: { f_caja: otra.id } }, "GET", "/listados/caja");
  assert.equal(listado.total, 4);
  const cierres = await llamar({ ...admin, query: { f_caja: otra.id } }, "GET", "/listados/cierres");
  assert.equal(cierres.filas[0].saldo, 40, "el saldo es el efectivo que quedó, después del retiro");
  assert.equal(cierres.filas[0].efectivo_contado, 185);
  assert.equal(cierres.filas[0].retiro, 145);
  const metaCierres = await llamar(admin, "GET", "/listados/cierres/meta");
  assert.equal(metaCierres.columnas[0].titulo, "ID");
  assert.equal(metaCierres.columnas.find(c => c.clave === "saldo").titulo, "Saldo");
  assert.equal((await llamar(admin, "GET", "/caja/estado")).resumen.saldo_esperado, 100);
  assert.deepEqual(await db.all("SELECT id, estado FROM predio_turno"), [{ id: turno, estado: "ABIERTO" }]);
});
