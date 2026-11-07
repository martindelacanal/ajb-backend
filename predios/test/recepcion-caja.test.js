"use strict";

const test = require("node:test"),
  assert = require("node:assert/strict"),
  {
    crearSqlite,
    asegurarEsquema
  } = require("../lib/db-sqlite");
const {
    sembrarPredio
  } = require("../lib/semilla"),
  api = require("../lib/api"),
  N = require("../lib/negocio"),
  U = require("../lib/util");
test("saldo personal, reparto, venta mixta y reversión conservan stock, caja y pasivos", async t => {
  const db = crearSqlite(":memory:", {
    predioId: 1
  });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const r = {
    id: 315,
    usuario_id: 135,
    afiliado: 0,
    titular_dni: "99911222",
    titular_nombre: "Demo",
    precio_total: 0,
    diferencia: 0,
    personas: [{
      dni: "99911222",
      nombre: "Uno",
      apellido: "Ejemplo",
      entrada: U.hoy()
    }, {
      dni: "99911223",
      nombre: "Dos",
      apellido: "Ejemplo",
      entrada: U.hoy()
    }]
  };
  const ctx = {
    db,
    pid: 1,
    modo: "local",
    origen: "LOCAL",
    usuario: {
      id: 1,
      rol: "ADMIN",
      nombre: "Empleada"
    },
    servicios: {
      recepcion: async k => k === "guardar" ? r : {
        reserva: r
      }
    },
    sesion: {}
  };
  await db.tx(tx => sembrarPredio(tx, ctx, "MIRAMAR"));
  const caja = await db.get("SELECT * FROM predio_caja LIMIT 1");
  ctx.sesion = {
    caja_id: caja.id,
    boca_id: caja.boca_id
  };
  const call = (m, p, b = {}, query = {}, usuario = ctx.usuario) => api.ejecutar({
    ...ctx,
    usuario,
    body: b,
    query
  }, m, p);
  await assert.rejects(call("GET", "/recepcion/detalle", {}, {}, {
    id: 2,
    rol: "CAJERO"
  }), e => e.status === 403);
  const alta = {
    operacion: U.uuid()
  };
  await call("POST", "/recepcion/guardar", alta);
  await call("POST", "/recepcion/guardar", alta);
  const cuenta = () => call("GET", "/recepcion/detalle", {}, {
    id: r.id
  }).then(x => x.cuenta);
  const [a, b] = (await cuenta()).personas;
  const mover = datos => call("POST", "/recepcion/315/cuenta", {
    operacion: U.uuid(),
    ...datos
  });
  await assert.rejects(mover({
    accion: "CARGA",
    medio: "AL_SALIR",
    huesped_id: a.id,
    importe: 100
  }), /particulares/);
  const antesDeCargar = await call("POST", "/recepcion/cotizar", { id: r.id });
  await mover({
    accion: "CARGA",
    medio: "EFECTIVO",
    huesped_id: a.id,
    importe: 100
  });
  await assert.rejects(call("POST", "/recepcion/guardar", {
    operacion: U.uuid(), id: r.id, cuenta_esperada: antesDeCargar.cuenta
  }), /Cambió la cuenta/);
  assert.deepEqual((await call("POST", "/recepcion/cotizar", { id: r.id })).cuenta,
    { pendiente: 0, neto_consumos: -100 });
  await mover({
    accion: "REPARTIR",
    huesped_id: a.id,
    destino_id: b.id,
    importe: 40
  });
  const p = await call("POST", "/productos", {
    nombre: "Producto",
    destino: "VENTA_DIRECTA",
    precio_venta_manual: 100
  });
  await db.tx(tx => N.moverStock(tx, ctx, {
    bocaId: caja.boca_id,
    productoId: p.id,
    cantidad: 4,
    tipo: "AJUSTE"
  }));
  const venta = {
    items: [{
      producto_id: p.id,
      cantidad: 0.5
    }],
    forma_pago: "MIXTO",
    pagos: [{
      forma: "SALDO",
      huesped_id: b.id,
      importe: 30
    }, {
      forma: "EFECTIVO",
      importe: 20
    }],
    recibido: 25
  };
  const intento = { ...venta, operacion: U.uuid() };
  const v = await call("POST", "/ventas", intento);
  assert.deepEqual(await call("POST", "/ventas", { ...intento, confirmar_sin_stock: true }), v);
  await assert.rejects(call("POST", "/ventas", { ...intento, recibido: 30 }), e => e.status === 409);
  assert.equal(v.vuelto, 5);
  const { resumen } = await call("GET", "/caja/estado");
  assert.equal(resumen.ventas_cantidad, 1);
  assert.equal(resumen.ventas_total, 50);
  assert.equal(resumen.ventas_efectivo, 20);
  assert.equal(resumen.saldo_esperado, 120);
  assert.equal((await call("GET", "/saldos/presentes", {}, { q: "99.911.223" }))[0].id, b.id);
  const sugerencias = await call("GET", "/saldos/presentes", {}, { q: "99.911" });
  assert.deepEqual(sugerencias.map(p => p.id).sort(), [a.id, b.id].sort());
  assert.ok(sugerencias.every(p => !p.exacto));
  assert.deepEqual(await call("GET", "/saldos/presentes", {}, { q: "%" }), []);
  assert.equal((await cuenta()).saldo, 70);
  assert.equal((await db.get("SELECT importe FROM predio_caja_movimiento WHERE venta_id=?", [v.id])).importe, 20);
  await assert.rejects(call("POST", "/ventas", venta), /saldo no alcanza/);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_venta")).n, 1);
  const operador = { id: 2, rol: "CAJERO", nombre: "Cajero", bocas: [caja.boca_id] };
  const pedirAnulacion = id => call("POST", "/permisos", {
    tipo: "ANULAR_VENTA", referencia_id: id, detalle: "Duplicada"
  }, {}, operador);
  const solicitud = await pedirAnulacion(v.id);
  await assert.rejects(mover({ accion: "LIQUIDAR", medio: "EFECTIVO", esperado: -70 }), /anulación pendiente/);
  assert.equal((await cuenta()).saldo, 70);
  assert.equal((await call("POST", "/permisos/" + solicitud.id + "/resolver", { aprobar: true })).devolver_efectivo, 20);
  assert.equal((await cuenta()).saldo, 100);
  assert.equal((await cuenta()).consumos, 0);
  r.personas[1].salida = U.hoy();
  await call("POST", "/recepcion/guardar", {
    operacion: U.uuid()
  });
  assert.deepEqual(await call("GET", "/saldos/presentes", {}, {
    q: r.personas[1].dni
  }), []);
  await assert.rejects(call("POST", "/ventas", venta), /presente/);
  const devolucion = { accion: "LIQUIDAR", medio: "EFECTIVO", esperado: -100 };
  const dobles = await Promise.allSettled([mover(devolucion), mover(devolucion)]);
  assert.deepEqual(dobles.map(x => x.status).sort(), ["fulfilled", "rejected"]);
  const devuelto = await db.get("SELECT COUNT(*) AS movimientos, SUM(importe) AS importe FROM predio_caja_movimiento WHERE concepto='LIQUIDACION_ESTADIA' AND tipo='EGRESO'");
  assert.deepEqual({ ...devuelto }, { movimientos: 1, importe: 100 });
  assert.equal((await cuenta()).saldo, 0);
  assert.equal((await cuenta()).neto_consumos, 0);
  assert.equal((await cuenta()).cierre_pendiente, false);
  // El anticipo en efectivo ya fue devuelto. Una carga nueva por transferencia
  // no habilita un segundo retiro contra ese anticipo anterior.
  await mover({ accion: "CARGA", medio: "TRANSFERENCIA", huesped_id: a.id, importe: 50 });
  await assert.rejects(mover({ accion: "RETIRO", medio: "EFECTIVO", huesped_id: a.id, importe: 50 }), /por ese medio/);
  const consumido = await call("POST", "/ventas", { items: venta.items, forma_pago: "SALDO", huesped_id: a.id });
  assert.equal((await cuenta()).neto_consumos, 0);
  assert.equal((await cuenta()).saldo, 0);
  assert.equal((await cuenta()).cierre_pendiente, true);
  await mover({ accion: "LIQUIDAR", medio: "EFECTIVO", esperado: 0 });
  await assert.rejects(mover({ accion: "LIQUIDAR", medio: "EFECTIVO", esperado: 0 }), /No hay consumos/);
  await assert.rejects(call("POST", "/ventas/" + consumido.id + "/anular", { motivo: "Cerrada" }), /liquidó/);
  await assert.rejects(pedirAnulacion(consumido.id), /liquidó/);
  // La planilla no liquida la parte en efectivo de una venta combinada.
  r.afiliado = 1;
  r.personas[0].legajo = "L-23";
  await call("POST", "/recepcion/guardar", {
    operacion: U.uuid()
  });
  const afiliado = await db.tx(tx => N.insertar(tx, ctx, "predio_afiliado", {
    dni: r.titular_dni,
    nombre: "Prueba",
    usuario_general_id: r.usuario_id,
    limite: 30,
    habilitado_descuento: 1,
    origen: "SISTEMA"
  }));
  assert.deepEqual((await call("GET", "/saldos/presentes", {}, { q: "l-2" })).map(p => [p.id, p.exacto]), [[a.id, false]]);
  assert.deepEqual((await call("GET", "/saldos/presentes", {}, { q: "l-23" })).map(p => [p.id, p.exacto]), [[a.id, true]]);
  await assert.rejects(call("POST", "/ventas", {
    items: venta.items,
    forma_pago: "MIXTO",
    pagos: [{
      forma: "DESCUENTO",
      importe: 25,
      huesped_id: a.id
    }, {
      forma: "QR",
      importe: 25
    }]
  }), /Elegí Saldo/);
  await assert.rejects(call("POST", "/ventas", { items: venta.items, forma_pago: "SALDO", huesped_id: a.id }), /saldo no alcanza/);
  const carga = {
    operacion: U.uuid(),
    accion: "CARGA",
    huesped_id: a.id,
    importe: 80,
    medio: "AL_SALIR"
  };
  await mover(carga);
  await mover(carga);
  assert.equal((await cuenta()).saldo, 80);
  await mover({ accion: "CARGA", medio: "TRANSFERENCIA", huesped_id: a.id, importe: 10 });
  const mixta = await call("POST", "/ventas", {
    items: [{ producto_id: p.id, cantidad: 1 }], forma_pago: "MIXTO",
    pagos: [{ forma: "SALDO", huesped_id: a.id, importe: 50 }, { forma: "QR", importe: 50 }]
  });
  assert.deepEqual(mixta.ticket.pagos.map(p => [p.forma, p.importe]), [["SALDO", 50], ["QR", 50]]);
  assert.equal(mixta.ticket.venta.importe_haberes, null);
  assert.equal((await cuenta()).saldo, 40);
  // Ficha manual aún sin enlazar por la sincronización de Turismo.
  await db.tx(tx => N.actualizar(tx, ctx, "predio_afiliado", afiliado, { usuario_general_id: null, origen: "MANUAL" }));
  const pedidoPlanilla = { operacion: U.uuid(), accion: "LIQUIDAR", medio: "HABERES", esperado: 40 };
  // Dos pestañas intentan saldar la misma cuenta y la primera reenvía su
  // petición al perder la respuesta. Sólo corresponde emitir una planilla.
  const [primera, reenvio, otra] = await Promise.allSettled([
    mover(pedidoPlanilla), mover(pedidoPlanilla), mover({ ...pedidoPlanilla, operacion: U.uuid() }),
  ]);
  assert.equal(primera.status, "fulfilled");
  assert.deepEqual(reenvio, primera);
  assert.equal(otra.status, "rejected");
  assert.match(otra.reason.message, /No hay consumos|importe cambió/);
  const planilla = primera.value;
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_estadia_mov WHERE concepto='SALDAR_CONSUMOS' AND medio='HABERES'")).n, 1);
  assert.ok(planilla.liquidacion_id);
  const impresa = await call("GET", "/recepcion/315/planilla/" + planilla.liquidacion_id);
  assert.equal(impresa.liquidacion.total, 40);
  assert.equal(impresa.afiliado.id, afiliado);
  assert.equal(impresa.afiliado.limite, 30);
  assert.equal(impresa.estadia.reserva_id, r.id);
  assert.match(impresa.estadia.lineas[1].concepto, /Ticket/);
  assert.deepEqual(impresa.estadia.lineas.map(m => m.importe), [-10, 50]);
  assert.equal((await cuenta()).neto_consumos, 0);
  assert.equal((await db.get("SELECT SUM(CASE WHEN tipo='INGRESO' THEN importe ELSE -importe END) AS n FROM predio_caja_movimiento")).n, 0);

  // Un cobro en el mismo segundo que el cierre pertenece al período nuevo.
  const mismaHora = U.fechaHora();
  t.mock.method(U, "fechaHora", () => mismaHora);
  await db.tx(tx => N.insertar(tx, ctx, "predio_usuario", { usuario: "recepcion", nombre: "Empleada", rol: "ADMIN", activo: 1 }));
  const { clave } = await call("POST", "/caja/cierre/clave", { caja_id: caja.id });
  await call("POST", "/caja/cierre", { caja_id: caja.id, efectivo_contado: 0, clave });
  const siguiente = await call("POST", "/ventas", {
    items: venta.items, forma_pago: "MIXTO",
    pagos: [{ forma: "EFECTIVO", importe: 20 }, { forma: "QR", importe: 30 }],
  });
  const abierta = (await call("GET", "/caja/estado")).resumen;
  assert.equal(abierta.ventas_cantidad, 1);
  assert.equal(abierta.ventas_total, 50);
  assert.equal(abierta.ventas_efectivo, 20);
  await call("POST", "/ventas/" + siguiente.id + "/anular", { motivo: "Anulación de la nueva caja" });
  assert.equal((await call("GET", "/caja/estado")).resumen.saldo_esperado, 0);
});
