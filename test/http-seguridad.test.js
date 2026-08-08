const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizarOrigen,
  obtenerOrigenesPermitidos,
  crearValidadorCors,
} = require("../api/security/http-config");
const {
  addUser,
  removeUser,
  getUsersByUsuario,
} = require("../api/socket/socket-user");

test("la configuracion CORS normaliza origenes y rechaza comodines", () => {
  assert.equal(normalizarOrigen("https://ejemplo.test/ruta"), "https://ejemplo.test");
  assert.equal(normalizarOrigen("*"), null);
  assert.throws(() => obtenerOrigenesPermitidos("*"), /invalido/);
  assert.deepEqual(
    [...obtenerOrigenesPermitidos("https://uno.test, http://localhost:4200")],
    ["https://uno.test", "http://localhost:4200"]
  );
});

test("el validador CORS permite solo la lista exacta y clientes sin Origin", async () => {
  const validar = crearValidadorCors(new Set(["https://permitido.test"]));
  const ejecutar = (origen) => new Promise((resolve) => validar(origen, (error, ok) => resolve({ error, ok })));

  assert.equal((await ejecutar(undefined)).ok, true);
  assert.equal((await ejecutar("https://permitido.test")).ok, true);
  assert.equal((await ejecutar("https://otro.test")).error.code, "ORIGEN_CORS_NO_PERMITIDO");
});

test("los usuarios socket no pueden elegir salas arbitrarias y admiten multiples pestañas", () => {
  const uno = addUser({ id: "socket-a", usuario: "12345678", rol: "cliente" });
  const dos = addUser({ id: "socket-b", usuario: "12345678", rol: "cliente" });
  const invalido = addUser({ id: "socket-c", usuario: "12345678", rol: "superadmin" });

  assert.equal(uno.user.room, "cliente");
  assert.equal(dos.user.room, "cliente");
  assert.equal(getUsersByUsuario("12345678").length, 2);
  assert.equal(invalido.error, "Rol invalido");

  removeUser("socket-a");
  removeUser("socket-b");
});
