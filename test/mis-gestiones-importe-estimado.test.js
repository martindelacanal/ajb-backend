"use strict";

// Mis gestiones: el reintegro de coseguro sin importe autorizado muestra el
// estimado (o el del comprobante). La columna importe_es_estimado viaja en todas
// las ramas del UNION, en la misma posición, para que el front marque «≈».

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "mis-gestiones-importe-estimado-test-secret";

const llamadas = [];
let filasPagina = [];

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

const SESION = {
  id: 100, rol_id: 3, rol: "afiliado", departamental_id: 4, habilitado: "Y",
  area_turismo: 1, area_coseguro: 1, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 0,
};

async function consultar(sql, params = []) {
  if (esConsultaAutorizacion(sql)) return [[{ ...SESION }]];
  llamadas.push({ sql, params });
  if (/SELECT g\.tipo, COUNT\(\*\) AS total/.test(sql)) return [[{ tipo: "coseguro", total: filasPagina.length }]];
  if (/SELECT g\.\* FROM \(/.test(sql)) return [filasPagina];
  return [[]];
}

const db = {
  query: consultar,
  execute: consultar,
  async getConnection() {
    return { query: consultar, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => db } };

const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/user"));

const consoleLogOriginal = console.log;
test.before(() => {
  console.log = () => {};
});
test.after(() => {
  console.log = consoleLogOriginal;
});

async function pedirGestiones() {
  llamadas.length = 0;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify({ id: SESION.id, rol: SESION.rol }) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mis-gestiones`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return { body, consultas: [...llamadas] };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Alias de cada columna (en orden) de las ramas del UNION de la consulta paginada. */
function columnasPorRama(sql) {
  const union = sql.slice(sql.indexOf("FROM (") + "FROM (".length, sql.lastIndexOf(") g"));
  return union.split(/\bUNION ALL\b/).map((rama) => {
    // El FROM de la rama ocupa su renglón («FROM reserva r»); el del subselect de conceptos, no
    const select = rama.slice(0, rama.search(/^\s*FROM\s+\w+\s+\w+\s*\r?$/m));
    return [...select.matchAll(/\bAS\s+([a-z_]+),?\s*$/gm)].map((m) => m[1]);
  });
}

test("todas las ramas del UNION traen importe_es_estimado en la misma posición", async () => {
  filasPagina = [];
  const { consultas } = await pedirGestiones();
  const pagina = consultas.find(({ sql }) => /SELECT g\.\* FROM \(/.test(sql));
  assert.ok(pagina, "falta la consulta de la página");

  const ramas = columnasPorRama(pagina.sql);
  assert.equal(ramas.length, 5, "turismo, coseguro, traslado, beneficio y kit");
  for (const columnas of ramas) {
    assert.deepEqual(columnas, ramas[0], "las ramas no proyectan las mismas columnas en el mismo orden");
    assert.equal(columnas.indexOf("importe_es_estimado"), columnas.indexOf("importe") + 1);
  }
});

test("sólo el reintegro sin importe autorizado se marca como estimado", async () => {
  filasPagina = [];
  const { consultas } = await pedirGestiones();
  const { sql } = consultas.find(({ sql: texto }) => /SELECT g\.\* FROM \(/.test(texto));
  const ramas = sql.slice(sql.indexOf("FROM (")).split(/\bUNION ALL\b/);
  const coseguro = ramas.find((rama) => /'coseguro' AS tipo/.test(rama));
  assert.match(coseguro, /CASE WHEN cs\.importe_autorizado IS NULL THEN 1 ELSE 0 END AS importe_es_estimado/);
  for (const rama of ramas.filter((texto) => texto !== coseguro)) {
    assert.match(rama, /\b0 AS importe_es_estimado\b/);
  }
});

test("la marca llega tal cual al front", async () => {
  filasPagina = [
    { id: 57, tipo: "coseguro", codigo: "C-57", estado: "Solicitud iniciada", importe: 4500, importe_es_estimado: 1 },
    { id: 58, tipo: "coseguro", codigo: "C-58", estado: "Liquidado", importe: 9000, importe_es_estimado: 0 },
  ];
  const { body } = await pedirGestiones();
  assert.deepEqual(body.results.map((fila) => [fila.codigo, fila.importe_es_estimado]), [["C-57", 1], ["C-58", 0]]);
});
