const test = require("node:test");
const assert = require("node:assert/strict");

const { esErrorDeNegocio, registrarErrorRuta } = require("../api/services/errores");

function capturar(ejecutar) {
  const salidas = { warn: [], error: [] };
  const originales = { warn: console.warn, error: console.error };
  console.warn = (...args) => salidas.warn.push(args);
  console.error = (...args) => salidas.error.push(args);
  try {
    ejecutar();
  } finally {
    console.warn = originales.warn;
    console.error = originales.error;
  }
  return salidas;
}

test("un error de negocio (4xx) se registra en una linea, sin stack", () => {
  const error = Object.assign(new Error("Ya tenes una reserva iniciada"), { statusCode: 409, codigo: "RESERVA_DUPLICADA" });
  assert.equal(esErrorDeNegocio(error), true);

  const salidas = capturar(() => registrarErrorRuta(error, "reservas"));
  assert.equal(salidas.error.length, 0);
  assert.equal(salidas.warn.length, 1);
  const linea = salidas.warn[0][0];
  assert.equal(typeof linea, "string");
  assert.ok(linea.includes("409") && linea.includes("RESERVA_DUPLICADA") && linea.includes("Ya tenes una reserva iniciada"));
  assert.ok(!linea.includes("\n    at "), "no lleva stack");
});

test("un fallo real conserva el objeto de error completo (con stack)", () => {
  const error = new TypeError("Cannot read properties of undefined");
  assert.equal(esErrorDeNegocio(error), false);
  assert.equal(esErrorDeNegocio(Object.assign(new Error("x"), { statusCode: 500 })), false);

  const salidas = capturar(() => registrarErrorRuta(error));
  assert.equal(salidas.warn.length, 0);
  assert.equal(salidas.error.length, 1);
  assert.equal(salidas.error[0][0], error);
});
