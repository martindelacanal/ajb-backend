"use strict";

// Contable: recibos por cada cobro, notas de crédito (parciales y por anulación), anulación de notas de crédito,
// enlaces con la cuenta de la estadía y la caja, historial y listado.

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const api = require("../lib/api");
const U = require("../lib/util");

const hoy = U.hoy();

function reserva(id) {
  return {
    id, usuario_id: 9, afiliado: 1, titular_dni: "30111222", titular_nombre: "Pérez, Ana", titular_legajo: "24812189",
    titular_departamental: "Tandil", titular_direccion: "Calle 9 N° 100", servicio: "Camping Miramar", recursos: [{ nombre: "Parcela" }],
    numero_parcela: 12, ubicacion: "Bajo los pinos", fecha_inicio: hoy, fecha_fin: U.sumarDias(hoy, 2), precio_total: 28000,
    diferencia: 28000, diferenciales: [{ importe: 28000 }],
    personas: [{ dni: "30111222", nombre: "Ana", apellido: "Pérez", entrada: hoy }, { dni: "30111223", nombre: "Luis", apellido: "Pérez", entrada: hoy }],
    vehiculos: [{ patente: "AB123CD", marca: "Fiat", color: "Gris", sector: "B" }],
    adicionales: []
  };
}

async function preparar(t, r) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = {
    db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, rol: "ADMIN", nombre: "Administración" }, sesion: {},
    servicios: { recepcion: async accion => accion === "guardar" ? { ...r, diferenciales: r.diferenciales } : { reserva: r, historial: [] } }
  };
  await db.tx(tx => sembrarPredio(tx, ctx, "MIRAMAR"));
  const caja = await db.get("SELECT * FROM predio_caja LIMIT 1");
  ctx.sesion = { caja_id: caja.id, boca_id: caja.boca_id };
  const call = (m, p, body = {}, query = {}, usuario = ctx.usuario) => api.ejecutar({ ...ctx, usuario, body, query }, m, p);
  return { db, ctx, caja, call };
}

