"use strict";

// La cuenta se replica con la identidad (predio_id, id). Consultarla junto al
// historial evita duplicar movimientos cuando una notebook reintenta sincronizar.
const medios = {
  EFECTIVO: "Efectivo", TRANSFERENCIA: "Transferencia", SALDO: "Saldo",
  DESCUENTO: "Descuento de haberes", HABERES: "Haberes", AL_SALIR: "A saldar al salir",
  TARJETA: "Tarjeta", CHEQUE: "Cheque",
};
const conceptos = {
  CARGA: "Carga de saldo", RETIRO: "Retiro de saldo", COMPRA: "Compra",
  ANULACION: "Anulación de compra", SALDAR_CONSUMOS: "Liquidación de consumos",
  PAGO_RESERVA: "Liquidación del alojamiento", DIFERENCIAL: "Diferencia de alojamiento",
};
function etiqueta(campo, opciones) {
  return "CASE " + campo + " " + Object.entries(opciones).map(([k, v]) => "WHEN '" + k + "' THEN '" + v + "'").join(" ") + " ELSE " + campo + " END";
}
const importe = campo => `CONCAT(IF(${campo}<0,'-$ ','$ '), FORMAT(ABS(${campo}),2,'de_DE'))`;
const detallePago = `(SELECT GROUP_CONCAT(CONCAT(${etiqueta("pago.forma", medios)}, ' ', ${importe("pago.importe")}) ORDER BY pago.id SEPARATOR ' + ')
  FROM predio_venta_pago pago WHERE pago.predio_id=m.predio_id AND pago.venta_id=m.venta_id)`;

const fuenteHistorialReserva = `(
  SELECT id, reserva_id, fecha_modificacion, tipo_operacion, campo_modificado, valor_anterior,
    valor_nuevo, observaciones, usuario_modificador_id,
    CASE WHEN hr.observaciones LIKE 'Operación atípica · %' THEN (
      SELECT e.actor FROM recepcion_reserva_evento e
      WHERE e.reserva_id=hr.reserva_id AND (
        JSON_CONTAINS(e.actual,CAST(hr.id AS JSON),'$.historial_ids')=1 OR
        (JSON_EXTRACT(e.actual,'$.historial_ids') IS NULL
         AND RIGHT(hr.observaciones,CHAR_LENGTH(CONCAT_WS(' · ', '', e.actor, NULLIF(e.motivo,'')))) =
             CONCAT_WS(' · ', '', e.actor, NULLIF(e.motivo,'')))
      )
      ORDER BY ABS(TIMESTAMPDIFF(SECOND,hr.fecha_modificacion,e.fecha)), e.id DESC LIMIT 1
    ) END AS empleado_predio, NULL AS predio_id
  FROM historial_reserva hr
  UNION ALL
  SELECT m.id, m.reserva_id, m.fecha, 'CUENTA_PREDIO',
    CASE WHEN m.concepto='REPARTO' THEN IF(m.importe<0,'Reparto de saldo enviado','Reparto de saldo recibido')
         ELSE ${etiqueta("m.concepto", conceptos)} END, NULL, ${importe("m.importe")},
    CONCAT_WS(' · ', NULLIF(f.nombre,''), NULLIF(m.detalle,''),
      IF(m.venta_id IS NULL,${etiqueta("m.medio",medios)},${detallePago})),
    NULL, m.usuario_nombre, m.predio_id
  FROM predio_estadia_mov m
  LEFT JOIN predio_huesped f ON f.predio_id=m.predio_id AND f.reserva_id=m.reserva_id AND f.id=m.huesped_id
  WHERE EXISTS (SELECT 1 FROM recepcion_reserva_evento e WHERE e.reserva_id=m.reserva_id AND e.predio_id=m.predio_id)
) h`;
module.exports = { fuenteHistorialReserva };
