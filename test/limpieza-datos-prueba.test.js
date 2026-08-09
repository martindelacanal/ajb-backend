"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BLOCK_RESOURCE_INCONSISTENCIES_SQL,
  COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL,
  COINSURANCE_WITHOUT_SNAPSHOT_SQL,
  CONFIRMATION,
  HISTORY_CONFIRMATION,
  INCOMPLETE_SNAPSHOT_PREDICATE_SQL,
  INVALID_ADDITIONAL_TARIFFS_SQL,
  INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL,
  INVALID_TARIFFS_SQL,
  INVALID_TARIFF_DIMENSIONS_SQL,
  OBSOLETE_RAFFLES_SQL,
  POSTCHECK_SQL,
  RESERVATION_REASONS_SQL,
  SNAPSHOT_COVERAGE_SQL,
  agruparMotivos,
  cantidadObjetivos,
  crearTriggerCoincide,
  estadoRecursoTrasLiberacion,
  esTemporadaExclusiva,
  extraerShowCreateTrigger,
  manifestResult,
  resumenManifiesto,
  validarOpciones,
} = require("../scripts/limpiar-datos-prueba-inconsistentes");

const HASH = "a".repeat(64);
const SCRIPT_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../scripts/limpiar-datos-prueba-inconsistentes.js"),
  "utf8"
);

test("la limpieza es dry-run por defecto", () => {
  assert.deepEqual(validarOpciones({}, { NODE_ENV: "development" }), {
    apply: false,
    purgeTestHistory: false,
    manifestSha256: "",
    production: false,
  });
});

test("apply exige confirmacion literal y SHA-256 del dry-run", () => {
  assert.throws(
    () => validarOpciones({ apply: true }, { NODE_ENV: "development" }),
    new RegExp(CONFIRMATION)
  );
  assert.throws(
    () => validarOpciones({ apply: true, confirm: CONFIRMATION }, { NODE_ENV: "development" }),
    /manifest-sha256/
  );
  assert.equal(
    validarOpciones(
      { apply: true, confirm: CONFIRMATION, "manifest-sha256": HASH },
      { NODE_ENV: "development" }
    ).manifestSha256,
    HASH
  );
});

test("produccion exige allow-production y TLS verify-full", () => {
  const base = { apply: true, confirm: CONFIRMATION, "manifest-sha256": HASH };
  assert.throws(
    () => validarOpciones(base, { NODE_ENV: "production", DB_SSL_MODE: "verify-full" }),
    /allow-production/
  );
  assert.throws(
    () => validarOpciones(
      { ...base, "allow-production": true },
      { NODE_ENV: "production", DB_SSL_MODE: "disabled" }
    ),
    /verify-full/
  );
  assert.equal(
    validarOpciones(
      { ...base, "allow-production": true },
      { NODE_ENV: "production", DB_SSL_MODE: "verify-full" }
    ).production,
    true
  );
});

test("la purga append-only exige apply y una segunda confirmacion", () => {
  assert.throws(
    () => validarOpciones({ "purge-test-history": true }, { NODE_ENV: "development" }),
    /solo se admite junto con --apply/
  );
  const base = {
    apply: true,
    confirm: CONFIRMATION,
    "manifest-sha256": HASH,
    "purge-test-history": true,
  };
  assert.throws(
    () => validarOpciones(base, { NODE_ENV: "development" }),
    new RegExp(HISTORY_CONFIRMATION)
  );
  assert.equal(
    validarOpciones(
      { ...base, "confirm-purge-history": HISTORY_CONFIRMATION },
      { NODE_ENV: "development" }
    ).purgeTestHistory,
    true
  );
});

test("los motivos de reserva se deduplican y ordenan deterministicamente", () => {
  assert.deepEqual(
    agruparMotivos([
      { reserva_id: "9", motivo: "Z" },
      { reserva_id: 2, motivo: "B" },
      { reserva_id: 2, motivo: "A" },
      { reserva_id: 2, motivo: "A" },
    ]),
    [
      { id: 2, motivos: ["A", "B"] },
      { id: 9, motivos: ["Z"] },
    ]
  );
});

test("solo una temporada BLOQUE completamente contenida es purgable", () => {
  const candidateBlocks = [4, 7];
  const candidateReservations = [23, 24];
  assert.equal(
    esTemporadaExclusiva(
      { origen: "BLOQUE", bloques: [7, 4], referenciasReserva: [24, 23] },
      candidateBlocks,
      candidateReservations
    ),
    true
  );
  assert.equal(
    esTemporadaExclusiva(
      { origen: "GENERAL", bloques: [4], referenciasReserva: [] },
      candidateBlocks,
      candidateReservations
    ),
    false
  );
  assert.equal(
    esTemporadaExclusiva(
      { origen: "BLOQUE", bloques: [4, 99], referenciasReserva: [] },
      candidateBlocks,
      candidateReservations
    ),
    false
  );
  assert.equal(
    esTemporadaExclusiva(
      { origen: "BLOQUE", bloques: [4], referenciasReserva: [500] },
      candidateBlocks,
      candidateReservations
    ),
    false
  );
});

