#!/usr/bin/env node
"use strict";

// Corrige el descuento de los ADICIONALES de reservas de turismo que quedaron
// con el 100% de un "Menor de 2 años" (tipo_persona_id = 5).
//
// Regla anterior: cada noche los adicionales tomaban el mayor % de TODAS las
// personas, así que un bebé (tarifa al 100%) dejaba gratis la mascota, la
// cochera, etc. Regla vigente (api/services/descuento-adicionales.js): el mayor
// % del resto de las personas; si nadie más tiene %, 0%.
//
// El recálculo usa el snapshot que la reserva guardó de cada persona y noche
// (reserva_familiar_tarifa: tarifa_id, usa_porcentaje_aplicado,
// porcentaje_descuento_aplicado) y el precio de lista del adicional
// (tarifa_adicional del detalle), con las mismas funciones en centavos y puntos
// base que la API. Sólo toca detalles cuya fila coincide EXACTAMENTE con la
// regla anterior y no con la vigente; cualquier otra diferencia aborta.
//
// Uso (desde BACKEND). Los scripts cargan .env (bloque PRODUCCION activo) y
// dotenv no pisa variables ya definidas, así que para develop se pasan las
// DB_* del bloque DEVELOP:
//
//   # 1. Dry-run de sólo lectura: manifiesto + SHA-256 + antes/después.
//   DB_HOST=localhost DB_USER=<usuario> DB_PASSWORD=<clave> DB_DATABASE=db_miajb \
//     node scripts/corregir-descuento-adicionales-bebe.js
//
//   # 2. Aplicar exactamente el manifiesto revisado.
//   node scripts/corregir-descuento-adicionales-bebe.js --apply \
//     --confirm=CORREGIR_DESCUENTO_BEBE --manifest-sha256=<SHA256_DEL_DRY_RUN>
//
//   # Una base no local (RDS de producción) exige además --allow-production.
//
// Idempotente: una vez aplicado, el dry-run no encuentra candidatos y repetir
// el --apply con el mismo SHA-256 informa already_applied.

