"use strict";

const CONFIRMACION = "APLICAR_NOTIFICACIONES_PREFERENCIAS";
const TABLA = "usuario_notificacion_preferencia";
const COLUMNAS = ["usuario_id", "mensajes", "estados", "gestiones", "novedades", "fecha_modificacion"];
const DDL = `CREATE TABLE IF NOT EXISTS usuario_notificacion_preferencia (
  usuario_id INT NOT NULL,
  mensajes TINYINT(1) NOT NULL DEFAULT 1,
  estados TINYINT(1) NOT NULL DEFAULT 1,
  gestiones TINYINT(1) NOT NULL DEFAULT 1,
  novedades TINYINT(1) NOT NULL DEFAULT 1,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (usuario_id),
  CONSTRAINT fk_unp_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

async function verificar(connection) {
  const [filas] = await connection.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [TABLA]
  );
  const existentes = new Set(filas.map((fila) => fila.COLUMN_NAME));
  return COLUMNAS.filter((columna) => !existentes.has(columna));
}

async function main({ argv = process.argv.slice(2), env = process.env, pool, logger = console } = {}) {
  const aplicar = argv.includes("--apply");
  if (aplicar && !argv.includes(`--confirm=${CONFIRMACION}`)) throw new Error(`Usá --confirm=${CONFIRMACION}`);
  for (const variable of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!env[variable]) throw new Error(`Falta ${variable}`);
  }
  if (!/^[A-Za-z0-9_]+$/.test(env.DB_DATABASE)) throw new Error("DB_DATABASE inválida");
  const hostLocal = ["localhost", "127.0.0.1", "::1"].includes(String(env.DB_HOST).toLowerCase());
  if (aplicar && !hostLocal && !argv.includes("--allow-production")) throw new Error("El host remoto exige --allow-production");
  const db = (pool || require("../api/connection/connection")).promise();
  const connection = await db.getConnection();
  try {
    const faltantes = await verificar(connection);
    logger.log(JSON.stringify({ mode: aplicar ? "apply" : "check", table: TABLA, database: env.DB_DATABASE, missing_columns: faltantes }));
    if (!aplicar) return;
    await connection.query(DDL);
    const faltantesDespues = await verificar(connection);
    if (faltantesDespues.length) throw new Error(`Faltan columnas: ${faltantesDespues.join(", ")}`);
    if (!argv.includes("--skip-grants")) {
      const [cuentas] = await connection.query("SELECT user, host FROM mysql.user WHERE user = ?", ["miajb_runtime"]);
      if (!cuentas.length) throw new Error("No se encontró la cuenta miajb_runtime para otorgar permisos");
      for (const cuenta of cuentas) {
        await connection.query(`GRANT SELECT, INSERT, UPDATE ON ${connection.escapeId(env.DB_DATABASE)}.${connection.escapeId(TABLA)} TO ${connection.escape(cuenta.user)}@${connection.escape(cuenta.host)}`);
      }
      logger.log("Permisos SELECT, INSERT, UPDATE otorgados a miajb_runtime");
    }
  } finally {
    connection.release();
    await db.end();
  }
}

if (require.main === module) {
  require("dotenv").config();
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { CONFIRMACION, TABLA, COLUMNAS, DDL, verificar, main };
