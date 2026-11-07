"use strict";

const N = require("./negocio");
const U = require("./util");
const { cuenta } = require("./api/recepcion");
const { importarStockDemo } = require("./traslado-ejemplos-stock");

const CLAVE = "traslado-miramar-demo-20261106-v1";
// Manifiesto de los registros originales del predio de demostración.
const RESERVAS = [
  { id: 52, dni: "99067310", nombre: "Mila Arenas Demo", entrada: "2026-11-05", salida: null, cargo: 204200 },
  { id: 53, dni: "99067311", nombre: "Bruno Médano Demo", entrada: "2026-11-02", salida: null, cargo: 69600 },
  { id: 54, dni: "99067312", nombre: "Luz Ribera Demo", entrada: null, salida: null, cargo: 59500 },
  { id: 55, dni: "99067313", nombre: "Vera Salinas Demo", entrada: "2026-10-29", salida: "2026-10-31", cargo: 39500 },
  { id: 56, dni: "99067314", nombre: "Felipe Faro Demo", entrada: "2026-11-06", salida: null, cargo: 48000 },
];

function validarOrden(config, cuerpo) {
  if (Number(config.predio_id) !== 1 || config.predio_codigo !== "MIRAMAR" || cuerpo?.clave !== CLAVE) {
    throw U.error("El traslado pertenece a la instalación de Miramar y requiere su manifiesto original.", 409);
  }
  const { pago, recibo } = cuerpo;
  if (Number(pago?.predio_id) !== 7 || Number(pago.id) !== 5 || Number(pago.reserva_id) !== 55 ||
      pago.concepto !== "PAGO_RESERVA" || pago.medio !== "TRANSFERENCIA" || Number(pago.importe) !== 39500 ||
      pago.fecha !== "2026-11-06 21:38:02" || pago.usuario_nombre !== "Recepción · Demostración" ||
      pago.detalle !== "Pago ficticio de la estadía finalizada.") {
    throw U.error("El pago original de T-55 no coincide con la transferencia de demostración.", 409);
  }
  if (Number(recibo?.predio_id) !== 7 || Number(recibo.id) !== 5 ||
      recibo.clave !== "edb6aa4a-8049-4dd7-9b71-05a0f6f00aa2" ||
      recibo.huella !== "28d9dace3ebe109a4a29acc9e6428c4cb226959f95775c0ee46cc4d6646eb067" ||
      recibo.respuesta !== '{"mensaje":"Movimiento registrado","liquidacion_id":null}') {
    throw U.error("El recibo de la transferencia no coincide con el original.", 409);
  }
}

async function verificarCuentas(t, ctx) {
  for (const esperada of RESERVAS) {
    const actual = await cuenta(t, ctx, esperada.id, true);
    const huesped = actual.personas[0];
    if (actual.personas.length !== 1 || String(huesped.dni) !== esperada.dni || huesped.nombre !== esperada.nombre ||
        huesped.entrada !== esperada.entrada || huesped.salida !== esperada.salida ||
        Number(huesped.titular) !== 1 || Number(huesped.afiliado) !== 0) {
      throw U.error(`Los huéspedes de T-${esperada.id} no coinciden con la estadía de demostración. Verificá la sincronización de Recepción.`, 409);
    }
    if (actual.movimientos.length !== 1 || actual.movimientos[0].concepto !== "DIFERENCIAL" ||
        actual.pendiente !== esperada.cargo || actual.neto_consumos !== 0 || actual.saldo !== 0) {
      throw U.error(`La cuenta de T-${esperada.id} difiere del cargo original. Revisala antes del traslado.`, 409);
    }
  }
}

// Se llama dentro de la misma transacción que registra el éxito de la orden.
async function trasladarEjemplosMiramar(t, config, cuerpo) {
  validarOrden(config, cuerpo);
  const ctx = { db: t, pid: 1, modo: "local", origen: "SISTEMA", sesion: {}, query: {}, ip: null,
    usuario: { id: null, nombre: "Traslado de ejemplos a Miramar", rol: "ADMIN", bocas: [] } };
  const { pago, recibo } = cuerpo;
  const huella = U.sha256(CLAVE + ":" + recibo.huella);
  const buscarRecibo = clave => t.get("SELECT huella,respuesta FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, clave]);
  const aplicado = await buscarRecibo(CLAVE);
  if (aplicado) {
    if (aplicado.huella !== huella) throw U.error("La clave de traslado ya corresponde a otra operación.", 409);
    return JSON.parse(aplicado.respuesta);
  }
  if (await buscarRecibo(recibo.clave)) throw U.error("El pago original ya tiene recibo en Miramar. Revisá la cuenta de T-55.", 409);
  await verificarCuentas(t, ctx);
  const pagoId = await N.insertar(t, ctx, "predio_estadia_mov", {
    reserva_id: 55, fecha: pago.fecha, concepto: pago.concepto, medio: pago.medio, importe: Number(pago.importe),
    detalle: pago.detalle, usuario_id: null, usuario_nombre: pago.usuario_nombre,
  });
  await N.insertar(t, ctx, "predio_recepcion_recibo", { clave: recibo.clave, huella: recibo.huella, respuesta: recibo.respuesta });
  const stock = await importarStockDemo(t, ctx);
  const resultado = { reservas: RESERVAS.map(r => r.id), pago_id: pagoId, stock };
  await N.auditar(t, ctx, "Traslado de demostración", "reserva", 55, {
    clave: CLAVE, predio_origen: 7, pago_origen_id: pago.id, recibo_original: recibo.clave, ...resultado,
  });
  await N.insertar(t, ctx, "predio_recepcion_recibo", { clave: CLAVE, huella, respuesta: JSON.stringify(resultado) });
  return resultado;
}

module.exports = { trasladarEjemplosMiramar };
