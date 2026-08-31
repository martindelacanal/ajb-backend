"use strict";

const IMAGEN_MUESTRA_SERVICIO = "6.png";
const IMAGEN_MUESTRA_RECURSO = "10.png";

const TIPOS_SERVICIO = Object.freeze([
  {
    codigo: "ALOJAMIENTO_RECURSO",
    nombre: "Alojamiento por recurso",
    descripcion: "Reservas de una habitación, cabaña, departamento u otra unidad identificable.",
    activo: 1,
    orden: 10,
    legacyId: 1,
  },
  {
    codigo: "CUPO_NUMERADO",
    nombre: "Cupo numerado",
    descripcion: "Reservas contra un cupo por período con asignación de un identificador, por ejemplo una parcela.",
    activo: 1,
    orden: 20,
  },
  {
    codigo: "CONVENIO_HOTELERO",
    nombre: "Convenio hotelero",
    descripcion: "Alojamiento ofrecido por un prestador en convenio y sujeto a propuesta o confirmación.",
    activo: 1,
    orden: 30,
  },
]);

const FILTROS = Object.freeze([
  { legacyId: 1, codigo: "PERSONAS", nombre: "Personas", tipoValor: "NUMERO", categoria: "Capacidad", unidad: "personas", ayuda: "Capacidad máxima informada para la unidad.", opciones: null, activo: 1, orden: 10 },
  { legacyId: 2, codigo: "AMBIENTES", nombre: "Ambientes", tipoValor: "NUMERO", categoria: "Distribución", unidad: "ambientes", ayuda: "Cantidad de ambientes de la unidad.", opciones: null, activo: 1, orden: 20 },
  { codigo: "HABITACIONES", nombre: "Habitaciones", tipoValor: "NUMERO", categoria: "Distribución", unidad: "habitaciones", ayuda: "Cantidad de habitaciones o dormitorios separados.", opciones: null, activo: 1, orden: 30 },
  { codigo: "PLANTAS", nombre: "Plantas", tipoValor: "NUMERO", categoria: "Distribución", unidad: "plantas", ayuda: "Cantidad de plantas de la unidad.", opciones: null, activo: 1, orden: 40 },
  { legacyId: 3, codigo: "CAMAS_INDIVIDUALES", nombre: "Camas individuales", tipoValor: "NUMERO", categoria: "Camas", unidad: "camas", ayuda: "Cantidad de camas individuales disponibles.", opciones: null, activo: 1, orden: 50 },
  { legacyId: 4, codigo: "CAMAS_MATRIMONIALES", nombre: "Camas matrimoniales", tipoValor: "NUMERO", categoria: "Camas", unidad: "camas", ayuda: "Cantidad de camas matrimoniales disponibles.", opciones: null, activo: 1, orden: 60 },
  { legacyId: 6, codigo: "BANOS", nombre: "Baños", tipoValor: "NUMERO", categoria: "Baños", unidad: "baños", ayuda: "Cantidad total de baños informada.", opciones: null, activo: 1, orden: 70 },
  { codigo: "BANO_PRIVADO", nombre: "Baño privado", tipoValor: "BOOLEANO", categoria: "Baños", unidad: null, ayuda: "Indica que la unidad posee baño privado.", opciones: null, activo: 1, orden: 80 },
  { codigo: "BANO_EN_SUITE", nombre: "Baño en suite", tipoValor: "BOOLEANO", categoria: "Baños", unidad: null, ayuda: "Indica que al menos uno de los baños es en suite.", opciones: null, activo: 1, orden: 90 },
  { codigo: "SIN_BANO", nombre: "Sin baño", tipoValor: "BOOLEANO", categoria: "Baños", unidad: null, ayuda: "La unidad fue informada expresamente como sin baño.", opciones: null, activo: 1, orden: 100 },
  { legacyId: 5, codigo: "MESA_SILLAS", nombre: "Mesa y sillas", tipoValor: "BOOLEANO", categoria: "Comodidades", unidad: null, ayuda: "La unidad incluye mesa y sillas.", opciones: null, activo: 1, orden: 110 },
  { codigo: "COCINA_EQUIPADA", nombre: "Cocina equipada", tipoValor: "BOOLEANO", categoria: "Comodidades", unidad: null, ayuda: "La unidad cuenta con cocina equipada.", opciones: null, activo: 1, orden: 120 },
  { codigo: "PARRILLA_PROPIA", nombre: "Parrilla propia", tipoValor: "BOOLEANO", categoria: "Comodidades", unidad: null, ayuda: "La unidad cuenta con parrilla de uso propio.", opciones: null, activo: 1, orden: 130 },
  { codigo: "TIPO_UNIDAD", nombre: "Tipo de unidad", tipoValor: "OPCION", categoria: "Tipo", unidad: null, ayuda: "Clasificación informada para el recurso.", opciones: ["Habitación", "Cabaña", "Departamento", "Parcela"], activo: 1, orden: 140 },
  { codigo: "UBICACION", nombre: "Ubicación", tipoValor: "OPCION", categoria: "Ubicación", unidad: null, ayuda: "Ubicación relativa de la unidad dentro del predio.", opciones: ["En cuerpo principal", "Frente al cuerpo", "Detrás del cuerpo", "Alejada del cuerpo"], activo: 1, orden: 150 },
  { codigo: "VISTA_MAR", nombre: "Vista al mar", tipoValor: "BOOLEANO", categoria: "Ubicación", unidad: null, ayuda: "La unidad fue informada con vista al mar.", opciones: null, activo: 1, orden: 160 },
  { codigo: "VENTANA_CALLE", nombre: "Ventana a la calle", tipoValor: "BOOLEANO", categoria: "Ubicación", unidad: null, ayuda: "La habitación posee ventana a la calle.", opciones: null, activo: 1, orden: 170 },
  { codigo: "ENTRA_CATRE", nombre: "Entra un catre", tipoValor: "BOOLEANO", categoria: "Camas", unidad: null, ayuda: "Hay espacio informado para agregar un catre.", opciones: null, activo: 1, orden: 180 },
  { codigo: "CAMA_MATRIMONIAL_ENTREPISO", nombre: "Cama matrimonial en entrepiso", tipoValor: "BOOLEANO", categoria: "Camas", unidad: null, ayuda: "La cama matrimonial se encuentra en un entrepiso.", opciones: null, activo: 1, orden: 190 },
]);