test("la liberacion de recursos sigue el estado del bloque y del sorteo", () => {
  assert.equal(
    estadoRecursoTrasLiberacion({ modalidad: "BLOQUE", estadoBloque: "ACTIVO" }),
    "DISPONIBLE"
  );
  assert.equal(
    estadoRecursoTrasLiberacion({
      modalidad: "SORTEO",
      estadoBloque: "ACTIVO",
      estadoSorteo: "ACTIVO",
    }),
    "SORTEO"
  );
  assert.equal(
    estadoRecursoTrasLiberacion({
      modalidad: "SORTEO",
      estadoBloque: "ACTIVO",
      estadoSorteo: "CERRADO",
    }),
    "VENTA_DIRECTA"
  );
  assert.equal(
    estadoRecursoTrasLiberacion({ modalidad: "SORTEO", estadoBloque: "LIBERADO" }),
    "LIBERADO"
  );
});

test("el manifiesto y su hash no dependen del orden de entrada", () => {
  const first = manifestResult({
    reservas: [{ id: 9 }, { id: 2 }],
    sorteos: [{ id: 5 }, { id: 4 }],
    historial_prueba: {
      archivos: [{ id: 20 }, { id: 3 }],
      backups_correccion: [
        { correccion_id: "z", reserva_id: 9 },
        { correccion_id: "a", reserva_id: 2 },
      ],
    },
  });
  const second = manifestResult({
    reservas: [{ id: 2 }, { id: 9 }],
    sorteos: [{ id: 4 }, { id: 5 }],
    historial_prueba: {
      archivos: [{ id: 3 }, { id: 20 }],
      backups_correccion: [
        { correccion_id: "a", reserva_id: 2 },
        { correccion_id: "z", reserva_id: 9 },
      ],
    },
  });
  assert.equal(first.canonical, second.canonical);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.manifest.reservas.map((row) => row.id), [2, 9]);
});

test("el resumen separa objetivos operacionales del historial opcional", () => {
  const result = manifestResult({
    reservas: [{ id: 1 }],
    coseguros: [{ id: 2, archivos: 3 }],
    tarifas: [{ id: 3 }],
    historial_prueba: {
      archivos: [{ id: 10 }],
      backups_correccion: [{ correccion_id: "x", reserva_id: 1 }],
    },
  });
  assert.equal(cantidadObjetivos(result.manifest), 3);
  assert.deepEqual(resumenManifiesto(result.manifest), {
    reservas: 1,
    sorteos: 0,
    bloques: 0,
    recursos_bloque: 0,
    temporadas: 0,
    notificaciones: 0,
    coseguros: 1,
    archivos_coseguro_referenciados: 3,
    tarifas: 1,
    tarifas_adicionales: 0,
    archivos_historial: 1,
    backups_correccion: 1,
    objetivos_operacionales: 3,
  });
});

test("SHOW CREATE del trigger append-only se captura y compara sin depender de espacios", () => {
  const row = {
    Trigger: "ajb_reserva_archivo_bd",
    sql_mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
    "SQL Original Statement": `CREATE DEFINER=\`admin\`@\`%\` TRIGGER \`ajb_reserva_archivo_bd\`
      BEFORE DELETE ON \`ajb_reserva_version_archivo\`
      FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'append-only'; END`,
  };
  const before = extraerShowCreateTrigger(row);
  const equivalent = {
    createSql: before.createSql.replace(/\s+/g, " "),
    sqlMode: before.sqlMode,
  };
  assert.equal(crearTriggerCoincide(before, equivalent), true);
  assert.equal(
    crearTriggerCoincide(before, {
      createSql: before.createSql.replace("append-only", "distinto"),
      sqlMode: before.sqlMode,
    }),
    false
  );
});

