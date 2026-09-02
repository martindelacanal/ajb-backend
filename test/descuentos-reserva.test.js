"use strict";

// Pruebas offline del cálculo de descuentos de turismo (sin base ni S3).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calcularDescuentos,
  normalizarCodigoCupon,
  normalizarCodigoTipoViaje,
} = require("../api/services/descuentos-reserva");

const reglaBase = (extra = {}) => ({
  id: 1,
  tipo: "CUPON",
  codigo: "JUBILADO",
  nombre: "Jubilados",
  porcentaje: 10,
  base_calculo: "PRECIO_FINAL",
  incluye_adicionales: 0,
  acumulable: 0,
  requiere_comprobante: 0,
  alcance_persona: "TODAS",
  tipos_persona: [],
  edad_minima: null,
  edad_maxima: null,
  ...extra,
});

// Dos personas: el afiliado paga 70.000 (lista 100.000) y un invitado 90.000 (lista 90.000)
const personas = [
  { tipo_persona_id: 1, edad: 68, final_centavos: 7_000_000, lista_centavos: 10_000_000 },
  { tipo_persona_id: 3, edad: 30, final_centavos: 9_000_000, lista_centavos: 9_000_000 },
];

test("normaliza hashtags con o sin numeral, espacios y minúsculas", () => {
  assert.equal(normalizarCodigoCupon("#jubilado"), "JUBILADO");
  assert.equal(normalizarCodigoCupon("  ##Ajb 2026 "), "AJB_2026");
  assert.equal(normalizarCodigoCupon("año-nuevo"), "ANO-NUEVO");
  assert.equal(normalizarCodigoCupon("#"), null);
  assert.equal(normalizarCodigoCupon("a"), null);
  assert.equal(normalizarCodigoCupon("con ñ y símbolos!"), null);
  assert.equal(normalizarCodigoTipoViaje("Viaje de bodas / Unión civil"), "VIAJE_DE_BODAS_UNION_CIVIL");
});

test("descuento sobre el precio final se aplica a todas las personas", () => {
  const resultado = calcularDescuentos({ personas, adicionalesCentavos: 0, reglas: [reglaBase()] });
  assert.equal(resultado.total_antes, 160000);
  assert.equal(resultado.total_descuento, 16000);
  assert.equal(resultado.total_final, 144000);
  assert.equal(resultado.aplicados.length, 1);
  assert.equal(resultado.items[0].personas_alcanzadas, 2);
});

test("descuento sobre el precio de lista usa el precio original de la temporada", () => {
  const resultado = calcularDescuentos({
    personas,
    reglas: [reglaBase({ base_calculo: "PRECIO_LISTA", porcentaje: 20 })],
  });
  // 20% de (100.000 + 90.000) = 38.000
  assert.equal(resultado.total_descuento, 38000);
  assert.equal(resultado.total_final, 122000);
});

test("el descuento nunca supera lo que paga la persona ni deja la reserva en negativo", () => {
  const resultado = calcularDescuentos({
    personas: [{ tipo_persona_id: 1, edad: 40, final_centavos: 3_000_00, lista_centavos: 10_000_00 }],
    reglas: [reglaBase({ base_calculo: "PRECIO_LISTA", porcentaje: 80 })],
  });
  // 80% de 10.000 = 8.000, pero la persona paga 3.000: el tope es 3.000
  assert.equal(resultado.total_descuento, 3000);
  assert.equal(resultado.total_final, 0);
});

test("filtra por tipo de persona y rango de edad", () => {
  const soloJubilados = calcularDescuentos({
    personas,
    reglas: [reglaBase({ alcance_persona: "SELECCIONADAS", tipos_persona: [1], edad_minima: 60 })],
  });
  assert.equal(soloJubilados.items[0].personas_alcanzadas, 1);
  assert.equal(soloJubilados.total_descuento, 7000);

  const nadie = calcularDescuentos({
    personas,
    reglas: [reglaBase({ edad_minima: 80 })],
  });
  assert.equal(nadie.total_descuento, 0);
  assert.equal(nadie.aplicados.length, 0);
  assert.match(nadie.items[0].motivo_no_aplicado, /Ninguna persona/);
});