const {
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
const {
  aplicarDescuentoEnPuntosBase,
  centavosADecimal,
  decimalACentavos,
  decimalAPuntosBase,
  sumarCentavos,
} = require("../api/services/valores-dominio");
const {
  TIPO_PERSONA_MENOR_2,
  elegirMayorDescuentoTarifas,
  esMenorDe2,
  personasParaDescuentoAdicionales,
} = require("../api/services/descuento-adicionales");

const CONFIRMATION = "CORREGIR_DESCUENTO_BEBE";
const FIX_ID = "20260924_fix_descuento_adicionales_bebe";
const CORRECTION_LOCK = "ajb_fix_descuento_adicionales_bebe_20260924";
const HOSTS_LOCALES = new Set(["localhost", "127.0.0.1", "::1"]);

// Reservas con algún detalle de adicional que tomó el % de un menor de 2 años:
// su tarifa_id es una tarifa tipo 5, o es la tarifa (o el mismo %) que el
// snapshot de un bebé de la reserva tuvo esa noche.
const CANDIDATES_SQL = `
  SELECT DISTINCT ra.reserva_id AS id
    FROM reserva_adicional_detalle rad
    INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
    LEFT JOIN tarifa t ON t.id = rad.tarifa_id
   WHERE t.tipo_persona_id = ${TIPO_PERSONA_MENOR_2}
      OR EXISTS (
        SELECT 1
          FROM reserva_familiar rf
          INNER JOIN reserva_familiar_tarifa rft ON rft.reserva_familiar_id = rf.id
         WHERE rf.reserva_id = ra.reserva_id
           AND rf.tipo_persona_id = ${TIPO_PERSONA_MENOR_2}
           AND rft.fecha = rad.fecha
           AND (rft.tarifa_id = rad.tarifa_id
             OR (COALESCE(rad.porcentaje_descuento, 0) > 0
                 AND rft.usa_porcentaje_aplicado = 1
                 AND rft.porcentaje_descuento_aplicado = rad.porcentaje_descuento))
      )
   ORDER BY ra.reserva_id
`;

function integer(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Entero inesperado: ${value}`);
  return parsed;
}

function optionalId(value) {
  return value === null || value === undefined ? null : integer(value);
}

function cents(value, label) {
  const parsed = decimalACentavos(value ?? 0);
  if (parsed === null) throw new Error(`Importe inválido en ${label}: ${value}`);
  return parsed;
}

function basisPoints(value, label) {
  const parsed = decimalAPuntosBase(value ?? 0);
  if (parsed === null) throw new Error(`Porcentaje inválido en ${label}: ${value}`);
  return parsed;
}

// Los puntos base son centésimos de punto porcentual: 3500 → "35.00".
const money = (value) => centavosADecimal(value);
const percent = (value) => centavosADecimal(value);

/**
 * Plan puro de corrección de una reserva (sin base de datos).
 *
 * @returns {{ row: object|null, errors: string[], detalles_revisados: number }}
 *   row = null cuando ningún detalle necesita cambios.
 */
function planificarReserva({
  reserva,
  familiares = [],
  tarifasFamiliares = [],
  adicionales = [],
  detalles = [],
  tarifasAdicionales = [],
  descuentosConAdicionales = [],
  saludes = 0,
}) {
  const reservaId = integer(reserva.id);
  const errors = [];
  const fail = (message) => errors.push(`reserva ${reservaId}: ${message}`);

  const snapshot = new Map(
    tarifasFamiliares.map((fila) => [`${integer(fila.reserva_familiar_id)}|${fila.fecha}`, fila])
  );
  const precioLista = new Map(tarifasAdicionales.map((fila) => [integer(fila.id), fila]));
  const adicionalPorId = new Map(adicionales.map((fila) => [integer(fila.id), fila]));
  const personas = familiares
    .slice()
    .sort((a, b) => integer(a.id) - integer(b.id))
    .map((fila) => ({ id: integer(fila.id), tipo_persona_id: integer(fila.tipo_persona_id) }));

  const detallesPlan = [];
  const subtotalNuevoPorAdicional = new Map();

  for (const detalle of detalles) {
    const detalleId = integer(detalle.id);
    const adicionalId = integer(detalle.reserva_adicional_id);
    const fecha = String(detalle.fecha);
    const cantidad = integer(detalle.cantidad);
    const adicional = adicionalPorId.get(adicionalId);
    const precioUnitarioAnterior = cents(detalle.precio_unitario, `detalle ${detalleId}`);
    const subtotalAnterior = cents(detalle.subtotal, `detalle ${detalleId}`);
    const puntosAnteriores = basisPoints(detalle.porcentaje_descuento, `detalle ${detalleId}`);
    const tarifaAnterior = optionalId(detalle.tarifa_id);
    let subtotalNuevo = subtotalAnterior;

    if (!adicional) {
      fail(`el detalle ${detalleId} no pertenece a un adicional de la reserva`);
      continue;
    }
    if (subtotalAnterior !== precioUnitarioAnterior * cantidad) {
      fail(`el detalle ${detalleId} no cumple subtotal = precio_unitario × cantidad`);
    }

    // Tarifas de cada persona esa noche, en el orden de la reserva.
    const personasNoche = personas.map((persona) => ({
      ...persona,
      snapshot: snapshot.get(`${persona.id}|${fecha}`) || null,
    }));
    const sinSnapshot = personasNoche.filter((persona) => !persona.snapshot);
    if (sinSnapshot.length > 0 || personasNoche.length === 0) {
      fail(`falta el snapshot de tarifa de alguna persona para la noche ${fecha}`);
      continue;
    }
    const tarifaDe = (persona) => ({
      id: optionalId(persona.snapshot.tarifa_id),
      usa_porcentaje: persona.snapshot.usa_porcentaje_aplicado,
      porcentaje_descuento: persona.snapshot.porcentaje_descuento_aplicado,
    });
    let reglaAnterior;
    let reglaVigente;
    try {
      reglaAnterior = elegirMayorDescuentoTarifas(personasNoche.map(tarifaDe), { fecha });
      reglaVigente = elegirMayorDescuentoTarifas(
        personasParaDescuentoAdicionales(personasNoche).map(tarifaDe),
        { fecha }
      );
    } catch (error) {
      fail(`snapshot inválido para la noche ${fecha}: ${error.message}`);
      continue;
    }
    const tarifasBebe = new Set(
      personasNoche.filter(esMenorDe2).map((persona) => optionalId(persona.snapshot.tarifa_id))
    );

    const yaVigente = puntosAnteriores === reglaVigente.porcentaje_puntos_base &&
      (tarifaAnterior === reglaVigente.tarifa_id || !tarifasBebe.has(tarifaAnterior));
    if (yaVigente) {
      subtotalNuevoPorAdicional.set(
        adicionalId,
        sumarCentavos(subtotalNuevoPorAdicional.get(adicionalId) ?? 0, subtotalAnterior)
      );
      continue;
    }
    const esReglaAnterior = puntosAnteriores === reglaAnterior.porcentaje_puntos_base &&
      (tarifaAnterior === reglaAnterior.tarifa_id || tarifasBebe.has(tarifaAnterior));
    if (!esReglaAnterior) {
      fail(
        `el detalle ${detalleId} (${fecha}) tiene ${percent(puntosAnteriores)}% y tarifa ${tarifaAnterior}, ` +
        "que no coincide ni con la regla anterior ni con la vigente; revisar a mano"
      );
      continue;
    }

    const tarifaAdicionalId = optionalId(detalle.tarifa_adicional_id);
    const lista = tarifaAdicionalId ? precioLista.get(tarifaAdicionalId) : null;
    if (!lista || integer(lista.adicional_id) !== integer(adicional.adicional_id)) {
      fail(`el detalle ${detalleId} no tiene una tarifa de adicional válida para recuperar el precio de lista`);
      continue;
    }
    const precioListaCentavos = cents(lista.precio, `tarifa_adicional ${tarifaAdicionalId}`);
    if (aplicarDescuentoEnPuntosBase(precioListaCentavos, puntosAnteriores) !== precioUnitarioAnterior) {
      fail(`el precio de lista del detalle ${detalleId} cambió desde el alta; no se puede recalcular con certeza`);
      continue;
    }
    const precioUnitarioNuevo = aplicarDescuentoEnPuntosBase(
      precioListaCentavos,
      reglaVigente.porcentaje_puntos_base
    );
    subtotalNuevo = precioUnitarioNuevo === null ? null : precioUnitarioNuevo * cantidad;
    if (subtotalNuevo === null || !Number.isSafeInteger(subtotalNuevo)) {
      fail(`el nuevo importe del detalle ${detalleId} excede el rango monetario`);
      continue;
    }
    subtotalNuevoPorAdicional.set(
      adicionalId,
      sumarCentavos(subtotalNuevoPorAdicional.get(adicionalId) ?? 0, subtotalNuevo)
    );
    detallesPlan.push({
      id: detalleId,
      reserva_adicional_id: adicionalId,
      fecha,
      cantidad,
      tarifa_adicional_id: tarifaAdicionalId,
      precio_lista: money(precioListaCentavos),
      anterior: {
        precio_unitario: money(precioUnitarioAnterior),
        subtotal: money(subtotalAnterior),
        porcentaje_descuento: percent(puntosAnteriores),
        tarifa_id: tarifaAnterior,
      },
      nuevo: {
        precio_unitario: money(precioUnitarioNuevo),
        subtotal: money(subtotalNuevo),
        porcentaje_descuento: percent(reglaVigente.porcentaje_puntos_base),
        tarifa_id: reglaVigente.tarifa_id,
      },
    });
  }

  if (detallesPlan.length === 0) {
    return { row: null, errors, detalles_revisados: detalles.length };
  }

  // Consistencia previa: sólo se corrige una reserva cuyos totales cierran.
  const adicionalesPlan = [];
  let montoAnterior = 0;
  let montoNuevo = 0;
  for (const adicional of adicionales.slice().sort((a, b) => integer(a.id) - integer(b.id))) {
    const id = integer(adicional.id);
    const subtotalAnterior = cents(adicional.subtotal, `reserva_adicional ${id}`);
    const sumaDetalles = detalles
      .filter((detalle) => integer(detalle.reserva_adicional_id) === id)
      .reduce((total, detalle) => sumarCentavos(total, cents(detalle.subtotal, `detalle ${detalle.id}`)), 0);
    if (sumaDetalles !== subtotalAnterior) {
      fail(`el adicional ${id} no coincide con la suma de sus detalles`);
    }
    const subtotalNuevo = subtotalNuevoPorAdicional.get(id) ?? subtotalAnterior;
    montoAnterior = sumarCentavos(montoAnterior, subtotalAnterior);
    montoNuevo = sumarCentavos(montoNuevo, subtotalNuevo);
    adicionalesPlan.push({
      id,
      adicional_id: integer(adicional.adicional_id),
      nombre: String(adicional.nombre_adicional ?? ""),
      cantidad: integer(adicional.cantidad),
      subtotal_anterior: money(subtotalAnterior),
      subtotal_nuevo: money(subtotalNuevo),
    });
  }

  const sumaFamiliares = familiares.reduce(
    (total, fila) => sumarCentavos(total, cents(fila.precio, `reserva_familiar ${fila.id}`)),
    0
  );
  const montoAdicionales = cents(reserva.monto_adicionales, "reserva.monto_adicionales");
  const montoDescuentos = cents(reserva.monto_descuentos ?? 0, "reserva.monto_descuentos");
  const precioTotalAnterior = cents(reserva.precio_total, "reserva.precio_total");
  if (montoAdicionales !== montoAnterior) {
    fail("monto_adicionales no coincide con la suma de los adicionales");
  }
  if (precioTotalAnterior !== sumarCentavos(sumaFamiliares, montoAnterior, -montoDescuentos)) {
    fail("precio_total no coincide con familiares + adicionales - descuentos");
  }
  if (descuentosConAdicionales.length > 0) {
    fail(
      "tiene descuentos que incluyen adicionales (reserva_descuento " +
      `${descuentosConAdicionales.map((fila) => fila.id).join(", ")}); ` +
      "su importe depende del monto de adicionales: recalcularlo editando la reserva, no con este script"
    );
  }
  if (Number(saludes) > 0 || Number(reserva.es_por_salud) === 1) {
    fail("es un viaje por salud: el subsidio se calcula sobre el total y debe revisarse a mano");
  }
  const precioTotalNuevo = sumarCentavos(sumaFamiliares, montoNuevo, -montoDescuentos);
  if (precioTotalNuevo === null || precioTotalNuevo < 0) {
    fail("el nuevo precio_total no es válido");
  }

  return {
    errors,
    detalles_revisados: detalles.length,
    row: {
      id: reservaId,
      estado_reserva_id: integer(reserva.estado_reserva_id),
      estado: reserva.estado ?? null,
      modalidad: String(reserva.modalidad),
      fecha_inicio: String(reserva.fecha_inicio),
      fecha_fin: String(reserva.fecha_fin),
      suma_familiares: money(sumaFamiliares),
      monto_descuentos: money(montoDescuentos),
      monto_adicionales_anterior: money(montoAdicionales),
      monto_adicionales_nuevo: money(montoNuevo),
      precio_total_anterior: money(precioTotalAnterior),
      precio_total_nuevo: money(precioTotalNuevo),
      adicionales: adicionalesPlan,
      detalles: detallesPlan,
    },
  };
}

async function loadReservationData(connection, reservaId) {
  const tieneDescuentos = Boolean(await columnInfo(connection, "reserva", "monto_descuentos"));
  const [[reserva]] = await connection.query(
    `SELECT r.id, r.estado_reserva_id, er.nombre AS estado, r.modalidad, r.fecha_inicio, r.fecha_fin,
            CAST(r.precio_total AS DECIMAL(12,2)) AS precio_total,
            CAST(r.monto_adicionales AS DECIMAL(12,2)) AS monto_adicionales,
            ${tieneDescuentos ? "CAST(COALESCE(r.monto_descuentos, 0) AS DECIMAL(12,2))" : "0"} AS monto_descuentos,
            r.es_por_salud
       FROM reserva r
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.id = ?`,
    [reservaId]
  );
  const [familiares] = await connection.query(
    `SELECT id, tipo_persona_id, CAST(precio AS DECIMAL(12,2)) AS precio
       FROM reserva_familiar WHERE reserva_id = ? ORDER BY id`,
    [reservaId]
  );
  const [tarifasFamiliares] = await connection.query(
    `SELECT rft.reserva_familiar_id, rft.fecha, rft.tarifa_id, rft.usa_porcentaje_aplicado,
            CAST(rft.porcentaje_descuento_aplicado AS DECIMAL(5,2)) AS porcentaje_descuento_aplicado
       FROM reserva_familiar_tarifa rft
       INNER JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
      WHERE rf.reserva_id = ?
      ORDER BY rf.id, rft.fecha`,
    [reservaId]
  );
  const [adicionales] = await connection.query(
    `SELECT id, adicional_id, nombre_adicional, cantidad, dias,
            CAST(subtotal AS DECIMAL(12,2)) AS subtotal
       FROM reserva_adicional WHERE reserva_id = ? ORDER BY id`,
    [reservaId]
  );
  const [detalles] = await connection.query(
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
  const [tarifasAdicionales] = await connection.query(
    `SELECT DISTINCT ta.id, ta.adicional_id, CAST(ta.precio AS DECIMAL(12,2)) AS precio
       FROM tarifa_adicional ta
       INNER JOIN reserva_adicional_detalle rad ON rad.tarifa_adicional_id = ta.id
       INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
      WHERE ra.reserva_id = ?
      ORDER BY ta.id`,
    [reservaId]
  );
  let descuentosConAdicionales = [];
  if (await tableExists(connection, "reserva_descuento")) {
    [descuentosConAdicionales] = await connection.query(
      `SELECT id FROM reserva_descuento
        WHERE reserva_id = ?
          AND (COALESCE(JSON_EXTRACT(detalle_json, '$.incluye_adicionales') = TRUE, FALSE)
               -- El tope global de calcularDescuentos depende del total con adicionales:
               -- un descuento recortado habría sido otro con los adicionales corregidos.
               OR COALESCE(JSON_EXTRACT(detalle_json, '$.recortado') = TRUE, FALSE))
        ORDER BY id`,
      [reservaId]
    );
  }
  const salud = await queryOne(
    connection,
    "SELECT COUNT(*) AS cantidad FROM reserva_salud WHERE reserva_id = ?",
    [reservaId]
  );
  return {
    reserva,
    familiares,
    tarifasFamiliares,
    adicionales,
    detalles,
    tarifasAdicionales,
    descuentosConAdicionales,
    saludes: Number(salud.cantidad || 0),
  };
}

async function loadManifest(connection) {
  const [candidates] = await connection.query(CANDIDATES_SQL);
  const errors = [];
  const rows = [];
  const sinCambios = [];
  for (const candidate of candidates) {
    const reservaId = integer(candidate.id);
    const plan = planificarReserva(await loadReservationData(connection, reservaId));
    errors.push(...plan.errors);
    if (plan.row) rows.push(plan.row);
    else sinCambios.push(reservaId);
  }
  const manifest = {
    correction_id: FIX_ID,
    regla: "adicionales = mayor % de las personas sin contar menores de 2 años (tipo 5)",
    rows,
  };
  const canonical = stableJson(manifest);
  return { manifest, canonical, hash: sha256(canonical), errors, sinCambios };
}

function summary(result) {
  const rows = result.manifest.rows;
  const ajuste = rows.reduce(
    (total, row) => total + decimalACentavos(row.precio_total_nuevo) - decimalACentavos(row.precio_total_anterior),
    0
  );
  return {
    cantidad: rows.length,
    ajuste_total: centavosADecimal(ajuste),
    reservas_candidatas_sin_cambios: result.sinCambios || [],
    antes_despues: rows.map((row) => ({
      reserva: row.id,
      estado: row.estado,
      precio_total: `${row.precio_total_anterior} -> ${row.precio_total_nuevo}`,
      monto_adicionales: `${row.monto_adicionales_anterior} -> ${row.monto_adicionales_nuevo}`,
      adicionales: row.adicionales
        .filter((adicional) => adicional.subtotal_anterior !== adicional.subtotal_nuevo)
        .map((adicional) => `${adicional.nombre}: ${adicional.subtotal_anterior} -> ${adicional.subtotal_nuevo}`),
      noches: row.detalles.map((detalle) =>
        `${detalle.fecha} detalle ${detalle.id}: ${detalle.anterior.porcentaje_descuento}% ` +
        `(tarifa ${detalle.anterior.tarifa_id}) $${detalle.anterior.precio_unitario} -> ` +
        `${detalle.nuevo.porcentaje_descuento}% (tarifa ${detalle.nuevo.tarifa_id}) $${detalle.nuevo.precio_unitario}` +
        ` sobre lista $${detalle.precio_lista}`
      ),
    })),
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
  if (rows.length !== 1 || rows[0].estado !== "APLICADA" || rows[0].checksum !== MIGRATION_CHECKSUM) {
    throw new Error(`La migración ${MIGRATION_ID} no está aplicada con el checksum esperado`);
  }
  for (const [table, column] of [
    ["reserva", "precio_total"],
    ["reserva", "monto_adicionales"],
    ["reserva_adicional_detalle", "precio_unitario"],
  ]) {
    const info = await columnInfo(connection, table, column);
    if (!info || String(info.COLUMN_TYPE).toLowerCase() !== "decimal(12,2)") {
      throw new Error(`${table}.${column} no cumple DECIMAL(12,2)`);
    }
  }
}

// Misma tabla de respaldo que corregir-doble-adicional-reservas.js; aquí
// monto_adicionales es el valor anterior y suma_adicionales el corregido. El
// manifest_json conserva cada detalle antes/después para poder revertir.
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
  for (const column of ["manifest_sha256", "manifest_json", "monto_adicionales", "suma_adicionales"]) {
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
            COALESCE(SUM(r.id IS NULL
              OR CAST(r.precio_total AS DECIMAL(12,2)) <> b.precio_total_nuevo
              OR CAST(r.monto_adicionales AS DECIMAL(12,2)) <> b.suma_adicionales), 0) AS inconsistentes
       FROM ajb_reserva_precio_backup b
       LEFT JOIN reserva r ON r.id = b.reserva_id
      WHERE b.correccion_id = ?`,
    [manifestHash, FIX_ID]
  );
}

