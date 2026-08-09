#!/usr/bin/env node
"use strict";

const {
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  canonicalizeSql,
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

const CLEANUP_ID = "20260809_limpieza_datos_prueba_inconsistentes";
const MANIFEST_VERSION = 1;
const CONFIRMATION = "LIMPIAR_DATOS_PRUEBA_INCONSISTENTES";
const HISTORY_CONFIRMATION = "PURGAR_HISTORIAL_PRUEBA";
const CLEANUP_LOCK = "ajb_limpieza_datos_prueba_20260809";
const ARCHIVE_DELETE_TRIGGER = "ajb_reserva_archivo_bd";
const TERMINAL_RESERVATION_STATES = [
  "cancelada",
  "finalizada",
  "rechazada",
  "utilizada",
  "no adjudicada",
  "convenio rechazado",
];

const SNAPSHOT_COVERAGE_SQL = `
  SELECT r.id,
         COUNT(DISTINCT rf.id) AS familiares,
         DATEDIFF(r.fecha_fin, r.fecha_inicio) * COUNT(DISTINCT rf.id) AS esperado,
         COUNT(rft.id) AS actual,
         COUNT(DISTINCT rf.id, rft.fecha) AS pares_unicos,
         COALESCE(SUM(
           rft.id IS NOT NULL
           AND (rft.fecha < r.fecha_inicio OR rft.fecha >= r.fecha_fin)
         ), 0) AS fuera_de_rango,
         COALESCE(SUM(
           rft.id IS NOT NULL
           AND (
             rft.snapshot_estado <> 'COMPLETO'
             OR rft.tarifa_id IS NULL
             OR rft.precio_aplicado IS NULL
             OR rft.snapshot_creado_en IS NULL
             OR rft.usa_porcentaje_aplicado IS NULL
             OR rft.usa_porcentaje_aplicado NOT IN (0, 1)
             OR (
               rft.usa_porcentaje_aplicado = 1
               AND (
                 rft.porcentaje_descuento_aplicado IS NULL
                 OR rft.porcentaje_descuento_aplicado < 0
                 OR rft.porcentaje_descuento_aplicado > 100
               )
             )
             OR (
               rft.usa_porcentaje_aplicado = 0
               AND COALESCE(rft.porcentaje_descuento_aplicado, 0) <> 0
             )
           )
         ), 0) AS snapshots_invalidos
    FROM reserva r
    LEFT JOIN reserva_familiar rf ON rf.reserva_id = r.id
    LEFT JOIN reserva_familiar_tarifa rft ON rft.reserva_familiar_id = rf.id
   WHERE r.modalidad <> 'CONVENIO'
   GROUP BY r.id, r.fecha_inicio, r.fecha_fin
`;

const INCOMPLETE_SNAPSHOT_PREDICATE_SQL = `
  cobertura.familiares = 0
  OR cobertura.esperado <> cobertura.actual
  OR cobertura.actual <> cobertura.pares_unicos
  OR cobertura.fuera_de_rango <> 0
  OR cobertura.snapshots_invalidos <> 0
`;

const INVALID_TARIFF_DIMENSIONS_SQL = `
  r.id IS NULL OR tp.id IS NULL OR reg.id IS NULL OR tt.id IS NULL
  OR sr.servicio_id IS NULL
`;

const INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL = `
  r.id IS NULL OR ad.id IS NULL OR reg.id IS NULL OR tt.id IS NULL
  OR sr.servicio_id IS NULL
`;

const COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL = `
  s.porcentaje_cobertura_aplicado IS NULL OR s.importe_estimado IS NULL
`;

const OBSOLETE_RAFFLES_CTE = `
  WITH sorteos_obsoletos AS (
    SELECT s.id
      FROM sorteo s
     WHERE s.estado = 'ACTIVO'
       AND s.fecha_fin_inscripcion < CURDATE()
       AND NOT EXISTS (
         SELECT 1
           FROM bloque_fecha bf_futuro
          WHERE bf_futuro.sorteo_id = s.id
            AND bf_futuro.estado = 'ACTIVO'
            AND bf_futuro.fecha_fin > CURDATE()
       )
  )
`;

const OBSOLETE_RAFFLES_SQL = `
  SELECT s.id, s.estado, s.fecha_inicio_inscripcion, s.fecha_fin_inscripcion,
         (SELECT COUNT(*) FROM bloque_fecha bf WHERE bf.sorteo_id = s.id) AS bloques,
         (SELECT COUNT(*) FROM reserva r WHERE r.sorteo_id = s.id) AS reservas
    FROM sorteo s
   WHERE s.estado = 'ACTIVO'
     AND s.fecha_fin_inscripcion < CURDATE()
     AND NOT EXISTS (
       SELECT 1
         FROM bloque_fecha bf_futuro
        WHERE bf_futuro.sorteo_id = s.id
          AND bf_futuro.estado = 'ACTIVO'
          AND bf_futuro.fecha_fin > CURDATE()
     )
   ORDER BY s.id
`;

const RESERVATION_REASONS_SQL = `
  ${OBSOLETE_RAFFLES_CTE}
  SELECT DISTINCT rf.reserva_id, 'RFT_TARIFA_HUERFANA' AS motivo
    FROM reserva_familiar_tarifa rft
    INNER JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
    LEFT JOIN tarifa t ON t.id = rft.tarifa_id
   WHERE rft.tarifa_id IS NOT NULL AND t.id IS NULL
  UNION ALL
  SELECT DISTINCT ra.reserva_id, 'RAD_TARIFA_HUERFANA' AS motivo
    FROM reserva_adicional_detalle rad
    INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
    LEFT JOIN tarifa t ON t.id = rad.tarifa_id
   WHERE rad.tarifa_id IS NOT NULL AND t.id IS NULL
  UNION ALL
  SELECT cobertura.id, 'SNAPSHOT_DIARIO_INCOMPLETO' AS motivo
    FROM (${SNAPSHOT_COVERAGE_SQL}) cobertura
   WHERE ${INCOMPLETE_SNAPSHOT_PREDICATE_SQL}
  UNION ALL
  SELECT r.id, 'VENCIDA_NO_TERMINAL' AS motivo
    FROM reserva r
    LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
   WHERE r.fecha_fin < CURDATE()
     AND LOWER(TRIM(COALESCE(er.nombre, ''))) NOT IN
         ('cancelada','finalizada','rechazada','utilizada','no adjudicada','convenio rechazado')
  UNION ALL
  SELECT r.id, 'SORTEO_OBSOLETO' AS motivo
    FROM reserva r
   WHERE r.sorteo_id IN (SELECT id FROM sorteos_obsoletos)
      OR r.bloque_fecha_id IN (
        SELECT bf.id FROM bloque_fecha bf
         WHERE bf.sorteo_id IN (SELECT id FROM sorteos_obsoletos)
      )
  UNION ALL
  SELECT sar.reserva_id, 'RESPUESTA_SORTEO_OBSOLETO' AS motivo
    FROM sorteo_adjudicacion_respuesta sar
   WHERE sar.sorteo_id IN (SELECT id FROM sorteos_obsoletos)
      OR sar.bloque_fecha_id IN (
        SELECT bf.id FROM bloque_fecha bf
         WHERE bf.sorteo_id IN (SELECT id FROM sorteos_obsoletos)
      )
  UNION ALL
  SELECT bfr.reserva_id, 'RECURSO_SORTEO_OBSOLETO' AS motivo
    FROM bloque_fecha_recurso bfr
    INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
   WHERE bf.sorteo_id IN (SELECT id FROM sorteos_obsoletos)
     AND bfr.reserva_id IS NOT NULL
  UNION ALL
  SELECT bfr.reserva_id, 'RECURSO_BLOQUE_INCONSISTENTE' AS motivo
    FROM bloque_fecha bf
    INNER JOIN bloque_fecha_recurso bfr ON bfr.bloque_fecha_id = bf.id
    LEFT JOIN reserva r ON r.id = bfr.reserva_id
    LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
   WHERE bfr.reserva_id IS NOT NULL
     AND (
       (bf.estado IN ('LIBERADO', 'CANCELADO')
        AND bfr.estado NOT IN ('LIBERADO', 'DISPONIBLE', 'CANCELADO'))
       OR ((bfr.estado IN ('RESERVADO', 'ASIGNADO')) <> (bfr.reserva_id IS NOT NULL))
       OR (r.id IS NULL
           OR r.bloque_fecha_id <> bf.id
           OR r.recurso_id <> bfr.recurso_id
           OR LOWER(TRIM(COALESCE(er.nombre, ''))) IN
             ('cancelada','finalizada','rechazada','utilizada','no adjudicada','convenio rechazado'))
     )
   ORDER BY reserva_id, motivo
`;

const BLOCK_RESOURCE_INCONSISTENCIES_SQL = `
  SELECT bfr.id, bfr.bloque_fecha_id, bfr.recurso_id, bfr.estado, bfr.reserva_id,
         bf.modalidad, bf.estado AS bloque_estado, s.estado AS sorteo_estado
    FROM bloque_fecha bf
    INNER JOIN bloque_fecha_recurso bfr ON bfr.bloque_fecha_id = bf.id
    LEFT JOIN sorteo s ON s.id = bf.sorteo_id
    LEFT JOIN reserva r ON r.id = bfr.reserva_id
    LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
   WHERE (bf.estado IN ('LIBERADO', 'CANCELADO')
          AND bfr.estado NOT IN ('LIBERADO', 'DISPONIBLE', 'CANCELADO'))
      OR ((bfr.estado IN ('RESERVADO', 'ASIGNADO')) <> (bfr.reserva_id IS NOT NULL))
      OR (bfr.reserva_id IS NOT NULL AND (
           r.id IS NULL
           OR r.bloque_fecha_id <> bf.id
           OR r.recurso_id <> bfr.recurso_id
           OR LOWER(TRIM(COALESCE(er.nombre, ''))) IN
             ('cancelada','finalizada','rechazada','utilizada','no adjudicada','convenio rechazado')
         ))
   ORDER BY bfr.id
`;

const COINSURANCE_WITHOUT_SNAPSHOT_SQL = `
  SELECT s.id, s.estado_id, s.tipo_reintegro_id, s.eliminado,
         (SELECT COUNT(*) FROM coseguro_archivo a WHERE a.solicitud_id = s.id) AS archivos,
         (SELECT COUNT(*) FROM coseguro_historial h WHERE h.solicitud_id = s.id) AS historial,
         (SELECT COUNT(*) FROM coseguro_observacion o WHERE o.solicitud_id = s.id) AS observaciones,
         (SELECT COUNT(*) FROM coseguro_comprobante_claim c WHERE c.solicitud_id = s.id) AS claims,
         IF(s.firma_archivo IS NULL, 0, 1) AS firma_archivo
    FROM coseguro_solicitud s
    INNER JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id
   WHERE s.eliminado = 0
     AND t.modo_cobertura = 'PORCENTAJE'
     AND (${COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL})
   ORDER BY s.id
`;

const INVALID_TARIFFS_SQL = `
  SELECT t.id, t.recurso_id, r.servicio_id, t.tipo_persona_id,
         t.regimen_id, t.temporada_tarifa_id
    FROM tarifa t
    LEFT JOIN recurso r ON r.id = t.recurso_id
    LEFT JOIN tipo_persona tp ON tp.id = t.tipo_persona_id
    LEFT JOIN regimen reg ON reg.id = t.regimen_id
    LEFT JOIN temporada_tarifa tt ON tt.id = t.temporada_tarifa_id
    LEFT JOIN servicio_regimen sr
      ON sr.servicio_id = r.servicio_id AND sr.regimen_id = t.regimen_id
   WHERE (${INVALID_TARIFF_DIMENSIONS_SQL})
      AND NOT EXISTS (
       SELECT 1 FROM reserva_familiar_tarifa rft
        WHERE rft.tarifa_id = t.id OR rft.tarifa_id_legacy = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM reserva_adicional_detalle rad WHERE rad.tarifa_id = t.id
     )
   ORDER BY t.id
`;

const INVALID_ADDITIONAL_TARIFFS_SQL = `
  SELECT ta.id, ta.recurso_id, r.servicio_id, ta.adicional_id,
         ta.regimen_id, ta.temporada_tarifa_id
    FROM tarifa_adicional ta
    LEFT JOIN recurso r ON r.id = ta.recurso_id
    LEFT JOIN adicional ad ON ad.id = ta.adicional_id
    LEFT JOIN regimen reg ON reg.id = ta.regimen_id
    LEFT JOIN temporada_tarifa tt ON tt.id = ta.temporada_tarifa_id
    LEFT JOIN servicio_regimen sr
      ON sr.servicio_id = r.servicio_id AND sr.regimen_id = ta.regimen_id
   WHERE (${INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL})
      AND NOT EXISTS (
       SELECT 1 FROM reserva_adicional_detalle rad
        WHERE rad.tarifa_adicional_id = ta.id
     )
   ORDER BY ta.id
`;

const POSTCHECK_SQL = `
  WITH RECURSIVE cadena_familiar AS (
    SELECT id AS raiz, id AS actual, usuario_familiar_id AS siguiente,
           CAST(CONCAT(',', id, ',') AS CHAR(2048)) AS camino,
           0 AS ciclo, 0 AS profundidad
      FROM usuario
     WHERE usuario_familiar_id IS NOT NULL
    UNION ALL
    SELECT c.raiz, u.id, u.usuario_familiar_id,
           CONCAT(c.camino, u.id, ','),
           IF(LOCATE(CONCAT(',', u.id, ','), c.camino) > 0, 1, 0),
           c.profundidad + 1
      FROM cadena_familiar c
      INNER JOIN usuario u ON u.id = c.siguiente
     WHERE c.ciclo = 0 AND c.profundidad < 20
  )
  SELECT
    (SELECT COUNT(*) FROM reserva_familiar_tarifa rft
      LEFT JOIN tarifa t ON t.id = rft.tarifa_id
     WHERE rft.tarifa_id IS NOT NULL AND t.id IS NULL) AS rft_huerfanas,
    (SELECT COUNT(*) FROM reserva_adicional_detalle rad
      LEFT JOIN tarifa t ON t.id = rad.tarifa_id
     WHERE rad.tarifa_id IS NOT NULL AND t.id IS NULL) AS rad_huerfanas,
    (SELECT COUNT(*) FROM (${SNAPSHOT_COVERAGE_SQL}) cobertura
      WHERE ${INCOMPLETE_SNAPSHOT_PREDICATE_SQL}) AS reservas_snapshot_incompleto,
    (SELECT COUNT(*) FROM reserva r
      LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
     WHERE r.fecha_fin < CURDATE()
       AND LOWER(TRIM(COALESCE(er.nombre, ''))) NOT IN
         ('cancelada','finalizada','rechazada','utilizada','no adjudicada','convenio rechazado'))
      AS reservas_vencidas_no_terminales,
    (SELECT COUNT(*) FROM sorteo s
     WHERE s.estado = 'ACTIVO' AND s.fecha_fin_inscripcion < CURDATE()
       AND NOT EXISTS (SELECT 1 FROM bloque_fecha bf WHERE bf.sorteo_id = s.id
         AND bf.estado = 'ACTIVO' AND bf.fecha_fin > CURDATE())) AS sorteos_obsoletos,
    (SELECT COUNT(*) FROM bloque_fecha bf
      INNER JOIN bloque_fecha_recurso bfr ON bfr.bloque_fecha_id = bf.id
      LEFT JOIN reserva r ON r.id = bfr.reserva_id
      LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
     WHERE (bf.estado IN ('LIBERADO', 'CANCELADO')
            AND bfr.estado NOT IN ('LIBERADO', 'DISPONIBLE', 'CANCELADO'))
        OR ((bfr.estado IN ('RESERVADO', 'ASIGNADO')) <> (bfr.reserva_id IS NOT NULL))
        OR (bfr.reserva_id IS NOT NULL AND (
             r.id IS NULL OR r.bloque_fecha_id <> bf.id OR r.recurso_id <> bfr.recurso_id
             OR LOWER(TRIM(COALESCE(er.nombre, ''))) IN
               ('cancelada','finalizada','rechazada','utilizada','no adjudicada','convenio rechazado')
           ))) AS recursos_bloque_inconsistentes,
    (SELECT COUNT(*) FROM coseguro_solicitud s
      INNER JOIN coseguro_tipo_reintegro tr ON tr.id = s.tipo_reintegro_id
     WHERE s.eliminado = 0 AND tr.modo_cobertura = 'PORCENTAJE'
       AND (${COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL}))
      AS coseguros_sin_snapshot,
    (SELECT COUNT(*) FROM tarifa t
      LEFT JOIN recurso r ON r.id = t.recurso_id
      LEFT JOIN tipo_persona tp ON tp.id = t.tipo_persona_id
      LEFT JOIN regimen reg ON reg.id = t.regimen_id
      LEFT JOIN temporada_tarifa tt ON tt.id = t.temporada_tarifa_id
      LEFT JOIN servicio_regimen sr
        ON sr.servicio_id = r.servicio_id AND sr.regimen_id = t.regimen_id
      WHERE ${INVALID_TARIFF_DIMENSIONS_SQL})
      AS tarifas_fuera_servicio,
    (SELECT COUNT(*) FROM tarifa_adicional ta
      LEFT JOIN recurso r ON r.id = ta.recurso_id
      LEFT JOIN adicional ad ON ad.id = ta.adicional_id
      LEFT JOIN regimen reg ON reg.id = ta.regimen_id
      LEFT JOIN temporada_tarifa tt ON tt.id = ta.temporada_tarifa_id
      LEFT JOIN servicio_regimen sr
        ON sr.servicio_id = r.servicio_id AND sr.regimen_id = ta.regimen_id
     WHERE ${INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL}) AS tarifas_adicionales_fuera_servicio,
    (SELECT COUNT(*)
       FROM tarifa a
       INNER JOIN tarifa b
         ON a.id < b.id
        AND a.recurso_id <=> b.recurso_id
        AND a.regimen_id <=> b.regimen_id
        AND a.tipo_persona_id <=> b.tipo_persona_id
        AND COALESCE(a.edad_minima, 0) <= COALESCE(b.edad_maxima, 130)
        AND COALESCE(b.edad_minima, 0) <= COALESCE(a.edad_maxima, 130)
        AND a.fecha_inicio <= b.fecha_fin
        AND b.fecha_inicio <= a.fecha_fin
       LEFT JOIN temporada_tarifa ta ON ta.id = a.temporada_tarifa_id
       LEFT JOIN temporada_tarifa tb ON tb.id = b.temporada_tarifa_id
      WHERE a.temporada_tarifa_id <=> b.temporada_tarifa_id
         OR (
           COALESCE(ta.origen, 'GENERAL') = 'GENERAL'
           AND COALESCE(tb.origen, 'GENERAL') = 'GENERAL'
         )) AS tarifas_aplicables_solapadas,
    (SELECT COUNT(*)
       FROM tarifa_adicional a
       INNER JOIN tarifa_adicional b
         ON a.id < b.id
        AND a.recurso_id = b.recurso_id
        AND a.regimen_id = b.regimen_id
        AND a.adicional_id = b.adicional_id
        AND a.activo = 1 AND b.activo = 1
        AND a.fecha_inicio <= b.fecha_fin
        AND b.fecha_inicio <= a.fecha_fin
       LEFT JOIN temporada_tarifa ta ON ta.id = a.temporada_tarifa_id
       LEFT JOIN temporada_tarifa tb ON tb.id = b.temporada_tarifa_id
      WHERE a.temporada_tarifa_id = b.temporada_tarifa_id
         OR (
           COALESCE(ta.origen, 'GENERAL') = 'GENERAL'
           AND COALESCE(tb.origen, 'GENERAL') = 'GENERAL'
         )) AS adicionales_aplicables_solapados,
    (SELECT COUNT(*)
       FROM usuario relacionado
       LEFT JOIN usuario titular ON titular.id = relacionado.usuario_familiar_id
      WHERE relacionado.usuario_familiar_id IS NOT NULL
        AND (titular.id IS NULL
          OR relacionado.id = relacionado.usuario_familiar_id
          OR relacionado.departamental_id IS NULL
          OR titular.departamental_id IS NULL
          OR relacionado.departamental_id <> titular.departamental_id))
      AS familiares_vinculo_inconsistente,
    (SELECT COUNT(DISTINCT raiz) FROM cadena_familiar WHERE ciclo = 1)
      AS ciclos_familiares,
    (SELECT COUNT(*)
       FROM reserva r
      WHERE r.es_por_salud = 1
        AND NOT EXISTS (SELECT 1 FROM reserva_salud rs WHERE rs.reserva_id = r.id))
      AS reservas_salud_sin_detalle,
    (SELECT COUNT(*)
       FROM reserva_salud rs
       INNER JOIN reserva r ON r.id = rs.reserva_id
       LEFT JOIN (
         SELECT reserva_id, SUM(precio) AS total
           FROM reserva_familiar GROUP BY reserva_id
       ) f ON f.reserva_id = r.id
       LEFT JOIN (
         SELECT reserva_id, SUM(subtotal) AS total
           FROM reserva_adicional GROUP BY reserva_id
       ) a ON a.reserva_id = r.id
      WHERE rs.estado = 'APROBADA'
        AND NOT (
          r.es_por_salud = 1
          AND r.precio_total = 0
          AND rs.precio_cubierto IS NOT NULL
          AND ABS(rs.precio_cubierto - (COALESCE(f.total, 0) + COALESCE(a.total, 0))) <= 0.011
        )) AS subsidios_aprobados_inconsistentes,
    (SELECT COUNT(*)
       FROM observacion_lectura ol
      WHERE (
          ol.modulo = 'turismo'
          AND NOT EXISTS (SELECT 1 FROM reserva r WHERE r.id = ol.entidad_id)
        ) OR (
          ol.modulo = 'coseguro'
          AND NOT EXISTS (
            SELECT 1 FROM coseguro_solicitud cs WHERE cs.id = ol.entidad_id
          )
        )) AS observaciones_lectura_huerfanas
`;

const REQUIRED_TABLES = [
  "ajb_reserva_mutacion_guard",
  "ajb_reserva_precio_backup",
  "ajb_reserva_version_archivo",
  "ajb_schema_migration",
  "adicional",
  "bloque_fecha",
  "bloque_fecha_recurso",
  "coseguro_archivo",
  "coseguro_comprobante_claim",
  "coseguro_historial",
  "coseguro_observacion",
  "coseguro_solicitud",
  "coseguro_tipo_reintegro",
  "notificacion",
  "observacion_lectura",
  "estado_reserva",
  "historial_reserva",
  "recurso",
  "reserva",
  "reserva_adicional",
  "reserva_adicional_detalle",
  "reserva_familiar",
  "reserva_familiar_tarifa",
  "reserva_convenio_propuesta",
  "reserva_observacion",
  "reserva_salud",
  "reserva_salud_archivo",
  "regimen",
  "servicio_regimen",
  "sorteo",
  "sorteo_adjudicacion_respuesta",
  "tarifa",
  "tarifa_adicional",
  "temporada_tarifa",
  "tipo_persona",
  "usuario",
];

function integer(value, label = "entero") {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} invalido: ${value}`);
  return result;
}

function nullableInteger(value, label = "entero") {
  return value === null || value === undefined ? null : integer(value, label);
}

function dateString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function sortById(rows) {
  return [...rows].sort((left, right) => integer(left.id) - integer(right.id));
}

function agruparMotivos(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const id = integer(row.reserva_id, "reserva_id");
    const reason = String(row.motivo || "").trim();
    if (!reason) throw new Error(`La reserva ${id} no tiene motivo`);
    if (!grouped.has(id)) grouped.set(id, new Set());
    grouped.get(id).add(reason);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([id, reasons]) => ({ id, motivos: [...reasons].sort() }));
}

function esTemporadaExclusiva({ origen, bloques = [], referenciasReserva = [] }, blockIds, reservationIds) {
  if (String(origen || "").toUpperCase() !== "BLOQUE") return false;
  const allowedBlocks = new Set((blockIds || []).map(Number));
  const allowedReservations = new Set((reservationIds || []).map(Number));
  return bloques.length > 0 &&
    bloques.every((id) => allowedBlocks.has(Number(id))) &&
    referenciasReserva.every((id) => allowedReservations.has(Number(id)));
}

function estadoRecursoTrasLiberacion({ modalidad, estadoBloque, estadoSorteo }) {
  if (String(estadoBloque) !== "ACTIVO") return "LIBERADO";
  if (String(modalidad) !== "SORTEO") return "DISPONIBLE";
  if (String(estadoSorteo) === "ACTIVO") return "SORTEO";
  if (String(estadoSorteo) === "CERRADO") return "VENTA_DIRECTA";
  return "LIBERADO";
}

function normalizarManifiesto(sections = {}) {
  const normalizeRows = (rows) => sortById(rows || []).map((row) => {
    const normalized = { ...row, id: integer(row.id) };
    for (const key of ["motivos", "bloques", "referencias_reserva"]) {
      if (Array.isArray(normalized[key])) {
        normalized[key] = [...new Set(normalized[key])].sort((left, right) =>
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right))
        );
      }
    }
    return normalized;
  });
  return {
    cleanup_id: CLEANUP_ID,
    manifest_version: MANIFEST_VERSION,
    reservas: normalizeRows(sections.reservas),
    sorteos: normalizeRows(sections.sorteos),
    bloques: normalizeRows(sections.bloques),
    recursos_bloque: normalizeRows(sections.recursos_bloque),
    temporadas: normalizeRows(sections.temporadas),
    notificaciones: normalizeRows(sections.notificaciones),
    coseguros: normalizeRows(sections.coseguros),
    tarifas: normalizeRows(sections.tarifas),
    tarifas_adicionales: normalizeRows(sections.tarifas_adicionales),
    historial_prueba: {
      archivos: normalizeRows(sections.historial_prueba?.archivos),
      backups_correccion: [...(sections.historial_prueba?.backups_correccion || [])]
        .map((row) => ({ ...row, reserva_id: integer(row.reserva_id) }))
        .sort((left, right) =>
          String(left.correccion_id).localeCompare(String(right.correccion_id)) ||
          left.reserva_id - right.reserva_id
        ),
    },
  };
}

function manifestResult(sections, errors = []) {
  const manifest = normalizarManifiesto(sections);
  const canonical = stableJson(manifest);
  return { manifest, canonical, hash: sha256(canonical), errors: [...errors] };
}

function cantidadObjetivos(manifest) {
  return [
    "reservas",
    "sorteos",
    "bloques",
    "recursos_bloque",
    "temporadas",
    "notificaciones",
    "coseguros",
    "tarifas",
    "tarifas_adicionales",
  ].reduce((total, key) => total + (manifest?.[key]?.length || 0), 0);
}

function resumenManifiesto(manifest) {
  return {
    reservas: manifest.reservas.length,
    sorteos: manifest.sorteos.length,
    bloques: manifest.bloques.length,
    recursos_bloque: manifest.recursos_bloque.length,
    temporadas: manifest.temporadas.length,
    notificaciones: manifest.notificaciones.length,
    coseguros: manifest.coseguros.length,
    archivos_coseguro_referenciados: manifest.coseguros.reduce(
      (total, row) => total + integer(row.archivos || 0),
      0
    ),
    tarifas: manifest.tarifas.length,
    tarifas_adicionales: manifest.tarifas_adicionales.length,
    archivos_historial: manifest.historial_prueba.archivos.length,
    backups_correccion: manifest.historial_prueba.backups_correccion.length,
    objetivos_operacionales: cantidadObjetivos(manifest),
  };
}

function validarOpciones(args = {}, env = process.env) {
  const apply = args.apply === true;
  const purgeTestHistory = args["purge-test-history"] === true;
  const manifestSha256 = String(args["manifest-sha256"] || "").trim().toLowerCase();
  const production = String(env.NODE_ENV || "").trim().toLowerCase() === "production";
  if (purgeTestHistory && !apply) {
    throw new Error("--purge-test-history solo se admite junto con --apply");
  }
  if (apply && args.confirm !== CONFIRMATION) {
    throw new Error(`Para aplicar se exige --confirm=${CONFIRMATION}`);
  }
  if (apply && !/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new Error("Para aplicar se exige --manifest-sha256=<hash del dry-run>");
  }
  if (production && apply && args["allow-production"] !== true) {
    throw new Error("En produccion tambien se exige --allow-production");
  }
  if (production && String(env.DB_SSL_MODE || "").trim().toLowerCase() !== "verify-full") {
    throw new Error("En produccion DB_SSL_MODE debe ser verify-full");
  }
  const historyConfirmation = args["confirm-purge-history"] || args["confirm-history"];
  if (purgeTestHistory && historyConfirmation !== HISTORY_CONFIRMATION) {
    throw new Error(
      `Para purgar el historial se exige --confirm-purge-history=${HISTORY_CONFIRMATION}`
    );
  }
  return { apply, purgeTestHistory, manifestSha256, production };
}

function extraerShowCreateTrigger(row) {
  if (!row || typeof row !== "object") throw new Error("SHOW CREATE TRIGGER no devolvio una fila");
  const createSql = row["SQL Original Statement"] || row["Create Trigger"] ||
    Object.values(row).find((value) => /^\s*CREATE\s+(?:DEFINER\s*=.*?)?\s*TRIGGER\b/is.test(String(value)));
  if (!createSql || !/\bTRIGGER\s+(?:`[^`]+`\.)?`?ajb_reserva_archivo_bd`?(?:\s|$)/i.test(String(createSql))) {
    throw new Error("No se pudo capturar el CREATE del trigger append-only");
  }
  return {
    createSql: String(createSql).trim().replace(/;\s*$/, ""),
    sqlMode: String(row.sql_mode || row.SQL_MODE || ""),
  };
}

