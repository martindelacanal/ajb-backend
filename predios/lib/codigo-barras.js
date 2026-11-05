"use strict";

// Un código corto puede ser interno o un UPC completo. Nunca se completa por longitud.
// Sólo se sugieren candidatos y el operador coteja el envase antes de corregirlo.
function digitoControl(cuerpo) {
  if (!/^\d+$/.test(String(cuerpo || ""))) return null;
  let suma = 0;
  const s = String(cuerpo);
  for (let i = s.length - 1, peso = 3; i >= 0; i--, peso = peso === 3 ? 1 : 3) suma += Number(s[i]) * peso;
  return String((10 - suma % 10) % 10);
}

function gtinValido(codigo) {
  const s = String(codigo || "");
  return /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(s) && digitoControl(s.slice(0, -1)) === s.slice(-1);
}

// Distancia de edición acotada a un carácter (incluye transposición contigua).
function diferenciaUnCaracter(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (i === Math.min(a.length, b.length)) return true;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1)
      || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  if (a.length < b.length) return a.slice(i) === b.slice(i + 1);
  return a.slice(i + 1) === b.slice(i);
}

function proximidadCodigo(guardado, leido) {
  const a = String(guardado || "");
  const b = String(leido || "");
  if (!/^\d{6,60}$/.test(a) || !/^\d{8,60}$/.test(b)) return null;
  if (a === b) return 0;
  // El sistema anterior recortaba el final; se tolera hasta seis dígitos faltantes,
  // sin presentar códigos internos muy cortos como supuestas identidades de producto.
  if (b.startsWith(a) && b.length - a.length <= 6) return b.length - a.length;
  if (diferenciaUnCaracter(a, b)) return 2;
  return null;
}

module.exports = { digitoControl, gtinValido, proximidadCodigo };
