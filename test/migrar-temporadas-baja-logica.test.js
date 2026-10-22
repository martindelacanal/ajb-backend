"use strict";

// scripts/migrar-temporadas-baja-logica.js: columnas e índices de la baja lógica de
// tarifas. Idempotente, --check sin DDL, frena ante columnas o índices ajenos y no
// corre contra producción sin --allow-production.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INDICES,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  MIGRATION_LOCK,
  TABLAS,
  ejecutarMigracion,
  main,
  parsearArgumentos,
  validarDestino,
} = require("../scripts/migrar-temporadas-baja-logica");

// Columnas de hoy (develop): sólo las que importan para la migración.
function esquemaActual() {
  const columna = (DATA_TYPE, COLUMN_TYPE, IS_NULLABLE = "YES", COLUMN_DEFAULT = null) => (
    { DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT }
  );
  return {
    tarifa: {
      columnas: new Map([
        ["id", columna("int", "int", "NO")],
        ["recurso_id", columna("int", "int")],
        ["temporada_tarifa_id", columna("int", "int")],
        ["turismo_tarifa_regla_id", columna("bigint", "bigint unsigned")],
      ]),
      indices: { PRIMARY: ["id"], tarifa_temporada_idx: ["temporada_tarifa_id"] },
    },
    tarifa_adicional: {
      columnas: new Map([
        ["id", columna("int", "int", "NO")],
        ["temporada_tarifa_id", columna("int", "int", "NO")],
        ["activo", columna("tinyint", "tinyint(1)", "NO", "1")],
      ]),
      indices: { PRIMARY: ["id"], idx_tarifa_adicional_activo: ["temporada_tarifa_id", "activo"] },
    },
  };
}

// Conexión falsa que aplica los ALTER sobre `esquema` (así la segunda corrida ve el
// resultado de la primera) y responde los conteos y el registro de migraciones.
function crearConexion(esquema, { lock = 1, registrada = null } = {}) {
  const consultas = [];
  const definicion = (tabla, nombre) => TABLAS.find((t) => t.tabla === tabla).columnas.find((c) => c.nombre === nombre);
  return {
    consultas,
    terminada: false,
    async query(sql, params = []) {
      const texto = String(sql).replace(/\s+/g, " ").trim();
      consultas.push({ sql: texto, params });
      if (/^SELECT GET_LOCK/.test(texto)) return [[{ adquirido: lock }]];
      if (/^SELECT RELEASE_LOCK/.test(texto)) return [[{ liberado: 1 }]];
      if (/^CREATE TABLE IF NOT EXISTS ajb_schema_migration/.test(texto)) return [{}];
      if (/^SELECT checksum FROM ajb_schema_migration/.test(texto)) return [registrada ? [{ checksum: registrada }] : []];
      if (/^(INSERT INTO|UPDATE) ajb_schema_migration/.test(texto)) return [{ affectedRows: 1 }];
      if (/FROM information_schema\.TABLES/.test(texto)) return [[{ total: esquema[params[0]] ? 1 : 0 }]];
      if (/FROM information_schema\.COLUMNS/.test(texto)) {
        const tabla = esquema[params[0]];
        return [tabla ? Array.from(tabla.columnas, ([COLUMN_NAME, datos]) => ({ COLUMN_NAME, ...datos })) : []];
      }
      if (/FROM information_schema\.STATISTICS/.test(texto)) {
        const filas = Object.entries(esquema[params[0]]?.indices || {}).flatMap(([INDEX_NAME, columnas]) => (
          columnas.map((COLUMN_NAME, posicion) => ({ INDEX_NAME, SEQ_IN_INDEX: posicion + 1, COLUMN_NAME }))
        ));
        return [filas];
      }
      const altaColumnas = /^ALTER TABLE (\w+) (ADD COLUMN .*)$/.exec(texto);
      if (altaColumnas) {
        for (const [, nombre] of altaColumnas[2].matchAll(/ADD COLUMN (\w+)/g)) {
          const def = definicion(altaColumnas[1], nombre);
          esquema[altaColumnas[1]].columnas.set(nombre, {
            DATA_TYPE: def.dataType,
            COLUMN_TYPE: def.columnType || def.dataType,
            IS_NULLABLE: def.nulable ? "YES" : "NO",
            COLUMN_DEFAULT: def.predeterminado ?? null,
          });
        }
        return [{ affectedRows: 0 }];
      }
      const altaIndice = /^ALTER TABLE (\w+) ADD INDEX (\w+) \(([^)]+)\), ALGORITHM=INPLACE, LOCK=NONE$/.exec(texto);
      if (altaIndice) {
        esquema[altaIndice[1]].indices[altaIndice[2]] = altaIndice[3].split(", ");
        return [{ affectedRows: 0 }];
      }
      if (/AS origen, COUNT\(\*\) AS filas FROM tarifa t/.test(texto)) {
        return [[{ origen: "BLOQUE", filas: 216 }, { origen: "GENERAL", filas: 1854 }]];
      }
      if (/COUNT\(DISTINCT t\.temporada_tarifa_id\) AS temporadas/.test(texto)) return [[{ temporadas: 2 }]];
      if (/FROM tarifa_adicional WHERE activo = 0/.test(texto)) return [[{ filas: 0 }]];
      if (/FROM tarifa WHERE eliminado = 1/.test(texto)) return [[{ filas: 0 }]];
      throw new Error(`Consulta inesperada: ${texto}`);
    },
    async end() {
      this.terminada = true;
    },
  };
}

