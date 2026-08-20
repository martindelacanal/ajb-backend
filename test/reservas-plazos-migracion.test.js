const test = require("node:test");
const assert = require("node:assert/strict");

const {
  asegurarEsquemaModalidad,
  evaluarColumnaModalidad,
  normalizarModalidadLegacy,
  validarPreflight,
} = require("../scripts/migrar-reservas-plazos-v1");

const consoleLogOriginal = console.log;
test.before(() => {
  console.log = () => {};
});
test.after(() => {
  console.log = consoleLogOriginal;
});

function columnaModalidad(overrides = {}) {
  return {
    DATA_TYPE: "enum",
    COLUMN_TYPE: "enum('FECHA_LIBRE','BLOQUE','SORTEO','CONVENIO')",
    IS_NULLABLE: "NO",
    COLUMN_DEFAULT: "FECHA_LIBRE",
    EXTRA: "",
    CHARACTER_MAXIMUM_LENGTH: 11,
    CHARACTER_SET_NAME: "utf8mb4",
    COLLATION_NAME: "utf8mb4_0900_ai_ci",
    COLUMN_COMMENT: "",
    GENERATION_EXPRESSION: "",
    ...overrides,
  };
}

test("el plan de modalidad conserva el tipo real y solo endurece cuando hace falta", () => {
  const actual = evaluarColumnaModalidad(columnaModalidad());
  assert.equal(actual.requiereNotNull, false);
  assert.equal(actual.requiereDefault, false);
  assert.equal(
    evaluarColumnaModalidad(columnaModalidad({ COLUMN_DEFAULT: "fecha_libre" })).requiereDefault,
    true
  );

  const legacy = evaluarColumnaModalidad(columnaModalidad({
    IS_NULLABLE: "YES",
    COLUMN_DEFAULT: null,
    COLUMN_COMMENT: "modalidad de turismo",
  }));
  assert.equal(legacy.requiereNotNull, true);
  assert.equal(legacy.requiereDefault, true);
  assert.match(legacy.sqlModificar, /enum\('FECHA_LIBRE','BLOQUE','SORTEO','CONVENIO'\)/);
  assert.match(legacy.sqlModificar, /CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci/);
  assert.match(legacy.sqlModificar, /NOT NULL DEFAULT 'FECHA_LIBRE'/);
  assert.match(legacy.sqlModificar, /COMMENT 'modalidad de turismo'/);
});

test("el plan falla cerrado para tipos que no admiten FECHA_LIBRE", () => {
  assert.throws(
    () => evaluarColumnaModalidad(columnaModalidad({
      DATA_TYPE: "varchar",
      COLUMN_TYPE: "varchar(8)",
      CHARACTER_MAXIMUM_LENGTH: 8,
    })),
    /longitud suficiente/
  );
  assert.throws(
    () => evaluarColumnaModalidad(columnaModalidad({
      DATA_TYPE: "enum",
      COLUMN_TYPE: "enum('BLOQUE','SORTEO','CONVENIO')",
    })),
    /no admite FECHA_LIBRE/
  );
  assert.throws(
    () => evaluarColumnaModalidad(columnaModalidad({
      GENERATION_EXPRESSION: "UPPER(origen)",
      EXTRA: "STORED GENERATED",
    })),
    /columna generada/
  );
});

test("la normalizacion es repetible y verifica que no queden NULL o vacios", async () => {
  const consultas = [];
  const connection = {
    async query(sql) {
      consultas.push(sql);
      if (sql.includes("UPDATE reserva")) return [{ affectedRows: 2 }];
      if (sql.includes("COUNT(*) AS total")) {
        return [[{ total: 4, nulas: 0, vacias: 0, desconocidas: 0 }]];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };

  const actualizadas = await normalizarModalidadLegacy(
    connection,
    { nulas: 1, vacias: 1 },
    { checkOnly: false }
  );
  assert.equal(actualizadas, 2);
  assert.match(consultas[0], /SET modalidad = 'FECHA_LIBRE'/);
  assert.match(consultas[0], /modalidad IS NULL/);
  assert.match(consultas[0], /TRIM\(CAST\(modalidad AS CHAR\)\) = ''/);

  consultas.length = 0;
  await normalizarModalidadLegacy(connection, { nulas: 0, vacias: 0 }, { checkOnly: false });
  assert.match(consultas[0], /UPDATE reserva/);
});

test("check-only informa pero no normaliza ni altera el esquema", async () => {
  const connection = {
    async query(sql) {
      throw new Error(`No debio escribir: ${sql}`);
    },
  };
  assert.equal(
    await normalizarModalidadLegacy(connection, { nulas: 2, vacias: 1 }, { checkOnly: true }),
    3
  );
  assert.equal(
    await asegurarEsquemaModalidad(
      connection,
      columnaModalidad({ IS_NULLABLE: "YES", COLUMN_DEFAULT: null }),
      { checkOnly: true }
    ),
    true
  );
});

test("el endurecimiento revalida NOT NULL y default despues del ALTER", async () => {
  const consultas = [];
  const connection = {
    async query(sql) {
      consultas.push(sql);
      if (sql.startsWith("ALTER TABLE")) return [{ affectedRows: 0 }];
      if (sql.includes("information_schema.COLUMNS")) return [[columnaModalidad()]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };

  assert.equal(
    await asegurarEsquemaModalidad(
      connection,
      columnaModalidad({ IS_NULLABLE: "YES", COLUMN_DEFAULT: null })
    ),
    true
  );
  assert.match(consultas[0], /MODIFY COLUMN `modalidad`/);
  assert.match(consultas[0], /NOT NULL DEFAULT 'FECHA_LIBRE'/);
});

test("el preflight cuenta duplicados usando NULL/vacio como FECHA_LIBRE", async () => {
  const consultas = [];
  const tablas = new Set(["reserva", "estado_reserva", "reserva_convenio_propuesta"]);
  const connection = {
    async query(sql, params = []) {
      consultas.push({ sql, params });
      if (sql.includes("information_schema.TABLES")) {
        return [[{ total: tablas.has(params[0]) ? 1 : 0 }]];
      }
      if (sql.includes("FROM estado_reserva")) {
        return [[
          { nombre: "Iniciada", total: 1 },
          { nombre: "Rechazada", total: 1 },
          { nombre: "Propuesta convenio", total: 1 },
          { nombre: "Convenio rechazado", total: 1 },
        ]];
      }
      if (sql.includes("information_schema.COLUMNS")) return [[columnaModalidad()]];
      if (sql.includes("HAVING COUNT(*) > 1")) return [[]];
      if (sql.includes("COUNT(*) AS total") && sql.includes("FROM reserva")) {
        return [[{ total: 10, nulas: 0, vacias: 0, desconocidas: 0 }]];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };

  await validarPreflight(connection);
  const duplicadosSql = consultas.find(({ sql }) => sql.includes("HAVING COUNT(*) > 1"))?.sql;
  assert.ok(duplicadosSql);
  assert.match(
    duplicadosSql,
    /COALESCE\(NULLIF\(UPPER\(TRIM\(CAST\(r\.modalidad AS CHAR\)\)\), ''\), 'FECHA_LIBRE'\)/
  );
});
