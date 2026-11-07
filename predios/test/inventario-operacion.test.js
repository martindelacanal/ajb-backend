"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../lib/api");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const { revisarVencimientos } = require("../lib/vencimientos");
const { listarAvisos } = require("../lib/avisos");
const U = require("../lib/util");

test("una donación suma existencias en su boca, queda auditada y respeta el umbral de cada producto", async t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", usuario: { id: 1, rol: "ADMIN", nombre: "Encargada", bocas: [] } };
  await db.tx(tr => sembrarPredio(tr, ctx, "MIRAMAR"));
  const llamar = (metodo, ruta, body, usuario = ctx.usuario, query = {}) => api.ejecutar({ ...ctx, usuario, query, body }, metodo, ruta);
  const hoy = U.hoy(), fecha = U.sumarDias(hoy, 14);
  const producto = await llamar("POST", "/productos", { nombre: "Leche", perecedero: 1, dias_aviso_vencimiento: 14, fecha_caducidad: fecha });
  const boca = await db.get("SELECT id FROM predio_boca WHERE activo=1 AND es_almacen=0 LIMIT 1");
  const cuerpo = { producto_id: producto.id, cantidad: 12, boca_id: boca.id, motivo: "DONACION", observaciones: "Una caja" };
  const empleado = { id: 25, rol: "CAJERO", bocas: [boca.id] };
  await assert.rejects(llamar("POST", "/altas", cuerpo, empleado), e => e.status === 403);
  await assert.rejects(llamar("POST", "/altas", { ...cuerpo, cantidad: -2 }));
  await llamar("POST", "/altas", cuerpo);
  const mov = await db.get("SELECT * FROM predio_movimiento WHERE producto_id=?", [producto.id]);
  assert.deepEqual([mov.tipo, mov.motivo, mov.boca_id, mov.cantidad, mov.saldo, mov.usuario_nombre], ["ALTA", "DONACION", boca.id, 12, 12, "Encargada"]);
  const revisar = dia => db.tx(tr => revisarVencimientos(tr, ctx, dia));
  const avisos = () => listarAvisos({ ...ctx, usuario: empleado });
  await revisar(U.sumarDias(hoy, -1));
  assert.equal((await avisos()).length, 0);
  await Promise.all([revisar(hoy), revisar(hoy)]);
  assert.deepEqual((await avisos()).map(a => a.detalle.fecha_caducidad), [fecha]);
  assert.equal((await llamar("GET", "/listados/productos", {}, ctx.usuario, { f_vencimiento: "aviso" })).total, 1);
  await assert.rejects(llamar("PUT", "/productos/" + producto.id, { dias_aviso_vencimiento: 1.5 }));
  await llamar("PUT", "/productos/" + producto.id, { dias_aviso_vencimiento: 0 });
  await revisar(hoy);
  assert.equal((await avisos()).length, 0);
  await revisar(fecha);
  assert.equal((await avisos()).length, 1);
  await llamar("POST", "/bajas", { ...cuerpo, motivo: "VENCIMIENTO" });
  await revisar(fecha);
  assert.equal((await avisos()).length, 0);
});

test("el historial de altas lista las líneas de Sumar stock y sólo está disponible para administradores", async t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", usuario: { id: 1, rol: "ADMIN", nombre: "Encargada", bocas: [] } };
  await db.tx(tr => sembrarPredio(tr, ctx, "MIRAMAR"));
  const llamar = (metodo, ruta, body, query = {}) => api.ejecutar({ ...ctx, query, body }, metodo, ruta);
  const leche = await llamar("POST", "/productos", { nombre: "Leche", cantidad_almacen: 3 });
  const pan = await llamar("POST", "/productos", { nombre: "Pan" });
  const boca = await db.get("SELECT id, nombre FROM predio_boca WHERE activo=1 AND es_almacen=1");
  await llamar("POST", "/altas", {
    boca_id: boca.id, motivo: "DONACION", observaciones: "Dos cajas",
    lineas: [{ producto_id: leche.id, cantidad: 12 }, { producto_id: pan.id, cantidad: 2.5 }],
  });
  await llamar("POST", "/altas", { boca_id: boca.id, producto_id: leche.id, cantidad: 1, motivo: "RECUENTO" });
  await llamar("POST", "/bajas", { boca_id: boca.id, producto_id: leche.id, cantidad: 1, motivo: "ROTURA" });

  const ruta = "/listados/altas";
  const { filas, total, totales } = await llamar("GET", ruta);
  assert.equal(total, 3);
  assert.equal(totales.cantidad, 15.5);
  assert.deepEqual(filas.map(f => [f.producto, f.cantidad, f.motivo]), [
    ["Leche", 1, "RECUENTO"], ["Pan", 2.5, "DONACION"], ["Leche", 12, "DONACION"],
  ]);
  assert.deepEqual([filas[1].boca, filas[1].detalle, filas[1].usuario_nombre], [boca.nombre, "Donación · Dos cajas", "Encargada"]);
  const filtrado = await llamar("GET", ruta, {}, { f_motivo: "DONACION", f_producto: leche.id });
  assert.deepEqual(filtrado.filas.map(f => f.id), [filas[2].id]);
  const { csv } = await llamar("GET", ruta, {}, { formato: "csv", modo: "resumen", grupo: "motivo" });
  assert.match(csv, /Donación;2;14,5/);
  const empleado = { ...ctx, query: {}, usuario: { id: 25, rol: "CAJERO", bocas: [boca.id] } };
  for (const endpoint of [ruta, ruta + "/meta"]) {
    await assert.rejects(api.ejecutar(empleado, "GET", endpoint), e => e.status === 403);
  }
});
