"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

const MIGRATION_ID = "20260829_webauthn_v1";
const MIGRATION_REVISION = 1;
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;
const CONFIRMACION_APPLY = "APLICAR_WEBAUTHN";
const TARGETS = new Set(["develop", "production", "all"]);

const CREATE_CREDENCIAL_SQL = `
  CREATE TABLE IF NOT EXISTS webauthn_credencial (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    usuario_id INT NOT NULL,
    rp_id VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    webauthn_usuario_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    credential_id VARCHAR(1400) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    clave_publica BLOB NOT NULL,
    contador BIGINT UNSIGNED NOT NULL DEFAULT 0,
    tipo_dispositivo VARCHAR(32) NOT NULL,
    respaldada TINYINT(1) NOT NULL DEFAULT 0,
    transportes JSON NULL,
    nombre VARCHAR(100) NOT NULL DEFAULT 'Clave de acceso',
    fecha_creacion DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    fecha_ultimo_uso DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_wac_rp_credential (rp_id, credential_id),
    KEY idx_wac_usuario_rp (usuario_id, rp_id, fecha_creacion),
    CONSTRAINT fk_wac_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE CASCADE,
    CONSTRAINT chk_wac_respaldada CHECK (respaldada IN (0, 1))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
`;

const CREATE_DESAFIO_SQL = `
  CREATE TABLE IF NOT EXISTS webauthn_desafio (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tipo ENUM('REGISTRO','AUTENTICACION') NOT NULL,
    usuario_id INT NULL,
    challenge VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    webauthn_usuario_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
    origen VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    rp_id VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recordar TINYINT(1) NOT NULL DEFAULT 0,
    vence_en DATETIME(6) NOT NULL,
    consumido_en DATETIME(6) NULL,
    fecha_creacion DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_wad_rp_challenge (rp_id, challenge),
    KEY idx_wad_vencimiento (vence_en, consumido_en),
    KEY idx_wad_usuario_tipo (usuario_id, tipo, vence_en),
    CONSTRAINT fk_wad_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE CASCADE,
    CONSTRAINT chk_wad_recordar CHECK (recordar IN (0, 1)),
    CONSTRAINT chk_wad_tipo_usuario CHECK (
      (tipo = 'REGISTRO' AND usuario_id IS NOT NULL AND webauthn_usuario_id IS NOT NULL)
      OR
      (tipo = 'AUTENTICACION' AND usuario_id IS NULL AND webauthn_usuario_id IS NULL)
    )
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
`;

const CREATE_MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ajb_schema_migration (
    migration_id VARCHAR(100) NOT NULL,
    checksum CHAR(64) NOT NULL,
    revision INT UNSIGNED NOT NULL,
    estado ENUM('APLICANDO','APLICADA','FALLIDA') NOT NULL,
    etapa VARCHAR(100) NULL,
    detalle TEXT NULL,
    trigger_definer VARCHAR(255) NOT NULL DEFAULT '',
    trigger_sql_mode TEXT NOT NULL,
    iniciada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    finalizada_en DATETIME NULL,
    PRIMARY KEY (migration_id)
  ) ENGINE=InnoDB
