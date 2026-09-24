"use strict";

// Plan puro del corrector de adicionales que tomaron el 100% de un bebé.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONFIRMATION,
  planificarReserva,
  validateApplyArguments,
} = require("../scripts/corregir-descuento-adicionales-bebe");

const NOCHES = ["2026-10-14", "2026-10-15"];

// Réplica de la reserva 29: afiliado 35%, invitado familiar 20%, bebé 100% y
// una mascota de $5.000 por noche que quedó gratis.
function reservaConBebe(extra = {}) {
  const snapshot = (reservaFamiliarId, tarifaId, porcentaje) => NOCHES.map((fecha) => ({
    reserva_familiar_id: reservaFamiliarId,
    fecha,
    tarifa_id: tarifaId,
    usa_porcentaje_aplicado: 1,
    porcentaje_descuento_aplicado: porcentaje,
  }));
  return {
    reserva: {
      id: 29,
      estado_reserva_id: 2,
      estado: "Verificada",
      modalidad: "FECHA_LIBRE",
      fecha_inicio: "2026-10-14",
      fecha_fin: "2026-10-16",
      precio_total: "145000.00",
      monto_adicionales: "0.00",
      monto_descuentos: "0.00",
      es_por_salud: 0,
    },
    familiares: [
      { id: 41, tipo_persona_id: 1, precio: "65000.00" },
      { id: 42, tipo_persona_id: 2, precio: "80000.00" },
      { id: 43, tipo_persona_id: 5, precio: "0.00" },
    ],
    tarifasFamiliares: [
      ...snapshot(41, 512, "35.00"),
      ...snapshot(42, 513, "20.00"),
      ...snapshot(43, 516, "100.00"),
    ],
    adicionales: [{ id: 30, adicional_id: 3, nombre_adicional: "Mascota", cantidad: 1, dias: 2, subtotal: "0.00" }],
    detalles: NOCHES.map((fecha, indice) => ({
      id: 57 + indice,
      reserva_adicional_id: 30,
      fecha,
      cantidad: 1,
      precio_unitario: "0.00",
      subtotal: "0.00",
      tarifa_adicional_id: 25,
      porcentaje_descuento: "100.00",
      tarifa_id: 516,
    })),
    tarifasAdicionales: [{ id: 25, adicional_id: 3, precio: "5000.00" }],
    descuentosConAdicionales: [],
    saludes: 0,
    ...extra,
  };
}

test("recalcula la mascota con el 35% del afiliado en lugar del 100% del bebe", () => {
  const { row, errors } = planificarReserva(reservaConBebe());
  assert.deepEqual(errors, []);
  assert.equal(row.monto_adicionales_anterior, "0.00");
  assert.equal(row.monto_adicionales_nuevo, "6500.00");
  assert.equal(row.precio_total_anterior, "145000.00");
  assert.equal(row.precio_total_nuevo, "151500.00");
  assert.deepEqual(row.adicionales.map((a) => [a.id, a.subtotal_anterior, a.subtotal_nuevo]), [[30, "0.00", "6500.00"]]);
  assert.deepEqual(row.detalles.map((d) => d.id), [57, 58]);
  for (const detalle of row.detalles) {
    assert.deepEqual(detalle.anterior, { precio_unitario: "0.00", subtotal: "0.00", porcentaje_descuento: "100.00", tarifa_id: 516 });
    assert.deepEqual(detalle.nuevo, { precio_unitario: "3250.00", subtotal: "3250.00", porcentaje_descuento: "35.00", tarifa_id: 512 });
    assert.equal(detalle.precio_lista, "5000.00");
  }
});

test("con solo invitados sin porcentaje y un bebe el adicional se cobra entero", () => {
  const datos = reservaConBebe();
  datos.familiares = [
    { id: 41, tipo_persona_id: 3, precio: "72500.00" },
    { id: 43, tipo_persona_id: 5, precio: "0.00" },
  ];
  datos.reserva.precio_total = "145000.00";
  datos.familiares[0].precio = "145000.00";
  datos.tarifasFamiliares = datos.tarifasFamiliares
    .filter((fila) => fila.reserva_familiar_id !== 42)
    .map((fila) => fila.reserva_familiar_id === 41
      ? { ...fila, tarifa_id: 514, usa_porcentaje_aplicado: 0, porcentaje_descuento_aplicado: "0.00" }
      : fila);
  const { row, errors } = planificarReserva(datos);
  assert.deepEqual(errors, []);
  assert.equal(row.monto_adicionales_nuevo, "10000.00");
  assert.equal(row.precio_total_nuevo, "155000.00");
  assert.deepEqual(row.detalles[0].nuevo, { precio_unitario: "5000.00", subtotal: "5000.00", porcentaje_descuento: "0.00", tarifa_id: null });
});

