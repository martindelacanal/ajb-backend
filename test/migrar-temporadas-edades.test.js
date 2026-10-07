"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { crearPlan, planTarifas, planPredeterminados, opcionesDesdeArgv } = require("../scripts/migrar-temporadas-edades");

function tarifa(id, min, max, extra = {}) {
  return {
    id, recurso_id: 1, tipo_persona_id: 1, regimen_id: 1, temporada_tarifa_id: 1,
    edad_minima: min, edad_maxima: max, precio: "100.00", fecha_inicio: "2026-01-01",
    fecha_fin: "2026-12-31", precio_por_persona: "Y", usa_porcentaje: 0,
    porcentaje_descuento: "0.00", parcelas_disponibles: null,
    audiencia_departamental: "TODAS", turismo_tarifa_regla_id: null, ...extra,
  };
}

function datos(extra = {}) {
  return {
    tipos: [{ id: 1, nombre: "Afiliado" }, { id: 4, nombre: "Precio de lista" }, { id: 5, nombre: "Menores de 2 años" }],
    temporadas: [{ id: 1 }], tarifas: [], reglas: [], rangos: [], reservas: [], personas: [], referencias: [], protegidas: [], ...extra,
  };
}

function referencia(extra = {}) {
  return { tarifa_id: 1, reserva_familiar_id: 10, fecha: "2026-10-15", precio_aplicado: "100.00", tipo_persona_id: 1, edad: 18, ...extra };
}

test("rango abierto reservado por adulto conserva ID, precio y referencia; agrega menores", () => {
  const fuente = datos({ tarifas: [tarifa(1, null, null)], referencias: [referencia()] });
  const plan = planTarifas(fuente);
  assert.deepEqual(plan.updates.map((fila) => [fila.id, fila.edad_minima, fila.edad_maxima]), [[1, 18, null]]);
  assert.deepEqual(plan.inserts.map((fila) => [fila.edad_minima, fila.edad_maxima, fila.precio]), [[2, 17, "100.00"]]);
  assert.deepEqual(plan.deletes, []);
  const repetido = planTarifas({ ...fuente, tarifas: plan.resultado.map((fila) => ({ ...fila, id: fila.id ?? 2 })) });
  assert.equal(repetido.updates.length + repetido.inserts.length + repetido.deletes.length, 0);
});

test("consolida rangos antiguos a 2-17 y 18+ preservando valores representativos", () => {
  const plan = planTarifas(datos({ tarifas: [tarifa(1, 2, 4, { precio: "50.00" }), tarifa(2, 5, 12), tarifa(3, 13, 17), tarifa(4, 18, null)] }));
  assert.deepEqual(plan.deletes, [2, 3]);
  assert.deepEqual(plan.resultado.map((fila) => [fila.id, fila.edad_minima, fila.edad_maxima, fila.precio]), [[4, 18, null, "100.00"], [1, 2, 17, "50.00"]]);
});

test("tarifas globales por recurso no se convierten en tarifas por edad", () => {
  const fila = tarifa(1, null, null, { precio_por_persona: "N", tipo_persona_id: null });
  const plan = planTarifas(datos({ tarifas: [fila] }));
  assert.deepEqual(plan.resultado, [fila]);
  assert.equal(plan.updates.length + plan.inserts.length + plan.deletes.length, 0);
});

test("bebé queda 0-1 sin porcentaje ni cargo y mantiene referencia", () => {
  const plan = planTarifas(datos({ tarifas: [tarifa(1, 0, 2, { tipo_persona_id: 5, precio: "0.00", usa_porcentaje: 1, porcentaje_descuento: "100.00" })], referencias: [referencia({ tipo_persona_id: 5, edad: 1, precio_aplicado: "0.00" })] }));
  assert.deepEqual(plan.updates.map((fila) => [fila.edad_minima, fila.edad_maxima, fila.precio, fila.usa_porcentaje]), [[0, 1, "0.00", 0]]);
});

test("rehúsa consolidar snapshots de distintas categorías que comparten tarifa", () => {
  assert.throws(() => planTarifas(datos({ tarifas: [tarifa(1, null, null)], referencias: [referencia(), referencia({ edad: 17 })] })), /varias categorias/);
});

test("rehúsa eliminar tarifas referenciadas por adicionales o historial", () => {
  assert.throws(() => planTarifas(datos({ tarifas: [tarifa(1, 2, 4), tarifa(2, 5, 12), tarifa(3, 18, null)], protegidas: [{ tarifa_id: 2 }] })), /referencias/);
});

test("precios de bandas agregadas respetan lista y porcentaje", () => {
  const plan = planTarifas(datos({ tarifas: [
    tarifa(1, 2, 4, { precio: "50.00", usa_porcentaje: 1, porcentaje_descuento: "50.00" }),
    tarifa(2, 2, 4, { tipo_persona_id: 4, precio: "100.00" }),
    tarifa(3, 5, null, { tipo_persona_id: 4, precio: "200.00" }),
  ] }));
  assert.equal(plan.resultado.find((fila) => fila.tipo_persona_id === 1 && fila.edad_minima === 18).precio, "100.00");
  assert.equal(plan.resultado.find((fila) => fila.tipo_persona_id === 1 && fila.edad_minima === 2).precio, "50.00");
});

test("predeterminados remapean base y tope a los nuevos órdenes", () => {
  const plan = planPredeterminados(datos({ reglas: [{ id: 1, tipo_persona_id: 0, rango_base_orden: 0, usar_tope: 1, rango_tope_orden: 3 }], rangos: [
    { regla_id: 1, orden: 0, edad_minima: 2, edad_maxima: 4 },
    { regla_id: 1, orden: 1, edad_minima: 5, edad_maxima: 12 },
    { regla_id: 1, orden: 2, edad_minima: 13, edad_maxima: 17 },
    { regla_id: 1, orden: 3, edad_minima: 18, edad_maxima: null },
  ] }));
  assert.deepEqual(plan, [{ id: 1, nuevos: [{ orden: 0, edad_minima: 2, edad_maxima: 17 }, { orden: 1, edad_minima: 18, edad_maxima: null }], rango_base_orden: 0, rango_tope_orden: 1 }]);
});

test("verifica totales respetando descuentos y falla antes de escribir si difieren", () => {
  const fuente = datos({ tarifas: [tarifa(1, 18, null), tarifa(2, 2, 17)], referencias: [referencia()],
    personas: [{ id: 10, reserva_id: 1, edad: 18, precio: "100.00" }],
    reservas: [{ id: 1, precio_total: "95.00", monto_adicionales: "5.00", monto_descuentos: "10.00" }] });
  assert.equal(crearPlan(fuente).resumen.reservas_verificadas, 1);
  fuente.reservas[0].precio_total = "90.00";
  assert.throws(() => crearPlan(fuente), /total de la reserva/);
});

test("check es default, target explícito y production/apply requieren opciones deliberadas", () => {
  assert.equal(opcionesDesdeArgv(["--target=develop"]).apply, false);
  assert.throws(() => opcionesDesdeArgv([]), /target/);
  assert.throws(() => opcionesDesdeArgv(["--target=production"]), /allow-production/);
  assert.throws(() => opcionesDesdeArgv(["--target=develop", "--apply"]), /confirm/);
});
