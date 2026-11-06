"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const N = require("../lib/negocio");
const U = require("../lib/util");
const api = require("../lib/api");
const { revisarStockMinimo } = require("../lib/stock-minimo");

async function preparar(t, archivo = ":memory:") {
  const db = crearSqlite(archivo, { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, nombre: "Admin", rol: "ADMIN", bocas: [] }, sesion: {} };
  await db.tx(async (tr) => {
    for (const [usuario, rol, activo] of [["admin", "ADMIN", 1], ["boca-a", "CAJERO", 1], ["boca-b", "CAJERO", 1], ["inactivo", "CAJERO", 0], ["turno", "CAJERO", 1]]) {
      await N.insertar(tr, ctx, "predio_usuario", { usuario, nombre: usuario, rol, activo });
    }
    for (const nombre of ["Boca A", "Boca B"]) await N.insertar(tr, ctx, "predio_boca", { nombre, activo: 1, es_origen: 1, es_destino: 1 });
    await N.insertar(tr, ctx, "predio_caja", { boca_id: 1, nombre: "Caja A", activo: 1 });
    for (const [usuario_id, boca_id] of [[2, 1], [3, 2], [4, 1]]) await N.insertar(tr, ctx, "predio_usuario_boca", { usuario_id, boca_id });
    await N.insertar(tr, ctx, "predio_turno", { caja_id: 1, boca_id: 1, usuario_id: 5, usuario_nombre: "turno", inicio: U.fechaHora(), estado: "ABIERTO" });
  });
  const llamar = (metodo, ruta, body = {}, actor = ctx) => api.ejecutar({ ...actor, body, query: {} }, metodo, ruta);
  const crear = (extra = {}) => llamar("POST", "/productos", { nombre: "Agua", precio_compra: 100, margen: 50, stock_minimo: 5, ...extra });
  const mover = (productoId, cantidad, bocaId = 1, tipo = "AJUSTE") => db.tx((tr) => N.moverStock(tr, ctx, { bocaId, productoId, cantidad, tipo }));
  const usuario = (id, bocaId) => ({ ...ctx, usuario: { id, rol: "CAJERO", nombre: "Usuario", bocas: [bocaId] }, sesion: { boca_id: bocaId, caja_id: bocaId === 1 ? 1 : null } });
  const avisos = () => db.all("SELECT * FROM predio_aviso WHERE tipo = 'STOCK_MINIMO' ORDER BY id");
  return { db, ctx, llamar, crear, mover, usuario, avisos };
}

test("al quedar bajo mínimo avisa al admin y usuarios de esa boca, sin revelar otras bocas ni costos", async (t) => {
  const { llamar, crear, mover, usuario, avisos, db } = await preparar(t);
  const p = await crear();
  await mover(p.id, 5);
  assert.equal((await avisos()).length, 0, "en el mínimo exacto no se alerta");
  await mover(p.id, -1, 1, "VENTA");
  const filas = await avisos();
  assert.deepEqual(filas.map((a) => a.usuario_id), [null, 2, 5]);
  assert.match(filas[0].mensaje, /Boca A: quedan 4.*mínimo de 5/);
  assert.equal(JSON.parse(filas[0].detalle).boca_id, 1);
  assert.ok(!JSON.stringify(filas).includes("precio_compra"));
  const deBocaA = await llamar("GET", "/avisos", {}, usuario(2, 1));
  const deBocaB = await llamar("GET", "/avisos", {}, usuario(3, 2));
  assert.equal(deBocaA.notificaciones_no_leidas, 1);
  assert.equal(deBocaB.notificaciones_no_leidas, 0);
  await assert.rejects(llamar("POST", `/avisos/${filas[1].id}/leer`, {}, usuario(3, 2)), { status: 404 });
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_outbox WHERE tabla = 'predio_aviso'")).n, 3);
});

test("ventas, consultas repetidas y lectura no repiten el episodio; reponer lo resuelve y otra caída vuelve a avisar", async (t) => {
  const { ctx, db, crear, mover, llamar, avisos, usuario } = await preparar(t);
  const p = await crear();
  await mover(p.id, 6);
  await mover(p.id, -2, 1, "VENTA");
  const primeros = await avisos();
  await llamar("POST", `/avisos/${primeros[1].id}/leer`, {}, usuario(2, 1));
  await Promise.all([mover(p.id, -1, 1, "VENTA"), mover(p.id, -1, 1, "VENTA")]);
  for (let i = 0; i < 3; i++) await revisarStockMinimo(db, ctx, { forzar: true });
  assert.equal((await avisos()).length, 3);
  await mover(p.id, 3, 1, "TRASPASO_ENTRADA");
  assert.ok((await avisos()).every((a) => a.resuelto_fecha));
  assert.equal((await llamar("GET", "/avisos", {}, usuario(2, 1))).notificaciones_no_leidas, 0);
  await mover(p.id, -1, 1, "BAJA");
  const renovados = await avisos();
  assert.equal(renovados.length, 6);
  assert.ok(renovados.slice(3).every((a) => !a.resuelto_fecha));
  const historial = await llamar("GET", "/avisos/historial", {}, usuario(2, 1));
  assert.equal(historial.total, 2);
  assert.equal(historial.filas[1].leido, true);
});

