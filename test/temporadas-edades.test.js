"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validarRangosEdadTemporada } = require("../api/services/temporadas-edades");

const rango = (edad_minima, edad_maxima) => ({ edad_minima, edad_maxima });

test("bebés tienen un único rango inclusivo de 0 a 1 años", () => {
  assert.equal(validarRangosEdadTemporada(5, [rango(0, 1)]), null);
  for (const rangos of [[rango(0, 2)], [rango(0, null)], [rango(0, 0), rango(1, 1)]]) {
    assert.match(validarRangosEdadTemporada(5, rangos), /único rango de 0 a 1/);
  }
});

test("menores y adultos se separan a los 18 años para todos los tipos generales", () => {
  for (const tipo of [0, 1, 2, 3, 4, 6]) {
    assert.equal(validarRangosEdadTemporada(tipo, [rango(2, 17), rango(18, null)]), null);
    assert.match(validarRangosEdadTemporada(tipo, [rango(2, 4), rango(5, null)]), /Separá/);
    assert.match(validarRangosEdadTemporada(tipo, [rango(2, 18)]), /Separá/);
    assert.match(validarRangosEdadTemporada(tipo, [rango(0, 1)]), /Menores de 2/);
  }
});

test("se admiten subdivisiones inclusivas y tarifas para una sola edad", () => {
  assert.equal(validarRangosEdadTemporada(1, [rango(2, 2), rango(3, 16), rango(17, 17), rango(18, 18), rango(19, null)]), null);
  assert.equal(validarRangosEdadTemporada(4, [{ edadMinima: "2", edadMaxima: "17" }, { edadMinima: "18", edadMaxima: "" }]), null);
  assert.match(validarRangosEdadTemporada(1, [rango(2, 10), rango(10, 17)]), /solaparse/);
});

test("no se aceptan edades fraccionarias, fuera de límite o convertidas desde booleanos", () => {
  for (const [minimo, maximo] of [[2.5, 17], [2, 17.5], [18, 131], [false, 17], [[2], 17], [2, true], [" ", 17], [18, 17]]) {
    assert.match(validarRangosEdadTemporada(1, [rango(minimo, maximo)]), /límites enteros/);
  }
});
