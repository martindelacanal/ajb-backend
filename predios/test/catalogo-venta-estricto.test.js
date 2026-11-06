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

test("el aviso y las banderas de clientes anteriores nunca habilitan cobrar sin stock", async (t) => {
  const { db, admin, cajero, boca, crear, llamar } = await datos(t);
  await db.tx(tx => N.guardarConfig(tx, admin, "vender_sin_stock", "1"));
  for (const destino of ["VENTA_DIRECTA", "VENTA_COMPUESTA", "ALQUILER"]) {
    const p = await crear(destino, destino, 0);
    const aviso = await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: p.id, cantidad: 2, confirmar: true });
    assert.equal(aviso.puede_vender, false);
    const cuerpo = { items: [{ producto_id: p.id, cantidad: 2 }], forma_pago: "QR", confirmar_sin_stock: true, avisos_sin_stock: [{ id: aviso.id, producto_id: p.id }] };
    await assert.rejects(llamar(cajero, "POST", "/ventas", cuerpo), { codigo: "SIN_STOCK" });
    assert.equal(await N.stockActual(db, admin, boca.id, p.id), 0);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_venta")).n, 0);
  }
  const interno = await crear("USO_INTERNO", "No vendible", 0);
  await assert.rejects(llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: interno.id, confirmar: true }), { codigo: "PRODUCTO_NO_VENDIBLE" });
});

test("dos tamaños vendidos juntos descuentan su consumo estimado del mismo paquete de la boca", async t => {
  const { db, admin, cajero, boca, crear, llamar } = await datos(t);
  const paquete = await crear("USO_INTERNO", "Paquete de café", 0.1);
  const chico = await crear("VENTA_COMPUESTA", "Café chico", 0, 1000, "7790895067556");
  const grande = await crear("VENTA_COMPUESTA", "Café grande", 0);
  for (const [p, rendimiento] of [[chico, 40], [grande, 20]]) {
    await llamar(admin, "PUT", "/productos/" + p.id, { receta: { insumo_id: paquete.id, rendimiento } });
  }
  assert.equal((await llamar(cajero, "GET", "/productos/consultar-codigo", {}, { codigo: "7790895067556" })).producto.stock_boca, 4);
  const porciones = await llamar(cajero, "GET", "/productos/buscar", {}, { q: "Café", venta: "1" });
  assert.equal(porciones.find(p => p.id === grande.id).stock_boca, 2);
  const intento = { items: [{ producto_id: chico.id, cantidad: 3 }, { producto_id: grande.id, cantidad: 1 }], forma_pago: "QR" };
  await assert.rejects(llamar(cajero, "POST", "/ventas", intento), e => e.codigo === "SIN_STOCK" && e.faltantes[0].pedido === 0.125 && e.faltantes[0].producto_id === paquete.id);
  const aviso = await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: paquete.id, cantidad: 0.125, insumo: true, confirmar: true });
  assert.equal(aviso.puede_vender, false);
  const venta = await llamar(cajero, "POST", "/ventas", { ...intento, items: [{ producto_id: chico.id, cantidad: 2 }, { producto_id: grande.id, cantidad: 1 }] });
  assert.equal(await N.stockActual(db, admin, boca.id, paquete.id), 0);
  assert.equal(venta.ticket.items.length, 2);
  assert.equal((await db.get("SELECT SUM(cantidad) AS consumo FROM predio_movimiento WHERE tipo = 'VENTA' AND motivo = 'CONSUMO_ESTIMADO' AND referencia_id = ?", [venta.id])).consumo, -0.1);
  assert.deepEqual(await llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1", q: "Café" }), []);
  await llamar(admin, "PUT", "/productos/" + chico.id, { receta: { insumo_id: paquete.id, rendimiento: 10 } });
  await llamar(admin, "POST", "/ventas/" + venta.id + "/anular", { motivo: "Pedido duplicado" });
  assert.equal(await N.stockActual(db, admin, boca.id, paquete.id), 0.1);
});

test("los compuestos sin receta usan porciones propias y los alquileres exigen la cantidad disponible", async t => {
  const { db, admin, cajero, boca, crear, llamar } = await datos(t);
  for (const destino of ["VENTA_COMPUESTA", "ALQUILER"]) {
    const p = await crear(destino, destino, 2);
    const cobrar = cantidad => llamar(cajero, "POST", "/ventas", { items: [{ producto_id: p.id, cantidad }], forma_pago: "QR" });
    await assert.rejects(cobrar(3), { codigo: "SIN_STOCK" });
    const venta = await cobrar(2);
    assert.equal(await N.stockActual(db, admin, boca.id, p.id), destino === "ALQUILER" ? 2 : 0);
    await llamar(admin, "POST", "/ventas/" + venta.id + "/anular", { motivo: "Revertir prueba" });
    assert.equal(await N.stockActual(db, admin, boca.id, p.id), 2);
  }
});