function crearTriggerCoincide(before, after) {
  return Boolean(before && after) &&
    canonicalizeSql(before.createSql) === canonicalizeSql(after.createSql) &&
    String(before.sqlMode || "") === String(after.sqlMode || "");
}

function ids(rows) {
  return (rows || []).map((row) => integer(row.id));
}

async function selectByIds(connection, sql, targetIds) {
  if (!targetIds.length) return [];
  const [rows] = await connection.query(sql, [targetIds]);
  return rows;
}

async function loadReservationRows(connection, reasonGroups) {
  const reservationIds = ids(reasonGroups);
  if (!reservationIds.length) return [];
  const rows = await selectByIds(
    connection,
    `SELECT r.id, r.estado_reserva_id, r.modalidad, r.sorteo_id, r.bloque_fecha_id,
            r.recurso_id, r.fecha_inicio, r.fecha_fin,
            (SELECT COUNT(*) FROM reserva_familiar rf WHERE rf.reserva_id = r.id) AS familiares,
            (SELECT COUNT(*) FROM reserva_familiar_tarifa rft
              INNER JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
             WHERE rf.reserva_id = r.id) AS tarifas_familiares,
            (SELECT COUNT(*) FROM reserva_adicional ra WHERE ra.reserva_id = r.id) AS adicionales,
            (SELECT COUNT(*) FROM reserva_adicional_detalle rad
              INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
             WHERE ra.reserva_id = r.id) AS detalles_adicionales
       FROM reserva r WHERE r.id IN (?) ORDER BY r.id`,
    reservationIds
  );
  const reasonMap = new Map(reasonGroups.map((row) => [row.id, row.motivos]));
  return rows.map((row) => ({
    id: integer(row.id),
    estado_reserva_id: nullableInteger(row.estado_reserva_id),
    modalidad: String(row.modalidad),
    sorteo_id: nullableInteger(row.sorteo_id),
    bloque_fecha_id: nullableInteger(row.bloque_fecha_id),
    recurso_id: nullableInteger(row.recurso_id),
    fecha_inicio: dateString(row.fecha_inicio),
    fecha_fin: dateString(row.fecha_fin),
    motivos: reasonMap.get(integer(row.id)) || [],
    dependencias: {
      familiares: integer(row.familiares),
      tarifas_familiares: integer(row.tarifas_familiares),
      adicionales: integer(row.adicionales),
      detalles_adicionales: integer(row.detalles_adicionales),
    },
  }));
}

