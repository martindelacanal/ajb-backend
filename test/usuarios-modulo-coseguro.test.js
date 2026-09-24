"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "usuarios-modulo-coseguro-test-secret";

const databaseCalls = [];
let sesionActual;
let databaseHandler = async (sql) => {
  throw new Error(`Consulta inesperada: ${sql}`);
};
let commits = 0;
let rollbacks = 0;
let releases = 0;

const SESIONES = {
  admin: {
    id: 1,
    rol_id: 1,
    rol: "admin",
    departamental_id: null,
    habilitado: "Y",
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 1,
  },
  departamental: {
    id: 100,
    rol_id: 2,
    rol: "departamental",
    departamental_id: 7,
    habilitado: "Y",
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 1,
  },
  afiliado: {
    id: 200,
    rol_id: 3,
    rol: "afiliado",
    departamental_id: 7,
    habilitado: "Y",
    area_turismo: 0,
    area_coseguro: 0,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 1,
  },
};

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

async function consultar(sql, params = []) {
  databaseCalls.push({ sql, params });
  if (esConsultaAutorizacion(sql)) {
    return [[{ ...sesionActual }]];
  }
  return databaseHandler(sql, params);
}

const transactionalConnection = {
  query: consultar,
  execute: consultar,
  async beginTransaction() {},
  async commit() { commits += 1; },
  async rollback() { rollbacks += 1; },
  release() { releases += 1; },
};

