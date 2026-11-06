/* La caja y la vista previa usan el mismo múltiplo de $100.
   El cálculo en centavos evita que un error decimal suba otro escalón. */
(function () {
  "use strict";
  function precioDeVenta(costo, margen) {
    var centavos = Math.round((Number(costo || 0) + Number.EPSILON) * 100);
    var factor = 10000 + Math.round((Number(margen || 0) + Number.EPSILON) * 100);
    var unidad = 100000000;
    // Separar el cociente mantiene exacto el producto con montos DECIMAL(14,2).
    var centenas = Math.floor(centavos / unidad) * factor + Math.ceil((centavos % unidad) * factor / unidad);
    return centenas * 100;
  }
  if (typeof module === "object" && module.exports) module.exports = precioDeVenta;
  else if (!window.__SIN_SOPORTE) window.P.precioDeVenta = precioDeVenta;
})();
