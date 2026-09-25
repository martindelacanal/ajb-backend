"use strict";

// Estado de reserva "Cancelada".
//
// Hasta ahora, cuando el afiliado cancelaba su reserva Iniciada, el backend la
// guardaba como "Rechazada" porque el catálogo estado_reserva no tenía
// "Cancelada". Esta migración:
//
//   1. Da de alta estado_reserva (13, 'Cancelada'). El id es fijo porque
//      api/routes/user.js lo usa en ESTADOS_RESERVA_BAJA_IDS (las consultas de
//      solapamiento excluyen 4 y 13). Si 'Cancelada' ya existe con otro id, o
//      el 13 está tomado por otro nombre, frena sin tocar nada.
//   2. Reclasifica las cancelaciones pasadas: reservas regulares hoy en
//      "Rechazada" cuyo ÚLTIMO cambio de estado lo hizo el propio dueño con rol
//      afiliado (el afiliado sólo puede llegar a ese estado cancelando). Pasan a
//      "Cancelada" con una fila en historial_reserva (sin usuario: la hizo el
//      sistema). Los rechazos de Turismo y los vencimientos de 72 h no se tocan.
//
// Idempotente. Registra la corrida en ajb_schema_migration.
// Espejo de BD/MIGRACION_ESTADO_RESERVA_CANCELADA.md.
//
// Uso:
//   node scripts/migrar-estado-reserva-cancelada.js --check             → sólo informa
//   node scripts/migrar-estado-reserva-cancelada.js                     → aplica en develop (DB_HOST local)
//   node scripts/migrar-estado-reserva-cancelada.js --allow-production  → obligatorio si DB_HOST no es local
//
// TLS: si DB_SSL_MODE es verify-ca o verify-full se conecta con DB_SSL_CA_PATH.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MIGRATION_ID = "20260925_estado_reserva_cancelada_v1";
const MIGRATION_REVISION = 1;
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;

const ESTADO_CANCELADA = Object.freeze({ id: 13, nombre: "Cancelada" });
const ESTADO_RECHAZADA_ID = 4;
const OBSERVACION_RECLASIFICACION =
  "Reclasificación automática: la baja la pidió el afiliado, por eso queda como Cancelada y no como Rechazada.";

// Reservas regulares en Rechazada cuyo último cambio de estado lo hizo su dueño
// siendo afiliado (única forma en que un afiliado llega a Rechazada: cancelando).
const SQL_CANCELACIONES_PASADAS = `
  SELECT r.id
    FROM reserva r
    INNER JOIN historial_reserva h ON h.id = (
      SELECT MAX(h2.id)
        FROM historial_reserva h2
       WHERE h2.reserva_id = r.id AND h2.campo_modificado = 'estado_reserva_id'
    )
    INNER JOIN usuario u ON u.id = r.usuario_id
    INNER JOIN rol ro ON ro.id = u.rol_id
   WHERE r.estado_reserva_id = ?
     AND (r.modalidad IN ('FECHA_LIBRE', 'BLOQUE') OR r.modalidad IS NULL OR TRIM(CAST(r.modalidad AS CHAR)) = '')
     AND h.valor_nuevo = ?
     AND h.usuario_modificador_id = r.usuario_id
     AND ro.nombre = 'afiliado'
   ORDER BY r.id`;

const MIGRATION_CHECKSUM = crypto
  .createHash("sha256")
  .update(JSON.stringify({
    revision: MIGRATION_REVISION,
    estado: ESTADO_CANCELADA,
    sql: SQL_CANCELACIONES_PASADAS,
  }))
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

/** 'EXISTE' si ya está bien dado de alta, 'FALTA' si hay que insertarlo; lanza si hay conflicto. */
async function revisarCatalogo(connection) {
  const [rows] = await connection.query(
    "SELECT id, nombre FROM estado_reserva WHERE id = ? OR nombre = ? FOR UPDATE",
    [ESTADO_CANCELADA.id, ESTADO_CANCELADA.nombre]
  );
  const porNombre = rows.find((fila) => fila.nombre === ESTADO_CANCELADA.nombre);
  const porId = rows.find((fila) => Number(fila.id) === ESTADO_CANCELADA.id);
  if (porNombre && Number(porNombre.id) !== ESTADO_CANCELADA.id) {
    throw new Error(
      `'${ESTADO_CANCELADA.nombre}' ya existe con id ${porNombre.id}, pero el backend espera el ${ESTADO_CANCELADA.id}. Revisalo a mano.`
    );
  }
  if (porId && porId.nombre !== ESTADO_CANCELADA.nombre) {
    throw new Error(`El id ${ESTADO_CANCELADA.id} de estado_reserva ya es '${porId.nombre}'. Revisalo a mano.`);
  }
  return porId ? "EXISTE" : "FALTA";
}

