const { normalizarFechaCivil } = require("./valores-dominio");

const ESTADOS_RESERVA_TERMINALES = new Set([
  "cancelada",
  "rechazada",
  "utilizada",
  "no adjudicada",
  "convenio rechazado",
]);

function normalizarEstado(valor) {
  return typeof valor === "string" ? valor.trim().toLowerCase() : "";
}

function esEstadoReservaTerminal(nombre) {
  return ESTADOS_RESERVA_TERMINALES.has(normalizarEstado(nombre));
}

function estadoInicialSorteoPermitido(estado) {
  const normalizado = typeof estado === "string" ? estado.trim().toUpperCase() : "";
  return normalizado === "BORRADOR" || normalizado === "ACTIVO";
}

function crearResultadoInvalido(codigo, mensaje) {
  return { codigo, mensaje };
}

function validarAdjudicacionSorteo({
  estadoBloque,
  estadoSorteo,
  fechaFinInscripcion,
  fechaInicioBloque,
  hoy,
}) {
  if (estadoBloque !== "ACTIVO" || estadoSorteo !== "ACTIVO") {
    return crearResultadoInvalido(
      "SORTEO_NO_ADJUDICABLE",
      "El bloque y el sorteo deben estar activos para adjudicar"
    );
  }

  const fechaActual = normalizarFechaCivil(hoy);
  const finInscripcion = normalizarFechaCivil(fechaFinInscripcion);
  const inicioBloque = normalizarFechaCivil(fechaInicioBloque);
  if (!fechaActual || !finInscripcion || !inicioBloque) {
    return crearResultadoInvalido(
      "FECHAS_SORTEO_INVALIDAS",
      "Las fechas del sorteo o del bloque no son validas"
    );
  }

  if (fechaActual <= finInscripcion) {
    return crearResultadoInvalido(
      "INSCRIPCION_SORTEO_ABIERTA",
      "La inscripcion debe estar cerrada antes de adjudicar"
    );
  }

  if (fechaActual >= inicioBloque) {
    return crearResultadoInvalido(
      "BLOQUE_YA_INICIADO",
      "El bloque ya inicio y no admite adjudicaciones"
    );
  }

  return null;
}

function validarRespuestaAdjudicacion({
  estadoBloque,
  estadoSorteo,
  fechaInicioBloque,
  hoy,
}) {
  if (estadoBloque !== "ACTIVO" || !["ACTIVO", "CERRADO"].includes(estadoSorteo)) {
    return crearResultadoInvalido(
      "ADJUDICACION_NO_PROCESABLE",
      "El bloque o el sorteo ya no admiten respuestas"
    );
  }

  const fechaActual = normalizarFechaCivil(hoy);
  const inicioBloque = normalizarFechaCivil(fechaInicioBloque);
  if (!fechaActual || !inicioBloque) {
    return crearResultadoInvalido(
      "FECHAS_SORTEO_INVALIDAS",
      "Las fechas del sorteo o del bloque no son validas"
    );
  }

  if (fechaActual > inicioBloque) {
    return crearResultadoInvalido(
      "RESPUESTA_ADJUDICACION_VENCIDA",
      "El plazo para responder la adjudicacion ya vencio"
    );
  }

  return null;
}

function obtenerEstadoRecursoTrasRechazo({ estadoBloque, estadoSorteo }) {
  if (estadoBloque !== "ACTIVO" || estadoSorteo === "CANCELADO") {
    return "LIBERADO";
  }
  if (estadoSorteo === "ACTIVO") {
    return "SORTEO";
  }
  if (estadoSorteo === "CERRADO") {
    return "VENTA_DIRECTA";
  }
  return "LIBERADO";
}

function obtenerEstadoRecursoTrasLiberacion({ modalidad, estadoBloque, estadoSorteo }) {
  if (estadoBloque !== "ACTIVO") {
    return "LIBERADO";
  }
  if (modalidad !== "SORTEO") {
    return "DISPONIBLE";
  }
  return obtenerEstadoRecursoTrasRechazo({ estadoBloque, estadoSorteo });
}

module.exports = {
  estadoInicialSorteoPermitido,
  esEstadoReservaTerminal,
  obtenerEstadoRecursoTrasLiberacion,
  obtenerEstadoRecursoTrasRechazo,
  validarAdjudicacionSorteo,
  validarRespuestaAdjudicacion,
};