const silencio = () => {};
const altas = (conexion) => conexion.consultas.filter(({ sql }) => /^ALTER TABLE/.test(sql)).map(({ sql }) => sql);

test("agrega las columnas en orden y los índices; una segunda corrida no hace nada", async () => {
  const esquema = esquemaActual();
  const conexion = crearConexion(esquema);
  const primera = await ejecutarMigracion(conexion, { log: silencio });

  assert.deepEqual(primera.columnasCreadas, [
    "tarifa.eliminado",
    "tarifa.fecha_eliminacion",
    "tarifa.eliminado_usuario_id",
    "tarifa.eliminado_motivo",
    "tarifa.eliminado_lote",
    "tarifa_adicional.fecha_eliminacion",
    "tarifa_adicional.eliminado_usuario_id",
    "tarifa_adicional.eliminado_motivo",
    "tarifa_adicional.eliminado_lote",
  ]);
  assert.deepEqual(primera.indicesCreados, [
    "tarifa.idx_tarifa_temporada_eliminado",
    "tarifa.idx_tarifa_eliminado_lote",
    "tarifa_adicional.idx_tarifa_adicional_lote",
  ]);

  const [tarifa, adicional, ...indices] = altas(conexion);
  assert.match(tarifa, /^ALTER TABLE tarifa ADD COLUMN eliminado TINYINT\(1\) NOT NULL DEFAULT 0 COMMENT '[^']+' AFTER turismo_tarifa_regla_id, /);
  assert.match(tarifa, /ADD COLUMN fecha_eliminacion DATETIME NULL DEFAULT NULL AFTER eliminado, /);
  assert.match(tarifa, /ADD COLUMN eliminado_usuario_id INT NULL DEFAULT NULL AFTER fecha_eliminacion, /);
  assert.match(tarifa, /ADD COLUMN eliminado_motivo ENUM\('QUITADO','REEMPLAZADO'\) NULL DEFAULT NULL AFTER eliminado_usuario_id, /);
  assert.match(tarifa, /ADD COLUMN eliminado_lote CHAR\(36\) NULL DEFAULT NULL AFTER eliminado_motivo$/);
  assert.match(adicional, /^ALTER TABLE tarifa_adicional ADD COLUMN fecha_eliminacion DATETIME NULL DEFAULT NULL AFTER activo, /);
  assert.doesNotMatch(adicional, /ADD COLUMN eliminado /, "tarifa_adicional sigue usando activo");
  assert.deepEqual(indices, INDICES.map((indice) => (
    `ALTER TABLE ${indice.tabla} ADD INDEX ${indice.nombre} (${indice.columnas.join(", ")}), ALGORITHM=INPLACE, LOCK=NONE`
  )));
  // No reescribe filas: ningún UPDATE ni DELETE de datos.
  assert.equal(conexion.consultas.filter(({ sql }) => /^(UPDATE|DELETE|INSERT)/.test(sql)).length, 0);
  assert.deepEqual(primera.conteos, {
    tarifas_por_origen: { BLOQUE: 216, GENERAL: 1854 },
    temporadas_con_reservas: 2,
    adicionales_inactivos_legado: 0,
    tarifas_dadas_de_baja: 0,
  });

  const otra = crearConexion(esquema);
  const segunda = await ejecutarMigracion(otra, { log: silencio });
  assert.deepEqual(segunda.columnasCreadas, []);
  assert.deepEqual(segunda.indicesCreados, []);
  assert.equal(segunda.columnasExistentes.length, 9);
  assert.equal(segunda.indicesExistentes.length, 3);
  assert.deepEqual(altas(otra), []);
});

