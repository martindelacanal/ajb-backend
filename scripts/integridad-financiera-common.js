"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const MIGRATION_ID = "20260807_01_integridad_financiera";
const MIGRATION_LOCK = "ajb_integridad_financiera_20260807";
const DOUBLE_ADDITIONAL_FIX_ID = "20260807_fix_doble_adicional";
const MIGRATION_REVISION = 9;
const MIGRATION_STAGES = [
  "tipos_monetarios_y_contratos",
  "archivo_reservas",
  "snapshots_tarifa",
  "checks",
  "indices_unicos_y_disponibilidad",
  "claims_coseguro",
  "unicidad_olimpiadas",
];
const MIGRATION_CHECKSUM = crypto
  .createHash("sha256")
  .update(
    JSON.stringify({
      migration: MIGRATION_ID,
      revision: MIGRATION_REVISION,
      stages: MIGRATION_STAGES,
    })
  )
  .digest("hex");

const REQUIRED_TABLES = [
  "reserva",
  "reserva_familiar",
  "reserva_familiar_tarifa",
  "reserva_adicional",
  "reserva_adicional_detalle",
  "tarifa",
  "tarifa_adicional",
  "temporada_tarifa",
  "temporada_tipo_persona_porcentaje",
  "servicio_regimen",
  "coseguro_solicitud",
  "coseguro_tipo_reintegro",
  "reserva_salud",
  "sorteo",
  "olimpiada",
  "olimpiada_disciplina",
  "olimpiada_disciplina_config",
  "olimpiada_inscripcion",
  "historial_reserva",
  "bloque_fecha_recurso",
];

// La API considera activos todos los comprobantes salvo los rechazados por la
// departamental (5), cancelados (6) o eliminados lógicamente.
const ACTIVE_RECEIPT_SQL =
  "eliminado = 0 AND estado_id NOT IN (5, 6) AND duplicado_forzado = 0";
const LEGACY_ACTIVE_RECEIPT_SQL =
  "eliminado = 0 AND estado_id NOT IN (5, 6) AND COALESCE(JSON_EXTRACT(verificacion, '$.duplicados_forzados') = TRUE, FALSE) = FALSE";
const CANONICAL_PTO_SQL =
  "LPAD(COALESCE(NULLIF(TRIM(LEADING '0' FROM comprobante_pto_venta), ''), '0'), 5, '0')";
const CANONICAL_NUMBER_SQL =
  "COALESCE(NULLIF(TRIM(LEADING '0' FROM comprobante_numero), ''), '0')";
const CANONICAL_CUIT_SQL =
  "NULLIF(REGEXP_REPLACE(COALESCE(emisor_cuit, ''), '[^0-9]', ''), '')";

function databaseConfig() {
  const required = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables de conexión: ${missing.join(", ")}`);
  }

  const sslMode = String(process.env.DB_SSL_MODE || "disabled").trim().toLowerCase();
  let ssl;
  if (sslMode !== "disabled") {
    if (sslMode !== "verify-ca" && sslMode !== "verify-full") {
      throw new Error("DB_SSL_MODE debe ser disabled, verify-ca o verify-full");
    }
    const caPath = String(process.env.DB_SSL_CA_PATH || "").trim();
    if (!caPath) throw new Error("DB_SSL_CA_PATH es obligatorio cuando TLS esta habilitado");
    ssl = { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    connectTimeout: 10000,
    decimalNumbers: false,
    dateStrings: true,
    multipleStatements: false,
    ssl,
  };
}

function normalizarSqlModeEstricto(valor) {
  const modos = String(valor || "")
    .split(",")
    .map((modo) => modo.trim().toUpperCase())
    .filter(Boolean);
  const unicos = new Set(modos);
  if (!unicos.has("STRICT_TRANS_TABLES") && !unicos.has("STRICT_ALL_TABLES")) {
    unicos.add("STRICT_TRANS_TABLES");
  }
  unicos.add("NO_ENGINE_SUBSTITUTION");
  return [...unicos].join(",");
}

async function createConnection() {
  const connection = await mysql.createConnection(databaseConfig());
  try {
    const [[session]] = await connection.query("SELECT @@SESSION.sql_mode AS sql_mode");
    await connection.query("SET SESSION sql_mode = ?", [normalizarSqlModeEstricto(session?.sql_mode)]);
    await connection.query("SET SESSION time_zone = '-03:00'");
    return connection;
  } catch (error) {
    await connection.end();
    throw error;
  }
}

function redactError(error) {
  const message = String(error?.message || error || "Error desconocido")
    .replace(/(?:[A-Za-z0-9_.-]+)@(?:[A-Za-z0-9_.-]+)/g, "[redacted]")
    .replace(/password\s*=\s*[^\s;]+/gi, "password=[redacted]");
  return { code: error?.code || error?.name || "ERROR", message };
}

function normalizeValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) || value.includes(".") ? number : value;
  }
  return value;
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, normalizeValue(value)])
  );
}

async function queryOne(connection, sql, params = []) {
  const [rows] = await connection.query(sql, params);
  return normalizeRow(rows[0] || {});
}

async function tableExists(connection, tableName) {
  const row = await queryOne(
    connection,
    `SELECT COUNT(*) AS cantidad
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(row.cantidad) === 1;
}

