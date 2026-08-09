#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const {
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  MIGRATION_REVISION,
  createConnection,
  parseArguments,
  redactError,
  runDataPreflight,
  sha256,
  stableJson,
} = require("./integridad-financiera-common");
const {
  aplicarDescuentoEnPuntosBase,
  calcularEdadEnFecha,
  centavosADecimal,
  decimalACentavos,
  decimalAPuntosBase,
  diferenciaDiasCivil,
  obtenerNochesReserva,
  sumarCentavos,
  sumarDiasFechaCivil,
} = require("../api/services/valores-dominio");

const MARKER = "[AJB-DEMO:v1]";
const LEGACY_SEASON_NAME = "Temporada de prueba (seed)";
const FALLBACK_LOW_SEASON_NAME = `${MARKER} Temporada baja`;
const HIGH_SEASON_NAME = `${MARKER} Temporada alta`;
const RAFFLE_NAME = `${MARKER} Sorteo de temporada alta`;
const BLOCK_NAME = `${MARKER} Bloque de sorteo`;
const OLYMPICS_NAME = `${MARKER} Olimpiadas abiertas`;
const RESERVATION_NOTE = `${MARKER} Reserva fecha libre con adicional`;
const APPLY_CONFIRMATION = "APLICAR_DATOS_DEMO";
const SEED_LOCK = "ajb_seed_demo_integral_v1";
const LOW_BASE_CENTS = 5_000_000;
const HIGH_BASE_CENTS = 6_500_000;
const ADDITIONAL_CENTS = 500_000;
const LOW_NIGHTS = 2;
const HIGH_BLOCK_DAYS = 5;
const MAX_SEARCH_DAYS = 366;

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function naturalNameMatches(actual, wanted) {
  const actualNormalized = normalizeName(actual);
  const wantedNormalized = normalizeName(wanted);
  if (actualNormalized === wantedNormalized) return true;
  if (!/[?\uFFFD]/u.test(actualNormalized)) return false;
  const escapedPattern = [...actualNormalized]
    .map((character) => {
      if (character === "?" || character === "\uFFFD") return "[a-z0-9]";
      return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${escapedPattern}$`, "u").test(wantedNormalized);
}

function asPositiveId(value, label = "ID") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} invalido`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} invalido`);
  return parsed;
}

function assertZeroOrOne(rows, label) {
  if (!Array.isArray(rows)) throw new TypeError(`${label}: resultado invalido`);
  if (rows.length > 1) {
    throw new Error(`${label}: se encontraron ${rows.length} filas; se esperaba como maximo una`);
  }
  return rows[0] || null;
}

function pickUniqueByName(rows, wanted, label) {
  const matches = (rows || []).filter((row) => naturalNameMatches(row.nombre, wanted));
  if (matches.length !== 1) {
    throw new Error(`${label}: se esperaba una coincidencia para "${wanted}" y se encontraron ${matches.length}`);
  }
  return matches[0];
}

function validateApplyArguments(
  args,
  nodeEnv = process.env.NODE_ENV,
  sslMode = process.env.DB_SSL_MODE
) {
  const production = String(nodeEnv || "").trim().toLowerCase() === "production";
  if (production && String(sslMode || "").trim().toLowerCase() !== "verify-full") {
    throw new Error("En produccion DB_SSL_MODE debe ser verify-full");
  }
  const apply = Boolean(args.apply);
  if (!apply) return { apply: false };
  if (args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`Para aplicar use --confirm=${APPLY_CONFIRMATION}`);
  }
  const manifestSha256 = String(args["manifest-sha256"] || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error("--manifest-sha256 debe contener el SHA-256 exacto emitido por el dry-run");
  }
  if (production) {
    if (!args["allow-production"]) {
      throw new Error("En produccion tambien es obligatorio --allow-production");
    }
  }
  return { apply: true, manifestSha256 };
}

function fingerprint(kind, ids) {
  const canonical = Array.isArray(ids) ? ids.map(Number).sort((a, b) => a - b) : [Number(ids)];
  return crypto.createHash("sha256").update(`${MARKER}:${kind}:${canonical.join(",")}`).digest("hex").slice(0, 20);
}

function participantFingerprint(participant) {
  return crypto.createHash("sha256").update(stableJson({
    marker: MARKER,
    kind: "participant",
    user_id: Number(participant.userId),
    type_id: Number(participant.typeId),
    relationship_id: participant.relationshipId === null ? null : Number(participant.relationshipId),
    age_at_check_in: Number(participant.age),
  })).digest("hex").slice(0, 20);
}

function pricePolicyForType(typeName, baseCents, highSeason = false) {
  const name = normalizeName(typeName);
  let discountBasisPoints = 0;
  if (name.includes("menores de 2") || name.includes("bebe")) discountBasisPoints = 10_000;
  else if (name.includes("afiliad")) discountBasisPoints = highSeason ? 2_500 : 3_500;
  else if (name.includes("familiar")) discountBasisPoints = highSeason ? 1_000 : 2_000;
  const priceCents = aplicarDescuentoEnPuntosBase(baseCents, discountBasisPoints);
  if (priceCents === null) throw new Error(`No se pudo calcular la tarifa para ${typeName}`);
  return {
    priceCents,
    usesPercentage: discountBasisPoints > 0,
    discountPercent: discountBasisPoints / 100,
  };
}

function canonicalAdditionalPricing(participants, basePriceCents, nights) {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error("El adicional demo requiere al menos un participante");
  }
  if (!Array.isArray(nights) || nights.length === 0) {
    throw new Error("El adicional demo requiere al menos una noche");
  }

  let discountBasisPoints = 0;
  let sourceParticipantIndex = null;
  for (let index = 0; index < participants.length; index += 1) {
    const participant = participants[index];
    const usesPercentage = participant.usesPercentage === true ||
      participant.usesPercentage === 1 || participant.usesPercentage === "1";
    const basisPoints = decimalAPuntosBase(participant.discountPercent ?? 0);
    if (usesPercentage && basisPoints === null) {
      throw new Error("Una tarifa participante del adicional demo tiene un porcentaje invalido");
    }
    // Replica obtenerMejorDescuentoDia: el mayor porcentaje gana y un empate
    // conserva la primera persona del orden canonico de la reserva.
    if (usesPercentage && basisPoints > discountBasisPoints) {
      discountBasisPoints = basisPoints;
      sourceParticipantIndex = index;
    }
  }

  const unitPriceCents = aplicarDescuentoEnPuntosBase(basePriceCents, discountBasisPoints);
  if (unitPriceCents === null) throw new Error("El precio base del adicional demo es invalido");
  const details = nights.map((date) => ({
    date,
    quantity: 1,
    unitPriceCents,
    subtotalCents: unitPriceCents,
  }));
  const subtotalCents = details.reduce(
    (total, detail) => sumarCentavos(total, detail.subtotalCents),
    0
  );
  if (subtotalCents === null) throw new Error("El subtotal del adicional demo excede el rango monetario");

  const sourceParticipant = sourceParticipantIndex === null
    ? null
    : participants[sourceParticipantIndex];
  return {
    basePriceCents,
    unitPriceCents,
    subtotalCents,
    discountBasisPoints,
    discountPercent: discountBasisPoints / 100,
    sourceParticipantIndex,
    sourceTypeId: sourceParticipant ? sourceParticipant.typeId : null,
    sourceTariffId: sourceParticipant?.tariffId ?? null,
    details,
  };
}

function resolveAdditionalSourceTariffId(low) {
  const sourceIndex = low.additional.sourceParticipantIndex;
  if (sourceIndex === null) return null;
  const participant = low.participants[sourceIndex];
  if (!participant) throw new Error("No existe el participante fuente del descuento del adicional");
  return asPositiveId(participant.tariffId, "tarifa fuente del descuento del adicional");
}

function buildTariffSpecs(types, resourceIds, regimenId, start, end, baseCents, highSeason = false) {
  return resourceIds.flatMap((resourceId) => types.map((type) => ({
    resourceId: asPositiveId(resourceId, "recurso"),
    typeId: asPositiveId(type.id, "tipo de persona"),
    regimenId: asPositiveId(regimenId, "regimen"),
    start,
    end,
    ...pricePolicyForType(type.nombre, baseCents, highSeason),
  })));
}

function buildDefaultSchedule(today, lowStart = null) {
  const startLow = lowStart || sumarDiasFechaCivil(today, 14);
  const endLow = sumarDiasFechaCivil(startLow, LOW_NIGHTS);
  const blockStart = sumarDiasFechaCivil(endLow, 30);
  return {
    today,
    lowStart: startLow,
    lowEnd: endLow,
    raffleEnrollmentStart: sumarDiasFechaCivil(today, -1),
    raffleEnrollmentEnd: sumarDiasFechaCivil(today, 7),
    blockStart,
    blockEnd: sumarDiasFechaCivil(blockStart, HIGH_BLOCK_DAYS),
    olympicsEnrollmentStart: sumarDiasFechaCivil(today, -1),
    olympicsEnrollmentEnd: sumarDiasFechaCivil(today, 21),
    olympicsStart: sumarDiasFechaCivil(today, 45),
    olympicsEnd: sumarDiasFechaCivil(today, 48),
  };
}

function money(cents) {
  const value = centavosADecimal(cents);
  if (value === null) throw new Error("Importe fuera de rango");
  return value;
}

function publicManifest(plan) {
  return {
    dataset: MARKER,
    anchor_date: plan.today,
    migration: {
      id: MIGRATION_ID,
      revision: MIGRATION_REVISION,
      checksum: MIGRATION_CHECKSUM,
    },
    actor_ref: fingerprint("actor", plan.catalog.actor.id),
    participants: {
      titular_ref: fingerprint("titular", plan.low.participants[0].userId),
      group_ref: fingerprint("grupo", plan.low.participants.map((participant) => participant.userId)),
      member_refs: plan.low.participants.map(participantFingerprint).sort(),
      count: plan.low.participants.length,
      type_ids: [...new Set(plan.low.participants.map((participant) => participant.typeId))].sort((a, b) => a - b),
    },
    low_season: {
      action: plan.low.seasonAction,
      name: plan.low.seasonName,
      start: plan.low.start,
      end: plan.low.end,
      resource_count: 1,
      tariff_rows: plan.low.newTariffSpecs.length,
      additional_rows: plan.low.seasonAction === "CREATE" ? 1 : 0,
    },
    reservation: {
      action: plan.low.reservationAction,
      modality: "FECHA_LIBRE",
      start: plan.low.start,
      end: plan.low.end,
      nights: plan.low.nights.length,
      participant_count: plan.low.participants.length,
      snapshot_rows: plan.low.participants.length * plan.low.nights.length,
      family_subtotal: money(plan.low.familySubtotalCents),
      additional_subtotal: money(plan.low.additionalSubtotalCents),
      total: money(plan.low.totalCents),
      additional: {
        name: plan.catalog.additional.name,
        quantity: 1,
        detail_rows: plan.low.additional.details.length,
        base_unit_price: money(plan.low.additional.basePriceCents),
        discount_percent: plan.low.additional.discountPercent,
        discounted_unit_price: money(plan.low.additional.unitPriceCents),
        discount_source_ref: plan.low.additional.sourceParticipantIndex === null
          ? null
          : participantFingerprint(plan.low.participants[plan.low.additional.sourceParticipantIndex]),
      },
    },
    high_season: {
      action: plan.high.action,
      start: plan.high.start,
      end: plan.high.end,
      resource_count: plan.high.resourceIds.length,
      tariff_rows: plan.high.tariffSpecs.length,
      includes_free_minor_rate: plan.high.tariffSpecs.some((spec) => spec.priceCents === 0 && spec.discountPercent === 100),
    },
    raffle: {
      action: plan.high.action,
      enrollment_start: plan.high.enrollmentStart,
      enrollment_end: plan.high.enrollmentEnd,
      state: "ACTIVO",
      block_state: "ACTIVO",
      resource_state: "SORTEO",
    },
    olympics: {
      action: plan.olympics.action,
      enrollment_start: plan.olympics.enrollmentStart,
      enrollment_end: plan.olympics.enrollmentEnd,
      start: plan.olympics.start,
      end: plan.olympics.end,
      disciplines: plan.olympics.disciplineIds.length,
      registrations: 0,
    },
    coseguro: {
      action: "OMIT",
      reason: "Los comprobantes demo requieren archivos S3 y deben probarse por la API",
    },
  };
}

function manifestHash(plan) {
  return sha256(stableJson(publicManifest(plan)));
}

function lockClause(forUpdate) {
  return forUpdate ? " FOR UPDATE" : "";
}

async function getToday(connection) {
  const [[row]] = await connection.query("SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today");
  if (!row?.today) throw new Error("No se pudo obtener la fecha civil de la base");
  return row.today;
}

async function assertMigrationApplied(connection) {
  const [rows] = await connection.query(
    `SELECT estado, revision, checksum
       FROM ajb_schema_migration
      WHERE migration_id = ?`,
    [MIGRATION_ID]
  );
  const registry = assertZeroOrOne(rows, "registro de migracion de integridad");
  if (
    !registry || registry.estado !== "APLICADA" ||
    Number(registry.revision) !== MIGRATION_REVISION || registry.checksum !== MIGRATION_CHECKSUM
  ) {
    throw new Error("La migracion exacta de integridad financiera no esta aplicada");
  }
  const preflight = await runDataPreflight(connection);
  if (!preflight.ok) {
    const codes = preflight.fatal.map((finding) => finding.code).join(", ") || "sin codigo";
    throw new Error(`El preflight de integridad esta bloqueado (${codes})`);
  }
}

async function loadCatalog(connection, forUpdate) {
  const suffix = lockClause(forUpdate);
  const [services] = await connection.query(`SELECT id, nombre FROM servicio ORDER BY id${suffix}`);
  const service = pickUniqueByName(services, "Cabañas", "servicio de demostracion");
  const [resources] = await connection.query(
    `SELECT id, nombre FROM recurso WHERE servicio_id = ? ORDER BY id${suffix}`,
    [service.id]
  );
  if (resources.length === 0) throw new Error("Cabañas no tiene recursos configurados");

  const [regimens] = await connection.query(
    `SELECT r.id, r.nombre
       FROM servicio_regimen sr
       INNER JOIN regimen r ON r.id = sr.regimen_id
      WHERE sr.servicio_id = ?
      ORDER BY r.id${suffix}`,
    [service.id]
  );
  const regimen = pickUniqueByName(regimens, "Único", "regimen de Cabañas");
  const [types] = await connection.query(`SELECT id, nombre FROM tipo_persona ORDER BY id${suffix}`);
  if (types.length === 0) throw new Error("No hay tipos de persona configurados");
  const minorTypes = types.filter((type) => {
    const name = normalizeName(type.nombre);
    return name.includes("menores de 2") || name.includes("bebe");
  });
  if (minorTypes.length !== 1) throw new Error("Debe existir exactamente un tipo de persona para menores de 2 años");

  const [additionals] = await connection.query(`SELECT id, nombre FROM adicional ORDER BY id${suffix}`);
  const additional = pickUniqueByName(additionals, "Mascota", "adicional de demostracion");
  const [reservationStates] = await connection.query(`SELECT id, nombre FROM estado_reserva ORDER BY id${suffix}`);
  const initialState = pickUniqueByName(reservationStates, "Iniciada", "estado inicial de reserva");

  const [actors] = await connection.query(
    `SELECT u.id
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
      WHERE LOWER(TRIM(r.nombre)) = 'admin' AND u.habilitado = 'Y'
      ORDER BY u.id
      LIMIT 1${suffix}`
  );
  if (actors.length !== 1) throw new Error("No hay un administrador habilitado para auditar el seed");

  return {
    service: { id: asPositiveId(service.id), name: service.nombre },
    resources: resources.map((resource) => ({ id: asPositiveId(resource.id), name: resource.nombre })),
    regimen: { id: asPositiveId(regimen.id), name: regimen.nombre },
    types: types.map((type) => ({ id: asPositiveId(type.id), nombre: type.nombre })),
    minorTypeId: asPositiveId(minorTypes[0].id),
    additional: { id: asPositiveId(additional.id), name: additional.nombre },
    initialState: { id: asPositiveId(initialState.id), name: initialState.nombre },
    actor: { id: asPositiveId(actors[0].id) },
  };
}

async function loadEligibleParticipants(connection, checkIn, forUpdate, minorTypeId) {
  const suffix = lockClause(forUpdate);
  const [titulars] = await connection.query(
    `SELECT u.id, u.tipo_persona_id, u.fecha_nacimiento, u.parentesco_id
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
       INNER JOIN departamental d ON d.id = u.departamental_id AND d.habilitado = 'Y'
      WHERE LOWER(TRIM(r.nombre)) = 'afiliado'
        AND u.habilitado = 'Y'
        AND u.usuario_familiar_id IS NULL
        AND u.tipo_persona_id IS NOT NULL
        AND u.fecha_nacimiento IS NOT NULL
      ORDER BY u.id
      LIMIT 20${suffix}`
  );
  if (titulars.length === 0) throw new Error("No hay un titular afiliado elegible para la demostracion");

  for (const titular of titulars) {
    const [members] = await connection.query(
      `SELECT id, tipo_persona_id, fecha_nacimiento, parentesco_id
         FROM usuario
        WHERE usuario_familiar_id = ?
          AND habilitado = 'Y'
          AND tipo_persona_id IS NOT NULL
          AND fecha_nacimiento IS NOT NULL
        ORDER BY CASE WHEN es_familiar = 'S' THEN 0 ELSE 1 END, id
        LIMIT 2${suffix}`,
      [titular.id]
    );
    const selected = [titular, ...members].map((row) => {
      const age = calcularEdadEnFecha(row.fecha_nacimiento, checkIn);
      if (!Number.isInteger(age) || age < 0 || age > 130) return null;
      const typeId = asPositiveId(row.tipo_persona_id, "tipo de participante");
      if ((typeId === minorTypeId) !== (age < 2)) return null;
      return {
        userId: asPositiveId(row.id, "usuario participante"),
        typeId,
        relationshipId: row.parentesco_id === null ? null : asPositiveId(row.parentesco_id, "parentesco"),
        age,
      };
    });
    if (selected.every(Boolean)) return selected;
  }
  throw new Error("Ningun grupo afiliado elegible tiene fechas de nacimiento validas");
}

async function markerRow(connection, sql, params, label) {
  const [rows] = await connection.query(sql, params);
  return assertZeroOrOne(rows, label);
}

async function rangeIsFree(connection, resourceIds, start, end) {
  const [tariffs] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM tarifa
      WHERE recurso_id IN (?) AND fecha_inicio <= ? AND fecha_fin >= ?`,
    [resourceIds, end, start]
  );
  const [blocks] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM bloque_fecha_recurso bfr
       INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
      WHERE bfr.recurso_id IN (?)
        AND bf.estado = 'ACTIVO'
        AND bfr.estado IN ('DISPONIBLE','SORTEO','VENTA_DIRECTA','RESERVADO','ASIGNADO')
        AND bf.fecha_inicio < ? AND bf.fecha_fin > ?`,
    [resourceIds, end, start]
  );
  const [reservations] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM reserva
      WHERE recurso_id IN (?) AND fecha_inicio < ? AND fecha_fin > ?`,
    [resourceIds, end, start]
  );
  return Number(tariffs[0].total) === 0 && Number(blocks[0].total) === 0 && Number(reservations[0].total) === 0;
}

