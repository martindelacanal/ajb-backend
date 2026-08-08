#!/usr/bin/env node
"use strict";

/**
 * Migración idempotente de integridad monetaria e histórica.
 *
 * Es dry-run por defecto. Para aplicar:
 *   node scripts/migrar-integridad-financiera.js \
 *     --apply --confirm=APLICAR_INTEGRIDAD_FINANCIERA
 *
 * En NODE_ENV=production también exige --allow-production.
 * La DDL de MySQL hace commits implícitos: cada etapa se registra y es
 * reanudable mediante introspección; no se simula atomicidad inexistente.
 */

const {
  ACTIVE_RECEIPT_SQL,
  CANONICAL_CUIT_SQL,
  CANONICAL_NUMBER_SQL,
  CANONICAL_PTO_SQL,
  MIGRATION_ID,
  MIGRATION_LOCK,
  MIGRATION_CHECKSUM,
  MIGRATION_REVISION,
  MIGRATION_STAGES,
  activeReceiptSql,
  canonicalizeCheck,
  canonicalizeSql,
  checkInfo,
  columnInfo,
  createConnection,
  indexInfo,
  parseArguments,
  queryOne,
  redactError,
  runDataPreflight,
  tableExists,
  triggerInfo,
} = require("./integridad-financiera-common");

const CONFIRMATION = "APLICAR_INTEGRIDAD_FINANCIERA";
let verificationOnly = false;
let verificationTriggerContext = null;
let loggingEnabled = true;

function quoteIdentifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`Identificador SQL inválido: ${value}`);
  return `\`${value}\``;
}

function logAction(mode, message) {
  if (!loggingEnabled) return;
  console.log(`[${mode ? "APPLY" : "DRY-RUN"}] ${message}`);
}

function normalizeSqlMode(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

function quoteDefiner(definer) {
  const match = String(definer || "").match(/^([^@]+)@(.+)$/);
  if (!match) throw new Error("DB_TRIGGER_DEFINER debe tener formato usuario@host");
  const escape = (value) => `\`${String(value).replace(/`/g, "``")}\``;
  return `${escape(match[1])}@${escape(match[2])}`;
}

async function triggerContext(connection) {
  const context = await queryOne(
    connection,
    "SELECT CURRENT_USER() AS trigger_user, @@SESSION.sql_mode AS sql_mode"
  );
  const configured = String(process.env.DB_TRIGGER_DEFINER || "").trim();
  return {
    definer: configured || String(context.trigger_user),
    definerSql: configured ? quoteDefiner(configured) : "CURRENT_USER",
    sqlMode: String(context.sql_mode || ""),
  };
}

function triggerActionFromCreate(sql) {
  const match = String(sql).match(/FOR\s+EACH\s+ROW\s+([\s\S]+)$/i);
  if (!match) throw new Error("No se pudo extraer ACTION_STATEMENT del trigger");
  return match[1].trim();
}

async function executeOrPlan(connection, apply, description, sql, params = []) {
  logAction(apply, description);
  if (!apply) {
    if (verificationOnly) throw new Error(`Falta objeto o contrato: ${description}`);
    return null;
  }
  return connection.query(sql, params);
}

function defaultClause(info, nullable) {
  if (info.COLUMN_DEFAULT === null || info.COLUMN_DEFAULT === undefined) {
    return nullable ? " DEFAULT NULL" : "";
  }
  const value = String(info.COLUMN_DEFAULT);
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return ` DEFAULT ${value}`;
  if (/^(?:CURRENT_TIMESTAMP(?:\(\d+\))?|NULL)$/i.test(value)) return ` DEFAULT ${value}`;
  return ` DEFAULT '${value.replace(/'/g, "''")}'`;
}

async function ensureColumnContract(
  connection,
  apply,
  table,
  column,
  { type = null, notNull = null, allowedDataTypes = null } = {}
) {
  const info = await columnInfo(connection, table, column);
  if (!info) throw new Error(`No existe ${table}.${column}`);
  const currentType = String(info.COLUMN_TYPE).toLowerCase();
  const targetType = String(type || info.COLUMN_TYPE).toLowerCase();
  if (
    allowedDataTypes &&
    !new Set(allowedDataTypes.map((item) => item.toLowerCase())).has(
      String(info.DATA_TYPE).toLowerCase()
    )
  ) {
    throw new Error(`Tipo inesperado en ${table}.${column}: ${info.COLUMN_TYPE}`);
  }
  const targetNullable =
    notNull === true ? false : notNull === false ? true : info.IS_NULLABLE === "YES";
  if (currentType === targetType && (info.IS_NULLABLE === "NO") === !targetNullable) {
    logAction(apply, `${table}.${column} ya cumple ${targetType.toUpperCase()} ${targetNullable ? "NULL" : "NOT NULL"}`);
    return;
  }
  const nullableSql = targetNullable ? "NULL" : "NOT NULL";
  await executeOrPlan(
    connection,
    apply,
    `Alinear ${table}.${column}: ${info.COLUMN_TYPE} ${info.IS_NULLABLE} -> ${targetType.toUpperCase()} ${nullableSql}`,
    `ALTER TABLE ${quoteIdentifier(table)} MODIFY COLUMN ${quoteIdentifier(column)} ${targetType} ${nullableSql}${defaultClause(info, targetNullable)}`
  );
}

async function ensureDecimalColumn(connection, apply, table, column, notNull = true) {
  return ensureColumnContract(connection, apply, table, column, {
    type: "decimal(12,2)",
    notNull,
    allowedDataTypes: ["float", "double", "decimal"],
  });
}

async function ensureColumn(connection, apply, table, column, definition, validation = {}) {
  const info = await columnInfo(connection, table, column);
  if (info) {
    if (validation.type && String(info.COLUMN_TYPE).toLowerCase() !== validation.type.toLowerCase()) {
      throw new Error(
        `La columna ${table}.${column} existe con tipo incompatible: ${info.COLUMN_TYPE}`
      );
    }
    if (validation.notNull === true && info.IS_NULLABLE !== "NO") {
      throw new Error(`La columna ${table}.${column} debe ser NOT NULL`);
    }
    if (validation.generated) {
      const generated = String(info.GENERATION_EXPRESSION || "")
        .replace(/`|\s|_utf8mb4/g, "")
        .toLowerCase();
      const fragments = Array.isArray(validation.generated)
        ? validation.generated
        : [validation.generated];
      if (
        fragments.some(
          (fragment) =>
            !generated.includes(
              String(fragment).replace(/`|\s|_utf8mb4/g, "").toLowerCase()
            )
        )
      ) {
        throw new Error(`La expresión generada de ${table}.${column} no coincide`);
      }
    }
    logAction(apply, `La columna ${table}.${column} ya existe`);
    return;
  }
  await executeOrPlan(
    connection,
    apply,
    `Agregar columna ${table}.${column}`,
    `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`
  );
}

async function ensureIndex(connection, apply, table, name, columns, unique = false) {
  const existing = await indexInfo(connection, table, name);
  if (existing.length > 0) {
    const existingColumns = existing.map((row) => row.COLUMN_NAME || row.EXPRESSION);
    const existingUnique = Number(existing[0].NON_UNIQUE) === 0;
    if (
      existingUnique !== unique ||
      existingColumns.length !== columns.length ||
      existingColumns.some((column, index) => column !== columns[index]) ||
      existing.some(
        (row) =>
          row.SUB_PART !== null ||
          row.COLLATION !== "A" ||
          row.INDEX_TYPE !== "BTREE" ||
          row.IS_VISIBLE !== "YES"
      )
    ) {
      throw new Error(`El índice ${table}.${name} existe con una definición incompatible`);
    }
    logAction(apply, `El índice ${table}.${name} ya existe`);
    return;
  }
  const isPrimary = name === "PRIMARY";
  const uniqueSql = unique ? "UNIQUE " : "";
  const addSql = isPrimary
    ? `PRIMARY KEY (${columns.map(quoteIdentifier).join(", ")})`
    : `${uniqueSql}INDEX ${quoteIdentifier(name)} (${columns.map(quoteIdentifier).join(", ")})`;
  await executeOrPlan(
    connection,
    apply,
    `Agregar ${isPrimary ? "PRIMARY KEY" : unique ? "UNIQUE" : "INDEX"} ${table}.${name}`,
    `ALTER TABLE ${quoteIdentifier(table)} ADD ${addSql}`
  );
}

