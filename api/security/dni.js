"use strict";

// ============================================================================
// DNI — misma regla que el front (FRONTEND/src/app/utils/dni.utils.ts):
// un documento argentino va de 6 a 8 dígitos. Vive acá para que la API no
// acepte por HTTP lo que el formulario bloquea en el navegador.
// ============================================================================

const DNI_MIN_DIGITOS = 6;
const DNI_MAX_DIGITOS = 8;
const DNI_PATTERN = new RegExp(`^\\d{${DNI_MIN_DIGITOS},${DNI_MAX_DIGITOS}}$`);
const DNI_MENSAJE = `El DNI debe tener entre ${DNI_MIN_DIGITOS} y ${DNI_MAX_DIGITOS} dígitos`;

function esDniValido(valor) {
  return DNI_PATTERN.test(String(valor ?? "").trim());
}

module.exports = {
  DNI_MIN_DIGITOS,
  DNI_MAX_DIGITOS,
  DNI_PATTERN,
  DNI_MENSAJE,
  esDniValido,
};
