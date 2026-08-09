"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APPLY_CONFIRMATION,
  HIGH_BASE_CENTS,
  LOW_BASE_CENTS,
  MARKER,
  assertZeroOrOne,
  buildDefaultSchedule,
  buildTariffSpecs,
  canonicalAdditionalPricing,
  manifestHash,
  naturalNameMatches,
  normalizeName,
  pricePolicyForType,
  publicManifest,
  validateApplyArguments,
} = require("../scripts/seed-demo-integral");

function fakePlan() {
  return {
    today: "2026-08-09",
    catalog: {
      actor: { id: 91 },
      additional: { id: 7, name: "Mascota" },
      types: [
        { id: 1, nombre: "Afiliados" },
        { id: 2, nombre: "Invitados familiares ajb y convenios" },
        { id: 5, nombre: "Menores de 2 años" },
      ],
    },
    low: {
      seasonAction: "CREATE",
      seasonName: "Temporada de prueba (seed)",
      reservationAction: "CREATE",
      start: "2026-08-23",
      end: "2026-08-25",
      nights: ["2026-08-23", "2026-08-24"],
      participants: [
        { userId: 31, typeId: 1, relationshipId: null, age: 40, tariffId: 101, usesPercentage: true, discountPercent: 35 },
        { userId: 32, typeId: 2, relationshipId: 2, age: 38, tariffId: 102, usesPercentage: true, discountPercent: 20 },
      ],
      additional: {
        details: [
          { date: "2026-08-23", quantity: 1, unitPriceCents: 325_000, subtotalCents: 325_000 },
          { date: "2026-08-24", quantity: 1, unitPriceCents: 325_000, subtotalCents: 325_000 },
        ],
        basePriceCents: 500_000,
        unitPriceCents: 325_000,
        discountPercent: 35,
        sourceParticipantIndex: 0,
      },
      newTariffSpecs: [{}, {}, {}],
      familySubtotalCents: 14_500_000,
      additionalSubtotalCents: 650_000,
      totalCents: 15_150_000,
    },
    high: {
      action: "CREATE",
      start: "2026-09-24",
      end: "2026-09-29",
      enrollmentStart: "2026-08-08",
      enrollmentEnd: "2026-08-16",
      resourceIds: [12, 13],
      tariffSpecs: [
        { priceCents: 0, discountPercent: 100 },
        { priceCents: 4_875_000, discountPercent: 25 },
      ],
    },
    olympics: {
      action: "CREATE",
      enrollmentStart: "2026-08-08",
      enrollmentEnd: "2026-08-30",
      start: "2026-09-23",
      end: "2026-09-26",
      disciplineIds: [2, 21, 43],
    },
  };
}

test("el seed es dry-run salvo confirmacion, hash y permiso explicitos", () => {
  assert.deepEqual(validateApplyArguments({}, "production", "verify-full"), { apply: false });
  assert.throws(() => validateApplyArguments({}, "production", "disabled"), /verify-full/);
  assert.throws(
    () => validateApplyArguments({ apply: true }, "development"),
    new RegExp(APPLY_CONFIRMATION)
  );
  assert.throws(
    () => validateApplyArguments({ apply: true, confirm: APPLY_CONFIRMATION }, "development"),
    /manifest-sha256/
  );
  const hash = "a".repeat(64);
  assert.throws(
    () => validateApplyArguments(
      { apply: true, confirm: APPLY_CONFIRMATION, "manifest-sha256": hash },
      "production",
      "verify-full"
    ),
    /allow-production/
  );
  assert.throws(
    () => validateApplyArguments({
      apply: true,
      confirm: APPLY_CONFIRMATION,
      "manifest-sha256": hash,
      "allow-production": true,
    }, "production", "disabled"),
    /verify-full/
  );
  assert.deepEqual(
    validateApplyArguments({
      apply: true,
      confirm: APPLY_CONFIRMATION,
      "manifest-sha256": hash.toUpperCase(),
      "allow-production": true,
    }, "production", "verify-full"),
    { apply: true, manifestSha256: hash }
  );
});

test("normaliza nombres naturales sin depender de acentos ni IDs", () => {
  assert.equal(normalizeName("  Cabañas  "), "cabanas");
  assert.equal(normalizeName("ÚNICO"), "unico");
  assert.equal(normalizeName("Menores   de 2 años"), "menores de 2 anos");
  assert.equal(naturalNameMatches("Caba?as", "Cabañas"), true);
  assert.equal(naturalNameMatches("?nico", "Único"), true);
  assert.equal(naturalNameMatches("Camping", "Cabañas"), false);
});

test("las tarifas porcentuales usan centavos y 100 por ciento produce cero", () => {
  assert.deepEqual(pricePolicyForType("Afiliados", LOW_BASE_CENTS, false), {
    priceCents: 3_250_000,
    usesPercentage: true,
    discountPercent: 35,
  });
  assert.deepEqual(pricePolicyForType("Afiliados", HIGH_BASE_CENTS, true), {
    priceCents: 4_875_000,
    usesPercentage: true,
    discountPercent: 25,
  });
  assert.deepEqual(pricePolicyForType("Menores de 2 años", HIGH_BASE_CENTS, true), {
    priceCents: 0,
    usesPercentage: true,
    discountPercent: 100,
  });
});

