"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

let conexionActual;
let consultarPool = async () => {
  throw new Error("Consulta de pool inesperada");
};

const dbFalsa = {
  query(sql, params) {
    return consultarPool(sql, params);
  },
  async getConnection() {
    assert.ok(conexionActual, "la prueba debe configurar una conexión");
    return conexionActual;
  },
};

const poolFalso = {
  promise() {
    return dbFalsa;
  },
};

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: poolFalso,
};

const router = require("../api/routes/noticias");

function obtenerHandlerFinal(metodo, ruta) {
  const capa = router.stack.find(
    (item) => item.route?.path === ruta && item.route.methods?.[metodo]
  );
  assert.ok(capa, `no se encontró ${metodo.toUpperCase()} ${ruta}`);
  return capa.route.stack[capa.route.stack.length - 1].handle;
}

const postNoticia = obtenerHandlerFinal("post", "/admin/noticias");
const putNoticia = obtenerHandlerFinal("put", "/admin/noticias/:id(\\d+)");
const putFlags = obtenerHandlerFinal("put", "/admin/noticias/:id(\\d+)/flags");
const getApoyos = obtenerHandlerFinal("get", "/admin/noticias/apoyos");
const getDestacadas = obtenerHandlerFinal("get", "/noticias/publicas/destacadas");

function crearConexion({ totalDestacadas, noticiaId = 23, insertId = 71 }) {
  const eventos = [];
  const connection = {
    eventos,
    async query(sql) {
      if (sql.includes("GET_LOCK")) {
        eventos.push("get_lock");
        return [[{ adquirido: 1 }]];
      }
      if (sql.includes("RELEASE_LOCK")) {
        eventos.push("release_lock");
        return [[{ liberado: 1 }]];
      }
      if (/SELECT \* FROM noticia/.test(sql)) {
        eventos.push("select_noticia");
        return [[{
          id: noticiaId,
          destacada: 0,
          fecha_publicacion: null,
          imagen_archivo: null,
        }]];
      }
      if (/SELECT id FROM noticia/.test(sql)) {
        eventos.push("select_noticia");
        return [[{ id: noticiaId }]];
      }
      if (/SELECT COUNT\(\*\) AS total\s+FROM noticia/.test(sql)) {
        eventos.push("count");
        return [[{ total: totalDestacadas }]];
      }
      if (/INSERT INTO noticia\s/.test(sql)) {
        eventos.push("insert");
        return [{ insertId }];
      }
      if (/UPDATE noticia SET/.test(sql)) {
        eventos.push("update");
        return [{ affectedRows: 1 }];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async beginTransaction() {
      eventos.push("begin");
    },
    async commit() {
      eventos.push("commit");
    },
    async rollback() {
      eventos.push("rollback");
    },
    release() {
      eventos.push("release");
    },
    destroy() {
      eventos.push("destroy");
    },
  };
  return connection;
}

const bodyNoticiaDestacada = Object.freeze({
  titulo: "Noticia de prueba",
  categoria: "Institucional",
  estado: "BORRADOR",
  destacada: "1",
  orden: "0",
  cuerpo: "",
  fecha_publicacion: "",
});

async function ejecutar(handler, { body = {}, params = {} } = {}) {
  let statusCode = 200;
  let respuesta;
  const req = {
    body,
    params,
    files: {},
    data: { data: JSON.stringify({ id: 9, rol: "admin" }) },
  };
  const res = {
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      respuesta = value;
      return this;
    },
    removeHeader() {
      return this;
    },
    set() {
      return this;
    },
  };

  const consoleErrorOriginal = console.error;
  console.error = () => {};
  try {
    await handler(req, res);
  } finally {
    console.error = consoleErrorOriginal;
  }
  return { statusCode, respuesta };
}

test("POST permite crear la quinta destacada y libera el lock después del commit", async () => {
  conexionActual = crearConexion({ totalDestacadas: 4 });

  const resultado = await ejecutar(postNoticia, { body: { ...bodyNoticiaDestacada } });

  assert.equal(resultado.statusCode, 201);
  assert.equal(resultado.respuesta.id, 71);
  assert.deepEqual(conexionActual.eventos, [
    "get_lock", "begin", "count", "insert", "commit", "release_lock", "release",
  ]);
});

for (const escenario of [
  { nombre: "POST", handler: postNoticia, params: {} },
  { nombre: "PUT completo", handler: putNoticia, params: { id: "23" } },
  { nombre: "PUT flags", handler: putFlags, params: { id: "23" }, flags: true },
]) {
  test(`${escenario.nombre} rechaza una sexta destacada, revierte y libera el lock`, async () => {
    conexionActual = crearConexion({ totalDestacadas: 5 });
    const body = escenario.flags
      ? { destacada: "1" }
      : { ...bodyNoticiaDestacada };

    const resultado = await ejecutar(escenario.handler, { body, params: escenario.params });

    assert.equal(resultado.statusCode, 409);
    assert.equal(resultado.respuesta, "Solo se pueden destacar hasta 5 noticias");
    assert.equal(conexionActual.eventos.includes("commit"), false);
    assert.equal(conexionActual.eventos.includes("insert"), false);
    assert.equal(conexionActual.eventos.includes("update"), false);
    assert.deepEqual(conexionActual.eventos.slice(-3), ["rollback", "release_lock", "release"]);
  });
}

test("GET público limita la consulta a cinco noticias destacadas", async () => {
  let consulta;
  consultarPool = async (sql) => {
    consulta = sql;
    return [[]];
  };

  const resultado = await ejecutar(getDestacadas);

  assert.equal(resultado.statusCode, 200);
  assert.deepEqual(resultado.respuesta, []);
  assert.match(consulta, /LIMIT 5\s*$/);
});

test("GET apoyos conserva sus campos y suma el conteo y máximo de destacadas", async () => {
  conexionActual = undefined;
  consultarPool = async (sql) => {
    if (sql.includes("DISTINCT categoria")) return [[{ categoria: "Gremial" }]];
    if (sql.includes("FROM departamental")) return [[{ id: 4, nombre: "La Plata" }]];
    if (sql.includes("COUNT(*) AS total")) return [[{ total: "5" }]];
    throw new Error(`SQL de apoyos inesperado: ${sql}`);
  };

  const resultado = await ejecutar(getApoyos);

  assert.equal(resultado.statusCode, 200);
  assert.deepEqual(resultado.respuesta, {
    categorias: ["Gremial"],
    departamentales: [{ id: 4, nombre: "La Plata" }],
    destacadas: 5,
    max_destacadas: 5,
  });
});