async function loadBlockRows(connection, raffleIds) {
  const rows = await selectByIds(
    connection,
    `SELECT bf.id, bf.sorteo_id, bf.temporada_tarifa_id, bf.servicio_id,
            bf.modalidad, bf.estado, bf.fecha_inicio, bf.fecha_fin,
            (SELECT COUNT(*) FROM bloque_fecha_recurso bfr WHERE bfr.bloque_fecha_id = bf.id) AS recursos,
            (SELECT COUNT(*) FROM reserva r WHERE r.bloque_fecha_id = bf.id) AS reservas
       FROM bloque_fecha bf
      WHERE bf.sorteo_id IN (?) ORDER BY bf.id`,
    raffleIds
  );
  return rows.map((row) => ({
    id: integer(row.id),
    sorteo_id: integer(row.sorteo_id),
    temporada_tarifa_id: nullableInteger(row.temporada_tarifa_id),
    servicio_id: integer(row.servicio_id),
    modalidad: String(row.modalidad),
    estado: String(row.estado),
    fecha_inicio: dateString(row.fecha_inicio),
    fecha_fin: dateString(row.fecha_fin),
    recursos: integer(row.recursos),
    reservas: integer(row.reservas),
  }));
}

async function loadBlockResourceRows(connection) {
  const [rows] = await connection.query(BLOCK_RESOURCE_INCONSISTENCIES_SQL);
  return rows.map((row) => ({
    id: integer(row.id),
    bloque_fecha_id: integer(row.bloque_fecha_id),
    recurso_id: integer(row.recurso_id),
    estado: String(row.estado),
    reserva_id: nullableInteger(row.reserva_id),
    modalidad: String(row.modalidad),
    bloque_estado: String(row.bloque_estado),
    sorteo_estado: row.sorteo_estado === null ? null : String(row.sorteo_estado),
    estado_objetivo: estadoRecursoTrasLiberacion({
      modalidad: row.modalidad,
      estadoBloque: row.bloque_estado,
      estadoSorteo: row.sorteo_estado,
    }),
  }));
}

