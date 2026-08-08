const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  estadoInicialSorteoPermitido,
  esEstadoReservaTerminal,
  obtenerEstadoRecursoTrasLiberacion,
  obtenerEstadoRecursoTrasRechazo,
  validarAdjudicacionSorteo,
  validarRespuestaAdjudicacion,
} = require("../api/services/sorteos-vigencia");

const userRoutesSource = fs.readFileSync(
  path.join(__dirname, "..", "api", "routes", "user.js"),
  "utf8"
);

function extraerContrato(inicioTexto, finTexto) {
  const inicio = userRoutesSource.indexOf(inicioTexto);
  const fin = userRoutesSource.indexOf(finTexto, inicio + inicioTexto.length);
  assert.notEqual(inicio, -1, inicioTexto);
  assert.notEqual(fin, -1, finTexto);
  return userRoutesSource.slice(inicio, fin);
}

const baseAdjudicacion = {
  estadoBloque: "ACTIVO",
  estadoSorteo: "ACTIVO",
  fechaFinInscripcion: "2040-08-10",
  fechaInicioBloque: "2040-08-15",
};

test("un sorteo nuevo solo admite BORRADOR o ACTIVO", () => {
  assert.equal(estadoInicialSorteoPermitido("BORRADOR"), true);
  assert.equal(estadoInicialSorteoPermitido("ACTIVO"), true);
  assert.equal(estadoInicialSorteoPermitido("CERRADO"), false);
  assert.equal(estadoInicialSorteoPermitido("CANCELADO"), false);
  assert.match(
    extraerContrato('router.post("/admin/sorteos",', 'router.put("/admin/sorteos/:id",'),
    /estadoInicialSorteoPermitido\(estadoSorteo\)/
  );
});

test("adjudicar requiere inscripcion cerrada y bloque aun no iniciado", () => {
  assert.equal(validarAdjudicacionSorteo({ ...baseAdjudicacion, hoy: "2040-08-11" }), null);
  assert.equal(
    validarAdjudicacionSorteo({ ...baseAdjudicacion, hoy: "2040-08-10" }).codigo,
    "INSCRIPCION_SORTEO_ABIERTA"
  );
  assert.equal(
    validarAdjudicacionSorteo({ ...baseAdjudicacion, hoy: "2040-08-15" }).codigo,
    "BLOQUE_YA_INICIADO"
  );
});

test("adjudicar exige estados ACTIVO exactos", () => {
  assert.equal(
    validarAdjudicacionSorteo({ ...baseAdjudicacion, estadoSorteo: "CERRADO", hoy: "2040-08-11" }).codigo,
    "SORTEO_NO_ADJUDICABLE"
  );
  assert.equal(
    validarAdjudicacionSorteo({ ...baseAdjudicacion, estadoBloque: "LIBERADO", hoy: "2040-08-11" }).codigo,
    "SORTEO_NO_ADJUDICABLE"
  );
});

test("aceptar o rechazar admite ACTIVO/CERRADO hasta el dia de inicio inclusive", () => {
  const base = {
    estadoBloque: "ACTIVO",
    estadoSorteo: "CERRADO",
    fechaInicioBloque: "2040-08-15",
  };
  assert.equal(validarRespuestaAdjudicacion({ ...base, hoy: "2040-08-15" }), null);
  assert.equal(
    validarRespuestaAdjudicacion({ ...base, hoy: "2040-08-16" }).codigo,
    "RESPUESTA_ADJUDICACION_VENCIDA"
  );
  assert.equal(
    validarRespuestaAdjudicacion({ ...base, estadoSorteo: "CANCELADO", hoy: "2040-08-14" }).codigo,
    "ADJUDICACION_NO_PROCESABLE"
  );
});

