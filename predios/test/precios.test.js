"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const N = require("../lib/negocio");
const { sembrarPredio } = require("../lib/semilla");
const api = require("../lib/api");
const { limiteRevision, revisarPreciosVencidos } = require("../lib/precios");

async function datos(t) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, nombre: "Admin", rol: "ADMIN", bocas: [] }, sesion: {} };
  await db.tx((tx) => sembrarPredio(tx, ctx, "MIRAMAR"));
  const boca = await db.get("SELECT id FROM predio_boca WHERE nombre = 'Proveeduría'");
  const caja = await db.get("SELECT id FROM predio_caja WHERE boca_id = ? LIMIT 1", [boca.id]);
  const llamar = (metodo, ruta, body = {}, query = {}, otro = {}) => api.ejecutar({ ...ctx, body, query, ...otro }, metodo, ruta);
  const crear = (nombre, extra = {}) => llamar("POST", "/productos", { nombre, precio_compra: 100, margen: 40, destino: "VENTA_DIRECTA", ...extra });
  const mover = (id, cantidad) => db.tx((tx) => N.moverStock(tx, ctx, { bocaId: boca.id, productoId: id, cantidad, tipo: "AJUSTE" }));
  const viejo = (id, fecha = "2026-06-01 12:00:00") => db.run("UPDATE predio_producto SET fecha_revision_precio = ? WHERE predio_id = 1 AND id = ?", [fecha, id]);
  return { db, ctx, boca, caja, llamar, crear, mover, viejo };
}

test("más de cuatro meses usa calendario, respeta el instante límite y los meses cortos", () => {
  assert.equal(limiteRevision(new Date("2026-11-05T15:30:00-03:00")), "2026-07-05 15:30:00");
  assert.equal(limiteRevision(new Date("2026-06-28T15:30:00-03:00")), "2026-02-28 15:30:00");
  assert.equal(limiteRevision(new Date("2026-06-30T15:30:00-03:00")), "2026-03-01 00:00:00");
  assert.equal(limiteRevision(new Date("2024-06-29T15:30:00-03:00")), "2024-02-29 15:30:00");
});

test("una oferta se registra al costo facturado y sólo actualiza los precios seleccionados", async (t) => {
  const { db, llamar, crear, viejo } = await datos(t);
  const p = await crear("Oferta", { precio_compra: 1000 });
  const otro = await crear("Con actualización", { precio_compra: 1000 });
  await viejo(p.id);
  const proveedor = await llamar("POST", "/proveedores", { razon_social: "Proveedor" });
  const factura = { proveedor_id: proveedor.id, factura: "F-1", fecha_factura: "2026-11-01", total_factura: 1600,
    items: [{ producto_id: p.id, cantidad: 1, precio_unitario: 700 },
      { producto_id: otro.id, cantidad: 1, precio_unitario: 900, actualizar_precio: true, margen: 99, costo_referencia: 1000 }] };
  const compra = await llamar("POST", "/compras", factura);
  const detalle = await llamar("GET", `/compras/${compra.id}`);
  assert.equal(detalle.compra.boca, "Almacén");
  assert.deepEqual(detalle.items.map(i => [i.precio_unitario, i.actualizo_precio, i.precio_venta]), [[700, 0, 1400], [900, 1, 1300]]);
  const ficha = (await llamar("GET", `/productos/${p.id}`)).producto;
  assert.equal(ficha.fecha_revision_precio, "2026-06-01 12:00:00");
  assert.equal(ficha.precio_compra, 1000);
  assert.equal((await llamar("GET", "/productos/buscar", {}, { q: "Oferta" }))[0].ultimo_costo, 700);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_stock WHERE boca_id = ? AND cantidad = 1", [detalle.compra.boca_id])).n, 2);
  await assert.rejects(llamar("POST", "/compras", { ...factura, factura: "F-2" }), /costo de referencia/);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_compra")).n, 1, "un cambio concurrente revierte toda la factura");
  const anulada = await llamar("POST", `/compras/${compra.id}/anular`, { motivo: "Factura duplicada" });
  assert.deepEqual(anulada.precios_restaurados.map(i => i.producto_id), [otro.id]);
  assert.equal((await llamar("GET", "/productos/buscar", {}, { q: "Oferta" }))[0].ultimo_costo, null);
});

