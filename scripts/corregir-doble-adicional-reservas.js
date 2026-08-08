#!/usr/bin/env node
"use strict";

const {
  DOUBLE_ADDITIONAL_FIX_ID,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  columnInfo,
  createConnection,
  parseArguments,
  queryOne,
  redactError,
  sha256,
  stableJson,
  tableExists,
} = require("./integridad-financiera-common");
const {
  archivarVersionReservaAntesDeReemplazo,
  cerrarGuardiaArchivoReserva,
  limpiarTokenGuardiaArchivoReserva,
} = require("../api/services/reserva-version-archivo");

const CONFIRMATION = "CORREGIR_DOBLE_ADICIONAL";
const CORRECTION_LOCK = "ajb_fix_doble_adicional_20260807";
const HISTORICAL_CUTOFF = "2026-08-07";

const CANDIDATES_SQL = `
  SELECT r.id,
         r.estado_reserva_id,
         r.modalidad,
         r.fecha_inicio,
         r.fecha_fin,
         CAST(r.precio_total AS DECIMAL(12,2)) AS precio_total_anterior,
         CAST(r.monto_adicionales AS DECIMAL(12,2)) AS monto_adicionales,
         CAST(f.total AS DECIMAL(12,2)) AS suma_familiares,
         CAST(a.total AS DECIMAL(12,2)) AS suma_adicionales,
         CAST(f.total + a.total AS DECIMAL(12,2)) AS precio_total_nuevo
    FROM reserva r
    JOIN (
      SELECT reserva_id, CAST(SUM(CAST(precio AS DECIMAL(12,2))) AS DECIMAL(12,2)) AS total
        FROM reserva_familiar
       GROUP BY reserva_id
    ) f ON f.reserva_id = r.id
    JOIN (
      SELECT reserva_id, CAST(SUM(CAST(subtotal AS DECIMAL(12,2))) AS DECIMAL(12,2)) AS total
        FROM reserva_adicional
       GROUP BY reserva_id
    ) a ON a.reserva_id = r.id
   WHERE r.modalidad = 'FECHA_LIBRE'
     AND r.fecha_fin < DATE '${HISTORICAL_CUTOFF}'
     AND a.total > CAST(0 AS DECIMAL(12,2))
     AND CAST(r.precio_total AS DECIMAL(12,2)) =
         CAST(f.total + (CAST(2 AS DECIMAL(12,2)) * a.total) AS DECIMAL(12,2))
     AND CAST(r.precio_total AS DECIMAL(12,2)) <>
         CAST(f.total + a.total AS DECIMAL(12,2))
   ORDER BY r.id
`;

function decimal(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`Importe decimal inesperado: ${value}`);
  const cents = (match[3] || "").padEnd(2, "0");
  return `${match[1]}${match[2]}.${cents}`;
}

