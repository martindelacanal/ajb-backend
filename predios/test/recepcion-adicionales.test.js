"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const api = require("../lib/api");
const U = require("../lib/util");
const { estadoAdicionales } = require("../lib/api/recepcion");

const hoy = U.hoy();
const ayer = U.sumarDias(hoy, -1);
const anteayer = U.sumarDias(hoy, -2);

function reservaDemo() {
  return {
    id: 410, usuario_id: 9, afiliado: 0, titular_dni: "99800100", titular_nombre: "Demo, Ana", precio_total: 30000, diferencia: 0,
    personas: [{ dni: "99800100", nombre: "Ana", apellido: "Demo", entrada: anteayer }],
    adicionales: [
      { adicional_id: 1, nombre: "Sombrilla", modalidad: "ALQUILER", cantidad: 2, dias: 2, subtotal: 6000, base_turismo: 0, fecha_desde: anteayer, fecha_hasta: ayer },
      { adicional_id: 2, nombre: "Carbón", modalidad: "VENTA", cantidad: 3, dias: 1, subtotal: 9000, base_turismo: 0, fecha_desde: ayer, fecha_hasta: ayer },
      { adicional_id: 3, nombre: "Mascota", modalidad: "ALQUILER", cantidad: 1, dias: 2, subtotal: 4000, base_turismo: 4000 },
    ],
  };
}

test("estado de los artículos: lo que viene de Turismo no se cobra y el saldo de la reserva los cubre", () => {
  const r = reservaDemo();
  const sinPagar = estadoAdicionales(r, { pendiente: 15000, pagos_adicionales: { 1: 2000 }, devoluciones: [] }, hoy);
  const [sombrilla, carbon, mascota] = sinPagar;
  assert.deepEqual([sombrilla.en_predio, sombrilla.pagado, sombrilla.adeudado, sombrilla.sin_devolver, sombrilla.dias_atraso], [6000, 2000, 4000, true, 1]);
  assert.deepEqual([carbon.adeudado, carbon.sin_devolver], [9000, false]);
  assert.deepEqual([mascota.en_predio, mascota.adeudado], [0, 0]);
  const saldada = estadoAdicionales(r, { pendiente: 0, pagos_adicionales: {}, devoluciones: [{ adicional_id: 1, fecha: ayer }] }, hoy);
  assert.deepEqual([saldada[0].adeudado, saldada[0].saldado_con_reserva, saldada[0].devuelto, saldada[0].sin_devolver], [0, true, ayer, false]);
  // Si ya salieron todos, lo no devuelto queda pendiente aunque su período no haya terminado.
  const r2 = reservaDemo();
  r2.personas[0].salida = hoy;
  r2.adicionales[0].fecha_hasta = U.sumarDias(hoy, 3);
  assert.equal(estadoAdicionales(r2, { pendiente: 1, pagos_adicionales: {}, devoluciones: [] }, hoy)[0].sin_devolver, true);
});

