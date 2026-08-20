"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "perfil-departamental-test-secret";

const databaseCalls = [];
let databaseHandler = async (sql) => {
  throw new Error(`Consulta inesperada: ${sql}`);
};
let commits = 0;
let rollbacks = 0;

const sesionDepartamentalSinTurismo = {
  id: 100,
  rol_id: 2,
  rol: "departamental",
  departamental_id: 7,
  habilitado: "Y",
  area_turismo: 0,
  area_coseguro: 1,
  modulo_turismo: 1,
  modulo_coseguro: 1,
  modulo_olimpiadas: 1,
};

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

async function consultar(sql, params = []) {
  databaseCalls.push({ sql, params });
  if (esConsultaAutorizacion(sql)) {
    return [[{ ...sesionDepartamentalSinTurismo }]];
  }
  return databaseHandler(sql, params);
}

const transactionalConnection = {
  query: consultar,
  execute: consultar,
  async beginTransaction() {},
  async commit() { commits += 1; },
  async rollback() { rollbacks += 1; },
  release() {},
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

function setDatabaseHandler(handler) {
  databaseCalls.length = 0;
  commits = 0;
  rollbacks = 0;
  databaseHandler = handler;
}

function tokenDepartamental() {
  return jwt.sign({
    data: JSON.stringify({
      id: 100,
      rol: "departamental",
      departamental_id: 7,
      area_turismo: 0,
    }),
  }, process.env.JWT_SECRET);
}

async function request(path, { method = "GET", body } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokenDepartamental()}`,
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

function usuarioAfiliado(departamentalId = 7) {
  return {
    id: 200,
    rol_id: 3,
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 0,
    departamental_id: departamentalId,
    tipo_persona_id: 1,
    nombre: "Ana",
    apellido: "Perez",
    fecha_nacimiento: "1990-01-15",
    documento: 30111222,
    email: "ana@example.test",
    telefono: "2215550000",
    direccion: "Direccion anterior",
    dependencia_judicial: "Dependencia anterior",
    legajo: "A-1",
    cuil: null,
    cbu: null,
    foto_archivo: null,
    habilitado: "Y",
    rol_nombre: "afiliado",
  };
}

function responderPerfil({ departamentalObjetivo = 7 } = {}) {
  const afiliado = usuarioAfiliado(departamentalObjetivo);
  return async (sql) => {
    if (/SELECT id, departamental_id FROM usuario WHERE id IN \(\?, \?\)/i.test(sql)) {
      return [[
        { id: 100, departamental_id: 7 },
        { id: 200, departamental_id: departamentalObjetivo },
      ]];
    }
    if (/SELECT \* FROM usuario WHERE id = \? FOR UPDATE/i.test(sql)) {
      return [[afiliado]];
    }
    if (/FROM usuario u[\s\S]+LEFT JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql)) {
      return [[afiliado]];
    }
    if (/SELECT nombre FROM rol WHERE id = \?/i.test(sql)) {
      return [[{ nombre: "afiliado" }]];
    }
    if (/^UPDATE usuario SET/i.test(sql.trim())) {
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO historial_usuario/i.test(sql)) {
      return [{ insertId: 1 }];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

test("GET perfil permite a la departamental sin area Turismo consultar un afiliado propio", async () => {
  setDatabaseHandler(responderPerfil());

  const response = await request("/api/configuracion/usuario/200");

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.id, 200);
  assert.equal(response.body.data.departamental_id, 7);
  assert.equal(databaseCalls.filter(({ sql }) => /WHERE u\.id = \?/i.test(sql)).length, 2);
});

test("PUT perfil permite editar contacto y modulos propios sin area Turismo", async () => {
  setDatabaseHandler(responderPerfil());

  const response = await request("/api/configuracion/usuario/200", {
    method: "PUT",
    body: {
      direccion: "Calle 123",
      dependencia_judicial: "Juzgado Laboral",
      modulo_turismo: 0,
      modulo_coseguro: 0,
      modulo_olimpiadas: 1,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(commits, 1);
  const actualizacion = databaseCalls.find(({ sql }) => /^UPDATE usuario SET/i.test(sql.trim()));
  assert.ok(actualizacion);
  assert.match(actualizacion.sql, /modulo_turismo = \?/);
  assert.match(actualizacion.sql, /modulo_coseguro = \?/);
  assert.match(actualizacion.sql, /modulo_olimpiadas = \?/);
  assert.match(actualizacion.sql, /direccion = \?/);
  assert.match(actualizacion.sql, /dependencia_judicial = \?/);
  assert.deepEqual(actualizacion.params, [0, 0, 1, "Calle 123", "Juzgado Laboral", 200]);
});

test("GET perfil mantiene bloqueado al afiliado de otra jurisdiccion", async () => {
  setDatabaseHandler(responderPerfil({ departamentalObjetivo: 8 }));

  const response = await request("/api/configuracion/usuario/200");

  assert.equal(response.status, 403);
  assert.equal(response.body.success, false);
  assert.equal(
    databaseCalls.some(({ sql }) => /LEFT JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql)),
    false
  );
});

test("PUT perfil mantiene bloqueada la edicion fuera de jurisdiccion", async () => {
  setDatabaseHandler(responderPerfil({ departamentalObjetivo: 8 }));

  const response = await request("/api/configuracion/usuario/200", {
    method: "PUT",
    body: { direccion: "No debe guardarse", modulo_turismo: 0 },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.success, false);
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
  assert.equal(databaseCalls.some(({ sql }) => /^UPDATE usuario SET/i.test(sql.trim())), false);
});