test("los estados terminales se resuelven por nombre y no por ID", () => {
  for (const estado of ["Cancelada", "Rechazada", "Utilizada", "No adjudicada", "Convenio rechazado"]) {
    assert.equal(esEstadoReservaTerminal(estado), true, estado);
  }
  assert.equal(esEstadoReservaTerminal("Solicitud sorteo"), false);
  assert.equal(esEstadoReservaTerminal("Adjudicada"), false);
});

test("el rechazo deriva el estado del recurso desde padre y sorteo", () => {
  assert.equal(
    obtenerEstadoRecursoTrasRechazo({ estadoBloque: "ACTIVO", estadoSorteo: "ACTIVO" }),
    "SORTEO"
  );
  assert.equal(
    obtenerEstadoRecursoTrasRechazo({ estadoBloque: "ACTIVO", estadoSorteo: "CERRADO" }),
    "VENTA_DIRECTA"
  );
  assert.equal(
    obtenerEstadoRecursoTrasRechazo({ estadoBloque: "LIBERADO", estadoSorteo: "CERRADO" }),
    "LIBERADO"
  );
  assert.equal(
    obtenerEstadoRecursoTrasRechazo({ estadoBloque: "ACTIVO", estadoSorteo: "CANCELADO" }),
    "LIBERADO"
  );
});

test("la cancelacion libera recursos segun modalidad y estado del padre", () => {
  assert.equal(
    obtenerEstadoRecursoTrasLiberacion({ modalidad: "FECHA_LIBRE", estadoBloque: "ACTIVO" }),
    "DISPONIBLE"
  );
  assert.equal(
    obtenerEstadoRecursoTrasLiberacion({ modalidad: "SORTEO", estadoBloque: "ACTIVO", estadoSorteo: "ACTIVO" }),
    "SORTEO"
  );
  assert.equal(
    obtenerEstadoRecursoTrasLiberacion({ modalidad: "SORTEO", estadoBloque: "ACTIVO", estadoSorteo: "CERRADO" }),
    "VENTA_DIRECTA"
  );
  assert.equal(
    obtenerEstadoRecursoTrasLiberacion({ modalidad: "FECHA_LIBRE", estadoBloque: "LIBERADO" }),
    "LIBERADO"
  );
  assert.match(userRoutesSource, /async function liberarRecursoBloqueReserva[\s\S]*obtenerEstadoRecursoTrasLiberacion/);
});

test("las rutas validan vigencia antes de ejecutar sus UPDATE", () => {
  const aceptar = extraerContrato(
    'router.put("/sorteos/adjudicaciones/:id/aceptar",',
    'router.put("/sorteos/adjudicaciones/:id/rechazar",'
  );
  assert.ok(aceptar.indexOf("validarRespuestaAdjudicacion") < aceptar.indexOf("UPDATE sorteo_adjudicacion_respuesta"));

  const rechazar = extraerContrato(
    'router.put("/sorteos/adjudicaciones/:id/rechazar",',
    'router.get("/admin/sorteos",'
  );
  assert.ok(rechazar.indexOf("validarRespuestaAdjudicacion") < rechazar.indexOf("UPDATE sorteo_adjudicacion_respuesta"));
  assert.match(rechazar, /obtenerEstadoRecursoTrasRechazo/);
  assert.match(rechazar, /SET estado = \?/);

  const adjudicar = extraerContrato(
    'router.put("/admin/sorteos/inscripciones/:id/adjudicar",',
    'router.put("/admin/sorteos/inscripciones/:id/no-adjudicada",'
  );
  assert.ok(adjudicar.indexOf("validarAdjudicacionSorteo") < adjudicar.indexOf("UPDATE reserva"));
  assert.match(adjudicar, /esEstadoReservaTerminal\(reserva\.estado_nombre\)/);
});

test("GET /admin/sorteos no muta perezosamente el estado", () => {
  const contract = extraerContrato(
    'router.get("/admin/sorteos",',
    'router.post("/admin/sorteos",'
  );
  assert.doesNotMatch(contract, /UPDATE\s+sorteo\s+SET\s+estado/i);
  assert.match(contract, /sorteo\.estado/);
});
