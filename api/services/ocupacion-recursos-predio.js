"use strict";

// Resuelve los rangos de todas las unidades en una consulta, tanto para el
// catálogo como para el calendario de alternativas de muchos días.
async function ocupacionAlojamiento(c, ids, inicio, fin, excluir = null) {
  const [filas] = await c.query(`SELECT u.recurso_id, DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
    DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin FROM reserva r
    JOIN (SELECT id AS reserva_id,recurso_id FROM reserva WHERE recurso_id IN (?)
          UNION ALL SELECT reserva_id,recurso_id FROM recepcion_reserva_recurso WHERE recurso_id IN (?)) u ON u.reserva_id=r.id
    LEFT JOIN estado_reserva er ON er.id=r.estado_reserva_id
    WHERE r.fecha_inicio < ? AND r.fecha_fin > ? AND COALESCE(r.estado_reserva_id,1) <> 4
      AND COALESCE(er.nombre,'') NOT IN ('Cancelada','Rechazada','No adjudicada')${excluir ? " AND r.id<>?" : ""}`,
  [ids, ids, fin, inicio, ...(excluir ? [excluir] : [])]);
  return filas;
}

// El recurso principal vive en reserva. Los demás ocupan el mismo intervalo
// [ingreso, salida) y se liberan junto con la cabecera al cancelar la estadía.
async function ocupacionesSecundarias(c, recursoIds, inicio, fin, excluir = null, lock = false) {
  if (!recursoIds.length) return [];
  const [filas] = await c.query(`SELECT r.id, rr.recurso_id,
    DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio, DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin
    FROM reserva r JOIN recepcion_reserva_recurso rr ON rr.reserva_id=r.id
    JOIN estado_reserva er ON er.id=r.estado_reserva_id
    WHERE rr.recurso_id IN (?) AND r.fecha_inicio < ? AND r.fecha_fin > ?
      AND er.nombre NOT IN ('Cancelada','Rechazada','No adjudicada')${excluir ? " AND r.id<>?" : ""}${lock ? " FOR UPDATE OF r" : ""}`,
    [recursoIds, fin, inicio, ...(excluir ? [excluir] : [])]);
  return filas;
}

async function bloqueSuperponeReserva(c, ids, inicio, fin) {
  const [filas] = await c.query(`SELECT r.id FROM reserva r JOIN estado_reserva er ON er.id=r.estado_reserva_id
    WHERE (r.recurso_id IN (?) OR EXISTS(SELECT 1 FROM recepcion_reserva_recurso rr WHERE rr.reserva_id=r.id AND rr.recurso_id IN (?)))
      AND r.fecha_inicio < ? AND r.fecha_fin > ? AND er.nombre NOT IN ('Cancelada','Rechazada','No adjudicada') LIMIT 1 FOR UPDATE OF r`,
  [ids, ids, fin, inicio]);
  return filas.length > 0;
}
module.exports = { ocupacionAlojamiento, ocupacionesSecundarias, bloqueSuperponeReserva };
