"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const api = require("../lib/api");
const { hoy } = require("../lib/util");

async function preparar(t) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, usuario: { id: 1, nombre: "Admin", rol: "ADMIN" }, modo: "local", sesion: {} };
  await db.tx(tx => sembrarPredio(tx, ctx, "MIRAMAR"));
  const llamar = (metodo, ruta, body, query, otro) => api.ejecutar({ ...ctx, body, query, ...otro }, metodo, ruta);
  const proveedor = await llamar("POST", "/proveedores", { razon_social: "Distribuidora" });
  const producto = nombre => llamar("POST", "/productos", { nombre, destino: "VENTA_DIRECTA", precio_compra: 10, margen: 20 });
  const almacen = await N.bocaAlmacen(db, ctx);
  return { db, ctx, llamar, proveedor, producto, almacen, stock: p => N.stockActual(db, ctx, almacen.id, p.id) };
}

test("recepción, edición y factura concilian sólo diferencias, con reintentos y control de versión", async t => {
  const { db, ctx, llamar, proveedor, producto, stock, almacen } = await preparar(t);
  const a = await producto("Lata");
  const b = await producto("Bolsa");
  const renglon = (p, cantidad, precio_unitario = 11) => ({ producto_id: p.id, cantidad, precio_unitario, actualizar_precio: true });
  const recepcion = { proveedor_id: proveedor.id, operacion: "a".repeat(32), items: [renglon(a, 5)] };
  const [uno, dos] = await Promise.all([llamar("POST", "/compras/temporal", recepcion), llamar("POST", "/compras/temporal", recepcion)]);
  assert.equal(uno.id, dos.id);
  assert.equal(await stock(a), 5);
  assert.equal((await llamar("GET", `/productos/${a.id}`)).producto.precio_compra, 10);
  assert.equal((await llamar("GET", "/listados/compras")).totales.total, 0);
  const ruta = `/compras/${uno.id}`;
  const revision = (await llamar("GET", ruta)).revision;
  await db.tx(tx => N.moverStock(tx, ctx, { bocaId: almacen.id, productoId: a.id, cantidad: -3, tipo: "VENTA" }));
  const edicion = { proveedor_id: proveedor.id, temporal: true, revision, items: [renglon(b, 2)] };
  await assert.rejects(llamar("POST", ruta + "/revisar", edicion), /Revisá sus ventas y traspasos/);
  assert.equal((await llamar("GET", ruta)).revision, revision, "el fallo devuelve la recepción y sus renglones al estado previo");
  assert.equal(await stock(b), 0);
  edicion.items.push(renglon(a, 3));
  await llamar("POST", ruta + "/revisar", edicion);
  assert.equal(await stock(a), 0);
  assert.equal(await stock(b), 2);
  await assert.rejects(llamar("POST", ruta + "/revisar", edicion), /Otra persona/);
  const actual = (await llamar("GET", ruta)).revision;
  const final = { ...edicion, temporal: false, revision: actual, factura: "Final-1", fecha_factura: hoy(), total_factura: 55.5, redondeo_confirmado: 0.5 };
  const intentos = await Promise.allSettled([llamar("POST", ruta + "/revisar", final), llamar("POST", ruta + "/revisar", final)]);
  assert.equal(intentos.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await llamar("GET", ruta)).compra.estado, "CARGADA");
  assert.equal(await stock(a), 0);
  assert.equal(await stock(b), 2);
  assert.equal((await llamar("GET", `/productos/${a.id}`)).producto.precio_compra, 11);
  assert.deepEqual((await db.all("SELECT cantidad FROM predio_movimiento WHERE referencia_tipo='compra' ORDER BY id")).map(f => f.cantidad), [5, -2, 2]);
  const listado = await llamar("GET", "/listados/compras", {}, { f_producto: b.id });
  assert.equal(listado.total, 1);
  assert.deepEqual(listado.totales, { items: 2, total: 55.5 });
  assert.equal((await llamar("GET", "/listados/compras", {}, { f_producto: 999999 })).total, 0);
  await assert.rejects(llamar("POST", ruta + "/anular", { temporal: true, motivo: "Descarte en otra pestaña", revision: actual }), /cambió de estado/);
  await assert.rejects(llamar("POST", ruta + "/anular", { motivo: "Anular mercadería vendida" }), /Revisá sus ventas y traspasos/);
  assert.equal((await llamar("GET", ruta)).compra.estado, "CARGADA");
});

test("descartar repone la situación anterior y no permite descontar dos veces", async t => {
  const { ctx, llamar, proveedor, producto, stock } = await preparar(t);
  const p = await producto("Queso");
  const recepcion = { operacion: "b".repeat(32), proveedor_id: proveedor.id, items: [{ producto_id: p.id, cantidad: 0.5, precio_unitario: 100 }] };
  await assert.rejects(llamar("POST", "/compras/temporal", recepcion, {}, { usuario: { ...ctx.usuario, rol: "CAJERO", bocas: [] } }), /administrador/);
  const { id } = await llamar("POST", "/compras/temporal", recepcion);
  const ruta = `/compras/${id}`;
  const { revision } = await llamar("GET", ruta);
  await assert.rejects(llamar("POST", ruta + "/anular", { motivo: "Pantalla anterior" }), /Volvé a abrir/);
  await assert.rejects(llamar("POST", ruta + "/anular", { motivo: "Versión anterior", temporal: true, revision: revision - 1 }), /cambió/);
  const descarte = { motivo: "Mercadería devuelta", temporal: true, revision };
  await llamar("POST", ruta + "/anular", descarte);
  assert.equal(await stock(p), 0);
  assert.equal((await llamar("GET", ruta)).compra.estado, "DESCARTADA");
  await assert.rejects(llamar("POST", ruta + "/anular", descarte), /cambió de estado/);
});

test("el redondeo firmado exige aceptar la diferencia exacta y admite el total entero", async t => {
  const { llamar, proveedor, producto, stock } = await preparar(t);
  const p = await producto("Yerba");
  const compra = { proveedor_id: proveedor.id, factura: "F-1", fecha_factura: hoy(), total_factura: 100,
    items: [{ producto_id: p.id, cantidad: 1, precio_unitario: 100.48 }] };
  await assert.rejects(llamar("POST", "/compras", compra), /Confirmá el redondeo/);
  await assert.rejects(llamar("POST", "/compras", { ...compra, redondeo_confirmado: 0.48 }), /Confirmá el redondeo/);
  await assert.rejects(llamar("POST", "/compras", { ...compra, total_factura: 95, redondeo_confirmado: -5.48 }), /Supera el redondeo/);
  assert.equal(await stock(p), 0);
  const r = await llamar("POST", "/compras", { ...compra, redondeo_confirmado: -0.48 });
  const { compra: guardada, items } = await llamar("GET", `/compras/${r.id}`);
  assert.deepEqual([guardada.total_factura, guardada.total_items, items[0].precio_unitario], [100, 100.48, 100.48]);
  assert.match(r.avisos[0], /Redondeo/);
});
