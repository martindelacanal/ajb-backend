"use strict";

// Versiones inmutables + aceptación y cálculo de cancelación auditables.
// Por defecto sólo chequea. Aplicar: --apply [--allow-production].
const fs = require("fs");
const path = require("path");
const { REGLAS_INICIALES } = require("../api/services/politica-cancelacion");

const MIGRATION_ID = "20261007_politicas_cancelacion_v1";
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;
const TABLAS = {
  politica_cancelacion: `CREATE TABLE IF NOT EXISTS politica_cancelacion (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    version INT UNSIGNED NOT NULL,
    titulo VARCHAR(160) NOT NULL,
    reglas_json JSON NOT NULL,
    motivo TEXT NOT NULL,
    creada_por BIGINT UNSIGNED NULL,
    creada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_politica_cancelacion_version (version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  politica_cancelacion_vigente: `CREATE TABLE IF NOT EXISTS politica_cancelacion_vigente (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    politica_id BIGINT UNSIGNED NOT NULL,
    CONSTRAINT fk_politica_cancelacion_vigente FOREIGN KEY (politica_id) REFERENCES politica_cancelacion (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  reserva_politica_cancelacion: `CREATE TABLE IF NOT EXISTS reserva_politica_cancelacion (
    reserva_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    politica_id BIGINT UNSIGNED NOT NULL,
    version INT UNSIGNED NOT NULL,
    snapshot_json JSON NOT NULL,
    aceptada_por BIGINT UNSIGNED NOT NULL,
    aceptada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reserva_politica_cancelacion FOREIGN KEY (politica_id) REFERENCES politica_cancelacion (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  reserva_cancelacion_politica: `CREATE TABLE IF NOT EXISTS reserva_cancelacion_politica (
    reserva_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    politica_id BIGINT UNSIGNED NOT NULL,
    version INT UNSIGNED NOT NULL,
    porcentaje_reintegro DECIMAL(5,2) NOT NULL,
    fecha_calculo DATE NOT NULL,
    fecha_checkin DATE NOT NULL,
    dias_previos INT NOT NULL,
    snapshot_json JSON NOT NULL,
    cancelada_por BIGINT UNSIGNED NOT NULL,
    cancelada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cancelacion_politica FOREIGN KEY (politica_id) REFERENCES politica_cancelacion (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

function parsearArgumentos(argv = []) {
  if (argv.some((arg) => !["--check", "--apply", "--allow-production"].includes(arg))
    || (argv.includes("--check") && argv.includes("--apply"))) {
    throw new Error("Uso: --check o --apply [--allow-production]");
  }
  return { checkOnly: !argv.includes("--apply"), allowProduction: argv.includes("--allow-production") };
}

function validarDestino(opciones, env = process.env) {
  for (const clave of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!env[clave]) throw new Error(`Falta la variable ${clave}`);
  }
  const remoto = !["localhost", "127.0.0.1", "::1"].includes(String(env.DB_HOST).trim().toLowerCase());
  if ((remoto || env.NODE_ENV === "production") && !opciones.checkOnly && !opciones.allowProduction) {
    throw new Error("Para aplicar en un servidor remoto/producción usá --allow-production");
  }
  return { remoto };
}

async function ejecutarMigracion(connection, { checkOnly = true, log = console.log } = {}) {
  const [existentes] = await connection.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
    [Object.keys(TABLAS)]
  );
  const nombres = new Set(existentes.map((row) => row.TABLE_NAME));
  const faltantes = Object.keys(TABLAS).filter((nombre) => !nombres.has(nombre));
  if (checkOnly) {
    let vigente = null;
    if (nombres.has("politica_cancelacion") && nombres.has("politica_cancelacion_vigente")) {
      const [rows] = await connection.query(
        `SELECT p.id, p.version FROM politica_cancelacion p
         INNER JOIN politica_cancelacion_vigente v ON v.politica_id = p.id WHERE v.id = 1`
      );
      vigente = rows[0] || null;
    }
    log(JSON.stringify({ migration: MIGRATION_ID, modo: "check", faltantes, vigente, requiere_semilla: !vigente }));
    return { faltantes, vigente };
  }
  // DDL idempotente separado de la transacción: MySQL confirma DDL implícitamente.
  for (const sql of Object.values(TABLAS)) await connection.query(sql);
  await connection.beginTransaction();
  try {
    const [actual] = await connection.query("SELECT politica_id FROM politica_cancelacion_vigente WHERE id = 1 FOR UPDATE");
    if (!actual.length) {
      const [ultima] = await connection.query("SELECT id FROM politica_cancelacion ORDER BY version DESC LIMIT 1");
      let id = ultima[0]?.id;
      if (!id) {
        const [resultado] = await connection.query(
          `INSERT INTO politica_cancelacion (version, titulo, reglas_json, motivo, creada_por) VALUES (1, ?, ?, ?, NULL)`,
          ["Política de cancelación de hospedajes", JSON.stringify(REGLAS_INICIALES),
            "Configuración inicial: 15 días o más, 100%; 7 a 14 días, 50%; 0 a 6 días, 0%. Días calendario en Argentina."]
        );
        id = resultado.insertId;
      }
      await connection.query("INSERT INTO politica_cancelacion_vigente (id, politica_id) VALUES (1, ?)", [id]);
    }
    await connection.commit();
    log(`Migración ${MIGRATION_ID} aplicada; política y aceptaciones existentes conservadas.`);
    return { faltantes, aplicada: true };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
  const opciones = parsearArgumentos(argv);
  const { remoto } = validarDestino(opciones);
  const modoTls = String(process.env.DB_SSL_MODE || "disabled").toLowerCase();
  if (!["disabled", "verify-ca", "verify-full"].includes(modoTls)) throw new Error("DB_SSL_MODE inválido");
  if (remoto && process.env.NODE_ENV === "production" && modoTls === "disabled") throw new Error("TLS es obligatorio en producción remota");
  const ssl = modoTls === "disabled" ? undefined : { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true };
  const connection = await require("mysql2/promise").createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, port: Number(process.env.DB_PORT || 3306),
    timezone: "-03:00", dateStrings: ["DATE"], multipleStatements: false, ssl,
  });
  let lock = false;
  try {
    await connection.query("SET SESSION time_zone = '-03:00'");
    const [rows] = await connection.query("SELECT GET_LOCK(?, 10) AS adquirido", [MIGRATION_LOCK]);
    lock = Number(rows[0]?.adquirido) === 1;
    if (!lock) throw new Error("Otra migración de políticas está ejecutándose");
    await ejecutarMigracion(connection, opciones);
  } finally {
    if (lock) await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]).catch(() => {});
    await connection.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error("Error migrando políticas de cancelación:", error.message);
  process.exitCode = 1;
});

module.exports = { MIGRATION_ID, TABLAS, parsearArgumentos, validarDestino, ejecutarMigracion };
