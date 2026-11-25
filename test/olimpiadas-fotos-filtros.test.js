"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

Object.assign(process.env, { JWT_SECRET: "fotos-filtros", BUCKET_REGION: "us-east-1", BUCKET_NAME: "fotos-filtros",
  ACCESS_KEY: "test", SECRET_ACCESS_KEY: "test" });
const conexionReal = require.resolve("../api/connection/connection");
require.cache[conexionReal] = { id: conexionReal, filename: conexionReal, loaded: true,
  exports: { promise: () => ({ async query() { throw new Error("Estas pruebas no usan la base"); } }) } };

const { leerDepartamentales, listarFotos, nombresDepartamentales, serializarFoto } = require("../api/services/olimpiadas-fotos");

test("fotos: las departamentales llegan como lista, JSON o texto con comas, sin repetir", () => {
  assert.deepEqual(leerDepartamentales([3, "7", 3]), [3, 7]);
  assert.deepEqual(leerDepartamentales("[7, 3]"), [7, 3]);
  assert.deepEqual(leerDepartamentales("3,7 , 3"), [3, 7]);
  assert.deepEqual(leerDepartamentales(5), [5]);
  for (const vacio of [undefined, null, "", "  ", [], "[]"]) assert.deepEqual(leerDepartamentales(vacio), []);
  for (const invalido of ["La Plata", [0], [-1], ["1.5"], "[1,", [{ id: 1 }], "3,,7"]) {
    assert.throws(() => leerDepartamentales(invalido), /departamentales elegidas son inválidas/, JSON.stringify(invalido));
  }
  assert.throws(() => leerDepartamentales(Array.from({ length: 41 }, (_, i) => i + 1)), /hasta 40 departamentales/);

  const { leerCamposFoto } = require("../api/routes/olimpiadas-contenido").__test;
  assert.deepEqual(leerCamposFoto({ departamentales: "[3,7,3]" }), { departamentales: "[3,7]" });
  // Lista vacía = quitar las departamentales; campo ausente = no tocarlas.
  assert.deepEqual(leerCamposFoto({ departamentales: [] }), { departamentales: null });
  assert.deepEqual(leerCamposFoto({ fecha: "2026-11-27" }), { fecha: "2026-11-27" });
});

// Base simulada: registra cada consulta y devuelve lo mínimo que necesita el listado.
function baseDeFotos(filas, departamentales) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql, params });
      if (sql.startsWith("SELECT COUNT(*) AS total")) return [[{ total: filas.length }]];
      if (sql.startsWith("SELECT f.id,")) return [filas];
      if (sql.includes("FROM olimpiada_foto f CROSS JOIN JSON_TABLE(COALESCE(f.departamentales")) return [departamentales];
      if (sql.includes("FROM departamental WHERE id IN (?)")) return [departamentales.filter(d => params[0].includes(d.id))];
      if (sql.includes("GROUP BY")) return [[]];
      throw new Error("Consulta inesperada: " + sql);
    },
  };
}
const sinPartidos = async () => [];

test("fotos: cada filtro admite varias opciones y alcanza con coincidir con alguna", async () => {
  const filas = [
    { id: 2, olimpiada_id: 1, archivo: "g/2.webp", miniatura_archivo: "m/2.webp", departamentales: "[7,3,99]", etiquetas: '["hinchada"]' },
    { id: 1, olimpiada_id: 1, archivo: "g/1.webp", miniatura_archivo: "m/1.webp", departamentales: [3], etiquetas: null, etiqueta: null },
    { id: 3, olimpiada_id: 1, archivo: "g/3.webp", miniatura_archivo: "m/3.webp", departamentales: null },
  ];
  const facetas = [{ id: 3, nombre: "La Plata", cantidad: "2" }, { id: 7, nombre: "Azul", cantidad: 1 }];
  const base = baseDeFotos(filas, facetas);
  const respuesta = await listarFotos(base, 1, {
    disciplinas: "5,6,5", partidos: ["9", "12"], fechas: "2026-11-26, 2026-11-27", etiquetas: "hinchada, La Plata",
    departamentales: "3,7", pageSize: "12",
  }, sinPartidos);

  const [cuenta, pagina] = base.consultas;
  for (const condicion of [
    "f.disciplina_id IN (?)", "f.partido_id IN (?)", "f.fecha IN (?)", "WHERE tag.etiqueta IN (?)) > 0",
    "(SELECT COUNT(*) FROM JSON_TABLE(COALESCE(f.departamentales, JSON_ARRAY()), '$[*]' COLUMNS (id INT PATH '$')) AS dep WHERE dep.id IN (?)) > 0",
  ]) {
    assert.ok(cuenta.sql.includes(condicion), "el total filtra por " + condicion);
    assert.ok(pagina.sql.includes(condicion), "la página filtra por " + condicion);
  }
  const filtros = [1, [5, 6], [9, 12], ["2026-11-26", "2026-11-27"], ["hinchada", "La Plata"], [3, 7]];
  assert.deepEqual(cuenta.params, filtros);
  // Sin EXISTS sobre las listas JSON: MySQL 8.0 lo vuelve un semijoin con totales equivocados.
  assert.ok(!cuenta.sql.includes("EXISTS (SELECT 1 FROM JSON_TABLE"));
  assert.deepEqual(pagina.params, [...filtros, 12, 0]);
  // Para el público, las fotos de un partido que todavía no empezó no se filtran por ese partido.
  assert.match(cuenta.sql, /p\.estado IN \('EN_JUEGO', 'FINALIZADO'\)/);

  assert.deepEqual(respuesta.results.map(f => f.departamentales), [
    // Ordenadas por nombre; la que ya no existe (99) no se muestra.
    [{ id: 7, nombre: "Azul" }, { id: 3, nombre: "La Plata" }],
    [{ id: 3, nombre: "La Plata" }],
    [],
  ]);
  assert.deepEqual(respuesta.filtros.departamentales, [{ id: 3, nombre: "La Plata", cantidad: 2 }, { id: 7, nombre: "Azul", cantidad: 1 }]);
  assert.equal(respuesta.pageSize, 12);
});

