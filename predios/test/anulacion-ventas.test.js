"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const api = require("../lib/api");

test("sólo la confirmación autorizada devuelve stock y efectivo una vez por venta", async t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  t.after(() => db.cerrar());
  asegurarEsquema(db);
  const admin = { db, pid: 1, modo: "local", usuario: { id: 1, rol: "ADMIN", nombre: "Admin" } };
  await db.tx(tx => sembrarPredio(tx, admin, "MIRAMAR"));
  const [caja, otra] = await db.all("SELECT * FROM predio_caja ORDER BY id LIMIT 2");
  const cajero = { ...admin, usuario: { id: 2, rol: "CAJERO", nombre: "Cajero", bocas: [caja.boca_id] },
    sesion: { boca_id: caja.boca_id, caja_id: caja.id, turno_id: 1 } };
  const post = (actor, ruta, body) => api.ejecutar({ ...actor, body }, "POST", ruta);
  const get = (actor, ruta, query) => api.ejecutar({ ...actor, query }, "GET", ruta);
  const producto = await post(admin, "/productos", { nombre: "Gaseosa", destino: "VENTA_DIRECTA", precio_venta_manual: 100 });
  await db.tx(async tx => {
    await N.insertar(tx, cajero, "predio_turno", { ...cajero.sesion, usuario_id: 2, inicio: "2026-11-05 09:00:00", estado: "ABIERTO" });
    await N.moverStock(tx, admin, { productoId: producto.id, bocaId: caja.boca_id, cantidad: 4, tipo: "AJUSTE" });
  });
  const items = [{ producto_id: producto.id, cantidad: 2 }];
  const { id: venta } = await post(cajero, "/ventas", { items, forma_pago: "EFECTIVO" });
  const { id: segunda } = await post(cajero, "/ventas", { items, forma_pago: "QR" });
  const motivo = "Ticket duplicado";
  const solicitar = (actor, id) => post(actor, "/permisos", { tipo: "ANULAR_VENTA", referencia_id: id, detalle: motivo });
  const pendientes = () => get(admin, "/listados/ventas", { f_estado: "PENDIENTE_ANULACION" });
  const ruta = "/ventas/" + venta + "/anular";
  const delegado = { ...cajero, usuario: { ...cajero.usuario, puede_anular_ticket: 1 } };
  const ajeno = { ...delegado, sesion: { ...delegado.sesion, caja_id: otra.id } };
  await assert.rejects(solicitar(ajeno, venta), { status: 403 });
  await assert.rejects(post(ajeno, ruta, { motivo }), { status: 403 });
  const [primero, repetido] = await Promise.all([solicitar(cajero, venta), solicitar(cajero, venta)]);
  assert.equal(repetido.id, primero.id);
  assert.deepEqual((await pendientes()).filas.map(f => f.id), [venta]);
  assert.equal((await get(cajero, "/ventas/" + venta)).venta.solicitud_anulacion.detalle, motivo);
  assert.equal((await db.get("SELECT estado FROM predio_venta WHERE id=?", [venta])).estado, "CONFIRMADA");
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_caja_movimiento WHERE tipo='EGRESO'")).n, 0);
  assert.equal(await N.stockActual(db, admin, caja.boca_id, producto.id), 0);
  const encargadoCierre = { ...cajero, usuario: { ...cajero.usuario, puede_cerrar_caja: 1 } };
  await assert.rejects(post(encargadoCierre, "/caja/cierre", { efectivo_contado: 0 }), { codigo: "ANULACIONES_PENDIENTES" });
  await assert.rejects(post(cajero, ruta, { motivo, permiso_id: primero.id }), { status: 403 });
  await assert.rejects(post(cajero, "/permisos/" + primero.id + "/resolver", { aprobar: true }), { status: 403 });
  await post(admin, "/permisos/" + primero.id + "/resolver", { aprobar: false });
  await assert.rejects(post(admin, ruta, { motivo, solicitud_id: primero.id }), { status: 409 });
  assert.equal((await pendientes()).total, 0);
  const pedido = await solicitar(cajero, venta);
  const resultados = await Promise.allSettled([
    post(admin, "/permisos/" + pedido.id + "/resolver", { aprobar: true }),
    post(delegado, ruta, { motivo, solicitud_id: pedido.id }),
  ]);
  assert.equal(resultados.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(resultados.find(r => r.status === "fulfilled").value.devolver_efectivo, 200);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_caja_movimiento WHERE venta_id=? AND importe=200 AND tipo='EGRESO'", [venta])).n, 1);
  assert.equal(await N.stockActual(db, admin, caja.boca_id, producto.id), 2);
  assert.equal((await db.get("SELECT estado FROM predio_permiso WHERE id=?", [pedido.id])).estado, "USADO");
  assert.equal((await pendientes()).total, 0);
  await post(delegado, "/ventas/" + segunda + "/anular", { motivo });
  assert.equal((await db.get("SELECT anulacion_autorizacion FROM predio_venta WHERE id=?", [segunda])).anulacion_autorizacion, "DELEGADO");

  const afiliado = await post(admin, "/afiliados", { dni: "30111222", nombre: "Afiliado con consumos históricos", limite: 2000 });
  const historica = await db.tx(tx => N.insertar(tx, cajero, "predio_venta", {
    ...cajero.sesion, usuario_id: 2, afiliado_id: afiliado.id, estado: "CONFIRMADA", forma_pago: "DESCUENTO", total: 450, fecha: "2026-11-05 12:00:00",
  }));
  const hacerLiquidacion = () => post(admin, "/afiliados/" + afiliado.id + "/liquidaciones", { forma_pago: "DESCUENTO_HABERES" });
  const historicoPendiente = await solicitar(cajero, historica);
  await assert.rejects(hacerLiquidacion(), /anulación pendiente/);
  await post(admin, "/permisos/" + historicoPendiente.id + "/resolver", { aprobar: false });
  assert.equal((await hacerLiquidacion()).total, 450);
  await assert.rejects(solicitar(cajero, historica), /liquidación del afiliado/);

  const posterior = await db.tx(tx => N.insertar(tx, cajero, "predio_venta", {
    ...cajero.sesion, usuario_id: 2, estado: "CONFIRMADA", forma_pago: "EFECTIVO", total: 30, fecha: "2026-11-05 13:00:00",
  }));
  await post(encargadoCierre, "/caja/cierre", { efectivo_contado: 0 });
  await assert.rejects(post(admin, "/ventas/" + posterior + "/anular", { motivo }), /caja se cerró/);
});