async function reservationWindowIsFree(connection, resourceId, start, end) {
  const [blocks] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM bloque_fecha_recurso bfr
       INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
      WHERE bfr.recurso_id = ? AND bf.estado = 'ACTIVO'
        AND bfr.estado IN ('DISPONIBLE','SORTEO','VENTA_DIRECTA','RESERVADO','ASIGNADO')
        AND bf.fecha_inicio < ? AND bf.fecha_fin > ?`,
    [resourceId, end, start]
  );
  const [reservations] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM reserva
      WHERE recurso_id = ? AND fecha_inicio < ? AND fecha_fin > ?`,
    [resourceId, end, start]
  );
  return Number(blocks[0].total) === 0 && Number(reservations[0].total) === 0;
}

async function findFreshWindow(connection, resourceIds, today, { offset = 14, length = 2 } = {}) {
  for (let day = offset; day <= MAX_SEARCH_DAYS; day += 1) {
    const start = sumarDiasFechaCivil(today, day);
    const end = sumarDiasFechaCivil(start, length);
    if (await rangeIsFree(connection, resourceIds, start, end)) return { start, end };
  }
  throw new Error(`No se encontro una ventana libre de ${length} dias durante los proximos ${MAX_SEARCH_DAYS} dias`);
}

async function exactRatesForParticipants(connection, {
  seasonId,
  resourceId,
  regimenId,
  participants,
  start,
  end,
}) {
  const rates = [];
  for (const participant of participants) {
    const [rows] = await connection.query(
      `SELECT id, precio, usa_porcentaje, porcentaje_descuento
         FROM tarifa
        WHERE temporada_tarifa_id = ? AND recurso_id = ? AND regimen_id = ?
          AND tipo_persona_id = ?
          AND (edad_minima IS NULL OR edad_minima <= ?)
          AND (edad_maxima IS NULL OR edad_maxima >= ?)
          AND fecha_inicio <= ? AND fecha_fin >= ?
        ORDER BY id`,
      [seasonId, resourceId, regimenId, participant.typeId, participant.age, participant.age, start, end]
    );
    if (rows.length !== 1) return null;
    const priceCents = decimalACentavos(rows[0].precio);
    if (priceCents === null) return null;
    rates.push({
      ...participant,
      tariffId: asPositiveId(rows[0].id, "tarifa"),
      priceCents,
      usesPercentage: Number(rows[0].usa_porcentaje) === 1,
      discountPercent: rows[0].porcentaje_descuento === null ? null : Number(rows[0].porcentaje_descuento),
    });
  }
  return rates;
}

