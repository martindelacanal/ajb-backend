"use strict";

// Migración v2 de los holds de Turismo: latido del formulario.
//
// Hasta v1 un hold abandonado (navegador cerrado de golpe, sin red, proceso
// muerto) quedaba retenido hasta sus 20 minutos. Con v2 `vence_en` pasa a ser
// un plazo corto que el formulario renueva con cada latido, y el tope de 20
// minutos que ve la persona se guarda aparte. Esta migración sólo agrega:
//
//   vence_max_en      DATETIME(6) NULL  tope de 20 minutos (lo que ve el usuario)
//   ultimo_latido_en  DATETIME(6) NULL  diagnóstico: última señal de vida
//   motivo_cierre     VARCHAR(24) NULL  TIEMPO | ABANDONO | REEMPLAZADO | LIBERADO
//
// y copia `vence_max_en = vence_en` en las filas existentes. Las columnas son
// NULL-ables a propósito: el backend anterior puede seguir insertando entre la
// migración y el deploy. No toca índices, CHECKs ni el enum `estado`, así que
// `npm run migrate:turismo-holds:check` (v1) sigue en verde con el mismo checksum.
// Espejo de BD/MIGRACION_TURISMO_HOLDS_V2_LATIDO.md.
//
// Uso:
//   node scripts/migrar-turismo-holds-v2-latido.js --check             → sólo informa (sin DDL ni DML)
//   node scripts/migrar-turismo-holds-v2-latido.js                     → aplica en develop (DB_HOST local)
//   node scripts/migrar-turismo-holds-v2-latido.js --allow-production  → obligatorio si DB_HOST no es local
//   node scripts/migrar-turismo-holds-v2-latido.js --skip-grants       → no intenta el GRANT al runtime
//
// Hace falta una cuenta con ALTER (root local en develop, admin en la RDS): pasá
// las credenciales por entorno, dotenv no pisa lo ya definido.
// TLS: si DB_SSL_MODE es verify-ca o verify-full se conecta con DB_SSL_CA_PATH.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MIGRATION_ID = "20260924_turismo_reserva_holds_latido_v2";
const MIGRATION_REVISION = 1;
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;
const TABLE_NAME = "turismo_reserva_hold";
const USUARIO_RUNTIME = "miajb_runtime";
const PRIVILEGIOS_RUNTIME = ["SELECT", "INSERT", "UPDATE", "DELETE"];

// Orden de aplicación: cada columna queda después de la anterior de referencia.
const COLUMNAS_V2 = [
  {
    nombre: "vence_max_en",
    tipo: "datetime(6)",
    ddl: `ALTER TABLE ${TABLE_NAME} ADD COLUMN vence_max_en DATETIME(6) NULL AFTER vence_en`,
  },
  {
    nombre: "ultimo_latido_en",
    tipo: "datetime(6)",
    ddl: `ALTER TABLE ${TABLE_NAME} ADD COLUMN ultimo_latido_en DATETIME(6) NULL AFTER vence_max_en`,
  },
  {
    nombre: "motivo_cierre",
    tipo: "varchar(24)",
    ddl: `ALTER TABLE ${TABLE_NAME} ADD COLUMN motivo_cierre VARCHAR(24) NULL AFTER fecha_cierre`,
  },
];

const BACKFILL_SQL = `UPDATE ${TABLE_NAME} SET vence_max_en = vence_en WHERE vence_max_en IS NULL`;

const MIGRATION_CHECKSUM = crypto
  .createHash("sha256")
  .update(JSON.stringify({ revision: MIGRATION_REVISION, columnas: COLUMNAS_V2, backfill: BACKFILL_SQL }))
  .digest("hex");

function parsearArgumentos(argv = process.argv.slice(2)) {
  const desconocidos = argv.filter((arg) => !["--check", "--allow-production", "--skip-grants"].includes(arg));
  if (desconocidos.length > 0) {
    throw new Error(`Argumentos desconocidos: ${desconocidos.join(" ")}`);
  }
  return {
    checkOnly: argv.includes("--check"),
    allowProduction: argv.includes("--allow-production"),
    skipGrants: argv.includes("--skip-grants"),
  };
}

function esHostLocal(host) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(host || "").trim().toLowerCase());
}

function validarDestino(opciones, env = process.env) {
  for (const variable of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!env[variable]) throw new Error(`Falta la variable de entorno ${variable}`);
  }
  const remoto = !esHostLocal(env.DB_HOST);
  const produccion = String(env.NODE_ENV || "").trim().toLowerCase() === "production";
  if ((remoto || produccion) && !opciones.checkOnly && !opciones.allowProduction) {
    throw new Error(
      `DB_HOST=${env.DB_HOST} no es local. Para aplicar contra producción agregá --allow-production.`
    );
  }
  return { remoto, produccion };
}

