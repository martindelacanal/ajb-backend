"use strict";

const TIPO_PERSONA_BEBE = 5;
const EDAD_MINIMA_MENOR = 2;
const EDAD_MINIMA_ADULTO = 18;
const EDAD_MAXIMA = 130;

function edadEntera(valor, { opcional = false } = {}) {
  if (valor === null || valor === undefined || valor === "") return opcional ? null : NaN;
  if (!["number", "string"].includes(typeof valor) || String(valor).trim() === "") return NaN;
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= 0 && numero <= EDAD_MAXIMA ? numero : NaN;
}

/** Los límites son inclusivos: bebés 0-1, menores 2-17, adultos desde 18. */
function validarRangosEdadTemporada(tipoPersonaId, rangos) {
  if (!Array.isArray(rangos) || rangos.length === 0) return "Debe incluir al menos un rango de edad";

  const esBebe = Number(tipoPersonaId) === TIPO_PERSONA_BEBE;
  if (esBebe && rangos.length !== 1) return "Menores de 2 años admite un único rango de 0 a 1 años";

  const anteriores = [];
  for (const rango of rangos) {
    const minimo = edadEntera(rango?.edadMinima ?? rango?.edad_minima);
    const maximo = edadEntera(rango?.edadMaxima ?? rango?.edad_maxima, { opcional: true });
    if (!Number.isFinite(minimo) || (maximo !== null && (!Number.isFinite(maximo) || maximo < minimo))) {
      return "El rango de edad debe tener límites enteros válidos entre 0 y 130 años";
    }
    if (esBebe && (minimo !== 0 || maximo !== 1)) {
      return "Menores de 2 años admite un único rango de 0 a 1 años";
    }
    if (!esBebe && minimo < EDAD_MINIMA_MENOR) {
      return "Las edades de 0 a 1 años corresponden al tipo Menores de 2 años";
    }
    if (!esBebe && minimo < EDAD_MINIMA_ADULTO && (maximo === null || maximo >= EDAD_MINIMA_ADULTO)) {
      return "Separá los rangos de menores (2 a 17 años) y adultos (desde 18 años)";
    }
    const maximoComparable = maximo === null ? EDAD_MAXIMA : maximo;
    if (anteriores.some((anterior) => minimo <= anterior.maximo && maximoComparable >= anterior.minimo)) {
      return "Los rangos de edad del mismo tipo de persona no pueden solaparse";
    }
    anteriores.push({ minimo, maximo: maximoComparable });
  }

  return null;
}

module.exports = {
  EDAD_MINIMA_ADULTO,
  EDAD_MINIMA_MENOR,
  TIPO_PERSONA_BEBE,
  validarRangosEdadTemporada,
};