async function exactAdditionalRate(connection, { seasonId, resourceId, regimenId, additionalId, start, end }) {
  const [rows] = await connection.query(
    `SELECT id, precio
       FROM tarifa_adicional
      WHERE temporada_tarifa_id = ? AND recurso_id = ? AND regimen_id = ?
        AND adicional_id = ? AND activo = 1
        AND fecha_inicio <= ? AND fecha_fin >= ?
      ORDER BY id`,
    [seasonId, resourceId, regimenId, additionalId, start, end]
  );
  if (rows.length !== 1) return null;
  const priceCents = decimalACentavos(rows[0].precio);
  return priceCents === null ? null : { id: asPositiveId(rows[0].id), priceCents };
}

async function tryReusableSeason(connection, season, context) {
  if (!season || season.origen !== "GENERAL") return null;
  const earliest = season.fecha_inicio > sumarDiasFechaCivil(context.today, 7)
    ? season.fecha_inicio
    : sumarDiasFechaCivil(context.today, 7);
  for (let start = earliest; start <= season.fecha_fin; start = sumarDiasFechaCivil(start, 1)) {
    const end = sumarDiasFechaCivil(start, LOW_NIGHTS);
    if (end > season.fecha_fin) break;
    const [matrixRows] = await connection.query(
      `SELECT tipo_persona_id, COUNT(*) AS total
         FROM tarifa
        WHERE temporada_tarifa_id = ? AND recurso_id = ? AND regimen_id = ?
          AND edad_minima IS NULL AND edad_maxima IS NULL
          AND fecha_inicio <= ? AND fecha_fin >= ?
        GROUP BY tipo_persona_id
        ORDER BY tipo_persona_id`,
      [season.id, context.resourceId, context.regimenId, start, end]
    );
    const matrix = new Map(matrixRows.map((row) => [Number(row.tipo_persona_id), Number(row.total)]));
    if (
      matrix.size !== context.types.length ||
      context.types.some((type) => matrix.get(type.id) !== 1)
    ) continue;
    const participants = await loadEligibleParticipants(
      connection,
      start,
      context.forUpdate,
      context.minorTypeId
    );
    if (!(await reservationWindowIsFree(connection, context.resourceId, start, end))) continue;
    const rates = await exactRatesForParticipants(connection, {
      seasonId: season.id,
      resourceId: context.resourceId,
      regimenId: context.regimenId,
      participants,
      start,
      end,
    });
    if (!rates) continue;
    const additional = await exactAdditionalRate(connection, {
      seasonId: season.id,
      resourceId: context.resourceId,
      regimenId: context.regimenId,
      additionalId: context.additionalId,
      start,
      end,
    });
    if (!additional) continue;
    return { start, end, participants: rates, additional };
  }
  return null;
}

function composeLowPlan({ catalog, seasonAction, seasonName, seasonId = null, start, end, participants, additional, newTariffSpecs = [] }) {
  const nights = obtenerNochesReserva(start, end, 366);
  if (nights.length !== LOW_NIGHTS) throw new Error("La reserva demo debe tener exactamente dos noches");
  const familySubtotalCents = participants.reduce((total, participant) => {
    const participantTotal = participant.priceCents * nights.length;
    return sumarCentavos(total, participantTotal);
  }, 0);
  const additionalPricing = canonicalAdditionalPricing(participants, additional.priceCents, nights);
  const additionalSubtotalCents = additionalPricing.subtotalCents;
  const totalCents = sumarCentavos(familySubtotalCents, additionalSubtotalCents);
  if ([familySubtotalCents, additionalSubtotalCents, totalCents].some((value) => value === null)) {
    throw new Error("El total de la reserva demo excede el rango monetario");
  }
  return {
    seasonAction,
    seasonName,
    seasonId,
    reservationAction: "CREATE",
    reservationId: null,
    resourceId: catalog.resources[0].id,
    regimenId: catalog.regimen.id,
    start,
    end,
    nights,
    participants,
    additional: { ...additional, ...additionalPricing },
    newTariffSpecs,
    familySubtotalCents,
    additionalSubtotalCents,
    totalCents,
  };
}

function assertStoredAdditionalContract(rows, low, additionalId) {
  if (!Array.isArray(rows) || rows.length !== low.nights.length) {
    throw new Error("El adicional demo no tiene exactamente un detalle por noche");
  }
  const parentIds = new Set(rows.map((row) => Number(row.reservation_additional_id)));
  if (parentIds.size !== 1 || !Number.isSafeInteger([...parentIds][0]) || [...parentIds][0] <= 0) {
    throw new Error("El adicional demo no tiene una unica cabecera valida");
  }
  const expectedSourceTariffId = resolveAdditionalSourceTariffId(low);
  const expectedAdditionalTariffId = asPositiveId(low.additional.id, "tarifa base del adicional");

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = low.additional.details[index];
    const actualSourceTariffId = row.tarifa_id === null
      ? null
      : asPositiveId(row.tarifa_id, "tarifa fuente almacenada del adicional");
    if (
      row.fecha !== expected.date ||
      Number(row.adicional_id) !== additionalId ||
      Number(row.additional_quantity) !== 1 ||
      Number(row.additional_days) !== low.nights.length ||
      decimalACentavos(row.additional_subtotal) !== low.additionalSubtotalCents ||
      Number(row.detail_quantity) !== expected.quantity ||
      decimalACentavos(row.precio_unitario) !== expected.unitPriceCents ||
      decimalACentavos(row.detail_subtotal) !== expected.subtotalCents ||
      Number(row.tarifa_adicional_id) !== expectedAdditionalTariffId ||
      decimalAPuntosBase(row.porcentaje_descuento) !== low.additional.discountBasisPoints ||
      actualSourceTariffId !== expectedSourceTariffId ||
      decimalACentavos(row.base_price) !== low.additional.basePriceCents ||
      Number(row.additional_season_id) !== Number(low.seasonId) ||
      Number(row.additional_resource_id) !== low.resourceId ||
      Number(row.additional_regimen_id) !== low.regimenId ||
      Number(row.tariff_additional_id) !== additionalId ||
      Number(row.additional_active) !== 1 ||
      row.tariff_start > expected.date || row.tariff_end < expected.date
    ) {
      throw new Error("El detalle del adicional demo no coincide con el contrato canonico de cotizacion");
    }
  }
}