function recurso({
  legacyId = null,
  codigo,
  nombre,
  categoria,
  descripcion,
  activo = 1,
  orden,
  cupoMaximo = null,
  esRecursoPrincipal = 0,
  valores = {},
}) {
  return {
    legacyId,
    codigo,
    nombre,
    categoria,
    descripcion,
    activo,
    orden,
    cupoMaximo,
    esRecursoPrincipal,
    valores,
  };
}

const T = "TIPO_UNIDAD";
const P = "PERSONAS";
const A = "AMBIENTES";
const H = "HABITACIONES";
const PL = "PLANTAS";
const CI = "CAMAS_INDIVIDUALES";
const CM = "CAMAS_MATRIMONIALES";
const B = "BANOS";
const BP = "BANO_PRIVADO";
const BES = "BANO_EN_SUITE";
const SB = "SIN_BANO";
const MS = "MESA_SILLAS";
const CE = "COCINA_EQUIPADA";
const PP = "PARRILLA_PROPIA";
const U = "UBICACION";
const VM = "VISTA_MAR";
const VC = "VENTANA_CALLE";
const EC = "ENTRA_CATRE";
const CME = "CAMA_MATRIMONIAL_ENTREPISO";

const parador = [
  recurso({ codigo: "PAR-HAB-001", nombre: "Habitacion 1", categoria: "Habitacion", descripcion: "Habitacion, 2 personas, 1 ambiente, 1 cama matrimonial, En cuerpo principal", orden: 10, valores: { [T]: "Habitacion", [P]: 2, [A]: 1, [CM]: 1, [U]: "En cuerpo principal" } }),
  recurso({ codigo: "PAR-HAB-001-A", nombre: "Habitacion 1 A", categoria: "Habitacion", descripcion: "2 personas", orden: 20, valores: { [P]: 2 } }),
  recurso({ codigo: "PAR-HAB-002", nombre: "Habitacion 2", categoria: "Habitacion", descripcion: "Habitacion, 2 personas, 1 ambiente, 1 cama matrimonial, En cuerpo principal", orden: 30, valores: { [T]: "Habitacion", [P]: 2, [A]: 1, [CM]: 1, [U]: "En cuerpo principal" } }),
  recurso({ codigo: "PAR-HAB-003", nombre: "Habitacion 3", categoria: "Habitacion", descripcion: "Habitacion, 2 personas", orden: 40, valores: { [T]: "Habitacion", [P]: 2 } }),
  recurso({ codigo: "PAR-HAB-004", nombre: "Habitacion 4", categoria: "Habitacion", descripcion: "Habitacion, 1 ambiente, 2 personas, En cuerpo principal, 2 camas individuales", orden: 50, valores: { [T]: "Habitacion", [A]: 1, [P]: 2, [U]: "En cuerpo principal", [CI]: 2 } }),
  ...[
    [5, 4, 2, 2, 1, 2, 1, "Frente al cuerpo"],
    [6, 4, 2, 2, 1, 2, 1, "Frente al cuerpo"],
    [7, 4, 2, 2, 1, 2, 1, "Frente al cuerpo"],
  ].map(([numero, personas, plantas, habitaciones, matrimoniales, individuales, banos, ubicacion], index) => recurso({
    codigo: `PAR-CAB-${String(numero).padStart(3, "0")}`,
    nombre: `Cabana ${numero}`,
    categoria: "Cabana",
    descripcion: `Cabana, ${personas} personas, ${plantas} plantas, ${habitaciones} habitaciones, ${matrimoniales} cama matrimonial, ${individuales} camas individuales, ${banos} bano, Mesa y Sillas, ${ubicacion}`,
    orden: 100 + index * 10,
    valores: { [T]: "Cabana", [P]: personas, [PL]: plantas, [H]: habitaciones, [CM]: matrimoniales, [CI]: individuales, [B]: banos, [MS]: true, [U]: ubicacion },
  })),
  recurso({ codigo: "PAR-CAB-008", nombre: "Cabana 8", categoria: "Cabana", descripcion: "Cabana, 2 habitaciones, 1 cama matrimonial, 2 banos (1 en suite), Frente al cuerpo, 4 personas, 2 camas individuales", orden: 130, valores: { [T]: "Cabana", [H]: 2, [CM]: 1, [B]: 2, [BES]: true, [U]: "Frente al cuerpo", [P]: 4, [CI]: 2 } }),
  ...[9, 10].map((numero, index) => recurso({ codigo: `PAR-CAB-${String(numero).padStart(3, "0")}`, nombre: `Cabana ${numero}`, categoria: "Cabana", descripcion: "Cabana, 4 personas, 2 habitaciones, 4 camas individuales, 1 bano, Frente al cuerpo", orden: 140 + index * 10, valores: { [T]: "Cabana", [P]: 4, [H]: 2, [CI]: 4, [B]: 1, [U]: "Frente al cuerpo" } })),
  ...[11, 12].map((numero, index) => recurso({ codigo: `PAR-CAB-${String(numero).padStart(3, "0")}`, nombre: `Cabana ${numero}`, categoria: "Cabana", descripcion: "Cabana, 3 personas, 2 habitaciones, 3 camas individuales, 1 bano, Detras del cuerpo", orden: 160 + index * 10, valores: { [T]: "Cabana", [P]: 3, [H]: 2, [CI]: 3, [B]: 1, [U]: "Detras del cuerpo" } })),
  recurso({ codigo: "PAR-CAB-013", nombre: "Cabana 13", categoria: "Cabana", descripcion: "Cabana, 6 personas, 2 habitaciones, 1 cama matrimonial, 4 camas individuales, 1 bano, Frente al cuerpo", orden: 180, valores: { [T]: "Cabana", [P]: 6, [H]: 2, [CM]: 1, [CI]: 4, [B]: 1, [U]: "Frente al cuerpo" } }),
  recurso({ codigo: "PAR-CAB-014", nombre: "Cabana 14", categoria: "Cabana", descripcion: "Cabana, 5 personas, 2 habitaciones, 1 cama matrimonial, 3 camas individuales, 1 bano, Frente al cuerpo", orden: 190, valores: { [T]: "Cabana", [P]: 5, [H]: 2, [CM]: 1, [CI]: 3, [B]: 1, [U]: "Frente al cuerpo" } }),
  recurso({ codigo: "PAR-CAB-015", nombre: "Cabana 15", categoria: "Cabana", descripcion: "Cabana, 6 personas, 2 habitaciones, 1 cama matrimonial, 4 camas individuales, 1 bano, Frente al cuerpo", orden: 200, valores: { [T]: "Cabana", [P]: 6, [H]: 2, [CM]: 1, [CI]: 4, [B]: 1, [U]: "Frente al cuerpo" } }),
  recurso({ codigo: "PAR-CAB-023", nombre: "Cabana 23", categoria: "Cabana", descripcion: "Cabana, 5 personas, 1 ambiente, 1 cama matrimonial, 3 camas individuales, 1 bano, Detras del cuerpo", orden: 210, valores: { [T]: "Cabana", [P]: 5, [A]: 1, [CM]: 1, [CI]: 3, [B]: 1, [U]: "Detras del cuerpo" } }),
  recurso({ codigo: "PAR-CAB-024", nombre: "Cabana 24", categoria: "Cabana", descripcion: "Cabana, 5 personas, 1 ambiente, 1 cama matrimonial, 3 camas individuales, 1 bano, Detras del cuerpo", orden: 220, valores: { [T]: "Cabana", [P]: 5, [A]: 1, [CM]: 1, [CI]: 3, [B]: 1, [U]: "Detras del cuerpo" } }),
  recurso({ codigo: "PAR-CAB-025", nombre: "Cabana 25", categoria: "Cabana", descripcion: "Cabana, 5 personas, 2 habitaciones, 1 cama matrimonial, 3 camas individuales, 2 banos, Alejada del cuerpo", orden: 230, valores: { [T]: "Cabana", [P]: 5, [H]: 2, [CM]: 1, [CI]: 3, [B]: 2, [U]: "Alejada del cuerpo" } }),
  recurso({ codigo: "PAR-CAB-026", nombre: "Cabana 26", categoria: "Cabana", descripcion: "Cabana, 4 personas, 2 habitaciones, 1 cama matrimonial, 2 camas individuales, 1 bano, Alejada del cuerpo", orden: 240, valores: { [T]: "Cabana", [P]: 4, [H]: 2, [CM]: 1, [CI]: 2, [B]: 1, [U]: "Alejada del cuerpo" } }),
  recurso({ codigo: "PAR-CAB-027", nombre: "Cabana 27", categoria: "Cabana", descripcion: "Cabana, 5 personas, 2 habitaciones, 1 cama matrimonial, 3 camas individuales, 2 banos, Frente al cuerpo", orden: 250, valores: { [T]: "Cabana", [P]: 5, [H]: 2, [CM]: 1, [CI]: 3, [B]: 2, [U]: "Frente al cuerpo" } }),
  recurso({ codigo: "PAR-CAB-028", nombre: "Cabana 28", categoria: "Cabana", descripcion: "Cabana, 4 personas, 1 cama matrimonial, 2 camas individuales, 2 habitaciones, 1 bano, Alejada del cuerpo", orden: 260, valores: { [T]: "Cabana", [P]: 4, [CM]: 1, [CI]: 2, [H]: 2, [B]: 1, [U]: "Alejada del cuerpo" } }),
  recurso({ codigo: "PAR-DEP-016", nombre: "Departamento 16", categoria: "Departamento", descripcion: "Departamento, 3 personas, 1 ambiente, 3 camas individuales, Detras del cuerpo", orden: 300, valores: { [T]: "Departamento", [P]: 3, [A]: 1, [CI]: 3, [U]: "Detras del cuerpo" } }),
  recurso({ codigo: "PAR-DEP-017", nombre: "Departamento 17", categoria: "Departamento", descripcion: "Cabana, 3 personas, 2 habitaciones, 1 cama matrimonial, 1 cama individual, 1 bano, Detras del cuerpo", orden: 310, valores: { [T]: "Cabana", [P]: 3, [H]: 2, [CM]: 1, [CI]: 1, [B]: 1, [U]: "Detras del cuerpo" } }),
  recurso({ codigo: "PAR-DEP-018", nombre: "Departamento 18", categoria: "Departamento", descripcion: "Departamento, 3 personas, 1 ambiente, 3 camas individuales, Detras del cuerpo", orden: 320, valores: { [T]: "Departamento", [P]: 3, [A]: 1, [CI]: 3, [U]: "Detras del cuerpo" } }),
  recurso({ codigo: "PAR-DEP-019", nombre: "Departamento 19", categoria: "Departamento", descripcion: "Departamento, 3 personas, 1 ambiente, 1 cama matrimonial, 1 cama individual, Detras del cuerpo", orden: 330, valores: { [T]: "Departamento", [P]: 3, [A]: 1, [CM]: 1, [CI]: 1, [U]: "Detras del cuerpo" } }),
  recurso({ codigo: "PAR-DEP-020", nombre: "Departamento 20", categoria: "Departamento", descripcion: "Departamento, 2 personas, 1 ambiente, 2 camas individuales", orden: 340, valores: { [T]: "Departamento", [P]: 2, [A]: 1, [CI]: 2 } }),
  recurso({ codigo: "PAR-DEP-021", nombre: "Departamento 21", categoria: "Departamento", descripcion: "Departamento, 3 personas, 1 ambiente, 3 camas individuales, Detras del cuerpo", orden: 350, valores: { [T]: "Departamento", [P]: 3, [A]: 1, [CI]: 3, [U]: "Detras del cuerpo" } }),
  recurso({ codigo: "PAR-DEP-022", nombre: "Departamento 22", categoria: "Departamento", descripcion: "Departamento, 2 personas, 1 ambiente, 1 cama matrimonial, Detras del cuerpo", orden: 360, valores: { [T]: "Departamento", [P]: 2, [A]: 1, [CM]: 1, [U]: "Detras del cuerpo" } }),
  recurso({ codigo: "PAR-CASA-SAMAI", nombre: "Casa Samai", categoria: "Departamento", descripcion: "Departamento, 2 habitaciones, 1 bano, 6 personas", activo: 0, orden: 900, valores: { [T]: "Departamento", [H]: 2, [B]: 1, [P]: 6 } }),
];

