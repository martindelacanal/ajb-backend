const crypto = require("crypto");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const mysqlConnection = require("../api/connection/connection");

const MIGRATION_ID = "20260819_reservas_plazos_72h_v1";
const MIGRATION_REVISION = 1;
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;
const DEFINICION = JSON.stringify({
  indexes: {
    reserva: [
      ["usuario_id", "estado_reserva_id", "modalidad", "fecha_creacion"],
      ["estado_reserva_id", "modalidad", "fecha_creacion"],
    ],
    reserva_convenio_propuesta: [["respuesta", "fecha_propuesta"]],
  },
  plazo_horas: 72,
});
const MIGRATION_CHECKSUM = crypto.createHash("sha256").update(DEFINICION).digest("hex");
const MODALIDAD_MIGRATION_ID = "20260820_reservas_modalidad_fecha_libre_v1";
const MODALIDAD_MIGRATION_REVISION = 1;
const MODALIDAD_DEFINICION = JSON.stringify({
  tabla: "reserva",
  columna: "modalidad",
  normaliza: ["NULL", "VACIA_O_ESPACIOS"],
  destino: "FECHA_LIBRE",
  esquema_objetivo: {
    nullable: false,
    default: "FECHA_LIBRE",
  },
});
const MODALIDAD_MIGRATION_CHECKSUM = crypto
  .createHash("sha256")
  .update(MODALIDAD_DEFINICION)
  .digest("hex");

async function existeTabla(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tabla]
  );
  return Number(rows[0]?.total) === 1;
}