function integer(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Entero inesperado: ${value}`);
  return parsed;
}

async function loadCandidateRows(connection) {
  const [rows] = await connection.query(CANDIDATES_SQL);
  return rows;
}

async function loadManifest(connection) {
  const candidates = await loadCandidateRows(connection);
  const errors = [];
  const rows = [];

  for (const candidate of candidates) {
    const reservaId = integer(candidate.id);
    const [additionRows] = await connection.query(
      `SELECT ra.id, ra.adicional_id, ra.cantidad, ra.dias,
              CAST(ra.subtotal AS DECIMAL(12,2)) AS subtotal,
              COUNT(rad.id) AS cantidad_detalles,
              COUNT(DISTINCT rad.fecha) AS fechas_distintas,
              DATEDIFF(r.fecha_fin, r.fecha_inicio) AS noches_reserva,
              CAST(COALESCE(SUM(CAST(rad.subtotal AS DECIMAL(12,2))), 0) AS DECIMAL(12,2)) AS suma_detalles,
              COALESCE(SUM(
                CAST(rad.subtotal AS DECIMAL(12,2)) <>
                CAST(CAST(rad.cantidad AS DECIMAL(12,2)) * CAST(rad.precio_unitario AS DECIMAL(12,2)) AS DECIMAL(12,2))
              ), 0) AS detalles_ecuacion_invalida,
              COALESCE(SUM(rad.cantidad <> ra.cantidad), 0) AS detalles_cantidad_invalida,
              COALESCE(SUM(rad.fecha < r.fecha_inicio OR rad.fecha >= r.fecha_fin), 0) AS detalles_fecha_invalida,
              MIN(rad.fecha) AS primera_fecha,
              MAX(rad.fecha) AS ultima_fecha
         FROM reserva_adicional ra
         INNER JOIN reserva r ON r.id = ra.reserva_id
         LEFT JOIN reserva_adicional_detalle rad ON rad.reserva_adicional_id = ra.id
        WHERE ra.reserva_id = ?
        GROUP BY ra.id, ra.adicional_id, ra.cantidad, ra.dias, ra.subtotal
        ORDER BY ra.id`,
      [reservaId]
    );
    const [detailRows] = await connection.query(
      `SELECT rad.id, rad.reserva_adicional_id, rad.fecha, rad.cantidad,
              CAST(rad.precio_unitario AS DECIMAL(12,2)) AS precio_unitario,
              CAST(rad.subtotal AS DECIMAL(12,2)) AS subtotal,
              rad.tarifa_adicional_id, rad.tarifa_id,
              CAST(COALESCE(rad.porcentaje_descuento, 0) AS DECIMAL(5,2)) AS porcentaje_descuento
         FROM reserva_adicional_detalle rad
         INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
        WHERE ra.reserva_id = ?
        ORDER BY ra.id, rad.fecha, rad.id`,
      [reservaId]
    );

    const additions = additionRows.map((row) => ({
      id: integer(row.id),
      adicional_id: integer(row.adicional_id),
      cantidad: integer(row.cantidad),
      dias: integer(row.dias),
      subtotal: decimal(row.subtotal),
      cantidad_detalles: integer(row.cantidad_detalles),
      fechas_distintas: integer(row.fechas_distintas),
      noches_reserva: integer(row.noches_reserva),
      suma_detalles: decimal(row.suma_detalles),
      primera_fecha: row.primera_fecha,
      ultima_fecha: row.ultima_fecha,
    }));
    const details = detailRows.map((row) => ({
      id: integer(row.id),
      reserva_adicional_id: integer(row.reserva_adicional_id),
      fecha: row.fecha,
      cantidad: integer(row.cantidad),
      precio_unitario: decimal(row.precio_unitario),
      subtotal: decimal(row.subtotal),
      tarifa_adicional_id:
        row.tarifa_adicional_id === null ? null : integer(row.tarifa_adicional_id),
      tarifa_id: row.tarifa_id === null ? null : integer(row.tarifa_id),
      porcentaje_descuento: decimal(row.porcentaje_descuento),
    }));

    for (const addition of additionRows) {
      if (decimal(addition.subtotal) !== decimal(addition.suma_detalles)) {
        errors.push(`reserva ${reservaId}: adicional ${addition.id} no coincide con sus detalles`);
      }
      if (integer(addition.dias) !== integer(addition.cantidad_detalles)) {
        errors.push(`reserva ${reservaId}: adicional ${addition.id} no coincide con la cantidad de noches`);
      }
      if (
        integer(addition.dias) !== integer(addition.noches_reserva) ||
        integer(addition.fechas_distintas) !== integer(addition.noches_reserva) ||
        addition.primera_fecha !== candidate.fecha_inicio ||
        addition.ultima_fecha !== (() => {
          const date = new Date(`${candidate.fecha_fin}T00:00:00Z`);
          date.setUTCDate(date.getUTCDate() - 1);
          return date.toISOString().slice(0, 10);
        })()
      ) {
        errors.push(`reserva ${reservaId}: adicional ${addition.id} no cubre exactamente todas las noches`);
      }
      if (
        integer(addition.detalles_ecuacion_invalida) !== 0 ||
        integer(addition.detalles_cantidad_invalida) !== 0 ||
        integer(addition.detalles_fecha_invalida) !== 0
      ) {
        errors.push(`reserva ${reservaId}: adicional ${addition.id} tiene detalle, cantidad o fecha inválida`);
      }
    }
    if (decimal(candidate.monto_adicionales) !== decimal(candidate.suma_adicionales)) {
      errors.push(`reserva ${reservaId}: monto_adicionales no coincide con la suma de adicionales`);
    }

    rows.push({
      id: reservaId,
      estado_reserva_id: integer(candidate.estado_reserva_id),
      modalidad: String(candidate.modalidad),
      fecha_inicio: candidate.fecha_inicio,
      fecha_fin: candidate.fecha_fin,
      precio_total_anterior: decimal(candidate.precio_total_anterior),
      monto_adicionales: decimal(candidate.monto_adicionales),
      suma_familiares: decimal(candidate.suma_familiares),
      suma_adicionales: decimal(candidate.suma_adicionales),
      precio_total_nuevo: decimal(candidate.precio_total_nuevo),
      adicionales: additions,
      detalles_adicionales: details,
    });
  }

  const manifest = {
    correction_id: DOUBLE_ADDITIONAL_FIX_ID,
    historical_cutoff_exclusive: HISTORICAL_CUTOFF,
    rows,
  };
  const canonical = stableJson(manifest);
  return { manifest, canonical, hash: sha256(canonical), errors };
}

function summary(result) {
  const rows = result.manifest.rows;
  const cents = (value) => Math.round(Number(value) * 100);
  const adjustment = rows.reduce(
    (total, row) => total + cents(row.precio_total_anterior) - cents(row.precio_total_nuevo),
    0
  );
  return {
    cantidad: rows.length,
    ajuste_total: (adjustment / 100).toFixed(2),
    por_estado: rows.reduce((accumulator, row) => {
      const key = String(row.estado_reserva_id);
      accumulator[key] = (accumulator[key] || 0) + 1;
      return accumulator;
    }, {}),
  };
}

async function ensureCorrectionPrerequisites(connection) {
  if (!(await tableExists(connection, "ajb_schema_migration"))) {
    throw new Error(`Primero debe aplicarse la migración ${MIGRATION_ID}`);
  }
  const [rows] = await connection.query(
    "SELECT checksum, estado FROM ajb_schema_migration WHERE migration_id = ?",
    [MIGRATION_ID]
  );
  if (
    rows.length !== 1 ||
    rows[0].estado !== "APLICADA" ||
    rows[0].checksum !== MIGRATION_CHECKSUM
  ) {
    throw new Error(`La migración ${MIGRATION_ID} no está aplicada con el checksum esperado`);
  }
  const priceColumn = await columnInfo(connection, "reserva", "precio_total");
  if (
    !priceColumn ||
    String(priceColumn.COLUMN_TYPE).toLowerCase() !== "decimal(12,2)"
  ) {
    throw new Error("reserva.precio_total no cumple DECIMAL(12,2)");
  }
}

async function ensureBackupTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ajb_reserva_precio_backup (
      correccion_id VARCHAR(100) NOT NULL,
      reserva_id INT NOT NULL,
      manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      manifest_json JSON NOT NULL,
      precio_total_anterior DECIMAL(12,2) NOT NULL,
      precio_total_nuevo DECIMAL(12,2) NOT NULL,
      suma_familiares DECIMAL(12,2) NOT NULL,
      suma_adicionales DECIMAL(12,2) NOT NULL,
      monto_adicionales DECIMAL(12,2) NOT NULL,
      estado_reserva_id INT NOT NULL,
      modalidad VARCHAR(30) NOT NULL,
      fecha_inicio DATE NOT NULL,
      fecha_fin DATE NOT NULL,
      checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      respaldada_en DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (correccion_id, reserva_id),
      KEY idx_ajb_backup_reserva (reserva_id),
      KEY idx_ajb_backup_manifest (correccion_id, manifest_sha256)
    ) ENGINE=InnoDB
  `);
  for (const column of ["manifest_sha256", "manifest_json", "monto_adicionales"]) {
    if (!(await columnInfo(connection, "ajb_reserva_precio_backup", column))) {
      throw new Error(`La tabla de backup existente no tiene ${column}; no se alterará automáticamente`);
    }
  }
}