test("la purga opcional inventaria y elimina todo el historial de prueba sin truncar tablas", () => {
  const loadHistorySource = SCRIPT_SOURCE.slice(
    SCRIPT_SOURCE.indexOf("async function loadHistoryRows"),
    SCRIPT_SOURCE.indexOf("async function loadManifest")
  );
  assert.match(
    loadHistorySource,
    /FROM ajb_reserva_version_archivo\s+ORDER BY id/i
  );
  assert.match(
    loadHistorySource,
    /FROM ajb_reserva_precio_backup\s+ORDER BY correccion_id, reserva_id/i
  );
  assert.doesNotMatch(loadHistorySource, /\bWHERE\b/i);

  const purgeSource = SCRIPT_SOURCE.slice(
    SCRIPT_SOURCE.indexOf("async function purgeTestHistory"),
    SCRIPT_SOURCE.indexOf("async function main")
  );
  assert.match(purgeSource, /DELETE FROM ajb_reserva_version_archivo/);
  assert.match(purgeSource, /DELETE FROM ajb_reserva_precio_backup/);
  assert.doesNotMatch(purgeSource, /\bTRUNCATE\b/i);
  assert.match(purgeSource, /SELECT COUNT\(\*\) FROM ajb_reserva_version_archivo/i);
  assert.match(purgeSource, /SELECT COUNT\(\*\) FROM ajb_reserva_precio_backup/i);
  assert.match(purgeSource, /restoreArchiveDeleteTrigger/);
  assert.doesNotMatch(purgeSource, /DROP TABLE|ajb_schema_migration/i);
});