test("recibo, corrección con nota de crédito, anulación y vuelta atrás dejan la cuenta, la caja y el historial en orden", async t => {
  const r = reserva(500);
  const { db, caja, call } = await preparar(t, r);
  const cuenta = async () => (await call("GET", "/recepcion/detalle", {}, { id: r.id })).cuenta;
  const ver = id => call("GET", "/contable/comprobantes/" + id);
  const contable = (id, accion, datos) => call("POST", "/contable/comprobantes/" + id + "/" + accion, { operacion: U.uuid(), ...datos });
  const cajaRecepcion = () => db.all("SELECT tipo, importe, concepto, recibo FROM predio_caja_movimiento WHERE concepto IN ('DIFERENCIA_RESERVA','NOTA_CREDITO') ORDER BY id");

  await call("POST", "/recepcion/guardar", { operacion: U.uuid() });
  assert.equal((await cuenta()).pendiente, 28000);

  // Cobro de la reserva en efectivo: recibo R-00000001 enlazado al movimiento y a la caja.
  const cobro = await call("POST", "/recepcion/500/cuenta", { operacion: U.uuid(), accion: "PAGO_RESERVA", medio: "EFECTIVO", caja_id: caja.id, esperado: 28000, detalle: "Acampar 2 días" });
  assert.equal(cobro.mensaje, "Movimiento registrado · Recibo R-00000001");
  const recibo = cobro.comprobante;
  let d = await ver(recibo.id);
  assert.deepEqual([d.tipo, d.numero, d.total, d.medio, d.operacion, d.observacion, d.disponible], ["RECIBO", 1, 28000, "EFECTIVO", "DIFERENCIA_RESERVA", "Acampar 2 días", 28000]);
  assert.deepEqual(d.renglones.map(l => [l.texto, l.detalle, l.rubro, l.importe]), [["Alojamiento", "Diferencia de la reserva", "ALOJAMIENTO", 28000]]);
  assert.deepEqual(d.cliente, { nombre: "Pérez, Ana", dni: "30111222", legajo: "24812189", departamental: "Tandil", domicilio: "Calle 9 N° 100", afiliado: true, condicion_iva: "Consumidor final" });
  assert.deepEqual([d.estadia.reserva_id, d.estadia.numero_parcela, d.estadia.ubicacion, d.estadia.personas, d.estadia.vehiculos], [500, 12, "Bajo los pinos", 2, [{ patente: "AB123CD", sector: "B" }]]);
  assert.deepEqual([d.emisor.cuit, d.emisor.iibb, d.emisor.inicio_actividades], ["30-57416579-9", "902-316676-5", "01/12/1992"]);
  assert.deepEqual(d.saldo, { reserva: 0, consumos: 0, total: 0 });
  assert.deepEqual([d.puede_anular, d.puede_nota_credito], [true, true]);
  assert.deepEqual(d.historial.map(h => h.accion), ["Recibo emitido"]);
  assert.deepEqual(await cajaRecepcion(), [{ tipo: "INGRESO", importe: 28000, concepto: "DIFERENCIA_RESERVA", recibo: "R-00000001" }]);

  // Se cobró de más: la reserva se corrige (queda $14.000 a favor) y una nota de crédito parcial devuelve la diferencia.
  r.diferencia = -14000;
  r.diferenciales = [{ importe: -14000 }];
  await call("POST", "/recepcion/guardar", { operacion: U.uuid() });
  assert.equal((await cuenta()).pendiente, -14000);
  const renglon = d.renglones[0].movimiento_id;
  await assert.rejects(contable(recibo.id, "nota-credito", { medio: "TRANSFERENCIA", renglones: [{ movimiento_id: renglon, importe: 14000 }] }), /motivo/);
  await assert.rejects(contable(recibo.id, "nota-credito", { medio: "TRANSFERENCIA", motivo: "x", renglones: [{ movimiento_id: renglon, importe: 28000.01 }] }), /supera lo que queda del recibo/);
  await assert.rejects(contable(recibo.id, "nota-credito", { medio: "HABERES", motivo: "x", renglones: [{ movimiento_id: renglon, importe: 1 }] }), /medio/);
  const parcial = await contable(recibo.id, "nota-credito", { medio: "TRANSFERENCIA", motivo: "Se cobraron dos días y estuvo uno", renglones: [{ movimiento_id: renglon, importe: 14000 }] });
  assert.equal(parcial.mensaje, "Nota de crédito NC-00000001 emitida por $ 14.000,00");
  assert.deepEqual([parcial.datos.origen.codigo, parcial.datos.renglones[0].texto, parcial.datos.renglones[0].importe, parcial.datos.saldo.total], ["R-00000001", "Devolución de alojamiento", 14000, 0]);
  assert.equal((await cuenta()).pendiente, 0);
  d = await ver(recibo.id);
  assert.deepEqual([d.estado, d.devuelto, d.disponible, d.notas_credito.map(n => n.codigo)], ["EMITIDO", 14000, 14000, ["NC-00000001"]]);
  assert.deepEqual(d.historial.map(h => h.accion), ["Recibo emitido", "Devolución con nota de crédito"]);
  assert.equal((await cajaRecepcion()).length, 1, "la transferencia no pasa por la caja");

  // Anular el recibo: nota de crédito por lo que quedaba vigente y el recibo queda ANULADO; la reserva vuelve a deber.
  const anulado = await contable(recibo.id, "anular", { medio: "EFECTIVO", caja_id: caja.id, motivo: "Recibo emitido a otro titular" });
  assert.equal(anulado.mensaje, "Recibo R-00000001 anulado · Nota de crédito NC-00000002 por $ 14.000,00");
  assert.equal(anulado.datos.operacion, "ANULACION");
  d = await ver(recibo.id);
  assert.deepEqual([d.estado, d.anulacion.motivo, d.anulacion.nota_credito.codigo, d.disponible, d.puede_anular, d.puede_nota_credito],
    ["ANULADO", "Recibo emitido a otro titular", "NC-00000002", 0, false, false]);
  assert.equal((await cuenta()).pendiente, 14000);
  assert.deepEqual((await cajaRecepcion()).map(c => [c.tipo, c.importe, c.recibo]), [["INGRESO", 28000, "R-00000001"], ["EGRESO", 14000, "NC-00000002"]]);
  await assert.rejects(contable(recibo.id, "anular", { medio: "EFECTIVO", caja_id: caja.id, motivo: "otra vez" }), /ya está anulado/);
  await assert.rejects(contable(recibo.id, "nota-credito", { medio: "EFECTIVO", caja_id: caja.id, motivo: "x", renglones: [{ movimiento_id: renglon, importe: 1 }] }), /está anulado/);
  // La nota de crédito parcial no se anula mientras el recibo siga anulado por otra.
  await assert.rejects(contable(parcial.comprobante.id, "anular", { motivo: "error" }), /anulá primero la nota de crédito de esa anulación \(NC-00000002\)/);

  // Se emite el recibo correcto: un cobro nuevo de lo que quedó pendiente.
  const nuevo = await call("POST", "/recepcion/500/cuenta", { operacion: U.uuid(), accion: "PAGO_RESERVA", medio: "EFECTIVO", caja_id: caja.id, esperado: 14000 });
  assert.equal(nuevo.comprobante.codigo, "R-00000002");
  assert.equal((await cuenta()).pendiente, 0);

  // Vuelta atrás de la anulación: anular NC-00000002 reintegra el dinero y el recibo R-00000001 queda vigente otra vez.
  const vuelta = await contable(anulado.comprobante.id, "anular", { caja_id: caja.id, motivo: "Se anuló el recibo equivocado" });
  assert.equal(vuelta.mensaje, "Nota de crédito NC-00000002 anulada: se registró el reintegro de $ 14.000,00");
  d = await ver(recibo.id);
  assert.deepEqual([d.estado, d.anulacion, d.disponible], ["EMITIDO", null, 14000]);
  assert.deepEqual(d.historial.map(h => h.accion), ["Recibo emitido", "Devolución con nota de crédito", "Devolución con nota de crédito", "Recibo anulado", "Recibo vigente otra vez"]);
  const nc2 = await ver(anulado.comprobante.id);
  assert.deepEqual([nc2.estado, nc2.anulacion.motivo, nc2.puede_anular], ["ANULADO", "Se anuló el recibo equivocado", false]);
  assert.equal((await cuenta()).pendiente, -14000);
  assert.deepEqual((await cajaRecepcion()).map(c => [c.tipo, c.importe, c.recibo]),
    [["INGRESO", 28000, "R-00000001"], ["EGRESO", 14000, "NC-00000002"], ["INGRESO", 14000, "R-00000002"], ["INGRESO", 14000, "Anula NC-00000002"]]);
  await assert.rejects(contable(anulado.comprobante.id, "anular", { caja_id: caja.id, motivo: "otra vez" }), /ya está anulada/);

  // La «Devolución de la diferencia» desde la cuenta documenta la salida de dinero con una nota de crédito sin recibo de origen.
  const devolucion = await call("POST", "/recepcion/500/cuenta", { operacion: U.uuid(), accion: "PAGO_RESERVA", medio: "TRANSFERENCIA", esperado: -14000 });
  assert.equal(devolucion.comprobante.codigo, "NC-00000003");
  const nc3 = await ver(devolucion.comprobante.id);
  assert.deepEqual([nc3.origen, nc3.renglones[0].texto, nc3.total, nc3.puede_anular], [null, "Devolución de alojamiento", 14000, true]);
  assert.equal((await cuenta()).pendiente, 0);

  // Ficha de la reserva y listado de Contable.
  const ficha = await call("GET", "/recepcion/detalle", {}, { id: r.id });
  assert.deepEqual(ficha.comprobantes.map(c => [c.codigo, c.estado, c.corrige]),
    [["NC-00000003", "EMITIDO", null], ["R-00000002", "EMITIDO", null], ["NC-00000002", "ANULADO", "R-00000001"], ["NC-00000001", "EMITIDO", "R-00000001"], ["R-00000001", "EMITIDO", null]]);
  const lista = await call("GET", "/listados/comprobantes", {}, { tam: 50 });
  assert.equal(lista.total, 5);
  // Neto: 28.000 + 14.000 cobrados − 14.000 (NC-1) − 14.000 (NC-3); NC-2 se reintegró.
  assert.equal(lista.totales.importe, 14000);
  assert.deepEqual((await call("GET", "/listados/comprobantes", {}, { q: "R-00000002" })).filas.map(f => [f.tipo, f.numero]), [["RECIBO", 2]]);
  assert.equal((await call("GET", "/listados/comprobantes", {}, { q: "T-500" })).total, 5);
  assert.equal((await call("GET", "/listados/comprobantes", {}, { f_tipo: "NOTA_CREDITO", f_estado: "EMITIDO" })).total, 2);

  // Una cuenta sin rol de administrador no ve el listado ni corrige comprobantes; con permiso de reservas puede reimprimir.
  const cajero = { id: 2, rol: "CAJERO", nombre: "Caja", gestionar_reservas: 1 };
  await assert.rejects(call("GET", "/listados/comprobantes", {}, {}, cajero), e => e.status === 403);
  await assert.rejects(call("POST", "/contable/comprobantes/" + recibo.id + "/anular", { operacion: U.uuid(), motivo: "x", medio: "EFECTIVO" }, {}, cajero), e => e.status === 403);
  assert.equal((await call("GET", "/contable/comprobantes/" + recibo.id, {}, {}, cajero)).codigo, "R-00000001");
});