function escaparLiteralSql(valor) {
  return String(valor).replace(/\\/g, "\\\\").replace(/'/g, "''");
}

function validarIdentificadorEsquema(valor, nombre) {
  if (valor === null || valor === undefined || valor === "") return null;
  const texto = String(valor);
  if (!/^[a-zA-Z0-9_]+$/.test(texto)) {
    throw new Error(`La columna modalidad tiene ${nombre} no seguro: ${texto}`);
  }
  return texto;
}

function evaluarColumnaModalidad(columna) {
  if (!columna) {
    throw new Error("Falta la columna requerida reserva.modalidad");
  }

  const dataType = String(columna.DATA_TYPE || "").trim().toLowerCase();
  const columnType = String(columna.COLUMN_TYPE || "").trim();
  const generationExpression = String(columna.GENERATION_EXPRESSION || "").trim();
  const extra = String(columna.EXTRA || "").trim();
  if (generationExpression || /generated/i.test(extra)) {
    throw new Error("reserva.modalidad no puede ser una columna generada");
  }
  if (extra && extra.toUpperCase() !== "DEFAULT_GENERATED") {
    throw new Error(`reserva.modalidad tiene atributos EXTRA no soportados: ${extra}`);
  }

  if (dataType === "enum") {
    const enumSeguro = /^enum\((?:'(?:[^'\\]|\\.|'')*')(?:,\s*'(?:[^'\\]|\\.|'')*')*\)$/i;
    if (!enumSeguro.test(columnType) || !columnType.toUpperCase().includes("'FECHA_LIBRE'")) {
      throw new Error("El ENUM reserva.modalidad no admite FECHA_LIBRE o tiene una definicion no segura");
    }
  } else if (["char", "varchar"].includes(dataType)) {
    if (!/^(?:var)?char\(\d+\)$/i.test(columnType)) {
      throw new Error(`El tipo ${columnType || dataType} de reserva.modalidad no se puede reconstruir con seguridad`);
    }
    if (Number(columna.CHARACTER_MAXIMUM_LENGTH) < "FECHA_LIBRE".length) {
      throw new Error("reserva.modalidad no tiene longitud suficiente para FECHA_LIBRE");
    }
  } else {
    throw new Error(`El tipo ${columnType || dataType || "desconocido"} de reserva.modalidad no esta soportado`);
  }

  const charset = validarIdentificadorEsquema(columna.CHARACTER_SET_NAME, "CHARACTER SET");
  const collation = validarIdentificadorEsquema(columna.COLLATION_NAME, "COLLATION");
  if (Boolean(charset) !== Boolean(collation)) {
    throw new Error("reserva.modalidad tiene charset/collation incompletos");
  }

  const nullable = String(columna.IS_NULLABLE || "").toUpperCase();
  if (!["YES", "NO"].includes(nullable)) {
    throw new Error("No se pudo determinar si reserva.modalidad acepta NULL");
  }
  const defaultActual = columna.COLUMN_DEFAULT === null || columna.COLUMN_DEFAULT === undefined
    ? null
    : String(columna.COLUMN_DEFAULT).trim();
  const requiereNotNull = nullable !== "NO";
  const requiereDefault = defaultActual !== "FECHA_LIBRE";

  const definicion = [columnType];
  if (charset) definicion.push(`CHARACTER SET ${charset}`, `COLLATE ${collation}`);
  definicion.push("NOT NULL", "DEFAULT 'FECHA_LIBRE'");
  const comentario = String(columna.COLUMN_COMMENT || "");
  if (comentario) definicion.push(`COMMENT '${escaparLiteralSql(comentario)}'`);

  return {
    requiereNotNull,
    requiereDefault,
    sqlModificar: `ALTER TABLE \`reserva\` MODIFY COLUMN \`modalidad\` ${definicion.join(" ")}`,
  };
}

async function obtenerColumnaModalidad(connection) {
  const [rows] = await connection.query(
    `SELECT DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
            CHARACTER_MAXIMUM_LENGTH, CHARACTER_SET_NAME, COLLATION_NAME,
            COLUMN_COMMENT, GENERATION_EXPRESSION
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'reserva'
        AND COLUMN_NAME = 'modalidad'
      LIMIT 1`
  );
  return rows[0] || null;
}

async function obtenerResumenModalidad(connection) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(modalidad IS NULL), 0) AS nulas,
            COALESCE(SUM(modalidad IS NOT NULL AND TRIM(CAST(modalidad AS CHAR)) = ''), 0) AS vacias,
            COALESCE(SUM(
              COALESCE(NULLIF(UPPER(TRIM(CAST(modalidad AS CHAR))), ''), 'FECHA_LIBRE')
                NOT IN ('FECHA_LIBRE', 'BLOQUE', 'SORTEO', 'CONVENIO')
            ), 0) AS desconocidas
       FROM reserva`
  );
  const row = rows[0] || {};
  return {
    total: Number(row.total || 0),
    nulas: Number(row.nulas || 0),
    vacias: Number(row.vacias || 0),
    desconocidas: Number(row.desconocidas || 0),
  };
}

async function obtenerColumnasIndice(connection, tabla, indice) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [tabla, indice]
  );
  return rows.map((row) => row.COLUMN_NAME);
}

async function asegurarIndice(connection, tabla, nombre, columnas, { checkOnly = false } = {}) {
  const existentes = await obtenerColumnasIndice(connection, tabla, nombre);
  if (existentes.length > 0) {
    if (existentes.join(",") !== columnas.join(",")) {
      throw new Error(`El indice ${tabla}.${nombre} existe con columnas incompatibles`);
    }
    console.log(`[OK] ${tabla}.${nombre} ya existe`);
    return false;
  }

  if (checkOnly) {
    console.log(`[PENDIENTE] crear ${tabla}.${nombre} (${columnas.join(", ")})`);
    return true;
  }

  const columnasSql = columnas.map((columna) => `\`${columna}\``).join(", ");
  await connection.query(`ALTER TABLE \`${tabla}\` ADD INDEX \`${nombre}\` (${columnasSql})`);
  console.log(`[CREADO] ${tabla}.${nombre}`);
  return true;
}

async function normalizarModalidadLegacy(connection, resumen, { checkOnly = false } = {}) {
  const pendientes = Number(resumen?.nulas || 0) + Number(resumen?.vacias || 0);
  if (checkOnly && pendientes === 0) {
    console.log("[OK] reserva.modalidad no tiene valores NULL/vacios");
    return 0;
  }
  if (checkOnly) {
    console.log(`[PENDIENTE] normalizar ${pendientes} reserva.modalidad a FECHA_LIBRE`);
    return pendientes;
  }

  const [resultado] = await connection.query(
    `UPDATE reserva
        SET modalidad = 'FECHA_LIBRE'
      WHERE modalidad IS NULL
         OR TRIM(CAST(modalidad AS CHAR)) = ''`
  );
  const actualizadas = Number(resultado?.affectedRows || 0);
  const posterior = await obtenerResumenModalidad(connection);
  if (posterior.nulas > 0 || posterior.vacias > 0) {
    throw new Error("No se pudieron normalizar todas las modalidades NULL/vacias");
  }
  console.log(`[NORMALIZADO] ${actualizadas} reserva.modalidad a FECHA_LIBRE`);
  return actualizadas;
}

