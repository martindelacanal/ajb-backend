"use strict";

const U = require("../../predios/lib/util");
const { opcionesFiltros } = require("./recepcion-filtros");

const ESTADOS_CONFIRMADOS = new Set(["Aprobada", "Utilizada", "Adjudicada", "Convenio aceptado"]);
const filas = async (c, sql, params) => (await c.query(sql, params))[0];
const leerJson = valor => typeof valor === "string" ? JSON.parse(valor) : valor;

function coincideRecurso(reserva, recursoId, dia) {
  if (!recursoId || Number(reserva.secundario) === recursoId) return true;
  const tramo = reserva.tramos.findLast(t => t.desde <= dia);
  return Number(tramo ? tramo.recurso_id : reserva.recurso_id) === recursoId;
}

async function estadisticas(c, codigos, pid, consulta) {
  const hasta = U.fecha(consulta.hasta) || U.hoy();
  const desde = U.fecha(consulta.desde) || U.sumarDias(hasta, -29);
  if (desde > hasta) throw U.error("La fecha inicial debe ser anterior o igual a la final.");
  const servicioId = U.id(consulta.servicio_id, "El servicio", false);
  const recursoId = U.id(consulta.recurso_id, "El recurso", false);
  const adicionalId = U.id(consulta.adicional_id, "El adicional", false);
  const opciones = consulta.opciones === "1" ? await opcionesFiltros(c, codigos) : undefined;
  const reservas = await filas(c, `SELECT r.id,r.recurso_id,rr.recurso_id AS secundario,er.nombre AS estado,
      JSON_EXTRACT(e.actual,'$.personas') AS personas, JSON_EXTRACT(e.actual,'$.tramos') AS tramos
    FROM reserva r JOIN servicio s ON s.id=r.servicio_id JOIN estado_reserva er ON er.id=r.estado_reserva_id
    LEFT JOIN recepcion_reserva_recurso rr ON rr.reserva_id=r.id AND rr.recurso_id=?
    LEFT JOIN recepcion_reserva_evento e ON e.id=(SELECT MAX(ev.id) FROM recepcion_reserva_evento ev
      WHERE ev.reserva_id=r.id AND ev.predio_id=?)
    WHERE s.codigo IN (?) AND r.fecha_inicio<=? AND r.fecha_fin>=?${servicioId ? " AND r.servicio_id=?" : ""}`,
  [recursoId, pid, codigos, hasta, desde, ...(servicioId ? [servicioId] : [])]);

  for (const r of reservas) {
    r.personas = leerJson(r.personas);
    const tramos = leerJson(r.tramos);
    r.tramos = tramos?.length && Number(tramos.at(-1).recurso_id) === Number(r.recurso_id) ? tramos : [];
  }
  const porReserva = new Map(reservas.map(r => [Number(r.id), r]));
  const antiguos = reservas.filter(r => !Array.isArray(r.personas));
  if (antiguos.length) {
    const huespedes = await filas(c, `SELECT reserva_id,dni,entrada FROM predio_huesped
      WHERE predio_id=? AND reserva_id IN (?) AND entrada BETWEEN ? AND ?`, [pid, antiguos.map(r => r.id), desde, hasta]);
    antiguos.forEach(r => { r.personas = []; });
    for (const p of huespedes) porReserva.get(Number(p.reserva_id)).personas.push(p);
  }

  const confirmadas = reservas.filter(r => ESTADOS_CONFIRMADOS.has(r.estado)).map(r => r.id);
  const usos = confirmadas.length ? await filas(c, `SELECT ra.id,ra.reserva_id,ra.adicional_id,ra.nombre_adicional,
      COALESCE(d.fecha,r.fecha_inicio) AS dia, COALESCE(d.cantidad,ra.cantidad) AS unidades,
      COALESCE(d.cantidad,ra.cantidad * ra.dias) AS unidades_dia, COALESCE(d.subtotal,ra.subtotal) AS importe,
      d.reserva_adicional_id IS NULL AS sin_detalle
    FROM reserva_adicional ra JOIN reserva r ON r.id=ra.reserva_id
    LEFT JOIN reserva_adicional_detalle d ON d.reserva_adicional_id=ra.id
    WHERE ra.reserva_id IN (?) AND (d.fecha BETWEEN ? AND ? OR
      (d.reserva_adicional_id IS NULL AND r.fecha_inicio BETWEEN ? AND ?))${adicionalId ? " AND ra.adicional_id=?" : ""}`,
  [confirmadas, desde, hasta, desde, hasta, ...(adicionalId ? [adicionalId] : [])]) : [];

  const extras = new Map();
  const reservasConAdicional = new Set();
  let sinDetalle = false;
  for (const uso of usos) {
    const id = Number(uso.reserva_id);
    if (!coincideRecurso(porReserva.get(id), recursoId, uso.dia)) continue;
    reservasConAdicional.add(id);
    sinDetalle ||= Boolean(Number(uso.sin_detalle));
    const clave = Number(uso.adicional_id);
    if (!extras.has(clave)) extras.set(clave, { nombre: uso.nombre_adicional, unidades_dia: 0, importe: 0, porLinea: new Map() });
    const extra = extras.get(clave);
    // Una misma unidad de una línea se alquila durante varios días. Contarla
    // una vez por línea separa la cantidad física de los días que se cobran.
    extra.porLinea.set(uso.id, Math.max(extra.porLinea.get(uso.id) || 0, Number(uso.unidades)));
    extra.unidades_dia += Number(uso.unidades_dia);
    extra.importe += Number(uso.importe);
  }

  const ingresos = new Map();
  for (const r of reservas) {
    if (adicionalId && !reservasConAdicional.has(Number(r.id))) continue;
    for (const p of r.personas) {
      if (!p.dni || !p.entrada || p.entrada < desde || p.entrada > hasta || !coincideRecurso(r, recursoId, p.entrada)) continue;
      if (!ingresos.has(p.entrada)) ingresos.set(p.entrada, new Set());
      ingresos.get(p.entrada).add(String(p.dni));
    }
  }
  return {
    desde, hasta, opciones, sin_detalle: sinDetalle,
    ingresos: [...ingresos].sort(([a], [b]) => a.localeCompare(b)).map(([dia, dnis]) => ({ dia, personas: dnis.size })),
    adicionales: [...extras.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es-AR")).map(({ porLinea, importe, ...extra }) => ({
      ...extra, unidades: [...porLinea.values()].reduce((suma, cantidad) => suma + cantidad, 0), importe: U.redondear(importe),
    })),
  };
}

module.exports = { estadisticas };