async function planNewLowDataset(connection, catalog, today, forUpdate) {
  const suffix = lockClause(forUpdate);
  const [legacyRows] = await connection.query(
    `SELECT id, nombre, DATE_FORMAT(fecha_inicio, '%Y-%m-%d') fecha_inicio,
            DATE_FORMAT(fecha_fin, '%Y-%m-%d') fecha_fin, origen
       FROM temporada_tarifa WHERE nombre = ? ORDER BY id${suffix}`,
    [LEGACY_SEASON_NAME]
  );
  const legacy = assertZeroOrOne(legacyRows, LEGACY_SEASON_NAME);
  const reusable = await tryReusableSeason(connection, legacy, {
    today,
    forUpdate,
    resourceId: catalog.resources[0].id,
    regimenId: catalog.regimen.id,
    additionalId: catalog.additional.id,
    types: catalog.types,
    minorTypeId: catalog.minorTypeId,
  });
  if (reusable) {
    return composeLowPlan({
      catalog,
      seasonAction: "REUSE",
      seasonName: LEGACY_SEASON_NAME,
      seasonId: asPositiveId(legacy.id),
      ...reusable,
      newTariffSpecs: [],
    });
  }

  const [fallbackRows] = await connection.query(
    `SELECT id, nombre, DATE_FORMAT(fecha_inicio, '%Y-%m-%d') fecha_inicio,
            DATE_FORMAT(fecha_fin, '%Y-%m-%d') fecha_fin, origen
       FROM temporada_tarifa WHERE nombre = ? ORDER BY id${suffix}`,
    [FALLBACK_LOW_SEASON_NAME]
  );
  const fallback = assertZeroOrOne(fallbackRows, FALLBACK_LOW_SEASON_NAME);
  const fallbackReusable = await tryReusableSeason(connection, fallback, {
    today,
    forUpdate,
    resourceId: catalog.resources[0].id,
    regimenId: catalog.regimen.id,
    additionalId: catalog.additional.id,
    types: catalog.types,
    minorTypeId: catalog.minorTypeId,
  });
  if (fallbackReusable) {
    return composeLowPlan({
      catalog,
      seasonAction: "REUSE",
      seasonName: FALLBACK_LOW_SEASON_NAME,
      seasonId: asPositiveId(fallback.id),
      ...fallbackReusable,
      newTariffSpecs: [],
    });
  }
  if (fallback) {
    throw new Error("La temporada baja demo existe pero ya no tiene una matriz futura valida");
  }

  const window = await findFreshWindow(connection, [catalog.resources[0].id], today, { offset: 14, length: LOW_NIGHTS });
  const participants = await loadEligibleParticipants(connection, window.start, forUpdate, catalog.minorTypeId);
  const specs = buildTariffSpecs(
    catalog.types,
    [catalog.resources[0].id],
    catalog.regimen.id,
    window.start,
    window.end,
    LOW_BASE_CENTS,
    false
  );
  const specByType = new Map(specs.map((spec) => [spec.typeId, spec]));
  const ratedParticipants = participants.map((participant) => {
    const spec = specByType.get(participant.typeId);
    if (!spec) throw new Error("Falta una tarifa demo para un tipo de participante");
    return { ...participant, tariffId: null, ...spec };
  });
  return composeLowPlan({
    catalog,
    seasonAction: "CREATE",
    // La temporada historica solo se reutiliza; todo dato nuevo lleva el
    // marcador inequivoco del dataset para poder auditarlo o retirarlo.
    seasonName: FALLBACK_LOW_SEASON_NAME,
    start: window.start,
    end: window.end,
    participants: ratedParticipants,
    additional: { id: null, priceCents: ADDITIONAL_CENTS },
    newTariffSpecs: specs,
  });
}

async function loadExistingReservationPlan(connection, catalog, row, today, forUpdate) {
  const suffix = lockClause(forUpdate);
  const [headers] = await connection.query(
    `SELECT id, modalidad, estado_reserva_id, recurso_id, regimen_id, usuario_id,
            DATE_FORMAT(fecha_inicio, '%Y-%m-%d') fecha_inicio,
            DATE_FORMAT(fecha_fin, '%Y-%m-%d') fecha_fin,
            precio_total, monto_adicionales, observaciones
       FROM reserva WHERE id = ?${suffix}`,
    [row.id]
  );
  const header = headers[0];
  if (!header || header.modalidad !== "FECHA_LIBRE" || header.observaciones !== RESERVATION_NOTE) {
    throw new Error("La reserva demo existente no conserva su contrato raiz");
  }
  const reservationNights = obtenerNochesReserva(header.fecha_inicio, header.fecha_fin, 366);
  if (header.fecha_inicio <= today || reservationNights.length !== LOW_NIGHTS) {
    throw new Error("La reserva demo existente ya no representa una ventana futura de dos noches");
  }
  if (
    Number(header.recurso_id) !== catalog.resources[0].id ||
    Number(header.regimen_id) !== catalog.regimen.id ||
    Number(header.estado_reserva_id) !== catalog.initialState.id
  ) {
    throw new Error("La reserva demo existente fue modificada; no se recreara automaticamente");
  }

  const [familyRows] = await connection.query(
    `SELECT rf.id, rf.usuario_id, rf.tipo_persona_id, rf.parentesco_id, rf.edad, rf.precio
       FROM reserva_familiar rf WHERE rf.reserva_id = ? ORDER BY rf.id${suffix}`,
    [header.id]
  );
  if (familyRows.length === 0 || familyRows.length > 3) throw new Error("Participantes demo inconsistentes");
  if (Number(familyRows[0].usuario_id) !== Number(header.usuario_id)) {
    throw new Error("El titular almacenado no coincide con el primer participante de la reserva demo");
  }
  const participantIds = familyRows.map((family) => asPositiveId(family.usuario_id));
  const [authorizedRows] = await connection.query(
    `SELECT id, tipo_persona_id, fecha_nacimiento
       FROM usuario
      WHERE id IN (?) AND habilitado = 'Y'
        AND (id = ? OR usuario_familiar_id = ?)
      ORDER BY id${suffix}`,
    [participantIds, header.usuario_id, header.usuario_id]
  );
  const authorizedById = new Map(authorizedRows.map((user) => [Number(user.id), user]));
  if (authorizedById.size !== familyRows.length) {
    throw new Error("La reserva demo existente contiene participantes fuera del grupo autorizado");
  }
  const participants = [];
  let seasonId = null;
  for (const family of familyRows) {
    const authorized = authorizedById.get(Number(family.usuario_id));
    const currentAge = calcularEdadEnFecha(authorized.fecha_nacimiento, header.fecha_inicio);
    if (
      Number(authorized.tipo_persona_id) !== Number(family.tipo_persona_id) ||
      currentAge !== Number(family.edad) ||
      ((Number(family.tipo_persona_id) === catalog.minorTypeId) !== (currentAge < 2))
    ) {
      throw new Error("El tipo o la edad de un participante demo ya no coincide con su perfil");
    }
    const [daily] = await connection.query(
      `SELECT rft.tarifa_id, rft.precio_aplicado, rft.snapshot_estado,
              t.temporada_tarifa_id, t.usa_porcentaje, t.porcentaje_descuento,
              DATE_FORMAT(rft.fecha, '%Y-%m-%d') fecha
         FROM reserva_familiar_tarifa rft
         LEFT JOIN tarifa t ON t.id = rft.tarifa_id
        WHERE rft.reserva_familiar_id = ? ORDER BY rft.fecha${suffix}`,
      [family.id]
    );
    if (
      daily.length !== LOW_NIGHTS ||
      daily.some((item, index) => item.snapshot_estado !== "COMPLETO" || !item.tarifa_id ||
        !item.temporada_tarifa_id || item.fecha !== reservationNights[index])
    ) {
      throw new Error("La reserva demo existente no tiene snapshots diarios completos");
    }
    const distinctSeasons = new Set(daily.map((item) => Number(item.temporada_tarifa_id)));
    if (distinctSeasons.size !== 1) throw new Error("La reserva demo usa mas de una temporada");
    const participantSeasonId = [...distinctSeasons][0];
    if (seasonId !== null && seasonId !== participantSeasonId) throw new Error("La reserva demo mezcla temporadas");
    seasonId = participantSeasonId;
    const dailyPriceCents = decimalACentavos(daily[0].precio_aplicado);
    const dailyTariffId = asPositiveId(daily[0].tarifa_id);
    const dailyUsesPercentage = Number(daily[0].usa_porcentaje) === 1;
    const dailyDiscountBasisPoints = decimalAPuntosBase(daily[0].porcentaje_descuento ?? 0);
    if (
      dailyPriceCents === null ||
      (dailyUsesPercentage && dailyDiscountBasisPoints === null) ||
      daily.some((item) => decimalACentavos(item.precio_aplicado) !== dailyPriceCents ||
        Number(item.tarifa_id) !== dailyTariffId ||
        (Number(item.usa_porcentaje) === 1) !== dailyUsesPercentage ||
        decimalAPuntosBase(item.porcentaje_descuento ?? 0) !== dailyDiscountBasisPoints)
    ) {
      throw new Error("La reserva demo tiene precios diarios inconsistentes");
    }
    participants.push({
      userId: asPositiveId(family.usuario_id),
      typeId: asPositiveId(family.tipo_persona_id),
      relationshipId: family.parentesco_id === null ? null : asPositiveId(family.parentesco_id),
      age: Number(family.edad),
      tariffId: dailyTariffId,
      priceCents: dailyPriceCents,
      usesPercentage: Number(daily[0].usa_porcentaje) === 1,
      discountPercent: daily[0].porcentaje_descuento === null ? null : Number(daily[0].porcentaje_descuento),
    });
  }

  const [additionalRows] = await connection.query(
    `SELECT ra.id reservation_additional_id, ra.adicional_id,
            ra.cantidad additional_quantity, ra.dias additional_days, ra.subtotal additional_subtotal,
            rad.tarifa_adicional_id, rad.cantidad detail_quantity, rad.precio_unitario,
            rad.subtotal detail_subtotal, rad.porcentaje_descuento, rad.tarifa_id,
            DATE_FORMAT(rad.fecha, '%Y-%m-%d') fecha,
            ta.precio base_price, ta.temporada_tarifa_id additional_season_id,
            ta.recurso_id additional_resource_id, ta.regimen_id additional_regimen_id,
            ta.adicional_id tariff_additional_id, ta.activo additional_active,
            DATE_FORMAT(ta.fecha_inicio, '%Y-%m-%d') tariff_start,
            DATE_FORMAT(ta.fecha_fin, '%Y-%m-%d') tariff_end
       FROM reserva_adicional ra
       INNER JOIN reserva_adicional_detalle rad ON rad.reserva_adicional_id = ra.id
       INNER JOIN tarifa_adicional ta ON ta.id = rad.tarifa_adicional_id
      WHERE ra.reserva_id = ? ORDER BY rad.fecha${suffix}`,
    [header.id]
  );
  if (
    additionalRows.length !== LOW_NIGHTS ||
    new Set(additionalRows.map((item) => Number(item.tarifa_adicional_id))).size !== 1
  ) {
    throw new Error("El adicional de la reserva demo existente es inconsistente");
  }
  const additionalBasePriceCents = decimalACentavos(additionalRows[0].base_price);
  if (additionalBasePriceCents === null) {
    throw new Error("La tarifa base del adicional demo no conserva un precio exacto");
  }
  const [seasonRows] = await connection.query(
    `SELECT id, nombre, origen FROM temporada_tarifa WHERE id = ?${suffix}`,
    [seasonId]
  );
  const season = seasonRows[0];
  if (!season || season.origen !== "GENERAL") throw new Error("La temporada de la reserva demo no es GENERAL");
  const plan = composeLowPlan({
    catalog,
    seasonAction: "REUSE",
    seasonName: season.nombre,
    seasonId,
    start: header.fecha_inicio,
    end: header.fecha_fin,
    participants,
    additional: { id: asPositiveId(additionalRows[0].tarifa_adicional_id), priceCents: additionalBasePriceCents },
    newTariffSpecs: [],
  });
  plan.reservationAction = "REUSE";
  plan.reservationId = asPositiveId(header.id);
  assertStoredAdditionalContract(additionalRows, plan, catalog.additional.id);
  if (
    decimalACentavos(header.precio_total) !== plan.totalCents ||
    decimalACentavos(header.monto_adicionales) !== plan.additionalSubtotalCents
  ) {
    throw new Error("El total almacenado de la reserva demo no coincide con sus componentes");
  }
  return plan;
}

