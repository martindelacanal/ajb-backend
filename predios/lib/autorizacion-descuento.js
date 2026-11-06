"use strict";

const { pesos } = require("./util");
const { CONFIG_POR_DEFECTO } = require("./negocio");

const MENORES_DE_TREINTA = [
  "CERO", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE",
  "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE",
  "VEINTE", "VEINTIÚN", "VEINTIDÓS", "VEINTITRÉS", "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS",
  "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE",
];
const DECENAS = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const CENTENAS = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

// Cardinal masculino para los pesos y para los grupos de miles y millones.
function cardinal(n) {
  if (n < 30) return MENORES_DE_TREINTA[n];
  if (n < 100) return DECENAS[Math.floor(n / 10)] + (n % 10 ? " Y " + cardinal(n % 10) : "");
  if (n === 100) return "CIEN";
  if (n < 1000) return CENTENAS[Math.floor(n / 100)] + (n % 100 ? " " + cardinal(n % 100) : "");

  const base = n < 1000000 ? 1000 : 1000000;
  const grupos = Math.floor(n / base);
  let prefijo;
  if (base === 1000) prefijo = grupos === 1 ? "MIL" : cardinal(grupos) + " MIL";
  else prefijo = grupos === 1 ? "UN MILLÓN" : cardinal(grupos) + " MILLONES";
  return prefijo + (n % base ? " " + cardinal(n % base) : "");
}

function autorizacionDescuento(config, importe) {
  const centavos = Math.round(Number(importe) * 100);
  const enteros = Math.floor(centavos / 100);
  const moneda = enteros === 1 ? " PESO" : " PESOS";
  const de = enteros > 0 && enteros % 1000000 === 0 ? " DE" : "";
  const fraccion = centavos % 100 ? " CON " + String(centavos % 100).padStart(2, "0") + "/100" : "";
  const suma = cardinal(enteros) + de + moneda + fraccion + " (" + pesos(importe) + ")";
  const texto = (config.texto_autorizacion || "").trim();
  if (texto && texto !== CONFIG_POR_DEFECTO.texto_autorizacion) return texto + "\nSUMA: " + suma;

  const razonSocial = config.razon_social || CONFIG_POR_DEFECTO.razon_social;
  return "Me dirijo a usted a efectos de autorizar expresamente a la " + razonSocial +
    " a retener de mi sueldo la suma de " + suma + " en ____ cuota/s, de acuerdo al sistema de descuento vigente.";
}

module.exports = { autorizacionDescuento };
