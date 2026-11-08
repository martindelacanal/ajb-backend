/* Etiquetas de balanza (EAN-13 de peso variable). Lo usan el servidor y las pantallas.

   Formato de la balanza del camping (configurable en Sistema → Configuración):
     2 000140 00485 0
     │ └─┬──┘ └─┬─┘ └ dígito verificador
     │   │      └ gramos (5 dígitos: hasta 99,999 kg)
     └───┴ código del producto en el sistema (7 dígitos) = 2 + PLU de 5 dígitos + 0
   Ej.: el jamón cocido es el PLU 14 de la balanza → código 2000140; la etiqueta
   2000140004850 son 485 g y la 2000140010653, 1,065 kg. */
(function () {
  "use strict";

  var DEFECTO = { prefijo: "2", digitos_codigo: 7 };

  function formato(config) {
    config = config || {};
    var prefijo = String(config.balanza_prefijo == null || config.balanza_prefijo === "" ? DEFECTO.prefijo : config.balanza_prefijo).trim();
    var digitos = Number(config.balanza_digitos_codigo == null || config.balanza_digitos_codigo === "" ? DEFECTO.digitos_codigo : config.balanza_digitos_codigo);
    if (!/^\d{1,3}$/.test(prefijo)) prefijo = DEFECTO.prefijo;
    if (!(digitos >= prefijo.length + 1 && digitos <= 8)) digitos = DEFECTO.digitos_codigo;
    return { prefijo: prefijo, digitos_codigo: digitos, digitos_peso: 12 - digitos, activa: String(config.balanza_activa == null ? "1" : config.balanza_activa) !== "0" };
  }

  function digitoControl(cuerpo) {
    var suma = 0;
    for (var i = cuerpo.length - 1, peso = 3; i >= 0; i--, peso = peso === 3 ? 1 : 3) suma += Number(cuerpo[i]) * peso;
    return String((10 - suma % 10) % 10);
  }

  // Devuelve null si el texto no es una etiqueta de balanza válida con este formato.
  function leer(texto, config) {
    var f = formato(config);
    var s = String(texto == null ? "" : texto).trim();
    if (!f.activa || !/^\d{13}$/.test(s) || s.indexOf(f.prefijo) !== 0) return null;
    if (digitoControl(s.slice(0, 12)) !== s.slice(12)) return null;
    var gramos = Number(s.slice(f.digitos_codigo, 12));
    if (!(gramos > 0)) return null;
    var codigo = s.slice(0, f.digitos_codigo);
    return { etiqueta: s, codigo: codigo, gramos: gramos, kg: Math.round(gramos) / 1000, plu: pluDeCodigo(codigo, config) };
  }

  // Número de la balanza (PLU) ↔ código del producto: prefijo + PLU con ceros + 0.
  function largoPlu(f) { return f.digitos_codigo - f.prefijo.length - 1; }
  function codigoDePlu(plu, config) {
    var f = formato(config);
    var n = String(plu == null ? "" : plu).trim();
    if (!/^\d+$/.test(n) || Number(n) <= 0 || largoPlu(f) < 1 || String(Number(n)).length > largoPlu(f)) return null;
    var relleno = String(Number(n));
    while (relleno.length < largoPlu(f)) relleno = "0" + relleno;
    return f.prefijo + relleno + "0";
  }
  function pluDeCodigo(codigo, config) {
    var f = formato(config);
    var s = String(codigo == null ? "" : codigo);
    if (largoPlu(f) < 1 || s.length !== f.digitos_codigo || s.indexOf(f.prefijo) !== 0 || s.slice(-1) !== "0") return null;
    var plu = Number(s.slice(f.prefijo.length, -1));
    return plu > 0 ? plu : null;
  }

  var Balanza = { formato: formato, leer: leer, codigoDePlu: codigoDePlu, pluDeCodigo: pluDeCodigo, digitoControl: digitoControl };
  if (typeof module === "object" && module.exports) module.exports = Balanza;
  else if (!window.__SIN_SOPORTE) window.P.balanza = Balanza;
})();