test("devolución, pago, anulación y avisos de artículos vencidos se registran en el predio", async t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const r = reservaDemo();
  const ctx = {
    db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, rol: "ADMIN", nombre: "Recepción" }, sesion: {},
    servicios: {
      recepcion: async (accion) => {
        if (accion === "detalle") return { reserva: r, historial: [] };
        if (accion === "vencidas") return { cantidad: 0 };
        if (accion === "alquileres") return { hoy, lineas: r.adicionales.filter(a => a.fecha_desde).map(a => ({ ...a, reserva_id: r.id, titular: r.titular_nombre, todos_salieron: false })) };
        throw new Error("Acción inesperada " + accion);
      },
    },
  };
  await db.tx(tx => sembrarPredio(tx, ctx, "MIRAMAR"));
  const caja = await db.get("SELECT * FROM predio_caja LIMIT 1");
  ctx.sesion = { caja_id: caja.id, boca_id: caja.boca_id };
  // La reserva le debe al predio lo que se agregó en recepción.
  await db.run("INSERT INTO predio_estadia_mov (predio_id,id,reserva_id,fecha,concepto,importe) VALUES (1,1,?,?,'DIFERENCIAL',15000)", [r.id, U.fechaHora()]);
  const call = (m, p, body = {}, query = {}) => api.ejecutar({ ...ctx, body, query }, m, p);
  const operar = datos => call("POST", "/recepcion/410/adicional", { operacion: U.uuid(), ...datos });

  let pendientes = await call("GET", "/recepcion/adicionales-pendientes");
  assert.deepEqual(pendientes.filas.map(f => [f.nombre, f.sin_devolver, f.sin_pagar]), [["Sombrilla", true, true]]);
  assert.equal((await call("GET", "/recepcion/vencidas")).adicionales, 1);

  await assert.rejects(operar({ accion: "DEVOLVER", adicional_id: 2 }), /alquilado/);
  await assert.rejects(operar({ accion: "PAGAR", adicional_id: 1, medio: "EFECTIVO", importe: 7000 }), /supera/);
  await operar({ accion: "PAGAR", adicional_id: 1, medio: "EFECTIVO", importe: 6000, caja_id: caja.id });
  const enCaja = await db.get("SELECT SUM(importe) AS total FROM predio_caja_movimiento WHERE concepto='ADICIONAL_ESTADIA'");
  assert.equal(Number(enCaja.total), 6000);
  await operar({ accion: "DEVOLVER", adicional_id: 1, fecha: ayer });
  pendientes = await call("GET", "/recepcion/adicionales-pendientes");
  assert.equal(pendientes.filas.length, 0);

  let detalle = await call("GET", "/recepcion/detalle", {}, { id: r.id });
  const sombrilla = detalle.adicionales.find(a => a.adicional_id === 1);
  assert.deepEqual([sombrilla.pagado, sombrilla.adeudado, sombrilla.devuelto], [6000, 0, ayer]);
  assert.equal(detalle.cuenta.pendiente, 9000);

  const pago = detalle.cuenta.movimientos.find(m => m.concepto === "PAGO_ADICIONAL");
  await operar({ accion: "ANULAR_PAGO", adicional_id: 1, movimiento_id: pago.id, caja_id: caja.id });
  await assert.rejects(operar({ accion: "ANULAR_PAGO", adicional_id: 1, movimiento_id: pago.id, caja_id: caja.id }), /ya fue anulado/);
  await operar({ accion: "DESHACER_DEVOLUCION", adicional_id: 1 });
  detalle = await call("GET", "/recepcion/detalle", {}, { id: r.id });
  const otraVez = detalle.adicionales.find(a => a.adicional_id === 1);
  assert.deepEqual([otraVez.pagado, otraVez.adeudado, otraVez.devuelto, otraVez.sin_devolver], [0, 6000, null, true]);
  assert.equal(detalle.cuenta.pendiente, 15000);
  const saldoCaja = await db.get("SELECT SUM(CASE WHEN tipo='INGRESO' THEN importe ELSE -importe END) AS neto FROM predio_caja_movimiento WHERE concepto IN ('ADICIONAL_ESTADIA','NOTA_CREDITO')");
  assert.equal(Number(saldoCaja.neto), 0);
});