async function planLowDataset(connection, catalog, today, forUpdate) {
  const suffix = lockClause(forUpdate);
  const [rows] = await connection.query(
    `SELECT id FROM reserva WHERE observaciones = ? ORDER BY id${suffix}`,
    [RESERVATION_NOTE]
  );
  const existing = assertZeroOrOne(rows, "reserva demo integral");
  return existing
    ? loadExistingReservationPlan(connection, catalog, existing, today, forUpdate)
    : planNewLowDataset(connection, catalog, today, forUpdate);
}

async function validateExistingHigh(connection, catalog, roots, today, forUpdate) {
  const suffix = lockClause(forUpdate);
  const [rows] = await connection.query(
    `SELECT bf.id, bf.sorteo_id, bf.temporada_tarifa_id, bf.servicio_id, bf.nombre,
            bf.modalidad, bf.estado, DATE_FORMAT(bf.fecha_inicio, '%Y-%m-%d') fecha_inicio,
            DATE_FORMAT(bf.fecha_fin, '%Y-%m-%d') fecha_fin,
            s.estado sorteo_estado,
            DATE_FORMAT(s.fecha_inicio_inscripcion, '%Y-%m-%d') inscripcion_inicio,
            DATE_FORMAT(s.fecha_fin_inscripcion, '%Y-%m-%d') inscripcion_fin
       FROM bloque_fecha bf INNER JOIN sorteo s ON s.id = bf.sorteo_id
      WHERE bf.id = ?${suffix}`,
    [roots.block.id]
  );
  const block = rows[0];
  if (
    roots.season.origen !== "BLOQUE" ||
    !block || Number(block.sorteo_id) !== Number(roots.raffle.id) ||
    Number(block.temporada_tarifa_id) !== Number(roots.season.id) ||
    Number(block.servicio_id) !== catalog.service.id || block.modalidad !== "SORTEO" ||
    block.estado !== "ACTIVO" || block.sorteo_estado !== "ACTIVO" ||
    block.inscripcion_inicio > today || block.inscripcion_fin < today || block.fecha_inicio <= block.inscripcion_fin
  ) {
    throw new Error("El sorteo demo existente no conserva una ventana activa coherente");
  }
  const [resourceRows] = await connection.query(
    `SELECT recurso_id, estado, reserva_id FROM bloque_fecha_recurso
      WHERE bloque_fecha_id = ? ORDER BY recurso_id${suffix}`,
    [block.id]
  );
  if (
    resourceRows.length === 0 || resourceRows.length > 2 ||
    resourceRows.some((item) => item.estado !== "SORTEO" || item.reserva_id !== null)
  ) {
    throw new Error("Los recursos del sorteo demo fueron modificados");
  }
  const resourceIds = resourceRows.map((item) => asPositiveId(item.recurso_id));
  if (resourceIds.some((id) => !catalog.resources.some((resource) => resource.id === id))) {
    throw new Error("El sorteo demo contiene recursos ajenos a Cabañas");
  }
  const [tariffRows] = await connection.query(
    `SELECT recurso_id, tipo_persona_id, precio, usa_porcentaje, porcentaje_descuento,
            DATE_FORMAT(fecha_inicio, '%Y-%m-%d') fecha_inicio,
            DATE_FORMAT(fecha_fin, '%Y-%m-%d') fecha_fin
       FROM tarifa WHERE temporada_tarifa_id = ? AND regimen_id = ? ORDER BY recurso_id, tipo_persona_id${suffix}`,
    [roots.season.id, catalog.regimen.id]
  );
  if (tariffRows.length !== resourceIds.length * catalog.types.length) {
    throw new Error("La matriz de tarifas del sorteo demo no esta completa");
  }
  const tariffSpecs = tariffRows.map((row) => ({
    resourceId: asPositiveId(row.recurso_id),
    typeId: asPositiveId(row.tipo_persona_id),
    regimenId: catalog.regimen.id,
    start: row.fecha_inicio,
    end: row.fecha_fin,
    priceCents: decimalACentavos(row.precio),
    usesPercentage: Number(row.usa_porcentaje) === 1,
    discountPercent: Number(row.porcentaje_descuento || 0),
  }));
  const matrixKeys = new Set(tariffSpecs.map((spec) => `${spec.resourceId}:${spec.typeId}`));
  const expectedKeys = new Set(resourceIds.flatMap((resourceId) =>
    catalog.types.map((type) => `${resourceId}:${type.id}`)
  ));
  const minorRows = tariffSpecs.filter((spec) => spec.typeId === catalog.minorTypeId);
  if (
    matrixKeys.size !== tariffSpecs.length ||
    matrixKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !matrixKeys.has(key)) ||
    tariffSpecs.some((spec) => spec.priceCents === null || spec.start !== block.fecha_inicio || spec.end !== block.fecha_fin) ||
    minorRows.length !== resourceIds.length ||
    minorRows.some((spec) => spec.priceCents !== 0 || spec.discountPercent !== 100 || !spec.usesPercentage)
  ) {
    throw new Error("La matriz del sorteo demo no conserva sus importes y rangos");
  }
  return {
    action: "REUSE",
    seasonId: asPositiveId(roots.season.id),
    raffleId: asPositiveId(roots.raffle.id),
    blockId: asPositiveId(roots.block.id),
    start: block.fecha_inicio,
    end: block.fecha_fin,
    enrollmentStart: block.inscripcion_inicio,
    enrollmentEnd: block.inscripcion_fin,
    resourceIds,
    tariffSpecs,
  };
}

