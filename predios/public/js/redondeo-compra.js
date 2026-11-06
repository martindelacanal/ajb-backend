/* Margen por redondear cada unitario (o renglón) y el total al peso más cercano. */
(function () {
  "use strict";
  function limiteRedondeoCompra(lineas) {
    var unidades = lineas.reduce(function (suma, linea) {
      return suma + Math.max(1, Number(linea.cantidad));
    }, 0);
    return Math.ceil((1 + unidades) * 50) / 100;
  }
  if (typeof module === "object" && module.exports) module.exports = limiteRedondeoCompra;
  else if (!window.__SIN_SOPORTE) window.P.limiteRedondeoCompra = limiteRedondeoCompra;
})();
