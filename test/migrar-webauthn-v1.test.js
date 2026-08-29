"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONFIRMACION_APPLY,
  ESQUEMAS,
  obtenerEntornos,
  parsearArgumentos,
  parsearBloquesEnv,
  validarApplySeguro,
  validarEsquemaTabla,
} = require("../scripts/migrar-webauthn-v1");

function bloqueDb(nombre, extras = "") {
  return `
# ${nombre}
DB_HOST=db.example.test
DB_USER=migrator
DB_PASSWORD=secret
DB_DATABASE=ajb
DB_PORT=3306
${extras}
`;
}

function crearEsquemaIdeal(tabla) {
  const esperado = ESQUEMAS[tabla];
  const columns = Object.entries(esperado.columns).map(([
    COLUMN_NAME,
    [COLUMN_TYPE, IS_NULLABLE, CHARACTER_SET_NAME = null, COLLATION_NAME = null],
  ]) => ({
    COLUMN_NAME,
    COLUMN_TYPE,
    IS_NULLABLE,
    CHARACTER_SET_NAME,
    COLLATION_NAME,
  }));
  const indexes = Object.entries(esperado.indexes).flatMap(
    ([INDEX_NAME, [unique, nombresColumnas]]) => nombresColumnas.map((COLUMN_NAME, index) => ({
      INDEX_NAME,
      NON_UNIQUE: unique ? 0 : 1,
      COLUMN_NAME,
      SEQ_IN_INDEX: index + 1,
    }))
  );
  const foreignKeys = Object.entries(esperado.foreignKeys).map(
    ([CONSTRAINT_NAME, [COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, DELETE_RULE]]) => ({
      CONSTRAINT_NAME,
      COLUMN_NAME,
      REFERENCED_TABLE_NAME,
      REFERENCED_COLUMN_NAME,
      DELETE_RULE,
    })
  );
  const checks = esperado.checks.map((CONSTRAINT_NAME) => ({ CONSTRAINT_NAME }));

  return {
    engine: "InnoDB",
    tableCollation: esperado.tableCollation,
    columns,
    indexes,
    foreignKeys,
    checks,
  };
}

function clonar(valor) {
  return JSON.parse(JSON.stringify(valor));
}

test("parsea por separado el bloque activo de produccion y el comentado de develop", () => {
  const bloques = parsearBloquesEnv(`
VARIABLE_AJENA=ignorada
# PRODUCCION (RDS)
DB_HOST=prod-db.internal
DB_USER=prod_user
DB_PASSWORD="prod password"
DB_DATABASE=ajb_prod
DB_PORT=3306
DB_SSL_MODE=verify-full
DB_SSL_CA_PATH="C:/certificados/prod ca.pem"

# DEVELOP (MySQL local) - descomentar para usar
# DB_HOST=127.0.0.1
# DB_USER=dev_user
# DB_PASSWORD='dev password'
# DB_DATABASE=ajb_dev
# DB_PORT=3307
# DB_SSL_MODE=disabled
`);

  assert.deepEqual(bloques.production, {
    DB_HOST: "prod-db.internal",
    DB_USER: "prod_user",
    DB_PASSWORD: "prod password",
    DB_DATABASE: "ajb_prod",
    DB_PORT: "3306",
    DB_SSL_MODE: "verify-full",
    DB_SSL_CA_PATH: "C:/certificados/prod ca.pem",
  });
  assert.deepEqual(bloques.develop, {
    DB_HOST: "127.0.0.1",
    DB_USER: "dev_user",
    DB_PASSWORD: "dev password",
    DB_DATABASE: "ajb_dev",
    DB_PORT: "3307",
    DB_SSL_MODE: "disabled",
  });
});

test("sin argumentos queda en check de develop y nunca habilita apply implicitamente", () => {
  const opciones = parsearArgumentos([]);

  assert.equal(opciones.apply, false);
  assert.equal(opciones.checkOnly, true);
  assert.equal(opciones.target, "develop");
  assert.equal(opciones.allowProduction, false);
  assert.equal(opciones.confirmacion, null);

  assert.equal(parsearArgumentos(["--check", "--target=all"]).checkOnly, true);
  assert.throws(
    () => parsearArgumentos(["--apply", "--check"]),
    /--check o --apply, no ambos/
  );
  assert.throws(
    () => parsearArgumentos(["--target=staging"]),
    /develop, production o all/
  );
});

test("apply exige la confirmacion exacta antes de permitir cualquier entorno", () => {
  const develop = [{ nombre: "develop", config: {} }];

  assert.throws(
    () => validarApplySeguro(parsearArgumentos(["--apply"]), develop),
    new RegExp(`--confirm=${CONFIRMACION_APPLY}`)
  );
  assert.throws(
    () => validarApplySeguro(
      parsearArgumentos(["--apply", "--confirm=aplicar_webauthn"]),
      develop
    ),
    new RegExp(`--confirm=${CONFIRMACION_APPLY}`)
  );
  assert.doesNotThrow(() => validarApplySeguro(
    parsearArgumentos(["--apply", `--confirm=${CONFIRMACION_APPLY}`]),
    develop
  ));
});