test("no toca reservas que ya cumplen la regla vigente (idempotencia)", () => {
  const datos = reservaConBebe();
  datos.detalles = datos.detalles.map((detalle) => ({
    ...detalle, precio_unitario: "3250.00", subtotal: "3250.00", porcentaje_descuento: "35.00", tarifa_id: 512,
  }));
  datos.adicionales[0].subtotal = "6500.00";
  datos.reserva.monto_adicionales = "6500.00";
  datos.reserva.precio_total = "151500.00";
  assert.deepEqual(planificarReserva(datos), { row: null, errors: [], detalles_revisados: 2 });
});

test("un bebe con tarifa reducida (50%) tambien deja de contar", () => {
  const datos = reservaConBebe();
  datos.tarifasFamiliares = datos.tarifasFamiliares.map((fila) => fila.reserva_familiar_id === 43
    ? { ...fila, porcentaje_descuento_aplicado: "50.00" }
    : fila);
  datos.detalles = datos.detalles.map((d) => ({ ...d, precio_unitario: "2500.00", subtotal: "2500.00", porcentaje_descuento: "50.00" }));
  datos.adicionales[0].subtotal = "5000.00";
  datos.reserva.monto_adicionales = "5000.00";
  datos.reserva.precio_total = "150000.00";
  const { row, errors } = planificarReserva(datos);
  assert.deepEqual(errors, []);
  assert.equal(row.precio_total_nuevo, "151500.00");
  assert.equal(row.detalles[0].nuevo.porcentaje_descuento, "35.00");

  // Si la lista del adicional cambió desde el alta no se puede recalcular con certeza.
  const listaCambiada = planificarReserva({ ...datos, tarifasAdicionales: [{ id: 25, adicional_id: 3, precio: "6000.00" }] });
  assert.ok(listaCambiada.errors.some((e) => /precio de lista del detalle 57 cambió/.test(e)));
  assert.equal(listaCambiada.row, null);
});

test("aborta si un detalle no coincide con ninguna regla o los totales no cierran", () => {
  const raro = planificarReserva(reservaConBebe({
    detalles: reservaConBebe().detalles.map((d) => ({ ...d, precio_unitario: "3250.00", subtotal: "3250.00", porcentaje_descuento: "35.00", tarifa_id: 516 })),
  }));
  assert.ok(raro.errors.some((e) => /ni con la regla anterior ni con la vigente/.test(e)));

  // Con 100% el precio aplicado es 0 para cualquier lista: se toma la lista
  // vigente de la tarifa_adicional del detalle.
  const datos = reservaConBebe();
  datos.tarifasAdicionales = [{ id: 25, adicional_id: 3, precio: "6000.00" }];
  assert.deepEqual(planificarReserva(datos).errors, []);
  assert.equal(planificarReserva(datos).row.monto_adicionales_nuevo, "7800.00");

  const totalRoto = reservaConBebe();
  totalRoto.reserva.precio_total = "140000.00";
  assert.ok(planificarReserva(totalRoto).errors.some((e) => /precio_total no coincide/.test(e)));
});

test("aborta con mensaje claro si un descuento incluye adicionales o es viaje por salud", () => {
  const conDescuento = planificarReserva(reservaConBebe({ descuentosConAdicionales: [{ id: 9 }] }));
  assert.ok(conDescuento.errors.some((e) => /descuentos que incluyen adicionales \(reserva_descuento 9\)/.test(e)));
  const salud = planificarReserva(reservaConBebe({ saludes: 1 }));
  assert.ok(salud.errors.some((e) => /viaje por salud/.test(e)));
});

test("resta los descuentos que no incluyen adicionales del nuevo total", () => {
  const datos = reservaConBebe();
  datos.reserva.monto_descuentos = "14500.00";
  datos.reserva.precio_total = "130500.00";
  const { row, errors } = planificarReserva(datos);
  assert.deepEqual(errors, []);
  assert.equal(row.precio_total_nuevo, "137000.00");
});

test("el apply exige confirmacion, SHA-256 y --allow-production fuera de una base local", () => {
  const hash = "b".repeat(64);
  assert.deepEqual(validateApplyArguments({}, { host: "rds.amazonaws.com" }), { apply: false });
  assert.throws(() => validateApplyArguments({ apply: true }, { host: "localhost" }), new RegExp(CONFIRMATION));
  assert.throws(
    () => validateApplyArguments({ apply: true, confirm: CONFIRMATION }, { host: "localhost" }),
    /manifest-sha256/
  );
  assert.deepEqual(
    validateApplyArguments({ apply: true, confirm: CONFIRMATION, "manifest-sha256": hash }, { host: "localhost" }),
    { apply: true, manifestSha256: hash }
  );
  assert.throws(
    () => validateApplyArguments({ apply: true, confirm: CONFIRMATION, "manifest-sha256": hash }, { host: "database-1.rds.amazonaws.com" }),
    /allow-production/
  );
  assert.throws(
    () => validateApplyArguments(
      { apply: true, confirm: CONFIRMATION, "manifest-sha256": hash },
      { host: "localhost", nodeEnv: "production" }
    ),
    /allow-production/
  );
  assert.equal(
    validateApplyArguments(
      { apply: true, confirm: CONFIRMATION, "manifest-sha256": hash, "allow-production": true },
      { host: "database-1.rds.amazonaws.com" }
    ).apply,
    true
  );
});