test("--check sólo informa lo pendiente, sin DDL ni registro", async () => {
  const conexion = crearConexion(esquemaActual());
  const lineas = [];
  const resultado = await ejecutarMigracion(conexion, { checkOnly: true, log: (linea) => lineas.push(linea) });
  assert.equal(resultado.pendientes.length, 12);
  assert.deepEqual(altas(conexion), []);
  assert.ok(lineas.some((linea) => /\[PENDIENTE\] ALTER TABLE tarifa ADD COLUMN eliminado /.test(linea)));
  assert.ok(lineas.some((linea) => /\[PENDIENTE\] ALTER TABLE tarifa ADD INDEX idx_tarifa_temporada_eliminado/.test(linea)));
  assert.ok(lineas.some((linea) => /Tarifas dadas de baja: - \(falta la columna eliminado\)/.test(linea)));
  assert.equal(resultado.conteos.tarifas_dadas_de_baja, null);
});

test("frena sin tocar nada si una columna ya existe con otra definición", async () => {
  const esquema = esquemaActual();
  esquema.tarifa.columnas.set("eliminado", { DATA_TYPE: "int", COLUMN_TYPE: "int", IS_NULLABLE: "YES", COLUMN_DEFAULT: null });
  const conexion = crearConexion(esquema);
  await assert.rejects(
    () => ejecutarMigracion(conexion, { log: silencio }),
    /tarifa\.eliminado: tipo int \(se esperaba tinyint\), NULL \(se esperaba NOT NULL\), DEFAULT NULL \(se esperaba 0\)/
  );
  assert.deepEqual(altas(conexion), []);
});

test("completa una migración a medias y no duplica índices con otro nombre", async () => {
  const esquema = esquemaActual();
  esquema.tarifa.columnas.set("eliminado", {
    DATA_TYPE: "tinyint", COLUMN_TYPE: "tinyint(1)", IS_NULLABLE: "NO", COLUMN_DEFAULT: "0",
  });
  esquema.tarifa.indices.idx_lote_manual = ["eliminado_lote", "id"];
  const conexion = crearConexion(esquema);
  const resultado = await ejecutarMigracion(conexion, { log: silencio });
  assert.ok(!resultado.columnasCreadas.includes("tarifa.eliminado"));
  assert.ok(resultado.columnasCreadas.includes("tarifa.fecha_eliminacion"));
  assert.deepEqual(resultado.indicesExistentes, ["tarifa.idx_lote_manual"]);
  const [tarifa] = altas(conexion);
  assert.match(tarifa, /^ALTER TABLE tarifa ADD COLUMN fecha_eliminacion DATETIME NULL DEFAULT NULL AFTER eliminado, /);
});

test("frena si el nombre de un índice está tomado por otras columnas", async () => {
  const esquema = esquemaActual();
  esquema.tarifa_adicional.indices.idx_tarifa_adicional_lote = ["recurso_id"];
  const conexion = crearConexion(esquema);
  await assert.rejects(() => ejecutarMigracion(conexion, { log: silencio }), /ya tiene un índice idx_tarifa_adicional_lote sobre \(recurso_id\)/);
  assert.deepEqual(altas(conexion), [], "valida todo antes de ejecutar DDL");
});

