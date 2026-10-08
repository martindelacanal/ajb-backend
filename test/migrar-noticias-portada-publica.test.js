"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DDL_EN_PORTADA_PUBLICA,
  ejecutarMigracion,
  main,
  validarEntorno,
} = require("../scripts/migrar-noticias-portada-publica");

// Conexión falsa: `columnas` dice qué columnas de noticia existen.
function conexionFalsa(columnas, consistencia = {}) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params = []) {
      consultas.push(sql);
      if (/information_schema\.COLUMNS/.test(sql)) return [columnas.includes(params[1]) ? [{ 1: 1 }] : []];
      if (/ALTER TABLE noticia/.test(sql)) {
        columnas.push("en_portada_publica");
        return [{}];
      }
      if (/fuera_de_portada/.test(sql)) {
        return [[{ fuera_de_portada: 0, fuera_destacadas: 0, fuera_para_todas: 0, ...consistencia }]];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async end() {},
  };
}

const silencio = { log: () => {}, warn: () => {} };

test("crea la columna con 1 por defecto y es idempotente", async () => {
  assert.match(DDL_EN_PORTADA_PUBLICA, /ADD COLUMN en_portada_publica TINYINT\(1\) NOT NULL DEFAULT 1/);
  assert.match(DDL_EN_PORTADA_PUBLICA, /AFTER alcance_todas/);

  const columnas = ["alcance_todas"];
  const primera = conexionFalsa(columnas);
  assert.equal((await ejecutarMigracion(primera, silencio)).columnaCreada, true);

  const segunda = conexionFalsa(columnas);
  assert.equal((await ejecutarMigracion(segunda, silencio)).columnaCreada, false);
  assert.equal(segunda.consultas.some((sql) => /ALTER TABLE/.test(sql)), false);
});

test("exige la migración de noticias por departamental", async () => {
  await assert.rejects(() => ejecutarMigracion(conexionFalsa([]), silencio), /migrate:noticias-departamentales/);
});

test("avisa las inconsistencias sin corregirlas", async () => {
  const avisos = [];
  const conexion = conexionFalsa(["alcance_todas", "en_portada_publica"], { fuera_destacadas: 2, fuera_para_todas: 1 });
  const resultado = await ejecutarMigracion(conexion, { log: () => {}, warn: (texto) => avisos.push(texto) });
  assert.deepEqual(resultado.consistencia, { fuera_de_portada: 0, fuera_destacadas: 2, fuera_para_todas: 1 });
  assert.equal(avisos.length, 2);
  assert.equal(conexion.consultas.some((sql) => /UPDATE/.test(sql)), false);
});

test("no corre contra producción sin --allow-production", async () => {
  const env = { DB_HOST: "rds.example.com", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db" };
  assert.throws(() => validarEntorno(env), /--allow-production/);
  assert.deepEqual(validarEntorno(env, { permiteProduccion: true }), { esProduccion: true });

  let conecto = false;
  await assert.rejects(
    () => main({ argv: ["node", "x"], env, conectar: async () => { conecto = true; }, ...silencio }),
    /--allow-production/
  );
  assert.equal(conecto, false);
});