`;

const MIGRATION_CHECKSUM = crypto
  .createHash("sha256")
  .update(JSON.stringify({
    id: MIGRATION_ID,
    revision: MIGRATION_REVISION,
    credencial: CREATE_CREDENCIAL_SQL.trim(),
    desafio: CREATE_DESAFIO_SQL.trim(),
  }))
  .digest("hex");

const ESQUEMAS = {
  webauthn_credencial: {
    tableCollation: "utf8mb4_unicode_ci",
    columns: {
      id: ["bigint unsigned", "NO"],
      usuario_id: ["int", "NO"],
      rp_id: ["varchar(253)", "NO", "ascii", "ascii_bin"],
      webauthn_usuario_id: ["varchar(255)", "NO", "ascii", "ascii_bin"],
      credential_id: ["varchar(1400)", "NO", "ascii", "ascii_bin"],
      clave_publica: ["blob", "NO"],
      contador: ["bigint unsigned", "NO"],
      tipo_dispositivo: ["varchar(32)", "NO"],
      respaldada: ["tinyint(1)", "NO"],
      transportes: ["json", "YES"],
      nombre: ["varchar(100)", "NO", "utf8mb4", "utf8mb4_unicode_ci"],
      fecha_creacion: ["datetime(6)", "NO"],
      fecha_ultimo_uso: ["datetime(6)", "YES"],
    },
    indexes: {
      PRIMARY: [true, ["id"]],
      uq_wac_rp_credential: [true, ["rp_id", "credential_id"]],
      idx_wac_usuario_rp: [false, ["usuario_id", "rp_id", "fecha_creacion"]],
    },
    foreignKeys: {
      fk_wac_usuario: ["usuario_id", "usuario", "id", "CASCADE"],
    },
    checks: ["chk_wac_respaldada"],
  },
  webauthn_desafio: {
    tableCollation: "utf8mb4_unicode_ci",
    columns: {
      id: ["char(36)", "NO", "ascii", "ascii_bin"],
      tipo: ["enum('REGISTRO','AUTENTICACION')", "NO"],
      usuario_id: ["int", "YES"],
      challenge: ["varchar(255)", "NO", "ascii", "ascii_bin"],
      webauthn_usuario_id: ["varchar(255)", "YES", "ascii", "ascii_bin"],
      origen: ["varchar(512)", "NO", "ascii", "ascii_bin"],
      rp_id: ["varchar(253)", "NO", "ascii", "ascii_bin"],
      recordar: ["tinyint(1)", "NO"],
      vence_en: ["datetime(6)", "NO"],
      consumido_en: ["datetime(6)", "YES"],
      fecha_creacion: ["datetime(6)", "NO"],
    },
    indexes: {
      PRIMARY: [true, ["id"]],
      uq_wad_rp_challenge: [true, ["rp_id", "challenge"]],
      idx_wad_vencimiento: [false, ["vence_en", "consumido_en"]],
      idx_wad_usuario_tipo: [false, ["usuario_id", "tipo", "vence_en"]],
    },
    foreignKeys: {
      fk_wad_usuario: ["usuario_id", "usuario", "id", "CASCADE"],
    },
    checks: ["chk_wad_recordar", "chk_wad_tipo_usuario"],
  },
};

function parsearArgumentos(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const check = argv.includes("--check");
  if (apply && check) throw new Error("Indica --check o --apply, no ambos");

  const target = argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
    || "develop";
  if (!TARGETS.has(target)) throw new Error("--target debe ser develop, production o all");

  return {
    apply,
    checkOnly: !apply,
    target,
    allowProduction: argv.includes("--allow-production"),
    confirmacion: argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length) || null,
    envFile: argv.find((arg) => arg.startsWith("--env-file="))?.slice("--env-file=".length)
      || path.resolve(__dirname, "..", ".env"),
  };
}

function parsearValorEnv(nombre, valor) {
  const parsed = dotenv.parse(Buffer.from(`${nombre}=${valor}`));
  return parsed[nombre] ?? "";
}

function parsearBloquesEnv(contenido) {
  const bloques = { develop: {}, production: {} };
  let bloque = null;
  for (const linea of String(contenido || "").split(/\r?\n/)) {
    if (/^\s*#\s*PRODUCCION\b/i.test(linea)) {
      bloque = "production";
      continue;
    }
    if (/^\s*#\s*DEVELOP\b/i.test(linea)) {
      bloque = "develop";
      continue;
    }
    if (!bloque) continue;

    const match = /^\s*(?:#\s*)?(DB_HOST|DB_USER|DB_PASSWORD|DB_DATABASE|DB_PORT|DB_SSL_MODE|DB_SSL_CA_PATH)\s*=\s*(.*)$/.exec(linea);
    if (!match) continue;
    bloques[bloque][match[1]] = parsearValorEnv(match[1], match[2]);
  }
  return bloques;
}

function validarConfiguracionEntorno(nombre, config) {
  const faltantes = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE", "DB_PORT"]
    .filter((campo) => !String(config?.[campo] || "").trim());
  if (faltantes.length) {
    throw new Error(`El bloque ${nombre} no contiene todos los campos DB requeridos`);
  }
  if (nombre === "production") {
    if (String(config.DB_SSL_MODE || "").trim().toLowerCase() !== "verify-full") {
      throw new Error("El bloque production exige DB_SSL_MODE=verify-full");
    }
    if (!String(config.DB_SSL_CA_PATH || "").trim()) {
      throw new Error("El bloque production exige DB_SSL_CA_PATH");
    }
  }
}

function obtenerEntornos(opciones, contenidoEnv, overridesTls = process.env) {
  const bloques = parsearBloquesEnv(contenidoEnv);
  const nombres = opciones.target === "all" ? ["develop", "production"] : [opciones.target];
  return nombres.map((nombre) => {
    const config = { ...bloques[nombre] };
    for (const campo of ["DB_SSL_MODE", "DB_SSL_CA_PATH"]) {
      if (String(overridesTls?.[campo] || "").trim()) config[campo] = overridesTls[campo];
    }
    validarConfiguracionEntorno(nombre, config);
    return { nombre, config };
  });
}

function validarApplySeguro(opciones, entornos) {
  if (entornos.some(({ nombre }) => nombre === "production") && !opciones.allowProduction) {
    throw new Error("Acceder a production exige --allow-production");
  }
  if (!opciones.apply) return;
  if (opciones.confirmacion !== CONFIRMACION_APPLY) {
    throw new Error(`Confirma la migracion con --confirm=${CONFIRMACION_APPLY}`);
  }
}

function crearOpcionesConexion(config) {
  const modoTls = String(config.DB_SSL_MODE || "disabled").trim().toLowerCase();
  if (!["disabled", "verify-ca", "verify-full"].includes(modoTls)) {
    throw new Error("DB_SSL_MODE debe ser disabled, verify-ca o verify-full");
  }
  let ssl;
  if (modoTls !== "disabled") {
    const caPath = String(config.DB_SSL_CA_PATH || "").trim();
    if (!caPath || !fs.existsSync(caPath)) {
      throw new Error("DB_SSL_CA_PATH es requerido cuando TLS esta habilitado");
    }
    ssl = { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
  }
  return {
    host: config.DB_HOST,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_DATABASE,
    port: Number(config.DB_PORT),
    ssl,
    timezone: "-03:00",
    dateStrings: ["DATE"],
    multipleStatements: false,
  };
}

async function validarPreflight(connection) {
  const [tablas] = await connection.query(
    `SELECT ENGINE
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuario'
      LIMIT 1`
  );
  if (!tablas.length || String(tablas[0].ENGINE).toUpperCase() !== "INNODB") {
    throw new Error("Falta la tabla usuario InnoDB");
  }
  const [columnas] = await connection.query(
    `SELECT COLUMN_TYPE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuario' AND COLUMN_NAME = 'id'
      LIMIT 1`
  );
  if (String(columnas[0]?.COLUMN_TYPE || "").toLowerCase() !== "int") {
    throw new Error("usuario.id debe ser INT");
  }
}

async function obtenerEsquemaTabla(connection, tabla) {
  const [tableRows] = await connection.query(
    `SELECT ENGINE, TABLE_COLLATION
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      LIMIT 1`,
    [tabla]
  );
  if (!tableRows.length) return null;
  const [columns] = await connection.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
            CHARACTER_SET_NAME, COLLATION_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [tabla]
  );
  const [indexes] = await connection.query(
    `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [tabla]
  );
  const [foreignKeys] = await connection.query(
    `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME,
            k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.CONSTRAINT_SCHEMA = DATABASE()
        AND k.TABLE_NAME = ?
        AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.CONSTRAINT_NAME`,
    [tabla]
  );
  const [checks] = await connection.query(
    `SELECT tc.CONSTRAINT_NAME
       FROM information_schema.TABLE_CONSTRAINTS tc
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = ?
        AND tc.CONSTRAINT_TYPE = 'CHECK'
      ORDER BY tc.CONSTRAINT_NAME`,
    [tabla]
  );
  return {
    engine: tableRows[0].ENGINE,
    tableCollation: tableRows[0].TABLE_COLLATION,
    columns,
    indexes,
    foreignKeys,
    checks,
  };
}