async function loadReservationHealthIds(connection, reservationIds) {
  if (!reservationIds.length) return [];
  const [rows] = await connection.query(
    "SELECT id FROM reserva_salud WHERE reserva_id IN (?) ORDER BY id",
    [reservationIds]
  );
  return ids(rows);
}

async function loadNotifications(connection, targets) {
  const reservationIds = targets.reservationIds || [];
  const reservationHealthIds = targets.reservationHealthIds || [];
  const raffleIds = targets.raffleIds || [];
  const blockIds = targets.blockIds || [];
  const coseguroIds = targets.coseguroIds || [];
  const predicates = [];
  const params = [];
  const responsePredicates = [];
  const responseParams = [];
  if (reservationIds.length) {
    responsePredicates.push("sar.reserva_id IN (?)");
    responseParams.push(reservationIds);
    predicates.push("JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.reserva_id')) IN (?)");
    params.push(reservationIds);
  }
  if (reservationHealthIds.length) {
    predicates.push("JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.reserva_salud_id')) IN (?)");
    params.push(reservationHealthIds);
  }
  if (raffleIds.length) {
    responsePredicates.push("sar.sorteo_id IN (?)");
    responseParams.push(raffleIds);
    predicates.push("JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.sorteo_id')) IN (?)");
    params.push(raffleIds);
  }
  if (blockIds.length) {
    responsePredicates.push("sar.bloque_fecha_id IN (?)");
    responseParams.push(blockIds);
    predicates.push("JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.bloque_fecha_id')) IN (?)");
    params.push(blockIds);
    predicates.push("JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.bloque_id')) IN (?)");
    params.push(blockIds);
  }
  if (responsePredicates.length) {
    predicates.push(
      `EXISTS (
        SELECT 1 FROM sorteo_adjudicacion_respuesta sar
         WHERE sar.notificacion_id = n.id
           AND (${responsePredicates.join(" OR ")})
      )`
    );
    params.push(...responseParams);
  }
  if (coseguroIds.length) {
    predicates.push(
      `(n.tipo LIKE 'COSEGURO%'
        AND JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.solicitud_id')) IN (?))`
    );
    params.push(coseguroIds);
  }
  if (!predicates.length) return [];
  const [rows] = await connection.query(
    `SELECT DISTINCT n.id, n.tipo,
            SHA2(COALESCE(CAST(n.payload AS CHAR), ''), 256) AS payload_sha256
       FROM notificacion n
      WHERE ${predicates.join(" OR ")}
      ORDER BY n.id`,
    params
  );
  return rows.map((row) => ({
    id: integer(row.id),
    tipo: String(row.tipo),
    payload_sha256: String(row.payload_sha256),
  }));
}

