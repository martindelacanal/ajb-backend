"use strict";

// Fuente: Plan_de_Cuentas_631.xlsx, hoja «Plan de Cuentas», entregado por el cliente.
// Las filas sin descripción y los rubros no son prestaciones seleccionables.
const GRUPOS = [
  { codigo: "631.100", nombre: "Internaciones", icono: "local_hospital" },
  { codigo: "631.200", nombre: "Medicina", icono: "stethoscope" },
  { codigo: "631.300", nombre: "Bioquímica", icono: "biotech" },
  { codigo: "631.400", nombre: "Medicamentos", icono: "medication" },
  { codigo: "631.500", nombre: "Odontología", icono: "dentistry" },
  { codigo: "631.600", nombre: "Otras prestaciones", icono: "health_and_safety" },
  { codigo: "511.700", nombre: "Subsidios", icono: "volunteer_activism" },
].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

const FILAS = [
  ["631.103", "Internaciones", "local_hospital", ["Internación geriátrica", "Otros"]],
  ["631.105", "Acompañante terapéutico", "accessibility_new"],
  ["631.202", "Bono de consulta", "confirmation_number"],
  ["631.203", "Honorarios médicos particulares / excepciones", "stethoscope"],
  ["631.205", "Médicos coordinadores de zona", "medical_services"],
  ["631.206", "Prácticas médicas", "medical_services", ["Con cobertura IOMA", "Sin cobertura IOMA"]],
  ["631.301", "Prácticas bioquímicas", "biotech", ["Bono bioquímico", "Prácticas no autorizadas IOMA"]],
  ["631.401", "Pago a farmacia sindical", "local_pharmacy"],
  ["631.402", "Pago a otras farmacias", "local_pharmacy"],
  ["631.403", "Medicamentos", "medication"],
  ["631.501", "Odontología por excepción", "dentistry"],
  ["631.502", "Odontología", "dentistry"],
  ["631.503", "Prótesis odontológicas", "dentistry"],
  ["631.504", "Tratamiento de ortodoncia", "dentistry"],
  ["631.505", "Auditoría odontológica", "fact_check"],
  ["631.601", "Psiquiatría", "neurology"],
  ["631.602", "Psicología", "psychology", ["Terapia individual", "Terapia familiar y otras"]],
  ["631.603", "Prestaciones paramédicas", "healing", ["Enfermería", "Instrumentación quirúrgica", "Curso preparto", "Anestesista", "Fonoaudiología", "Terapia ocupacional"]],
  ["631.604", "Cristales", "visibility"],
  ["631.605", "Armazón", "eyeglasses"],
  ["631.606", "Hospedaje", "hotel", ["Reintegros por hospedaje de salud", "Convenios por hospedaje"]],
  ["631.607", "Material descartable", "sanitizer"],
  ["631.608", "Ortopedia", "accessible"],
  ["631.609", "Kinesiología", "sports_gymnastics"],
  ["631.611", "Otras prestaciones", "health_and_safety"],
  ["631.612", "Rehabilitación", "physical_therapy"],
  ["631.613", "Subsidio por fallecimiento", "volunteer_activism"],
  ["631.614", "Subsidio por celiaquía", "no_food"],
  ["511.701", "Subsidio por nacimiento / adopción", "child_care"],
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
    adjuntos: adjuntosPara(codigo) };
}).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

function normalizarCicCodigo(valor) {
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const codigo = String(valor).trim();
  if (!/^\d+(?:\.\d+)?$/.test(codigo) || codigo.length > 20) return null;
  return /^\d{6}$/.test(codigo) ? `${codigo.slice(0, 3)}.${codigo.slice(3)}` : codigo;
}

module.exports = { GRUPOS, TIPOS, normalizarCicCodigo };
