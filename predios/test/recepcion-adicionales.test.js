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
  const saldoCaja = await db.get("SELECT SUM(CASE WHEN tipo='INGRESO' THEN importe ELSE -importe END) AS neto FROM predio_caja_movimiento WHERE concepto='ADICIONAL_ESTADIA'");
  assert.equal(Number(saldoCaja.neto), 0);
});

test("cobro de varios artículos con un solo comprobante, reintento idempotente y reimpresión con anulaciones", async t => {
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
  const ver = numero => call("GET", "/recepcion/410/articulos/comprobante/" + numero);
  const pagos = () => db.all("SELECT id, adicional_id, importe, medio, comprobante FROM predio_estadia_mov WHERE concepto='PAGO_ADICIONAL' ORDER BY id");
  const enCaja = () => db.all("SELECT tipo, importe FROM predio_caja_movimiento WHERE concepto='ADICIONAL_ESTADIA' ORDER BY id");

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

  // Dos artículos, un comprobante y un solo ingreso de efectivo por el total.
  const body = { operacion: U.uuid(), medio: "EFECTIVO", caja_id: caja.id, detalle: "Paga en recepción",
    items: [{ adicional_id: 1, importe: 6000 }, { adicional_id: 2, importe: 4000 }] };
  const cobro = await cobrar(body);
  assert.equal(cobro.total, 10000);
  assert.match(cobro.mensaje, new RegExp("Cobro de 2 artículos registrado · Comprobante N° " + cobro.comprobante));
  const movs = await pagos();
  assert.deepEqual(movs.map(m => [m.adicional_id, Number(m.importe), m.medio, m.comprobante]),
    [[1, 6000, "EFECTIVO", cobro.comprobante], [2, 4000, "EFECTIVO", cobro.comprobante]]);
  assert.equal(movs[0].id, cobro.comprobante, "el número es el id del primer pago del cobro");
  assert.deepEqual((await enCaja()).map(c => [c.tipo, Number(c.importe)]), [["INGRESO", 10000]]);
  const d = cobro.datos;
  assert.deepEqual(d.items.map(i => [i.nombre, i.modalidad, i.cantidad, i.importe, i.anulado]),
    [["Sombrilla", "ALQUILER", 2, 6000, false], ["Carbón", "VENTA", 3, 4000, false]]);
  assert.deepEqual([d.numero, d.estado, d.medio, d.empleado, d.observacion, d.total, d.vigente], [cobro.comprobante, "VIGENTE", "EFECTIVO", "Recepción", "Paga en recepción", 10000, 10000]);
  assert.deepEqual([d.reserva.id, d.reserva.titular_nombre, d.reserva.titular_dni], [410, "Demo, Ana", "99800100"]);
  assert.equal(d.empresa.razon_social, "Asociación Judicial Bonaerense");

  // Reintento con la misma operación: misma respuesta, sin duplicar pagos ni efectivo.
  assert.deepEqual(await cobrar(body), cobro);
  assert.equal((await pagos()).length, 2);
  assert.equal((await enCaja()).length, 1);
  await assert.rejects(cobrar({ ...body, detalle: "Otra cosa" }), /ya utilizado/);

  let detalle = await call("GET", "/recepcion/detalle", {}, { id: r.id });
  const porId = id => detalle.adicionales.find(a => a.adicional_id === id);
  assert.deepEqual([porId(1).adeudado, porId(2).pagado, porId(2).adeudado], [0, 4000, 5000]);
  assert.equal(detalle.cuenta.pendiente, 5000);

  // «Registrar pago» de un solo artículo usa el mismo cobro: comprobante propio y la transferencia no pasa por la caja.
  const segundo = await cobrar({ operacion: U.uuid(), medio: "TRANSFERENCIA", items: [{ adicional_id: 2, importe: 5000 }] });
  assert.ok(segundo.comprobante > cobro.comprobante);
  assert.match(segundo.mensaje, /^Pago de Carbón registrado · Comprobante N° /);
  assert.equal((await enCaja()).length, 1);
  detalle = await call("GET", "/recepcion/detalle", {}, { id: r.id });
  assert.equal(detalle.cuenta.pendiente, 0);

  // Reimpresión: mismos datos; al anular un pago, el comprobante lo detalla.
  const reimpreso = await ver(cobro.comprobante);
  assert.deepEqual(reimpreso, d);
  await call("POST", "/recepcion/410/adicional", { operacion: U.uuid(), accion: "ANULAR_PAGO", adicional_id: 1, movimiento_id: movs[0].id, caja_id: caja.id, detalle: "Se cobró de más" });
  let anulado = await ver(cobro.comprobante);
  assert.deepEqual([anulado.estado, anulado.total, anulado.anulado, anulado.vigente], ["ANULADO_PARCIAL", 10000, 6000, 4000]);
  const sombrilla = anulado.items.find(i => i.adicional_id === 1);
  assert.deepEqual([sombrilla.anulado, sombrilla.anulacion.motivo, sombrilla.anulacion.usuario_nombre], [true, "Se cobró de más", "Recepción"]);
  assert.equal(anulado.items.find(i => i.adicional_id === 2).anulado, false);
  await call("POST", "/recepcion/410/adicional", { operacion: U.uuid(), accion: "ANULAR_PAGO", adicional_id: 2, movimiento_id: movs[1].id, caja_id: caja.id });
  anulado = await ver(cobro.comprobante);
  assert.deepEqual([anulado.estado, anulado.vigente], ["ANULADO", 0]);
  assert.equal(anulado.items.find(i => i.adicional_id === 2).anulacion.motivo, null);
  assert.equal((await ver(segundo.comprobante)).estado, "VIGENTE");
  assert.deepEqual((await enCaja()).map(c => [c.tipo, Number(c.importe)]), [["INGRESO", 10000], ["EGRESO", 6000], ["EGRESO", 4000]]);

  // Un número que no es un pago de artículo de la reserva no se imprime.
  await assert.rejects(ver(1), /No encontramos ese comprobante/);
  await assert.rejects(ver(99999), /No encontramos ese comprobante/);
  // Un pago individual anterior a los comprobantes (sin número) se reimprime con su propio id.
  await call("POST", "/recepcion/410/adicional", { operacion: U.uuid(), accion: "PAGAR", adicional_id: 1, medio: "TRANSFERENCIA", importe: 1000 });
  const viejo = (await pagos()).pop();
  assert.equal(viejo.comprobante, null);
  const legado = await ver(viejo.id);
  assert.deepEqual([legado.numero, legado.total, legado.items.length, legado.items[0].nombre], [viejo.id, 1000, 1, "Sombrilla"]);
});