async function columnInfo(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
            EXTRA, GENERATION_EXPRESSION, CHARACTER_SET_NAME, COLLATION_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return rows[0] ? normalizeRow(rows[0]) : null;
}

async function indexInfo(connection, tableName, indexName) {
  const [rows] = await connection.query(
    `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, EXPRESSION,
            SUB_PART, COLLATION, INDEX_TYPE, IS_VISIBLE
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [tableName, indexName]
  );
  return rows.map(normalizeRow);
}

async function checkInfo(connection, constraintName) {
  const [rows] = await connection.query(
    `SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE, tc.ENFORCED
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE()
        AND tc.CONSTRAINT_TYPE = 'CHECK'
        AND tc.CONSTRAINT_NAME = ?`,
    [constraintName]
  );
  return rows[0] ? normalizeRow(rows[0]) : null;
}

async function triggerInfo(connection, triggerName) {
  const [rows] = await connection.query(
    `SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING,
            ACTION_STATEMENT, DEFINER, SQL_MODE, ACTION_ORIENTATION
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?`,
    [triggerName]
  );
  return rows[0] ? normalizeRow(rows[0]) : null;
}

function canonicalizeSql(value) {
  return String(value || "")
    .replace(/`/g, "")
    .replace(/_utf8mb4/gi, "")
    // INFORMATION_SCHEMA serializa las comillas de algunos CHECK/ACTION_STATEMENT
    // como \\' aunque el SQL original use '. Ambas formas representan el mismo
    // literal y deben compararse de manera idempotente.
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;=<>+*\/])\s*/g, "$1")
    .replace(/;$/g, "")
    .trim()
    .toLowerCase();
}

function stripEnclosingParentheses(value) {
  let result = String(value).trim();
  for (;;) {
    if (!result.startsWith("(") || !result.endsWith(")")) return result;
    let depth = 0;
    let quote = null;
    let enclosesAll = true;
    for (let index = 0; index < result.length; index += 1) {
      const char = result[index];
      if (quote) {
        if (char === quote && result[index - 1] !== "\\") quote = null;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0 && index !== result.length - 1) {
          enclosesAll = false;
          break;
        }
      }
    }
    if (!enclosesAll || depth !== 0) return result;
    result = result.slice(1, -1).trim();
  }
}

