const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fuente = fs.readFileSync(path.join(__dirname, "../api/routes/user.js"), "utf8");

function contratoEntre(inicio, fin) {
  const desde = fuente.indexOf(inicio);
  assert.notEqual(desde, -1, `No se encontró ${inicio}`);
  const hasta = fuente.indexOf(fin, desde + inicio.length);
  assert.notEqual(hasta, -1, `No se encontró ${fin}`);
  return fuente.slice(desde, hasta);
}

function assertValidaRangoNoPasado(contrato) {
  assert.match(contrato, /validarRangoReservaTemporal\(fechaInicio(?:Solicitud|Reserva), fechaFin(?:Solicitud|Reserva)\)/);
}

test("búsqueda y cotización de fecha libre rechazan rangos pasados", () => {
  assertValidaRangoNoPasado(contratoEntre(
    'router.post("/reserva/recursos",',
    'router.post("/filtros/para-recursos",'
  ));
  assertValidaRangoNoPasado(contratoEntre(
    'router.post("/filtros/para-recursos",',
    'router.post("/reserva/tarifa/fechas",'
  ));
  assertValidaRangoNoPasado(contratoEntre(
    'router.post("/reserva/tarifa/fechas",',
    'router.post("/reserva/adicionales",'
  ));
  assertValidaRangoNoPasado(contratoEntre(
    'router.post("/reserva/adicionales",',
    'async function registrarHistorial('
  ));
});

test("las dos altas de reserva rechazan rangos pasados antes de insertar", () => {
  assertValidaRangoNoPasado(contratoEntre(
    'router.post("/reserva",',
    'router.post("/convenios-hoteleros/:id/reservas",'
  ));
  assertValidaRangoNoPasado(contratoEntre(
    'router.post("/convenios-hoteleros/:id/reservas",',
    'router.put("/reserva/:id",'
  ));
});

test("cotización e inscripción a sorteos validan también las fechas del bloque", () => {
  const contrato = contratoEntre(
    "function validarBloqueInscripcionAbierta",
    "async function cotizarBloqueComun"
  );
  assert.match(contrato, /validarRangoReservaTemporal\(bloque\.fecha_inicio, bloque\.fecha_fin, \{ hoy \}\)/);
});

test("la edición histórica sólo exceptúa el rango existente exacto", () => {
  const contrato = contratoEntre(
    'router.put("/reserva/:id",',
    'router.get("/reserva/:id/edicion",'
  );
  assert.match(contrato, /validarRangoReservaTemporal\(fechaInicioReserva, fechaFinReserva,\s*\{[\s\S]*?rangoExistente:/);
  assert.match(contrato, /RANGO_HISTORICO_NO_EDITABLE/);
});