async function ensureCheck(connection, apply, table, name, expression) {
  const existing = await checkInfo(connection, name);
  if (existing) {
    if (
      existing.TABLE_NAME !== table ||
      existing.ENFORCED !== "YES" ||
      canonicalizeCheck(existing.CHECK_CLAUSE) !== canonicalizeCheck(expression)
    ) {
      throw new Error(`El CHECK ${name} existe con una definición incompatible`);
    }
    logAction(apply, `El CHECK ${name} ya existe y está aplicado`);
    return;
  }
  await executeOrPlan(
    connection,
    apply,
    `Agregar CHECK ${name}`,
    `ALTER TABLE ${quoteIdentifier(table)} ADD CONSTRAINT ${quoteIdentifier(name)} CHECK (${expression})`
  );
}

async function ensureTrigger(connection, apply, specification) {
  const context =
    specification.context || verificationTriggerContext || (await triggerContext(connection));
  const existing = await triggerInfo(connection, specification.name);
  const expectedAction = triggerActionFromCreate(specification.sql);
  if (existing) {
    if (
      existing.EVENT_OBJECT_TABLE !== specification.table ||
      existing.EVENT_MANIPULATION !== specification.event ||
      existing.ACTION_TIMING !== specification.timing ||
      String(existing.ACTION_ORIENTATION).toUpperCase() !== "ROW" ||
      canonicalizeSql(existing.ACTION_STATEMENT) !== canonicalizeSql(expectedAction) ||
      String(existing.DEFINER) !== context.definer ||
      normalizeSqlMode(existing.SQL_MODE) !== normalizeSqlMode(context.sqlMode)
    ) {
      throw new Error(`El trigger ${specification.name} existe con una definición incompatible`);
    }
    logAction(apply, `El trigger ${specification.name} ya existe`);
    return;
  }
  await executeOrPlan(
    connection,
    apply,
    `Crear trigger ${specification.name}`,
    specification.sql.replace(
      /CREATE\s+TRIGGER/i,
      `CREATE DEFINER = ${context.definerSql} TRIGGER`
    )
  );
}

