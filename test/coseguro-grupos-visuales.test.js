"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "coseguro-grupos-visuales-test";

const anteriores = [
  { id: 1, nombre: "GASTOS EN PRESTACIONES", cic_codigo: "631.000", grupo_codigo: "631.000", grupo_nombre: "General", grupo_icono: "health_and_safety" },
  { id: 2, nombre: "SUBSIDIOS FALLECIMIENTOS", cic_codigo: "631.613", grupo_codigo: "631.600", grupo_nombre: "Otras prestaciones", grupo_icono: "health_and_safety" },
  { id: 3, nombre: "SUBSIDIOS CELIAQUIA", cic_codigo: "631.614", grupo_codigo: "631.600", grupo_nombre: "Otras prestaciones", grupo_icono: "health_and_safety" },
  { id: 4, nombre: "OTRAS PRESTACIONES", cic_codigo: "631.611", grupo_codigo: "631.600", grupo_nombre: "Otras prestaciones", grupo_icono: "health_and_safety" },
  { id: 5, nombre: "SUBSIDIOS PROTESIS ODONTOLOGICAS", cic_codigo: "631.503", grupo_codigo: "631.500", grupo_nombre: "Odontología", grupo_icono: "dentistry" },
];
const consultas = [];
const db = {
  async query(sql) {
    consultas.push(sql);
    if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u/.test(sql)) return [[{ id: 9, rol: "afiliado", rol_id: 3, departamental_id: 7, habilitado: "Y", area_coseguro: 1, modulo_coseguro: 1 }]];
    if (/FROM coseguro_tipo_reintegro t/.test(sql)) {
      assert.match(sql, /i\.codigo AS cic_codigo/);
      assert.match(sql, /LEFT JOIN coseguro_imputacion i ON i\.id = t\.imputacion_id/);
      return [anteriores.map((fila) => ({ ...fila, adjuntos_config: "[]", conceptos: "[]" }))];
    }
    if (/FROM coseguro_estado|FROM coseguro_concepto|FROM coseguro_imputacion|FROM servicio s/.test(sql)) return [[]];
    throw Error(`Consulta inesperada: ${sql}`);
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => db } };
const app = express();
app.use("/api", require("../api/routes/coseguro"));
app.use("/api", require("../api/routes/publico"));

async function leerCatalogo(url) {
  consultas.length = 0;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify({ id: 9, rol: "afiliado" }) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return await response.json();
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

function verificarGrupos(tipos) {
  assert.deepEqual(tipos.map(({ id, nombre, grupo_codigo, grupo_nombre }) => ({ id, nombre, grupo_codigo, grupo_nombre })), [
    { ...anteriores[0], grupo_nombre: "Gastos en prestaciones" },
    { ...anteriores[1], grupo_codigo: "511.700", grupo_nombre: "Subsidios" },
    { ...anteriores[2], grupo_codigo: "511.700", grupo_nombre: "Subsidios" },
    { ...anteriores[3], grupo_nombre: "Otros" },
    anteriores[4],
  ].map(({ id, nombre, grupo_codigo, grupo_nombre }) => ({ id, nombre, grupo_codigo, grupo_nombre })));
  assert.ok(consultas.every((sql) => /^\s*SELECT\b/i.test(sql)), "la reclasificación debe realizarse sólo al leer");
}

test("el afiliado obtiene grupos actualizados sin modificar las filas antiguas de la base", async () => {
  const catalogo = await leerCatalogo("/coseguro/catalogos");
  verificarGrupos(catalogo.tipos_reintegro);
  assert.equal(catalogo.grupos.find((grupo) => grupo.codigo === "631.000").nombre, "Gastos en prestaciones");
  assert.deepEqual(catalogo.tipos_reintegro.map((tipo) => tipo.cic_codigo), anteriores.map((tipo) => tipo.cic_codigo));
});

test("la portada de salud usa los mismos grupos sin exponer el C.I.C. interno", async () => {
  const catalogo = await leerCatalogo("/publico/salud");
  verificarGrupos(catalogo.tipos);
  for (const tipo of catalogo.tipos) assert.equal(Object.hasOwn(tipo, "cic_codigo"), false);
});
