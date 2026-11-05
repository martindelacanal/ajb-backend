// Detección de navegadores que no sirven (Internet Explorer y similares). ES5 a propósito,
// sin evaluar código (la política de seguridad de la página lo impide).
(function () {
  var ok = typeof window.fetch === "function" && typeof window.Promise === "function" && typeof Object.assign === "function" &&
    typeof String.prototype.padStart === "function" && "noModule" in document.createElement("script") &&
    !!(window.CSS && CSS.supports && CSS.supports("display", "grid"));
  if (!ok) {
    window.__SIN_SOPORTE = true;
    var aviso = document.getElementById("sin-soporte");
    if (aviso) aviso.removeAttribute("hidden");
  }
})();
