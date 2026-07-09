// Migración del módulo "Familiares y acompañantes"
//
// Agrega la columna usuario.es_familiar ('S' | 'N') para distinguir de forma
// explícita a los familiares del grupo familiar (cargados por el afiliado,
// usados también por el coseguro médico) de los acompañantes de viaje creados
// automáticamente durante una reserva.
//
// Backfill para vínculos existentes (usuario_familiar_id IS NOT NULL):
//   parentesco Pareja (2), Hijo (3) o Familiar (4)  -> 'S' (familiar)
//   resto (Titular, Otro o sin parentesco)          -> 'N' (acompañante)
//
// Uso: node scripts/migrar-familiares-acompaniantes.js

const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function assertEnvVar(value, name) {
  if (!value) {
    throw new Error(`Falta variable de entorno requerida: ${name}`);
  }
}

async function columnExists(connection, table, column) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS existe
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].existe > 0;
}

async function main() {
  assertEnvVar(process.env.DB_HOST, "DB_HOST");
  assertEnvVar(process.env.DB_USER, "DB_USER");
  assertEnvVar(process.env.DB_DATABASE, "DB_DATABASE");

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  });

  try {
    if (await columnExists(connection, "usuario", "es_familiar")) {
      console.log("La columna usuario.es_familiar ya existe. No hay nada para migrar.");
      return;
    }

    console.log("Agregando columna usuario.es_familiar...");
    await connection.query(
      `ALTER TABLE usuario
       ADD COLUMN es_familiar CHAR(1) NULL DEFAULT NULL
       COMMENT 'S: familiar del grupo familiar, N: acompañante de viaje'
       AFTER usuario_familiar_id`
    );

    console.log("Backfill de vínculos existentes...");
    const [familiares] = await connection.query(
      `UPDATE usuario
       SET es_familiar = 'S'
       WHERE usuario_familiar_id IS NOT NULL AND parentesco_id IN (2, 3, 4)`
    );
    const [acompaniantes] = await connection.query(
      `UPDATE usuario
       SET es_familiar = 'N'
       WHERE usuario_familiar_id IS NOT NULL AND es_familiar IS NULL`
    );

    console.log(`Listo. Familiares marcados: ${familiares.affectedRows}, acompañantes marcados: ${acompaniantes.affectedRows}.`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("Error en la migración:", error.message);
  process.exit(1);
});