test("argumentos y destino: producción exige --allow-production", () => {
  assert.deepEqual(parsearArgumentos(["--check"]), { checkOnly: true, allowProduction: false });
  assert.throws(() => parsearArgumentos(["--force"]), /Argumentos desconocidos/);
  const remoto = { DB_HOST: "db.rds.test", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db_miajb" };
  assert.throws(() => validarDestino({ checkOnly: false, allowProduction: false }, remoto), /--allow-production/);
  assert.doesNotThrow(() => validarDestino({ checkOnly: true, allowProduction: false }, remoto));
  assert.doesNotThrow(() => validarDestino({ checkOnly: false, allowProduction: true }, remoto));
  assert.doesNotThrow(() => validarDestino({ checkOnly: false, allowProduction: false }, { ...remoto, DB_HOST: "localhost" }));
});

test("main toma el lock, registra la corrida y no se conecta a producción sin permiso", async () => {
  const remoto = { DB_HOST: "db.rds.test", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db_miajb" };
  let conecto = false;
  await assert.rejects(
    () => main({ argv: [], env: remoto, conectar: async () => { conecto = true; }, log: silencio }),
    /--allow-production/
  );
  assert.equal(conecto, false);

  const conexion = crearConexion(esquemaActual());
  await main({ argv: [], env: { ...remoto, DB_HOST: "localhost" }, conectar: async () => conexion, log: silencio });
  const sqls = conexion.consultas.map(({ sql }) => sql);
  assert.equal(conexion.consultas[0].params[0], MIGRATION_LOCK);
  assert.match(sqls[0], /^SELECT GET_LOCK/);
  const registro = conexion.consultas.find(({ sql }) => /^INSERT INTO ajb_schema_migration/.test(sql));
  assert.deepEqual(registro.params, [MIGRATION_ID, MIGRATION_CHECKSUM, 1]);
  const cierre = conexion.consultas.find(({ sql }) => /^UPDATE ajb_schema_migration/.test(sql));
  assert.equal(cierre.params[0], "APLICADA");
  assert.match(sqls.at(-1), /^SELECT RELEASE_LOCK/);
  assert.equal(conexion.terminada, true);

  // --check: sin registro ni DDL.
  const chequeo = crearConexion(esquemaActual());
  await main({ argv: ["--check"], env: remoto, conectar: async () => chequeo, log: silencio });
  assert.equal(chequeo.consultas.filter(({ sql }) => /ajb_schema_migration|^ALTER/.test(sql)).length, 0);
});

test("main marca la corrida como FALLIDA si algo sale mal y libera el lock", async () => {
  const esquema = esquemaActual();
  delete esquema.tarifa_adicional;
  const conexion = crearConexion(esquema);
  await assert.rejects(
    () => main({ argv: [], env: { DB_HOST: "localhost", DB_USER: "root", DB_PASSWORD: "x", DB_DATABASE: "db" }, conectar: async () => conexion, log: silencio }),
    /Falta la tabla tarifa_adicional/
  );
  const cierre = conexion.consultas.find(({ sql }) => /^UPDATE ajb_schema_migration/.test(sql));
  assert.equal(cierre.params[0], "FALLIDA");
  assert.match(conexion.consultas.at(-1).sql, /^SELECT RELEASE_LOCK/);
  assert.deepEqual(altas(conexion), []);
});

test("frena si la migración ya se registró con otro checksum", async () => {
  const conexion = crearConexion(esquemaActual(), { registrada: "otro" });
  await assert.rejects(
    () => main({ argv: [], env: { DB_HOST: "localhost", DB_USER: "root", DB_PASSWORD: "x", DB_DATABASE: "db" }, conectar: async () => conexion, log: silencio }),
    /ya fue registrada con otro checksum/
  );
  assert.deepEqual(altas(conexion), []);
});
