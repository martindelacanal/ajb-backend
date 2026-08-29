"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MIGRATION_ID = "20260829_turismo_reserva_holds_v1";
const MIGRATION_REVISION = 1;
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;
const CONFIRMACION_APPLY = "APLICAR_TURISMO_HOLDS";
const TABLE_NAME = "turismo_reserva_hold";

const TABLE_DEFINITION = {
  table: TABLE_NAME,
  engine: "InnoDB",
  columns: [
    ["id", "bigint unsigned", "NO"],
    ["token_hash", "binary(32)", "NO"],
    ["actor_usuario_id", "int", "NO"],
    ["titular_usuario_id", "int", "YES"],
    ["servicio_id", "int", "NO"],
    ["recurso_id", "int", "NO"],
    ["bloque_fecha_id", "int", "YES"],
    ["modalidad", "enum('FECHA_LIBRE','BLOQUE')", "NO"],
    ["fecha_inicio", "date", "NO"],
    ["fecha_fin", "date", "NO"],
    ["numero_parcela", "int", "YES"],
    ["estado", "enum('ACTIVO','CONSUMIDO','LIBERADO','VENCIDO')", "NO"],
    ["vence_en", "datetime(6)", "NO"],
    ["reserva_id", "int", "YES"],
    ["fecha_creacion", "datetime(6)", "NO"],
    ["fecha_modificacion", "datetime(6)", "NO"],
    ["fecha_cierre", "datetime(6)", "YES"],
    ["actor_activo_id", "int", "YES"],
  ],
  indexes: {
    PRIMARY: { unique: true, columns: ["id"] },
    uq_trh_token_hash: { unique: true, columns: ["token_hash"] },
    uq_trh_actor_activo: { unique: true, columns: ["actor_activo_id"] },
    idx_trh_actor_estado: { unique: false, columns: ["actor_usuario_id", "estado", "vence_en"] },
    idx_trh_servicio: { unique: false, columns: ["servicio_id"] },
    idx_trh_recurso_rango: {
      unique: false,
      columns: ["recurso_id", "estado", "vence_en", "fecha_inicio", "fecha_fin"],
    },
    idx_trh_bloque_recurso: {
      unique: false,
      columns: ["bloque_fecha_id", "recurso_id", "estado", "vence_en"],
    },
    idx_trh_expiracion: { unique: false, columns: ["estado", "vence_en"] },
    idx_trh_reserva: { unique: false, columns: ["reserva_id"] },
    idx_trh_titular: { unique: false, columns: ["titular_usuario_id", "estado", "vence_en"] },
  },
  foreignKeys: {
    fk_trh_actor: ["actor_usuario_id", "usuario", "id", "RESTRICT"],
    fk_trh_titular: ["titular_usuario_id", "usuario", "id", "SET NULL"],
    fk_trh_servicio: ["servicio_id", "servicio", "id", "RESTRICT"],
    fk_trh_recurso: ["recurso_id", "recurso", "id", "RESTRICT"],
    fk_trh_bloque: ["bloque_fecha_id", "bloque_fecha", "id", "RESTRICT"],
    fk_trh_reserva: ["reserva_id", "reserva", "id", "RESTRICT"],
  },
  checks: {
    chk_trh_fechas: "fecha_inicio < fecha_fin",
    chk_trh_parcela: "numero_parcela IS NULL OR numero_parcela > 0",
    chk_trh_modalidad_bloque:
      "(modalidad = 'FECHA_LIBRE' AND bloque_fecha_id IS NULL) OR (modalidad = 'BLOQUE' AND bloque_fecha_id IS NOT NULL)",
    chk_trh_consumido_reserva: "estado <> 'CONSUMIDO' OR reserva_id IS NOT NULL",
  },
};

