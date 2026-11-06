"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const N = require("../lib/negocio");
const api = require("../lib/api");
const { emitirAviso } = require("../lib/avisos");

async function preparar(t, archivo = ":memory:") {
  const db = crearSqlite(archivo, { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", soloLectura: true, usuario: { id: 1, rol: "CAJERO", bocas: [] }, sesion: {} };
  await db.tx(async (tr) => {
    await N.insertar(tr, ctx, "predio_usuario", { usuario: "propio", nombre: "Cajera", rol: "CAJERO", activo: 1 });
    await N.insertar(tr, ctx, "predio_usuario", { usuario: "otro", nombre: "Otra cajera", rol: "CAJERO", activo: 1 });
    await N.insertar(tr, ctx, "predio_usuario", { usuario: "admin", nombre: "Admin", rol: "ADMIN", activo: 1 });
  });
  const llamar = (metodo, ruta, query = {}, extra = {}) => api.ejecutar({ ...ctx, query, body: {}, ...extra }, metodo, ruta);
  const emitir = (extra = {}) => db.tx((tr) => emitirAviso(tr, ctx, {
    tipo: "ACCESO_FALLIDO", usuarioId: 1, titulo: "Aviso de acceso", mensaje: "Detalle privado", ...extra,
  }));
  return { ctx, db, llamar, emitir };
}

test("la campana conserva las últimas diez notificaciones leídas y resueltas y cuenta todos los pendientes", async (t) => {
  const { llamar, emitir, db } = await preparar(t);
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push(await emitir({ titulo: `Aviso ${i + 1}` }));
  await llamar("POST", `/avisos/${ids[24]}/leer`);
  await db.run("UPDATE predio_aviso SET resuelto_fecha = '2026-11-06 10:00:00' WHERE predio_id = 1 AND id = ?", [ids[23]]);
  const campana = await llamar("GET", "/avisos");
  assert.equal(campana.recientes.length, 10);
  assert.deepEqual(campana.recientes.map((n) => n.id), ids.slice(-10).reverse());
  assert.equal(campana.recientes[0].leido, true);
  assert.equal(campana.recientes[1].resuelto_fecha, "2026-11-06 10:00:00");
  assert.equal(campana.notificaciones_total, 25);
  assert.equal(campana.notificaciones_no_leidas, 23);
  assert.equal(campana.total, 23);
  const primera = await llamar("GET", "/avisos/historial");
  const segunda = await llamar("GET", "/avisos/historial", { pagina: "2" });
  assert.equal(primera.paginas, 2);
  assert.equal(primera.filas.length, 20);
  assert.equal(segunda.filas.length, 5);
  assert.deepEqual([...primera.filas, ...segunda.filas].map((n) => n.id), ids.slice().reverse());
});

test("el historial, los contadores y las lecturas aíslan usuarios, predios y avisos para administradores", async (t) => {
  const { llamar, emitir, ctx, db } = await preparar(t);
  const propio = await emitir();
  const otro = await emitir({ usuarioId: 2, mensaje: "Sólo para la otra cajera" });
  const broadcast = await emitir({ usuarioId: null, tipo: "VENTA_SIN_STOCK", mensaje: "Sólo para administradores" });
  const general = await emitir({ usuarioId: null, generalUsuarioId: 77, generalDocumento: "30111222", mensaje: "Sólo para esa identidad general" });
  await db.tx((tr) => emitirAviso(tr, { ...ctx, pid: 2 }, { tipo: "ACCESO_FALLIDO", usuarioId: 1, titulo: "Otro predio", mensaje: "No visible" }));
  const cajera = await llamar("GET", "/avisos/historial");
  assert.deepEqual(cajera.filas.map((n) => n.id), [propio]);
  assert.equal(cajera.total, 1);
  assert.equal(cajera.no_leidas, 1);
  const admin = { usuario: { id: 3, rol: "ADMIN" } };
  assert.deepEqual((await llamar("GET", "/avisos/historial", {}, admin)).filas.map((n) => n.id), [broadcast]);
  await db.tx((tr) => N.insertar(tr, ctx, "predio_usuario", { usuario: "general", nombre: "Admin general", rol: "ADMIN", activo: 1, es_admin_general: 1, general_usuario_id: 77, documento: "30111222" }));
  const identidadGeneral = { usuario: { id: 4, rol: "ADMIN" } };
  assert.deepEqual((await llamar("GET", "/avisos/historial", {}, identidadGeneral)).filas.map((n) => n.id), [general, broadcast]);
  await assert.rejects(llamar("POST", `/avisos/${otro}/leer`), { status: 404 });
  await assert.rejects(llamar("POST", `/avisos/${propio}/leer`, {}, admin), { status: 404 });
  await assert.rejects(llamar("GET", "/avisos/historial", {}, { usuario: null }), { status: 401 });
});

test("leer un aviso no lo borra, conserva la lectura individual y permite filtrar con paginación acotada", async (t) => {
  const { llamar, emitir, db } = await preparar(t);
  const id = await emitir({ usuarioId: null });
  const a = { usuario: { id: 3, rol: "ADMIN" } };
  const b = { usuario: { id: 4, rol: "ADMIN" } };
  await llamar("POST", `/avisos/${id}/leer`, {}, a);
  await llamar("POST", `/avisos/${id}/leer`, {}, a);
  const leidas = await llamar("GET", "/avisos/historial", { estado: "leidos", tam: "9999", pagina: "99999" }, a);
  assert.equal(leidas.total, 1);
  assert.equal(leidas.tam, 20);
  assert.equal(leidas.pagina, 1);
  assert.equal(leidas.filas[0].leido, true);
  assert.ok(leidas.filas[0].leido_fecha);
  assert.equal((await llamar("GET", "/avisos/historial", { estado: "no_leidos" }, a)).total, 0);
  assert.equal((await llamar("GET", "/avisos/historial", { estado: "no_leidos" }, b)).total, 1);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_aviso_lectura")).n, 1);
  assert.ok(await db.get("SELECT seq FROM predio_outbox WHERE tabla = 'predio_aviso_lectura'"));
});

test("historial y estado de lectura persisten al reabrir la base sin internet", async (t) => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "predio-notificaciones-"));
  const archivo = path.join(carpeta, "avisos.db");
  const { ctx, db, llamar, emitir } = await preparar(t, archivo);
  const id = await emitir();
  await llamar("POST", `/avisos/${id}/leer`);
  db.cerrar();
  const reabierta = crearSqlite(archivo, { predioId: 1 });
  asegurarEsquema(reabierta);
  t.after(() => { reabierta.cerrar(); fs.rmSync(carpeta, { recursive: true, force: true }); });
  const r = await api.ejecutar({ ...ctx, db: reabierta, query: {} }, "GET", "/avisos/historial");
  assert.equal(r.total, 1);
  assert.equal(r.no_leidas, 0);
  assert.equal(r.filas[0].id, id);
  assert.equal(r.filas[0].leido, true);
});
