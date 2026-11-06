"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const api = require("../lib/api");
const { digitoControl, gtinValido, proximidadCodigo } = require("../lib/codigo-barras");

async function escenario(t) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", origen: "LOCAL", ip: "192.168.1.7", usuario: { id: 1, nombre: "Admin", rol: "ADMIN", bocas: [] }, sesion: {} };
  await db.tx(async (tx) => sembrarPredio(tx, ctx, "MIRAMAR"));
  const boca = await db.get("SELECT id FROM predio_boca WHERE nombre = 'Proveeduría'");
  const caja = await db.get("SELECT id FROM predio_caja WHERE boca_id = ? ORDER BY id LIMIT 1", [boca.id]);
  const cajero = { ...ctx, usuario: { id: 2, nombre: "Operador", rol: "CAJERO", bocas: [boca.id] }, sesion: { boca_id: boca.id, caja_id: caja.id } };
  const llamar = (actor, metodo, ruta, body = {}, query = {}) => api.ejecutar({ ...actor, body, query }, metodo, ruta);
  const crear = async (nombre, codigo, destino = "VENTA_DIRECTA") => llamar(ctx, "POST", "/productos", { nombre, codigo, precio_venta_manual: 1000, destino });
  const mover = async (id, cantidad) => db.tx((tx) => N.moverStock(tx, ctx, { bocaId: boca.id, productoId: id, cantidad, tipo: "AJUSTE" }));
  return { db, ctx, cajero, llamar, crear, mover, boca, caja };
}

test("el dígito de control se calcula sin asumir que un código de 12 dígitos está truncado", () => {
  assert.equal(digitoControl("629104150021"), "3");
  assert.equal(gtinValido("6291041500213"), true);
  assert.equal(gtinValido("036000291452"), true); // UPC válido, no un EAN incompleto.
  assert.equal(gtinValido("6291041500218"), false);
  assert.equal(proximidadCodigo("779089500043", "7790895000430"), 1);
  assert.equal(proximidadCodigo("77908950", "7790895000430"), 5);
  assert.equal(proximidadCodigo("779089500043", "779089500034"), 2);
  assert.equal(proximidadCodigo("123", "1234567890123"), null);
  assert.equal(proximidadCodigo("779089500043", "8888888888888"), null);
});