const CREATE_TABLE_SQL = `
  CREATE TABLE turismo_reserva_hold (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    token_hash BINARY(32) NOT NULL,
    actor_usuario_id INT NOT NULL,
    titular_usuario_id INT NULL,
    servicio_id INT NOT NULL,
    recurso_id INT NOT NULL,
    bloque_fecha_id INT NULL,
    modalidad ENUM('FECHA_LIBRE','BLOQUE') NOT NULL,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE NOT NULL,
    numero_parcela INT NULL,
    estado ENUM('ACTIVO','CONSUMIDO','LIBERADO','VENCIDO') NOT NULL DEFAULT 'ACTIVO',
    vence_en DATETIME(6) NOT NULL,
    reserva_id INT NULL,
    fecha_creacion DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    fecha_modificacion DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    fecha_cierre DATETIME(6) NULL,
    actor_activo_id INT GENERATED ALWAYS AS (
      CASE WHEN estado = 'ACTIVO' THEN actor_usuario_id ELSE NULL END
    ) STORED,
    PRIMARY KEY (id),
    UNIQUE KEY uq_trh_token_hash (token_hash),
    UNIQUE KEY uq_trh_actor_activo (actor_activo_id),
    KEY idx_trh_actor_estado (actor_usuario_id, estado, vence_en),
    KEY idx_trh_servicio (servicio_id),
    KEY idx_trh_recurso_rango (recurso_id, estado, vence_en, fecha_inicio, fecha_fin),
    KEY idx_trh_bloque_recurso (bloque_fecha_id, recurso_id, estado, vence_en),
    KEY idx_trh_expiracion (estado, vence_en),
    KEY idx_trh_reserva (reserva_id),
    KEY idx_trh_titular (titular_usuario_id, estado, vence_en),
    CONSTRAINT fk_trh_actor FOREIGN KEY (actor_usuario_id) REFERENCES usuario (id) ON DELETE RESTRICT,
    CONSTRAINT fk_trh_titular FOREIGN KEY (titular_usuario_id) REFERENCES usuario (id) ON DELETE SET NULL,
    CONSTRAINT fk_trh_servicio FOREIGN KEY (servicio_id) REFERENCES servicio (id) ON DELETE RESTRICT,
    CONSTRAINT fk_trh_recurso FOREIGN KEY (recurso_id) REFERENCES recurso (id) ON DELETE RESTRICT,
    CONSTRAINT fk_trh_bloque FOREIGN KEY (bloque_fecha_id) REFERENCES bloque_fecha (id) ON DELETE RESTRICT,
    CONSTRAINT fk_trh_reserva FOREIGN KEY (reserva_id) REFERENCES reserva (id) ON DELETE RESTRICT,
    CONSTRAINT chk_trh_fechas CHECK (fecha_inicio < fecha_fin),
    CONSTRAINT chk_trh_parcela CHECK (numero_parcela IS NULL OR numero_parcela > 0),
    CONSTRAINT chk_trh_modalidad_bloque CHECK (
      (modalidad = 'FECHA_LIBRE' AND bloque_fecha_id IS NULL)
      OR (modalidad = 'BLOQUE' AND bloque_fecha_id IS NOT NULL)
    ),
    CONSTRAINT chk_trh_consumido_reserva CHECK (estado <> 'CONSUMIDO' OR reserva_id IS NOT NULL)
  ) ENGINE=InnoDB
`;

const MIGRATION_CHECKSUM = crypto
  .createHash("sha256")
  .update(JSON.stringify({ revision: MIGRATION_REVISION, definition: TABLE_DEFINITION, ddl: CREATE_TABLE_SQL.trim() }))
  .digest("hex");

function parsearArgumentos(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const apply = argv.includes("--apply");
  if (check === apply) {
    throw new Error("Indica exactamente uno de --check o --apply");
  }

  const confirmacion = argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length) || null;
  return {
    checkOnly: check,
    apply,
    allowProduction: argv.includes("--allow-production"),
    confirmacion,
  };
}

function esHostLocal(host) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(host || "").trim().toLowerCase());
}

function validarApplySeguro(opciones, env = process.env) {
  const remoto = !esHostLocal(env.DB_HOST);
  const produccion = String(env.NODE_ENV || "").trim().toLowerCase() === "production";
  if (!remoto && !produccion) return;

  if (opciones.apply && !opciones.allowProduction) {
    throw new Error("Una base remota o de produccion exige --allow-production");
  }
  if (opciones.apply && opciones.confirmacion !== CONFIRMACION_APPLY) {
    throw new Error(`Confirma la migracion con --confirm=${CONFIRMACION_APPLY}`);
  }
  if (String(env.DB_SSL_MODE || "").trim().toLowerCase() !== "verify-full") {
    throw new Error("Una migracion remota o de produccion exige DB_SSL_MODE=verify-full");
  }
  const caPath = String(env.DB_SSL_CA_PATH || "").trim();
  if (!caPath || !fs.existsSync(caPath)) {
    throw new Error("Una migracion remota o de produccion exige un DB_SSL_CA_PATH existente");
  }
}