async function countTargetObservationReads(connection, reservationIds, coseguroIds) {
  const predicates = [];
  const params = [];
  if (reservationIds.length) {
    predicates.push("(ol.modulo = 'turismo' AND ol.entidad_id IN (?))");
    params.push(reservationIds);
  }
  if (coseguroIds.length) {
    predicates.push("(ol.modulo = 'coseguro' AND ol.entidad_id IN (?))");
    params.push(coseguroIds);
  }
  if (!predicates.length) return 0;
  const row = await queryOne(
    connection,
    `SELECT COUNT(*) AS cantidad
       FROM observacion_lectura ol
      WHERE ${predicates.join(" OR ")}`,
    params
  );
  return integer(row.cantidad);
}

async function loadExclusiveSeasons(connection, blocks, reservationIds) {
  const seasonIds = [...new Set(blocks.map((row) => row.temporada_tarifa_id).filter(Boolean))];
  if (!seasonIds.length) return [];
  const [seasonRows] = await connection.query(
    `SELECT tt.id, tt.origen, tt.fecha_inicio, tt.fecha_fin,
            (SELECT COUNT(*) FROM tarifa t WHERE t.temporada_tarifa_id = tt.id) AS tarifas,
            (SELECT COUNT(*) FROM tarifa_adicional ta WHERE ta.temporada_tarifa_id = tt.id) AS tarifas_adicionales
       FROM temporada_tarifa tt WHERE tt.id IN (?) ORDER BY tt.id`,
    [seasonIds]
  );
  const [allBlocks] = await connection.query(
    "SELECT id, temporada_tarifa_id FROM bloque_fecha WHERE temporada_tarifa_id IN (?) ORDER BY id",
    [seasonIds]
  );
  const [references] = await connection.query(
    `SELECT DISTINCT t.temporada_tarifa_id, rf.reserva_id
       FROM tarifa t
       INNER JOIN reserva_familiar_tarifa rft
         ON rft.tarifa_id = t.id OR rft.tarifa_id_legacy = t.id
       INNER JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
      WHERE t.temporada_tarifa_id IN (?)
      UNION
     SELECT DISTINCT t.temporada_tarifa_id, ra.reserva_id
       FROM tarifa t
       INNER JOIN reserva_adicional_detalle rad ON rad.tarifa_id = t.id
       INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
      WHERE t.temporada_tarifa_id IN (?)
      UNION
     SELECT DISTINCT ta.temporada_tarifa_id, ra.reserva_id
       FROM tarifa_adicional ta
       INNER JOIN reserva_adicional_detalle rad ON rad.tarifa_adicional_id = ta.id
       INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
      WHERE ta.temporada_tarifa_id IN (?)`,
    [seasonIds, seasonIds, seasonIds]
  );
  const candidateBlockIds = ids(blocks);
  return seasonRows
    .map((row) => {
      const seasonId = integer(row.id);
      const seasonBlocks = allBlocks
        .filter((block) => integer(block.temporada_tarifa_id) === seasonId)
        .map((block) => integer(block.id));
      const referenceReservations = references
        .filter((reference) => integer(reference.temporada_tarifa_id) === seasonId)
        .map((reference) => integer(reference.reserva_id));
      return {
        id: seasonId,
        origen: String(row.origen),
        fecha_inicio: dateString(row.fecha_inicio),
        fecha_fin: dateString(row.fecha_fin),
        tarifas: integer(row.tarifas),
        tarifas_adicionales: integer(row.tarifas_adicionales),
        bloques: seasonBlocks,
        referencias_reserva: [...new Set(referenceReservations)].sort((a, b) => a - b),
      };
    })
    .filter((row) => esTemporadaExclusiva(
      { origen: row.origen, bloques: row.bloques, referenciasReserva: row.referencias_reserva },
      candidateBlockIds,
      reservationIds
    ));
}

function normalizeRaffleRows(rows) {
  return rows.map((row) => ({
    id: integer(row.id),
    estado: String(row.estado),
    fecha_inicio_inscripcion: dateString(row.fecha_inicio_inscripcion),
    fecha_fin_inscripcion: dateString(row.fecha_fin_inscripcion),
    bloques: integer(row.bloques),
    reservas: integer(row.reservas),
  }));
}

function normalizeCoseguroRows(rows) {
  return rows.map((row) => ({
    id: integer(row.id),
    estado_id: integer(row.estado_id),
    tipo_reintegro_id: integer(row.tipo_reintegro_id),
    eliminado: integer(row.eliminado),
    archivos: integer(row.archivos),
    historial: integer(row.historial),
    observaciones: integer(row.observaciones),
    claims: integer(row.claims),
    firma_archivo: integer(row.firma_archivo),
    motivo: "PORCENTAJE_SIN_SNAPSHOT",
  }));
}

function normalizeTariffRows(rows) {
  return rows.map((row) => ({
    id: integer(row.id),
    recurso_id: nullableInteger(row.recurso_id),
    servicio_id: nullableInteger(row.servicio_id),
    tipo_persona_id: nullableInteger(row.tipo_persona_id),
    adicional_id: nullableInteger(row.adicional_id),
    regimen_id: nullableInteger(row.regimen_id),
    temporada_tarifa_id: nullableInteger(row.temporada_tarifa_id),
    motivo: "REGIMEN_NO_HABILITADO_SIN_REFERENCIAS",
  }));
}

async function loadHistoryRows(connection) {
  const [archiveRows] = await connection.query(
    `SELECT id, reserva_id, version_numero, operacion, contenido_sha256
       FROM ajb_reserva_version_archivo
      ORDER BY id`
  );
  const [backupRows] = await connection.query(
    `SELECT correccion_id, reserva_id, manifest_sha256, checksum
       FROM ajb_reserva_precio_backup
      ORDER BY correccion_id, reserva_id`
  );
  return {
    archivos: archiveRows.map((row) => ({
      id: integer(row.id),
      reserva_id: integer(row.reserva_id),
      version_numero: integer(row.version_numero),
      operacion: String(row.operacion),
      contenido_sha256: String(row.contenido_sha256),
    })),
    backups_correccion: backupRows.map((row) => ({
      correccion_id: String(row.correccion_id),
      reserva_id: integer(row.reserva_id),
      manifest_sha256: String(row.manifest_sha256),
      checksum: String(row.checksum),
    })),
  };
}

