"use strict";

// Los prefijos siguen la misma convencion que usa el frontend para
// iconos/navegacion. Salud se excluye expresamente de Turismo porque ambos
// comparten el prefijo historico RESERVA_.
const MODULOS_NOTIFICACION = {
  coseguro: { prefijos: ["COSEGURO"] },
  salud: { prefijos: ["RESERVA_SALUD"] },
  turismo: {
    prefijos: ["RESERVA_", "CONVENIO_", "TURISMO_"],
    tipos: ["SORTEO_ADJUDICADO"],
    excluirPrefijos: ["RESERVA_SALUD"],
  },
  traslados: { prefijos: ["TRASLADO"] },
  olimpiadas: { prefijos: ["OLIMPIADA"] },
  beneficios: { prefijos: ["BENEFICIO"] },
};

function construirCondicion(def) {
  const partes = [];
  const params = [];
  (def.prefijos || []).forEach((prefijo) => {
    partes.push("n.tipo LIKE ?");
    params.push(`${prefijo}%`);
  });
  if (def.tipos?.length) {
    partes.push(`n.tipo IN (${def.tipos.map(() => "?").join(", ")})`);
    params.push(...def.tipos);
  }

  const exclusiones = [];
  (def.excluirPrefijos || []).forEach((prefijo) => {
    exclusiones.push("n.tipo NOT LIKE ?");
    params.push(`${prefijo}%`);
  });
  const inclusion = `(${partes.join(" OR ")})`;
  return {
    sql: exclusiones.length
      ? `((${inclusion}) AND ${exclusiones.join(" AND ")})`
      : inclusion,
    params,
  };
}

function condicionModuloNotificacion(modulo) {
  if (Object.prototype.hasOwnProperty.call(MODULOS_NOTIFICACION, modulo)) {
    return construirCondicion(MODULOS_NOTIFICACION[modulo]);
  }

  if (modulo === "otras") {
    const conocidas = Object.values(MODULOS_NOTIFICACION).map(construirCondicion);
    return {
      sql: `NOT (${conocidas.map((condicion) => condicion.sql).join(" OR ")})`,
      params: conocidas.flatMap((condicion) => condicion.params),
    };
  }

  return null;
}

module.exports = {
  MODULOS_NOTIFICACION,
  condicionModuloNotificacion,
};