async function asegurarEsquemaModalidad(connection, columna, { checkOnly = false } = {}) {
  const plan = evaluarColumnaModalidad(columna);
  if (!plan.requiereNotNull && !plan.requiereDefault) {
    console.log("[OK] reserva.modalidad ya es NOT NULL DEFAULT FECHA_LIBRE");
    return false;
  }
  if (checkOnly) {
    const pendientes = [
      plan.requiereNotNull ? "NOT NULL" : null,
      plan.requiereDefault ? "DEFAULT FECHA_LIBRE" : null,
    ].filter(Boolean).join(" y ");
    console.log(`[PENDIENTE] endurecer reserva.modalidad con ${pendientes}`);
    return true;
  }

  if (plan.requiereNotNull) {
    await connection.query(plan.sqlModificar);
  } else if (plan.requiereDefault) {
    await connection.query(
      "ALTER TABLE `reserva` ALTER COLUMN `modalidad` SET DEFAULT 'FECHA_LIBRE'"
    );
  }

  const columnaPosterior = await obtenerColumnaModalidad(connection);
  const planPosterior = evaluarColumnaModalidad(columnaPosterior);
  if (planPosterior.requiereNotNull || planPosterior.requiereDefault) {
    throw new Error("reserva.modalidad no quedo con NOT NULL DEFAULT FECHA_LIBRE");
  }
  console.log("[ACTUALIZADO] reserva.modalidad NOT NULL DEFAULT FECHA_LIBRE");
  return true;
}

async function asegurarRegistroMigraciones(connection, {
  migrationId,
  checksum,
  revision,
  etapa,
}) {
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

  const [existente] = await connection.query(
    "SELECT checksum FROM ajb_schema_migration WHERE migration_id = ?",
    [migrationId]
  );
  if (existente.length > 0 && existente[0].checksum !== checksum) {
    throw new Error(`La migracion ${migrationId} ya fue registrada con otro checksum`);
  }

  await connection.query(
    `INSERT INTO ajb_schema_migration
       (migration_id, checksum, revision, estado, etapa, detalle, trigger_definer, trigger_sql_mode)
     VALUES (?, ?, ?, 'APLICANDO', ?, NULL, '', '')
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision), estado = 'APLICANDO', etapa = VALUES(etapa), detalle = NULL,
       finalizada_en = NULL`,
    [migrationId, checksum, revision, etapa]
  );
}

async function marcarMigracionAplicada(connection, migrationId) {
  await connection.query(
    `UPDATE ajb_schema_migration
        SET estado = 'APLICADA', etapa = 'completa', detalle = NULL, finalizada_en = NOW()
      WHERE migration_id = ?`,
    [migrationId]
  );
}

