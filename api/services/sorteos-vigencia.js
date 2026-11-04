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
      "Las fechas del sorteo o del bloque no son válidas"
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
      "Las fechas del sorteo o del bloque no son válidas"
    );
  }

  if (fechaActual > inicioBloque) {
    return crearResultadoInvalido(
      "RESPUESTA_ADJUDICACION_VENCIDA",
      "El plazo para responder la adjudicación ya venció"
    );
  }

  return null;
}

// Estados de una inscripción que todavía espera el sorteo (sin unidad asignada).
const ESTADOS_INSCRIPCION_SORTEO_EN_ESPERA = new Set([
  "solicitud sorteo",
  "pendiente_aprobacion_titular",
]);

/**
 * Baja que pide la persona afiliada de su propia inscripción a un sorteo antes
 * de que se sortee. La inscripción no ocupa ninguna unidad (recurso_id NULL),
 * así que darla de baja no libera nada; una vez adjudicada se responde desde el
 * aviso de adjudicación, y con el sorteo cerrado o cancelado ya no corre.
 */
function validarBajaInscripcionSorteo({
  esPropietario,
  recursoId,
  tieneAdjudicacion,
  estadoReserva,
  estadoSorteo,
}) {
  if (!esPropietario) {
    return crearResultadoInvalido(
      "INSCRIPCION_AJENA",
      "Sólo podés darte de baja de una inscripción tuya"
    );
  }
  if (recursoId || tieneAdjudicacion) {
    return crearResultadoInvalido(
      "INSCRIPCION_ADJUDICADA",
      "Tu inscripción ya salió sorteada: respondé desde el aviso de adjudicación"
    );
  }
  if (!ESTADOS_INSCRIPCION_SORTEO_EN_ESPERA.has(normalizarEstado(estadoReserva))) {
    return crearResultadoInvalido(
      "INSCRIPCION_NO_ACTIVA",
      "La inscripción ya no está activa"
    );
  }
  if (estadoSorteo !== "ACTIVO") {
    return crearResultadoInvalido(
      "SORTEO_YA_REALIZADO",
      "El sorteo ya se realizó o se canceló: la inscripción ya no se puede dar de baja"
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
  validarBajaInscripcionSorteo,
  validarRespuestaAdjudicacion,
};