function agruparIndices(rows) {
  const indices = {};
  for (const row of rows) {
    if (!indices[row.INDEX_NAME]) {
      indices[row.INDEX_NAME] = { unique: Number(row.NON_UNIQUE) === 0, columns: [] };
    }
    indices[row.INDEX_NAME].columns.push(row.COLUMN_NAME);
  }
  return indices;
}

function validarEsquemaTabla(tabla, esquema, esperado = ESQUEMAS[tabla]) {
  if (!esquema) throw new Error(`Falta la tabla ${tabla}`);
  const errores = [];
  if (String(esquema.engine).toUpperCase() !== "INNODB") errores.push("ENGINE no es InnoDB");
  if (String(esquema.tableCollation).toLowerCase() !== esperado.tableCollation.toLowerCase()) {
    errores.push(`collation de tabla ${esquema.tableCollation || "ausente"}`);
  }

  const columnas = new Map(esquema.columns.map((row) => [row.COLUMN_NAME, row]));
  for (const [nombre, [tipo, nullable, charset, collation]] of Object.entries(esperado.columns)) {
    const actual = columnas.get(nombre);
    if (!actual) {
      errores.push(`falta columna ${nombre}`);
      continue;
    }
    if (String(actual.COLUMN_TYPE).toLowerCase() !== tipo.toLowerCase()) {
      errores.push(`${nombre} tiene tipo ${actual.COLUMN_TYPE}`);
    }
    if (actual.IS_NULLABLE !== nullable) errores.push(`${nombre} tiene nulabilidad ${actual.IS_NULLABLE}`);
    if (charset && String(actual.CHARACTER_SET_NAME).toLowerCase() !== charset.toLowerCase()) {
      errores.push(`${nombre} tiene charset ${actual.CHARACTER_SET_NAME || "ausente"}`);
    }
    if (collation && String(actual.COLLATION_NAME).toLowerCase() !== collation.toLowerCase()) {
      errores.push(`${nombre} tiene collation ${actual.COLLATION_NAME || "ausente"}`);
    }
  }

  const indices = agruparIndices(esquema.indexes);
  for (const [nombre, [unique, columns]] of Object.entries(esperado.indexes)) {
    const actual = indices[nombre];
    if (!actual || actual.unique !== unique || actual.columns.join(",") !== columns.join(",")) {
      errores.push(`indice ${nombre} invalido o ausente`);
    }
  }

  const foreignKeys = new Map(esquema.foreignKeys.map((row) => [row.CONSTRAINT_NAME, row]));
  for (const [nombre, [columna, refTabla, refColumna, deleteRule]] of Object.entries(esperado.foreignKeys)) {
    const actual = foreignKeys.get(nombre);
    if (
      !actual
      || actual.COLUMN_NAME !== columna
      || actual.REFERENCED_TABLE_NAME !== refTabla
      || actual.REFERENCED_COLUMN_NAME !== refColumna
      || actual.DELETE_RULE !== deleteRule
    ) {
      errores.push(`foreign key ${nombre} invalida o ausente`);
    }
  }

  const checks = new Set(esquema.checks.map((row) => row.CONSTRAINT_NAME));
  for (const nombre of esperado.checks) {
    if (!checks.has(nombre)) errores.push(`check ${nombre} ausente`);
  }
  if (errores.length) throw new Error(`${tabla}: ${errores.join("; ")}`);
}