test("el adicional replica el mayor descuento canonico por noche y conserva su tarifa fuente", () => {
  const pricing = canonicalAdditionalPricing(
    [
      { typeId: 1, tariffId: 101, usesPercentage: true, discountPercent: "35.00" },
      { typeId: 2, tariffId: 102, usesPercentage: false, discountPercent: 90 },
      { typeId: 3, tariffId: 103, usesPercentage: true, discountPercent: 35 },
    ],
    1_001,
    ["2026-08-23", "2026-08-24"]
  );
  assert.equal(pricing.discountBasisPoints, 3_500);
  assert.equal(pricing.discountPercent, 35);
  assert.equal(pricing.sourceParticipantIndex, 0);
  assert.equal(pricing.sourceTariffId, 101);
  assert.equal(pricing.unitPriceCents, 651);
  assert.equal(pricing.subtotalCents, 1_302);
  assert.deepEqual(pricing.details.map((detail) => detail.date), ["2026-08-23", "2026-08-24"]);

  const free = canonicalAdditionalPricing(
    [{ typeId: 5, tariffId: 501, usesPercentage: true, discountPercent: 100 }],
    500_000,
    ["2026-08-23"]
  );
  assert.equal(free.unitPriceCents, 0);
  assert.equal(free.subtotalCents, 0);
  assert.equal(free.sourceTariffId, 501);
  assert.throws(
    () => canonicalAdditionalPricing(
      [{ typeId: 1, tariffId: 101, usesPercentage: true, discountPercent: "invalido" }],
      500_000,
      ["2026-08-23"]
    ),
    /porcentaje invalido/
  );
});

test("construye la matriz completa por recurso y tipo", () => {
  const rows = buildTariffSpecs(
    [
      { id: 1, nombre: "Afiliados" },
      { id: 5, nombre: "Menores de 2 años" },
    ],
    [11, 12],
    3,
    "2026-09-01",
    "2026-09-06",
    HIGH_BASE_CENTS,
    true
  );
  assert.equal(rows.length, 4);
  assert.deepEqual(new Set(rows.map((row) => row.resourceId)), new Set([11, 12]));
  assert.equal(rows.filter((row) => row.typeId === 5 && row.priceCents === 0).length, 2);
  assert.ok(rows.every((row) => row.regimenId === 3));
});

test("las fechas civiles conservan noches, ventanas y orden cronologico", () => {
  assert.deepEqual(buildDefaultSchedule("2026-12-20", "2026-12-30"), {
    today: "2026-12-20",
    lowStart: "2026-12-30",
    lowEnd: "2027-01-01",
    raffleEnrollmentStart: "2026-12-19",
    raffleEnrollmentEnd: "2026-12-27",
    blockStart: "2027-01-31",
    blockEnd: "2027-02-05",
    olympicsEnrollmentStart: "2026-12-19",
    olympicsEnrollmentEnd: "2027-01-10",
    olympicsStart: "2027-02-03",
    olympicsEnd: "2027-02-06",
  });
});

test("la cardinalidad 0/1/>1 evita duplicados silenciosos", () => {
  assert.equal(assertZeroOrOne([], "demo"), null);
  assert.deepEqual(assertZeroOrOne([{ id: 1 }], "demo"), { id: 1 });
  assert.throws(() => assertZeroOrOne([{ id: 1 }, { id: 2 }], "demo"), /encontraron 2 filas/);
});

test("el manifiesto es estable y no expone IDs de usuarios ni PII", () => {
  const plan = fakePlan();
  const manifest = publicManifest(plan);
  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.dataset, MARKER);
  assert.match(manifest.actor_ref, /^[a-f0-9]{20}$/);
  assert.match(manifest.participants.titular_ref, /^[a-f0-9]{20}$/);
  assert.equal(manifest.participants.member_refs.length, 2);
  assert.ok(manifest.participants.member_refs.every((ref) => /^[a-f0-9]{20}$/.test(ref)));
  assert.equal(serialized.includes('"userId"'), false);
  assert.equal(serialized.includes('"id":91'), false);
  assert.equal(manifest.reservation.additional_subtotal, "6500.00");
  assert.equal(manifest.reservation.total, "151500.00");
  assert.equal(manifest.reservation.additional.discount_percent, 35);
  assert.equal(manifest.reservation.additional.discounted_unit_price, "3250.00");
  assert.match(manifest.reservation.additional.discount_source_ref, /^[a-f0-9]{20}$/);
  assert.equal(manifest.high_season.includes_free_minor_rate, true);
  assert.equal(manifestHash(plan), manifestHash(structuredClone(plan)));
});

test("el script contiene los limites transaccionales y el legacy solo delega", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../scripts/seed-demo-integral.js"), "utf8");
  const legacy = fs.readFileSync(path.resolve(__dirname, "../scripts/seed-temporada-prueba.js"), "utf8");
  assert.match(script, /GET_LOCK/);
  assert.match(script, /START TRANSACTION WITH CONSISTENT SNAPSHOT/);
  assert.match(script, /beginTransaction\(\)/);
  assert.match(script, /connection\.rollback/);
  assert.match(script, /snapshot_estado = 'COMPLETO'/);
  assert.match(script, /'SORTEO'/);
  assert.match(script, /olimpiada_disciplina_config/);
  assert.doesNotMatch(script, /u\.area_turismo\s*=\s*1/);
  assert.match(script, /rad\.porcentaje_descuento, rad\.tarifa_id/);
  assert.doesNotMatch(legacy, /INSERT INTO tarifa/);
  assert.match(legacy, /require\("\.\/seed-demo-integral"\)/);
});
