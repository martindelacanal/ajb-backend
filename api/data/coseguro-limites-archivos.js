"use strict";

const LIMITES_ARCHIVOS = Object.freeze({
  por_tipo: 5,
  total: 20,
  peso_archivo_bytes: 5 * 1024 * 1024,
  peso_total_bytes: 50 * 1024 * 1024,
});
const ADJUNTO_OTROS = Object.freeze({ key: "OTROS_COMPROBANTES", label: "Otros comprobantes", requerido: 0 });

function completarAdjuntos(config) {
  const adjuntos = Array.isArray(config) ? config : [];
  return [...adjuntos.filter((adjunto) => adjunto?.key !== ADJUNTO_OTROS.key), { ...ADJUNTO_OTROS }];
}

module.exports = { LIMITES_ARCHIVOS, ADJUNTO_OTROS, completarAdjuntos };
