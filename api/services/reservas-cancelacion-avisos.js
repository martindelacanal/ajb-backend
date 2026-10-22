"use strict";

// Avisos de la baja de una reserva de turismo:
// - «Cancelar a pedido de la persona afiliada» que carga el staff: aviso a la
//   persona afiliada con el reintegro, al titular si la reserva es de un
//   familiar (el reintegro va a su cuenta) y a Turismo, sin incluir al autor.
// - La cancelación que hace la propia persona afiliada desde la app: aviso a
//   Turismo con el reintegro.
// Los textos son funciones puras para poder probarlos sin base de datos.

const { crearNotificacion } = require("./notificaciones");
const { esFamiliar } = require("./reservas-familiares");
const { normalizarFechaCivil } = require("./valores-dominio");

const TIPO_CANCELADA_A_PEDIDO = "RESERVA_CANCELADA_A_PEDIDO";
const TIPO_CANCELADA_AFILIADO = "RESERVA_CANCELADA_AFILIADO";
const REGLA_SIN_FIRMA = "SIN_FIRMA";
const TEXTO_CANAL = Object.freeze({ PRESENCIAL: "en persona", TELEFONO: "por teléfono", ESCRITO: "por escrito" });

function texto(valor) {
  return valor === null || valor === undefined ? "" : String(valor).trim();
}

function nombreCompleto(nombre, apellido) {
  return [nombre, apellido].map(texto).filter(Boolean).join(" ");
}

function formatearFecha(valor) {
  const fecha = normalizarFechaCivil(typeof valor === "string" ? valor.slice(0, 10) : valor);
  if (!fecha) return "";
  const [anio, mes, dia] = fecha.split("-");
  return `${dia}/${mes}/${anio}`;
}

