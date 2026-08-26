"use strict";

/**
 * Registro uniforme de errores capturados en las rutas.
 *
 * Los errores "de negocio" (los que se crean con `statusCode` 4xx, por ejemplo
 * "Ya tenés una reserva iniciada") son respuestas esperadas a un pedido inválido,
 * no fallos del sistema: se dejan en una sola línea, sin stack, para que el log
 * de pm2 muestre solo los errores reales con su traza completa.
 */

function esErrorDeNegocio(error) {
  const status = Number(error?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

function registrarErrorRuta(error, contexto = "") {
  const prefijo = contexto ? `[${contexto}] ` : "";
  if (esErrorDeNegocio(error)) {
    const codigo = error.codigo ? ` (${error.codigo})` : "";
    console.warn(`${prefijo}[negocio ${error.statusCode}${codigo}] ${error.message}`);
    return;
  }
  console.error(prefijo ? `${prefijo}${error?.stack || error}` : error);
}

module.exports = { esErrorDeNegocio, registrarErrorRuta };