async function appliedStatus(connection, manifestHash) {
  if (!(await tableExists(connection, "ajb_reserva_precio_backup"))) {
    return { backups: 0, inconsistentes: 0, otros_manifiestos: 0 };
  }
  return queryOne(
    connection,
    `SELECT COUNT(*) AS backups,
            COALESCE(SUM(b.manifest_sha256 <> ?), 0) AS otros_manifiestos,
            COALESCE(SUM(r.id IS NULL OR
              CAST(r.precio_total AS DECIMAL(12,2)) <> b.precio_total_nuevo), 0) AS inconsistentes
       FROM ajb_reserva_precio_backup b
       LEFT JOIN reserva r ON r.id = b.reserva_id
      WHERE b.correccion_id = ?`,
    [manifestHash, DOUBLE_ADDITIONAL_FIX_ID]
  );
}

async function verifyExistingBackup(connection, manifestHash) {
  const [rows] = await connection.query(
    `SELECT b.*, CAST(r.precio_total AS DECIMAL(12,2)) AS precio_actual
       FROM ajb_reserva_precio_backup b
       LEFT JOIN reserva r ON r.id = b.reserva_id
      WHERE b.correccion_id = ?
      ORDER BY b.reserva_id`,
    [DOUBLE_ADDITIONAL_FIX_ID]
  );
  if (rows.length === 0) return { ok: false, reason: "sin backups" };
  let manifest = rows[0].manifest_json;
  if (typeof manifest === "string") manifest = JSON.parse(manifest);
  if (!manifest || sha256(stableJson(manifest)) !== manifestHash) {
    return { ok: false, reason: "manifest_json no coincide con su SHA-256" };
  }
  if (!Array.isArray(manifest.rows) || manifest.rows.length !== rows.length) {
    return { ok: false, reason: "cantidad de filas del manifiesto inconsistente" };
  }
  const byId = new Map(manifest.rows.map((row) => [Number(row.id), row]));
  for (const backup of rows) {
    let storedManifest = backup.manifest_json;
    if (typeof storedManifest === "string") storedManifest = JSON.parse(storedManifest);
    const manifestRow = byId.get(Number(backup.reserva_id));
    if (
      backup.manifest_sha256 !== manifestHash ||
      sha256(stableJson(storedManifest)) !== manifestHash ||
      !manifestRow ||
      sha256(stableJson(manifestRow)) !== backup.checksum ||
      decimal(backup.precio_total_anterior) !== manifestRow.precio_total_anterior ||
      decimal(backup.precio_total_nuevo) !== manifestRow.precio_total_nuevo ||
      decimal(backup.monto_adicionales) !== manifestRow.monto_adicionales ||
      decimal(backup.precio_actual) !== manifestRow.precio_total_nuevo
    ) {
      return { ok: false, reason: `backup inconsistente para reserva ${backup.reserva_id}` };
    }
  }
  return { ok: true, count: rows.length };
}