test("production requiere un opt-in adicional tanto en check como en apply", () => {
  const production = [{ nombre: "production", config: {} }];
  const todos = [{ nombre: "develop", config: {} }, ...production];

  assert.throws(
    () => validarApplySeguro(
      parsearArgumentos(["--apply", "--target=production", `--confirm=${CONFIRMACION_APPLY}`]),
      production
    ),
    /--allow-production/
  );
  assert.throws(
    () => validarApplySeguro(
      parsearArgumentos(["--apply", "--target=all", `--confirm=${CONFIRMACION_APPLY}`]),
      todos
    ),
    /--allow-production/
  );
  assert.doesNotThrow(() => validarApplySeguro(
    parsearArgumentos([
      "--apply",
      "--target=production",
      `--confirm=${CONFIRMACION_APPLY}`,
      "--allow-production",
    ]),
    production
  ));
  assert.throws(
    () => validarApplySeguro(parsearArgumentos(["--target=production"]), production),
    /--allow-production/
  );
  assert.doesNotThrow(() => validarApplySeguro(
    parsearArgumentos(["--target=production", "--allow-production"]),
    production
  ));
});

test("production falla cerrado si no configura TLS verify-full y CA", () => {
  const opciones = parsearArgumentos([
    "--target=production",
    "--allow-production",
  ]);

  assert.throws(
    () => obtenerEntornos(opciones, bloqueDb("PRODUCCION"), {}),
    /DB_SSL_MODE=verify-full/
  );
  assert.throws(
    () => obtenerEntornos(
      opciones,
      bloqueDb("PRODUCCION", "DB_SSL_MODE=verify-full"),
      {}
    ),
    /DB_SSL_CA_PATH/
  );
  assert.doesNotThrow(() => obtenerEntornos(
    opciones,
    bloqueDb(
      "PRODUCCION",
      "DB_SSL_MODE=verify-full\nDB_SSL_CA_PATH=C:/certificados/rds.pem"
    ),
    {}
  ));
});

test("permite override de TLS sin reemplazar credenciales del bloque", () => {
  const opciones = parsearArgumentos([
    "--target=production",
    "--allow-production",
  ]);
  const [entorno] = obtenerEntornos(
    opciones,
    bloqueDb("PRODUCCION"),
    {
      DB_SSL_MODE: "verify-full",
      DB_SSL_CA_PATH: "C:/temp/rds-ca.pem",
      DB_USER: "usuario-que-no-debe-aplicarse",
      DB_PASSWORD: "secreto-que-no-debe-aplicarse",
    }
  );

  assert.equal(entorno.config.DB_SSL_MODE, "verify-full");
  assert.equal(entorno.config.DB_SSL_CA_PATH, "C:/temp/rds-ca.pem");
  assert.equal(entorno.config.DB_USER, "migrator");
  assert.equal(entorno.config.DB_PASSWORD, "secret");
});

test("acepta el esquema ideal de ambas tablas WebAuthn", () => {
  for (const tabla of Object.keys(ESQUEMAS)) {
    assert.doesNotThrow(() => validarEsquemaTabla(tabla, crearEsquemaIdeal(tabla)));
  }
});

test("rechaza tablas ausentes y acumula divergencias estructurales", () => {
  assert.throws(
    () => validarEsquemaTabla("webauthn_credencial", null),
    /Falta la tabla webauthn_credencial/
  );

  const esquema = clonar(crearEsquemaIdeal("webauthn_credencial"));
  esquema.engine = "MyISAM";
  esquema.tableCollation = "utf8mb4_0900_ai_ci";
  esquema.columns = esquema.columns.filter(({ COLUMN_NAME }) => COLUMN_NAME !== "clave_publica");
  esquema.columns.find(({ COLUMN_NAME }) => COLUMN_NAME === "contador").COLUMN_TYPE = "int unsigned";
  esquema.columns.find(({ COLUMN_NAME }) => COLUMN_NAME === "nombre").IS_NULLABLE = "YES";
  esquema.indexes = esquema.indexes.filter(({ INDEX_NAME }) => INDEX_NAME !== "idx_wac_usuario_rp");
  esquema.foreignKeys[0].DELETE_RULE = "RESTRICT";
  esquema.checks = [];

  assert.throws(
    () => validarEsquemaTabla("webauthn_credencial", esquema),
    (error) => {
      assert.match(error.message, /ENGINE no es InnoDB/);
      assert.match(error.message, /collation de tabla utf8mb4_0900_ai_ci/);
      assert.match(error.message, /falta columna clave_publica/);
      assert.match(error.message, /contador tiene tipo int unsigned/);
      assert.match(error.message, /nombre tiene nulabilidad YES/);
      assert.match(error.message, /indice idx_wac_usuario_rp invalido o ausente/);
      assert.match(error.message, /foreign key fk_wac_usuario invalida o ausente/);
      assert.match(error.message, /check chk_wac_respaldada ausente/);
      return true;
    }
  );
});

test("rechaza collations case-insensitive en identificadores WebAuthn", () => {
  const esquema = clonar(crearEsquemaIdeal("webauthn_credencial"));
  const credentialId = esquema.columns.find(({ COLUMN_NAME }) => COLUMN_NAME === "credential_id");
  credentialId.COLLATION_NAME = "ascii_general_ci";

  assert.throws(
    () => validarEsquemaTabla("webauthn_credencial", esquema),
    /credential_id tiene collation ascii_general_ci/
  );
});

test("valida orden y unicidad exactos de indices", () => {
  const esquema = clonar(crearEsquemaIdeal("webauthn_desafio"));
  const indice = esquema.indexes.filter(({ INDEX_NAME }) => INDEX_NAME === "uq_wad_rp_challenge");
  indice.reverse();
  indice.forEach((row, index) => {
    row.SEQ_IN_INDEX = index + 1;
    row.NON_UNIQUE = 1;
  });
  esquema.indexes = esquema.indexes.filter(({ INDEX_NAME }) => INDEX_NAME !== "uq_wad_rp_challenge");
  esquema.indexes.push(...indice);

  assert.throws(
    () => validarEsquemaTabla("webauthn_desafio", esquema),
    /indice uq_wad_rp_challenge invalido o ausente/
  );
});