function configuracionTls(env = process.env) {
  const modo = String(env.DB_SSL_MODE || "disabled").trim().toLowerCase();
  if (modo === "disabled") return undefined;
  if (!["verify-ca", "verify-full"].includes(modo)) {
    throw new Error("DB_SSL_MODE debe ser disabled, verify-ca o verify-full");
  }
  const caPath = String(env.DB_SSL_CA_PATH || "").trim();
  if (!caPath || !fs.existsSync(caPath)) {
    throw new Error("DB_SSL_CA_PATH debe apuntar a un certificado existente cuando TLS está habilitado");
  }
  return { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
}

async function existeTabla(connection) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [TABLE_NAME]
  );
  return Number(rows[0]?.total) > 0;
}

async function leerColumna(connection, nombre) {
  const [rows] = await connection.query(
    `SELECT COLUMN_TYPE, IS_NULLABLE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
      LIMIT 1`,
    [TABLE_NAME, nombre]
  );
  return rows[0] || null;
}

function validarColumna(columna, actual) {
  if (String(actual.COLUMN_TYPE || "").toLowerCase() !== columna.tipo) {
    throw new Error(`${TABLE_NAME}.${columna.nombre} existe con un tipo incompatible (${actual.COLUMN_TYPE})`);
  }
  if (String(actual.IS_NULLABLE || "").toUpperCase() !== "YES") {
    throw new Error(`${TABLE_NAME}.${columna.nombre} debe admitir NULL para convivir con el backend anterior`);
  }
}

async function contarSinTope(connection) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total FROM ${TABLE_NAME} WHERE vence_max_en IS NULL`
  );
  return Number(rows[0]?.total || 0);
}

// --- GRANT al runtime (patrón de migrar-beneficios.js) ---------------------
// Los permisos a nivel tabla cubren las columnas nuevas; esto sólo completa lo
// que falte (en develop el runtime no tenía ninguno sobre esta tabla).
const CODIGOS_SIN_PERMISO_GRANT = new Set([
  "ER_ACCESS_DENIED_ERROR",
  "ER_DBACCESS_DENIED_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_SPECIFIC_ACCESS_DENIED_ERROR",
  "ER_CANT_CREATE_USER_WITH_GRANT",
  "ER_NONEXISTING_GRANT",
  "ER_PASSWORD_NO_MATCH",
]);

async function cuentasRuntime(connection) {
  try {
    const [rows] = await connection.query("SELECT user, host FROM mysql.user WHERE user = ?", [USUARIO_RUNTIME]);
    return rows.map((row) => ({ user: row.user, host: row.host }));
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
    return null;
  }
}

async function privilegiosFaltantes(connection, cuenta, esquema) {
  const grantee = `'${cuenta.user}'@'${cuenta.host}'`;
  const [rows] = await connection.query(
    `SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?
     UNION
     SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ? AND TABLE_SCHEMA = ?
     UNION
     SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES
      WHERE GRANTEE = ? AND TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [grantee, grantee, esquema, grantee, esquema, TABLE_NAME]
  );
  const actuales = new Set(rows.map((row) => String(row.PRIVILEGE_TYPE || "").toUpperCase()));
  return PRIVILEGIOS_RUNTIME.filter((privilegio) => !actuales.has(privilegio));
}

async function asegurarGrantsRuntime(connection, { checkOnly }) {
  if (process.env.DB_USER === USUARIO_RUNTIME) {
    console.warn(`  · Conectado como ${USUARIO_RUNTIME}: no puede revisar ni otorgarse permisos. Revisalo con la cuenta administrativa.`);
    return { pendientes: [] };
  }
  const cuentas = await cuentasRuntime(connection);
  if (cuentas === null) {
    console.warn(`  · Sin permiso para leer mysql.user: no se revisaron los GRANTs de ${USUARIO_RUNTIME}.`);
    return { pendientes: [] };
  }
  if (cuentas.length === 0) {
    console.log(`  · No existe la cuenta ${USUARIO_RUNTIME} en esta base: no hay GRANTs que revisar.`);
    return { pendientes: [] };
  }
  const esquema = process.env.DB_DATABASE;
  const pendientes = [];
  for (const cuenta of cuentas) {
    const faltantes = await privilegiosFaltantes(connection, cuenta, esquema);
    const etiqueta = `'${cuenta.user}'@'${cuenta.host}'`;
    if (faltantes.length === 0) {
      console.log(`  ✔ ${etiqueta} ya tiene SELECT, INSERT, UPDATE, DELETE sobre ${TABLE_NAME}`);
      continue;
    }
    const sentencia = `GRANT ${faltantes.join(", ")} ON ${connection.escapeId(esquema)}.${connection.escapeId(TABLE_NAME)} TO ${connection.escape(cuenta.user)}@${connection.escape(cuenta.host)}`;
    pendientes.push({ etiqueta, sentencia });
  }
  if (pendientes.length === 0) return { pendientes };
  if (checkOnly) {
    for (const pendiente of pendientes) console.log(`  [PENDIENTE] ${pendiente.sentencia}`);
    return { pendientes };
  }
  try {
    for (const pendiente of pendientes) {
      await connection.query(pendiente.sentencia);
      console.log(`  ✔ ${pendiente.sentencia}`);
    }
    await connection.query("FLUSH PRIVILEGES");
    console.log("  ✔ FLUSH PRIVILEGES");
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
    console.warn(
      `  · Aviso: no se pudieron otorgar los permisos (${error.code}: ${error.message}).\n` +
        "    Corré con la cuenta administrativa:\n" +
        pendientes.map((pendiente) => `      ${pendiente.sentencia};`).join("\n") +
        "\n      FLUSH PRIVILEGES;"
    );
  }
  return { pendientes };
}

