const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PASSWORD_SIGNIN_MAX_LENGTH,
  normalizarCredencialesSignin,
} = require("../api/security/signin-input");

test("signin admite documentos historicos cortos como los usuarios demo", () => {
  assert.deepEqual(
    normalizarCredencialesSignin({ documento: 111, password: "test", recordar: false }),
    { documento: "111", password: "test", recordar: false, validas: true }
  );
});

test("signin conserva documentos con ceros iniciales y normaliza recordar", () => {
  assert.deepEqual(
    normalizarCredencialesSignin({ documento: " 00111 ", password: "test", recordar: "true" }),
    { documento: "00111", password: "test", recordar: true, validas: true }
  );
});

test("signin rechaza documentos no numericos o fuera del ancho de la columna", () => {
  assert.equal(normalizarCredencialesSignin({ documento: "", password: "test" }).validas, false);
  assert.equal(normalizarCredencialesSignin({ documento: "11a", password: "test" }).validas, false);
  assert.equal(normalizarCredencialesSignin({ documento: "12345678901", password: "test" }).validas, false);
});

test("signin limita la longitud de la contrasena", () => {
  assert.equal(normalizarCredencialesSignin({ documento: 111, password: "" }).validas, false);
  assert.equal(
    normalizarCredencialesSignin({ documento: 111, password: "x".repeat(PASSWORD_SIGNIN_MAX_LENGTH) }).validas,
    true
  );
  assert.equal(
    normalizarCredencialesSignin({ documento: 111, password: "x".repeat(PASSWORD_SIGNIN_MAX_LENGTH + 1) }).validas,
    false
  );
});
