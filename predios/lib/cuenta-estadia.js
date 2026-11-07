"use strict";

const U = require("./util");

function esCierreDeSaldo(m) {
  // Una anulación de haberes reabre deuda sin cancelar anticipos nuevos.
  return m.concepto === "SALDAR_CONSUMOS" && !(m.medio === "HABERES" && Number(m.importe) < 0);
}

function resumirCuenta(personas, movimientos) {
  const porId = new Map(personas.map(p => [Number(p.id), {
    alojamiento: 0, consumos: 0, trasladado: 0, cierre: 0
  }]));
  const cierreConsumos = Number(movimientos.find(esCierreDeSaldo)?.id || 0);
  const cierreAlojamiento = Number(movimientos.find(m => m.concepto === "PAGO_RESERVA" && !m.huesped_id)?.id || 0);
  for (const m of movimientos) {
    const p = porId.get(Number(m.huesped_id));
    if (m.concepto === "CIERRE_SALIDA" && p && !p.cierre) p.cierre = Number(m.id);
  }
  let prepago = 0, consumos = 0, pendiente = 0, huboOperacionDeSaldo = false;
  // Pagos de artículos alquilados o comprados: descuentan la deuda de la reserva (ver recepcion.js).
  const pagosAdicionales = {};
  for (let i = movimientos.length - 1; i >= 0; i--) {
    const m = movimientos[i];
    const importe = Number(m.importe), id = Number(m.id), p = porId.get(Number(m.huesped_id));
    const carga = ["CARGA", "RETIRO"].includes(m.concepto);
    const compra = ["COMPRA", "ANULACION"].includes(m.concepto);
    if (id > Math.max(cierreConsumos, p?.cierre || 0) && (carga || compra)) huboOperacionDeSaldo = true;
    const abono = carga && m.medio !== "AL_SALIR" || ["SALDAR_CONSUMOS", "PAGO_SALIDA_CONSUMOS"].includes(m.concepto);
    if (abono) prepago += importe;
    if (compra) consumos -= importe;
    if (m.concepto === "DIFERENCIAL") pendiente += importe;
    if (m.concepto === "PAGO_RESERVA") pendiente -= importe;
    if (m.concepto === "PAGO_ADICIONAL") {
      pendiente -= importe;
      pagosAdicionales[String(m.adicional_id)] = U.redondear((pagosAdicionales[String(m.adicional_id)] || 0) + importe);
    }
    if (!p) continue;
    if (id > cierreAlojamiento) {
      if (["DIFERENCIAL", "TRASPASO_ALOJAMIENTO"].includes(m.concepto)) p.alojamiento += importe;
      if (m.concepto === "PAGO_RESERVA") p.alojamiento -= importe;
      if (m.concepto === "TRASPASO_ALOJAMIENTO" && m.medio === "RECIBIDO") p.trasladado += importe;
    }
    if (id > cierreConsumos) {
      if (compra || abono) p.consumos -= importe;
      if (m.concepto === "TRASPASO_CONSUMOS") p.consumos += importe;
      if (m.concepto === "TRASPASO_CONSUMOS" && m.medio === "RECIBIDO") p.trasladado += importe;
      if (m.concepto === "REPARTO" && importe > 0) {
        // Repartir puede mover un anticipo pagado o un cupo a saldar al salir.
        // Sólo la porción con fondos pagados se acredita en la liquidación.
        const retiro = movimientos[i - 1];
        const origen = retiro?.concepto === "REPARTO" && Number(retiro.importe) === -importe
          ? porId.get(Number(retiro.huesped_id)) : null;
        if (origen) {
          const pagado = Math.min(importe, Math.max(0, -U.redondear(origen.consumos)));
          origen.consumos += pagado;
          p.consumos -= pagado;
        }
      }
    }
  }
  const neto = U.redondear(consumos - prepago);
  const saldo = U.redondear(personas.reduce((s, p) => s + Number(p.saldo), 0));
  return {
    personas,
    movimientos,
    consumos: U.redondear(consumos),
    neto_consumos: neto,
    pendiente: U.redondear(pendiente),
    saldo,
    cierre_pendiente: huboOperacionDeSaldo || saldo !== 0 || neto !== 0,
    pagos_adicionales: pagosAdicionales,
    pagos_anulados: movimientos.filter(m => m.anula_mov_id).map(m => Number(m.anula_mov_id)),
    saldos_individuales: Object.fromEntries(personas.map(p => [String(p.dni), porId.get(Number(p.id))]))
  };
}

// Trabajar en centavos evita que el reparto cree o pierda saldo.
function repartir(importe, pesos) {
  if (!pesos.length) return [];
  const centavos = Math.round(importe * 100), total = pesos.reduce((s, n) => s + n, 0);
  let asignado = 0, pesoAcumulado = 0;
  return pesos.map((peso, i) => {
    pesoAcumulado += peso;
    const hasta = Math.round(centavos * (total ? pesoAcumulado / total : (i + 1) / pesos.length));
    const cuota = (hasta - asignado) / 100;
    asignado = hasta;
    return cuota;
  });
}

module.exports = { esCierreDeSaldo, resumirCuenta, repartir };
