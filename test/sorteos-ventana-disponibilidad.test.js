const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const userRoutesSource = fs.readFileSync(
  path.join(__dirname, "..", "api", "routes", "user.js"),
  "utf8"
);

function extraerContrato(inicio, fin) {
  const indiceInicio = userRoutesSource.indexOf(inicio);
  assert.notEqual(indiceInicio, -1, `No se encontro el inicio del contrato: ${inicio}`);

  const indiceFin = userRoutesSource.indexOf(fin, indiceInicio + inicio.length);
  assert.notEqual(indiceFin, -1, `No se encontro el fin del contrato: ${fin}`);

  return userRoutesSource.slice(indiceInicio, indiceFin);
}

function assertVentanaInscripcionCompleta(sqlContract) {
  assert.match(sqlContract, /s\.fecha_inicio_inscripcion\s*<=\s*CURDATE\(\)/);
  assert.match(sqlContract, /s\.fecha_fin_inscripcion\s*>=\s*CURDATE\(\)/);
}

test("GET /servicios publica sorteos solo dentro de la ventana de inscripcion", () => {
  const contract = extraerContrato(
    'router.get("/servicios",',
    'router.get("/turismo/propuestas",'
  );

  assertVentanaInscripcionCompleta(contract);
});

test("obtenerBloquesDisponiblesPorServicio exige inicio y fin de inscripcion", () => {
  const contract = extraerContrato(
    "async function obtenerBloquesDisponiblesPorServicio",
    "function crearErrorReservaCamping"
  );

  assertVentanaInscripcionCompleta(contract);
});
