"use strict";

const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// Reutiliza la configuracion operativa del backend: TLS segun DB_SSL_MODE/CA,
// timezone de Argentina, limite de conexiones y multipleStatements desactivado.
const mysqlConnection = require("../api/connection/connection");

const CONFIRMACION = "MIGRAR_PREFERENCIAS_MODULOS_CONTACTO";

const COLUMNAS = [
  {
    nombre: "modulo_turismo",
    definicion: "TINYINT(1) NOT NULL DEFAULT 1 AFTER area_coseguro",
  },
  {
    nombre: "modulo_coseguro",
    definicion: "TINYINT(1) NOT NULL DEFAULT 1 AFTER modulo_turismo",
  },
  {
    nombre: "modulo_olimpiadas",
    definicion: "TINYINT(1) NOT NULL DEFAULT 1 AFTER modulo_coseguro",
  },
  {
    nombre: "direccion",
    definicion: "VARCHAR(50) NULL AFTER telefono",
  },
  {
    nombre: "dependencia_judicial",
    definicion: "VARCHAR(50) NULL AFTER direccion",
  },
];

function argumentos(argv) {
  const valores = new Map();
  for (const item of argv.slice(2)) {
    if (!item.startsWith("--")) continue;
    const [clave, ...resto] = item.slice(2).split("=");
    valores.set(clave, resto.length > 0 ? resto.join("=") : true);
  }
  return valores;
}

function exigirEntorno(env = process.env) {
  for (const nombre of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!env[nombre]) throw new Error(`Falta ${nombre} en BACKEND/.env`);
  }
  if (!/^[A-Za-z0-9_]+$/.test(env.DB_DATABASE)) {
    throw new Error("DB_DATABASE contiene caracteres no permitidos");
  }
}

async function columnasExistentes(connection, database) {
  const [filas] = await connection.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'usuario'`,
    [database]
  );
  return new Set(filas.map((fila) => fila.COLUMN_NAME));
}

async function main({
  argv = process.argv,
  env = process.env,
  pool = mysqlConnection,
  logger = console,
} = {}) {
  exigirEntorno(env);
  const args = argumentos(argv);
  const aplicar = args.get("apply") === true;
  if (aplicar && args.get("confirm") !== CONFIRMACION) {
    throw new Error(`La escritura exige --confirm=${CONFIRMACION}`);
  }

  const promisePool = pool.promise();
  let connection;

  try {
    connection = await promisePool.getConnection();
    const existentes = await columnasExistentes(connection, env.DB_DATABASE);
    const pendientes = COLUMNAS.filter((columna) => !existentes.has(columna.nombre));
    logger.log(JSON.stringify({
      mode: aplicar ? "apply" : "dry-run-read-only",
      database: env.DB_DATABASE,
      table: "usuario",
      pending_columns: pendientes.map((columna) => columna.nombre),
    }, null, 2));

    if (!aplicar || pendientes.length === 0) return;

    for (const columna of pendientes) {
      if (!/^[a-z0-9_]+$/.test(columna.nombre)) {
        throw new Error(`Nombre de columna no seguro: ${columna.nombre}`);
      }
      await connection.query(
        `ALTER TABLE usuario ADD COLUMN \`${columna.nombre}\` ${columna.definicion}`
      );
      logger.log(`[OK] usuario.${columna.nombre}`);
    }

    const verificadas = await columnasExistentes(connection, env.DB_DATABASE);
    const faltantes = COLUMNAS.filter((columna) => !verificadas.has(columna.nombre));
    if (faltantes.length > 0) {
      throw new Error(`No se pudieron verificar columnas: ${faltantes.map((c) => c.nombre).join(", ")}`);
    }
  } finally {
    try {
      connection?.release();
    } finally {
      await promisePool.end();
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  COLUMNAS,
  CONFIRMACION,
  argumentos,
  columnasExistentes,
  exigirEntorno,
  main,
};