function cabanaMiramar(numero, { nueva = false, vistaMar = false, activo = 1, especial = false } = {}) {
  const nombre = especial ? `Cabana Nro ${numero} Especial` : `Cabana Nro ${numero}${nueva ? " - Nueva" : ""}`;
  const personas = especial ? 4 : 6;
  const individuales = especial ? 2 : 4;
  const descripcion = `Cabana, ${personas} personas, 2 habitaciones, 1 cama matrimonial, ${individuales} camas individuales, 1 bano, Cocina equipada${especial ? "" : ", Parrilla propia"}${vistaMar ? ", Vista al mar" : ""}`;
  const valores = { [T]: "Cabana", [P]: personas, [H]: 2, [CM]: 1, [CI]: individuales, [B]: 1, [CE]: true };
  if (!especial) valores[PP] = true;
  if (vistaMar) valores[VM] = true;
  return recurso({
    legacyId: numero === 11 ? 3 : numero === 12 ? 2 : null,
    codigo: `MIR-CAB-${String(numero).padStart(3, "0")}${nueva ? "-NUEVA" : ""}`,
    nombre,
    categoria: "Cabana",
    descripcion,
    activo,
    orden: numero * 10,
    valores,
  });
}

function dormiMiramar(numero, { matrimonial = false, activo = 1, sinBano = true } = {}) {
  const descripcion = `Cabana, 4 personas, 1 ambiente, ${matrimonial ? "Mesa y Sillas, 1 cama matrimonial, 2 camas individuales" : "4 camas individuales, Mesa y Sillas"}${sinBano ? ", Sin bano" : ""}`;
  const valores = { [T]: "Cabana", [P]: 4, [A]: 1, [MS]: true, [CI]: matrimonial ? 2 : 4 };
  if (matrimonial) valores[CM] = 1;
  if (sinBano) valores[SB] = true;
  return recurso({ codigo: `MIR-DORMI-${String(numero).padStart(3, "0")}`, nombre: `Dormi ${numero}`, categoria: "Dormi", descripcion, activo, orden: 200 + numero * 10, valores });
}