async function planHighDataset(connection, catalog, today, low, forUpdate) {
  const suffix = lockClause(forUpdate);
  const season = await markerRow(
    connection,
    `SELECT id, nombre, origen FROM temporada_tarifa WHERE nombre = ? ORDER BY id${suffix}`,
    [HIGH_SEASON_NAME],
    HIGH_SEASON_NAME
  );
  const raffle = await markerRow(
    connection,
    `SELECT id, nombre FROM sorteo WHERE nombre = ? ORDER BY id${suffix}`,
    [RAFFLE_NAME],
    RAFFLE_NAME
  );
  const block = await markerRow(
    connection,
    `SELECT id, nombre FROM bloque_fecha WHERE nombre = ? ORDER BY id${suffix}`,
    [BLOCK_NAME],
    BLOCK_NAME
  );
  const roots = [season, raffle, block].filter(Boolean).length;
  if (roots !== 0 && roots !== 3) throw new Error("El dataset de sorteo demo esta parcialmente presente");
  if (roots === 3) return validateExistingHigh(connection, catalog, { season, raffle, block }, today, forUpdate);

  const resourceIds = catalog.resources.slice(0, 2).map((resource) => resource.id);
  const minimumOffset = Math.max(35, diferenciaDiasCivil(today, low.end) + 30);
  const window = await findFreshWindow(connection, resourceIds, today, { offset: minimumOffset, length: HIGH_BLOCK_DAYS });
  const enrollmentStart = sumarDiasFechaCivil(today, -1);
  const enrollmentEnd = sumarDiasFechaCivil(today, 7);
  if (enrollmentEnd >= window.start) throw new Error("La inscripcion del sorteo debe cerrar antes del bloque");
  return {
    action: "CREATE",
    seasonId: null,
    raffleId: null,
    blockId: null,
    start: window.start,
    end: window.end,
    enrollmentStart,
    enrollmentEnd,
    resourceIds,
    tariffSpecs: buildTariffSpecs(
      catalog.types,
      resourceIds,
      catalog.regimen.id,
      window.start,
      window.end,
      HIGH_BASE_CENTS,
      true
    ),
  };
}

async function planOlympics(connection, catalog, today, forUpdate) {
  const suffix = lockClause(forUpdate);
  const root = await markerRow(
    connection,
    `SELECT id, nombre, habilitado, eliminado,
            DATE_FORMAT(fecha_inicio, '%Y-%m-%d') fecha_inicio,
            DATE_FORMAT(fecha_fin, '%Y-%m-%d') fecha_fin,
            DATE_FORMAT(fecha_inicio_inscripcion, '%Y-%m-%d') inscripcion_inicio,
            DATE_FORMAT(fecha_fin_inscripcion, '%Y-%m-%d') inscripcion_fin
       FROM olimpiada WHERE nombre = ? ORDER BY id${suffix}`,
    [OLYMPICS_NAME],
    OLYMPICS_NAME
  );
  if (root) {
    const [configs] = await connection.query(
      `SELECT c.disciplina_id
         FROM olimpiada_disciplina_config c
         INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id AND d.habilitado = 'Y'
        WHERE c.olimpiada_id = ? ORDER BY c.disciplina_id${suffix}`,
      [root.id]
    );
    if (
      root.habilitado !== "Y" || Number(root.eliminado) !== 0 ||
      root.inscripcion_inicio > today || root.inscripcion_fin < today || root.fecha_inicio <= root.inscripcion_fin ||
      configs.length !== 3
    ) {
      throw new Error("La olimpiada demo existente fue modificada o ya no esta abierta");
    }
    return {
      action: "REUSE",
      id: asPositiveId(root.id),
      enrollmentStart: root.inscripcion_inicio,
      enrollmentEnd: root.inscripcion_fin,
      start: root.fecha_inicio,
      end: root.fecha_fin,
      disciplineIds: configs.map((config) => asPositiveId(config.disciplina_id)),
    };
  }

  const [disciplines] = await connection.query(
    `SELECT id FROM olimpiada_disciplina WHERE habilitado = 'Y' ORDER BY id LIMIT 3${suffix}`
  );
  if (disciplines.length !== 3) throw new Error("Se necesitan al menos tres disciplinas olimpicas habilitadas");
  const schedule = buildDefaultSchedule(today);
  return {
    action: "CREATE",
    id: null,
    enrollmentStart: schedule.olympicsEnrollmentStart,
    enrollmentEnd: schedule.olympicsEnrollmentEnd,
    start: schedule.olympicsStart,
    end: schedule.olympicsEnd,
    disciplineIds: disciplines.map((discipline) => asPositiveId(discipline.id)),
  };
}

async function buildPlan(connection, { forUpdate = false } = {}) {
  await assertMigrationApplied(connection);
  const today = await getToday(connection);
  const catalog = await loadCatalog(connection, forUpdate);
  const low = await planLowDataset(connection, catalog, today, forUpdate);
  const high = await planHighDataset(connection, catalog, today, low, forUpdate);
  const olympics = await planOlympics(connection, catalog, today, forUpdate);
  return { today, catalog, low, high, olympics };
}

async function insertSeasonHistory(connection, seasonId, actorId, field, value) {
  await connection.query(
    `INSERT INTO historial_temporada
       (temporada_id, usuario_id, operacion, campo_afectado, valor_anterior, valor_nuevo, fecha_cambio)
     VALUES (?, ?, 'CREATE', ?, NULL, ?, NOW())`,
    [seasonId, actorId, field, JSON.stringify(value)]
  );
}