async function loadManifest(connection) {
  const [raffleRows] = await connection.query(OBSOLETE_RAFFLES_SQL);
  const sorteos = normalizeRaffleRows(raffleRows);
  const bloques = await loadBlockRows(connection, ids(sorteos));
  const recursosBloque = await loadBlockResourceRows(connection);
  const [reasonRows] = await connection.query(RESERVATION_REASONS_SQL);
  const reasonGroups = agruparMotivos(reasonRows);
  const reservas = await loadReservationRows(connection, reasonGroups);
  const reservationIds = ids(reservas);
  const blockIds = ids(bloques);
  const reservationHealthIds = await loadReservationHealthIds(connection, reservationIds);
  const [coseguroRows] = await connection.query(COINSURANCE_WITHOUT_SNAPSHOT_SQL);
  const coseguros = normalizeCoseguroRows(coseguroRows);
  const notificaciones = await loadNotifications(connection, {
    reservationIds,
    reservationHealthIds,
    raffleIds: ids(sorteos),
    blockIds,
    coseguroIds: ids(coseguros),
  });
  const temporadas = await loadExclusiveSeasons(connection, bloques, reservationIds);
  const [tariffRows] = await connection.query(INVALID_TARIFFS_SQL);
  const [additionalTariffRows] = await connection.query(INVALID_ADDITIONAL_TARIFFS_SQL);
  const historialPrueba = await loadHistoryRows(connection);
  const errors = [];
  if (reservas.length !== reasonGroups.length) {
    errors.push("El conjunto de reservas cambio mientras se construia el manifiesto");
  }
  const targetObservationReads = await countTargetObservationReads(
    connection,
    reservationIds,
    ids(coseguros)
  );
  if (targetObservationReads !== 0) {
    errors.push(
      `Hay ${targetObservationReads} lecturas de observacion ligadas a raices candidatas`
    );
  }
  return manifestResult(
    {
      reservas,
      sorteos,
      bloques,
      recursos_bloque: recursosBloque,
      temporadas,
      notificaciones,
      coseguros,
      tarifas: normalizeTariffRows(tariffRows),
      tarifas_adicionales: normalizeTariffRows(additionalTariffRows),
      historial_prueba: historialPrueba,
    },
    errors
  );
}

async function ensureSessionContract(connection, production) {
  const session = await queryOne(
    connection,
    "SELECT @@SESSION.sql_mode AS sql_mode, @@SESSION.time_zone AS time_zone"
  );
  if (!/\bSTRICT_(?:TRANS|ALL)_TABLES\b/.test(String(session.sql_mode || ""))) {
    throw new Error("La sesion no tiene SQL mode estricto");
  }
  if (String(session.time_zone) !== "-03:00") {
    throw new Error("La sesion no usa la zona horaria -03:00");
  }
  const [sslRows] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
  const tlsCipher = String(sslRows[0]?.Value || "");
  if (production && !tlsCipher) throw new Error("La conexion de produccion no usa TLS");
  return { sql_mode: String(session.sql_mode), time_zone: String(session.time_zone), tls: Boolean(tlsCipher) };
}