test("fotos: los filtros de una sola opción siguen funcionando y los inválidos se rechazan", async () => {
  const base = baseDeFotos([], []);
  await listarFotos(base, 4, { disciplina_id: "5", partido_id: "9", fecha: "2026-11-27", etiqueta: "Azul", departamental_id: "3" }, sinPartidos, { gestion: true });
  assert.deepEqual(base.consultas[0].params, [4, [5], [9], ["2026-11-27"], ["Azul"], [3]]);
  // En la gestión (administración y Prensa) también se ven las fotos de partidos programados.
  assert.doesNotMatch(base.consultas[0].sql, /p\.estado IN/);

  const sinFiltros = baseDeFotos([], []);
  await listarFotos(sinFiltros, 4, { disciplinas: "", departamentales: "" }, sinPartidos);
  assert.deepEqual(sinFiltros.consultas[0].params, [4]);

  for (const [query, mensaje] of [
    [{ disciplinas: "5,x" }, /El filtro disciplinas es inválido/],
    [{ disciplina_id: "0" }, /El filtro disciplina_id es inválido/],
    [{ partidos: "-1" }, /El filtro partidos es inválido/],
    [{ fechas: "2026-11-27,ayer" }, /El filtro fechas es inválido/],
    [{ fecha: "27/11/2026" }, /El filtro fecha es inválido/],
    [{ departamentales: "La Plata" }, /El filtro departamentales es inválido/],
    [{ departamentales: Array.from({ length: 61 }, (_, i) => i + 1).join(",") }, /hasta 60 opciones/],
    [{ pageSize: "61" }, /paginación es inválida/],
  ]) {
    await assert.rejects(listarFotos(baseDeFotos([], []), 4, query, sinPartidos), mensaje, JSON.stringify(query));
  }
});

test("fotos: los nombres de las departamentales se consultan una sola vez y sólo si hacen falta", async () => {
  const base = baseDeFotos([], [{ id: 3, nombre: "La Plata" }, { id: 7, nombre: "Azul" }]);
  assert.equal((await nombresDepartamentales(base, [{ departamentales: null }, {}])).size, 0);
  assert.equal(base.consultas.length, 0);
  const nombres = await nombresDepartamentales(base, [{ departamentales: "[3]" }, { departamentales: [3, 7] }]);
  assert.equal(base.consultas.length, 1);
  assert.deepEqual(base.consultas[0].params, [[3, 7]]);
  const foto = await serializarFoto({ id: 9, olimpiada_id: 1, archivo: "g/9.jpg", miniatura_archivo: "m/9.webp", departamentales: "[3,7]" }, null, nombres);
  assert.deepEqual(foto.departamentales, [{ id: 7, nombre: "Azul" }, { id: 3, nombre: "La Plata" }]);
  // Sin el mapa de nombres (una llamada vieja) la foto sale igual, sin departamentales.
  assert.deepEqual((await serializarFoto({ id: 9, olimpiada_id: 1, archivo: "g/9.jpg", miniatura_archivo: "m/9.webp", departamentales: "[3]" })).departamentales, []);
});