async function insertSeasonAndRates(connection, {
  name,
  origin,
  start,
  end,
  tariffSpecs,
  types,
  actorId,
  additional = null,
}) {
  const [seasonResult] = await connection.query(
    "INSERT INTO temporada_tarifa (nombre, fecha_inicio, fecha_fin, origen) VALUES (?, ?, ?, ?)",
    [name, start, end, origin]
  );
  const seasonId = asPositiveId(seasonResult.insertId, "temporada creada");
  const percentageByType = new Map();
  for (const spec of tariffSpecs) percentageByType.set(spec.typeId, spec.discountPercent);
  for (const type of types) {
    await connection.query(
      `INSERT INTO temporada_tipo_persona_porcentaje (temporada_tarifa_id, tipo_persona_id, porcentaje)
       VALUES (?, ?, ?)`,
      [seasonId, type.id, percentageByType.get(type.id) ?? 0]
    );
  }
  const tariffIds = new Map();
  for (const spec of tariffSpecs) {
    const [result] = await connection.query(
      `INSERT INTO tarifa
         (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
          edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin,
          precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'Y', ?, ?, NULL)`,
      [
        spec.resourceId,
        spec.typeId,
        spec.regimenId,
        seasonId,
        money(spec.priceCents),
        start,
        end,
        spec.usesPercentage ? 1 : 0,
        spec.discountPercent,
      ]
    );
    tariffIds.set(`${spec.resourceId}:${spec.typeId}`, asPositiveId(result.insertId, "tarifa creada"));
  }
  let additionalTariffId = null;
  if (additional) {
    const [result] = await connection.query(
      `INSERT INTO tarifa_adicional
         (temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [seasonId, additional.resourceId, additional.regimenId, additional.additionalId, start, end, money(additional.priceCents)]
    );
    additionalTariffId = asPositiveId(result.insertId, "tarifa adicional creada");
  }
  await insertSeasonHistory(connection, seasonId, actorId, "temporada", { marker: MARKER, name, origin, start, end });
  return { seasonId, tariffIds, additionalTariffId };
}

async function applyLowDataset(connection, plan) {
  const low = plan.low;
  if (low.reservationAction === "REUSE") return;
  if (low.seasonAction === "CREATE") {
    const created = await insertSeasonAndRates(connection, {
      name: low.seasonName,
      origin: "GENERAL",
      start: low.start,
      end: low.end,
      tariffSpecs: low.newTariffSpecs,
      types: plan.catalog.types,
      actorId: plan.catalog.actor.id,
      additional: {
        resourceId: low.resourceId,
        regimenId: low.regimenId,
        additionalId: plan.catalog.additional.id,
        priceCents: low.additional.basePriceCents,
      },
    });
    low.seasonId = created.seasonId;
    low.additional.id = created.additionalTariffId;
    for (const participant of low.participants) {
      participant.tariffId = created.tariffIds.get(`${low.resourceId}:${participant.typeId}`);
    }
  }

  const [reservationResult] = await connection.query(
    `INSERT INTO reserva
       (estado_reserva_id, modalidad, sorteo_id, bloque_fecha_id, servicio_id, regimen_id,
        recurso_id, usuario_id, firma_archivo, precio_total, monto_adicionales,
        fecha_inicio, fecha_fin, observaciones, es_por_salud)
     VALUES (?, 'FECHA_LIBRE', NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0)`,
    [
      plan.catalog.initialState.id,
      plan.catalog.service.id,
      low.regimenId,
      low.resourceId,
      low.participants[0].userId,
      money(low.totalCents),
      money(low.additionalSubtotalCents),
      low.start,
      low.end,
      RESERVATION_NOTE,
    ]
  );
  low.reservationId = asPositiveId(reservationResult.insertId, "reserva creada");

  const [additionalResult] = await connection.query(
    `INSERT INTO reserva_adicional
       (reserva_id, adicional_id, nombre_adicional, cantidad, dias, subtotal)
     VALUES (?, ?, ?, 1, ?, ?)`,
    [low.reservationId, plan.catalog.additional.id, plan.catalog.additional.name, low.nights.length, money(low.additionalSubtotalCents)]
  );
  const reservationAdditionalId = asPositiveId(additionalResult.insertId);
  const sourceTariffId = resolveAdditionalSourceTariffId(low);
  for (const detail of low.additional.details) {
    await connection.query(
      `INSERT INTO reserva_adicional_detalle
         (reserva_adicional_id, fecha, cantidad, precio_unitario, subtotal,
          tarifa_adicional_id, porcentaje_descuento, tarifa_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reservationAdditionalId,
        detail.date,
        detail.quantity,
        money(detail.unitPriceCents),
        money(detail.subtotalCents),
        low.additional.id,
        low.additional.discountPercent,
        sourceTariffId,
      ]
    );
  }

  for (const participant of low.participants) {
    const [familyResult] = await connection.query(
      `INSERT INTO reserva_familiar
         (reserva_id, usuario_id, tipo_persona_id, parentesco_id, edad, precio)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        low.reservationId,
        participant.userId,
        participant.typeId,
        participant.relationshipId,
        participant.age,
        money(participant.priceCents * low.nights.length),
      ]
    );
    const familyId = asPositiveId(familyResult.insertId);
    for (const night of low.nights) {
      await connection.query(
        `INSERT INTO reserva_familiar_tarifa (reserva_familiar_id, tarifa_id, fecha)
         VALUES (?, ?, ?)`,
        [familyId, participant.tariffId, night]
      );
    }
  }
  await connection.query(
    `INSERT INTO historial_reserva
       (reserva_id, tipo_operacion, usuario_modificador_id, observaciones)
     VALUES (?, 'CREATE', ?, ?)`,
    [low.reservationId, plan.catalog.actor.id, `${MARKER} Alta transaccional del dataset demo`]
  );
}

async function applyHighDataset(connection, plan) {
  const high = plan.high;
  if (high.action === "REUSE") return;
  const createdSeason = await insertSeasonAndRates(connection, {
    name: HIGH_SEASON_NAME,
    origin: "BLOQUE",
    start: high.start,
    end: high.end,
    tariffSpecs: high.tariffSpecs,
    types: plan.catalog.types,
    actorId: plan.catalog.actor.id,
  });
  high.seasonId = createdSeason.seasonId;
  const [raffleResult] = await connection.query(
    `INSERT INTO sorteo
       (nombre, descripcion, fecha_inicio_inscripcion, fecha_fin_inscripcion, estado)
     VALUES (?, ?, ?, ?, 'ACTIVO')`,
    [RAFFLE_NAME, `${MARKER} Sorteo listo para probar inscripcion y adjudicacion`, high.enrollmentStart, high.enrollmentEnd]
  );
  high.raffleId = asPositiveId(raffleResult.insertId);
  const [blockResult] = await connection.query(
    `INSERT INTO bloque_fecha
       (sorteo_id, servicio_id, temporada_tarifa_id, nombre, modalidad, fecha_inicio, fecha_fin, estado)
     VALUES (?, ?, ?, ?, 'SORTEO', ?, ?, 'ACTIVO')`,
    [high.raffleId, plan.catalog.service.id, high.seasonId, BLOCK_NAME, high.start, high.end]
  );
  high.blockId = asPositiveId(blockResult.insertId);
  for (const resourceId of high.resourceIds) {
    await connection.query(
      `INSERT INTO bloque_fecha_recurso (bloque_fecha_id, recurso_id, estado, reserva_id)
       VALUES (?, ?, 'SORTEO', NULL)`,
      [high.blockId, resourceId]
    );
  }
}

async function applyOlympics(connection, plan) {
  const olympics = plan.olympics;
  if (olympics.action === "REUSE") return;
  const [result] = await connection.query(
    `INSERT INTO olimpiada
       (nombre, edicion, localidad, descripcion, fecha_inicio, fecha_fin,
        fecha_inicio_inscripcion, fecha_fin_inscripcion, texto_licencia, habilitado, eliminado)
     VALUES (?, 'Demo', 'Sede de demostracion', ?, ?, ?, ?, ?, ?, 'Y', 0)`,
    [
      OLYMPICS_NAME,
      `${MARKER} Evento sintetico sin inscripciones ni archivos precargados`,
      olympics.start,
      olympics.end,
      olympics.enrollmentStart,
      olympics.enrollmentEnd,
      "Acepto participar del evento de demostracion y completar la documentacion requerida.",
    ]
  );
  olympics.id = asPositiveId(result.insertId);
  for (const disciplineId of olympics.disciplineIds) {
    await connection.query(
      `INSERT INTO olimpiada_disciplina_config (olimpiada_id, disciplina_id, max_por_departamental)
       VALUES (?, ?, 10)`,
      [olympics.id, disciplineId]
    );
  }
  await connection.query(
    `INSERT INTO olimpiada_historial
       (entidad, entidad_id, olimpiada_id, inscripcion_id, usuario_id, usuario_rol,
        tipo_operacion, valor_nuevo, observacion)
     VALUES ('OLIMPIADA', ?, ?, NULL, ?, 'admin', 'CREATE', ?, ?)`,
    [olympics.id, olympics.id, plan.catalog.actor.id, OLYMPICS_NAME, `${MARKER} Alta transaccional del dataset demo`]
  );
}

async function postAssert(connection, plan) {
  const [reservationRows] = await connection.query(
    `SELECT r.id, r.modalidad, r.estado_reserva_id, r.servicio_id, r.regimen_id, r.recurso_id, r.usuario_id,
            DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') fecha_inicio,
            DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') fecha_fin,
            r.precio_total, r.monto_adicionales,
            (SELECT COALESCE(SUM(rf.precio), 0) FROM reserva_familiar rf WHERE rf.reserva_id = r.id) familiar_total,
            (SELECT COUNT(*) FROM reserva_familiar rf WHERE rf.reserva_id = r.id) family_count,
            (SELECT COALESCE(SUM(ra.subtotal), 0) FROM reserva_adicional ra WHERE ra.reserva_id = r.id) additional_total,
            (SELECT COUNT(*) FROM reserva_adicional ra
              WHERE ra.reserva_id = r.id AND ra.adicional_id = ? AND ra.cantidad = 1 AND ra.dias = ?) valid_additional_count,
            (SELECT COUNT(*) FROM reserva_adicional_detalle rad
              INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id WHERE ra.reserva_id = r.id) detail_count,
            (SELECT COALESCE(SUM(rad.subtotal), 0) FROM reserva_adicional_detalle rad
              INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id WHERE ra.reserva_id = r.id) detail_total,
            (SELECT COUNT(*) FROM reserva_adicional_detalle rad
              INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
             WHERE ra.reserva_id = r.id AND rad.tarifa_adicional_id IS NOT NULL) rated_detail_count,
            (SELECT COUNT(*) FROM reserva_familiar_tarifa rft
              INNER JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
             WHERE rf.reserva_id = r.id) snapshot_count,
            (SELECT COALESCE(SUM(rft.precio_aplicado), 0) FROM reserva_familiar_tarifa rft
              INNER JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
             WHERE rf.reserva_id = r.id) snapshot_total,
            (SELECT COUNT(*) FROM reserva_familiar_tarifa rft
              INNER JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
             WHERE rf.reserva_id = r.id AND rft.snapshot_estado = 'COMPLETO'
               AND rft.tarifa_id IS NOT NULL AND rft.precio_aplicado IS NOT NULL) complete_snapshot_count
       FROM reserva r WHERE r.observaciones = ?`,
    [plan.catalog.additional.id, plan.low.nights.length, RESERVATION_NOTE]
  );
  const reservation = assertZeroOrOne(reservationRows, "postassert reserva demo");
  if (!reservation) throw new Error("Postassert: falta la reserva demo");
  const expectedSnapshots = plan.low.participants.length * plan.low.nights.length;
  if (
    reservation.modalidad !== "FECHA_LIBRE" ||
    Number(reservation.estado_reserva_id) !== plan.catalog.initialState.id ||
    Number(reservation.servicio_id) !== plan.catalog.service.id ||
    Number(reservation.regimen_id) !== plan.low.regimenId ||
    Number(reservation.recurso_id) !== plan.low.resourceId ||
    Number(reservation.usuario_id) !== plan.low.participants[0].userId ||
    reservation.fecha_inicio !== plan.low.start || reservation.fecha_fin !== plan.low.end ||
    decimalACentavos(reservation.precio_total) !== plan.low.totalCents ||
    decimalACentavos(reservation.monto_adicionales) !== plan.low.additionalSubtotalCents ||
    decimalACentavos(reservation.familiar_total) !== plan.low.familySubtotalCents ||
    decimalACentavos(reservation.additional_total) !== plan.low.additionalSubtotalCents ||
    decimalACentavos(reservation.detail_total) !== plan.low.additionalSubtotalCents ||
    decimalACentavos(reservation.snapshot_total) !== plan.low.familySubtotalCents ||
    Number(reservation.family_count) !== plan.low.participants.length ||
    Number(reservation.valid_additional_count) !== 1 ||
    Number(reservation.detail_count) !== plan.low.nights.length ||
    Number(reservation.rated_detail_count) !== plan.low.nights.length ||
    Number(reservation.snapshot_count) !== expectedSnapshots ||
    Number(reservation.complete_snapshot_count) !== expectedSnapshots
  ) {
    throw new Error("Postassert: la reserva demo no coincide exactamente con su manifiesto");
  }

  const [additionalDetailRows] = await connection.query(
    `SELECT ra.id reservation_additional_id, ra.adicional_id,
            ra.cantidad additional_quantity, ra.dias additional_days, ra.subtotal additional_subtotal,
            rad.tarifa_adicional_id, rad.cantidad detail_quantity, rad.precio_unitario,
            rad.subtotal detail_subtotal, rad.porcentaje_descuento, rad.tarifa_id,
            DATE_FORMAT(rad.fecha, '%Y-%m-%d') fecha,
            ta.precio base_price, ta.temporada_tarifa_id additional_season_id,
            ta.recurso_id additional_resource_id, ta.regimen_id additional_regimen_id,
            ta.adicional_id tariff_additional_id, ta.activo additional_active,
            DATE_FORMAT(ta.fecha_inicio, '%Y-%m-%d') tariff_start,
            DATE_FORMAT(ta.fecha_fin, '%Y-%m-%d') tariff_end
       FROM reserva_adicional ra
       INNER JOIN reserva_adicional_detalle rad ON rad.reserva_adicional_id = ra.id
       INNER JOIN tarifa_adicional ta ON ta.id = rad.tarifa_adicional_id
      WHERE ra.reserva_id = ? ORDER BY rad.fecha`,
    [reservation.id]
  );
  try {
    assertStoredAdditionalContract(additionalDetailRows, plan.low, plan.catalog.additional.id);
  } catch (error) {
    throw new Error(`Postassert: ${error.message}`);
  }

  const [highRows] = await connection.query(
    `SELECT s.id sorteo_id, s.estado sorteo_estado, bf.id bloque_id, bf.estado bloque_estado,
            bf.temporada_tarifa_id,
            (SELECT COUNT(*) FROM bloque_fecha_recurso x WHERE x.bloque_fecha_id = bf.id) resource_count,
            (SELECT COUNT(*) FROM bloque_fecha_recurso x WHERE x.bloque_fecha_id = bf.id AND x.estado = 'SORTEO' AND x.reserva_id IS NULL) available_count,
            (SELECT COUNT(*) FROM tarifa t WHERE t.temporada_tarifa_id = bf.temporada_tarifa_id) tariff_count,
            (SELECT COUNT(*) FROM temporada_tipo_persona_porcentaje p
              WHERE p.temporada_tarifa_id = bf.temporada_tarifa_id) percentage_count,
            (SELECT COUNT(*) FROM tarifa t WHERE t.temporada_tarifa_id = bf.temporada_tarifa_id
              AND t.tipo_persona_id = ? AND t.precio = 0 AND t.usa_porcentaje = 1 AND t.porcentaje_descuento = 100) free_minor_count
       FROM sorteo s INNER JOIN bloque_fecha bf ON bf.sorteo_id = s.id
      WHERE s.nombre = ? AND bf.nombre = ?`,
    [plan.catalog.minorTypeId, RAFFLE_NAME, BLOCK_NAME]
  );
  const high = assertZeroOrOne(highRows, "postassert sorteo demo");
  if (
    !high || high.sorteo_estado !== "ACTIVO" || high.bloque_estado !== "ACTIVO" ||
    Number(high.resource_count) !== plan.high.resourceIds.length ||
    Number(high.available_count) !== plan.high.resourceIds.length ||
    Number(high.tariff_count) !== plan.high.resourceIds.length * plan.catalog.types.length ||
    Number(high.percentage_count) !== plan.catalog.types.length ||
    Number(high.free_minor_count) !== plan.high.resourceIds.length
  ) {
    throw new Error("Postassert: sorteo, bloque o matriz alta inconsistentes");
  }

  const [olympicsRows] = await connection.query(
    `SELECT o.id, o.habilitado, o.eliminado,
            (SELECT COUNT(*) FROM olimpiada_disciplina_config c WHERE c.olimpiada_id = o.id) config_count,
            (SELECT COUNT(*) FROM olimpiada_historial h WHERE h.olimpiada_id = o.id AND h.tipo_operacion = 'CREATE') history_count,
            (SELECT COUNT(*) FROM olimpiada_inscripcion i WHERE i.olimpiada_id = o.id AND i.eliminado = 0) registration_count
       FROM olimpiada o WHERE o.nombre = ?`,
    [OLYMPICS_NAME]
  );
  const olympics = assertZeroOrOne(olympicsRows, "postassert olimpiada demo");
  if (
    !olympics || olympics.habilitado !== "Y" || Number(olympics.eliminado) !== 0 ||
    Number(olympics.config_count) !== 3 || Number(olympics.history_count) < 1 || Number(olympics.registration_count) !== 0
  ) {
    throw new Error("Postassert: la olimpiada demo no conserva el contrato esperado");
  }
  return {
    reservation_id: asPositiveId(reservation.id),
    raffle_id: asPositiveId(high.sorteo_id),
    block_id: asPositiveId(high.bloque_id),
    olympics_id: asPositiveId(olympics.id),
  };
}

async function acquireLock(connection) {
  const [[row]] = await connection.query("SELECT GET_LOCK(?, 10) AS acquired", [SEED_LOCK]);
  if (Number(row?.acquired) !== 1) throw new Error("No se pudo adquirir el bloqueo del seed demo");
}

async function releaseLock(connection) {
  await connection.query("SELECT RELEASE_LOCK(?)", [SEED_LOCK]).catch(() => {});
}

function printResult({ apply, manifest, manifestSha256, postassert = null }) {
  console.log(JSON.stringify({
    script: "seed-demo-integral",
    dry_run: !apply,
    applied: apply,
    manifest_sha256: manifestSha256,
    manifest,
    postassert: postassert ? {
      ok: true,
      reservation_ref: fingerprint("reserva", postassert.reservation_id),
      raffle_ref: fingerprint("sorteo", postassert.raffle_id),
      block_ref: fingerprint("bloque", postassert.block_id),
      olympics_ref: fingerprint("olimpiada", postassert.olympics_id),
    } : null,
  }, null, 2));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const mode = validateApplyArguments(args);
  const connection = await createConnection();
  let transactionOpen = false;
  try {
    await acquireLock(connection);
    if (!mode.apply) {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.query("SET TRANSACTION READ ONLY");
      await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
      transactionOpen = true;
      const plan = await buildPlan(connection, { forUpdate: false });
      const manifest = publicManifest(plan);
      const manifestSha256 = sha256(stableJson(manifest));
      await connection.rollback();
      transactionOpen = false;
      printResult({ apply: false, manifest, manifestSha256 });
      return { applied: false, manifest, manifestSha256 };
    }

    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    transactionOpen = true;
    const plan = await buildPlan(connection, { forUpdate: true });
    const manifest = publicManifest(plan);
    const currentHash = sha256(stableJson(manifest));
    if (currentHash !== mode.manifestSha256) {
      throw new Error(`El manifiesto cambio: esperado ${mode.manifestSha256}, actual ${currentHash}`);
    }
    await applyLowDataset(connection, plan);
    await applyHighDataset(connection, plan);
    await applyOlympics(connection, plan);
    const postassert = await postAssert(connection, plan);
    await connection.commit();
    transactionOpen = false;
    printResult({ apply: true, manifest, manifestSha256: currentHash, postassert });
    return { applied: true, manifest, manifestSha256: currentHash, postassert };
  } catch (error) {
    if (transactionOpen) await connection.rollback().catch(() => {});
    throw error;
  } finally {
    await releaseLock(connection);
    await connection.end();
  }
}

module.exports = {
  ADDITIONAL_CENTS,
  APPLY_CONFIRMATION,
  HIGH_BASE_CENTS,
  LEGACY_SEASON_NAME,
  LOW_BASE_CENTS,
  MARKER,
  assertZeroOrOne,
  buildDefaultSchedule,
  buildTariffSpecs,
  canonicalAdditionalPricing,
  fingerprint,
  main,
  manifestHash,
  naturalNameMatches,
  normalizeName,
  pricePolicyForType,
  publicManifest,
  validateApplyArguments,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify(redactError(error)));
    process.exitCode = 1;
  });
}
