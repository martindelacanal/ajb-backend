"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const api = require("../lib/api");

async function datos(t) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const admin = { db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, rol: "ADMIN", nombre: "Admin", bocas: [] }, sesion: {} };
  await db.tx((tx) => sembrarPredio(tx, admin, "MIRAMAR"));
  const boca = await db.get("SELECT id FROM predio_boca WHERE nombre = 'Proveeduría'");
  const caja = await db.get("SELECT id FROM predio_caja WHERE boca_id = ? LIMIT 1", [boca.id]);
  const cajero = { ...admin, usuario: { id: 2, rol: "CAJERO", nombre: "Caja", bocas: [boca.id] }, sesion: { boca_id: boca.id, caja_id: caja.id } };
  const llamar = (ctx, m, ruta, body = {}, query = {}) => api.ejecutar({ ...ctx, body, query }, m, ruta);
  const crear = async (destino, nombre, stock, precio = 1000, codigo = null) => {
    const p = await llamar(admin, "POST", "/productos", { nombre, destino, precio_venta_manual: precio, codigo });
    if (stock) await db.tx((tx) => N.moverStock(tx, admin, { bocaId: boca.id, productoId: p.id, cantidad: stock, tipo: "AJUSTE" }));
    return p;
  };
  return { db, admin, cajero, boca, crear, llamar };
}

test("el buscador general exige stock positivo en la boca para todos los destinos incluso al escribir", async (t) => {
  const { cajero, crear, llamar } = await datos(t);
  const conStock = [];
  const agotados = [];
  for (const destino of ["VENTA_DIRECTA", "VENTA_COMPUESTA", "ALQUILER"]) {
    conStock.push(await crear(destino, `${destino} disponible`, 2));
    agotados.push(await crear(destino, `${destino} agotado`, 0));
    await crear(destino, `${destino} negativo`, -1);
    await crear(destino, `${destino} sin precio`, 2, 0);
  }
  await crear("USO_INTERNO", "Interno positivo", 2);
  const lista = await llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1" });
  assert.deepEqual(new Set(lista.map((p) => p.id)), new Set(conStock.map((p) => p.id)));
  assert.ok(lista.every((p) => p.stock_boca > 0 && p.precio_venta > 0));
  assert.deepEqual(await llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1", q: "agotado" }), []);
  assert.deepEqual(await llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1", q: "negativo" }), []);
  for (const p of agotados) assert.ok(!lista.some((r) => r.id === p.id));
});

test("el selector de aviso permite buscar todo activo y muestra stock/precio sin revelar costos ni otra boca", async (t) => {
  const { admin, cajero, crear, llamar } = await datos(t);
  const directo = await crear("VENTA_DIRECTA", "Directo agotado", 0);
  const compuesto = await crear("VENTA_COMPUESTA", "Compuesto agotado", 0);
  const alquiler = await crear("ALQUILER", "Alquiler sin precio", 0, 0);
  const interno = await crear("USO_INTERNO", "Interno informativo", 2);
  const baja = await crear("VENTA_DIRECTA", "Dado de baja", 0);
  await llamar(admin, "PUT", `/productos/${baja.id}`, { activo: 0 });
  const lista = await llamar(cajero, "GET", "/productos/buscar", {}, { contexto: "aviso" });
  assert.deepEqual(new Set(lista.map((p) => p.id)), new Set([directo.id, compuesto.id, alquiler.id, interno.id]));
  assert.equal(lista.find((p) => p.id === alquiler.id).estado_venta, "SIN_PRECIO");
  assert.equal(lista.find((p) => p.id === interno.id).estado_venta, "USO_INTERNO");
  assert.ok(lista.every((p) => p.precio_compra === undefined && p.margen === undefined));
  assert.equal((await llamar(cajero, "GET", "/productos/buscar", {}, { contexto: "aviso", q: "Compuesto" }))[0].id, compuesto.id);
  await assert.rejects(llamar({ ...cajero, sesion: {} }, "GET", "/productos/buscar", {}, { contexto: "aviso" }), { codigo: "SIN_PUESTO" });
  await assert.rejects(llamar(cajero, "GET", "/productos/buscar", {}, { contexto: "aviso", boca_id: "999" }), { status: 403 });
});

test("compuestas y alquileres agotados se diagnostican y requieren aviso/configuración sin consumir su stock", async (t) => {
  const { db, admin, cajero, boca, crear, llamar } = await datos(t);
  for (const [destino, codigo] of [["VENTA_COMPUESTA", "7790895067556"], ["ALQUILER", "7790895000430"]]) {
    const p = await crear(destino, destino, 0, 1000, codigo);
    assert.equal((await llamar(cajero, "GET", "/productos/consultar-codigo", {}, { codigo })).estado, "SIN_STOCK");
    assert.deepEqual(await llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1", q: codigo }), []);
    const cuerpo = { items: [{ producto_id: p.id, cantidad: 2 }], forma_pago: "QR" };
    await assert.rejects(llamar(cajero, "POST", "/ventas", cuerpo), { codigo: "STOCK_INSUFICIENTE" });
    const aviso = await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: p.id, confirmar: true });
    assert.equal(aviso.puede_vender, true);
    await llamar(cajero, "POST", "/ventas", { ...cuerpo, confirmar_sin_stock: true });
    assert.equal(await N.stockActual(db, admin, boca.id, p.id), 0);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_movimiento WHERE producto_id = ? AND tipo = 'VENTA'", [p.id])).n, 0);
  }
  const sinPrecio = await crear("ALQUILER", "Alquiler sin precio", 0, 0);
  assert.equal((await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: sinPrecio.id, confirmar: true })).puede_vender, false);
  const interno = await crear("USO_INTERNO", "No vendible", 0);
  await assert.rejects(llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: interno.id, confirmar: true }), { codigo: "PRODUCTO_NO_VENDIBLE" });
  await db.tx((tx) => N.guardarConfig(tx, admin, "vender_sin_stock", "0"));
  assert.equal((await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: sinPrecio.id, confirmar: true })).puede_vender, false);
  const bloqueado = await crear("VENTA_COMPUESTA", "No vender agotado", 0);
  await assert.rejects(llamar(cajero, "POST", "/ventas", { items: [{ producto_id: bloqueado.id, cantidad: 1 }], forma_pago: "QR", confirmar_sin_stock: true }), { codigo: "SIN_STOCK" });
});