async function validarPreflight(connection) {
  for (const tabla of ["reserva", "estado_reserva", "reserva_convenio_propuesta"]) {
    if (!(await existeTabla(connection, tabla))) {
      throw new Error(`Falta la tabla requerida ${tabla}`);
    }
  }

  const [estados] = await connection.query(
    `SELECT nombre, COUNT(*) AS total
       FROM estado_reserva
      WHERE nombre IN ('Iniciada', 'Rechazada', 'Propuesta convenio', 'Convenio rechazado')
      GROUP BY nombre`
  );
  const mapa = new Map(estados.map((row) => [row.nombre, Number(row.total)]));
  for (const nombre of ["Iniciada", "Rechazada", "Propuesta convenio", "Convenio rechazado"]) {
    if (mapa.get(nombre) !== 1) throw new Error(`El estado ${nombre} no existe o esta duplicado`);
  }

  const columnaModalidad = await obtenerColumnaModalidad(connection);
  const planModalidad = evaluarColumnaModalidad(columnaModalidad);
  const resumenModalidad = await obtenerResumenModalidad(connection);
  if (resumenModalidad.desconocidas > 0) {
    throw new Error(
      `Hay ${resumenModalidad.desconocidas} reservas con modalidades desconocidas; corregirlas manualmente antes de desplegar`
    );
  }

  const [duplicadas] = await connection.query(
    `SELECT r.usuario_id, COUNT(*) AS total
       FROM reserva r
       INNER JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE er.nombre = 'Iniciada'
        AND COALESCE(NULLIF(UPPER(TRIM(CAST(r.modalidad AS CHAR))), ''), 'FECHA_LIBRE')
              IN ('FECHA_LIBRE', 'BLOQUE')
        AND r.usuario_id IS NOT NULL
      GROUP BY r.usuario_id
     HAVING COUNT(*) > 1
      LIMIT 20`
  );
  if (duplicadas.length > 0) {
    throw new Error(
      `Hay ${duplicadas.length} afiliados con multiples reservas iniciadas; corregirlos antes de desplegar`
    );
  }

  return { columnaModalidad, planModalidad, resumenModalidad };
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const connection = await mysqlConnection.promise().getConnection();
  let lockTomado = false;
  let migracionActiva = null;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 10) AS adquirido", [MIGRATION_LOCK]);
    lockTomado = Number(locks[0]?.adquirido) === 1;
    if (!lockTomado) throw new Error("No se pudo obtener el lock de migracion");

    const preflight = await validarPreflight(connection);
    if (!checkOnly) {
      await asegurarRegistroMigraciones(connection, {
        migrationId: MIGRATION_ID,
        checksum: MIGRATION_CHECKSUM,
        revision: MIGRATION_REVISION,
        etapa: "indices",
      });
      migracionActiva = MIGRATION_ID;
    }

    await asegurarIndice(
      connection,
      "reserva",
      "idx_reserva_usuario_estado_plazo",
      ["usuario_id", "estado_reserva_id", "modalidad", "fecha_creacion"],
      { checkOnly }
    );
    await asegurarIndice(
      connection,
      "reserva",
      "idx_reserva_estado_plazo",
      ["estado_reserva_id", "modalidad", "fecha_creacion"],
      { checkOnly }
    );
    await asegurarIndice(
      connection,
      "reserva_convenio_propuesta",
      "idx_rcp_respuesta_fecha",
      ["respuesta", "fecha_propuesta"],
      { checkOnly }
    );

    if (!checkOnly) {
      await marcarMigracionAplicada(connection, MIGRATION_ID);
      migracionActiva = null;
      await asegurarRegistroMigraciones(connection, {
        migrationId: MODALIDAD_MIGRATION_ID,
        checksum: MODALIDAD_MIGRATION_CHECKSUM,
        revision: MODALIDAD_MIGRATION_REVISION,
        etapa: "normalizacion_modalidad",
      });
      migracionActiva = MODALIDAD_MIGRATION_ID;
    }

    await normalizarModalidadLegacy(connection, preflight.resumenModalidad, { checkOnly });
    await asegurarEsquemaModalidad(connection, preflight.columnaModalidad, { checkOnly });

    if (!checkOnly) {
      await marcarMigracionAplicada(connection, MODALIDAD_MIGRATION_ID);
      migracionActiva = null;
    }
    console.log(checkOnly ? "Preflight de reservas completado." : "Migracion de reservas completada.");
  } catch (error) {
    if (migracionActiva) {
      try {
        await connection.query(
          `UPDATE ajb_schema_migration
            SET estado = 'FALLIDA', detalle = ?
            WHERE migration_id = ?`,
          [String(error.message || error).slice(0, 2000), migracionActiva]
        );
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
        // El lock se libera al cerrar la conexion.
      }
    }
    connection.release();
    await mysqlConnection.promise().end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error en migracion de reservas:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  MODALIDAD_MIGRATION_CHECKSUM,
  MODALIDAD_MIGRATION_ID,
  asegurarEsquemaModalidad,
  asegurarIndice,
  evaluarColumnaModalidad,
  normalizarModalidadLegacy,
  obtenerResumenModalidad,
  validarPreflight,
};
