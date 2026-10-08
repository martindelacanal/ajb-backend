"use strict";

// Ejecutar antes del backend nuevo. Migración aditiva: conserva todos los
// estados, chats e historiales actuales. --check sólo inspecciona el esquema.
require("dotenv").config();
const mysql = require("mysql2/promise");
const fs = require("node:fs");

const DDL_CHAT = `CREATE TABLE IF NOT EXISTS servicio_observacion (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  servicio_id INT NOT NULL,
  recurso_id INT NULL,
  usuario_id INT NULL,
  usuario_rol VARCHAR(40) NOT NULL,
  usuario_nombre VARCHAR(255) NULL,
  usuario_apellido VARCHAR(255) NULL,
  mensaje TEXT NOT NULL,
  estado_aprobacion VARCHAR(40) NOT NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_servicio_observacion_hilo (servicio_id, id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;
const SQL_INCLUIR_PROPIETARIAS = `INSERT IGNORE INTO servicio_departamental_visible (servicio_id, departamental_id)
  SELECT id, propietario_departamental_id FROM servicio
  WHERE alcance_departamental = 'SELECCIONADAS' AND propietario_departamental_id IS NOT NULL`;

function validarEntorno(env, { permiteProduccion = false } = {}) {
  for (const campo of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!env[campo]) throw new Error(`Falta la variable ${campo}`);
  }
  if (!["localhost", "127.0.0.1"].includes(env.DB_HOST) && !permiteProduccion) {
    throw new Error("Para migrar una base remota agregá --allow-production");
  }
  if (!/^[A-Za-z0-9_]+$/.test(env.DB_DATABASE)) throw new Error("DB_DATABASE inválida");
}

function ampliarEnum(tipo) {
  if (!/^enum\((?:'[^']+'(?:,|(?=\))))+\)$/i.test(tipo || "")) {
    throw new Error("servicio.estado_aprobacion debe ser ENUM; revisar el esquema antes de migrar");
  }
  if (tipo.includes("'EN_REVISION'")) return null;
  // Agregar al final evita cambiar el índice interno de los valores previos.
  return tipo.slice(0, -1) + ",'EN_REVISION')";
}

async function ejecutarMigracion(connection, { check = false, env = process.env, skipGrants = false, log = console.log } = {}) {
  const [[columna]] = await connection.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'servicio' AND COLUMN_NAME = 'estado_aprobacion'`
  );
  const enumAmpliado = ampliarEnum(columna?.COLUMN_TYPE);
  const [tablas] = await connection.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'servicio_observacion'`
  );
  const resultado = { requiereEnum: Boolean(enumAmpliado), requiereChat: !tablas.length, check };
  if (check) {
    log(JSON.stringify(resultado));
    return resultado;
  }
  await connection.query(DDL_CHAT);
  if (enumAmpliado) {
    await connection.query(`ALTER TABLE servicio MODIFY COLUMN estado_aprobacion ${enumAmpliado} NOT NULL DEFAULT 'APROBADO'`);
  }
  const [incluidas] = await connection.query(SQL_INCLUIR_PROPIETARIAS);
  resultado.propietariasIncluidas = Number(incluidas.affectedRows || 0);
  if (!skipGrants) {
    const [cuentas] = await connection.query("SELECT user, host FROM mysql.user WHERE user = ?", ["miajb_runtime"]);
    for (const cuenta of cuentas) {
      await connection.query(
        `GRANT SELECT, INSERT ON ${mysql.escapeId(env.DB_DATABASE)}.servicio_observacion TO ${mysql.escape(cuenta.user)}@${mysql.escape(cuenta.host)}`
      );
    }
    resultado.cuentasRuntime = cuentas.length;
  }
  log("Chat de servicios y estado EN_REVISION listos; registros históricos conservados.");
  return resultado;
}

async function main({ argv = process.argv, env = process.env } = {}) {
  const args = argv.slice(2);
  validarEntorno(env, { permiteProduccion: args.includes("--allow-production") });
  const tls = String(env.DB_SSL_MODE || 'disabled').toLowerCase();
  const remoto = !["localhost", "127.0.0.1", "::1"].includes(env.DB_HOST);
  if (!["disabled", "verify-ca", "verify-full"].includes(tls)) throw new Error("DB_SSL_MODE inválido");
  if (remoto && tls === "disabled") throw new Error("La conexión remota requiere TLS de base de datos");
  if (tls !== "disabled" && !env.DB_SSL_CA_PATH) throw new Error("Falta DB_SSL_CA_PATH");
  const connection = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_DATABASE, port: env.DB_PORT || 3306, timezone: "-03:00",
    ssl: tls === "disabled" ? undefined : { ca: fs.readFileSync(env.DB_SSL_CA_PATH), rejectUnauthorized: true },
  });
  try {
    return await ejecutarMigracion(connection, {
      check: args.includes("--check"), skipGrants: args.includes("--skip-grants"), env,
    });
  } finally { await connection.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { DDL_CHAT, SQL_INCLUIR_PROPIETARIAS, ampliarEnum, ejecutarMigracion, validarEntorno };
