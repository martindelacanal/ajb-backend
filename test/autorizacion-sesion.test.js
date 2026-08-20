"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ErrorSesionUsuario,
  actualizarAutorizacionSesion,
  verificarTokenConAutorizacionActual,
} = require("../api/security/autorizacion-sesion");

function baseUsuario(overrides = {}) {
  return {
    id: 17,
    rol_id: 3,
    rol: "afiliado",
    departamental_id: 8,
    habilitado: "S",
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 0,
    modulo_coseguro: 1,
    modulo_olimpiadas: 0,
    ...overrides,
  };
}

test("actualiza los permisos embebidos en el JWT con los valores actuales", async () => {
  const authData = {
    data: JSON.stringify(baseUsuario({ modulo_turismo: 1, modulo_olimpiadas: 1 })),
  };
  const db = {
    query: async (_sql, params) => {
      assert.deepEqual(params, [17]);
      return [[baseUsuario()]];
    },
  };

  const actualizada = await actualizarAutorizacionSesion(authData, db);

  assert.equal(actualizada.modulo_turismo, 0);
  assert.equal(actualizada.modulo_coseguro, 1);
  assert.equal(actualizada.modulo_olimpiadas, 0);
  assert.equal(JSON.parse(authData.data).modulo_turismo, 0);
});

test("rechaza una sesion cuyo usuario fue inhabilitado", async () => {
  const authData = { data: JSON.stringify(baseUsuario()) };
  const db = { query: async () => [[baseUsuario({ habilitado: "N" })]] };

  await assert.rejects(
    actualizarAutorizacionSesion(authData, db),
    (error) => error instanceof ErrorSesionUsuario && error.statusCode === 403
  );
});

test("el middleware entrega al handler la autorizacion refrescada", async () => {
  const authData = { data: JSON.stringify(baseUsuario({ modulo_turismo: 1 })) };
  const jwt = {
    verify: (_token, _secret, callback) => callback(null, authData),
  };
  const db = { query: async () => [[baseUsuario({ modulo_turismo: 0 })]] };
  const req = { headers: { authorization: "Bearer token-valido" } };
  let status;
  let response;
  const res = {
    status(value) { status = value; return this; },
    json(value) { response = value; return this; },
  };
  await new Promise((resolve, reject) => {
    verificarTokenConAutorizacionActual({
      req,
      res,
      next: resolve,
      jwt,
      jwtSecret: "secret",
      db,
    });
    setImmediate(() => {
      if (status) reject(new Error(String(response)));
    });
  });

  assert.equal(JSON.parse(req.data.data).modulo_turismo, 0);
  assert.equal(status, undefined);
});

test("el middleware no consulta la base con un token invalido", () => {
  let consultada = false;
  const req = { headers: { authorization: "Bearer token-invalido" } };
  const res = {
    status(value) { assert.equal(value, 403); return this; },
    json(value) { assert.equal(value, "Error en el token"); },
  };

  verificarTokenConAutorizacionActual({
    req,
    res,
    next: () => assert.fail("no debe continuar"),
    jwt: { verify: (_token, _secret, callback) => callback(new Error("firma")) },
    jwtSecret: "secret",
    db: { query: async () => { consultada = true; return [[]]; } },
  });

  assert.equal(consultada, false);
});

test("el middleware refresca desde la base tambien a los roles administrativos", async () => {
  let consultas = 0;
  const authData = { data: JSON.stringify({ id: 4, rol: "admin", area_turismo: 1 }) };
  const req = { headers: { authorization: "Bearer token-valido" } };

  await new Promise((resolve, reject) => {
    verificarTokenConAutorizacionActual({
      req,
      res: {
        status: () => reject(new Error("no debe responder")),
        json: () => undefined,
      },
      next: resolve,
      jwt: { verify: (_token, _secret, callback) => callback(null, authData) },
      jwtSecret: "secret",
      db: {
        query: async (_sql, params) => {
          consultas += 1;
          assert.deepEqual(params, [4]);
          return [[baseUsuario({
            id: 4,
            rol_id: 1,
            rol: "departamental",
            departamental_id: 6,
            area_turismo: 0,
          })]];
        },
      },
    });
  });

  const actualizada = JSON.parse(req.data.data);
  assert.equal(consultas, 1);
  assert.equal(actualizada.rol, "departamental");
  assert.equal(actualizada.departamental_id, 6);
  assert.equal(actualizada.area_turismo, 0);
});