async function existeTabla(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME, ENGINE
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      LIMIT 1`,
    [tabla]
  );
  return rows[0] || null;
}

async function validarPreflight(connection) {
  for (const tabla of ["usuario", "servicio", "recurso", "reserva", "bloque_fecha"]) {
    const existente = await existeTabla(connection, tabla);
    if (!existente) throw new Error(`Falta la tabla requerida ${tabla}`);
    if (String(existente.ENGINE || "").toUpperCase() !== "INNODB") {
      throw new Error(`La tabla ${tabla} debe usar InnoDB`);
    }
    const [columnasId] = await connection.query(
      `SELECT COLUMN_TYPE
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'id'
        LIMIT 1`,
      [tabla]
    );
    if (String(columnasId[0]?.COLUMN_TYPE || "").toLowerCase() !== "int") {
      throw new Error(`${tabla}.id debe ser INT para crear sus foreign keys sin conversiones`);
    }
  }
}

async function obtenerEsquemaTabla(connection) {
  const tabla = await existeTabla(connection, TABLE_NAME);
  if (!tabla) return null;

  const [columns] = await connection.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, GENERATION_EXPRESSION
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [TABLE_NAME]
  );
  const [indexes] = await connection.query(
    `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [TABLE_NAME]
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
    [TABLE_NAME]
  );
  const [checks] = await connection.query(
    `SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
       FROM information_schema.TABLE_CONSTRAINTS tc
       INNER JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = ?
        AND tc.CONSTRAINT_TYPE = 'CHECK'
      ORDER BY tc.CONSTRAINT_NAME`,
    [TABLE_NAME]
  );

  return { tabla, columns, indexes, foreignKeys, checks };
}

