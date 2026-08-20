"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "autorizacion-rutas-test-secret";

let usuarioActual;
let consultas = 0;

function usuario(overrides = {}) {
  return {
    id: 9,
    rol_id: 1,
    rol: "admin",
    departamental_id: null,
    habilitado: "S",
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 1,
    ...overrides,
  };
}

const fakeConnection = {
  promise() {
    return {
      query: async (_sql, params) => {
        consultas += 1;
        assert.deepEqual(params, [usuarioActual.id]);
        return [[{ ...usuarioActual }]];
      },
    };
  },
};

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: fakeConnection,
};

const noticiasRouter = require("../api/routes/noticias");
const trasladosRouter = require("../api/routes/traslados");

async function ejecutarMiddleware(middleware, claims) {
  const token = jwt.sign({ data: JSON.stringify(claims) }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("El middleware no finalizo")), 1000);
    let status = 200;
    const finalizar = (resultado) => {
      clearTimeout(timer);
      resolve({ ...resultado, req });
    };
    const res = {
      status(value) {
        status = value;
        return this;
      },
      json(body) {
        finalizar({ continuo: false, status, body });
        return this;
      },
    };

    try {
      middleware(req, res, () => finalizar({ continuo: true, status }));
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

test("Noticias reemplaza el rol del token por la autorizacion administrativa vigente", async () => {
  consultas = 0;
  usuarioActual = usuario({ id: 9, rol: "admin" });

  const resultado = await ejecutarMiddleware(
    noticiasRouter.__test.verifyToken,
    { id: 9, rol: "departamental" }
  );

  assert.equal(resultado.continuo, true);
  assert.equal(JSON.parse(resultado.req.data.data).rol, "admin");
  assert.equal(consultas, 1);
});

test("Noticias corta la sesion de un administrador actualmente inhabilitado", async () => {
  consultas = 0;
  usuarioActual = usuario({ id: 9, habilitado: "N" });

  const resultado = await ejecutarMiddleware(
    noticiasRouter.__test.verifyToken,
    { id: 9, rol: "admin" }
  );

  assert.equal(resultado.continuo, false);
  assert.equal(resultado.status, 403);
  assert.equal(resultado.body, "Usuario inhabilitado");
  assert.equal(consultas, 1);
});

test("Traslados conserva el acceso admin-only usando el rol vigente en la base", async () => {
  consultas = 0;
  usuarioActual = usuario({ id: 9, rol_id: 2, rol: "departamental", departamental_id: 4 });

  const resultado = await ejecutarMiddleware(
    trasladosRouter.__test.verifyToken,
    { id: 9, rol: "admin" }
  );

  assert.equal(resultado.continuo, false);
  assert.equal(resultado.status, 403);
  assert.equal(resultado.body, "El módulo de Traslados está disponible únicamente para administradores");
  assert.equal(consultas, 1);
});

test("Traslados permite al admin vigente aunque el token conserve un rol anterior", async () => {
  consultas = 0;
  usuarioActual = usuario({ id: 9, rol: "admin" });

  const resultado = await ejecutarMiddleware(
    trasladosRouter.__test.verifyToken,
    { id: 9, rol: "departamental" }
  );

  assert.equal(resultado.continuo, true);
  assert.equal(JSON.parse(resultado.req.data.data).rol, "admin");
  assert.equal(consultas, 1);
});