test("la búsqueda de ventas respeta boca, stock y coincidencias aproximadas sin marcarlas exactas", async (t) => {
  const { cajero, llamar, crear, mover } = await escenario(t);
  const truncado = await crear("Coca en stock", "779089500043");
  const agotado = await crear("Coca agotada", "7790895000997");
  const interna = await crear("Coca de uso interno", "7790895000898", "USO_INTERNO");
  const servicio = await crear("Alquiler sin movimientos", null, "ALQUILER");
  await mover(truncado.id, 3);
  await mover(interna.id, 9);
  const lista = await llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1" });
  assert.deepEqual(new Set(lista.map((p) => p.id)), new Set([truncado.id]));
  const leido = await llamar(cajero, "GET", "/productos/buscar", {}, { q: "7790895000430", venta: "1" });
  assert.equal(leido[0].id, truncado.id);
  assert.equal(leido[0].exacto, false);
  assert.equal(leido[0].sugerido, true);
  assert.equal(leido[0].coincidencia, "CODIGO_APROXIMADO");
  assert.equal(leido[0].precio_compra, undefined);
  assert.deepEqual(await llamar(cajero, "GET", "/productos/buscar", {}, { q: "7790895000997", venta: "1" }), []);
  const excepcion = await llamar(cajero, "GET", "/productos/buscar", {}, { q: "Coca", venta: "1", sin_stock: "1" });
  assert.deepEqual(excepcion, []);
  const diagnostico = await llamar(cajero, "GET", "/productos/consultar-codigo", {}, { codigo: "7790895000997" });
  assert.equal(diagnostico.estado, "SIN_STOCK");
  assert.equal(diagnostico.producto.id, agotado.id);
  assert.deepEqual(await llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1", sin_stock: "1" }), []);
  await assert.rejects(llamar(cajero, "GET", "/productos/buscar", {}, { venta: "1", boca_id: "999" }), { status: 403 });
  await assert.rejects(llamar({ ...cajero, sesion: {} }, "GET", "/productos/buscar", {}, { venta: "1" }), { status: 409, codigo: "SIN_PUESTO" });
});

test("la corrección exige cotejo, GTIN válido, código anterior vigente y unicidad", async (t) => {
  const { db, ctx, cajero, llamar, crear, mover } = await escenario(t);
  const p = await crear("Coca cotejada", "779089500043");
  const cuerpo = { codigo_anterior: "779089500043", codigo_nuevo: "7790895000430", confirmar: true };
  await assert.rejects(llamar(cajero, "POST", `/productos/${p.id}/codigo-barras`, { ...cuerpo, confirmar: false }), { status: 400 });
  await assert.rejects(llamar(cajero, "POST", `/productos/${p.id}/codigo-barras`, { ...cuerpo, codigo_nuevo: "7790895000436" }), { status: 400, codigo: "CODIGO_BARRAS_INVALIDO" });
  await assert.rejects(llamar(cajero, "POST", `/productos/${p.id}/codigo-barras`, { ...cuerpo, codigo_anterior: "779089500042" }), { status: 409, codigo: "CODIGO_MODIFICADO" });
  const repetido = await crear("Ya tiene ese código", cuerpo.codigo_nuevo);
  await assert.rejects(llamar(cajero, "POST", `/productos/${p.id}/codigo-barras`, cuerpo), { status: 409, codigo: "CODIGO_DUPLICADO" });
  await llamar(ctx, "PUT", `/productos/${repetido.id}`, { activo: 0 });
  const r = await llamar(cajero, "POST", `/productos/${p.id}/codigo-barras`, cuerpo);
  assert.equal(r.codigo, cuerpo.codigo_nuevo);
  const ficha = await db.get("SELECT * FROM predio_producto WHERE predio_id = 1 AND id = ?", [p.id]);
  assert.equal(ficha.codigo, cuerpo.codigo_nuevo);
  assert.equal(ficha.precio_venta, 1000);
  assert.equal(ficha.nombre, "Coca cotejada");
  await mover(p.id, 1);
  const exactos = await llamar(cajero, "GET", "/productos/buscar", {}, { q: cuerpo.codigo_nuevo, venta: "1" });
  assert.equal(exactos[0].exacto, true);
  assert.equal(exactos[0].sugerido, false);
  const audit = await db.get("SELECT detalle FROM predio_auditoria WHERE entidad_id = ? AND accion LIKE 'Corrección%'", [p.id]);
  assert.equal(JSON.parse(audit.detalle).codigo.antes, cuerpo.codigo_anterior);
  assert.ok(await db.get("SELECT seq FROM predio_outbox WHERE tabla = 'predio_producto' AND fila_id = ?", [p.id]));
});

test("el intento sin stock avisa a administradores sin modificar stock y funciona con ventas prohibidas", async (t) => {
  const { db, ctx, cajero, llamar, crear, mover, boca, caja } = await escenario(t);
  const p = await crear("Agotado", "7790895000430");
  await assert.rejects(llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: p.id }), { status: 400 });
  await db.tx((tx) => N.guardarConfig(tx, ctx, "vender_sin_stock", "0"));
  const aviso = await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: p.id, busqueda: p.codigo, confirmar: true });
  assert.equal(aviso.puede_vender, false);
  const fila = await db.get("SELECT * FROM predio_aviso WHERE id = ?", [aviso.id]);
  assert.equal(fila.tipo, "VENTA_SIN_STOCK");
  assert.equal(fila.usuario_id, null);
  const detalle = JSON.parse(fila.detalle);
  assert.equal(detalle.boca_id, boca.id);
  assert.equal(detalle.caja_id, caja.id);
  assert.equal(detalle.usuario, "Operador");
  assert.equal(detalle.producto_id, p.id);
  assert.match(detalle.fecha, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(await N.stockActual(db, ctx, boca.id, p.id), 0);
  assert.ok(await db.get("SELECT seq FROM predio_outbox WHERE tabla = 'predio_aviso' AND fila_id = ?", [aviso.id]));
  await mover(p.id, 2);
  await assert.rejects(llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: p.id, confirmar: true }), { status: 409, codigo: "STOCK_DISPONIBLE" });
  const insuficiente = await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { producto_id: p.id, cantidad: 3, confirmar: true });
  assert.ok(insuficiente.id);
  const desconocido = await llamar(cajero, "POST", "/ventas/avisar-sin-stock", { busqueda: "Producto no registrado", confirmar: true });
  assert.equal(desconocido.puede_vender, false);
  assert.ok((await llamar(ctx, "GET", "/avisos")).notificaciones.some((a) => a.id === aviso.id));
  assert.ok(!(await llamar(cajero, "GET", "/avisos")).notificaciones.some((a) => a.id === aviso.id));
});