test("un aviso ya aceptado permite cobrar la misma cantidad sin otra confirmación ni aviso duplicado y se consume", async (t) => {
  const { db, cajero, crear, llamar } = await datos(t);
  const p = await crear("VENTA_DIRECTA", "Agotado aceptado", 0);
  const aviso = await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: p.id, cantidad: 1, confirmar: true });
  const cuerpo = { items: [{ producto_id: p.id, cantidad: 1 }], forma_pago: "QR", avisos_sin_stock: [{ id: aviso.id, producto_id: p.id }] };
  await assert.rejects(llamar(cajero, "POST", "/ventas", { ...cuerpo, items: [{ producto_id: p.id, cantidad: 2 }], avisos_sin_stock: [{ id: aviso.id, producto_id: p.id, cantidad: 999 }] }), { codigo: "STOCK_INSUFICIENTE" });
  await assert.rejects(llamar(cajero, "POST", "/ventas", { ...cuerpo, forma_pago: "EFECTIVO", recibido: 0 }), { status: 400 });
  assert.equal(JSON.parse((await db.get("SELECT detalle FROM predio_aviso WHERE id = ?", [aviso.id])).detalle).consumido_venta_id, undefined);
  const venta = await llamar(cajero, "POST", "/ventas", cuerpo);
  assert.equal(JSON.parse((await db.get("SELECT detalle FROM predio_aviso WHERE id = ?", [aviso.id])).detalle).consumido_venta_id, venta.id);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_aviso WHERE tipo = 'VENTA_SIN_STOCK'")).n, 1);
  await assert.rejects(llamar(cajero, "POST", "/ventas", cuerpo), { codigo: "STOCK_INSUFICIENTE" });
});

test("el aviso no sirve a otro usuario, caja o producto y no evita la configuración que prohíbe vender sin stock", async (t) => {
  const { db, admin, cajero, boca, crear, llamar } = await datos(t);
  const p = await crear("ALQUILER", "Alquiler aceptado", 0);
  const otroProducto = await crear("ALQUILER", "Otro alquiler", 0);
  const aviso = await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: p.id, confirmar: true });
  const cuerpo = { items: [{ producto_id: p.id, cantidad: 1 }], forma_pago: "QR", avisos_sin_stock: [{ id: aviso.id, producto_id: p.id }] };
  await assert.rejects(llamar({ ...cajero, usuario: { ...cajero.usuario, id: 3 } }, "POST", "/ventas", cuerpo), { codigo: "STOCK_INSUFICIENTE" });
  const otraCaja = await db.get("SELECT id FROM predio_caja WHERE boca_id = ? AND id <> ? LIMIT 1", [boca.id, cajero.sesion.caja_id]);
  await assert.rejects(llamar({ ...cajero, sesion: { ...cajero.sesion, caja_id: otraCaja.id } }, "POST", "/ventas", cuerpo), { codigo: "STOCK_INSUFICIENTE" });
  await assert.rejects(llamar(cajero, "POST", "/ventas", { ...cuerpo, items: [{ producto_id: otroProducto.id, cantidad: 1 }], avisos_sin_stock: [{ id: aviso.id, producto_id: otroProducto.id }] }), { codigo: "STOCK_INSUFICIENTE" });
  await db.tx((tx) => N.guardarConfig(tx, admin, "vender_sin_stock", "0"));
  await assert.rejects(llamar(cajero, "POST", "/ventas", cuerpo), { codigo: "SIN_STOCK" });
});

test("una venta mixta sólo vuelve a confirmar los faltantes que no estaban cubiertos", async (t) => {
  const { db, cajero, crear, llamar } = await datos(t);
  const a = await crear("VENTA_COMPUESTA", "Compuesto aceptado", 0);
  const b = await crear("VENTA_COMPUESTA", "Compuesto nuevo", 0);
  const aviso = await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: a.id, confirmar: true });
  const cuerpo = { items: [{ producto_id: a.id, cantidad: 1 }, { producto_id: b.id, cantidad: 1 }], forma_pago: "QR", avisos_sin_stock: [{ id: aviso.id, producto_id: a.id }] };
  await assert.rejects(llamar(cajero, "POST", "/ventas", cuerpo), (e) => e.codigo === "STOCK_INSUFICIENTE" && e.faltantes.length === 1 && e.faltantes[0].producto_id === b.id);
  await llamar(cajero, "POST", "/ventas", { ...cuerpo, confirmar_sin_stock: true });
  const avisos = await db.all("SELECT detalle FROM predio_aviso WHERE tipo = 'VENTA_SIN_STOCK' ORDER BY id");
  assert.equal(avisos.length, 2);
  assert.equal(JSON.parse(avisos[1].detalle).faltantes.length, 1);
  assert.equal(JSON.parse(avisos[1].detalle).faltantes[0].producto_id, b.id);
});