function splitTopLevelBoolean(value, operator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let betweenPending = false;
  const lower = value.toLowerCase();
  const isWord = (char) => /[a-z0-9_]/i.test(char || "");
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (
      lower.startsWith("between", index) &&
      !isWord(lower[index - 1]) &&
      !isWord(lower[index + 7])
    ) {
      betweenPending = true;
      index += 6;
      continue;
    }
    if (
      lower.startsWith(operator, index) &&
      !isWord(lower[index - 1]) &&
      !isWord(lower[index + operator.length])
    ) {
      if (operator === "and" && betweenPending) {
        betweenPending = false;
        index += operator.length - 1;
        continue;
      }
      parts.push(value.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (parts.length === 0) return [value];
  parts.push(value.slice(start).trim());
  return parts;
}

function canonicalizeCheck(value) {
  const normalized = stripEnclosingParentheses(canonicalizeSql(value));
  const orParts = splitTopLevelBoolean(normalized, "or");
  if (orParts.length > 1) return `or(${orParts.map(canonicalizeCheck).join(",")})`;
  const andParts = splitTopLevelBoolean(normalized, "and");
  if (andParts.length > 1) return `and(${andParts.map(canonicalizeCheck).join(",")})`;
  return stripEnclosingParentheses(normalized);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function activeReceiptSql(connection, alias = "") {
  const flag = await columnInfo(connection, "coseguro_solicitud", "duplicado_forzado");
  const predicate = flag ? ACTIVE_RECEIPT_SQL : LEGACY_ACTIVE_RECEIPT_SQL;
  if (!alias) return predicate;
  return predicate.replace(
    /\b(eliminado|estado_id|duplicado_forzado|verificacion)\b/g,
    `${alias}.$1`
  );
}

function addIssue(collection, code, message, evidence = undefined) {
  collection.push({ code, message, ...(evidence === undefined ? {} : { evidence }) });
}

async function runDataPreflight(connection) {
  const report = {
    migration_id: MIGRATION_ID,
    generated_at: new Date().toISOString(),
    server: {},
    metrics: {},
    fatal: [],
    warnings: [],
  };

  const server = await queryOne(
    connection,
    "SELECT VERSION() AS version, @@SESSION.transaction_isolation AS isolation_level, @@SESSION.sql_mode AS sql_mode"
  );
  report.server = server;
  const versionMatch = String(server.version || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  const supportsEnforcedChecks =
    versionMatch &&
    (Number(versionMatch[1]) > 8 ||
      (Number(versionMatch[1]) === 8 &&
        (Number(versionMatch[2]) > 0 || Number(versionMatch[3]) >= 16)));
  if (!supportsEnforcedChecks) {
    addIssue(
      report.fatal,
      "MYSQL_CHECK_NO_SOPORTADO",
      "Se requiere MySQL 8.0.16 o posterior para CHECK aplicados realmente",
      { version: server.version }
    );
  }
  if (!/\bSTRICT_(?:TRANS|ALL)_TABLES\b/.test(String(server.sql_mode || ""))) {
    addIssue(
      report.fatal,
      "SQL_MODE_NO_ESTRICTO",
      "La migración requiere STRICT_TRANS_TABLES o STRICT_ALL_TABLES para no truncar datos"
    );
  }

  const missingTables = [];
  for (const table of REQUIRED_TABLES) {
    if (!(await tableExists(connection, table))) missingTables.push(table);
  }
  report.metrics.required_tables_missing = missingTables;
  if (missingTables.length > 0) {
    addIssue(
      report.fatal,
      "TABLAS_REQUERIDAS_AUSENTES",
      "La migración no puede ejecutarse con un esquema incompleto",
      { tables: missingTables }
    );
    report.ok = false;
    return report;
  }

  const [nonTransactionalTables] = await connection.query(
    `SELECT TABLE_NAME, ENGINE
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) AND ENGINE <> 'InnoDB'
      ORDER BY TABLE_NAME`,
    [REQUIRED_TABLES]
  );
  report.metrics.non_innodb_tables = nonTransactionalTables.map(normalizeRow);
  if (nonTransactionalTables.length > 0) {
    addIssue(
      report.fatal,
      "TABLAS_NO_TRANSACCIONALES",
      "Las correcciones requieren InnoDB",
      report.metrics.non_innodb_tables
    );
  }

  report.metrics.float_conversion = await queryOne(
    connection,
    `SELECT
       (SELECT COALESCE(SUM(precio_total < 0), 0) FROM reserva) AS reserva_negativos,
       (SELECT COALESCE(SUM(ABS(precio_total) >= 10000000000), 0) FROM reserva) AS reserva_fuera_rango,
       (SELECT COALESCE(SUM(ABS(precio_total * 100 - ROUND(precio_total * 100)) > 0.0001), 0) FROM reserva) AS reserva_mas_dos_decimales,
       (SELECT COALESCE(SUM(precio < 0), 0) FROM reserva_familiar) AS familiar_negativos,
       (SELECT COALESCE(SUM(ABS(precio) >= 10000000000), 0) FROM reserva_familiar) AS familiar_fuera_rango,
       (SELECT COALESCE(SUM(ABS(precio * 100 - ROUND(precio * 100)) > 0.0001), 0) FROM reserva_familiar) AS familiar_mas_dos_decimales,
       (SELECT COALESCE(SUM(precio < 0), 0) FROM tarifa) AS tarifa_negativos,
       (SELECT COALESCE(SUM(ABS(precio) >= 10000000000), 0) FROM tarifa) AS tarifa_fuera_rango,
       (SELECT COALESCE(SUM(ABS(precio * 100 - ROUND(precio * 100)) > 0.0001), 0) FROM tarifa) AS tarifa_mas_dos_decimales,
       (SELECT COALESCE(SUM(monto_adicionales < 0 OR ABS(monto_adicionales) >= 10000000000 OR ABS(monto_adicionales * 100 - ROUND(monto_adicionales * 100)) > 0.0001), 0) FROM reserva) AS reserva_adicionales_invalidos,
       (SELECT COALESCE(SUM(subtotal < 0 OR ABS(subtotal) >= 10000000000 OR ABS(subtotal * 100 - ROUND(subtotal * 100)) > 0.0001), 0) FROM reserva_adicional) AS adicional_subtotal_invalidos,
       (SELECT COALESCE(SUM(precio_unitario < 0 OR ABS(precio_unitario) >= 10000000000 OR ABS(precio_unitario * 100 - ROUND(precio_unitario * 100)) > 0.0001 OR subtotal < 0 OR ABS(subtotal) >= 10000000000 OR ABS(subtotal * 100 - ROUND(subtotal * 100)) > 0.0001), 0) FROM reserva_adicional_detalle) AS adicional_detalle_importes_invalidos,
       (SELECT COALESCE(SUM(precio < 0 OR ABS(precio) >= 10000000000 OR ABS(precio * 100 - ROUND(precio * 100)) > 0.0001), 0) FROM tarifa_adicional) AS tarifa_adicional_invalidos`
  );
  if (Object.values(report.metrics.float_conversion).some((value) => Number(value) > 0)) {
    addIssue(
      report.fatal,
      "CONVERSION_DECIMAL_INSEGURA",
      "Hay importes que se redondearían, son negativos o no caben en DECIMAL(12,2)",
      report.metrics.float_conversion
    );
  }

  report.metrics.not_null_contract = await queryOne(
    connection,
    `SELECT
       (SELECT COALESCE(SUM(fecha_inicio IS NULL OR fecha_fin IS NULL OR monto_adicionales IS NULL), 0) FROM reserva) AS reserva,
       (SELECT COALESCE(SUM(reserva_id IS NULL OR usuario_id IS NULL OR tipo_persona_id IS NULL OR precio IS NULL), 0) FROM reserva_familiar) AS reserva_familiar,
       (SELECT COALESCE(SUM(reserva_familiar_id IS NULL OR fecha IS NULL), 0) FROM reserva_familiar_tarifa) AS reserva_familiar_tarifa,
       (SELECT COALESCE(SUM(precio IS NULL OR fecha_inicio IS NULL OR fecha_fin IS NULL), 0) FROM tarifa) AS tarifa,
       (SELECT COALESCE(SUM(fecha_inicio IS NULL OR fecha_fin IS NULL), 0) FROM temporada_tarifa) AS temporada_tarifa`
  );
  if (Object.values(report.metrics.not_null_contract).some((value) => Number(value) > 0)) {
    addIssue(
      report.fatal,
      "NULOS_BLOQUEAN_NOT_NULL",
      "Hay NULL en columnas que el contrato de reservas/tarifas exige obligatorias",
      report.metrics.not_null_contract
    );
  }

  report.metrics.check_violations = await queryOne(
    connection,
    `SELECT
       (SELECT COALESCE(SUM(fecha_inicio IS NOT NULL AND fecha_fin IS NOT NULL AND fecha_inicio >= fecha_fin), 0) FROM reserva) AS reserva_fechas,
       (SELECT COALESCE(SUM(monto_adicionales < 0 OR (numero_parcela IS NOT NULL AND numero_parcela <= 0)), 0) FROM reserva) AS reserva_valores,
       (SELECT COALESCE(SUM(reserva_id IS NULL OR usuario_id IS NULL OR tipo_persona_id IS NULL OR (edad IS NOT NULL AND (edad < 0 OR edad > 130))), 0) FROM reserva_familiar) AS familiar_valores,
       (SELECT COALESCE(SUM(reserva_familiar_id IS NULL OR fecha IS NULL), 0) FROM reserva_familiar_tarifa) AS familiar_tarifa,
       (SELECT COALESCE(SUM(cantidad <= 0 OR dias <= 0 OR subtotal < 0), 0) FROM reserva_adicional) AS adicional,
       (SELECT COALESCE(SUM(cantidad <= 0 OR precio_unitario < 0 OR subtotal < 0 OR porcentaje_descuento < 0 OR porcentaje_descuento > 100), 0) FROM reserva_adicional_detalle) AS adicional_detalle,
       (SELECT COALESCE(SUM(fecha_inicio IS NULL OR fecha_fin IS NULL OR fecha_inicio > fecha_fin OR edad_minima < 0 OR edad_maxima < 0 OR edad_minima > edad_maxima OR porcentaje_descuento < 0 OR porcentaje_descuento > 100), 0) FROM tarifa) AS tarifa,
       (SELECT COALESCE(SUM(fecha_inicio > fecha_fin OR precio < 0), 0) FROM tarifa_adicional) AS tarifa_adicional,
       (SELECT COALESCE(SUM(fecha_inicio IS NULL OR fecha_fin IS NULL OR fecha_inicio > fecha_fin), 0) FROM temporada_tarifa) AS temporada,
       (SELECT COALESCE(SUM(porcentaje < 0 OR porcentaje > 100), 0) FROM temporada_tipo_persona_porcentaje) AS temporada_porcentaje,
       (SELECT COALESCE(SUM(servicio_id IS NULL OR regimen_id IS NULL), 0) FROM servicio_regimen) AS servicio_regimen,
       (SELECT COALESCE(SUM(importe <= 0 OR TRIM(comprobante_numero) = '' OR importe_estimado < 0 OR importe_autorizado < 0 OR porcentaje_cobertura_aplicado < 0 OR porcentaje_cobertura_aplicado > 100 OR cantidad_sesiones <= 0), 0) FROM coseguro_solicitud) AS coseguro,
       (SELECT COALESCE(SUM((porcentaje_cobertura IS NOT NULL AND (porcentaje_cobertura <= 0 OR porcentaje_cobertura > 100)) OR (tope_reintegro IS NOT NULL AND tope_reintegro <= 0) OR (modo_cobertura = 'PORCENTAJE' AND porcentaje_cobertura IS NULL)), 0) FROM coseguro_tipo_reintegro) AS coseguro_config,
       (SELECT COALESCE(SUM(precio_cubierto < 0), 0) FROM reserva_salud) AS reserva_salud,
       (SELECT COALESCE(SUM(fecha_inicio_inscripcion > fecha_fin_inscripcion), 0) FROM sorteo) AS sorteo,
       (SELECT COALESCE(SUM(fecha_inicio > fecha_fin OR fecha_inicio_inscripcion > fecha_fin_inscripcion OR fecha_fin_inscripcion > fecha_inicio), 0) FROM olimpiada) AS olimpiada,
       (SELECT COALESCE(SUM(max_por_departamental IS NOT NULL AND max_por_departamental <= 0), 0) FROM olimpiada_disciplina) AS olimpiada_disciplina,
       (SELECT COALESCE(SUM(max_por_departamental IS NOT NULL AND max_por_departamental <= 0), 0) FROM olimpiada_disciplina_config) AS olimpiada_config`
  );
  if (Object.values(report.metrics.check_violations).some((value) => Number(value) > 0)) {
    addIssue(
      report.fatal,
      "DATOS_INCOMPATIBLES_CON_CHECKS",
      "Hay filas que impedirían crear las restricciones CHECK",
      report.metrics.check_violations
    );
  }

  report.metrics.duplicate_keys = await queryOne(
    connection,
    `SELECT
       (SELECT COUNT(*) FROM (SELECT reserva_id, usuario_id FROM reserva_familiar GROUP BY reserva_id, usuario_id HAVING COUNT(*) > 1) x) AS reserva_familiar,
       (SELECT COUNT(*) FROM (SELECT reserva_familiar_id, fecha FROM reserva_familiar_tarifa GROUP BY reserva_familiar_id, fecha HAVING COUNT(*) > 1) x) AS familiar_fecha,
       (SELECT COUNT(*) FROM (SELECT reserva_id, adicional_id FROM reserva_adicional GROUP BY reserva_id, adicional_id HAVING COUNT(*) > 1) x) AS reserva_adicional,
       (SELECT COUNT(*) FROM (SELECT reserva_adicional_id, fecha FROM reserva_adicional_detalle GROUP BY reserva_adicional_id, fecha HAVING COUNT(*) > 1) x) AS adicional_fecha,
       (SELECT COUNT(*) FROM (SELECT servicio_id, regimen_id FROM servicio_regimen GROUP BY servicio_id, regimen_id HAVING COUNT(*) > 1) x) AS servicio_regimen,
       (SELECT COUNT(*) FROM (SELECT olimpiada_id, usuario_id FROM olimpiada_inscripcion WHERE eliminado = 0 AND estado = 'VALIDADO' GROUP BY olimpiada_id, usuario_id HAVING COUNT(*) > 1) x) AS olimpiada_activa`
  );
  if (Object.values(report.metrics.duplicate_keys).some((value) => Number(value) > 0)) {
    addIssue(
      report.fatal,
      "DUPLICADOS_BLOQUEAN_UNIQUE",
      "Hay claves duplicadas que deben resolverse antes de agregar UNIQUE",
      report.metrics.duplicate_keys
    );
  }

  const receiptActive = await activeReceiptSql(connection);
  report.metrics.receipt_claim_duplicates = await queryOne(
    connection,
    `SELECT
       (SELECT COUNT(*) FROM (
          SELECT usuario_id, ${CANONICAL_PTO_SQL} AS pto, ${CANONICAL_NUMBER_SQL} AS numero
            FROM coseguro_solicitud
           WHERE ${receiptActive}
           GROUP BY usuario_id, pto, numero HAVING COUNT(*) > 1
        ) x) AS afiliado,
       (SELECT COUNT(*) FROM (
          SELECT ${CANONICAL_CUIT_SQL} AS cuit, ${CANONICAL_PTO_SQL} AS pto, ${CANONICAL_NUMBER_SQL} AS numero
            FROM coseguro_solicitud
           WHERE ${receiptActive} AND ${CANONICAL_CUIT_SQL} IS NOT NULL
           GROUP BY cuit, pto, numero HAVING COUNT(*) > 1
        ) x) AS emisor`
  );
  if (Object.values(report.metrics.receipt_claim_duplicates).some((value) => Number(value) > 0)) {
    addIssue(
      report.fatal,
      "COMPROBANTES_DUPLICADOS_BLOQUEAN_CLAIMS",
      "Existen comprobantes activos duplicados según la clave canónica",
      report.metrics.receipt_claim_duplicates
    );
  }

  report.metrics.historical_references = await queryOne(
    connection,
    `SELECT
       (SELECT COUNT(*) FROM reserva_familiar_tarifa rft LEFT JOIN tarifa t ON t.id = rft.tarifa_id WHERE rft.tarifa_id IS NOT NULL AND t.id IS NULL) AS familiar_tarifa_huerfana,
       (SELECT COUNT(*) FROM reserva_adicional_detalle d LEFT JOIN tarifa t ON t.id = d.tarifa_id WHERE d.tarifa_id IS NOT NULL AND t.id IS NULL) AS adicional_tarifa_huerfana`
  );
  if (Object.values(report.metrics.historical_references).some((value) => Number(value) > 0)) {
    addIssue(
      report.warnings,
      "REFERENCIAS_HISTORICAS_HUERFANAS",
      "Se preservarán los IDs heredados y no se inventarán snapshots",
      report.metrics.historical_references
    );
  }

  report.metrics.reservation_totals = await queryOne(
    connection,
    `SELECT
       COALESCE(SUM(ABS(precio_total - (familiares + adicionales)) > 0.011), 0) AS discrepantes,
       COALESCE(SUM(adicionales > 0 AND ABS(precio_total - (familiares + 2 * adicionales)) <= 0.011), 0) AS doble_adicional_exacto,
       COALESCE(ROUND(SUM(CASE WHEN adicionales > 0 AND ABS(precio_total - (familiares + 2 * adicionales)) <= 0.011 THEN adicionales ELSE 0 END), 2), 0) AS exceso_total
      FROM (
        SELECT r.precio_total,
               COALESCE(f.total, 0) AS familiares,
               COALESCE(a.total, 0) AS adicionales
          FROM reserva r
          LEFT JOIN (SELECT reserva_id, SUM(precio) AS total FROM reserva_familiar GROUP BY reserva_id) f ON f.reserva_id = r.id
          LEFT JOIN (SELECT reserva_id, SUM(subtotal) AS total FROM reserva_adicional GROUP BY reserva_id) a ON a.reserva_id = r.id
      ) totales`
  );
  if (Number(report.metrics.reservation_totals.discrepantes) > 0) {
    addIssue(
      report.warnings,
      "TOTALES_RESERVA_DISCREPANTES",
      "La migración de esquema no corrige importes; usar el corrector separado",
      report.metrics.reservation_totals
    );
  }

  report.metrics.family_tariff_history = await queryOne(
    connection,
    `SELECT
       COALESCE(SUM(esperado > cantidad_real), 0) AS reservas_con_faltantes,
       COALESCE(SUM(GREATEST(esperado - cantidad_real, 0)), 0) AS filas_faltantes
      FROM (
        SELECT r.id,
               DATEDIFF(r.fecha_fin, r.fecha_inicio) * COUNT(DISTINCT rf.id) AS esperado,
               COUNT(rft.id) AS cantidad_real
          FROM reserva r
          LEFT JOIN reserva_familiar rf ON rf.reserva_id = r.id
          LEFT JOIN reserva_familiar_tarifa rft ON rft.reserva_familiar_id = rf.id
         GROUP BY r.id, r.fecha_inicio, r.fecha_fin
      ) cobertura`
  );
  if (Number(report.metrics.family_tariff_history.filas_faltantes) > 0) {
    addIssue(
      report.warnings,
      "SNAPSHOT_DIARIO_INCOMPLETO",
      "Faltan filas históricas por persona/noche; no se crearán sin fuente confiable",
      report.metrics.family_tariff_history
    );
  }

  if (await tableExists(connection, "coseguro_comprobante_claim")) {
    const activeS = await activeReceiptSql(connection, "s");
    const ptoS = CANONICAL_PTO_SQL.replaceAll(
      /\b(comprobante_pto_venta)\b/g,
      "s.$1"
    );
    const numeroS = CANONICAL_NUMBER_SQL.replaceAll(
      /\b(comprobante_numero)\b/g,
      "s.$1"
    );
    const cuitS = CANONICAL_CUIT_SQL.replaceAll(/\b(emisor_cuit)\b/g, "s.$1");
    report.metrics.claims_consistency = await queryOne(
      connection,
      `SELECT
         (SELECT COUNT(*) FROM coseguro_comprobante_claim c
           LEFT JOIN coseguro_solicitud s ON s.id = c.solicitud_id
          WHERE s.id IS NULL OR NOT (${activeS})) AS claims_inactivos,
         (SELECT COUNT(*) FROM coseguro_solicitud s
          WHERE ${activeS}
            AND (SELECT COUNT(*) FROM coseguro_comprobante_claim c WHERE c.solicitud_id = s.id)
                <> 1 + IF(${cuitS} IS NULL, 0, 1)) AS solicitudes_sin_claims_completos,
         (SELECT COUNT(*) FROM coseguro_comprobante_claim c
           JOIN coseguro_solicitud s ON s.id = c.solicitud_id
          WHERE c.alcance = 'AFILIADO'
            AND (c.alcance_clave <> CAST(s.usuario_id AS CHAR)
              OR c.punto_venta_canonico <> ${ptoS}
              OR c.numero_canonico <> ${numeroS})) AS claims_afiliado_incorrectos,
         (SELECT COUNT(*) FROM coseguro_comprobante_claim c
           JOIN coseguro_solicitud s ON s.id = c.solicitud_id
          WHERE c.alcance = 'EMISOR'
            AND (c.alcance_clave <> ${cuitS}
              OR c.punto_venta_canonico <> ${ptoS}
              OR c.numero_canonico <> ${numeroS})) AS claims_emisor_incorrectos`
    );
    if (Object.values(report.metrics.claims_consistency).some((value) => Number(value) > 0)) {
      addIssue(
        report.fatal,
        "CLAIMS_INCONSISTENTES",
        "La tabla de claims existe pero no representa exactamente las solicitudes activas",
        report.metrics.claims_consistency
      );
    }
  }

  report.ok = report.fatal.length === 0;
  return report;
}

async function inspectTargetSchema(connection) {
  const targets = {
    columns: [
      ["reserva", "precio_total"],
      ["reserva", "monto_adicionales"],
      ["reserva_familiar", "precio"],
      ["reserva_adicional", "subtotal"],
      ["reserva_adicional_detalle", "precio_unitario"],
      ["reserva_adicional_detalle", "subtotal"],
      ["tarifa", "precio"],
      ["tarifa_adicional", "precio"],
      ["coseguro_solicitud", "duplicado_forzado"],
      ["reserva_familiar_tarifa", "tarifa_id_legacy"],
      ["reserva_familiar_tarifa", "precio_aplicado"],
      ["reserva_familiar_tarifa", "usa_porcentaje_aplicado"],
      ["reserva_familiar_tarifa", "porcentaje_descuento_aplicado"],
      ["reserva_familiar_tarifa", "snapshot_estado"],
      ["reserva_familiar_tarifa", "snapshot_creado_en"],
      ["olimpiada_inscripcion", "usuario_activo_unico"],
      ["ajb_reserva_version_archivo", "contenido_sha256"],
      ["ajb_reserva_mutacion_guard", "guard_token"],
    ],
    indexes: [
      ["reserva_familiar", "uq_rf_reserva_usuario"],
      ["reserva_familiar_tarifa", "uq_rft_familiar_fecha"],
      ["reserva_adicional", "uq_ra_reserva_adicional"],
      ["reserva_adicional_detalle", "uq_rad_adicional_fecha"],
      ["servicio_regimen", "uq_servicio_regimen"],
      ["reserva", "idx_reserva_disponibilidad_unidad"],
      ["reserva", "idx_reserva_disponibilidad_recurso"],
      ["tarifa", "idx_tarifa_cotizacion"],
      ["tarifa_adicional", "idx_tarifa_adicional_cotizacion"],
      ["bloque_fecha_recurso", "idx_bfr_disponibilidad"],
      ["coseguro_comprobante_claim", "uq_cos_claim_canonico"],
      ["coseguro_comprobante_claim", "uq_cos_claim_solicitud_alcance"],
      ["olimpiada_inscripcion", "uq_olimpiada_usuario_activo"],
      ["ajb_reserva_version_archivo", "uq_ajb_reserva_archivo_version"],
      ["ajb_reserva_mutacion_guard", "uq_ajb_reserva_guard_archivo"],
    ],
    checks: [
      "ajb_chk_reserva_importes",
      "ajb_chk_reserva_fechas",
      "ajb_chk_reserva_parcela",
      "ajb_chk_rf_valores",
      "ajb_chk_rft_snapshot",
      "ajb_chk_ra_valores",
      "ajb_chk_rad_valores",
      "ajb_chk_tarifa_valores",
      "ajb_chk_tarifa_adicional",
      "ajb_chk_temporada_fechas",
      "ajb_chk_temporada_porcentaje",
      "ajb_chk_coseguro_importes",
      "ajb_chk_coseguro_duplicado_forzado",
      "ajb_chk_coseguro_config",
      "ajb_chk_reserva_salud_importe",
      "ajb_chk_sorteo_fechas",
      "ajb_chk_olimpiada_fechas",
      "ajb_chk_olimpiada_disciplina",
      "ajb_chk_olimpiada_disciplina_cfg",
      "ajb_chk_cos_claim_pto",
      "ajb_chk_cos_claim_numero",
      "ajb_chk_reserva_archivo_operacion",
      "ajb_chk_reserva_archivo_sha",
      "ajb_chk_reserva_guard_token",
      "ajb_chk_reserva_guard_operacion",
    ],
    triggers: [
      "ajb_rft_snapshot_bi",
      "ajb_rft_snapshot_bu",
      "ajb_tarifa_hist_bd",
      "ajb_tarifa_ad_hist_bd",
      "ajb_temporada_hist_bd",
      "ajb_cos_claim_ai",
      "ajb_cos_claim_au",
      "ajb_cos_claim_ad",
      "ajb_reserva_archivo_bu",
      "ajb_reserva_archivo_bd",
      "ajb_rft_guard_bd",
      "ajb_rf_guard_bd",
      "ajb_rad_guard_bd",
      "ajb_ra_guard_bd",
      "ajb_reserva_guard_bd",
      "ajb_reserva_guard_bu",
      "ajb_rf_guard_bu",
    ],
  };

  const result = {
    columns: {},
    indexes: {},
    checks: {},
    triggers: {},
    tables: {},
    migration_registry: null,
  };
  for (const [table, column] of targets.columns) {
    result.columns[`${table}.${column}`] = await columnInfo(connection, table, column);
  }
  for (const [table, index] of targets.indexes) {
    result.indexes[`${table}.${index}`] = await indexInfo(connection, table, index);
  }
  for (const constraint of targets.checks) {
    result.checks[constraint] = await checkInfo(connection, constraint);
  }
  for (const trigger of targets.triggers) {
    result.triggers[trigger] = await triggerInfo(connection, trigger);
  }
  for (const table of [
    "ajb_schema_migration",
    "ajb_reserva_precio_backup",
    "coseguro_comprobante_claim",
    "ajb_reserva_version_archivo",
    "ajb_reserva_mutacion_guard",
  ]) {
    result.tables[table] = await tableExists(connection, table);
  }
  if (result.tables.ajb_schema_migration) {
    const [rows] = await connection.query(
      `SELECT * FROM ajb_schema_migration WHERE migration_id = ?`,
      [MIGRATION_ID]
    );
    result.migration_registry = rows[0] ? normalizeRow(rows[0]) : null;
  }
  return result;
}

function parseArguments(argv = process.argv.slice(2)) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith("--")) continue;
    const [rawKey, ...rawValue] = token.slice(2).split("=");
    args[rawKey] = rawValue.length === 0 ? true : rawValue.join("=");
  }
  return args;
}

module.exports = {
  ACTIVE_RECEIPT_SQL,
  LEGACY_ACTIVE_RECEIPT_SQL,
  CANONICAL_CUIT_SQL,
  CANONICAL_NUMBER_SQL,
  CANONICAL_PTO_SQL,
  DOUBLE_ADDITIONAL_FIX_ID,
  MIGRATION_ID,
  MIGRATION_LOCK,
  MIGRATION_CHECKSUM,
  MIGRATION_REVISION,
  MIGRATION_STAGES,
  REQUIRED_TABLES,
  activeReceiptSql,
  canonicalizeSql,
  canonicalizeCheck,
  checkInfo,
  columnInfo,
  createConnection,
  indexInfo,
  inspectTargetSchema,
  normalizeRow,
  normalizarSqlModeEstricto,
  parseArguments,
  queryOne,
  redactError,
  runDataPreflight,
  sha256,
  stableJson,
  tableExists,
  triggerInfo,
};