function formatearPesos(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return "$ 0";
  const conCentavos = Math.round(numero * 100) % 100 !== 0;
  return `$ ${numero.toLocaleString("es-AR", {
    minimumFractionDigits: conCentavos ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

function formatearPorcentaje(valor) {
  return `${Number(valor).toLocaleString("es-AR", { maximumFractionDigits: 2 })}%`;
}

// «Motivo: …» termina con un solo punto aunque la persona ya lo haya escrito.
function oracionMotivo(motivo) {
  const limpio = texto(motivo);
  if (!limpio) return "";
  return ` Motivo: ${/[.!?…]$/.test(limpio) ? limpio : `${limpio}.`}`;
}

function anticipacion(diasPrevios) {
  const dias = Number(diasPrevios);
  if (!Number.isFinite(dias) || dias <= 0) return "Era el día de ingreso";
  if (dias === 1) return "Faltaba 1 día para el ingreso";
  return `Faltaban ${dias} días para el ingreso`;
}

function esSinDevoluciones(cancelacion) {
  const reglas = Array.isArray(cancelacion?.politica?.reglas) ? cancelacion.politica.reglas : [];
  return reglas.length > 0 && reglas.every((regla) => Number(regla.porcentaje_reintegro) === 0);
}

function quienCancelo(rolActor) {
  return rolActor === "departamental" ? "Tu departamental" : "El equipo de Turismo";
}

function rangoFechas(datos) {
  const desde = formatearFecha(datos.fecha_inicio);
  const hasta = formatearFecha(datos.fecha_fin);
  return desde && hasta ? `del ${desde} al ${hasta}` : "";
}

/**
 * Oración del reintegro para la persona afiliada (`propia`: «tu reserva», «te
 * corresponde») o para su titular («la reserva», «corresponde»). Dice «según la
 * política de cancelación de la reserva» y no «las condiciones que aceptaste»:
 * en una carga administrativa puede que no las haya aceptado ella misma.
 */
function oracionReintegro(cancelacion, { propia = true } = {}) {
  if (Number(cancelacion?.monto_base) === 0) return "La estadía estaba bonificada: no hay importe para reintegrar.";
  if (esSinDevoluciones(cancelacion)) return "Esta reserva no tenía devoluciones: no corresponde reintegro.";
  const politica = propia ? "de tu reserva" : "de la reserva";
  const inicio = `${anticipacion(cancelacion?.dias_previos)}: según la política de cancelación ${politica},`;
  if (Number(cancelacion?.porcentaje_reintegro) === 0) return `${inicio} no corresponde reintegro.`;
  return `${inicio} ${propia ? "te corresponde" : "corresponde"} un reintegro estimado del `
    + `${formatearPorcentaje(cancelacion.porcentaje_reintegro)}: ${formatearPesos(cancelacion.monto_reintegro)} `
    + `sobre un total de ${formatearPesos(cancelacion.monto_base)}. El importe final se confirma al gestionar el reintegro.`;
}

/**
 * Aviso a la persona afiliada cuando el staff cancela a su pedido.
 * `datos`: reserva_id, servicio, fecha_inicio, fecha_fin.
 */
function textoAvisoCancelacionAPedido({ datos, cancelacion, rolActor, canal }) {
  const quien = quienCancelo(rolActor);
  const como = TEXTO_CANAL[canal] || "a tu pedido";
  // El mismo código que el resto de los avisos de la reserva («T-123»).
  const reserva = `la reserva T-${datos.reserva_id}`;
  const fechas = rangoFechas(datos);
  const cierre = " Si no pediste esta cancelación, comunicate con tu departamental.";
  if (cancelacion?.regla === REGLA_SIN_FIRMA) {
    return `${quien} canceló a tu pedido (${como}) ${reserva} que tenías para firmar (${datos.servicio}${fechas ? `, ${fechas}` : ""}). `
      + "Como todavía no la habías firmado, no tiene ningún cargo y no tenés que hacer nada."
      + `${oracionMotivo(cancelacion?.motivo)}${cierre}`;
  }
  return `${quien} canceló a tu pedido (${como}) ${reserva} de ${datos.servicio}${fechas ? `, ${fechas}` : ""}. `
    + `${oracionReintegro(cancelacion, { propia: true })}${oracionMotivo(cancelacion?.motivo)}${cierre}`;
}

/** Aviso al titular cuando la reserva cancelada es de un familiar de su grupo. */
function textoAvisoCancelacionTitular({ datos, cancelacion, rolActor, canal }) {
  const quien = quienCancelo(rolActor);
  const como = TEXTO_CANAL[canal] || "";
  const familiar = nombreCompleto(datos.afiliado_nombre, datos.afiliado_apellido) || "tu familiar";
  const pedido = `a pedido de ${familiar}${como ? ` (${como})` : ""}`;
  const fechas = rangoFechas(datos);
  const cierre = " Si nadie de tu grupo familiar pidió esta cancelación, comunicate con tu departamental.";
  if (cancelacion?.regla === REGLA_SIN_FIRMA) {
    return `${quien} canceló, ${pedido}, la reserva T-${datos.reserva_id} que tenía para firmar (${datos.servicio}${fechas ? `, ${fechas}` : ""}). `
      + "Como todavía no estaba firmada, no tiene ningún cargo."
      + `${oracionMotivo(cancelacion?.motivo)}${cierre}`;
  }
  return `${quien} canceló, ${pedido}, la reserva T-${datos.reserva_id} de ${datos.servicio}${fechas ? `, ${fechas}` : ""}. `
    + `${oracionReintegro(cancelacion, { propia: false })}${oracionMotivo(cancelacion?.motivo)}${cierre}`;
}

function resumenReintegroStaff(cancelacion) {
  if (!cancelacion) return "";
  if (cancelacion.regla === REGLA_SIN_FIRMA) return "Sin penalidad: todavía no estaba firmada.";
  if (Number(cancelacion?.monto_base) === 0) return "La estadía estaba bonificada: no hay importe para reintegrar.";
  return `Reintegro estimado: ${formatearPorcentaje(cancelacion?.porcentaje_reintegro)} `
    + `(${formatearPesos(cancelacion?.monto_reintegro)} sobre ${formatearPesos(cancelacion?.monto_base)}).`;
}

/** Aviso a Turismo: quién la cargó, a pedido de quién, cómo y el reintegro. */
function textoAvisoCancelacionStaff({ datos, cancelacion, rolActor, canal }) {
  const actor = nombreCompleto(datos.actor_nombre, datos.actor_apellido) || "Turismo";
  const area = rolActor === "departamental" && texto(datos.actor_departamental)
    ? `Departamental ${texto(datos.actor_departamental)}`
    : "Turismo";
  const afiliado = nombreCompleto(datos.afiliado_nombre, datos.afiliado_apellido) || "la persona afiliada";
  const como = TEXTO_CANAL[canal] ? `, ${TEXTO_CANAL[canal]}` : "";
  return `${actor} (${area}) la canceló a pedido de ${afiliado}${como}. `
    + `${resumenReintegroStaff(cancelacion)}${oracionMotivo(cancelacion?.motivo)}`;
}

/** Aviso a Turismo cuando la persona afiliada cancela desde la app. */
function textoAvisoCancelacionAfiliadoStaff(cancelacion) {
  return ["La persona afiliada canceló la reserva desde la app.", resumenReintegroStaff(cancelacion)]
    .filter(Boolean).join(" ") + oracionMotivo(cancelacion?.motivo);
}

async function leerDatosAviso(connection, { reservaId, actorId }) {
  const [filas] = await connection.query(
    `SELECT r.id AS reserva_id, r.usuario_id,
            DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin,
            COALESCE(s.nombre, 'Turismo') AS servicio,
            u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido,
            u.usuario_familiar_id, u.es_familiar, u.parentesco_id, ru.nombre AS rol,
            act.nombre AS actor_nombre, act.apellido AS actor_apellido, d.nombre AS actor_departamental
       FROM reserva r
       INNER JOIN usuario u ON u.id = r.usuario_id
       LEFT JOIN rol ru ON ru.id = u.rol_id
       LEFT JOIN recurso rec ON rec.id = r.recurso_id
       LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
       LEFT JOIN usuario act ON act.id = ?
       LEFT JOIN departamental d ON d.id = act.departamental_id
      WHERE r.id = ?
      LIMIT 1`,
    [actorId, reservaId]
  );
  return filas[0] || null;
}

/**
 * Avisos de «Cancelar a pedido de la persona afiliada». Van en la categoría
 * «estados»: quien silenció «Novedades» igual se entera. `notificarStaff(tipo,
 * titulo, mensaje, payload)` reparte a Turismo de la departamental de la
 * reserva y excluye al autor (notificarStaffTurismo de user.js).
 */
async function avisarCancelacionAPedido(connection, { reservaId, actorId, rolActor, canal, cancelacion, notificarStaff }) {
  const datos = await leerDatosAviso(connection, { reservaId, actorId });
  if (!datos) return;
  const payload = {
    reserva_id: Number(reservaId),
    estado: "Cancelada",
    origen: "STAFF_A_PEDIDO",
    regla: cancelacion?.regla || "POLITICA",
  };
  const contexto = { datos, cancelacion, rolActor, canal };
  if (Number(datos.usuario_id) !== Number(actorId)) {
    await crearNotificacion(connection, {
      usuarioId: datos.usuario_id,
      tipo: TIPO_CANCELADA_A_PEDIDO,
      titulo: `Reserva T-${reservaId} cancelada a tu pedido`,
      mensaje: textoAvisoCancelacionAPedido(contexto),
      payload,
      categoria: "estados",
    });
  }
  // El reintegro de la reserva de un familiar va a la cuenta del titular.
  const titularId = esFamiliar(datos) ? Number(datos.usuario_familiar_id) : null;
  if (titularId && titularId !== Number(datos.usuario_id) && titularId !== Number(actorId)) {
    const familiar = nombreCompleto(datos.afiliado_nombre, datos.afiliado_apellido) || "tu familiar";
    await crearNotificacion(connection, {
      usuarioId: titularId,
      tipo: TIPO_CANCELADA_A_PEDIDO,
      titulo: `Reserva T-${reservaId} de ${familiar} cancelada a su pedido`,
      mensaje: textoAvisoCancelacionTitular(contexto),
      payload,
      categoria: "estados",
    });
  }
  if (typeof notificarStaff === "function") {
    await notificarStaff(
      TIPO_CANCELADA_A_PEDIDO,
      `Reserva T-${reservaId} cancelada a pedido de la persona afiliada`,
      textoAvisoCancelacionStaff(contexto),
      payload
    );
  }
}

module.exports = {
  TIPO_CANCELADA_A_PEDIDO,
  TIPO_CANCELADA_AFILIADO,
  avisarCancelacionAPedido,
  formatearPesos,
  oracionReintegro,
  textoAvisoCancelacionAPedido,
  textoAvisoCancelacionAfiliadoStaff,
  textoAvisoCancelacionStaff,
  textoAvisoCancelacionTitular,
};