test("cobro de varios artículos con un solo recibo, reintento idempotente y anulación de pagos con nota de crédito", async t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const r = reservaDemo();
  const ctx = {
    db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, rol: "ADMIN", nombre: "Recepción" }, sesion: {},
    servicios: {
      recepcion: async (accion) => {
        if (accion === "detalle") return { reserva: r, historial: [] };
        throw new Error("Acción inesperada " + accion);
      },
    },
  };
  await db.tx(tx => sembrarPredio(tx, ctx, "MIRAMAR"));
  const caja = await db.get("SELECT * FROM predio_caja LIMIT 1");
  ctx.sesion = { caja_id: caja.id, boca_id: caja.boca_id };
  await db.run("INSERT INTO predio_estadia_mov (predio_id,id,reserva_id,fecha,concepto,importe) VALUES (1,1,?,?,'DIFERENCIAL',15000)", [r.id, U.fechaHora()]);
  const call = (m, p, body = {}, query = {}) => api.ejecutar({ ...ctx, body, query }, m, p);
  const cobrar = body => call("POST", "/recepcion/410/articulos/cobrar", body);
  const ver = id => call("GET", "/contable/comprobantes/" + id);
  const pagos = () => db.all("SELECT id, adicional_id, importe, medio, comprobante FROM predio_estadia_mov WHERE concepto='PAGO_ADICIONAL' ORDER BY id");
  const enCaja = () => db.all("SELECT tipo, importe, concepto, recibo FROM predio_caja_movimiento WHERE concepto IN ('ADICIONAL_ESTADIA','NOTA_CREDITO') ORDER BY id");

  // Validaciones: nada queda registrado si un ítem no corresponde.
  await assert.rejects(cobrar({ operacion: U.uuid(), medio: "EFECTIVO", caja_id: caja.id, items: [{ adicional_id: 1, importe: 6000.01 }] }), /supera lo que falta pagar de Sombrilla/);
  await assert.rejects(cobrar({ operacion: U.uuid(), medio: "EFECTIVO", caja_id: caja.id, items: [{ adicional_id: 1, importe: 100 }, { adicional_id: 2, importe: 9500 }] }), /supera lo que falta pagar de Carbón/);
  await assert.rejects(cobrar({ operacion: U.uuid(), medio: "TRANSFERENCIA", items: [{ adicional_id: 1, importe: 1 }, { adicional_id: 1, importe: 1 }] }), /dos veces/);
  await assert.rejects(cobrar({ operacion: U.uuid(), medio: "TRANSFERENCIA", items: [{ adicional_id: 3, importe: 100 }] }), /supera/, "lo pagado en Turismo no se cobra");
  await assert.rejects(cobrar({ operacion: U.uuid(), medio: "TRANSFERENCIA", items: [{ adicional_id: 99, importe: 100 }] }), /no está en la reserva/);
  await assert.rejects(cobrar({ operacion: U.uuid(), medio: "EFECTIVO", caja_id: caja.id, items: [] }), /al menos un artículo/);
  await assert.rejects(cobrar({ operacion: U.uuid(), medio: "HABERES", items: [{ adicional_id: 1, importe: 100 }] }), /El medio/);
  assert.equal((await pagos()).length, 0);
  assert.equal((await enCaja()).length, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_comprobante")).n, 0);

  // Dos artículos, un recibo y un solo ingreso de efectivo por el total, enlazado al recibo.
  const body = { operacion: U.uuid(), medio: "EFECTIVO", caja_id: caja.id, detalle: "Paga en recepción",
    items: [{ adicional_id: 1, importe: 6000 }, { adicional_id: 2, importe: 4000 }] };
  const cobro = await cobrar(body);
  assert.equal(cobro.total, 10000);
  assert.deepEqual([cobro.comprobante.tipo, cobro.comprobante.numero, cobro.comprobante.codigo], ["RECIBO", 1, "R-00000001"]);
  assert.match(cobro.mensaje, /^Cobro de 2 artículos registrado · Recibo R-00000001$/);
  const movs = await pagos();
  assert.deepEqual(movs.map(m => [m.adicional_id, Number(m.importe), m.medio, m.comprobante]),
    [[1, 6000, "EFECTIVO", cobro.comprobante.id], [2, 4000, "EFECTIVO", cobro.comprobante.id]]);
  assert.deepEqual((await enCaja()).map(c => [c.tipo, Number(c.importe), c.recibo]), [["INGRESO", 10000, "R-00000001"]]);
  const d = cobro.datos;
  assert.deepEqual(d.renglones.map(i => [i.texto, i.rubro, i.articulo.modalidad, i.articulo.cantidad, i.importe]),
    [["Sombrilla", "ARTICULO", "ALQUILER", 2, 6000], ["Carbón", "ARTICULO", "VENTA", 3, 4000]]);
  assert.deepEqual([d.codigo, d.estado, d.medio, d.usuario_nombre, d.observacion, d.total], ["R-00000001", "EMITIDO", "EFECTIVO", "Recepción", "Paga en recepción", 10000]);
  assert.deepEqual([d.estadia.reserva_id, d.cliente.nombre, d.cliente.dni, d.cliente.condicion_iva], [410, "Demo, Ana", "99800100", "Consumidor final"]);
  assert.deepEqual([d.emisor.razon_social, d.emisor.cuit], ["Asociación Judicial Bonaerense", "30-57416579-9"]);
  assert.deepEqual(d.saldo, { reserva: 5000, consumos: 0, total: 5000 });

  // Reintento con la misma operación: misma respuesta, sin duplicar pagos, efectivo ni recibo.
  assert.deepEqual(await cobrar(body), cobro);
  assert.equal((await pagos()).length, 2);
  assert.equal((await enCaja()).length, 1);
  await assert.rejects(cobrar({ ...body, detalle: "Otra cosa" }), /ya utilizado/);

  let detalle = await call("GET", "/recepcion/detalle", {}, { id: r.id });
  const porId = id => detalle.adicionales.find(a => a.adicional_id === id);
  assert.deepEqual([porId(1).adeudado, porId(2).pagado, porId(2).adeudado], [0, 4000, 5000]);
  assert.equal(detalle.cuenta.pendiente, 5000);
  assert.deepEqual(detalle.comprobantes.map(c => [c.codigo, c.total, c.estado]), [["R-00000001", 10000, "EMITIDO"]]);

  // «Registrar pago» de un solo artículo: recibo propio y la transferencia no pasa por la caja.
  const segundo = await cobrar({ operacion: U.uuid(), medio: "TRANSFERENCIA", items: [{ adicional_id: 2, importe: 5000 }] });
  assert.equal(segundo.comprobante.codigo, "R-00000002");
  assert.match(segundo.mensaje, /^Pago de Carbón registrado · Recibo R-00000002$/);
  assert.equal((await enCaja()).length, 1);
  detalle = await call("GET", "/recepcion/detalle", {}, { id: r.id });
  assert.equal(detalle.cuenta.pendiente, 0);

  // La reimpresión trae los mismos datos. Anular el pago de un artículo con recibo emite una nota de crédito sobre ese recibo.
  const reimpreso = await ver(cobro.comprobante.id);
  assert.deepEqual([reimpreso.codigo, reimpreso.total, reimpreso.disponible, reimpreso.renglones.length], ["R-00000001", 10000, 10000, 2]);
  const anula = await call("POST", "/recepcion/410/adicional", { operacion: U.uuid(), accion: "ANULAR_PAGO", adicional_id: 1, movimiento_id: movs[0].id, caja_id: caja.id, detalle: "Se cobró de más" });
  assert.match(anula.mensaje, /^Pago de Sombrilla anulado · Nota de crédito NC-00000001$/);
  let recibo = await ver(cobro.comprobante.id);
  assert.deepEqual([recibo.estado, recibo.devuelto, recibo.disponible], ["EMITIDO", 6000, 4000]);
  assert.deepEqual(recibo.notas_credito.map(n => [n.codigo, n.total, n.motivo]), [["NC-00000001", 6000, "Se cobró de más"]]);
  const nc = await ver(anula.comprobante.id);
  assert.deepEqual([nc.tipo, nc.origen.codigo, nc.renglones[0].texto, nc.renglones[0].origen_mov_id, nc.total, nc.medio],
    ["NOTA_CREDITO", "R-00000001", "Devolución · Sombrilla", movs[0].id, 6000, "EFECTIVO"]);
  await assert.rejects(call("POST", "/recepcion/410/adicional", { operacion: U.uuid(), accion: "ANULAR_PAGO", adicional_id: 1, movimiento_id: movs[0].id, caja_id: caja.id }), /ya fue anulado/);
  assert.deepEqual((await enCaja()).map(c => [c.tipo, Number(c.importe), c.concepto, c.recibo]),
    [["INGRESO", 10000, "ADICIONAL_ESTADIA", "R-00000001"], ["EGRESO", 6000, "NOTA_CREDITO", "NC-00000001"]]);
  detalle = await call("GET", "/recepcion/detalle", {}, { id: r.id });
  assert.deepEqual([porId(1).pagado, porId(1).adeudado], [0, 6000]);

  // Un pago anterior a los comprobantes (sin recibo) se sigue anulando como antes.
  await db.run("INSERT INTO predio_estadia_mov (predio_id,id,reserva_id,fecha,concepto,medio,importe,adicional_id) VALUES (1,900,?,?,'PAGO_ADICIONAL','TRANSFERENCIA',1000,1)", [r.id, U.fechaHora()]);
  const legado = await call("POST", "/recepcion/410/adicional", { operacion: U.uuid(), accion: "ANULAR_PAGO", adicional_id: 1, movimiento_id: 900 });
  assert.deepEqual([legado.mensaje, legado.comprobante], ["Pago de Sombrilla anulado", null]);
});