async function lockManifestRows(connection, ids) {
  if (ids.length === 0) return;
  await connection.query("SELECT id FROM reserva WHERE id IN (?) ORDER BY id FOR UPDATE", [ids]);
  await connection.query(
    "SELECT id FROM reserva_familiar WHERE reserva_id IN (?) ORDER BY reserva_id, id FOR UPDATE",
    [ids]
  );
  await connection.query(
    "SELECT id FROM reserva_adicional WHERE reserva_id IN (?) ORDER BY reserva_id, id FOR UPDATE",
    [ids]
  );
  await connection.query(
    `SELECT rad.id
       FROM reserva_adicional_detalle rad
       INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
      WHERE ra.reserva_id IN (?)
      ORDER BY ra.reserva_id, ra.id, rad.id FOR UPDATE`,
    [ids]
  );
}

async function applyCorrection(connection, expectedHash) {
  // READ COMMITTED hace que la segunda carga vea el estado corriente después
  // de esperar los FOR UPDATE, no un snapshot anterior a los bloqueos.
  await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await connection.beginTransaction();
  try {
    const initial = await loadManifest(connection);
    const ids = initial.manifest.rows.map((row) => row.id);
    await lockManifestRows(connection, ids);
    const locked = await loadManifest(connection);
    if (locked.errors.length > 0) {
      throw new Error(`El manifiesto no es consistente: ${locked.errors.join(" | ")}`);
    }
    if (locked.hash !== expectedHash || initial.hash !== expectedHash) {
      throw new Error(
        `El conjunto cambió o no coincide: esperado ${expectedHash}, observado ${locked.hash}`
      );
    }
    if (locked.manifest.rows.length === 0) throw new Error("El manifiesto aprobado está vacío");

    const canonicalManifest = locked.canonical;
    for (const row of locked.manifest.rows) {
      await archivarVersionReservaAntesDeReemplazo(
        connection,
        row.id,
        { id: null, rol: "SCRIPT_INTEGRIDAD" },
        "CORRECCION"
      );
      const rowChecksum = sha256(stableJson(row));
      await connection.query(
        `INSERT INTO ajb_reserva_precio_backup
          (correccion_id, reserva_id, manifest_sha256, manifest_json,
           precio_total_anterior, precio_total_nuevo, suma_familiares,
           suma_adicionales, monto_adicionales, estado_reserva_id, modalidad,
           fecha_inicio, fecha_fin, checksum)
         VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          DOUBLE_ADDITIONAL_FIX_ID,
          row.id,
          expectedHash,
          canonicalManifest,
          row.precio_total_anterior,
          row.precio_total_nuevo,
          row.suma_familiares,
          row.suma_adicionales,
          row.monto_adicionales,
          row.estado_reserva_id,
          row.modalidad,
          row.fecha_inicio,
          row.fecha_fin,
          rowChecksum,
        ]
      );
      await connection.query(
        `INSERT INTO historial_reserva
          (reserva_id, tipo_operacion, campo_modificado, valor_anterior,
           valor_nuevo, usuario_modificador_id, fecha_modificacion, observaciones)
         VALUES (?, 'UPDATE', 'precio_total', ?, ?, NULL, NOW(), ?)`,
        [
          row.id,
          row.precio_total_anterior,
          row.precio_total_nuevo,
          `Corrección ${DOUBLE_ADDITIONAL_FIX_ID}; manifiesto SHA-256 ${expectedHash}`,
        ]
      );
      const [update] = await connection.query(
        `UPDATE reserva
            SET precio_total = ?
          WHERE id = ?
            AND CAST(precio_total AS DECIMAL(12,2)) = ?
            AND CAST(monto_adicionales AS DECIMAL(12,2)) = ?
            AND estado_reserva_id = ?
            AND modalidad = ?
            AND fecha_inicio = ?
            AND fecha_fin = ?`,
        [
          row.precio_total_nuevo,
          row.id,
          row.precio_total_anterior,
          row.monto_adicionales,
          row.estado_reserva_id,
          row.modalidad,
          row.fecha_inicio,
          row.fecha_fin,
        ]
      );
      if (Number(update.affectedRows) !== 1) {
        throw new Error(`La reserva ${row.id} cambió durante la corrección`);
      }
      await cerrarGuardiaArchivoReserva(connection, row.id);
    }

    const verification = await queryOne(
      connection,
      `SELECT COUNT(*) AS inconsistentes
         FROM ajb_reserva_precio_backup b
         INNER JOIN reserva r ON r.id = b.reserva_id
        WHERE b.correccion_id = ?
          AND b.manifest_sha256 = ?
          AND CAST(r.precio_total AS DECIMAL(12,2)) <> b.precio_total_nuevo`,
      [DOUBLE_ADDITIONAL_FIX_ID, expectedHash]
    );
    if (integer(verification.inconsistentes) !== 0) {
      throw new Error("La verificación transaccional de precios falló");
    }
    await connection.commit();
    return locked;
  } catch (error) {
    await connection.rollback();
    try {
      await limpiarTokenGuardiaArchivoReserva(connection);
    } catch (_) {
      // La tabla de guardia y el archivo ya se revirtieron con la transacción.
    }
    throw error;
  }
}

async function dryRun(connection) {
  await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await connection.query("SET SESSION TRANSACTION READ ONLY");
  await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  try {
    return await loadManifest(connection);
  } finally {
    await connection.rollback();
  }
}

async function main() {
  const args = parseArguments();
  const apply = args.apply === true;
  const suppliedHash = String(args["manifest-sha256"] || "").toLowerCase();
  if (apply && args.confirm !== CONFIRMATION) {
    throw new Error(`Para aplicar se exige --confirm=${CONFIRMATION}`);
  }
  if (apply && !/^[0-9a-f]{64}$/.test(suppliedHash)) {
    throw new Error("Para aplicar se exige --manifest-sha256=<hash del dry-run>");
  }
  if (apply && process.env.NODE_ENV === "production" && args["allow-production"] !== true) {
    throw new Error("En producción también se exige --allow-production");
  }

  const connection = await createConnection();
  let lockAcquired = false;
  try {
    if (!apply) {
      const result = await dryRun(connection);
      console.log(
        JSON.stringify(
          {
            mode: "dry-run-read-only",
            valid: result.errors.length === 0 && result.manifest.rows.length > 0,
            manifest_sha256: result.hash,
            manifest: result.manifest,
            summary: summary(result),
            validation_errors: result.errors,
            apply_requires: `--apply --confirm=${CONFIRMATION} --manifest-sha256=${result.hash}`,
          },
          null,
          2
        )
      );
      if (result.errors.length > 0 || result.manifest.rows.length === 0) process.exitCode = 2;
      return;
    }

    const lock = await queryOne(connection, "SELECT GET_LOCK(?, 0) AS adquirido", [
      CORRECTION_LOCK,
    ]);
    if (Number(lock.adquirido) !== 1) throw new Error("Otra corrección está en curso");
    lockAcquired = true;

    await ensureCorrectionPrerequisites(connection);
    await ensureBackupTable(connection);
    const previous = await appliedStatus(connection, suppliedHash);
    if (Number(previous.backups) > 0) {
      const existingVerification = await verifyExistingBackup(connection, suppliedHash);
      if (
        Number(previous.otros_manifiestos) === 0 &&
        Number(previous.inconsistentes) === 0 &&
        existingVerification.ok
      ) {
        console.log(
          JSON.stringify({
            mode: "apply",
            already_applied: true,
            manifest_sha256: suppliedHash,
            backups: existingVerification.count,
          })
        );
        return;
      }
      throw new Error(
        `Existe un backup parcial, inconsistente o de otro manifiesto: ${existingVerification.reason || "estado inválido"}`
      );
    }

    const applied = await applyCorrection(connection, suppliedHash);
    const after = await appliedStatus(connection, suppliedHash);
    if (
      Number(after.backups) !== applied.manifest.rows.length ||
      Number(after.otros_manifiestos) !== 0 ||
      Number(after.inconsistentes) !== 0
    ) {
      throw new Error("La verificación posterior al commit no coincide con el manifiesto");
    }
    console.log(
      JSON.stringify({
        mode: "apply",
        applied: true,
        manifest_sha256: suppliedHash,
        summary: summary(applied),
      })
    );
  } finally {
    if (lockAcquired) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [CORRECTION_LOCK]);
      } catch (_) {
        // Cerrar la conexión también libera el advisory lock.
      }
    }
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify(redactError(error)));
    process.exitCode = 1;
  });
}

module.exports = { CANDIDATES_SQL, HISTORICAL_CUTOFF, loadManifest };
