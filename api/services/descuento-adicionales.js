"use strict";

// Descuento de los ADICIONALES de una reserva de turismo (mascota, cochera...).
//
// Regla de negocio (pedido del cliente, 2026-09): en cada noche, los
// adicionales toman el MAYOR % de descuento entre las tarifas de las personas
// de la reserva, SIN CONTAR a los "Menores de 2 años" (tipo_persona_id = 5).
// Los bebés tienen tarifa al 100% (viajan sin cargo) y, si contaran, cualquier
// reserva con un bebé tendría todos los adicionales gratis. Se toma el
// siguiente mayor % entre el resto; si nadie más tiene %, los adicionales se
// cobran sin descuento (0%). Ante un empate gana la primera persona, en el
// orden de la reserva.
//
// Única fuente del cálculo: la usan la cotización, el alta y la edición de
// reservas (routes/user.js → calcularAdicionalesReserva), el seed demo y el
// corrector scripts/corregir-descuento-adicionales-bebe.js.

const { decimalAPuntosBase } = require("./valores-dominio");

const TIPO_PERSONA_MENOR_2 = 5;

function crearErrorTarifa(mensaje, codigo) {
  const error = new Error(mensaje);
  error.statusCode = 409;
  error.codigo = codigo;
  return error;
}

function esMenorDe2(persona) {
  return Number(persona?.tipo_persona_id) === TIPO_PERSONA_MENOR_2;
}

/** Personas cuya tarifa cuenta para el descuento de los adicionales. */
function personasParaDescuentoAdicionales(personas) {
  return (Array.isArray(personas) ? personas : []).filter((persona) => !esMenorDe2(persona));
}

function esBanderaVerdadera(valor) {
  return valor === 1 || valor === true || valor === "1";
}

/**
 * Mayor % entre tarifas ya filtradas (sin menores de 2 años). Devuelve la
 * forma que se guarda en reserva_adicional_detalle: tarifa_id es la tarifa de
 * la que sale el %, o null cuando no hay descuento.
 *
 * @param {Array<{id?: number, usa_porcentaje: any, porcentaje_descuento: any}|null>} tarifas
 * @param {{fecha?: string}} [opciones] fecha sólo para el mensaje de error
 */
function elegirMayorDescuentoTarifas(tarifas, { fecha = null } = {}) {
  let maxPuntosBase = 0;
  let tarifaIdMax = null;
  for (const tarifa of Array.isArray(tarifas) ? tarifas : []) {
    if (!tarifa || !esBanderaVerdadera(tarifa.usa_porcentaje)) continue;
    const puntosBase = decimalAPuntosBase(tarifa.porcentaje_descuento ?? 0);
    if (puntosBase === null) {
      throw crearErrorTarifa(
        `La tarifa de la fecha ${fecha ?? "indicada"} tiene un porcentaje invalido`,
        "TARIFA_INVALIDA"
      );
    }
    if (puntosBase > maxPuntosBase) {
      maxPuntosBase = puntosBase;
      tarifaIdMax = tarifa.id ?? null;
    }
  }
  return {
    porcentaje_descuento: maxPuntosBase / 100,
    porcentaje_puntos_base: maxPuntosBase,
    tarifa_id: tarifaIdMax,
  };
}

/**
 * Descuento de los adicionales para una noche: busca la tarifa vigente de cada
 * persona que cuenta (se saltea a los menores de 2 años y a quien no tenga
 * tipo o edad) y se queda con el mayor %.
 */
async function obtenerMejorDescuentoAdicionalesDia(connection, {
  recursoId,
  regimenId,
  personas,
  fecha,
  temporadaTarifaId = null,
}) {
  const tarifas = [];
  for (const persona of personasParaDescuentoAdicionales(personas)) {
    if (!persona.tipo_persona_id || persona.edad === undefined) continue;

    const filtroTemporada = temporadaTarifaId
      ? "AND temporada_tarifa_id = ?"
      : `AND (temporada_tarifa_id IS NULL OR temporada_tarifa_id IN (
           SELECT id FROM temporada_tarifa WHERE COALESCE(origen, 'GENERAL') = 'GENERAL'
         ))`;
    const [rows] = await connection.query(
      `SELECT id, usa_porcentaje, porcentaje_descuento
       FROM tarifa
       WHERE recurso_id = ?
         AND tipo_persona_id = ?
         AND regimen_id = ?
         AND (edad_minima IS NULL OR edad_minima <= ?)
         AND (edad_maxima IS NULL OR edad_maxima >= ?)
         AND fecha_inicio <= ?
         AND fecha_fin >= ?
         ${filtroTemporada}
       ORDER BY fecha_inicio ASC`,
      [
        recursoId,
        persona.tipo_persona_id,
        regimenId,
        persona.edad,
        persona.edad,
        fecha,
        fecha,
        ...(temporadaTarifaId ? [temporadaTarifaId] : []),
      ]
    );

    if (rows.length > 1) {
      throw crearErrorTarifa(`Hay mas de una tarifa aplicable para la fecha ${fecha}`, "TARIFA_AMBIGUA");
    }
    if (rows.length > 0) tarifas.push(rows[0]);
  }

  return elegirMayorDescuentoTarifas(tarifas, { fecha });
}

module.exports = {
  TIPO_PERSONA_MENOR_2,
  elegirMayorDescuentoTarifas,
  esMenorDe2,
  obtenerMejorDescuentoAdicionalesDia,
  personasParaDescuentoAdicionales,
};