// --- Registro en ajb_schema_migration (mismo esquema que v1) ---------------
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
     VALUES (?, ?, ?, 'APLICANDO', 'columnas_latido', NULL, '', '')
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision), estado = 'APLICANDO', etapa = 'columnas_latido',
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
    [estado, estado === "APLICADA" ? "completa" : "columnas_latido", detalle, estado, MIGRATION_ID]
  );
}

async function ejecutarMigracion(connection, { checkOnly = false } = {}) {
  if (!(await existeTabla(connection))) {
    throw new Error(`Falta la tabla ${TABLE_NAME}: corré primero npm run migrate:turismo-holds (v1)`);
  }
  const agregadas = [];
  const pendientes = [];
  for (const columna of COLUMNAS_V2) {
    const actual = await leerColumna(connection, columna.nombre);
    if (actual) {
      validarColumna(columna, actual);
      console.log(`  · ${TABLE_NAME}.${columna.nombre} ya existía`);
      continue;
    }
    if (checkOnly) {
      console.log(`  [PENDIENTE] ${columna.ddl}`);
      pendientes.push(columna.nombre);
      continue;
    }
    await connection.query(columna.ddl);
    validarColumna(columna, await leerColumna(connection, columna.nombre));
    console.log(`  ✔ ${TABLE_NAME}.${columna.nombre} agregada`);
    agregadas.push(columna.nombre);
  }

  let rellenadas = 0;
  if (pendientes.includes("vence_max_en")) {
    console.log(`  [PENDIENTE] ${BACKFILL_SQL}`);
  } else if (checkOnly) {
    const sinTope = await contarSinTope(connection);
    if (sinTope > 0) console.log(`  [PENDIENTE] ${BACKFILL_SQL} (${sinTope} filas)`);
  } else {
    const [resultado] = await connection.query(BACKFILL_SQL);
    rellenadas = Number(resultado.affectedRows || 0);
    console.log(`  ✔ vence_max_en = vence_en en ${rellenadas} filas existentes`);
    const sinTope = await contarSinTope(connection);
    if (sinTope > 0) throw new Error(`Quedaron ${sinTope} holds sin vence_max_en`);
  }
  return { agregadas, pendientes, rellenadas };
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  validarDestino(opciones);
  const mysql = require("mysql2/promise");
  console.log(
    `${opciones.checkOnly ? "Chequeando" : "Migrando"} ${process.env.DB_HOST}/${process.env.DB_DATABASE} como ${process.env.DB_USER}...`
  );
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: Number(process.env.DB_PORT || 3306),
    timezone: "-03:00",
    ssl: configuracionTls(),
  });
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
    console.log(`Columnas de latido en ${TABLE_NAME}`);
    await ejecutarMigracion(connection, opciones);
    if (opciones.skipGrants) {
      console.log("Se omite la revisión de GRANTs (--skip-grants).");
    } else {
      console.log(`Permisos de '${USUARIO_RUNTIME}' sobre ${TABLE_NAME}`);
      await asegurarGrantsRuntime(connection, opciones);
    }
    if (migracionRegistrada) await marcarMigracion(connection, "APLICADA");
    console.log(opciones.checkOnly
      ? "Chequeo de holds v2 (latido) completado sin cambios."
      : `Migracion ${MIGRATION_ID} aplicada.`);
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
        // Cerrar la conexión también libera el advisory lock.
      }
    }
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error en la migracion de holds v2 (latido):", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  BACKFILL_SQL,
  COLUMNAS_V2,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  TABLE_NAME,
  ejecutarMigracion,
  parsearArgumentos,
  validarDestino,
};
