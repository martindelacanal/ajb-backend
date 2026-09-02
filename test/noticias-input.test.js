"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const router = require("../api/routes/noticias");

const {
  MAX_NOTICIAS_DESTACADAS,
  adquirirLockNoticiasDestacadas,
  liberarConexionGestionNoticias,
  liberarLockNoticiasDestacadas,
  normalizarIdsExcluidos,
  puedeGestionarNoticias,
  validarCupoNoticiasDestacadas,
} = router.__test;

test("la gestión de noticias admite los roles admin y prensa", () => {
  assert.equal(puedeGestionarNoticias({ rol: "admin" }), true);
  assert.equal(puedeGestionarNoticias({ rol: "prensa" }), true);
});

test("la gestión de noticias rechaza los demás roles", () => {
  ["afiliado", "departamental", "admin-central", "coseguro"].forEach((rol) => {
    assert.equal(puedeGestionarNoticias({ rol }), false, `el rol ${rol} no debe gestionar noticias`);
  });
  assert.equal(puedeGestionarNoticias({}), false);
  assert.equal(puedeGestionarNoticias(null), false);
});

test("exclude_ids admite hasta cinco enteros positivos y elimina repetidos", () => {
  assert.equal(MAX_NOTICIAS_DESTACADAS, 5);
  assert.deepEqual(normalizarIdsExcluidos(undefined), []);
  assert.deepEqual(normalizarIdsExcluidos("1, 2,2,900"), [1, 2, 900]);
  assert.deepEqual(normalizarIdsExcluidos("1,2,3,4,5"), [1, 2, 3, 4, 5]);
});

test("exclude_ids rechaza exceso, valores parciales y formas ambiguas", () => {
  assert.equal(normalizarIdsExcluidos("1,2,3,4,5,6"), null);
  assert.equal(normalizarIdsExcluidos("1,2 OR 1=1"), null);
  assert.equal(normalizarIdsExcluidos("1,,2"), null);
  assert.equal(normalizarIdsExcluidos(["1", "2"]), null);
  assert.equal(normalizarIdsExcluidos(String(Number.MAX_SAFE_INTEGER + 1)), null);
});

test("el cupo no consulta la base cuando la noticia no queda destacada", async () => {
  let consultas = 0;
  const connection = {
    query: async () => {
      consultas += 1;
      throw new Error("no debe consultar");
    },
  };

  await validarCupoNoticiasDestacadas(connection, 0);
  await validarCupoNoticiasDestacadas(connection, undefined, 8);
  assert.equal(consultas, 0);
});

test("el cupo permite crear la quinta noticia destacada", async () => {
  const connection = {
    query: async (sql, params) => {
      assert.match(sql, /eliminado = 0 AND destacada = 1/);
      assert.doesNotMatch(sql, /id <> \?/);
      assert.deepEqual(params, []);
      return [[{ total: 4 }]];
    },
  };

  await validarCupoNoticiasDestacadas(connection, 1);
});

test("el cupo excluye la noticia actual al editar", async () => {
  const connection = {
    query: async (sql, params) => {
      assert.match(sql, /id <> \?/);
      assert.deepEqual(params, [23]);
      return [[{ total: 4 }]];
    },
  };

  await validarCupoNoticiasDestacadas(connection, 1, 23);
});

test("el cupo rechaza una sexta noticia destacada con conflicto 409", async () => {
  const connection = {
    query: async () => [[{ total: 5 }]],
  };

  await assert.rejects(
    validarCupoNoticiasDestacadas(connection, 1),
    (error) => error.statusCode === 409
      && error.message === "Solo se pueden destacar hasta 5 noticias"
  );
});

test("el advisory lock se identifica por base y se libera en la misma conexión", async () => {
  const consultas = [];
  const connection = {
    query: async (sql, params = []) => {
      consultas.push({ sql, params });
      if (sql.includes("GET_LOCK")) return [[{ adquirido: 1 }]];
      return [[{ liberado: 1 }]];
    },
  };

  await adquirirLockNoticiasDestacadas(connection);
  assert.equal(await liberarLockNoticiasDestacadas(connection), true);
  assert.equal(consultas.length, 2);
  assert.match(consultas[0].sql, /GET_LOCK\(CONCAT\('noticias_destacadas:', DATABASE\(\)\)/);
  assert.deepEqual(consultas[0].params, [5]);
  assert.match(consultas[1].sql, /RELEASE_LOCK\(CONCAT\('noticias_destacadas:', DATABASE\(\)\)/);
});

test("el advisory lock informa indisponibilidad temporal", async () => {
  const connection = {
    query: async () => [[{ adquirido: 0 }]],
  };

  await assert.rejects(
    adquirirLockNoticiasDestacadas(connection),
    (error) => error.statusCode === 409 && /otra actualización/.test(error.message)
  );
});

test("el advisory lock diferencia un error de base de una contención", async () => {
  const connection = {
    query: async () => [[{ adquirido: null }]],
  };

  await assert.rejects(
    adquirirLockNoticiasDestacadas(connection),
    (error) => error.statusCode === 500 && /No se pudo coordinar/.test(error.message)
  );
});

test("la conexión vuelve al pool sólo después de liberar el advisory lock", async () => {
  const eventos = [];
  const connection = {
    query: async (sql) => {
      eventos.push(sql.includes("RELEASE_LOCK") ? "unlock" : "query");
      return [[{ liberado: 1 }]];
    },
    release: () => eventos.push("release"),
    destroy: () => eventos.push("destroy"),
  };

  await liberarConexionGestionNoticias(connection, true, "test");
  assert.deepEqual(eventos, ["unlock", "release"]);
});

test("una conexión que no pudo liberar el advisory lock se destruye", async () => {
  const eventos = [];
  const connection = {
    query: async () => [[{ liberado: 0 }]],
    release: () => eventos.push("release"),
    destroy: () => eventos.push("destroy"),
  };
  const consoleErrorOriginal = console.error;
  console.error = () => {};
  try {
    await liberarConexionGestionNoticias(connection, true, "test");
  } finally {
    console.error = consoleErrorOriginal;
  }

  assert.deepEqual(eventos, ["destroy"]);
});
