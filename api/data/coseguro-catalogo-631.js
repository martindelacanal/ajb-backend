"use strict";

// Fuente: Plan_de_Cuentas_631.xlsx, hoja «Plan de Cuentas», entregado por el cliente.
// Todas las filas con código y título son seleccionables, incluidas las cuentas 00.
const { completarAdjuntos } = require("./coseguro-limites-archivos");
const GRUPOS = [
  { codigo: "631.000", nombre: "General", icono: "health_and_safety" },
  { codigo: "631.100", nombre: "Internaciones", icono: "local_hospital" },
  { codigo: "631.200", nombre: "Medicina", icono: "stethoscope" },
  { codigo: "631.300", nombre: "Bioquímica", icono: "biotech" },
  { codigo: "631.400", nombre: "Medicamentos", icono: "medication" },
  { codigo: "631.500", nombre: "Odontología", icono: "dentistry" },
  { codigo: "631.600", nombre: "Otras prestaciones", icono: "health_and_safety" },
  { codigo: "511.700", nombre: "Subsidios", icono: "volunteer_activism" },
].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

const FILAS = [
  ["631.000", "GASTOS EN PRESTACIONES", "health_and_safety"],
  ["631.100", "INTERNACIONES Y GASTOS SANATORIALES", "local_hospital"],
  ["631.103", "REINTEGROS INTERNACIONES", "local_hospital", ["Internación geriátrica", "Otros"]],
  ["631.105", "ACOMPAÑANTE TERAPEUTICO", "accessibility_new"],
  ["631.200", "SERVICIOS MEDICOS", "stethoscope"],
  ["631.202", "BONO DE CONSULTA", "confirmation_number"],
  ["631.203", "HONORARIOS MEDICOS PARTICULARES/EXCEPCIONES", "stethoscope"],
  ["631.205", "MEDICOS COORDINADORES DE ZONA", "medical_services"],
  ["631.206", "PRACTICAS MEDICAS", "medical_services", ["Con cobertura IOMA", "Sin cobertura IOMA"]],
  ["631.300", "PRESTACIONES BIOQUIMICAS", "biotech"],
  ["631.301", "PRESTACIONES PRACTICAS BIOQUIMICAS", "biotech", ["Bono bioquímico", "Prácticas no autorizadas IOMA"]],
  ["631.400", "MEDICAMENTOS AMBULATORIOS", "medication"],
  ["631.401", "PAGO A FARMACIA SINDICAL", "local_pharmacy"],
  ["631.402", "PAGO A OTRAS FARMACIAS", "local_pharmacy"],
  ["631.403", "REINTEGRO DE MEDICAMENTOS", "medication"],
  ["631.500", "PRACTICAS ODONTOLOGICAS", "dentistry"],
  ["631.501", "REINTEGROS ODONTOLOGICOS POR EXCEPCION", "dentistry"],
  ["631.502", "REINTEGROS ODONTOLOGICOS", "dentistry"],
  ["631.503", "SUBSIDIOS PROTESIS ODONTOLOGICAS", "dentistry"],
  ["631.504", "SUBSIDIOS POR TRATAMIENTO DE ORTODONCIA", "dentistry"],
  ["631.505", "AUDITORIA ODONTOLOGICA", "fact_check"],
  ["631.600", "PRESTACIONES VARIAS", "health_and_safety"],
  ["631.601", "REINTEGROS POR PSIQUIATRIA", "neurology"],
  ["631.602", "REINTEGROS POR PSICOLOGIA", "psychology", ["Terapia individual", "Terapia familiar y otras"]],
  ["631.603", "PRESTACIONES PARAMEDICAS", "healing", ["Enfermería", "Instrumentación quirúrgica", "Curso preparto", "Anestesista", "Fonoaudiología", "Terapia ocupacional"]],
  ["631.604", "REINTEGRO POR CRISTALES", "visibility"],
  ["631.605", "REINTEGRO POR AMAZON", "eyeglasses"],
  ["631.606", "HOSPEDAJE", "hotel", ["Reintegros por hospedaje de salud", "Convenios por hospedaje"]],
  ["631.607", "REINTEGRO POR MATERIAL DESCARTABLE", "sanitizer"],
  ["631.608", "REINTEGRO ORTOPEDIA", "accessible"],
  ["631.609", "REINTEGRO KINESIOLOGIA", "sports_gymnastics"],
  ["631.611", "OTRAS PRESTACIONES", "health_and_safety"],
  ["631.612", "REINTEGROS POR REHABILITACION", "physical_therapy"],
  ["631.613", "SUBSIDIOS FALLECIMIENTOS", "volunteer_activism"],
  ["631.614", "SUBSIDIOS CELIAQUIA", "no_food"],
  ["511.701", "SUBSIDIO POR NACIMIENTO - ADOPCION", "child_care"],
];

function adjuntosPara(codigo) {
  if (codigo === "631.202") return [{ key: "BONO_FRENTE", label: "Foto del bono (frente)", requerido: 1 }, { key: "BONO_DORSO", label: "Foto del bono (dorso)", requerido: 0 }];
  if (codigo === "511.701") return [{ key: "PARTIDA_NACIMIENTO", label: "Partida de nacimiento / constancia de adopción", requerido: 1 }, { key: "DNI_RECIEN_NACIDO", label: "DNI del hijo o hija", requerido: 0 }];
  if (["631.401", "631.402", "631.403"].includes(codigo)) return [{ key: "RECETA", label: "Receta médica", requerido: 1 }, { key: "TICKET_FISCAL", label: "Ticket fiscal de la farmacia", requerido: 1 }, { key: "TROQUEL", label: "Troquel del medicamento", requerido: 0 }, { key: "DETALLE_COMPRA", label: "Detalle de la compra", requerido: 0 }];
  if (["631.206", "631.301"].includes(codigo)) return [{ key: "PRESCRIPCION", label: "Prescripción médica", requerido: 1 }, { key: "FACTURA", label: "Factura / ticket fiscal", requerido: 1 }, { key: "DETALLE_COMPRA", label: "Detalle de la práctica", requerido: 0 }];
  return [{ key: "FACTURA", label: "Factura / recibo de la prestación", requerido: 1 }, { key: "DOCUMENTACION", label: "Documentación respaldatoria", requerido: 0 }, { key: "PRESCRIPCION", label: "Prescripción / derivación médica", requerido: 0 }];
}

const TIPOS = FILAS.map(([codigo, nombre, icono, conceptos = []]) => {
  const grupoCodigo = `${codigo.slice(0, 5)}00`;
  const grupo = GRUPOS.find((item) => item.codigo === grupoCodigo);
  return { codigo, nombre, icono, grupo_codigo: grupo.codigo, grupo_nombre: grupo.nombre, grupo_icono: grupo.icono,
    conceptos: conceptos.sort((a, b) => a.localeCompare(b, "es")),
    requiere_pto_venta: ["631.202", "511.701", "631.611", "631.613", "631.614"].includes(codigo) ? 0 : 1,
    adjuntos: completarAdjuntos(adjuntosPara(codigo)) };
}).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

function normalizarCicCodigo(valor) {
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const codigo = String(valor).trim();
  if (!/^\d+(?:\.\d+)?$/.test(codigo) || codigo.length > 20) return null;
  return /^\d{6}$/.test(codigo) ? `${codigo.slice(0, 3)}.${codigo.slice(3)}` : codigo;
}

module.exports = { GRUPOS, TIPOS, normalizarCicCodigo };