test("saldo para consumos: recibo al cargar, nota de crédito al devolver y límite del saldo disponible", async t => {
  const r = reserva(510);
  r.diferencia = 0;
  r.diferenciales = [];
  const { db, caja, call } = await preparar(t, r);
  await call("POST", "/recepcion/guardar", { operacion: U.uuid() });
  const ana = (await call("GET", "/recepcion/detalle", {}, { id: r.id })).cuenta.personas.find(p => p.dni === "30111222");
  const mover = datos => call("POST", "/recepcion/510/cuenta", { operacion: U.uuid(), huesped_id: ana.id, caja_id: caja.id, ...datos });

  const carga = await mover({ accion: "CARGA", medio: "EFECTIVO", importe: 5000 });
  assert.equal(carga.comprobante.codigo, "R-00000001");
  const recibo = await call("GET", "/contable/comprobantes/" + carga.comprobante.id);
  assert.deepEqual(recibo.renglones.map(l => [l.texto, l.rubro]), [["Saldo para consumos en el predio", "SALDO"]]);
  assert.match(recibo.renglones[0].detalle, /Ana/, "el detalle dice para quién es el saldo");

  // «Reducir saldo» devuelve dinero: nota de crédito sin recibo de origen.
  const retiro = await mover({ accion: "RETIRO", medio: "EFECTIVO", importe: 2000 });
  assert.equal(retiro.comprobante.codigo, "NC-00000001");
  // La nota de crédito sobre el recibo de la carga no puede devolver más saldo del que queda.
  const renglon = recibo.renglones[0].movimiento_id;
  await assert.rejects(call("POST", "/contable/comprobantes/" + carga.comprobante.id + "/nota-credito",
    { operacion: U.uuid(), medio: "EFECTIVO", caja_id: caja.id, motivo: "Se va antes", renglones: [{ movimiento_id: renglon, importe: 4000 }] }), /ya no alcanza.*Disponible: \$ 3\.000,00/);
  const nc = await call("POST", "/contable/comprobantes/" + carga.comprobante.id + "/nota-credito",
    { operacion: U.uuid(), medio: "EFECTIVO", caja_id: caja.id, motivo: "Se va antes", renglones: [{ movimiento_id: renglon, importe: 3000 }] });
  assert.equal(nc.comprobante.codigo, "NC-00000002");
  const despues = (await call("GET", "/recepcion/detalle", {}, { id: r.id })).cuenta.personas.find(p => p.dni === "30111222");
  assert.equal(Number(despues.saldo), 0);
  // Anular esa nota de crédito le devuelve el saldo a la persona.
  await call("POST", "/contable/comprobantes/" + nc.comprobante.id + "/anular", { operacion: U.uuid(), caja_id: caja.id, motivo: "No se fue" });
  const repuesto = (await call("GET", "/recepcion/detalle", {}, { id: r.id })).cuenta.personas.find(p => p.dni === "30111222");
  assert.equal(Number(repuesto.saldo), 3000);
  const enCaja = await db.get("SELECT SUM(CASE WHEN tipo='INGRESO' THEN importe ELSE -importe END) AS neto FROM predio_caja_movimiento WHERE concepto IN ('SALDO_ESTADIA','NOTA_CREDITO')");
  assert.equal(Number(enCaja.neto), 3000);
  // Lo cargado «al salir» no es dinero: no lleva comprobante.
  const alSalir = await mover({ accion: "CARGA", medio: "AL_SALIR", importe: 1000 });
  assert.equal(alSalir.comprobante, null);
});