async function verifyExistingBackup(connection, manifestHash) {
  const [rows] = await connection.query(
    `SELECT b.*, CAST(r.precio_total AS DECIMAL(12,2)) AS precio_actual
       FROM ajb_reserva_precio_backup b
       LEFT JOIN reserva r ON r.id = b.reserva_id
      WHERE b.correccion_id = ?
      ORDER BY b.reserva_id`,
    [FIX_ID]
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
    const manifestRow = byId.get(Number(backup.reserva_id));
    if (
      backup.manifest_sha256 !== manifestHash ||
      !manifestRow ||
      sha256(stableJson(manifestRow)) !== backup.checksum ||
      String(backup.precio_actual) !== manifestRow.precio_total_nuevo
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

function describirAdicional(row, adicional) {
  const porcentajes = (lado) => [...new Set(
    row.detalles
      .filter((detalle) => detalle.reserva_adicional_id === adicional.id)
      .map((detalle) => detalle[lado].porcentaje_descuento)
  )].map((valor) => `${Number(valor)}%`).join("/");
  return {
    anterior: `-${porcentajes("anterior")} dto. · $${adicional.subtotal_anterior}`,
    nuevo: `-${porcentajes("nuevo")} dto. · $${adicional.subtotal_nuevo}`,
  };
}

async function applyCorrection(connection, expectedHash) {
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
      throw new Error(`El conjunto cambió o no coincide: esperado ${expectedHash}, observado ${locked.hash}`);
    }
    if (locked.manifest.rows.length === 0) throw new Error("El manifiesto aprobado está vacío");

    const observacion = (row) =>
      `Corrección ${FIX_ID}: los adicionales habían tomado el 100% de un menor de 2 años; ` +
      "se aplica el mayor descuento del resto de las personas de la reserva. " +
      `Manifiesto SHA-256 ${expectedHash}`;

    for (const row of locked.manifest.rows) {
      await archivarVersionReservaAntesDeReemplazo(
        connection,
        row.id,
        { id: null, rol: "SCRIPT_INTEGRIDAD" },
        "CORRECCION"
      );
      await connection.query(
        `INSERT INTO ajb_reserva_precio_backup
          (correccion_id, reserva_id, manifest_sha256, manifest_json,
           precio_total_anterior, precio_total_nuevo, suma_familiares,
           suma_adicionales, monto_adicionales, estado_reserva_id, modalidad,
           fecha_inicio, fecha_fin, checksum)
         VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          FIX_ID,
          row.id,
          expectedHash,
          locked.canonical,
          row.precio_total_anterior,
          row.precio_total_nuevo,
          row.suma_familiares,
          row.monto_adicionales_nuevo,
          row.monto_adicionales_anterior,
          row.estado_reserva_id,
          row.modalidad,
          row.fecha_inicio,
          row.fecha_fin,
          sha256(stableJson(row)),
        ]
      );

      for (const detalle of row.detalles) {
        const [update] = await connection.query(
          `UPDATE reserva_adicional_detalle
              SET precio_unitario = ?, subtotal = ?, porcentaje_descuento = ?, tarifa_id = ?
            WHERE id = ?
              AND reserva_adicional_id = ?
              AND CAST(precio_unitario AS DECIMAL(12,2)) = ?
              AND CAST(subtotal AS DECIMAL(12,2)) = ?
              AND CAST(COALESCE(porcentaje_descuento, 0) AS DECIMAL(5,2)) = ?
              AND tarifa_id <=> ?`,
          [
            detalle.nuevo.precio_unitario,
            detalle.nuevo.subtotal,
            detalle.nuevo.porcentaje_descuento,
            detalle.nuevo.tarifa_id,
            detalle.id,
            detalle.reserva_adicional_id,
            detalle.anterior.precio_unitario,
            detalle.anterior.subtotal,
            detalle.anterior.porcentaje_descuento,
            detalle.anterior.tarifa_id,
          ]
        );
        if (Number(update.affectedRows) !== 1) {
          throw new Error(`El detalle ${detalle.id} de la reserva ${row.id} cambió durante la corrección`);
        }
      }

      for (const adicional of row.adicionales) {
        if (adicional.subtotal_anterior === adicional.subtotal_nuevo) continue;
        const [update] = await connection.query(
          `UPDATE reserva_adicional SET subtotal = ?
            WHERE id = ? AND reserva_id = ? AND CAST(subtotal AS DECIMAL(12,2)) = ?`,
          [adicional.subtotal_nuevo, adicional.id, row.id, adicional.subtotal_anterior]
        );
        if (Number(update.affectedRows) !== 1) {
          throw new Error(`El adicional ${adicional.id} de la reserva ${row.id} cambió durante la corrección`);
        }
        const texto = describirAdicional(row, adicional);
        await connection.query(
          `INSERT INTO historial_reserva
            (reserva_id, tipo_operacion, campo_modificado, valor_anterior,
             valor_nuevo, usuario_modificador_id, fecha_modificacion, observaciones)
           VALUES (?, 'UPDATE', ?, ?, ?, NULL, NOW(), ?)`,
          [row.id, `Adicional (${adicional.nombre})`.slice(0, 100), texto.anterior, texto.nuevo, observacion(row)]
        );
      }

      for (const [campo, anterior, nuevo] of [
        ["monto_adicionales", row.monto_adicionales_anterior, row.monto_adicionales_nuevo],
        ["precio_total", row.precio_total_anterior, row.precio_total_nuevo],
      ]) {
        await connection.query(
          `INSERT INTO historial_reserva
            (reserva_id, tipo_operacion, campo_modificado, valor_anterior,
             valor_nuevo, usuario_modificador_id, fecha_modificacion, observaciones)
           VALUES (?, 'UPDATE', ?, ?, ?, NULL, NOW(), ?)`,
          [row.id, campo, anterior, nuevo, observacion(row)]
        );
      }

      const [update] = await connection.query(
        `UPDATE reserva
            SET monto_adicionales = ?, precio_total = ?
          WHERE id = ?
            AND CAST(precio_total AS DECIMAL(12,2)) = ?
            AND CAST(monto_adicionales AS DECIMAL(12,2)) = ?
            AND estado_reserva_id = ?
            AND modalidad = ?
            AND fecha_inicio = ?
            AND fecha_fin = ?`,
        [
          row.monto_adicionales_nuevo,
          row.precio_total_nuevo,
          row.id,
          row.precio_total_anterior,
          row.monto_adicionales_anterior,
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

    // Después de escribir, la regla vigente ya no debe encontrar diferencias.
    const after = await loadManifest(connection);
    if (after.errors.length > 0 || after.manifest.rows.length > 0) {
      throw new Error("La verificación transaccional falló: siguen quedando detalles por corregir");
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

function esBaseLocal(host = process.env.DB_HOST) {
  return HOSTS_LOCALES.has(String(host || "").trim().toLowerCase());
}

function validateApplyArguments(args, { nodeEnv = process.env.NODE_ENV, host = process.env.DB_HOST } = {}) {
  const apply = args.apply === true;
  if (!apply) return { apply: false };
  if (args.confirm !== CONFIRMATION) {
    throw new Error(`Para aplicar se exige --confirm=${CONFIRMATION}`);
  }
  const manifestSha256 = String(args["manifest-sha256"] || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new Error("Para aplicar se exige --manifest-sha256=<hash del dry-run>");
  }
  if ((nodeEnv === "production" || !esBaseLocal(host)) && args["allow-production"] !== true) {
    throw new Error("La base no es local (o NODE_ENV=production): se exige también --allow-production");
  }
  return { apply: true, manifestSha256 };
}

async function main() {
  const args = parseArguments();
  const { apply, manifestSha256 } = validateApplyArguments(args);

  const connection = await createConnection();
  let lockAcquired = false;
  try {
    if (!apply) {
      const result = await dryRun(connection);
      console.log(
        JSON.stringify(
          {
            mode: "dry-run-read-only",
            base: { host_local: esBaseLocal(), database: process.env.DB_DATABASE || null },
            valid: result.errors.length === 0 && result.manifest.rows.length > 0,
            manifest_sha256: result.hash,
            summary: summary(result),
            manifest: result.manifest,
            validation_errors: result.errors,
            apply_requires:
              `--apply --confirm=${CONFIRMATION} --manifest-sha256=${result.hash}` +
              (esBaseLocal() ? "" : " --allow-production"),
          },
          null,
          2
        )
      );
      if (result.errors.length > 0 || result.manifest.rows.length === 0) process.exitCode = 2;
      return;
    }

    const lock = await queryOne(connection, "SELECT GET_LOCK(?, 0) AS adquirido", [CORRECTION_LOCK]);
    if (Number(lock.adquirido) !== 1) throw new Error("Otra corrección está en curso");
    lockAcquired = true;

    await ensureCorrectionPrerequisites(connection);
    await ensureBackupTable(connection);
    const previous = await appliedStatus(connection, manifestSha256);
    if (Number(previous.backups) > 0) {
      const existingVerification = await verifyExistingBackup(connection, manifestSha256);
      if (
        Number(previous.otros_manifiestos) === 0 &&
        Number(previous.inconsistentes) === 0 &&
        existingVerification.ok
      ) {
        console.log(JSON.stringify({
          mode: "apply",
          already_applied: true,
          manifest_sha256: manifestSha256,
          backups: existingVerification.count,
        }));
        return;
      }
      throw new Error(
        `Existe un backup parcial, inconsistente o de otro manifiesto: ${existingVerification.reason || "estado inválido"}`
      );
    }

    const applied = await applyCorrection(connection, manifestSha256);
    const after = await appliedStatus(connection, manifestSha256);
    if (
      Number(after.backups) !== applied.manifest.rows.length ||
      Number(after.otros_manifiestos) !== 0 ||
      Number(after.inconsistentes) !== 0
    ) {
      throw new Error("La verificación posterior al commit no coincide con el manifiesto");
    }
    console.log(JSON.stringify({
      mode: "apply",
      applied: true,
      manifest_sha256: manifestSha256,
      summary: summary(applied),
    }, null, 2));
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

module.exports = {
  CANDIDATES_SQL,
  CONFIRMATION,
  FIX_ID,
  esBaseLocal,
  loadManifest,
  planificarReserva,
  summary,
  validateApplyArguments,
};