test("las consultas candidatas mantienen los limites de seguridad funcionales", () => {
  assert.match(OBSOLETE_RAFFLES_SQL, /s\.estado\s*=\s*'ACTIVO'/i);
  assert.match(OBSOLETE_RAFFLES_SQL, /fecha_fin_inscripcion\s*<\s*CURDATE\(\)/i);
  assert.match(OBSOLETE_RAFFLES_SQL, /NOT EXISTS[\s\S]*bf_futuro\.fecha_fin\s*>\s*CURDATE\(\)/i);
  assert.doesNotMatch(OBSOLETE_RAFFLES_SQL, /bf_futuro\.fecha_fin\s*>=\s*CURDATE\(\)/i);

  assert.match(RESERVATION_REASONS_SQL, /RFT_TARIFA_HUERFANA/);
  assert.match(RESERVATION_REASONS_SQL, /RAD_TARIFA_HUERFANA/);
  assert.match(RESERVATION_REASONS_SQL, /SNAPSHOT_DIARIO_INCOMPLETO/);
  assert.match(RESERVATION_REASONS_SQL, /VENCIDA_NO_TERMINAL/);
  assert.match(RESERVATION_REASONS_SQL, /SORTEO_OBSOLETO/);
  assert.match(RESERVATION_REASONS_SQL, /r\.modalidad\s*<>\s*'CONVENIO'/i);
  assert.match(RESERVATION_REASONS_SQL, /finalizada/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /COUNT\(DISTINCT\s+rf\.id,\s*rft\.fecha\)/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /rft\.fecha\s*<\s*r\.fecha_inicio/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /rft\.fecha\s*>=\s*r\.fecha_fin/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /snapshot_estado\s*<>\s*'COMPLETO'/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /rft\.tarifa_id\s+IS\s+NULL/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /precio_aplicado\s+IS\s+NULL/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /snapshot_creado_en\s+IS\s+NULL/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /usa_porcentaje_aplicado\s+IS\s+NULL/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /usa_porcentaje_aplicado\s*=\s*1[\s\S]*porcentaje_descuento_aplicado\s+IS\s+NULL/i);
  assert.match(SNAPSHOT_COVERAGE_SQL, /usa_porcentaje_aplicado\s*=\s*0[\s\S]*COALESCE\(rft\.porcentaje_descuento_aplicado,\s*0\)\s*<>\s*0/i);
  assert.match(INCOMPLETE_SNAPSHOT_PREDICATE_SQL, /familiares\s*=\s*0/i);
  assert.match(INCOMPLETE_SNAPSHOT_PREDICATE_SQL, /esperado\s*<>\s*cobertura\.actual/i);
  assert.match(INCOMPLETE_SNAPSHOT_PREDICATE_SQL, /actual\s*<>\s*cobertura\.pares_unicos/i);
  assert.match(INCOMPLETE_SNAPSHOT_PREDICATE_SQL, /fuera_de_rango\s*<>\s*0/i);
  assert.match(INCOMPLETE_SNAPSHOT_PREDICATE_SQL, /snapshots_invalidos\s*<>\s*0/i);

  assert.match(COINSURANCE_WITHOUT_SNAPSHOT_SQL, /s\.eliminado\s*=\s*0/i);
  assert.match(COINSURANCE_WITHOUT_SNAPSHOT_SQL, /modo_cobertura\s*=\s*'PORCENTAJE'/i);
  assert.match(
    COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL,
    /porcentaje_cobertura_aplicado\s+IS\s+NULL\s+OR\s+s\.importe_estimado\s+IS\s+NULL/i
  );
  assert.ok(COINSURANCE_WITHOUT_SNAPSHOT_SQL.includes(COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL));
  assert.ok(POSTCHECK_SQL.includes(COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL));
  assert.match(
    SCRIPT_SOURCE,
    /async function deleteCoseguro[\s\S]*COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL/
  );

  assert.match(BLOCK_RESOURCE_INCONSISTENCIES_SQL, /RESERVADO', 'ASIGNADO/);
  assert.match(BLOCK_RESOURCE_INCONSISTENCIES_SQL, /<>\s*\(bfr\.reserva_id\s+IS\s+NOT\s+NULL\)/i);
  assert.match(POSTCHECK_SQL, /recursos_bloque_inconsistentes/);
  assert.match(POSTCHECK_SQL, /tarifas_fuera_servicio/);
  assert.match(POSTCHECK_SQL, /familiares_vinculo_inconsistente/);
  assert.match(POSTCHECK_SQL, /ciclos_familiares/);
  assert.match(POSTCHECK_SQL, /reservas_salud_sin_detalle/);
  assert.match(POSTCHECK_SQL, /subsidios_aprobados_inconsistentes/);
  assert.match(POSTCHECK_SQL, /tarifas_aplicables_solapadas/);
  assert.match(POSTCHECK_SQL, /adicionales_aplicables_solapados/);
  assert.match(POSTCHECK_SQL, /observaciones_lectura_huerfanas/);
  assert.match(POSTCHECK_SQL, /CAST\(CONCAT\(',',\s*id,\s*','\)\s+AS\s+CHAR\(2048\)\)/i);

  for (const sql of [INVALID_TARIFFS_SQL, INVALID_ADDITIONAL_TARIFFS_SQL]) {
    assert.match(sql, /LEFT JOIN recurso/i);
    assert.match(sql, /LEFT JOIN servicio_regimen/i);
    assert.match(sql, /NOT EXISTS/i);
  }
  assert.ok(INVALID_TARIFFS_SQL.includes(INVALID_TARIFF_DIMENSIONS_SQL));
  assert.ok(POSTCHECK_SQL.includes(INVALID_TARIFF_DIMENSIONS_SQL));
  assert.ok(INVALID_ADDITIONAL_TARIFFS_SQL.includes(INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL));
  assert.ok(POSTCHECK_SQL.includes(INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL));
  assert.match(INVALID_TARIFFS_SQL, /LEFT JOIN tipo_persona/i);
  assert.match(INVALID_TARIFFS_SQL, /LEFT JOIN regimen/i);
  assert.match(INVALID_TARIFFS_SQL, /LEFT JOIN temporada_tarifa/i);
  assert.match(INVALID_ADDITIONAL_TARIFFS_SQL, /LEFT JOIN adicional/i);
  assert.match(INVALID_ADDITIONAL_TARIFFS_SQL, /LEFT JOIN regimen/i);
  assert.match(INVALID_ADDITIONAL_TARIFFS_SQL, /LEFT JOIN temporada_tarifa/i);
  assert.match(INVALID_TARIFF_DIMENSIONS_SQL, /tt\.id\s+IS\s+NULL/i);
  assert.match(INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL, /ad\.id\s+IS\s+NULL/i);
  assert.match(INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL, /reg\.id\s+IS\s+NULL/i);
  assert.match(INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL, /tt\.id\s+IS\s+NULL/i);
  assert.match(
    SCRIPT_SOURCE,
    /async function deleteTariff[\s\S]*INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL[\s\S]*INVALID_TARIFF_DIMENSIONS_SQL/
  );
  assert.match(INVALID_TARIFFS_SQL, /tarifa_id_legacy/);
  assert.match(INVALID_ADDITIONAL_TARIFFS_SQL, /tarifa_adicional_id/);

  for (const jsonKey of [
    "reserva_id",
    "reserva_salud_id",
    "sorteo_id",
    "bloque_fecha_id",
    "bloque_id",
    "solicitud_id",
  ]) {
    assert.match(SCRIPT_SOURCE, new RegExp(`JSON_EXTRACT\\(n\\.payload, '\\$\\.${jsonKey}'\\)`));
  }
  assert.match(SCRIPT_SOURCE, /n\.tipo LIKE 'COSEGURO%'/);
  assert.match(SCRIPT_SOURCE, /payload_sha256/);
  assert.match(
    SCRIPT_SOURCE,
    /async function deleteNotification[\s\S]*tipo = \?[\s\S]*SHA2\(COALESCE\(CAST\(payload AS CHAR\), ''\), 256\) = \?/
  );
  assert.match(SCRIPT_SOURCE, /countTargetObservationReads/);
});