test("el mínimo se evalúa por boca aunque el stock total sea suficiente; cambiarlo resuelve o abre avisos", async (t) => {
  const { crear, mover, llamar, avisos } = await preparar(t);
  const p = await crear({ stock_minimo: 0 });
  await mover(p.id, 2);
  await mover(p.id, 100, 2);
  assert.equal((await avisos()).length, 0);
  await llamar("PUT", `/productos/${p.id}`, { stock_minimo: 3 });
  assert.equal((await avisos()).length, 3);
  await llamar("PUT", `/productos/${p.id}`, { stock_minimo: 0 });
  assert.ok((await avisos()).every((a) => a.resuelto_fecha));
  await llamar("PUT", `/productos/${p.id}`, { stock_minimo: 2 });
  assert.equal((await avisos()).length, 3);
  await llamar("PUT", `/productos/${p.id}`, { stock_minimo: 2.001 });
  assert.equal((await avisos()).length, 6);
  await llamar("PUT", `/productos/${p.id}`, { activo: 0 });
  assert.ok((await avisos()).every((a) => a.resuelto_fecha));
});

test("recupera stock previo, añade una sola vez nuevos usuarios de la boca y no escribe sobre réplicas", async (t) => {
  const { ctx, db, crear, avisos } = await preparar(t);
  const p = await crear();
  await db.tx((tr) => N.insertar(tr, ctx, "predio_stock", { boca_id: 1, producto_id: p.id, cantidad: 1 }));
  await revisarStockMinimo(db, { ...ctx, modo: "central", revisarPreciosCentral: false }, { forzar: true });
  await revisarStockMinimo(db, { ...ctx, soloLectura: true }, { forzar: true });
  assert.equal((await avisos()).length, 0);
  await revisarStockMinimo(db, ctx, { forzar: true });
  assert.equal((await avisos()).length, 3);
  await db.tx((tr) => N.insertar(tr, ctx, "predio_usuario_boca", { usuario_id: 3, boca_id: 1 }));
  await revisarStockMinimo(db, ctx, { forzar: true });
  await revisarStockMinimo(db, ctx, { forzar: true });
  assert.equal((await avisos()).length, 4);
  assert.equal((await avisos()).filter((a) => a.usuario_id === 3).length, 1);
});

test("el episodio persiste sin internet y tras reiniciar no se repite hasta reponer", async (t) => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "predio-minimo-"));
  const { ctx, db, crear, mover } = await preparar(t, path.join(carpeta, "stock.db"));
  const p = await crear();
  await mover(p.id, 1);
  db.cerrar();
  const nuevo = crearSqlite(path.join(carpeta, "stock.db"), { predioId: 1 });
  asegurarEsquema(nuevo);
  t.after(() => { nuevo.cerrar(); fs.rmSync(carpeta, { recursive: true, force: true }); });
  await revisarStockMinimo(nuevo, { ...ctx, db: nuevo }, { forzar: true });
  assert.equal((await nuevo.get("SELECT COUNT(*) AS n FROM predio_aviso WHERE tipo = 'STOCK_MINIMO'")).n, 3);
});

test("si falla la entrega central se revierten juntos el stock y los avisos para reintentar", async (t) => {
  const { ctx, db, crear, mover, avisos } = await preparar(t);
  const p = await crear();
  await mover(p.id, 6);
  let recibidos = 0;
  const remoto = { ...ctx, alAvisosStock: async (_tr, filas) => { recibidos = filas.length; throw new Error("Entrega interrumpida"); } };
  await assert.rejects(db.tx((tr) => N.moverStock(tr, remoto, { bocaId: 1, productoId: p.id, cantidad: -2, tipo: "VENTA" })), /Entrega interrumpida/);
  assert.equal(recibidos, 3);
  assert.equal(await N.stockActual(db, ctx, 1, p.id), 6);
  assert.equal((await avisos()).length, 0);
  await mover(p.id, -2);
  assert.equal((await avisos()).length, 3);
});

test("eliminar físicamente un producto sin uso resuelve sus avisos y conserva el historial", async (t) => {
  const { ctx, db, crear, mover, llamar, avisos, usuario } = await preparar(t);
  const p = await crear();
  await mover(p.id, 2, 1, "ALTA_INICIAL");
  assert.equal((await avisos()).length, 3);
  await llamar("POST", "/productos/eliminar", { ids: [p.id] });
  assert.equal(await db.get("SELECT id FROM predio_producto WHERE predio_id = 1 AND id = ?", [p.id]), undefined);
  assert.equal(await db.get("SELECT id FROM predio_stock WHERE predio_id = 1 AND producto_id = ?", [p.id]), undefined);
  await revisarStockMinimo(db, ctx, { forzar: true });
  assert.ok((await avisos()).every((a) => a.resuelto_fecha));
  const actor = usuario(2, 1);
  assert.equal((await llamar("GET", "/avisos", {}, actor)).notificaciones_no_leidas, 0);
  const historial = await llamar("GET", "/avisos/historial", {}, actor);
  assert.equal(historial.total, 1);
  assert.ok(historial.filas[0].resuelto_fecha);
});