test("avisos pendientes se deduplican, se resuelven al revisar y renuevan cuando vuelve a vencer", async (t) => {
  const { db, ctx, llamar, crear, mover, viejo } = await datos(t);
  const p = await crear("Producto pendiente");
  const sinStock = await crear("Viejo sin stock");
  const interno = await crear("Insumo antiguo", { destino: "USO_INTERNO" });
  await mover(p.id, 2);
  await mover(interno.id, 1);
  await viejo(p.id); await viejo(sinStock.id); await viejo(interno.id);
  const ahora = new Date("2026-11-05T12:00:00-03:00");
  const revisar = (forzar = true) => revisarPreciosVencidos(db, ctx, { ahora, forzar });
  const primera = await revisar();
  assert.equal(primera.emitidos, 2);
  assert.equal((await revisar()).emitidos, 0);
  const tabla = await llamar("GET", "/listados/productos", {}, { f_revision_precio: "pendiente" }, { ahora });
  assert.deepEqual(new Set(tabla.filas.map((f) => f.id)), new Set([p.id, interno.id]));
  assert.match(tabla.filas[0].revision_precio, /Revisar/);
  await llamar("PUT", `/productos/${p.id}`, { nombre: "Nombre corregido", precio_compra: 100, margen: 40, precio_venta_manual: 140 });
  assert.equal((await llamar("GET", `/productos/${p.id}`)).producto.fecha_revision_precio, "2026-06-01 12:00:00");
  assert.equal((await revisar()).emitidos, 0);
  await llamar("PUT", `/productos/${p.id}`, { confirmar_revision_precio: true });
  const control = await db.get("SELECT * FROM predio_precio_control WHERE producto_id = ?", [p.id]);
  assert.ok(control.resuelto_fecha);
  assert.ok((await db.get("SELECT resuelto_fecha FROM predio_aviso WHERE id = ?", [control.aviso_id])).resuelto_fecha);
  assert.ok(!(await llamar("GET", "/avisos")).notificaciones.some((a) => a.id === control.aviso_id));
  await viejo(p.id, "2026-06-02 12:00:00");
  assert.equal((await revisar()).emitidos, 1);
  const renovado = await db.get("SELECT aviso_id FROM predio_precio_control WHERE producto_id = ?", [p.id]);
  assert.notEqual(renovado.aviso_id, control.aviso_id);
  await mover(p.id, -2);
  assert.equal((await revisar()).resueltos, 1);
  await mover(p.id, 1);
  assert.equal((await revisar()).emitidos, 1);
});