const miramar = [
  ...[1, 2, 3, 4, 5].map((numero) => cabanaMiramar(numero)),
  ...[6, 7, 8, 9, 10].map((numero) => cabanaMiramar(numero, { activo: 0 })),
  ...[11, 12, 13].map((numero) => cabanaMiramar(numero, { nueva: true, vistaMar: true })),
  cabanaMiramar(14, { activo: 0, especial: true }),
  ...[1, 2, 3, 4].map((numero) => dormiMiramar(numero)),
  ...[5, 6, 7, 8, 9].map((numero) => dormiMiramar(numero, { matrimonial: true })),
  dormiMiramar(10),
  dormiMiramar(11, { activo: 0, sinBano: false }),
];

const solisDatos = [
  [1, 1, "Habitacion, 2 Personas, 2 Camas Individuales", { [T]: "Habitacion", [P]: 2, [CI]: 2 }],
  [2, 0, "Habitacion, 3 Personas, 1 Cama Matrimonial, 1 Cama Individual, Bano Privado, Cama Matrimonial en Entrepiso", { [T]: "Habitacion", [P]: 3, [CM]: 1, [CI]: 1, [BP]: true, [CME]: true }],
  [3, 0, "Habitacion, 2 Personas, 1 Cama Matrimonial, Bano Privado", { [T]: "Habitacion", [P]: 2, [CM]: 1, [BP]: true }],
  [4, 1, "Habitacion, 3 Personas, 3 Camas Individuales, Bano Privado", { [T]: "Habitacion", [P]: 3, [CI]: 3, [BP]: true }],
  [5, 1, "Habitacion, 2 Personas, 2 Camas Individuales", { [T]: "Habitacion", [P]: 2, [CI]: 2 }],
  [6, 1, "Habitacion, 2 Personas, 2 Camas Individuales, Ventana a la calle", { [T]: "Habitacion", [P]: 2, [CI]: 2, [VC]: true }],
  [7, 1, "Habitacion, 3 Personas, 2 Camas Individuales, Ventana a la calle, Entra un catre", { [T]: "Habitacion", [P]: 3, [CI]: 2, [VC]: true, [EC]: true }],
  [8, 1, "Habitacion, 2 Personas, 2 Camas Individuales", { [T]: "Habitacion", [P]: 2, [CI]: 2 }],
  [9, 1, "Habitacion, 2 Personas, 1 Cama Matrimonial, Bano Privado", { [T]: "Habitacion", [P]: 2, [CM]: 1, [BP]: true }],
  [10, 1, "Habitacion, 4 Personas, 1 Cama Matrimonial, 2 Camas Individuales, Bano Privado", { [T]: "Habitacion", [P]: 4, [CM]: 1, [CI]: 2, [BP]: true }],
  [11, 1, "Habitacion, 3 Personas, 1 Cama Matrimonial, Bano Privado, Ventana a la calle, Entra un catre", { [T]: "Habitacion", [P]: 3, [CM]: 1, [BP]: true, [VC]: true, [EC]: true }],
  [12, 1, "Habitacion, 2 Personas, 2 Camas Individuales, Bano Privado, Ventana a la calle", { [T]: "Habitacion", [P]: 2, [CI]: 2, [BP]: true, [VC]: true }],
  [13, 1, "Habitacion, 1 Persona, 1 Cama Individual, Bano Privado", { [T]: "Habitacion", [P]: 1, [CI]: 1, [BP]: true }],
  [14, 0, "Habitacion, 2 Personas, 2 Camas Individuales, Bano Privado", { [T]: "Habitacion", [P]: 2, [CI]: 2, [BP]: true }],
];

