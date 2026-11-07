"use strict";

const MENSAJE_RECURSO_UNICO = "Cada reserva admite un solo recurso. Para otro recurso, creá otra reserva y asignale sus personas.";

function rechazar(mensaje) {
  const error = new Error(mensaje);
  error.status = error.statusCode = 400;
  error.codigo = "RECURSO_UNICO_POR_RESERVA";
  throw error;
}

function idRecurso(valor) {
  if (!["string", "number"].includes(typeof valor) || !String(valor).trim()) return null;
  const id = Number(valor);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Se admite el arreglo unitario de clientes anteriores durante su actualización.
// Nunca se ignora una selección múltiple ni se toma su primer elemento.
function recursoUnico(datos, requerido = true) {
  const vacio = datos.recurso_id == null || datos.recurso_id === "";
  const id = vacio ? null : idRecurso(datos.recurso_id);
  if ((!vacio && id === null) || (requerido && id === null)) rechazar("Indicá un recurso válido para la reserva.");
  if (datos.recursos_ids != null) {
    const seleccion = datos.recursos_ids;
    if (!Array.isArray(seleccion) || seleccion.length > 1) rechazar(MENSAJE_RECURSO_UNICO);
    if (seleccion.length !== (id === null ? 0 : 1) || (seleccion.length && idRecurso(seleccion[0]) !== id)) {
      rechazar("La selección debe coincidir con el único recurso de la reserva.");
    }
  }
  return id;
}

module.exports = { recursoUnico, MENSAJE_RECURSO_UNICO };