function compactarSql(sql) {
  return String(sql || "")
    .replace(/`/g, "")
    .replace(/_[a-z0-9]+(?=')/gi, "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function validarEsquemaExacto(esquema) {
  if (!esquema) throw new Error(`Falta la tabla ${TABLE_NAME}`);
  if (String(esquema.tabla.ENGINE || "").toUpperCase() !== "INNODB") {
    throw new Error(`${TABLE_NAME} debe usar InnoDB`);
  }

  const columnasEsperadas = new Map(TABLE_DEFINITION.columns.map(([nombre, tipo, nullable]) => [
    nombre,
    { tipo: tipo.toLowerCase(), nullable },
  ]));
  if (esquema.columns.length !== columnasEsperadas.size) {
    throw new Error(`${TABLE_NAME} tiene una cantidad de columnas incompatible`);
  }
  for (const columna of esquema.columns) {
    const esperada = columnasEsperadas.get(columna.COLUMN_NAME);
    if (!esperada) throw new Error(`Columna inesperada ${TABLE_NAME}.${columna.COLUMN_NAME}`);
    if (String(columna.COLUMN_TYPE || "").toLowerCase() !== esperada.tipo) {
      throw new Error(`Tipo incompatible en ${TABLE_NAME}.${columna.COLUMN_NAME}`);
    }
    if (String(columna.IS_NULLABLE || "").toUpperCase() !== esperada.nullable) {
      throw new Error(`Nullable incompatible en ${TABLE_NAME}.${columna.COLUMN_NAME}`);
    }
  }
  const actorActivo = esquema.columns.find((column) => column.COLUMN_NAME === "actor_activo_id");
  if (!actorActivo || !/generated/i.test(String(actorActivo.EXTRA || ""))) {
    throw new Error("actor_activo_id debe ser una columna generada");
  }
  const expresionActorActivo = compactarSql(actorActivo.GENERATION_EXPRESSION);
  if (
    !expresionActorActivo.includes("estado = 'activo'") ||
    !expresionActorActivo.includes("actor_usuario_id")
  ) {
    throw new Error("actor_activo_id no implementa la unicidad condicional de ACTIVO");
  }
  const id = esquema.columns.find((column) => column.COLUMN_NAME === "id");
  const estado = esquema.columns.find((column) => column.COLUMN_NAME === "estado");
  const creada = esquema.columns.find((column) => column.COLUMN_NAME === "fecha_creacion");
  const modificada = esquema.columns.find((column) => column.COLUMN_NAME === "fecha_modificacion");
  if (!/auto_increment/i.test(String(id?.EXTRA || ""))) throw new Error("id debe ser AUTO_INCREMENT");
  if (String(estado?.COLUMN_DEFAULT || "").toUpperCase() !== "ACTIVO") {
    throw new Error("estado debe tener default ACTIVO");
  }
  if (!/current_timestamp\(6\)/i.test(String(creada?.COLUMN_DEFAULT || ""))) {
    throw new Error("fecha_creacion debe usar CURRENT_TIMESTAMP(6)");
  }
  if (
    !/current_timestamp\(6\)/i.test(String(modificada?.COLUMN_DEFAULT || "")) ||
    !/on update current_timestamp\(6\)/i.test(String(modificada?.EXTRA || ""))
  ) {
    throw new Error("fecha_modificacion debe actualizarse con CURRENT_TIMESTAMP(6)");
  }

  const indicesActuales = new Map();
  for (const indice of esquema.indexes) {
    if (!indicesActuales.has(indice.INDEX_NAME)) {
      indicesActuales.set(indice.INDEX_NAME, {
        unique: Number(indice.NON_UNIQUE) === 0,
        columns: [],
      });
    }
    indicesActuales.get(indice.INDEX_NAME).columns.push(indice.COLUMN_NAME);
  }
  for (const [nombre, esperado] of Object.entries(TABLE_DEFINITION.indexes)) {
    const actual = indicesActuales.get(nombre);
    if (!actual || actual.unique !== esperado.unique || actual.columns.join(",") !== esperado.columns.join(",")) {
      throw new Error(`Indice incompatible o faltante ${TABLE_NAME}.${nombre}`);
    }
  }
  if (indicesActuales.size !== Object.keys(TABLE_DEFINITION.indexes).length) {
    throw new Error(`${TABLE_NAME} tiene indices inesperados`);
  }

  const fksActuales = new Map(esquema.foreignKeys.map((fk) => [
    fk.CONSTRAINT_NAME,
    [fk.COLUMN_NAME, fk.REFERENCED_TABLE_NAME, fk.REFERENCED_COLUMN_NAME, fk.DELETE_RULE],
  ]));
  for (const [nombre, esperado] of Object.entries(TABLE_DEFINITION.foreignKeys)) {
    const actual = fksActuales.get(nombre);
    if (!actual || actual.join("|") !== esperado.join("|")) {
      throw new Error(`Foreign key incompatible o faltante ${TABLE_NAME}.${nombre}`);
    }
  }
  if (fksActuales.size !== Object.keys(TABLE_DEFINITION.foreignKeys).length) {
    throw new Error(`${TABLE_NAME} tiene foreign keys inesperadas`);
  }

  const checksActuales = new Map(esquema.checks.map((check) => [
    check.CONSTRAINT_NAME,
    compactarSql(check.CHECK_CLAUSE),
  ]));
  for (const [nombre, expresion] of Object.entries(TABLE_DEFINITION.checks)) {
    const actual = checksActuales.get(nombre);
    if (!actual || actual !== compactarSql(expresion)) {
      throw new Error(`Check incompatible o faltante ${TABLE_NAME}.${nombre}`);
    }
  }
  if (checksActuales.size !== Object.keys(TABLE_DEFINITION.checks).length) {
    throw new Error(`${TABLE_NAME} tiene checks inesperados`);
  }
}

async function asegurarRegistroMigraciones(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ajb_schema_migration (
      migration_id VARCHAR(100) NOT NULL,
      checksum CHAR(64) NOT NULL,
      revision INT UNSIGNED NOT NULL DEFAULT 1,
      estado ENUM('APLICANDO','APLICADA','FALLIDA') NOT NULL,
      etapa VARCHAR(100) DEFAULT NULL,
      detalle TEXT DEFAULT NULL,
      trigger_definer VARCHAR(255) NOT NULL DEFAULT '',
      trigger_sql_mode TEXT NOT NULL DEFAULT (''),
      iniciada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      finalizada_en DATETIME DEFAULT NULL,
      PRIMARY KEY (migration_id)
    ) ENGINE=InnoDB
  `);
  const [rows] = await connection.query(
    "SELECT checksum FROM ajb_schema_migration WHERE migration_id = ?",
    [MIGRATION_ID]
  );
  if (rows.length > 0 && rows[0].checksum !== MIGRATION_CHECKSUM) {
    throw new Error(`La migracion ${MIGRATION_ID} ya fue registrada con otro checksum`);
  }
  await connection.query(
    `INSERT INTO ajb_schema_migration
       (migration_id, checksum, revision, estado, etapa, detalle, trigger_definer, trigger_sql_mode)
     VALUES (?, ?, ?, 'APLICANDO', 'tabla_holds', NULL, '', '')
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision), estado = 'APLICANDO', etapa = 'tabla_holds',
       detalle = NULL, finalizada_en = NULL`,
    [MIGRATION_ID, MIGRATION_CHECKSUM, MIGRATION_REVISION]
  );
}