const solis = solisDatos.map(([numero, activo, descripcion, valores]) => recurso({
  codigo: `SOL-HAB-${String(numero).padStart(3, "0")}`,
  nombre: `Habitacion ${numero}`,
  categoria: "Habitacion",
  descripcion,
  activo,
  orden: numero * 10,
  valores,
}));

const SERVICIOS = Object.freeze([
  {
    legacyId: 1,
    codigo: "PARADOR_MONTANA",
    tipoServicioCodigo: "ALOJAMIENTO_RECURSO",
    nombre: "Parador de la Montana",
    lugar: "Cordoba",
    rating: 4.5,
    descripcion: "Alojamiento de la AJB en Cordoba con habitaciones, cabanas y departamentos.",
    estadoAprobacion: "APROBADO",
    activo: 1,
    alcanceDepartamental: "TODAS",
    modeloTarifa: "TEMPORADAS",
    unidadCobro: "POR_PERSONA_NOCHE",
    permiteAcompanantes: 1,
    maxPersonasReserva: 6,
    etiquetaIdentificador: "Unidad",
    condiciones: null,
    formularioAdhesionUrl: null,
    orden: 10,
    imagenMuestra: IMAGEN_MUESTRA_SERVICIO,
    recursos: parador,
  },
  {
    legacyId: 2,
    codigo: "HOTEL_SOLIS",
    tipoServicioCodigo: "ALOJAMIENTO_RECURSO",
    nombre: "Hotel Solis",
    lugar: "Capital Federal",
    rating: 4,
    descripcion: "Alojamiento de la AJB en Capital Federal con habitaciones individuales, dobles, triples y cuadruples.",
    estadoAprobacion: "APROBADO",
    activo: 1,
    alcanceDepartamental: "TODAS",
    modeloTarifa: "TEMPORADAS",
    unidadCobro: "POR_PERSONA_NOCHE",
    permiteAcompanantes: 1,
    maxPersonasReserva: 4,
    etiquetaIdentificador: "Habitacion",
    condiciones: null,
    formularioAdhesionUrl: null,
    orden: 20,
    imagenMuestra: IMAGEN_MUESTRA_SERVICIO,
    recursos: solis,
  },
  {
    legacyId: 3,
    codigo: "MIRAMAR_CABANAS",
    tipoServicioCodigo: "ALOJAMIENTO_RECURSO",
    nombre: "Miramar Cabanas",
    lugar: "Miramar",
    rating: 3.5,
    descripcion: "Cabanas y dormis de la AJB en Miramar.",
    estadoAprobacion: "APROBADO",
    activo: 1,
    alcanceDepartamental: "TODAS",
    modeloTarifa: "TEMPORADAS",
    unidadCobro: "POR_PERSONA_NOCHE",
    permiteAcompanantes: 1,
    maxPersonasReserva: 6,
    etiquetaIdentificador: "Unidad",
    condiciones: null,
    formularioAdhesionUrl: null,
    orden: 30,
    imagenMuestra: IMAGEN_MUESTRA_SERVICIO,
    recursos: miramar,
  },
  {
    legacyId: 4,
    codigo: "MIRAMAR_CAMPING",
    tipoServicioCodigo: "CUPO_NUMERADO",
    nombre: "Camping",
    lugar: "Miramar",
    rating: 5,
    descripcion: "Camping de la AJB en Miramar con asignacion numerada de parcelas.",
    estadoAprobacion: "APROBADO",
    activo: 1,
    alcanceDepartamental: "TODAS",
    modeloTarifa: "TEMPORADAS",
    unidadCobro: "POR_PERSONA_NOCHE",
    permiteAcompanantes: 1,
    maxPersonasReserva: 6,
    etiquetaIdentificador: "Numero de parcela",
    condiciones: null,
    formularioAdhesionUrl: null,
    orden: 40,
    imagenMuestra: IMAGEN_MUESTRA_SERVICIO,
    recursos: [
      recurso({
        legacyId: 1,
        codigo: "CAMP-PARCELA",
        nombre: "Parcela",
        categoria: "Parcela",
        descripcion: "Parcela numerada de camping para hasta 6 personas.",
        orden: 10,
        cupoMaximo: null,
        esRecursoPrincipal: 1,
        valores: { [T]: "Parcela", [P]: 6 },
      }),
    ],
  },
]);