async function ensureMigrationRegistry(connection) {
  const trigger = await triggerContext(connection);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ajb_schema_migration (
      migration_id VARCHAR(100) NOT NULL,
      checksum CHAR(64) NOT NULL,
      revision INT UNSIGNED NOT NULL DEFAULT ${MIGRATION_REVISION},
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

  await ensureColumn(
    connection,
    true,
    "ajb_schema_migration",
    "revision",
    `INT UNSIGNED NOT NULL DEFAULT ${MIGRATION_REVISION} AFTER checksum`,
    { type: "int unsigned", notNull: true }
  );
  await ensureColumn(
    connection,
    true,
    "ajb_schema_migration",
    "trigger_definer",
    "VARCHAR(255) NOT NULL DEFAULT '' AFTER detalle",
    { type: "varchar(255)", notNull: true }
  );
  await ensureColumn(
    connection,
    true,
    "ajb_schema_migration",
    "trigger_sql_mode",
    "TEXT NOT NULL DEFAULT ('') AFTER trigger_definer",
    { type: "text", notNull: true }
  );

  const [rows] = await connection.query(
    "SELECT checksum FROM ajb_schema_migration WHERE migration_id = ?",
    [MIGRATION_ID]
  );
  if (rows.length > 0 && rows[0].checksum !== MIGRATION_CHECKSUM) {
    throw new Error(
      `La migración ${MIGRATION_ID} ya fue registrada con otro checksum; no se continuará`
    );
  }
  await connection.query(
    `INSERT INTO ajb_schema_migration
       (migration_id, checksum, revision, estado, etapa, detalle, trigger_definer, trigger_sql_mode)
     VALUES (?, ?, ?, 'APLICANDO', 'preflight', NULL, ?, ?)
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision), estado = 'APLICANDO', etapa = 'preflight', detalle = NULL,
       trigger_definer = VALUES(trigger_definer), trigger_sql_mode = VALUES(trigger_sql_mode),
       finalizada_en = NULL`,
    [MIGRATION_ID, MIGRATION_CHECKSUM, MIGRATION_REVISION, trigger.definer, trigger.sqlMode]
  );
}

async function recordStage(connection, stage, detail = null) {
  await connection.query(
    `UPDATE ajb_schema_migration
        SET estado = 'APLICANDO', etapa = ?, detalle = ?
      WHERE migration_id = ?`,
    [stage, detail, MIGRATION_ID]
  );
}

async function markCompleted(connection) {
  await connection.query(
    `UPDATE ajb_schema_migration
        SET estado = 'APLICADA', etapa = 'completa', detalle = NULL, finalizada_en = NOW()
      WHERE migration_id = ?`,
    [MIGRATION_ID]
  );
}

async function markFailed(connection, stage, error) {
  if (!(await tableExists(connection, "ajb_schema_migration"))) return;
  const safe = redactError(error);
  await connection.query(
    `UPDATE ajb_schema_migration
        SET estado = 'FALLIDA', etapa = ?, detalle = ?
      WHERE migration_id = ?`,
    [stage, `${safe.code}: ${safe.message}`.slice(0, 2000), MIGRATION_ID]
  );
}

async function migrateMoneyTypes(connection, apply) {
  await ensureDecimalColumn(connection, apply, "reserva", "precio_total", false);
  for (const [table, column] of [
    ["reserva", "monto_adicionales"],
    ["reserva_familiar", "precio"],
    ["reserva_adicional", "subtotal"],
    ["reserva_adicional_detalle", "precio_unitario"],
    ["reserva_adicional_detalle", "subtotal"],
    ["tarifa", "precio"],
    ["tarifa_adicional", "precio"],
  ]) {
    await ensureDecimalColumn(connection, apply, table, column, true);
  }
  for (const [table, column] of [
    ["reserva", "fecha_inicio"],
    ["reserva", "fecha_fin"],
    ["reserva_familiar", "reserva_id"],
    ["reserva_familiar", "usuario_id"],
    ["reserva_familiar", "tipo_persona_id"],
    ["reserva_familiar_tarifa", "reserva_familiar_id"],
    ["reserva_familiar_tarifa", "fecha"],
    ["tarifa", "fecha_inicio"],
    ["tarifa", "fecha_fin"],
    ["temporada_tarifa", "fecha_inicio"],
    ["temporada_tarifa", "fecha_fin"],
  ]) {
    await ensureColumnContract(connection, apply, table, column, { notNull: true });
  }
  await ensureColumn(
    connection,
    apply,
    "coseguro_solicitud",
    "duplicado_forzado",
    "TINYINT(1) NOT NULL DEFAULT 0 AFTER verificacion",
    { type: "tinyint(1)", notNull: true }
  );
  if (apply) {
    const ptoS = prefixed(CANONICAL_PTO_SQL, "s", ["comprobante_pto_venta"]);
    const ptoO = prefixed(CANONICAL_PTO_SQL, "o", ["comprobante_pto_venta"]);
    const numberS = prefixed(CANONICAL_NUMBER_SQL, "s", ["comprobante_numero"]);
    const numberO = prefixed(CANONICAL_NUMBER_SQL, "o", ["comprobante_numero"]);
    const cuitS = prefixed(CANONICAL_CUIT_SQL, "s", ["emisor_cuit"]);
    const cuitO = prefixed(CANONICAL_CUIT_SQL, "o", ["emisor_cuit"]);
    await connection.query(`
      UPDATE coseguro_solicitud s
      INNER JOIN coseguro_solicitud o
        ON o.id <> s.id
       AND o.eliminado = 0 AND o.estado_id NOT IN (5, 6)
       AND ${ptoO} = ${ptoS}
       AND ${numberO} = ${numberS}
       AND (o.usuario_id = s.usuario_id OR
            (${cuitS} IS NOT NULL AND ${cuitO} = ${cuitS}))
         SET s.duplicado_forzado = 1
       WHERE s.duplicado_forzado = 0
         AND s.eliminado = 0 AND s.estado_id NOT IN (5, 6)
         AND COALESCE(JSON_EXTRACT(s.verificacion, '$.duplicados_forzados') = TRUE, FALSE)
    `);
  } else {
    logAction(false, "Marcar sólo excepciones legadas que aún tienen un comprobante realmente duplicado");
  }
}

async function migrateReservationArchive(connection, apply) {
  if (!(await tableExists(connection, "ajb_reserva_version_archivo"))) {
    await executeOrPlan(
      connection,
      apply,
      "Crear archivo append-only de versiones completas de reserva",
      `CREATE TABLE ajb_reserva_version_archivo (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        reserva_id INT NOT NULL,
        version_numero INT UNSIGNED NOT NULL,
        operacion VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        actor_usuario_id INT DEFAULT NULL,
        actor_rol VARCHAR(64) DEFAULT NULL,
        conexion_id BIGINT UNSIGNED NOT NULL,
        contenido_json JSON NOT NULL,
        contenido_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        creada_en DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_ajb_reserva_archivo_version (reserva_id, version_numero),
        CONSTRAINT ajb_chk_reserva_archivo_operacion
          CHECK (operacion IN ('EDICION','ELIMINACION','CORRECCION')),
        CONSTRAINT ajb_chk_reserva_archivo_sha
          CHECK (REGEXP_LIKE(contenido_sha256, '^[0-9a-f]{64}$'))
      ) ENGINE=InnoDB`
    );
  } else {
    logAction(apply, "La tabla ajb_reserva_version_archivo ya existe");
  }

  if (!(await tableExists(connection, "ajb_reserva_mutacion_guard"))) {
    await executeOrPlan(
      connection,
      apply,
      "Crear guardia transaccional para reemplazos de reserva",
      `CREATE TABLE ajb_reserva_mutacion_guard (
        conexion_id BIGINT UNSIGNED NOT NULL,
        reserva_id INT NOT NULL,
        guard_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        archivo_id BIGINT UNSIGNED NOT NULL,
        operacion VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        creada_en DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (conexion_id, reserva_id),
        UNIQUE KEY uq_ajb_reserva_guard_archivo (archivo_id),
        CONSTRAINT fk_ajb_reserva_guard_archivo FOREIGN KEY (archivo_id)
          REFERENCES ajb_reserva_version_archivo (id) ON DELETE RESTRICT,
        CONSTRAINT ajb_chk_reserva_guard_token
          CHECK (REGEXP_LIKE(guard_token, '^[0-9a-f]{64}$')),
        CONSTRAINT ajb_chk_reserva_guard_operacion
          CHECK (operacion IN ('EDICION','ELIMINACION','CORRECCION'))
      ) ENGINE=InnoDB`
    );
  } else {
    logAction(apply, "La tabla ajb_reserva_mutacion_guard ya existe");
  }

  if (apply || (await tableExists(connection, "ajb_reserva_version_archivo"))) {
    await ensureIndex(
      connection,
      apply,
      "ajb_reserva_version_archivo",
      "PRIMARY",
      ["id"],
      true
    );
    await ensureIndex(
      connection,
      apply,
      "ajb_reserva_version_archivo",
      "uq_ajb_reserva_archivo_version",
      ["reserva_id", "version_numero"],
      true
    );
    await ensureCheck(
      connection,
      apply,
      "ajb_reserva_version_archivo",
      "ajb_chk_reserva_archivo_operacion",
      "operacion IN ('EDICION','ELIMINACION','CORRECCION')"
    );
    await ensureCheck(
      connection,
      apply,
      "ajb_reserva_version_archivo",
      "ajb_chk_reserva_archivo_sha",
      "REGEXP_LIKE(contenido_sha256, '^[0-9a-f]{64}$')"
    );
  }
  if (apply || (await tableExists(connection, "ajb_reserva_mutacion_guard"))) {
    await ensureIndex(
      connection,
      apply,
      "ajb_reserva_mutacion_guard",
      "PRIMARY",
      ["conexion_id", "reserva_id"],
      true
    );
    await ensureIndex(
      connection,
      apply,
      "ajb_reserva_mutacion_guard",
      "uq_ajb_reserva_guard_archivo",
      ["archivo_id"],
      true
    );
    await ensureCheck(
      connection,
      apply,
      "ajb_reserva_mutacion_guard",
      "ajb_chk_reserva_guard_token",
      "REGEXP_LIKE(guard_token, '^[0-9a-f]{64}$')"
    );
    await ensureCheck(
      connection,
      apply,
      "ajb_reserva_mutacion_guard",
      "ajb_chk_reserva_guard_operacion",
      "operacion IN ('EDICION','ELIMINACION','CORRECCION')"
    );
  }

  const appendOnlyTriggers = [
    {
      name: "ajb_reserva_archivo_bu",
      table: "ajb_reserva_version_archivo",
      event: "UPDATE",
      timing: "BEFORE",
      sql: `CREATE TRIGGER ajb_reserva_archivo_bu
            BEFORE UPDATE ON ajb_reserva_version_archivo
            FOR EACH ROW BEGIN
              SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'El archivo de versiones de reserva es append-only';
            END`,
    },
    {
      name: "ajb_reserva_archivo_bd",
      table: "ajb_reserva_version_archivo",
      event: "DELETE",
      timing: "BEFORE",
      sql: `CREATE TRIGGER ajb_reserva_archivo_bd
            BEFORE DELETE ON ajb_reserva_version_archivo
            FOR EACH ROW BEGIN
              SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'El archivo de versiones de reserva es append-only';
            END`,
    },
  ];
  for (const specification of appendOnlyTriggers) {
    await ensureTrigger(connection, apply, specification);
  }

  const guardPredicate = (reservaExpression, operation = null) =>
    `EXISTS (SELECT 1 FROM ajb_reserva_mutacion_guard g
      WHERE g.conexion_id = CONNECTION_ID()
        AND g.reserva_id = ${reservaExpression}
        AND g.guard_token = @ajb_reserva_guard_token${
          operation ? ` AND g.operacion = '${operation}'` : ""
        })`;
  const deleteGuards = [
    {
      name: "ajb_rft_guard_bd",
      table: "reserva_familiar_tarifa",
      reserve: "(SELECT rf.reserva_id FROM reserva_familiar rf WHERE rf.id = OLD.reserva_familiar_id)",
    },
    { name: "ajb_rf_guard_bd", table: "reserva_familiar", reserve: "OLD.reserva_id" },
    {
      name: "ajb_rad_guard_bd",
      table: "reserva_adicional_detalle",
      reserve: "(SELECT ra.reserva_id FROM reserva_adicional ra WHERE ra.id = OLD.reserva_adicional_id)",
    },
    { name: "ajb_ra_guard_bd", table: "reserva_adicional", reserve: "OLD.reserva_id" },
  ];
  for (const item of deleteGuards) {
    await ensureTrigger(connection, apply, {
      name: item.name,
      table: item.table,
      event: "DELETE",
      timing: "BEFORE",
      sql: `CREATE TRIGGER ${item.name}
            BEFORE DELETE ON ${item.table}
            FOR EACH ROW BEGIN
              IF NOT (${guardPredicate(item.reserve)}) THEN
                SIGNAL SQLSTATE '45000'
                  SET MESSAGE_TEXT = 'Falta archivo transaccional previo de la reserva';
              END IF;
            END`,
    });
  }
  await ensureTrigger(connection, apply, {
    name: "ajb_reserva_guard_bd",
    table: "reserva",
    event: "DELETE",
    timing: "BEFORE",
    sql: `CREATE TRIGGER ajb_reserva_guard_bd
          BEFORE DELETE ON reserva
          FOR EACH ROW BEGIN
            IF NOT (${guardPredicate("OLD.id", "ELIMINACION")}) THEN
              SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Falta archivo transaccional previo a eliminar la reserva';
            END IF;
          END`,
  });
  await ensureTrigger(connection, apply, {
    name: "ajb_reserva_guard_bu",
    table: "reserva",
    event: "UPDATE",
    timing: "BEFORE",
    sql: `CREATE TRIGGER ajb_reserva_guard_bu
          BEFORE UPDATE ON reserva
          FOR EACH ROW BEGIN
            IF (NOT (NEW.precio_total <=> OLD.precio_total)
                OR NOT (NEW.monto_adicionales <=> OLD.monto_adicionales)
                OR NOT (NEW.fecha_inicio <=> OLD.fecha_inicio)
                OR NOT (NEW.fecha_fin <=> OLD.fecha_fin))
               AND NOT (${guardPredicate("OLD.id")}) THEN
              SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Falta archivo transaccional previo al cambio financiero de reserva';
            END IF;
          END`,
  });
  await ensureTrigger(connection, apply, {
    name: "ajb_rf_guard_bu",
    table: "reserva_familiar",
    event: "UPDATE",
    timing: "BEFORE",
    sql: `CREATE TRIGGER ajb_rf_guard_bu
          BEFORE UPDATE ON reserva_familiar
          FOR EACH ROW BEGIN
            IF NOT (NEW.precio <=> OLD.precio)
               AND NOT (${guardPredicate("OLD.reserva_id")}) THEN
              SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Falta archivo transaccional previo al cambio de precio familiar';
            END IF;
          END`,
  });
}

async function migrateSnapshots(connection, apply) {
  await ensureColumn(
    connection,
    apply,
    "reserva_familiar_tarifa",
    "tarifa_id_legacy",
    "INT NULL COMMENT 'ID original preservado aunque la tarifa haya sido eliminada' AFTER tarifa_id",
    { type: "int" }
  );
  await ensureColumn(
    connection,
    apply,
    "reserva_familiar_tarifa",
    "precio_aplicado",
    "DECIMAL(12,2) NULL COMMENT 'Snapshot inmutable del precio diario aplicado' AFTER fecha",
    { type: "decimal(12,2)" }
  );
  await ensureColumn(
    connection,
    apply,
    "reserva_familiar_tarifa",
    "usa_porcentaje_aplicado",
    "TINYINT(1) NULL COMMENT 'Snapshot de la modalidad de descuento' AFTER precio_aplicado",
    { type: "tinyint(1)" }
  );
  await ensureColumn(
    connection,
    apply,
    "reserva_familiar_tarifa",
    "porcentaje_descuento_aplicado",
    "DECIMAL(5,2) NULL COMMENT 'Snapshot del porcentaje aplicado' AFTER usa_porcentaje_aplicado",
    { type: "decimal(5,2)" }
  );
  await ensureColumn(
    connection,
    apply,
    "reserva_familiar_tarifa",
    "snapshot_estado",
    "ENUM('COMPLETO','LEGADO_SIN_SNAPSHOT','TARIFA_NO_RESUELTA') NOT NULL DEFAULT 'LEGADO_SIN_SNAPSHOT' AFTER porcentaje_descuento_aplicado",
    { type: "enum('COMPLETO','LEGADO_SIN_SNAPSHOT','TARIFA_NO_RESUELTA')" }
  );
  await ensureColumn(
    connection,
    apply,
    "reserva_familiar_tarifa",
    "snapshot_creado_en",
    "DATETIME NULL COMMENT 'Momento en que se fijó el snapshot' AFTER snapshot_estado",
    { type: "datetime" }
  );

  if (apply) {
    logAction(true, "Preservar IDs históricos sin inferir importes de tarifas mutables");
    await connection.beginTransaction();
    try {
      await connection.query(`
        UPDATE reserva_familiar_tarifa
           SET tarifa_id_legacy = tarifa_id
         WHERE tarifa_id_legacy IS NULL AND tarifa_id IS NOT NULL
      `);
      await connection.query(`
        UPDATE reserva_familiar_tarifa rft
        LEFT JOIN tarifa t ON t.id = rft.tarifa_id
           SET rft.snapshot_estado = 'TARIFA_NO_RESUELTA'
         WHERE rft.precio_aplicado IS NULL
           AND rft.tarifa_id IS NOT NULL
           AND t.id IS NULL
      `);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } else {
    logAction(false, "Preservar tarifa_id en tarifa_id_legacy; no inventar snapshots irresolubles");
    logAction(false, "Mantener snapshots heredados en NULL; el trigger completa sólo filas nuevas");
  }

  await ensureTrigger(connection, apply, {
    name: "ajb_rft_snapshot_bi",
    table: "reserva_familiar_tarifa",
    event: "INSERT",
    timing: "BEFORE",
    requiredFragments: [
      "SET NEW.tarifa_id_legacy",
      "SET NEW.precio_aplicado",
      "SET NEW.snapshot_estado",
      "SET NEW.snapshot_creado_en",
    ],
    sql: `
      CREATE TRIGGER ajb_rft_snapshot_bi
      BEFORE INSERT ON reserva_familiar_tarifa
      FOR EACH ROW
      BEGIN
        DECLARE v_precio DECIMAL(12,2) DEFAULT NULL;
        DECLARE v_usa_porcentaje TINYINT DEFAULT NULL;
        DECLARE v_porcentaje DECIMAL(5,2) DEFAULT NULL;
        DECLARE v_encontrada TINYINT DEFAULT 1;
        DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_encontrada = 0;

        IF NEW.tarifa_id IS NULL THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Una tarifa familiar nueva debe referenciar su tarifa fuente';
        END IF;
        SET NEW.tarifa_id_legacy = NEW.tarifa_id;
        IF NEW.tarifa_id IS NOT NULL THEN
          SELECT CAST(precio AS DECIMAL(12,2)), usa_porcentaje, porcentaje_descuento
            INTO v_precio, v_usa_porcentaje, v_porcentaje
            FROM tarifa WHERE id = NEW.tarifa_id LIMIT 1;
          IF v_encontrada = 1 THEN
            SET NEW.precio_aplicado = v_precio;
            SET NEW.usa_porcentaje_aplicado = v_usa_porcentaje;
            SET NEW.porcentaje_descuento_aplicado = v_porcentaje;
            SET NEW.snapshot_estado = 'COMPLETO';
            SET NEW.snapshot_creado_en = COALESCE(NEW.snapshot_creado_en, NOW());
          ELSE
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'No se puede crear un snapshot con una tarifa inexistente';
          END IF;
        END IF;
      END
    `,
  });

  await ensureTrigger(connection, apply, {
    name: "ajb_rft_snapshot_bu",
    table: "reserva_familiar_tarifa",
    event: "UPDATE",
    timing: "BEFORE",
    requiredFragments: ["SNAPSHOT HISTORICO", "NEW.PRECIO_APLICADO", "OLD.PRECIO_APLICADO"],
    sql: `
      CREATE TRIGGER ajb_rft_snapshot_bu
      BEFORE UPDATE ON reserva_familiar_tarifa
      FOR EACH ROW
      BEGIN
        IF NOT (NEW.reserva_familiar_id <=> OLD.reserva_familiar_id)
           OR NOT (NEW.tarifa_id <=> OLD.tarifa_id)
           OR NOT (NEW.tarifa_id_legacy <=> OLD.tarifa_id_legacy)
           OR NOT (NEW.fecha <=> OLD.fecha)
           OR NOT (NEW.precio_aplicado <=> OLD.precio_aplicado)
           OR NOT (NEW.usa_porcentaje_aplicado <=> OLD.usa_porcentaje_aplicado)
           OR NOT (NEW.porcentaje_descuento_aplicado <=> OLD.porcentaje_descuento_aplicado)
           OR NOT (NEW.snapshot_estado <=> OLD.snapshot_estado)
           OR NOT (NEW.snapshot_creado_en <=> OLD.snapshot_creado_en) THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'El snapshot historico de tarifa es inmutable';
        END IF;
      END
    `,
  });

  await ensureTrigger(connection, apply, {
    name: "ajb_tarifa_hist_bd",
    table: "tarifa",
    event: "DELETE",
    timing: "BEFORE",
    requiredFragments: ["RESERVA_FAMILIAR_TARIFA", "TARIFA_ID_LEGACY", "HISTORIAL"],
    sql: `
      CREATE TRIGGER ajb_tarifa_hist_bd
      BEFORE DELETE ON tarifa
      FOR EACH ROW
      BEGIN
        IF EXISTS (
          SELECT 1 FROM reserva_familiar_tarifa rft
           WHERE rft.tarifa_id = OLD.id OR rft.tarifa_id_legacy = OLD.id
        ) OR EXISTS (
          SELECT 1 FROM reserva_adicional_detalle rad WHERE rad.tarifa_id = OLD.id
        ) THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'No se puede eliminar una tarifa referenciada por historial';
        END IF;
      END
    `,
  });

  await ensureTrigger(connection, apply, {
    name: "ajb_tarifa_ad_hist_bd",
    table: "tarifa_adicional",
    event: "DELETE",
    timing: "BEFORE",
    requiredFragments: ["RESERVA_ADICIONAL_DETALLE", "TARIFA_ADICIONAL_ID", "HISTORIAL"],
    sql: `
      CREATE TRIGGER ajb_tarifa_ad_hist_bd
      BEFORE DELETE ON tarifa_adicional
      FOR EACH ROW
      BEGIN
        IF EXISTS (
          SELECT 1 FROM reserva_adicional_detalle rad
           WHERE rad.tarifa_adicional_id = OLD.id
        ) THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'No se puede eliminar una tarifa adicional referenciada por historial';
        END IF;
      END
    `,
  });

  // MySQL no ejecuta triggers de tablas hijas cuando el borrado ocurre por
  // una acción referencial CASCADE; por eso también se protege la cabecera.
  await ensureTrigger(connection, apply, {
    name: "ajb_temporada_hist_bd",
    table: "temporada_tarifa",
    event: "DELETE",
    timing: "BEFORE",
    requiredFragments: ["TARIFA_ID_LEGACY", "TARIFA_ADICIONAL_ID", "HISTORIAL"],
    sql: `
      CREATE TRIGGER ajb_temporada_hist_bd
      BEFORE DELETE ON temporada_tarifa
      FOR EACH ROW
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM tarifa t
            INNER JOIN reserva_familiar_tarifa rft
              ON rft.tarifa_id = t.id OR rft.tarifa_id_legacy = t.id
           WHERE t.temporada_tarifa_id = OLD.id
        ) OR EXISTS (
          SELECT 1
            FROM tarifa t
            INNER JOIN reserva_adicional_detalle rad ON rad.tarifa_id = t.id
           WHERE t.temporada_tarifa_id = OLD.id
        ) OR EXISTS (
          SELECT 1
            FROM tarifa_adicional ta
            INNER JOIN reserva_adicional_detalle rad ON rad.tarifa_adicional_id = ta.id
           WHERE ta.temporada_tarifa_id = OLD.id
        ) THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'No se puede eliminar una temporada referenciada por historial';
        END IF;
      END
    `,
  });
}

async function migrateChecks(connection, apply) {
  const checks = [
    ["reserva", "ajb_chk_reserva_importes", "(precio_total IS NULL OR precio_total >= 0) AND monto_adicionales >= 0"],
    ["reserva", "ajb_chk_reserva_fechas", "fecha_inicio < fecha_fin"],
    ["reserva", "ajb_chk_reserva_parcela", "numero_parcela IS NULL OR numero_parcela > 0"],
    ["reserva_familiar", "ajb_chk_rf_valores", "precio >= 0 AND (edad IS NULL OR edad BETWEEN 0 AND 130)"],
    ["reserva_familiar_tarifa", "ajb_chk_rft_snapshot", "(precio_aplicado IS NULL OR precio_aplicado >= 0) AND (porcentaje_descuento_aplicado IS NULL OR porcentaje_descuento_aplicado BETWEEN 0 AND 100) AND (snapshot_estado <> 'COMPLETO' OR (precio_aplicado IS NOT NULL AND snapshot_creado_en IS NOT NULL))"],
    ["reserva_adicional", "ajb_chk_ra_valores", "cantidad > 0 AND dias > 0 AND subtotal >= 0"],
    ["reserva_adicional_detalle", "ajb_chk_rad_valores", "cantidad > 0 AND precio_unitario >= 0 AND subtotal >= 0 AND (porcentaje_descuento IS NULL OR porcentaje_descuento BETWEEN 0 AND 100)"],
    ["tarifa", "ajb_chk_tarifa_valores", "precio >= 0 AND fecha_inicio <= fecha_fin AND (edad_minima IS NULL OR edad_minima BETWEEN 0 AND 130) AND (edad_maxima IS NULL OR edad_maxima BETWEEN 0 AND 130) AND (edad_minima IS NULL OR edad_maxima IS NULL OR edad_minima <= edad_maxima) AND (porcentaje_descuento IS NULL OR porcentaje_descuento BETWEEN 0 AND 100)"],
    ["tarifa_adicional", "ajb_chk_tarifa_adicional", "precio >= 0 AND fecha_inicio <= fecha_fin"],
    ["temporada_tarifa", "ajb_chk_temporada_fechas", "fecha_inicio <= fecha_fin"],
    ["temporada_tipo_persona_porcentaje", "ajb_chk_temporada_porcentaje", "porcentaje BETWEEN 0 AND 100"],
    ["coseguro_solicitud", "ajb_chk_coseguro_importes", "importe > 0 AND TRIM(comprobante_numero) <> '' AND (importe_estimado IS NULL OR importe_estimado >= 0) AND (importe_autorizado IS NULL OR importe_autorizado >= 0) AND (porcentaje_cobertura_aplicado IS NULL OR porcentaje_cobertura_aplicado BETWEEN 0 AND 100) AND (cantidad_sesiones IS NULL OR cantidad_sesiones > 0)"],
    ["coseguro_solicitud", "ajb_chk_coseguro_duplicado_forzado", "duplicado_forzado IN (0, 1)"],
    ["coseguro_tipo_reintegro", "ajb_chk_coseguro_config", "(porcentaje_cobertura IS NULL OR porcentaje_cobertura > 0 AND porcentaje_cobertura <= 100) AND (tope_reintegro IS NULL OR tope_reintegro > 0) AND (modo_cobertura <> 'PORCENTAJE' OR porcentaje_cobertura IS NOT NULL)"],
    ["reserva_salud", "ajb_chk_reserva_salud_importe", "precio_cubierto IS NULL OR precio_cubierto >= 0"],
    ["sorteo", "ajb_chk_sorteo_fechas", "fecha_inicio_inscripcion <= fecha_fin_inscripcion"],
    ["olimpiada", "ajb_chk_olimpiada_fechas", "fecha_inicio <= fecha_fin AND fecha_inicio_inscripcion <= fecha_fin_inscripcion AND fecha_fin_inscripcion <= fecha_inicio"],
    ["olimpiada_disciplina", "ajb_chk_olimpiada_disciplina", "max_por_departamental IS NULL OR max_por_departamental > 0"],
    ["olimpiada_disciplina_config", "ajb_chk_olimpiada_disciplina_cfg", "max_por_departamental IS NULL OR max_por_departamental > 0"],
  ];
  for (const [table, name, expression] of checks) {
    await ensureCheck(connection, apply, table, name, expression);
  }
}

async function migrateIndexes(connection, apply) {
  const indexes = [
    ["reserva_familiar", "uq_rf_reserva_usuario", ["reserva_id", "usuario_id"], true],
    ["reserva_familiar_tarifa", "uq_rft_familiar_fecha", ["reserva_familiar_id", "fecha"], true],
    ["reserva_adicional", "uq_ra_reserva_adicional", ["reserva_id", "adicional_id"], true],
    ["reserva_adicional_detalle", "uq_rad_adicional_fecha", ["reserva_adicional_id", "fecha"], true],
    ["servicio_regimen", "uq_servicio_regimen", ["servicio_id", "regimen_id"], true],
    ["reserva", "idx_reserva_disponibilidad_unidad", ["recurso_id", "numero_parcela", "fecha_inicio", "fecha_fin", "estado_reserva_id"], false],
    ["reserva", "idx_reserva_disponibilidad_recurso", ["recurso_id", "fecha_inicio", "fecha_fin", "estado_reserva_id"], false],
    ["tarifa", "idx_tarifa_cotizacion", ["recurso_id", "regimen_id", "tipo_persona_id", "fecha_inicio", "fecha_fin"], false],
    ["tarifa_adicional", "idx_tarifa_adicional_cotizacion", ["recurso_id", "regimen_id", "adicional_id", "activo", "fecha_inicio", "fecha_fin"], false],
    ["bloque_fecha_recurso", "idx_bfr_disponibilidad", ["recurso_id", "estado", "bloque_fecha_id", "reserva_id"], false],
  ];
  for (const [table, name, columns, unique] of indexes) {
    await ensureIndex(connection, apply, table, name, columns, unique);
  }
}

function prefixed(expression, prefix, columns) {
  let result = expression;
  for (const column of columns) {
    result = result.replace(new RegExp(`\\b${column}\\b`, "g"), `${prefix}.${column}`);
  }
  return result;
}

async function migrateClaims(connection, apply) {
  const claimsExist = await tableExists(connection, "coseguro_comprobante_claim");
  if (!claimsExist) {
    await executeOrPlan(
      connection,
      apply,
      "Crear tabla canónica de claims de comprobantes",
      `CREATE TABLE coseguro_comprobante_claim (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        solicitud_id INT NOT NULL,
        alcance ENUM('AFILIADO','EMISOR') NOT NULL,
        alcance_clave VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        punto_venta_canonico CHAR(5) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        numero_canonico VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_cos_claim_canonico (alcance, alcance_clave, punto_venta_canonico, numero_canonico),
        UNIQUE KEY uq_cos_claim_solicitud_alcance (solicitud_id, alcance),
        CONSTRAINT fk_cos_claim_solicitud FOREIGN KEY (solicitud_id)
          REFERENCES coseguro_solicitud (id) ON DELETE CASCADE,
        CONSTRAINT ajb_chk_cos_claim_pto CHECK (REGEXP_LIKE(punto_venta_canonico, '^[0-9]{5}$')),
        CONSTRAINT ajb_chk_cos_claim_numero CHECK (numero_canonico <> '')
      ) ENGINE=InnoDB`
    );
  } else {
    logAction(apply, "La tabla coseguro_comprobante_claim ya existe");
  }

  if (apply || claimsExist) {
    await ensureIndex(
      connection,
      apply,
      "coseguro_comprobante_claim",
      "PRIMARY",
      ["id"],
      true
    );
    await ensureIndex(
      connection,
      apply,
      "coseguro_comprobante_claim",
      "uq_cos_claim_canonico",
      ["alcance", "alcance_clave", "punto_venta_canonico", "numero_canonico"],
      true
    );
    await ensureIndex(
      connection,
      apply,
      "coseguro_comprobante_claim",
      "uq_cos_claim_solicitud_alcance",
      ["solicitud_id", "alcance"],
      true
    );
    await ensureCheck(
      connection,
      apply,
      "coseguro_comprobante_claim",
      "ajb_chk_cos_claim_pto",
      "REGEXP_LIKE(punto_venta_canonico, '^[0-9]{5}$')"
    );
    await ensureCheck(
      connection,
      apply,
      "coseguro_comprobante_claim",
      "ajb_chk_cos_claim_numero",
      "numero_canonico <> ''"
    );
  }

  if (apply) {
    const pto = prefixed(CANONICAL_PTO_SQL, "s", ["comprobante_pto_venta"]);
    const numero = prefixed(CANONICAL_NUMBER_SQL, "s", ["comprobante_numero"]);
    const cuit = prefixed(CANONICAL_CUIT_SQL, "s", ["emisor_cuit"]);
    const active = await activeReceiptSql(connection, "s");
    logAction(true, "Reconstruir claims derivados dentro de una transacción");
    await connection.beginTransaction();
    try {
      await connection.query("DELETE FROM coseguro_comprobante_claim");
      await connection.query(`
        INSERT INTO coseguro_comprobante_claim
          (solicitud_id, alcance, alcance_clave, punto_venta_canonico, numero_canonico)
        SELECT s.id, 'AFILIADO', CAST(s.usuario_id AS CHAR), ${pto}, ${numero}
          FROM coseguro_solicitud s
         WHERE ${active}
      `);
      await connection.query(`
        INSERT INTO coseguro_comprobante_claim
          (solicitud_id, alcance, alcance_clave, punto_venta_canonico, numero_canonico)
        SELECT s.id, 'EMISOR', ${cuit}, ${pto}, ${numero}
          FROM coseguro_solicitud s
         WHERE ${active} AND ${cuit} IS NOT NULL
      `);
      const verification = await queryOne(
        connection,
        `SELECT COUNT(*) AS inconsistentes
           FROM coseguro_solicitud s
          WHERE ${active}
            AND (SELECT COUNT(*) FROM coseguro_comprobante_claim c WHERE c.solicitud_id = s.id)
                <> 1 + IF(${cuit} IS NULL, 0, 1)`
      );
      if (Number(verification.inconsistentes) !== 0) {
        throw new Error("El backfill de claims no cubrió todas las solicitudes activas");
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } else {
    logAction(false, "Reconstruir claims de solicitudes activas dentro de una transacción");
  }

  const ptoNew = "LPAD(COALESCE(NULLIF(TRIM(LEADING '0' FROM NEW.comprobante_pto_venta), ''), '0'), 5, '0')";
  const numeroNew = "COALESCE(NULLIF(TRIM(LEADING '0' FROM NEW.comprobante_numero), ''), '0')";
  const cuitNew = "NULLIF(REGEXP_REPLACE(COALESCE(NEW.emisor_cuit, ''), '[^0-9]', ''), '')";
  const activeNew =
    "NEW.eliminado = 0 AND NEW.estado_id NOT IN (5, 6) AND NEW.duplicado_forzado = 0";
  const insertClaims = `
    IF ${activeNew} THEN
      INSERT INTO coseguro_comprobante_claim
        (solicitud_id, alcance, alcance_clave, punto_venta_canonico, numero_canonico)
      VALUES (NEW.id, 'AFILIADO', CAST(NEW.usuario_id AS CHAR), ${ptoNew}, ${numeroNew});
      IF ${cuitNew} IS NOT NULL THEN
        INSERT INTO coseguro_comprobante_claim
          (solicitud_id, alcance, alcance_clave, punto_venta_canonico, numero_canonico)
        VALUES (NEW.id, 'EMISOR', ${cuitNew}, ${ptoNew}, ${numeroNew});
      END IF;
    END IF;
  `;

  await ensureTrigger(connection, apply, {
    name: "ajb_cos_claim_ai",
    table: "coseguro_solicitud",
    event: "INSERT",
    timing: "AFTER",
    requiredFragments: ["INSERT INTO coseguro_comprobante_claim", "'AFILIADO'", "'EMISOR'"],
    sql: `CREATE TRIGGER ajb_cos_claim_ai AFTER INSERT ON coseguro_solicitud
          FOR EACH ROW BEGIN ${insertClaims} END`,
  });
  await ensureTrigger(connection, apply, {
    name: "ajb_cos_claim_au",
    table: "coseguro_solicitud",
    event: "UPDATE",
    timing: "AFTER",
    requiredFragments: [
      "DELETE FROM coseguro_comprobante_claim",
      "INSERT INTO coseguro_comprobante_claim",
      "'AFILIADO'",
    ],
    sql: `CREATE TRIGGER ajb_cos_claim_au AFTER UPDATE ON coseguro_solicitud
          FOR EACH ROW BEGIN
            DELETE FROM coseguro_comprobante_claim WHERE solicitud_id = OLD.id;
            ${insertClaims}
          END`,
  });
  await ensureTrigger(connection, apply, {
    name: "ajb_cos_claim_ad",
    table: "coseguro_solicitud",
    event: "DELETE",
    timing: "AFTER",
    requiredFragments: ["DELETE FROM coseguro_comprobante_claim"],
    sql: `CREATE TRIGGER ajb_cos_claim_ad AFTER DELETE ON coseguro_solicitud
          FOR EACH ROW BEGIN
            DELETE FROM coseguro_comprobante_claim WHERE solicitud_id = OLD.id;
          END`,
  });
}

async function migrateOlympics(connection, apply) {
  await ensureColumn(
    connection,
    apply,
    "olimpiada_inscripcion",
    "usuario_activo_unico",
    "INT GENERATED ALWAYS AS (CASE WHEN eliminado = 0 AND estado = 'VALIDADO' THEN usuario_id ELSE NULL END) STORED",
    { type: "int", generated: ["usuario_id", "eliminado", "estado", "VALIDADO"] }
  );
  await ensureIndex(
    connection,
    apply,
    "olimpiada_inscripcion",
    "uq_olimpiada_usuario_activo",
    ["olimpiada_id", "usuario_activo_unico"],
    true
  );
}

const EXACT_COLUMN_CONTRACTS = [
  ["reserva", "precio_total", "decimal(12,2)", "YES"],
  ["reserva", "monto_adicionales", "decimal(12,2)", "NO", "0.00"],
  ["reserva", "fecha_inicio", "date", "NO"],
  ["reserva", "fecha_fin", "date", "NO"],
  ["reserva_familiar", "precio", "decimal(12,2)", "NO"],
  ["reserva_familiar", "reserva_id", "int", "NO"],
  ["reserva_familiar", "usuario_id", "int", "NO"],
  ["reserva_familiar", "tipo_persona_id", "int", "NO"],
  ["reserva_familiar_tarifa", "reserva_familiar_id", "int", "NO"],
  ["reserva_familiar_tarifa", "fecha", "date", "NO"],
  ["reserva_familiar_tarifa", "tarifa_id_legacy", "int", "YES"],
  ["reserva_familiar_tarifa", "precio_aplicado", "decimal(12,2)", "YES"],
  ["reserva_familiar_tarifa", "usa_porcentaje_aplicado", "tinyint(1)", "YES"],
  ["reserva_familiar_tarifa", "porcentaje_descuento_aplicado", "decimal(5,2)", "YES"],
  [
    "reserva_familiar_tarifa",
    "snapshot_estado",
    "enum('COMPLETO','LEGADO_SIN_SNAPSHOT','TARIFA_NO_RESUELTA')",
    "NO",
    "LEGADO_SIN_SNAPSHOT",
  ],
  ["reserva_familiar_tarifa", "snapshot_creado_en", "datetime", "YES"],
  ["reserva_adicional", "subtotal", "decimal(12,2)", "NO"],
  ["reserva_adicional_detalle", "precio_unitario", "decimal(12,2)", "NO"],
  ["reserva_adicional_detalle", "subtotal", "decimal(12,2)", "NO"],
  ["tarifa", "precio", "decimal(12,2)", "NO"],
  ["tarifa", "fecha_inicio", "date", "NO"],
  ["tarifa", "fecha_fin", "date", "NO"],
  ["tarifa_adicional", "precio", "decimal(12,2)", "NO"],
  ["temporada_tarifa", "fecha_inicio", "date", "NO"],
  ["temporada_tarifa", "fecha_fin", "date", "NO"],
  ["coseguro_solicitud", "duplicado_forzado", "tinyint(1)", "NO", "0"],
  ["ajb_reserva_version_archivo", "id", "bigint unsigned", "NO", null, "auto_increment"],
  ["ajb_reserva_version_archivo", "reserva_id", "int", "NO"],
  ["ajb_reserva_version_archivo", "version_numero", "int unsigned", "NO"],
  ["ajb_reserva_version_archivo", "operacion", "varchar(32)", "NO"],
  ["ajb_reserva_version_archivo", "actor_usuario_id", "int", "YES"],
  ["ajb_reserva_version_archivo", "actor_rol", "varchar(64)", "YES"],
  ["ajb_reserva_version_archivo", "conexion_id", "bigint unsigned", "NO"],
  ["ajb_reserva_version_archivo", "contenido_json", "json", "NO"],
  ["ajb_reserva_version_archivo", "contenido_sha256", "char(64)", "NO"],
  ["ajb_reserva_version_archivo", "creada_en", "datetime(6)", "NO", "CURRENT_TIMESTAMP(6)", "DEFAULT_GENERATED"],
  ["ajb_reserva_mutacion_guard", "conexion_id", "bigint unsigned", "NO"],
  ["ajb_reserva_mutacion_guard", "reserva_id", "int", "NO"],
  ["ajb_reserva_mutacion_guard", "guard_token", "char(64)", "NO"],
  ["ajb_reserva_mutacion_guard", "archivo_id", "bigint unsigned", "NO"],
  ["ajb_reserva_mutacion_guard", "operacion", "varchar(32)", "NO"],
  ["ajb_reserva_mutacion_guard", "creada_en", "datetime(6)", "NO", "CURRENT_TIMESTAMP(6)", "DEFAULT_GENERATED"],
  ["coseguro_comprobante_claim", "id", "bigint unsigned", "NO", null, "auto_increment"],
  ["coseguro_comprobante_claim", "solicitud_id", "int", "NO"],
  ["coseguro_comprobante_claim", "alcance", "enum('AFILIADO','EMISOR')", "NO"],
  ["coseguro_comprobante_claim", "alcance_clave", "varchar(64)", "NO"],
  ["coseguro_comprobante_claim", "punto_venta_canonico", "char(5)", "NO"],
  ["coseguro_comprobante_claim", "numero_canonico", "varchar(20)", "NO"],
  ["coseguro_comprobante_claim", "fecha_creacion", "datetime", "NO", "CURRENT_TIMESTAMP", "DEFAULT_GENERATED"],
  ["olimpiada_inscripcion", "usuario_activo_unico", "int", "YES", null, "STORED GENERATED"],
];

function sameDefault(actual, expected) {
  if (actual === null || actual === undefined) return expected === null || expected === undefined;
  if (expected === null || expected === undefined) return false;
  const normalize = (value) =>
    String(value)
      .replace(/^\((.*)\)$/s, "$1")
      .replace(/^CURRENT_TIMESTAMP\(\)$/i, "CURRENT_TIMESTAMP")
      .toUpperCase();
  if (/^-?\d+(?:\.\d+)?$/.test(String(actual)) && /^-?\d+(?:\.\d+)?$/.test(String(expected))) {
    return Number(actual) === Number(expected);
  }
  return normalize(actual) === normalize(expected);
}

async function verifyExactColumns(connection) {
  for (const [table, column, type, nullable, defaultValue = null, extra = ""] of EXACT_COLUMN_CONTRACTS) {
    const info = await columnInfo(connection, table, column);
    if (!info) throw new Error(`Falta la columna contractual ${table}.${column}`);
    if (
      String(info.COLUMN_TYPE).toLowerCase() !== type.toLowerCase() ||
      info.IS_NULLABLE !== nullable ||
      !sameDefault(info.COLUMN_DEFAULT, defaultValue) ||
      String(info.EXTRA || "").toUpperCase() !== extra.toUpperCase()
    ) {
      throw new Error(
        `Columna incompatible ${table}.${column}: ${info.COLUMN_TYPE}/${info.IS_NULLABLE}/${info.COLUMN_DEFAULT}/${info.EXTRA}`
      );
    }
  }
  const generated = await columnInfo(
    connection,
    "olimpiada_inscripcion",
    "usuario_activo_unico"
  );
  // MySQL agrega paréntesis alrededor de cada predicado; al quitarlos también
  // hay que quitar espacios para que `WHEN ((a) AND (b))` y `WHEN a AND b`
  // conserven la misma secuencia de tokens.
  const generation = canonicalizeSql(generated.GENERATION_EXPRESSION).replace(/[()\s]/g, "");
  const expected = canonicalizeSql(
    "CASE WHEN eliminado = 0 AND estado = 'VALIDADO' THEN usuario_id ELSE NULL END"
  ).replace(/[()\s]/g, "");
  if (generation !== expected) {
    throw new Error("La expresión de olimpiada_inscripcion.usuario_activo_unico no coincide");
  }
  for (const [table, column] of [
    ["ajb_reserva_version_archivo", "operacion"],
    ["ajb_reserva_version_archivo", "contenido_sha256"],
    ["ajb_reserva_mutacion_guard", "guard_token"],
    ["ajb_reserva_mutacion_guard", "operacion"],
    ["coseguro_comprobante_claim", "alcance_clave"],
    ["coseguro_comprobante_claim", "punto_venta_canonico"],
    ["coseguro_comprobante_claim", "numero_canonico"],
  ]) {
    const info = await columnInfo(connection, table, column);
    if (info.CHARACTER_SET_NAME !== "ascii" || info.COLLATION_NAME !== "ascii_bin") {
      throw new Error(`Charset/collation incompatible en ${table}.${column}`);
    }
  }
  const [engines] = await connection.query(
    `SELECT TABLE_NAME, ENGINE
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('ajb_reserva_version_archivo',
                           'ajb_reserva_mutacion_guard',
                           'coseguro_comprobante_claim')`
  );
  if (engines.length !== 3 || engines.some((row) => row.ENGINE !== "InnoDB")) {
    throw new Error("Las tablas nuevas deben existir exactamente con motor InnoDB");
  }
}

async function verifyForeignKeys(connection) {
  const expected = [
    ["coseguro_comprobante_claim", "fk_cos_claim_solicitud", "solicitud_id", "coseguro_solicitud", "id", "CASCADE"],
    ["ajb_reserva_mutacion_guard", "fk_ajb_reserva_guard_archivo", "archivo_id", "ajb_reserva_version_archivo", "id", "RESTRICT"],
  ];
  for (const [table, name, column, referencedTable, referencedColumn, deleteRule] of expected) {
    const [rows] = await connection.query(
      `SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
              r.DELETE_RULE, child.COLUMN_TYPE AS CHILD_TYPE,
              parent.COLUMN_TYPE AS PARENT_TYPE
         FROM information_schema.KEY_COLUMN_USAGE k
         INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
         INNER JOIN information_schema.COLUMNS child
           ON child.TABLE_SCHEMA = k.TABLE_SCHEMA
          AND child.TABLE_NAME = k.TABLE_NAME
          AND child.COLUMN_NAME = k.COLUMN_NAME
         INNER JOIN information_schema.COLUMNS parent
           ON parent.TABLE_SCHEMA = k.REFERENCED_TABLE_SCHEMA
          AND parent.TABLE_NAME = k.REFERENCED_TABLE_NAME
          AND parent.COLUMN_NAME = k.REFERENCED_COLUMN_NAME
        WHERE k.CONSTRAINT_SCHEMA = DATABASE()
          AND k.TABLE_NAME = ? AND k.CONSTRAINT_NAME = ?`,
      [table, name]
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row.COLUMN_NAME !== column ||
      row.REFERENCED_TABLE_NAME !== referencedTable ||
      row.REFERENCED_COLUMN_NAME !== referencedColumn ||
      row.DELETE_RULE !== deleteRule ||
      String(row.CHILD_TYPE).toLowerCase() !== String(row.PARENT_TYPE).toLowerCase()
    ) {
      throw new Error(`La FK ${table}.${name} falta o no es compatible/exacta`);
    }
  }
}

async function verifyTargetContract(connection, registry = null) {
  const previousVerification = verificationOnly;
  const previousContext = verificationTriggerContext;
  const previousLogging = loggingEnabled;
  verificationOnly = true;
  loggingEnabled = false;
  verificationTriggerContext = registry
    ? { definer: registry.trigger_definer, sqlMode: registry.trigger_sql_mode, definerSql: "" }
    : null;
  try {
    await verifyExactColumns(connection);
    await migrateReservationArchive(connection, false);
    await migrateSnapshots(connection, false);
    await migrateChecks(connection, false);
    await migrateIndexes(connection, false);
    await migrateClaims(connection, false);
    await migrateOlympics(connection, false);
    await verifyForeignKeys(connection);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: redactError(error) };
  } finally {
    verificationOnly = previousVerification;
    verificationTriggerContext = previousContext;
    loggingEnabled = previousLogging;
  }
}

async function runStage(connection, apply, name, action) {
  if (apply) await recordStage(connection, name);
  console.log(`\n== Etapa: ${name} ==`);
  await action();
}

async function main() {
  const args = parseArguments();
  const apply = args.apply === true;
  if (apply && args.confirm !== CONFIRMATION) {
    throw new Error(`Para aplicar se exige --confirm=${CONFIRMATION}`);
  }
  if (apply && process.env.NODE_ENV === "production" && args["allow-production"] !== true) {
    throw new Error("En producción también se exige --allow-production");
  }

  const connection = await createConnection();
  let lockAcquired = false;
  let migrationRunStarted = false;
  let currentStage = "inicio";
  try {
    if (apply) {
      const lock = await queryOne(connection, "SELECT GET_LOCK(?, 0) AS adquirido", [MIGRATION_LOCK]);
      if (Number(lock.adquirido) !== 1) throw new Error("Otra migración de integridad está en curso");
      lockAcquired = true;
    }

    const preflight = await runDataPreflight(connection);
    const blocking = preflight.fatal.filter((issue) => issue.code !== "CLAIMS_INCONSISTENTES");
    console.log(JSON.stringify({ preflight_ok: blocking.length === 0, metrics: preflight.metrics, warnings: preflight.warnings }, null, 2));
    if (blocking.length > 0) {
      console.error(JSON.stringify({ fatal: blocking }, null, 2));
      throw new Error("El preflight detectó condiciones bloqueantes; no se ejecutó DDL");
    }

    if (apply) {
      await ensureMigrationRegistry(connection);
      migrationRunStarted = true;
    }
    else console.log("\nDry-run: no se creará el registro de migración ni se ejecutará DDL/DML.");

    currentStage = "tipos_monetarios_y_contratos";
    await runStage(connection, apply, currentStage, () => migrateMoneyTypes(connection, apply));
    currentStage = "archivo_reservas";
    await runStage(connection, apply, currentStage, () =>
      migrateReservationArchive(connection, apply)
    );
    currentStage = "snapshots_tarifa";
    await runStage(connection, apply, currentStage, () => migrateSnapshots(connection, apply));
    currentStage = "checks";
    await runStage(connection, apply, currentStage, () => migrateChecks(connection, apply));
    currentStage = "indices_unicos_y_disponibilidad";
    await runStage(connection, apply, currentStage, () => migrateIndexes(connection, apply));
    currentStage = "claims_coseguro";
    await runStage(connection, apply, currentStage, () => migrateClaims(connection, apply));
    currentStage = "unicidad_olimpiadas";
    await runStage(connection, apply, currentStage, () => migrateOlympics(connection, apply));

    if (apply && migrationRunStarted) {
      const [registryRows] = await connection.query(
        `SELECT trigger_definer, trigger_sql_mode
           FROM ajb_schema_migration WHERE migration_id = ?`,
        [MIGRATION_ID]
      );
      const contract = await verifyTargetContract(connection, registryRows[0]);
      if (!contract.ok) {
        throw new Error(`El contrato exacto de esquema falló: ${contract.error.message}`);
      }
      const verification = await runDataPreflight(connection);
      if (!verification.ok) {
        throw new Error(`La verificación final falló: ${verification.fatal.map((x) => x.code).join(", ")}`);
      }
      await markCompleted(connection);
      console.log(`\nMigración ${MIGRATION_ID} aplicada y verificada.`);
    } else {
      console.log(`\nPlan dry-run completo para ${MIGRATION_ID}. No se modificó la base.`);
    }
  } catch (error) {
    if (apply && migrationRunStarted) {
      try {
        await markFailed(connection, currentStage, error);
      } catch (registryError) {
        console.error("No se pudo registrar el fallo:", redactError(registryError));
      }
    }
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]);
      } catch (_) {
        // El cierre de conexión también libera el advisory lock.
      }
    }
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify(redactError(error)));
    process.exitCode = 1;
  });
}

module.exports = {
  EXACT_COLUMN_CONTRACTS,
  verifyTargetContract,
};