test("únicamente el traspaso fraccionable confirmado puede dejar su origen en negativo", async t => {
  const { db, admin, boca, crear, llamar } = await datos(t);
  const destino = await db.get("SELECT id FROM predio_boca WHERE id <> ? AND es_destino = 1 LIMIT 1", [boca.id]);
  const queso = await crear("USO_INTERNO", "Queso por pieza", 0);
  const porcion = await crear("VENTA_COMPUESTA", "Porción de queso", 0);
  await llamar(admin, "PUT", "/productos/" + porcion.id, { receta: { insumo_id: queso.id, rendimiento: 8 } });
  const comun = await crear("VENTA_DIRECTA", "Gaseosa", 0);
  const cuerpo = producto_id => ({ boca_origen_id: boca.id, boca_destino_id: destino.id, lineas: [{ producto_id, cantidad: 0.5 }] });
  await assert.rejects(llamar(admin, "POST", "/traspasos", { ...cuerpo(comun.id), confirmar_fraccionado: true }), { codigo: "SIN_STOCK" });
  await assert.rejects(llamar(admin, "POST", "/traspasos", { ...cuerpo(queso.id), confirmar_sin_stock: true }), { codigo: "STOCK_INSUFICIENTE" });
  await llamar(admin, "POST", "/traspasos", { ...cuerpo(queso.id), confirmar_fraccionado: true });
  assert.equal(await N.stockActual(db, admin, boca.id, queso.id), -0.5);
  assert.equal(await N.stockActual(db, admin, destino.id, queso.id), 0.5);
  await assert.rejects(llamar(admin, "POST", "/bajas", { boca_id: boca.id, producto_id: queso.id, cantidad: 1, motivo: "VENCIMIENTO", confirmar_sin_stock: true }), { codigo: "SIN_STOCK" });
  const solicitud = await llamar(admin, "POST", "/solicitudes", { ...cuerpo(comun.id), confirmar_sin_stock: true });
  await assert.rejects(llamar(admin, "POST", "/solicitudes/" + solicitud.ids[0] + "/despachar", { confirmar_fraccionado: true }), { codigo: "SIN_STOCK" });
  const s = await llamar(admin, "GET", "/solicitudes/" + solicitud.ids[0]);
  assert.equal(s.solicitud.estado, "PENDIENTE");
});


test("un paquete alcanza para seis cobros separados con un rendimiento de seis porciones", async t => {
  const { db, admin, cajero, boca, crear, llamar } = await datos(t);
  const paquete = await crear("USO_INTERNO", "Paquete", 1);
  const taza = await crear("VENTA_COMPUESTA", "Taza", 0);
  await llamar(admin, "PUT", "/productos/" + taza.id, { receta: { insumo_id: paquete.id, rendimiento: 6 } });
  for (let restantes = 6; restantes > 0; restantes--) {
    const [p] = await llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1", q: "Taza" });
    assert.equal(p.stock_boca, restantes);
    await llamar(cajero, "POST", "/ventas", { items: [{ producto_id: taza.id, cantidad: 1 }], forma_pago: "QR" });
  }
  assert.equal(await N.stockActual(db, admin, boca.id, paquete.id), 0);
});


test("los rendimientos altos conservan cada porción hasta la última milésima", async t => {
  const { db, admin, cajero, boca, crear, llamar } = await datos(t);
  const Porciones = require("../lib/porciones");
  for (const rinde of [600, 750]) {
    let saldo = 1;
    for (let restantes = rinde; restantes > 0; restantes--) {
      assert.equal(Porciones.disponibles(saldo, rinde), restantes);
      saldo = Math.round(1000 * (saldo - Porciones.consumo(saldo, rinde, 1))) / 1000;
    }
    assert.equal(saldo, 0);
    const base = await crear("USO_INTERNO", "Paquete " + rinde, 1);
    const p = await crear("VENTA_COMPUESTA", "Porción " + rinde, 0);
    await llamar(admin, "PUT", "/productos/" + p.id, { receta: { insumo_id: base.id, rendimiento: rinde } });
    const buscar = () => llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1", q: "Porción " + rinde });
    const cobrar = cantidad => llamar(cajero, "POST", "/ventas", { items: [{ producto_id: p.id, cantidad }], forma_pago: "QR" });
    assert.equal((await buscar())[0].stock_boca, rinde);
    await assert.rejects(cobrar(rinde + 1), { codigo: "SIN_STOCK" });
    await cobrar(rinde - 1);
    assert.equal((await buscar())[0].stock_boca, 1);
    await cobrar(1);
    assert.equal(await N.stockActual(db, admin, boca.id, base.id), 0);
  }
});