const CONVENIOS_A_MIGRAR = Object.freeze([
  {
    legacyConvenioId: 1,
    codigoServicio: "CONVENIO_HOTEL_LINZ",
    tipoServicioCodigo: "CONVENIO_HOTELERO",
    estadoAprobacion: "APROBADO",
    alcanceDepartamental: "TODAS",
    // Los convenios se cotizan por el flujo de propuesta/PDF y permiten grupo.
    // TEMPORADAS evita mezclar esa modalidad con PRECIO_UNICO (solo titular).
    modeloTarifa: "TEMPORADAS",
    unidadCobro: "POR_ESTADIA",
    permiteAcompanantes: 1,
    etiquetaIdentificador: "Hotel",
    orden: 100,
  },
]);

// Los codigos son ASCII estables para integraciones; los textos visibles
// conservan la ortografia exacta en castellano aunque las declaraciones de
// datos se mantengan faciles de buscar por sus equivalentes legacy.
function acentuarTextosVisibles(valor, clave = null) {
  if (typeof valor === "string") {
    if (clave === "codigo" || clave === "codigoServicio" || clave === "tipoServicioCodigo") return valor;
    return valor
      .replace(/\bHabitacion\b/g, "Habitación")
      .replace(/\bCabanas\b/g, "Cabañas")
      .replace(/\bCabana\b/g, "Cabaña")
      .replace(/\bBanos\b/g, "Baños")
      .replace(/\bBano\b/g, "Baño")
      .replace(/\bcabanas\b/g, "cabañas")
      .replace(/\bcabana\b/g, "cabaña")
      .replace(/\bbanos\b/g, "baños")
      .replace(/\bbano\b/g, "baño")
      .replace(/\bDetras\b/g, "Detrás")
      .replace(/\bMontana\b/g, "Montaña")
      .replace(/\bCordoba\b/g, "Córdoba")
      .replace(/\bSolis\b/g, "Solís")
      .replace(/\bNumero\b/g, "Número")
      .replace(/\basignacion\b/g, "asignación")
      .replace(/\bcuadruples\b/g, "cuádruples");
  }
  if (Array.isArray(valor)) {
    for (let index = 0; index < valor.length; index += 1) {
      const acentuado = acentuarTextosVisibles(valor[index], clave);
      if (acentuado !== valor[index] && !Object.isFrozen(valor)) valor[index] = acentuado;
    }
    return valor;
  }
  if (valor && typeof valor === "object") {
    for (const [nombre, contenido] of Object.entries(valor)) {
      valor[nombre] = acentuarTextosVisibles(contenido, nombre);
    }
  }
  return valor;
}