async function verificarEsquema(connection) {
  for (const tabla of Object.keys(ESQUEMAS)) {
    validarEsquemaTabla(tabla, await obtenerEsquemaTabla(connection, tabla));
  }
}

async function registrarInicio(connection) {
  await connection.query(CREATE_MIGRATION_TABLE_SQL);
  const [existentes] = await connection.query(
    `SELECT checksum, revision, estado
       FROM ajb_schema_migration
      WHERE migration_id = ?
      LIMIT 1`,
    [MIGRATION_ID]
  );
  if (existentes.length && existentes[0].checksum !== MIGRATION_CHECKSUM) {
    throw new Error("La migracion existente tiene un checksum diferente");
  }
  await connection.query(
    `INSERT INTO ajb_schema_migration
       (migration_id, checksum, revision, estado, etapa, detalle, trigger_definer, trigger_sql_mode)
     VALUES (?, ?, ?, 'APLICANDO', 'creando_tablas', NULL, '', '')
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision), estado = 'APLICANDO', etapa = 'creando_tablas',
       detalle = NULL, finalizada_en = NULL`,
    [MIGRATION_ID, MIGRATION_CHECKSUM, MIGRATION_REVISION]
  );
}

async function marcarResultado(connection, estado, etapa, detalle = null) {
  await connection.query(
    `UPDATE ajb_schema_migration
        SET estado = ?, etapa = ?, detalle = ?,
            finalizada_en = CASE WHEN ? = 'APLICADA' THEN NOW() ELSE finalizada_en END
      WHERE migration_id = ?`,
    [estado, etapa, detalle, estado, MIGRATION_ID]
  );
}

