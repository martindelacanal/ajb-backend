"use strict";

// Misma regla que nombrePrestacion() del frontend (utils/coseguro-catalogo.utils.ts):
// los nombres del plan de cuentas 631 vienen en MAYÚSCULAS y sin tilde
// («REINTEGRO DE MEDICAMENTOS»); para mostrarlos pasan a oración y recuperan
// tildes, nombres propios y siglas. Si cambia una lista, cambiar las dos.

/** Palabras del plan de cuentas 631 que en la base vienen en MAYÚSCULAS y sin tilde. */
const TILDES_CATALOGO = Object.freeze({
  adopcion: "adopción",
  auditoria: "auditoría",
  bioquimica: "bioquímica",
  bioquimicas: "bioquímicas",
  bioquimico: "bioquímico",
  celiaquia: "celiaquía",
  excepcion: "excepción",
  internacion: "internación",
  kinesiologia: "kinesiología",
  medica: "médica",
  medicas: "médicas",
  medico: "médico",
  medicos: "médicos",
  odontologica: "odontológica",
  odontologicas: "odontológicas",
  odontologico: "odontológico",
  odontologicos: "odontológicos",
  paramedica: "paramédica",
  paramedicas: "paramédicas",
  practica: "práctica",
  practicas: "prácticas",
  prestacion: "prestación",
  protesis: "prótesis",
  psicologia: "psicología",
  psiquiatria: "psiquiatría",
  rehabilitacion: "rehabilitación",
  terapeutica: "terapéutica",
  terapeutico: "terapéutico",
});

/** Nombres propios y siglas que no van en minúscula. */
const PROPIOS_CATALOGO = Object.freeze({
  ajb: "AJB",
  amazon: "Amazon",
  dni: "DNI",
  ioma: "IOMA",
  pami: "PAMI",
});

/**
 * Nombre del catálogo para mostrar. Los que llegan en MAYÚSCULAS pasan a
 * oración con tildes, nombres propios y siglas; los que ya traen minúsculas
 * («Con cobertura IOMA») se respetan tal cual.
 */
function nombrePrestacion(valor) {
  const texto = valor === null || valor === undefined ? "" : String(valor).trim();
  if (!texto) return "";
  if (/\p{Ll}/u.test(texto)) return texto;
  const minusculas = texto.toLocaleLowerCase("es");
  const oracion = minusculas.charAt(0).toLocaleUpperCase("es") + minusculas.slice(1);
  return oracion.replace(/\p{L}+/gu, (palabra) => {
    const clave = palabra.toLocaleLowerCase("es");
    const propio = PROPIOS_CATALOGO[clave];
    if (propio) return propio;
    const conTilde = TILDES_CATALOGO[clave];
    if (!conTilde) return palabra;
    const inicial = palabra.charAt(0);
    return inicial !== inicial.toLocaleLowerCase("es") ? conTilde.charAt(0).toLocaleUpperCase("es") + conTilde.slice(1) : conTilde;
  });
}

module.exports = { nombrePrestacion };