acentuarTextosVisibles(TIPOS_SERVICIO);
acentuarTextosVisibles(FILTROS);
acentuarTextosVisibles(SERVICIOS);

const RESUMEN_ESPERADO = Object.freeze({
  recursosListado: 69,
  recursosListadoActivos: 58,
  recursosListadoInactivos: 11,
  recursosIncluyendoCamping: 70,
  recursosActivosIncluyendoCamping: 59,
  recursosInactivosIncluyendoCamping: 11,
  porServicio: {
    PARADOR_MONTANA: { total: 30, activos: 29, inactivos: 1 },
    HOTEL_SOLIS: { total: 14, activos: 11, inactivos: 3 },
    MIRAMAR_CABANAS: { total: 25, activos: 18, inactivos: 7 },
    MIRAMAR_CAMPING: { total: 1, activos: 1, inactivos: 0 },
  },
});

function validarCatalogoInicial() {
  const errores = [];
  const filtros = new Map(FILTROS.map((filtro) => [filtro.codigo, filtro]));
  if (filtros.size !== FILTROS.length) errores.push("Hay codigos de filtro duplicados");

  const codigosServicio = new Set();
  const legacyServicios = new Set();
  const codigosRecurso = new Set();
  const legacyRecursos = new Set();
  let total = 0;
  let activos = 0;

  for (const servicio of SERVICIOS) {
    if (codigosServicio.has(servicio.codigo)) errores.push(`Servicio duplicado: ${servicio.codigo}`);
    codigosServicio.add(servicio.codigo);
    if (servicio.legacyId != null) {
      if (legacyServicios.has(servicio.legacyId)) errores.push(`ID legacy de servicio duplicado: ${servicio.legacyId}`);
      legacyServicios.add(servicio.legacyId);
    }
    const esperado = RESUMEN_ESPERADO.porServicio[servicio.codigo];
    const activosServicio = servicio.recursos.filter((item) => item.activo === 1).length;
    if (!esperado || servicio.recursos.length !== esperado.total || activosServicio !== esperado.activos) {
      errores.push(`Conteo invalido para ${servicio.codigo}`);
    }
    for (const item of servicio.recursos) {
      total += 1;
      activos += item.activo === 1 ? 1 : 0;
      const clave = `${servicio.codigo}:${item.codigo}`;
      if (codigosRecurso.has(clave)) errores.push(`Recurso duplicado: ${clave}`);
      codigosRecurso.add(clave);
      if (item.legacyId != null) {
        if (legacyRecursos.has(item.legacyId)) errores.push(`ID legacy de recurso duplicado: ${item.legacyId}`);
        legacyRecursos.add(item.legacyId);
      }
      for (const [codigoFiltro, valor] of Object.entries(item.valores)) {
        const filtro = filtros.get(codigoFiltro);
        if (!filtro) {
          errores.push(`Filtro desconocido ${codigoFiltro} en ${clave}`);
          continue;
        }
        if (filtro.tipoValor === "NUMERO" && (!Number.isInteger(valor) || valor < 0)) errores.push(`Valor numerico invalido ${codigoFiltro} en ${clave}`);
        if (filtro.tipoValor === "BOOLEANO" && valor !== true && valor !== false) errores.push(`Valor booleano invalido ${codigoFiltro} en ${clave}`);
        if (filtro.tipoValor === "OPCION" && !filtro.opciones.includes(valor)) errores.push(`Opcion invalida ${codigoFiltro} en ${clave}`);
      }
    }
  }

  if (total !== RESUMEN_ESPERADO.recursosIncluyendoCamping) errores.push(`Total invalido: ${total}`);
  if (activos !== RESUMEN_ESPERADO.recursosActivosIncluyendoCamping) errores.push(`Activos invalidos: ${activos}`);
  if (total - activos !== RESUMEN_ESPERADO.recursosInactivosIncluyendoCamping) errores.push(`Inactivos invalidos: ${total - activos}`);
  if ([...legacyRecursos].sort((a, b) => a - b).join(",") !== "1,2,3") errores.push("Los recursos legacy deben ser exactamente 1,2,3");

  const depto17 = parador.find((item) => item.codigo === "PAR-DEP-017");
  if (depto17?.valores[T] !== "Cabaña") errores.push("Departamento 17 debe conservar tipo literal Cabaña");
  const habitacion1A = parador.find((item) => item.codigo === "PAR-HAB-001-A");
  if (Object.keys(habitacion1A?.valores || {}).join(",") !== P) errores.push("Habitacion 1 A debe conservar solo la caracteristica Personas");
  const dormi11 = miramar.find((item) => item.codigo === "MIR-DORMI-011");
  if (Object.prototype.hasOwnProperty.call(dormi11?.valores || {}, SB)) errores.push("Dormi 11 no debe inferir Sin bano");

  if (errores.length) throw new Error(`Catalogo de turismo invalido: ${errores.join("; ")}`);
  return {
    servicios: SERVICIOS.length,
    recursos: total,
    activos,
    inactivos: total - activos,
    filtros: FILTROS.length,
  };
}

module.exports = {
  CONVENIOS_A_MIGRAR,
  FILTROS,
  IMAGEN_MUESTRA_RECURSO,
  IMAGEN_MUESTRA_SERVICIO,
  RESUMEN_ESPERADO,
  SERVICIOS,
  TIPOS_SERVICIO,
  validarCatalogoInicial,
};