async function ejecutarEnEntorno(entorno, opciones) {
  let connection;
  let lockTomado = false;
  let registroIniciado = false;
  try {
    connection = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    await validarPreflight(connection);
    if (opciones.checkOnly) {
      await verificarEsquema(connection);
      console.log(`[webauthn] ${entorno.nombre}: esquema verificado`);
      return;
    }

    const [lockRows] = await connection.query("SELECT GET_LOCK(?, 15) AS tomado", [MIGRATION_LOCK]);
    if (Number(lockRows[0]?.tomado) !== 1) throw new Error("No se pudo obtener el lock de migracion");
    lockTomado = true;
    await registrarInicio(connection);
    registroIniciado = true;
    await connection.query(CREATE_CREDENCIAL_SQL);
    await connection.query(CREATE_DESAFIO_SQL);
    await verificarEsquema(connection);
    await marcarResultado(connection, "APLICADA", "completa");
    console.log(`[webauthn] ${entorno.nombre}: migracion aplicada y verificada`);
  } catch (error) {
    if (connection && opciones.apply && lockTomado && registroIniciado) {
      try {
        await marcarResultado(connection, "FALLIDA", "error", String(error.message || error).slice(0, 2000));
      } catch (_markError) {
        // La tabla de control puede no existir si fallo el preflight.
      }
    }
    throw error;
  } finally {
    if (connection && lockTomado) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]);
      } catch (_lockError) {
        // Cerrar la conexion tambien libera el lock.
      }
    }
    if (connection) await connection.end();
  }
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  const contenidoEnv = fs.readFileSync(opciones.envFile, "utf8");
  const entornos = obtenerEntornos(opciones, contenidoEnv);
  validarApplySeguro(opciones, entornos);
  console.log(`[webauthn] modo=${opciones.checkOnly ? "check" : "apply"}; target=${opciones.target}`);
  for (const entorno of entornos) {
    await ejecutarEnEntorno(entorno, opciones);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[webauthn] fallo: ${error?.code || error?.message || "error desconocido"}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMACION_APPLY,
  CREATE_CREDENCIAL_SQL,
  CREATE_DESAFIO_SQL,
  ESQUEMAS,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  crearOpcionesConexion,
  obtenerEntornos,
  parsearArgumentos,
  parsearBloquesEnv,
  validarApplySeguro,
  validarEsquemaTabla,
};