async function marcarMigracion(connection, estado, detalle = null) {
  await connection.query(
    `UPDATE ajb_schema_migration
        SET estado = ?, etapa = ?, detalle = ?,
            finalizada_en = CASE WHEN ? = 'APLICADA' THEN NOW() ELSE NULL END
      WHERE migration_id = ?`,
    [estado, estado === "APLICADA" ? "completa" : "tabla_holds", detalle, estado, MIGRATION_ID]
  );
}

async function ejecutarMigracion(connection, { checkOnly }) {
  await validarPreflight(connection);
  const esquemaInicial = await obtenerEsquemaTabla(connection);
  if (esquemaInicial) {
    validarEsquemaExacto(esquemaInicial);
    console.log(`[OK] ${TABLE_NAME} ya existe con el contrato esperado`);
    return { created: false };
  }
  if (checkOnly) {
    console.log(`[PENDIENTE] crear ${TABLE_NAME}`);
    return { created: true };
  }
  await connection.query(CREATE_TABLE_SQL);
  validarEsquemaExacto(await obtenerEsquemaTabla(connection));
  console.log(`[CREADA] ${TABLE_NAME}`);
  return { created: true };
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  validarApplySeguro(opciones);
  const mysqlConnection = require("../api/connection/connection");
  const connection = await mysqlConnection.promise().getConnection();
  let lockTomado = false;
  let migracionRegistrada = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 10) AS adquirido", [MIGRATION_LOCK]);
    lockTomado = Number(locks[0]?.adquirido) === 1;
    if (!lockTomado) throw new Error("No se pudo obtener el lock de migracion");

    if (!opciones.checkOnly) {
      await asegurarRegistroMigraciones(connection);
      migracionRegistrada = true;
    }
    await ejecutarMigracion(connection, opciones);
    if (migracionRegistrada) await marcarMigracion(connection, "APLICADA");
    console.log(opciones.checkOnly
      ? "Chequeo de holds de Turismo completado sin cambios."
      : "Migracion de holds de Turismo completada.");
  } catch (error) {
    if (migracionRegistrada) {
      try {
        await marcarMigracion(connection, "FALLIDA", String(error.message || error).slice(0, 2000));
      } catch (_) {
        // Se conserva el error original.
      }
    }
    throw error;
  } finally {
    if (lockTomado) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]);
      } catch (_) {
        // Cerrar la conexion tambien libera el advisory lock.
      }
    }
    connection.release();
    await mysqlConnection.promise().end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error en migracion de holds de Turismo:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMACION_APPLY,
  CREATE_TABLE_SQL,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  TABLE_DEFINITION,
  TABLE_NAME,
  compactarSql,
  ejecutarMigracion,
  parsearArgumentos,
  validarApplySeguro,
  validarEsquemaExacto,
};