async function ejecutarMigracion(connection, { checkOnly = false, log = console.log } = {}) {
  await connection.beginTransaction();
  try {
    const catalogo = await revisarCatalogo(connection);
    if (catalogo === "EXISTE") {
      log(`  · estado_reserva (${ESTADO_CANCELADA.id}, '${ESTADO_CANCELADA.nombre}') ya existe`);
    } else if (checkOnly) {
      log(`  [PENDIENTE] INSERT INTO estado_reserva (id, nombre) VALUES (${ESTADO_CANCELADA.id}, '${ESTADO_CANCELADA.nombre}')`);
    } else {
      await connection.query(
        "INSERT INTO estado_reserva (id, nombre) VALUES (?, ?)",
        [ESTADO_CANCELADA.id, ESTADO_CANCELADA.nombre]
      );
      log(`  ✔ estado_reserva (${ESTADO_CANCELADA.id}, '${ESTADO_CANCELADA.nombre}') creado`);
    }

    const [candidatas] = await connection.query(`${SQL_CANCELACIONES_PASADAS} FOR UPDATE`, [
      ESTADO_RECHAZADA_ID,
      String(ESTADO_RECHAZADA_ID),
    ]);
    const ids = candidatas.map((fila) => Number(fila.id));
    const reclasificadas = [];
    if (checkOnly) {
      log(`  ${ids.length} cancelación(es) del afiliado guardadas como Rechazada${ids.length ? `: ${ids.join(", ")}` : ""}`);
    } else {
      for (const id of ids) {
        const [resultado] = await connection.query(
          "UPDATE reserva SET estado_reserva_id = ?, fecha_modificacion = NOW() WHERE id = ? AND estado_reserva_id = ?",
          [ESTADO_CANCELADA.id, id, ESTADO_RECHAZADA_ID]
        );
        if (resultado.affectedRows !== 1) continue;
        await connection.query(
          `INSERT INTO historial_reserva
             (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo,
              usuario_modificador_id, observaciones)
           VALUES (?, 'UPDATE', 'estado_reserva_id', ?, ?, NULL, ?)`,
          [id, String(ESTADO_RECHAZADA_ID), String(ESTADO_CANCELADA.id), OBSERVACION_RECLASIFICACION]
        );
        reclasificadas.push(id);
      }
      log(`  ✔ ${reclasificadas.length} reserva(s) reclasificada(s) a Cancelada${reclasificadas.length ? `: ${reclasificadas.join(", ")}` : ""}`);
    }

    if (checkOnly) await connection.rollback();
    else await connection.commit();
    return { catalogo, candidatas: ids, reclasificadas };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // Se conserva el error original.
    }
    throw error;
  }
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
     VALUES (?, ?, ?, 'APLICANDO', 'estado', NULL, '', '')
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision), estado = 'APLICANDO', etapa = 'estado',
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
    [estado, estado === "APLICADA" ? "completa" : "estado", detalle, estado, MIGRATION_ID]
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
    console.log("Estado de reserva Cancelada");
    const resultado = await ejecutarMigracion(connection, opciones);
    if (migracionRegistrada) {
      await marcarMigracion(
        connection,
        "APLICADA",
        `catalogo: ${resultado.catalogo}; reclasificadas: ${resultado.reclasificadas.join(", ") || "-"}`
      );
    }
    console.log(opciones.checkOnly
      ? "Chequeo completado sin cambios."
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
    console.error("Error en la migracion del estado Cancelada:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  ESTADO_CANCELADA,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  SQL_CANCELACIONES_PASADAS,
  ejecutarMigracion,
  parsearArgumentos,
  revisarCatalogo,
  validarDestino,
};