test("confirmar una venta insuficiente emite aviso persistente y no acepta cadenas como confirmación", async (t) => {
  const { db, cajero, llamar, crear } = await escenario(t);
  const p = await crear("Venta excepcional", "7790895000430");
  const cuerpo = { items: [{ producto_id: p.id, cantidad: 1 }], forma_pago: "QR" };
  await assert.rejects(llamar(cajero, "POST", "/ventas", cuerpo), { status: 409, codigo: "STOCK_INSUFICIENTE" });
  await assert.rejects(llamar(cajero, "POST", "/ventas", { ...cuerpo, confirmar_sin_stock: "false" }), { status: 409, codigo: "STOCK_INSUFICIENTE" });
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_aviso")).n, 0);
  const venta = await llamar(cajero, "POST", "/ventas", { ...cuerpo, confirmar_sin_stock: true });
  const aviso = await db.get("SELECT * FROM predio_aviso WHERE tipo = 'VENTA_SIN_STOCK'");
  assert.equal(JSON.parse(aviso.detalle).venta_id, venta.id);
  assert.equal(JSON.parse(aviso.detalle).faltantes[0].producto_id, p.id);
});

test("dos cajas que intentan consumir la última unidad no venden ambas sin advertencia", async (t) => {
  const { db, ctx, cajero, llamar, crear, mover, boca } = await escenario(t);
  const p = await crear("Última unidad", "7790895000430");
  await mover(p.id, 1);
  await db.tx((tx) => N.guardarConfig(tx, ctx, "vender_sin_stock", "0"));
  const segundaCaja = await db.get("SELECT id FROM predio_caja WHERE boca_id = ? AND id <> ? LIMIT 1", [boca.id, cajero.sesion.caja_id]);
  const otra = { ...cajero, usuario: { ...cajero.usuario, id: 3 }, sesion: { ...cajero.sesion, caja_id: segundaCaja.id } };
  const cuerpo = { items: [{ producto_id: p.id, cantidad: 1 }], forma_pago: "QR" };
  const resultados = await Promise.allSettled([llamar(cajero, "POST", "/ventas", cuerpo), llamar(otra, "POST", "/ventas", cuerpo)]);
  assert.equal(resultados.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(resultados.find((r) => r.status === "rejected").reason.codigo, "SIN_STOCK");
  assert.equal(await N.stockActual(db, ctx, boca.id, p.id), 0);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_venta")).n, 1);
});

test("la validación de venta usa el saldo actual bloqueado aunque una instantánea anterior mostraba unidades", async (t) => {
  const { db, ctx, cajero, llamar, crear, mover } = await escenario(t);
  const p = await crear("Agotado por otra caja", "7790895000430");
  await mover(p.id, 1);
  await mover(p.id, -1);
  await db.tx((tx) => N.guardarConfig(tx, ctx, "vender_sin_stock", "0"));
  // Modelo de REPEATABLE READ: las lecturas normales todavía ven 1; FOR UPDATE
  // ve 0, que es el saldo confirmado por la caja que consumió la última unidad.
  const snapshotDb = { ...db, tx: (trabajo) => db.tx((tx) => trabajo({
    ...tx, forUpdate: " FOR UPDATE",
    get(sql, params) {
      if (/^SELECT cantidad FROM predio_stock/.test(sql) && !sql.endsWith(" FOR UPDATE")) return Promise.resolve({ cantidad: 1 });
      return tx.get(sql.replace(/ FOR UPDATE$/, ""), params);
    },
  })) };
  await assert.rejects(llamar({ ...cajero, db: snapshotDb }, "POST", "/ventas", {
    items: [{ producto_id: p.id, cantidad: 1 }], forma_pago: "QR",
  }), { status: 409, codigo: "SIN_STOCK" });
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_venta")).n, 0);
});
