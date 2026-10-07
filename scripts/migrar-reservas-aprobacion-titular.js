"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const ESTADO = "Pendiente_Aprobacion_Titular";
const DDL = `CREATE TABLE IF NOT EXISTS reserva_aprobacion_titular (
  reserva_id INT NOT NULL PRIMARY KEY,
  solicitante_usuario_id INT NOT NULL,
  titular_usuario_id INT NOT NULL,
  estado_destino VARCHAR(50) NOT NULL,
  decision ENUM('PENDIENTE','APROBADA','RECHAZADA','CANCELADA') NOT NULL DEFAULT 'PENDIENTE',
  fecha_solicitud DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_respuesta DATETIME NULL,
  correo_enviado_en DATETIME NULL,
  correo_ultimo_intento_en DATETIME NULL,
  correo_intentos INT NOT NULL DEFAULT 0,
  correo_error VARCHAR(255) NULL,
  KEY idx_rat_titular (titular_usuario_id, decision, fecha_solicitud),
  KEY idx_rat_solicitante (solicitante_usuario_id, decision),
  KEY idx_rat_correo (decision, correo_enviado_en, correo_ultimo_intento_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

async function migrar(connection, { checkOnly = false } = {}) {
  const [estado] = await connection.query("SELECT id FROM estado_reserva WHERE nombre = ?", [ESTADO]);
  const [tablas] = await connection.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reserva_aprobacion_titular'");
  if (checkOnly) return { estado: estado.length > 0, tabla: tablas.length > 0 };
  await connection.query(DDL);
  // El catálogo histórico no siempre tiene AUTO_INCREMENT; se asigna bajo advisory lock de migración.
  if (!estado.length) await connection.query("INSERT INTO estado_reserva (id, nombre) SELECT COALESCE(MAX(id), 0) + 1, ? FROM estado_reserva", [ESTADO]);
  return { estado: true, tabla: true };
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
  const lock = "ajb:migration:reservas_aprobacion_titular_v1";
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 10) AS adquirido", [lock]);
    if (Number(locks[0]?.adquirido) !== 1) throw new Error("No se pudo bloquear la migración");
    console.log(JSON.stringify(await migrar(connection, { checkOnly })));
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lock]);
    await connection.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { ESTADO, DDL, migrar };
