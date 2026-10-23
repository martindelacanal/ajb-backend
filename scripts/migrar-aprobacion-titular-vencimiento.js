"use strict";

// Plazo de 48 horas para que el titular responda la solicitud de un familiar (2026-10-23).
//
//   reserva_aprobacion_titular.vence_en  DATETIME NULL: hasta cuándo puede responder (48 h desde
//                                        la solicitud, sin pasar del día del ingreso ni, en un
//                                        sorteo, del último día de inscripción). Lo calcula el backend.
//   reserva_aprobacion_titular.decision  suma 'VENCIDA' (se dio de baja sola por falta de respuesta).
//   idx_rat_vence (decision, vence_en)   para el mantenimiento que las da de baja cada 5 minutos.
//
// Las solicitudes PENDIENTE que ya existían reciben 48 horas desde que corre la migración (no
// sabían del plazo). La tabla ya tiene GRANT para el runtime: la columna nueva queda cubierta.
// Va ANTES del backend: sin la columna, las altas de un familiar responden 500.
//
//   node scripts/migrar-aprobacion-titular-vencimiento.js --check             → sólo informa
//   node scripts/migrar-aprobacion-titular-vencimiento.js                     → aplica (base local)
//   node scripts/migrar-aprobacion-titular-vencimiento.js --allow-production  → obligatorio si DB_HOST no es local

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const TABLA = "reserva_aprobacion_titular";
const PLAZO_HORAS = 48;
const DECISIONES = ["PENDIENTE", "APROBADA", "RECHAZADA", "CANCELADA", "VENCIDA"];
const CAMBIOS = {
  decision: `ALTER TABLE ${TABLA} MODIFY COLUMN decision ENUM(${DECISIONES.map((d) => `'${d}'`).join(",")}) NOT NULL DEFAULT 'PENDIENTE'`,
  vence_en: `ALTER TABLE ${TABLA} ADD COLUMN vence_en DATETIME NULL DEFAULT NULL `
    + "COMMENT 'Hasta cuándo puede responder el titular' AFTER fecha_solicitud",
  idx_rat_vence: `ALTER TABLE ${TABLA} ADD INDEX idx_rat_vence (decision, vence_en)`,
};

async function estadoActual(connection) {
  const [columnas] = await connection.query(
    `SELECT COLUMN_NAME AS nombre, COLUMN_TYPE AS tipo FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [TABLA]);
  if (!columnas.length) throw new Error(`Falta la tabla ${TABLA}: corré antes scripts/migrar-reservas-aprobacion-titular.js`);
  const [indices] = await connection.query(
    `SELECT DISTINCT INDEX_NAME AS nombre FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [TABLA]);
  const tipos = new Map(columnas.map((columna) => [columna.nombre, String(columna.tipo)]));
  return {
    decisionConVencida: /'VENCIDA'/.test(tipos.get("decision") || ""),
    tieneVenceEn: tipos.has("vence_en"),
    tieneIndice: indices.some((indice) => indice.nombre === "idx_rat_vence"),
  };
}

async function migrar(connection, { checkOnly = false } = {}) {
  // Hora de Argentina, como la sesión de la API: fecha_solicitud y vence_en se guardan así.
  await connection.query("SET SESSION time_zone = '-03:00'");
  const actual = await estadoActual(connection);
  const pendientes = [];
  if (!actual.decisionConVencida) pendientes.push(CAMBIOS.decision);
  if (!actual.tieneVenceEn) pendientes.push(CAMBIOS.vence_en);
  if (!actual.tieneIndice) pendientes.push(CAMBIOS.idx_rat_vence);
  let sinVencimiento = 0;
  if (actual.tieneVenceEn) {
    const [[fila]] = await connection.query(
      `SELECT COUNT(*) AS n FROM ${TABLA} WHERE decision = 'PENDIENTE' AND vence_en IS NULL`);
    sinVencimiento = Number(fila.n);
  } else {
    const [[fila]] = await connection.query(`SELECT COUNT(*) AS n FROM ${TABLA} WHERE decision = 'PENDIENTE'`);
    sinVencimiento = Number(fila.n);
  }
  if (checkOnly) return { pendientes, solicitudes_sin_vencimiento: sinVencimiento };

  await connection.query("SET SESSION lock_wait_timeout = 10");
  for (const sql of pendientes) await connection.query(sql);
  const [completadas] = await connection.query(
    `UPDATE ${TABLA} SET vence_en = NOW() + INTERVAL ${PLAZO_HORAS} HOUR
      WHERE decision = 'PENDIENTE' AND vence_en IS NULL`);
  return { aplicados: pendientes.length, solicitudes_con_plazo_nuevo: Number(completadas.affectedRows || 0) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--check", "--allow-production"].includes(arg))) throw new Error("Argumento no reconocido");
  const checkOnly = args.includes("--check");
  if (!checkOnly && !["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST) && !args.includes("--allow-production")) {
    throw new Error("Para migrar una base remota se requiere --allow-production");
  }
  const modoTls = process.env.DB_SSL_MODE || "disabled";
  const connection = await require("mysql2/promise").createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, port: Number(process.env.DB_PORT || 3306), timezone: "-03:00",
    ssl: modoTls === "disabled" ? undefined : { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true },
  });
  const lock = "ajb:migration:aprobacion_titular_vencimiento_v1";
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 10) AS adquirido", [lock]);
    if (Number(locks[0]?.adquirido) !== 1) throw new Error("No se pudo bloquear la migración");
    console.log(`${checkOnly ? "Chequeando" : "Migrando"} ${process.env.DB_HOST}/${process.env.DB_DATABASE}`);
    console.log(JSON.stringify(await migrar(connection, { checkOnly }), null, 2));
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lock]);
    await connection.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { TABLA, PLAZO_HORAS, DECISIONES, CAMBIOS, migrar };