const fakeConnection = {
  promise() {
    return {
      query: consultar,
      execute: consultar,
      getConnection: async () => transactionalConnection,
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

const userRouter = require("../api/routes/user");
const app = express();
app.use(express.json());
app.use("/api", userRouter);

const consoleLogOriginal = console.log;
test.before(() => {
  console.log = () => {};
});
test.after(() => {
  console.log = consoleLogOriginal;
});

function preparar(rol, handler) {
  databaseCalls.length = 0;
  commits = 0;
  rollbacks = 0;
  releases = 0;
  sesionActual = { ...SESIONES[rol] };
  databaseHandler = handler;
}

function token(rol) {
  const sesion = SESIONES[rol];
  return jwt.sign({
    data: JSON.stringify({
      id: sesion.id,
      rol: sesion.rol,
      departamental_id: sesion.departamental_id,
    }),
  }, process.env.JWT_SECRET);
}

async function request(path, { rol, method = "PUT", body } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token(rol)}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function esSelectObjetivo(sql) {
  return /SELECT u\.id, u\.modulo_coseguro[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?[\s\S]+FOR UPDATE/i.test(sql);
}

function esUpdate(sql) {
  return /^UPDATE usuario SET modulo_coseguro = \? WHERE id = \?/i.test(sql.trim());
}

function esHistorial(sql) {
  return /INSERT INTO historial_usuario/i.test(sql);
}

function responderObjetivo({ rol = "afiliado", moduloCoseguro = 0, existe = true } = {}) {
  return async (sql) => {
    if (esSelectObjetivo(sql)) {
      if (!existe) return [[]];
      return [[{
        id: 300,
        modulo_coseguro: moduloCoseguro,
        nombre: "Ana",
        apellido: "Perez",
        rol,
      }]];
    }
    if (esUpdate(sql)) return [{ affectedRows: 1 }];
    if (esHistorial(sql)) return [{ insertId: 1 }];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

test("admin habilita el modulo Coseguro de un afiliado y queda en el historial", async () => {
  preparar("admin", responderObjetivo({ moduloCoseguro: 0 }));

  const response = await request("/api/usuarios/300/modulo-coseguro", {
    rol: "admin",
    body: { modulo_coseguro: 1 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id: 300, modulo_coseguro: 1 });
  assert.equal(commits, 1);
  assert.equal(rollbacks, 0);
  assert.equal(releases, 1);

  const seleccion = databaseCalls.find(({ sql }) => esSelectObjetivo(sql));
  assert.ok(seleccion);
  assert.deepEqual(seleccion.params, [300]);

  const actualizacion = databaseCalls.find(({ sql }) => esUpdate(sql));
  assert.ok(actualizacion);
  assert.deepEqual(actualizacion.params, [1, 300]);

  const historial = databaseCalls.find(({ sql }) => esHistorial(sql));
  assert.ok(historial);
  assert.equal(historial.params[0], 300);
  assert.equal(historial.params[1], "UPDATE");
  assert.equal(historial.params[2], "modulo_coseguro");
  assert.equal(historial.params[3], 0);
  assert.equal(historial.params[4], 1);
  assert.equal(historial.params[5], "usuario");
  assert.equal(historial.params[6], 1);
  assert.equal(historial.params[9], "Módulo Coseguro cambiado desde la tabla de usuarios");
});

test("admin deshabilita el modulo Coseguro aceptando booleanos", async () => {
  preparar("admin", responderObjetivo({ moduloCoseguro: 1 }));

  const response = await request("/api/usuarios/300/modulo-coseguro", {
    rol: "admin",
    body: { modulo_coseguro: false },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id: 300, modulo_coseguro: 0 });
  assert.equal(commits, 1);
  const actualizacion = databaseCalls.find(({ sql }) => esUpdate(sql));
  assert.ok(actualizacion);
  assert.deepEqual(actualizacion.params, [0, 300]);
});

test("admin sin cambio responde 200 sin UPDATE ni historial", async () => {
  preparar("admin", responderObjetivo({ moduloCoseguro: 1 }));

  const response = await request("/api/usuarios/300/modulo-coseguro", {
    rol: "admin",
    body: { modulo_coseguro: 1 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id: 300, modulo_coseguro: 1 });
  assert.equal(databaseCalls.some(({ sql }) => esUpdate(sql)), false);
  assert.equal(databaseCalls.some(({ sql }) => esHistorial(sql)), false);
  assert.equal(commits, 0);
  assert.equal(releases, 1);
});

for (const rol of ["departamental", "afiliado"]) {
  test(`${rol} no puede cambiar el modulo Coseguro (401)`, async () => {
    preparar(rol, responderObjetivo({ moduloCoseguro: 0 }));

    const response = await request("/api/usuarios/300/modulo-coseguro", {
      rol,
      body: { modulo_coseguro: 1 },
    });

    assert.equal(response.status, 401);
    assert.equal(response.body, "No autorizado");
    assert.equal(databaseCalls.some(({ sql }) => esSelectObjetivo(sql)), false);
    assert.equal(databaseCalls.some(({ sql }) => esUpdate(sql)), false);
  });
}

test("admin no puede cambiar el modulo a una cuenta que no es afiliada (422)", async () => {
  preparar("admin", responderObjetivo({ rol: "departamental", moduloCoseguro: 0 }));

  const response = await request("/api/usuarios/300/modulo-coseguro", {
    rol: "admin",
    body: { modulo_coseguro: 1 },
  });

  assert.equal(response.status, 422);
  assert.equal(response.body, "Solo se puede cambiar el módulo Coseguro a cuentas de afiliado");
  assert.equal(databaseCalls.some(({ sql }) => esUpdate(sql)), false);
  assert.equal(databaseCalls.some(({ sql }) => esHistorial(sql)), false);
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
  assert.equal(releases, 1);
});

test("admin sobre un usuario inexistente recibe 404", async () => {
  preparar("admin", responderObjetivo({ existe: false }));

  const response = await request("/api/usuarios/300/modulo-coseguro", {
    rol: "admin",
    body: { modulo_coseguro: 1 },
  });

  assert.equal(response.status, 404);
  assert.equal(databaseCalls.some(({ sql }) => esUpdate(sql)), false);
  assert.equal(rollbacks, 1);
});

for (const body of [{ modulo_coseguro: "si" }, { modulo_coseguro: 2 }, {}, { modulo_coseguro: null }]) {
  test(`body invalido ${JSON.stringify(body)} responde 400 sin tocar la base`, async () => {
    preparar("admin", responderObjetivo({ moduloCoseguro: 0 }));

    const response = await request("/api/usuarios/300/modulo-coseguro", {
      rol: "admin",
      body,
    });

    assert.equal(response.status, 400);
    assert.equal(response.body, "El valor de modulo_coseguro es inválido");
    assert.equal(databaseCalls.some(({ sql }) => esSelectObjetivo(sql)), false);
    assert.equal(databaseCalls.some(({ sql }) => esUpdate(sql)), false);
  });
}

test("id invalido responde 400", async () => {
  preparar("admin", responderObjetivo({ moduloCoseguro: 0 }));

  const response = await request("/api/usuarios/abc/modulo-coseguro", {
    rol: "admin",
    body: { modulo_coseguro: 1 },
  });

  assert.equal(response.status, 400);
  assert.equal(databaseCalls.some(({ sql }) => esSelectObjetivo(sql)), false);
});

test("la tabla de usuarios devuelve rol_codigo y modulo_coseguro", async () => {
  preparar("admin", async (sql) => {
    if (/SELECT COUNT\(\*\) AS count/i.test(sql)) return [[{ count: 0 }]];
    if (/FROM usuario u[\s\S]+LEFT JOIN rol r/i.test(sql)) return [[]];
    throw new Error(`Consulta inesperada: ${sql}`);
  });

  const response = await request("/api/tabla/usuarios?page=1", {
    rol: "admin",
    method: "POST",
    body: {},
  });

  assert.equal(response.status, 200);
  const principal = databaseCalls.find(({ sql }) => /END AS rol,[\s\S]+LEFT JOIN rol r[\s\S]+LIMIT/i.test(sql));
  assert.ok(principal);
  assert.match(principal.sql, /r\.nombre AS rol_codigo/);
  assert.match(principal.sql, /u\.modulo_coseguro/);
});
