"use strict";

// Índices para las búsquedas del grupo familiar.
//
// services/usuarios-datos.js recorre el grupo de un titular con
//   SELECT ... FROM usuario WHERE usuario_familiar_id IN (?) FOR UPDATE
// y corrige reservas abiertas de una persona con
//   SELECT ... FROM reserva_familiar rf ... WHERE rf.usuario_id = ? ... FOR UPDATE OF rf
// Sin índice sobre esas columnas InnoDB recorre (y BLOQUEA hasta el commit)
// todas las filas de la tabla: una edición de datos frenaba cualquier otra
// escritura sobre usuario o reserva_familiar. Con estos índices el bloqueo
// queda acotado a las filas del grupo / de la persona.
//
//   usuario(usuario_familiar_id)     → idx_usuario_familiar
//   reserva_familiar(usuario_id)     → idx_rf_usuario
//
// Idempotente: antes de cada ADD INDEX mira information_schema.STATISTICS y,
// si ya hay CUALQUIER índice cuya primera columna es la buscada (con el nombre
// que sea), no crea otro. Si el nombre ya existe sobre otras columnas, frena.
// Se crean en línea (ALGORITHM=INPLACE, LOCK=NONE): no bloquean lecturas ni
// escrituras mientras se construyen. No toca GRANTs: los índices no los necesitan.
// Registra la corrida en ajb_schema_migration (mismo esquema que las demás).
// Espejo de BD/MIGRACION_INDICES_FAMILIA.md.
//
// Uso:
//   node scripts/migrar-indices-familia.js --check             → sólo informa (sin DDL)
//   node scripts/migrar-indices-familia.js                     → aplica en develop (DB_HOST local)
//   node scripts/migrar-indices-familia.js --allow-production  → obligatorio si DB_HOST no es local
//
// Hace falta una cuenta con ALTER e INDEX (root local en develop, admin en la
// RDS): pasá las credenciales por entorno, dotenv no pisa lo ya definido.
// TLS: si DB_SSL_MODE es verify-ca o verify-full se conecta con DB_SSL_CA_PATH.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MIGRATION_ID = "20260924_indices_familia_v1";
const MIGRATION_REVISION = 1;
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;

const INDICES = Object.freeze([
  Object.freeze({
    tabla: "usuario",
    columna: "usuario_familiar_id",
    nombre: "idx_usuario_familiar",
    ddl: "ALTER TABLE usuario ADD INDEX idx_usuario_familiar (usuario_familiar_id), ALGORITHM=INPLACE, LOCK=NONE",
  }),
  Object.freeze({
    tabla: "reserva_familiar",
    columna: "usuario_id",
    nombre: "idx_rf_usuario",
    ddl: "ALTER TABLE reserva_familiar ADD INDEX idx_rf_usuario (usuario_id), ALGORITHM=INPLACE, LOCK=NONE",
  }),
]);

const MIGRATION_CHECKSUM = crypto
  .createHash("sha256")
  .update(JSON.stringify({ revision: MIGRATION_REVISION, indices: INDICES }))
  .digest("hex");

function parsearArgumentos(argv = process.argv.slice(2)) {
  const desconocidos = argv.filter((arg) => !["--check", "--allow-production"].includes(arg));
  if (desconocidos.length > 0) {
    throw new Error(`Argumentos desconocidos: ${desconocidos.join(" ")}`);
  }
  return {
    checkOnly: argv.includes("--check"),
    allowProduction: argv.includes("--allow-production"),
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

async function existeTabla(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tabla]
  );
  return Number(rows[0]?.total) > 0;
}

/** Índices de la tabla agrupados por nombre: Map<nombre, columnas en orden>. */
async function leerIndices(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [tabla]
  );
  const indices = new Map();
  for (const fila of rows) {
    const nombre = String(fila.INDEX_NAME);
    if (!indices.has(nombre)) indices.set(nombre, []);
    indices.get(nombre)[Number(fila.SEQ_IN_INDEX) - 1] = String(fila.COLUMN_NAME || "").toLowerCase();
  }
  return indices;
}

/**
 * ¿Ya hay un índice que sirva? Cualquiera cuya PRIMERA columna sea la buscada
 * (un índice compuesto también sirve para filtrar por su primera columna).
 * Devuelve { nombre, columnas } o null. Si el nombre que queremos usar ya está
 * tomado por un índice sobre otras columnas, lanza un error.
 */
function buscarIndiceEquivalente(indices, definicion) {
  const columna = definicion.columna.toLowerCase();
  for (const [nombre, columnas] of indices) {
    if (columnas[0] === columna) return { nombre, columnas };
  }
  if (indices.has(definicion.nombre)) {
    throw new Error(
      `${definicion.tabla} ya tiene un índice ${definicion.nombre} sobre (${indices.get(definicion.nombre).join(", ")}), ` +
        `no sobre ${definicion.columna}. Revisalo a mano antes de seguir.`
    );
  }
  return null;
}

async function ejecutarMigracion(connection, { checkOnly = false, log = console.log } = {}) {
  const creados = [];
  const existentes = [];
  const pendientes = [];
  for (const definicion of INDICES) {
    if (!(await existeTabla(connection, definicion.tabla))) {
      throw new Error(`Falta la tabla ${definicion.tabla}`);
    }
    const equivalente = buscarIndiceEquivalente(await leerIndices(connection, definicion.tabla), definicion);
    if (equivalente) {
      log(`  · ${definicion.tabla}(${definicion.columna}) ya tiene índice: ${equivalente.nombre} (${equivalente.columnas.join(", ")})`);
      existentes.push(`${definicion.tabla}.${equivalente.nombre}`);
      continue;
    }
    if (checkOnly) {
      log(`  [PENDIENTE] ${definicion.ddl}`);
      pendientes.push(`${definicion.tabla}.${definicion.nombre}`);
      continue;
    }
    await connection.query(definicion.ddl);
    const verificado = buscarIndiceEquivalente(await leerIndices(connection, definicion.tabla), definicion);
    if (!verificado) throw new Error(`No se pudo verificar el índice ${definicion.nombre} en ${definicion.tabla}`);
    log(`  ✔ ${definicion.tabla}.${definicion.nombre} (${definicion.columna}) creado`);
    creados.push(`${definicion.tabla}.${definicion.nombre}`);
  }
  return { creados, existentes, pendientes };
}

// --- Registro en ajb_schema_migration (mismo esquema que las demás) --------
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
     VALUES (?, ?, ?, 'APLICANDO', 'indices', NULL, '', '')
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision), estado = 'APLICANDO', etapa = 'indices',
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
    [estado, estado === "APLICADA" ? "completa" : "indices", detalle, estado, MIGRATION_ID]
  );
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
    console.log("Índices del grupo familiar");
    const resultado = await ejecutarMigracion(connection, opciones);
    if (migracionRegistrada) {
      await marcarMigracion(
        connection,
        "APLICADA",
        `creados: ${resultado.creados.join(", ") || "-"}; ya existían: ${resultado.existentes.join(", ") || "-"}`
      );
    }
    console.log(opciones.checkOnly
      ? `Chequeo completado sin cambios (${resultado.pendientes.length} índice(s) pendiente(s)).`
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
    console.error("Error en la migracion de índices del grupo familiar:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  INDICES,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  buscarIndiceEquivalente,
  ejecutarMigracion,
  leerIndices,
  parsearArgumentos,
  validarDestino,
};