test("la caja usa su margen, respeta una excepción de 0% y vuelve a heredar al quitarla", async (t) => {
  const { db, ctx, boca, caja, crear, mover, llamar } = await datos(t);
  const prod = await crear("Arroz", { codigo: "7790000000012", precio_compra: 1550, precio_venta_manual: 2050 });
  await mover(prod.id, 5);
  const actor = { usuario: { ...ctx.usuario, rol: "CAJERO", bocas: [boca.id] }, sesion: { boca_id: boca.id, caja_id: caja.id } };
  const detalle = () => llamar("GET", `/productos/${prod.id}`);
  const buscar = async () => (await llamar("GET", "/productos/buscar", {}, { venta: "1", q: "Arroz" }, actor))[0];
  const escanear = async () => (await llamar("GET", "/productos/consultar-codigo", {}, { codigo: "7790000000012" }, actor)).producto;
  const stock = async () => (await llamar("GET", "/listados/stock", {}, {}, actor)).filas[0];
  const venta = (esperado) => llamar("POST", "/ventas",
    { forma_pago: "QR", items: [{ producto_id: prod.id, cantidad: 1, precio_unitario: esperado }] }, {}, actor);
  await db.run("UPDATE predio_producto SET precio_venta = 2050 WHERE id = ?", [prod.id]); // Ficha del catálogo anterior.
  assert.equal((await detalle()).producto.precio_venta, 2100);
  assert.equal((await buscar()).precio_venta, 2100);
  await llamar("PUT", `/bocas/${boca.id}`, { margen_venta: 30 });
  assert.equal((await escanear()).precio_venta, 2100);
  await llamar("PUT", `/productos/${prod.id}`, { margenes_boca: [{ boca_id: boca.id, margen: 0 }] });
  assert.equal((await escanear()).precio_venta, 1600);
  assert.equal((await stock()).precio_venta, 1600);
  assert.equal((await buscar()).margen, undefined);
  assert.equal((await buscar()).ultimo_costo, undefined);
  await assert.rejects(venta(2100), { codigo: "PRECIOS_CAMBIARON", precios: [{ producto_id: prod.id, precio_venta: 1600 }] });
  assert.equal((await stock()).cantidad, 5);
  const cobrada = await venta(1600);
  assert.equal(cobrada.ticket.items[0].precio_unitario, 1600);
  await llamar("PUT", `/bocas/${boca.id}`, { margen_venta: 60 });
  assert.equal((await buscar()).precio_venta, 1600);
  await llamar("PUT", `/productos/${prod.id}`, { margenes_boca: [] });
  assert.equal((await buscar()).precio_venta, 2500);
  await llamar("PUT", `/bocas/${boca.id}`, { margen_venta: null });
  assert.equal((await buscar()).precio_venta, 2100);
  const { precios, margenes_boca } = await detalle();
  assert.deepEqual(precios.filter(f => f.boca_id === boca.id).map(f => f.precio_venta), [2100, 2500, 1600, 2100]);
  assert.ok(margenes_boca.every(f => f.margen == null));
  assert.ok((await db.all("SELECT DISTINCT op FROM predio_outbox WHERE tabla = 'predio_producto_margen_boca'")).some(f => f.op === "D"));
});

test("cambiar la proveeduría direcciona las compras y una nueva siembra de Miramar respeta la elección", async (t) => {
  const { db, ctx, boca, crear, llamar } = await datos(t);
  const anterior = await N.bocaAlmacen(db, ctx);
  assert.equal(anterior.nombre, "Almacén");
  const prod = await crear("Gaseosa");
  const prov = await llamar("POST", "/proveedores", { razon_social: "Distribuidor" });
  const factura = { proveedor_id: prov.id, factura: "F-3", fecha_factura: "2026-11-01", total_factura: 100,
    items: [{ producto_id: prod.id, cantidad: 1, precio_unitario: 100 }] };
  await llamar("PUT", `/bocas/${boca.id}`, { es_almacen: true });
  await assert.rejects(llamar("POST", "/compras", { ...factura, boca_id: anterior.id }), /proveeduría/);
  await assert.rejects(llamar("PUT", `/bocas/${boca.id}`, { activo: 0 }), /otra boca/);
  await db.tx(tx => sembrarPredio(tx, ctx, "MIRAMAR"));
  const compra = await llamar("POST", "/compras", factura);
  assert.equal((await llamar("GET", `/compras/${compra.id}`)).compra.boca_id, boca.id);
  assert.equal(await N.stockActual(db, ctx, anterior.id, prod.id), 0);
  assert.equal(await N.stockActual(db, ctx, boca.id, prod.id), 1);
});

