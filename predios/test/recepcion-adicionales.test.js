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