async function ensurePrerequisites(connection, production) {
  await ensureSessionContract(connection, production);
  const missing = [];
  for (const table of REQUIRED_TABLES) {
    if (!(await tableExists(connection, table))) missing.push(table);
  }
  if (missing.length) throw new Error(`Faltan tablas requeridas: ${missing.join(", ")}`);
  const [registry] = await connection.query(
    "SELECT checksum, estado FROM ajb_schema_migration WHERE migration_id = ?",
    [MIGRATION_ID]
  );
  if (
    registry.length !== 1 ||
    registry[0].estado !== "APLICADA" ||
    registry[0].checksum !== MIGRATION_CHECKSUM
  ) {
    throw new Error(`La migracion ${MIGRATION_ID} no esta aplicada con el checksum esperado`);
  }
  const guard = await queryOne(connection, "SELECT COUNT(*) AS cantidad FROM ajb_reserva_mutacion_guard");
  if (integer(guard.cantidad) !== 0) {
    throw new Error("Hay guardias de mutacion de reserva pendientes; se aborta la limpieza");
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

async function lockByIds(connection, sql, targetIds) {
  if (targetIds.length) await connection.query(sql, [targetIds]);
}

async function lockManifestRows(connection, manifest) {
  const reservationIds = ids(manifest.reservas);
  const raffleIds = ids(manifest.sorteos);
  const blockIds = ids(manifest.bloques);
  const blockResourceIds = ids(manifest.recursos_bloque);
  const seasonIds = ids(manifest.temporadas);
  const notificationIds = ids(manifest.notificaciones);
  const coseguroIds = ids(manifest.coseguros);
  const tariffIds = ids(manifest.tarifas);
  const additionalTariffIds = ids(manifest.tarifas_adicionales);

  await lockByIds(connection, "SELECT id FROM reserva WHERE id IN (?) ORDER BY id FOR UPDATE", reservationIds);
  await lockByIds(connection, "SELECT id FROM reserva_familiar WHERE reserva_id IN (?) ORDER BY reserva_id, id FOR UPDATE", reservationIds);
  await lockByIds(
    connection,
    `SELECT rft.id FROM reserva_familiar_tarifa rft
      INNER JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
      WHERE rf.reserva_id IN (?) ORDER BY rf.reserva_id, rf.id, rft.id FOR UPDATE`,
    reservationIds
  );
  await lockByIds(connection, "SELECT id FROM reserva_adicional WHERE reserva_id IN (?) ORDER BY reserva_id, id FOR UPDATE", reservationIds);
  await lockByIds(
    connection,
    `SELECT rad.id FROM reserva_adicional_detalle rad
      INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
      WHERE ra.reserva_id IN (?) ORDER BY ra.reserva_id, ra.id, rad.id FOR UPDATE`,
    reservationIds
  );
  for (const table of [
    "historial_reserva",
    "reserva_convenio_propuesta",
    "reserva_observacion",
    "reserva_salud",
    "sorteo_adjudicacion_respuesta",
  ]) {
    await lockByIds(
      connection,
      `SELECT id FROM ${table} WHERE reserva_id IN (?) ORDER BY reserva_id, id FOR UPDATE`,
      reservationIds
    );
  }
  await lockByIds(connection, "SELECT id FROM sorteo WHERE id IN (?) ORDER BY id FOR UPDATE", raffleIds);
  await lockByIds(connection, "SELECT id FROM bloque_fecha WHERE id IN (?) ORDER BY id FOR UPDATE", blockIds);
  await lockByIds(connection, "SELECT id FROM bloque_fecha_recurso WHERE bloque_fecha_id IN (?) ORDER BY bloque_fecha_id, id FOR UPDATE", blockIds);
  await lockByIds(connection, "SELECT id FROM bloque_fecha_recurso WHERE id IN (?) ORDER BY id FOR UPDATE", blockResourceIds);
  await lockByIds(connection, "SELECT id FROM bloque_fecha_recurso WHERE reserva_id IN (?) ORDER BY reserva_id, id FOR UPDATE", reservationIds);
  await lockByIds(connection, "SELECT id FROM temporada_tarifa WHERE id IN (?) ORDER BY id FOR UPDATE", seasonIds);
  await lockByIds(connection, "SELECT id FROM notificacion WHERE id IN (?) ORDER BY id FOR UPDATE", notificationIds);
  await lockByIds(connection, "SELECT id FROM coseguro_solicitud WHERE id IN (?) ORDER BY id FOR UPDATE", coseguroIds);
  for (const table of ["coseguro_archivo", "coseguro_historial", "coseguro_observacion", "coseguro_comprobante_claim"]) {
    await lockByIds(
      connection,
      `SELECT id FROM ${table} WHERE solicitud_id IN (?) ORDER BY solicitud_id, id FOR UPDATE`,
      coseguroIds
    );
  }
  await lockByIds(connection, "SELECT id FROM tarifa WHERE id IN (?) ORDER BY id FOR UPDATE", tariffIds);
  await lockByIds(connection, "SELECT id FROM tarifa_adicional WHERE id IN (?) ORDER BY id FOR UPDATE", additionalTariffIds);
  await lockByIds(
    connection,
    `SELECT rsa.id FROM reserva_salud_archivo rsa
      INNER JOIN reserva_salud rs ON rs.id = rsa.reserva_salud_id
      WHERE rs.reserva_id IN (?) ORDER BY rs.reserva_id, rs.id, rsa.id FOR UPDATE`,
    reservationIds
  );
}

async function deleteReservation(connection, row) {
  await archivarVersionReservaAntesDeReemplazo(
    connection,
    row.id,
    { id: null, rol: "SCRIPT_LIMPIEZA_PRUEBA" },
    "ELIMINACION"
  );
  await connection.query(
    `UPDATE bloque_fecha_recurso bfr
      INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
      LEFT JOIN sorteo s ON s.id = bf.sorteo_id
       SET bfr.estado = CASE
             WHEN bf.estado <> 'ACTIVO' THEN 'LIBERADO'
             WHEN bf.modalidad <> 'SORTEO' THEN 'DISPONIBLE'
             WHEN s.estado = 'ACTIVO' THEN 'SORTEO'
             WHEN s.estado = 'CERRADO' THEN 'VENTA_DIRECTA'
             ELSE 'LIBERADO'
           END,
           bfr.reserva_id = NULL
     WHERE bfr.reserva_id = ?`,
    [row.id]
  );
  const [result] = await connection.query("DELETE FROM reserva WHERE id = ?", [row.id]);
  if (integer(result.affectedRows) !== 1) throw new Error(`No se elimino exactamente la reserva ${row.id}`);
  await cerrarGuardiaArchivoReserva(connection, row.id);
}

async function normalizeBlockResource(connection, row) {
  const [currentRows] = await connection.query(
    `SELECT bfr.id, bf.modalidad, bf.estado AS bloque_estado, s.estado AS sorteo_estado
       FROM bloque_fecha_recurso bfr
       INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
       LEFT JOIN sorteo s ON s.id = bf.sorteo_id
      WHERE bfr.id = ? FOR UPDATE`,
    [row.id]
  );
  if (currentRows.length !== 1) throw new Error(`No existe el recurso de bloque ${row.id}`);
  const target = estadoRecursoTrasLiberacion({
    modalidad: currentRows[0].modalidad,
    estadoBloque: currentRows[0].bloque_estado,
    estadoSorteo: currentRows[0].sorteo_estado,
  });
  if (target !== row.estado_objetivo) {
    throw new Error(`El bloque del recurso ${row.id} cambio durante la limpieza`);
  }
  await connection.query(
    "UPDATE bloque_fecha_recurso SET estado = ?, reserva_id = NULL WHERE id = ?",
    [target, row.id]
  );
}

async function deleteNotification(connection, row) {
  const [result] = await connection.query(
    `DELETE FROM notificacion
      WHERE id = ?
        AND tipo = ?
        AND SHA2(COALESCE(CAST(payload AS CHAR), ''), 256) = ?
        AND NOT EXISTS (
          SELECT 1 FROM sorteo_adjudicacion_respuesta sar
           WHERE sar.notificacion_id = notificacion.id
        )`,
    [row.id, row.tipo, row.payload_sha256]
  );
  if (integer(result.affectedRows) !== 1) {
    throw new Error(`La notificacion ${row.id} aun tiene referencias o cambio durante la limpieza`);
  }
}

async function deleteCoseguro(connection, row) {
  const [result] = await connection.query(
    `DELETE s FROM coseguro_solicitud s
      INNER JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id
      WHERE s.id = ? AND s.eliminado = 0
        AND t.modo_cobertura = 'PORCENTAJE'
        AND (${COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL})`,
    [row.id]
  );
  if (integer(result.affectedRows) !== 1) throw new Error(`El coseguro ${row.id} cambio durante la limpieza`);
}

async function deleteTariff(connection, row, additional = false) {
  const table = additional ? "tarifa_adicional" : "tarifa";
  const alias = additional ? "ta" : "t";
  const dimensionJoins = additional
    ? `LEFT JOIN recurso r ON r.id = ta.recurso_id
       LEFT JOIN adicional ad ON ad.id = ta.adicional_id
       LEFT JOIN regimen reg ON reg.id = ta.regimen_id
       LEFT JOIN temporada_tarifa tt ON tt.id = ta.temporada_tarifa_id
       LEFT JOIN servicio_regimen sr
         ON sr.servicio_id = r.servicio_id AND sr.regimen_id = ta.regimen_id`
    : `LEFT JOIN recurso r ON r.id = t.recurso_id
       LEFT JOIN tipo_persona tp ON tp.id = t.tipo_persona_id
       LEFT JOIN regimen reg ON reg.id = t.regimen_id
       LEFT JOIN temporada_tarifa tt ON tt.id = t.temporada_tarifa_id
       LEFT JOIN servicio_regimen sr
         ON sr.servicio_id = r.servicio_id AND sr.regimen_id = t.regimen_id`;
  const invalidDimensions = additional
    ? INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL
    : INVALID_TARIFF_DIMENSIONS_SQL;
  const references = additional
    ? "NOT EXISTS (SELECT 1 FROM reserva_adicional_detalle rad WHERE rad.tarifa_adicional_id = ta.id)"
    : `NOT EXISTS (SELECT 1 FROM reserva_familiar_tarifa rft
          WHERE rft.tarifa_id = t.id OR rft.tarifa_id_legacy = t.id)
       AND NOT EXISTS (SELECT 1 FROM reserva_adicional_detalle rad WHERE rad.tarifa_id = t.id)`;
  const [result] = await connection.query(
    `DELETE ${alias} FROM ${table} ${alias}
      ${dimensionJoins}
      WHERE ${alias}.id = ? AND (${invalidDimensions}) AND ${references}`,
    [row.id]
  );
  if (integer(result.affectedRows) !== 1) {
    throw new Error(`La tarifa ${additional ? "adicional " : ""}${row.id} cambio durante la limpieza`);
  }
}

async function deleteBlock(connection, row) {
  const remaining = await queryOne(connection, "SELECT COUNT(*) AS cantidad FROM reserva WHERE bloque_fecha_id = ?", [row.id]);
  if (integer(remaining.cantidad) !== 0) throw new Error(`El bloque ${row.id} conserva reservas`);
  const [result] = await connection.query("DELETE FROM bloque_fecha WHERE id = ?", [row.id]);
  if (integer(result.affectedRows) !== 1) throw new Error(`No se elimino exactamente el bloque ${row.id}`);
}

async function deleteRaffle(connection, row) {
  const remaining = await queryOne(
    connection,
    `SELECT (SELECT COUNT(*) FROM bloque_fecha WHERE sorteo_id = ?) +
            (SELECT COUNT(*) FROM reserva WHERE sorteo_id = ?) +
            (SELECT COUNT(*) FROM sorteo_adjudicacion_respuesta WHERE sorteo_id = ?) AS cantidad`,
    [row.id, row.id, row.id]
  );
  if (integer(remaining.cantidad) !== 0) throw new Error(`El sorteo ${row.id} conserva referencias`);
  const [result] = await connection.query("DELETE FROM sorteo WHERE id = ?", [row.id]);
  if (integer(result.affectedRows) !== 1) throw new Error(`No se elimino exactamente el sorteo ${row.id}`);
}

async function deleteSeason(connection, row) {
  const remaining = await queryOne(
    connection,
    `SELECT
       (SELECT COUNT(*) FROM bloque_fecha bf WHERE bf.temporada_tarifa_id = ?) +
       (SELECT COUNT(*) FROM tarifa t INNER JOIN reserva_familiar_tarifa rft
          ON rft.tarifa_id = t.id OR rft.tarifa_id_legacy = t.id
         WHERE t.temporada_tarifa_id = ?) +
       (SELECT COUNT(*) FROM tarifa t INNER JOIN reserva_adicional_detalle rad ON rad.tarifa_id = t.id
         WHERE t.temporada_tarifa_id = ?) +
       (SELECT COUNT(*) FROM tarifa_adicional ta INNER JOIN reserva_adicional_detalle rad
          ON rad.tarifa_adicional_id = ta.id WHERE ta.temporada_tarifa_id = ?) AS cantidad`,
    [row.id, row.id, row.id, row.id]
  );
  if (integer(remaining.cantidad) !== 0) throw new Error(`La temporada ${row.id} conserva referencias`);
  const [result] = await connection.query(
    "DELETE FROM temporada_tarifa WHERE id = ? AND origen = 'BLOQUE'",
    [row.id]
  );
  if (integer(result.affectedRows) !== 1) throw new Error(`No se elimino exactamente la temporada ${row.id}`);
}

async function assertPostcheckMetrics(connection) {
  const metrics = await queryOne(connection, POSTCHECK_SQL);
  const remaining = Object.entries(metrics)
    .filter(([, value]) => Number(value) !== 0)
    .map(([key, value]) => `${key}=${value}`);
  if (remaining.length) {
    throw new Error(`Persisten metricas de inconsistencia: ${remaining.join(", ")}`);
  }
  return metrics;
}

async function applyCleanup(connection, expectedHash) {
  await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await connection.beginTransaction();
  try {
    const initial = await loadManifest(connection);
    if (initial.errors.length) throw new Error(initial.errors.join(" | "));
    if (initial.hash !== expectedHash) {
      throw new Error(`El manifiesto no coincide: esperado ${expectedHash}, observado ${initial.hash}`);
    }
    await lockManifestRows(connection, initial.manifest);
    const locked = await loadManifest(connection);
    if (locked.errors.length) throw new Error(locked.errors.join(" | "));
    if (locked.hash !== expectedHash) {
      throw new Error(`El conjunto cambio durante los bloqueos: ${locked.hash}`);
    }

    const reservationIds = ids(locked.manifest.reservas);
    const coseguroIds = ids(locked.manifest.coseguros);
    const notificationTargets = {
      reservationIds,
      reservationHealthIds: await loadReservationHealthIds(connection, reservationIds),
      raffleIds: ids(locked.manifest.sorteos),
      blockIds: ids(locked.manifest.bloques),
      coseguroIds,
    };
    if (await countTargetObservationReads(connection, reservationIds, coseguroIds)) {
      throw new Error("Aparecieron lecturas de observacion ligadas a las raices candidatas");
    }

    for (const row of locked.manifest.reservas) await deleteReservation(connection, row);
    for (const row of locked.manifest.recursos_bloque) await normalizeBlockResource(connection, row);
    for (const row of locked.manifest.coseguros) await deleteCoseguro(connection, row);
    for (const row of locked.manifest.tarifas_adicionales) await deleteTariff(connection, row, true);
    for (const row of locked.manifest.tarifas) await deleteTariff(connection, row, false);
    for (const row of locked.manifest.bloques) await deleteBlock(connection, row);
    for (const row of locked.manifest.sorteos) await deleteRaffle(connection, row);
    for (const row of locked.manifest.temporadas) await deleteSeason(connection, row);
    for (const row of locked.manifest.notificaciones) await deleteNotification(connection, row);

    const lingeringNotifications = await loadNotifications(connection, notificationTargets);
    if (lingeringNotifications.length !== 0) {
      throw new Error(
        `Persisten ${lingeringNotifications.length} notificaciones ligadas a raices purgadas`
      );
    }
    if (await countTargetObservationReads(connection, reservationIds, coseguroIds)) {
      throw new Error("Persisten lecturas de observacion ligadas a las raices purgadas");
    }

    const after = await loadManifest(connection);
    if (after.errors.length || cantidadObjetivos(after.manifest) !== 0) {
      throw new Error("La verificacion transaccional posterior aun detecta inconsistencias");
    }
    await assertPostcheckMetrics(connection);
    const guard = await queryOne(
      connection,
      "SELECT COUNT(*) AS cantidad FROM ajb_reserva_mutacion_guard WHERE conexion_id = CONNECTION_ID()"
    );
    if (integer(guard.cantidad) !== 0) throw new Error("La conexion conserva guardias de reserva");
    await connection.commit();
    return locked;
  } catch (error) {
    await connection.rollback();
    try {
      await limpiarTokenGuardiaArchivoReserva(connection);
    } catch (_) {
      // El rollback tambien revierte la guardia persistida.
    }
    throw error;
  }
}

async function captureArchiveDeleteTrigger(connection) {
  const [rows] = await connection.query(`SHOW CREATE TRIGGER \`${ARCHIVE_DELETE_TRIGGER}\``);
  return extraerShowCreateTrigger(rows[0]);
}

async function restoreArchiveDeleteTrigger(connection, snapshot) {
  const current = await queryOne(connection, "SELECT @@SESSION.sql_mode AS sql_mode");
  try {
    if (snapshot.sqlMode) await connection.query("SET SESSION sql_mode = ?", [snapshot.sqlMode]);
    await connection.query(snapshot.createSql);
  } finally {
    await connection.query("SET SESSION sql_mode = ?", [current.sql_mode]);
  }
  const restored = await captureArchiveDeleteTrigger(connection);
  if (!crearTriggerCoincide(snapshot, restored)) {
    throw new Error("El trigger append-only fue recreado pero no coincide con el original");
  }
}

async function purgeTestHistory(connection, triggerSnapshot) {
  let dropped = false;
  let primaryError = null;
  let restoreError = null;
  let deletedArchives = 0;
  let deletedBackups = 0;
  try {
    await connection.query(`DROP TRIGGER \`${ARCHIVE_DELETE_TRIGGER}\``);
    dropped = true;
    await connection.beginTransaction();
    try {
      const [archives] = await connection.query(
        "DELETE FROM ajb_reserva_version_archivo"
      );
      deletedArchives = integer(archives.affectedRows);

      const [backups] = await connection.query(
        "DELETE FROM ajb_reserva_precio_backup"
      );
      deletedBackups = integer(backups.affectedRows);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (dropped) {
      try {
        await restoreArchiveDeleteTrigger(connection, triggerSnapshot);
      } catch (error) {
        restoreError = error;
      }
    }
  }

  if (restoreError) {
    const error = new Error(
      `FALLO CRITICO al restaurar ${ARCHIVE_DELETE_TRIGGER}: ${restoreError.message}`
    );
    error.cause = primaryError || restoreError;
    throw error;
  }
  if (primaryError) throw primaryError;

  const remaining = await queryOne(
    connection,
    `SELECT
       (SELECT COUNT(*) FROM ajb_reserva_version_archivo) AS archivos,
       (SELECT COUNT(*) FROM ajb_reserva_precio_backup) AS backups`
  );
  if (integer(remaining.archivos) !== 0 || integer(remaining.backups) !== 0) {
    throw new Error("La purga integral del historial de prueba quedo incompleta");
  }
  return { archivos_eliminados: deletedArchives, backups_eliminados: deletedBackups, trigger_restaurado: true };
}

async function main() {
  const args = parseArguments();
  const options = validarOpciones(args);
  const connection = await createConnection();
  let lockAcquired = false;
  try {
    await ensurePrerequisites(connection, options.production);
    if (!options.apply) {
      const result = await dryRun(connection);
      console.log(JSON.stringify({
        mode: "dry-run-read-only",
        valid: result.errors.length === 0,
        nothing_to_do: cantidadObjetivos(result.manifest) === 0,
        manifest_sha256: result.hash,
        manifest: result.manifest,
        summary: resumenManifiesto(result.manifest),
        validation_errors: result.errors,
        apply_requires:
          `--apply --confirm=${CONFIRMATION} --manifest-sha256=${result.hash}`,
        purge_history_requires:
          `--purge-test-history --confirm-purge-history=${HISTORY_CONFIRMATION}`,
      }, null, 2));
      if (result.errors.length) process.exitCode = 2;
      return;
    }

    const lock = await queryOne(connection, "SELECT GET_LOCK(?, 0) AS adquirido", [CLEANUP_LOCK]);
    if (integer(lock.adquirido) !== 1) throw new Error("Otra limpieza de datos esta en curso");
    lockAcquired = true;
    await ensurePrerequisites(connection, options.production);

    let triggerSnapshot = null;
    if (options.purgeTestHistory) {
      triggerSnapshot = await captureArchiveDeleteTrigger(connection);
    }

    const applied = await applyCleanup(connection, options.manifestSha256);
    let history = null;
    if (options.purgeTestHistory) {
      history = await purgeTestHistory(connection, triggerSnapshot);
    }

    const finalCheck = await dryRun(connection);
    if (finalCheck.errors.length || cantidadObjetivos(finalCheck.manifest) !== 0) {
      throw new Error("La verificacion posterior al commit no quedo limpia");
    }
    await assertPostcheckMetrics(connection);
    console.log(JSON.stringify({
      mode: "apply",
      applied: cantidadObjetivos(applied.manifest) > 0,
      already_clean: cantidadObjetivos(applied.manifest) === 0,
      manifest_sha256: options.manifestSha256,
      summary: resumenManifiesto(applied.manifest),
      purge_test_history: history,
      postcheck_clean: true,
    }, null, 2));
  } finally {
    if (lockAcquired) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [CLEANUP_LOCK]);
      } catch (_) {
        // Cerrar la conexion tambien libera el advisory lock.
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

module.exports = {
  ARCHIVE_DELETE_TRIGGER,
  BLOCK_RESOURCE_INCONSISTENCIES_SQL,
  CLEANUP_ID,
  CLEANUP_LOCK,
  COINSURANCE_MISSING_SNAPSHOT_PREDICATE_SQL,
  COINSURANCE_WITHOUT_SNAPSHOT_SQL,
  CONFIRMATION,
  HISTORY_CONFIRMATION,
  INCOMPLETE_SNAPSHOT_PREDICATE_SQL,
  INVALID_ADDITIONAL_TARIFFS_SQL,
  INVALID_ADDITIONAL_TARIFF_DIMENSIONS_SQL,
  INVALID_TARIFFS_SQL,
  INVALID_TARIFF_DIMENSIONS_SQL,
  MANIFEST_VERSION,
  OBSOLETE_RAFFLES_SQL,
  POSTCHECK_SQL,
  RESERVATION_REASONS_SQL,
  SNAPSHOT_COVERAGE_SQL,
  TERMINAL_RESERVATION_STATES,
  agruparMotivos,
  cantidadObjetivos,
  crearTriggerCoincide,
  estadoRecursoTrasLiberacion,
  esTemporadaExclusiva,
  extraerShowCreateTrigger,
  manifestResult,
  normalizarManifiesto,
  resumenManifiesto,
  validarOpciones,
};