test("márgenes sobre costos altos y servicios sin costo mantienen el precio exacto en búsqueda y ficha", async (t) => {
  const { boca, llamar, crear } = await datos(t);
  // El costo multiplicado por el margen excede la precisión de un entero JS.
  // Queda una fracción por encima del múltiplo de $100 y debe subir el último escalón.
  const p = await crear("Mayorista", { precio_compra: 98989999.99, margen: 9899.99 });
  await llamar("PUT", `/bocas/${boca.id}`, { margen_venta: 9899.99 });
  const d = await llamar("GET", `/productos/${p.id}`);
  assert.equal(d.producto.precio_venta, 9898990200);
  assert.equal(d.margenes_boca.find(f => f.boca_id === boca.id).precio_venta, 9898990200);
  await crear("Alquiler", { destino: "ALQUILER", precio_compra: 0, precio_venta_manual: 1550 });
  const alquiler = (await llamar("GET", "/productos/buscar", {}, { boca_id: boca.id, q: "Alquiler" }))[0];
  assert.equal(alquiler.precio_venta, 1600, "el margen de la boca no deja sin precio un servicio con venta manual y sin costo");
});

test("el límite es estricto y un precio importado usa historial sin confundir cambios de nombre/código", async (t) => {
  const { db, ctx, crear, mover, viejo } = await datos(t);
  const exacto = await crear("Cuatro meses exactos");
  const pasado = await crear("Cuatro meses y un segundo");
  const importado = await crear("Importado antiguo");
  for (const p of [exacto, pasado, importado]) await mover(p.id, 1);
  await viejo(exacto.id, "2026-07-05 12:00:00");
  await viejo(pasado.id, "2026-07-05 11:59:59");
  await db.run("UPDATE predio_producto SET fecha_revision_precio = NULL, fecha_modificacion = '2026-11-05 12:00:00' WHERE id = ?", [importado.id]);
  await db.run("UPDATE predio_precio_historial SET fecha = '2026-05-01 00:00:00', origen = 'IMPORTACION' WHERE producto_id = ?", [importado.id]);
  const r = await revisarPreciosVencidos(db, ctx, { ahora: new Date("2026-11-05T12:00:00-03:00"), forzar: true });
  assert.equal(r.pendientes, 2);
  const ids = (await db.all("SELECT producto_id FROM predio_precio_control")).map((f) => f.producto_id);
  assert.deepEqual(new Set(ids), new Set([pasado.id, importado.id]));
});

test("el diagnóstico exacto explica sin precio y el buscador excluye todos los no vendibles", async (t) => {
  const { ctx, boca, caja, llamar, crear, mover } = await datos(t);
  const sinPrecio = await crear("Sin precio", { codigo: "7790895067556", precio_compra: 0, margen: 0 });
  const cercano = await crear("Cercano con precio", { codigo: "779089506755" });
  const servicio = await crear("Servicio con precio", { destino: "VENTA_COMPUESTA" });
  const servicioCero = await crear("Servicio sin precio", { destino: "ALQUILER", precio_compra: 0 });
  await mover(sinPrecio.id, 2); await mover(cercano.id, 2);
  const actor = { usuario: { ...ctx.usuario, id: 2, rol: "CAJERO", bocas: [boca.id] }, sesion: { boca_id: boca.id, caja_id: caja.id } };
  const busqueda = await llamar("GET", "/productos/buscar", {}, { venta: "1" }, actor);
  assert.deepEqual(new Set(busqueda.map((p) => p.id)), new Set([cercano.id]));
  assert.ok(!busqueda.some((p) => p.id === servicioCero.id));
  assert.deepEqual(await llamar("GET", "/productos/buscar", {}, { venta: "1", q: "7790895067556" }, actor), []);
  const consulta = await llamar("GET", "/productos/consultar-codigo", {}, { codigo: "7790895067556" }, actor);
  assert.equal(consulta.estado, "SIN_PRECIO");
  assert.equal(consulta.producto.id, sinPrecio.id);
  assert.equal(consulta.producto.precio_compra, undefined);
  assert.equal((await llamar("GET", "/productos/consultar-codigo", {}, { codigo: "7790895067555" }, actor)).estado, "NO_ENCONTRADO");
});

