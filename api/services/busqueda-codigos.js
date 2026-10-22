"use strict";

// Códigos de trámite en los buscadores de las bandejas (T-120, C-22, B-12…).
// Cada listado decide qué hace con el código; la regla común es que un código
// con prefijo busca ese id EXACTO ("T-12" no trae T-120) y que el número solo
// sigue siendo búsqueda amplia, porque puede ser parte de un DNI, de un
// importe o de una fecha.

// Guion común y las variantes tipográficas que llegan al copiar un texto:
// la guía «Cómo se usa» escribe «T‑120» con guion de no separación (U+2011).
const CODIGO_BUSCADO = /^(?:([a-z]{1,3})[-‐-―−]?|#)(\d{1,10})$/i;

/**
 * Lee el código de un trámite como lo escribe la gente en un buscador:
 *   "T-120", "t-120", "T120", "T 120", "T - 120" → { prefijo: "T", id: 120 }
 *   "#120"                                         → { prefijo: null, id: 120 } (el "#n" del staff)
 * `prefijos` es el prefijo del listado ("T") o la lista de los que admite
 * (["T", "C", "TR"]). Devuelve null si el texto no es un código de esos
 * prefijos: "120", "Torres 3", "T-" o "TR-120" en un listado de "T".
 */
function leerCodigoBuscado(texto, prefijos) {
  const limpio = String(texto ?? "").replace(/\s+/g, "");
  const partes = CODIGO_BUSCADO.exec(limpio);
  if (!partes) return null;
  const permitidos = [].concat(prefijos).map((prefijo) => String(prefijo).toUpperCase());
  const prefijo = partes[1] ? partes[1].toUpperCase() : null;
  if (prefijo && !permitidos.includes(prefijo)) return null;
  const id = Number(partes[2]);
  return Number.isSafeInteger(id) && id > 0 ? { prefijo, id } : null;
}

module.exports = { leerCodigoBuscado };