test("los adicionales entran en la base solo si la regla lo pide y no filtra personas", () => {
  const conAdicionales = calcularDescuentos({
    personas,
    adicionalesCentavos: 2_000_000,
    reglas: [reglaBase({ incluye_adicionales: 1 })],
  });
  assert.equal(conAdicionales.total_descuento, 18000);

  const filtrada = calcularDescuentos({
    personas,
    adicionalesCentavos: 2_000_000,
    reglas: [reglaBase({ incluye_adicionales: 1, edad_minima: 60 })],
  });
  assert.equal(filtrada.items[0].incluye_adicionales, false);
  assert.equal(filtrada.total_descuento, 7000);
});

test("cupón y tipo de viaje se suman si ambos son acumulables; si no, gana el mayor", () => {
  const cupon = reglaBase({ acumulable: 1, porcentaje: 10 });
  const tipoViaje = reglaBase({ id: 2, tipo: "TIPO_VIAJE", codigo: "BODAS", nombre: "Bodas", acumulable: 1, porcentaje: 25 });

  const acumulado = calcularDescuentos({ personas, reglas: [cupon, tipoViaje] });
  assert.equal(acumulado.aplicados.length, 2);
  assert.equal(acumulado.total_descuento, 16000 + 40000);

  const exclusivo = calcularDescuentos({ personas, reglas: [cupon, { ...tipoViaje, acumulable: 0 }] });
  assert.equal(exclusivo.aplicados.length, 1);
  assert.equal(exclusivo.aplicados[0].tipo, "TIPO_VIAJE");
  assert.equal(exclusivo.total_descuento, 40000);
  const descartado = exclusivo.items.find((item) => item.tipo === "CUPON");
  assert.equal(descartado.aplicado, false);
  assert.match(descartado.motivo_no_aplicado, /No es acumulable/);
});

test("la suma acumulada se recorta para no bajar de cero", () => {
  const resultado = calcularDescuentos({
    personas: [{ tipo_persona_id: 1, edad: 40, final_centavos: 10_000_00, lista_centavos: 10_000_00 }],
    reglas: [
      reglaBase({ acumulable: 1, porcentaje: 70 }),
      reglaBase({ id: 2, tipo: "TIPO_VIAJE", codigo: "X", nombre: "X", acumulable: 1, porcentaje: 50 }),
    ],
  });
  assert.equal(resultado.total_descuento, 10000);
  assert.equal(resultado.total_final, 0);
  assert.ok(resultado.aplicados.some((item) => item.recortado));
});

test("rechaza importes inválidos", () => {
  assert.throws(
    () => calcularDescuentos({ personas: [{ tipo_persona_id: 1, edad: 30, final_centavos: -5 }], reglas: [reglaBase()] }),
    /no es válido/
  );
});

test("una reserva Cancelada no consume cupos de uso ni suma en métricas", () => {
  const { ESTADOS_RESERVA_NO_CONSUMEN } = require("../api/services/descuentos-reserva");
  assert.ok(ESTADOS_RESERVA_NO_CONSUMEN.includes("Cancelada"));
  assert.ok(ESTADOS_RESERVA_NO_CONSUMEN.includes("Rechazada"));
});

test("el importe se arma persona por persona: el tope individual no se diluye en la suma", () => {
  // A paga 30 (lista 100): tope 30. B paga 100 (lista 100): 80. Total 110, no 130.
  const resultado = calcularDescuentos({
    personas: [
      { tipo_persona_id: 1, edad: 40, final_centavos: 3_000, lista_centavos: 10_000 },
      { tipo_persona_id: 3, edad: 40, final_centavos: 10_000, lista_centavos: 10_000 },
    ],
    reglas: [reglaBase({ base_calculo: "PRECIO_LISTA", porcentaje: 80 })],
  });
  assert.equal(resultado.total_descuento, 110);
  const detalle = resultado.items[0].detalle.personas.map((p) => p.descuento);
  assert.deepEqual(detalle, [30, 80]);
});