async function comprasDePrueba(t) {
  const d = await datos(t);
  const producto = await d.crear("Producto con compras", { cantidad_almacen: 4 });
  const proveedor = await d.llamar("POST", "/proveedores", { razon_social: "Proveedor de compras" });
  const comprar = (factura, costo) => d.llamar("POST", "/compras", {
    proveedor_id: proveedor.id, factura, fecha_factura: "2026-11-01", total_factura: costo,
    items: [{ producto_id: producto.id, cantidad: 1, precio_unitario: costo, actualizar_precio: true }],
  });
  const anular = (compra) => d.llamar("POST", `/compras/${compra.id}/anular`, { motivo: "Factura incorrecta" });
  const ficha = () => d.db.get("SELECT * FROM predio_producto WHERE id = ?", [producto.id]);
  return { ...d, producto, comprar, anular, ficha };
}

test("anular las últimas compras restaura la cadena vigente y no convierte la anulación en revisión reciente", async (t) => {
  const { db, ctx, producto, comprar, anular, ficha } = await comprasDePrueba(t);
  const a = await comprar("A", 200);
  await db.run("UPDATE predio_precio_historial SET fecha = '2026-01-06 10:00:00' WHERE origen = 'COMPRA' AND referencia_id = ?", [a.id]);
  const b = await comprar("B", 300);
  const r = await anular(b);
  assert.equal(r.precios_restaurados.length, 1);
  assert.equal((await ficha()).precio_compra, 200);
  assert.equal((await ficha()).precio_venta, 300);
  assert.equal((await ficha()).fecha_revision_precio, "2026-01-06 10:00:00");
  const revision = await revisarPreciosVencidos(db, ctx, { ahora: new Date("2026-11-05T12:00:00-03:00"), forzar: true });
  assert.equal(revision.pendientes, 1);
  await anular(a);
  assert.equal((await ficha()).precio_compra, 100);
  assert.equal((await ficha()).precio_venta, 200);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_precio_historial WHERE producto_id = ? AND origen = 'ANULACION_COMPRA'", [producto.id])).n, 2);
});

test("anular una compra anterior conserva la última activa y la cadena saltea compras ya anuladas", async (t) => {
  const { comprar, anular, ficha } = await comprasDePrueba(t);
  const a = await comprar("A", 200);
  const b = await comprar("B", 300);
  assert.equal((await anular(a)).precios_restaurados.length, 0);
  assert.equal((await ficha()).precio_compra, 300);
  await anular(b);
  assert.equal((await ficha()).precio_compra, 100);
  assert.equal((await ficha()).precio_venta, 200);
});

test("anular no pisa una edición ni una revisión explícita posterior aunque ocurra en el mismo segundo", async (t) => {
  const { db, producto, llamar, comprar, anular, ficha } = await comprasDePrueba(t);
  const a = await comprar("A", 200);
  await llamar("PUT", `/productos/${producto.id}`, { precio_venta_manual: 999 });
  await anular(a);
  assert.equal((await ficha()).precio_venta, 1000);
  assert.equal((await ficha()).precio_compra, 200);
  const b = await comprar("B", 300);
  await llamar("PUT", `/productos/${producto.id}`, { confirmar_revision_precio: true });
  // El ID del evento conserva el orden cuando las fechas son iguales.
  await db.run("UPDATE predio_precio_historial SET fecha = '2026-11-05 12:00:00' WHERE producto_id = ?", [producto.id]);
  assert.equal((await anular(b)).precios_restaurados.length, 0);
  assert.equal((await ficha()).precio_compra, 300);
  assert.equal((await ficha()).precio_venta, 500);
});

test("si el historial anterior falta se recupera el costo anterior sin inventar fecha y se informa la limitación", async (t) => {
  const { db, producto, comprar, anular, ficha } = await comprasDePrueba(t);
  const a = await comprar("A", 200);
  await db.run("DELETE FROM predio_precio_historial WHERE producto_id = ? AND origen <> 'COMPRA'", [producto.id]);
  const r = await anular(a);
  assert.equal((await ficha()).precio_compra, 100);
  assert.equal((await ficha()).precio_venta, 200);
  assert.equal((await ficha()).fecha_revision_precio, null);
  assert.equal(r.avisos.length, 1);
  assert.match(r.mensaje, /sin historial previo/);
});
