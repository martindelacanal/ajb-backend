"use strict";

// Descuento de los adicionales de turismo: el mayor % de las personas de la
// reserva SIN contar a los menores de 2 años (tipo 5, tarifa al 100%).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  TIPO_PERSONA_MENOR_2,
  elegirMayorDescuentoTarifas,
  esMenorDe2,
  obtenerMejorDescuentoAdicionalesDia,
  personasParaDescuentoAdicionales,
} = require("../api/services/descuento-adicionales");

const AFILIADO = 1;
const INVITADO_FAMILIAR = 2;
const INVITADO_GENERAL = 3;

// Tarifas vigentes por tipo de persona para la noche consultada.
const TARIFAS_POR_TIPO = {
  [AFILIADO]: { id: 512, usa_porcentaje: 1, porcentaje_descuento: "35.00" },
  [INVITADO_FAMILIAR]: { id: 513, usa_porcentaje: 1, porcentaje_descuento: "20.00" },
  [INVITADO_GENERAL]: { id: 514, usa_porcentaje: 0, porcentaje_descuento: "0.00" },
  [TIPO_PERSONA_MENOR_2]: { id: 516, usa_porcentaje: 1, porcentaje_descuento: "100.00" },
};

function conexionFalsa(tarifas = TARIFAS_POR_TIPO) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      assert.match(sql, /FROM tarifa/);
      const tipo = Number(params[1]);
      consultas.push(tipo);
      return [tarifas[tipo] ? [tarifas[tipo]] : []];
    },
  };
}

const persona = (tipo, edad) => ({ tipo_persona_id: tipo, edad });
const noche = (connection, personas) => obtenerMejorDescuentoAdicionalesDia(connection, {
  recursoId: 2,
  regimenId: 3,
  personas,
  fecha: "2026-10-14",
});

test("un afiliado al 35% con un bebe al 100%: los adicionales llevan 35%", async () => {
  const connection = conexionFalsa();
  const resultado = await noche(connection, [persona(AFILIADO, 36), persona(TIPO_PERSONA_MENOR_2, 1)]);
  assert.deepEqual(resultado, { porcentaje_descuento: 35, porcentaje_puntos_base: 3500, tarifa_id: 512 });
  // La tarifa del bebe ni siquiera se consulta.
  assert.deepEqual(connection.consultas, [AFILIADO]);
});

test("toma el siguiente mayor descuento entre el resto de las personas", async () => {
  const resultado = await noche(conexionFalsa(), [
    persona(TIPO_PERSONA_MENOR_2, 0),
    persona(INVITADO_FAMILIAR, 54),
    persona(AFILIADO, 36),
  ]);
  assert.equal(resultado.porcentaje_puntos_base, 3500);
  assert.equal(resultado.tarifa_id, 512);
});

test("solo invitados generales (0%) con un bebe: los adicionales no tienen descuento", async () => {
  const resultado = await noche(conexionFalsa(), [
    persona(INVITADO_GENERAL, 40),
    persona(INVITADO_GENERAL, 38),
    persona(TIPO_PERSONA_MENOR_2, 1),
  ]);
  assert.deepEqual(resultado, { porcentaje_descuento: 0, porcentaje_puntos_base: 0, tarifa_id: null });
});

test("una reserva que solo tiene bebes no hereda el 100%", async () => {
  const connection = conexionFalsa();
  const resultado = await noche(connection, [persona(TIPO_PERSONA_MENOR_2, 1)]);
  assert.deepEqual(resultado, { porcentaje_descuento: 0, porcentaje_puntos_base: 0, tarifa_id: null });
  assert.deepEqual(connection.consultas, []);
});

test("sin bebes el resultado es el de siempre: el mayor % y el empate conserva a la primera persona", async () => {
  const resultado = await noche(conexionFalsa(), [persona(INVITADO_FAMILIAR, 54), persona(AFILIADO, 36)]);
  assert.deepEqual(resultado, { porcentaje_descuento: 35, porcentaje_puntos_base: 3500, tarifa_id: 512 });

  const empate = elegirMayorDescuentoTarifas([
    { id: 7, usa_porcentaje: true, porcentaje_descuento: 25 },
    { id: 8, usa_porcentaje: "1", porcentaje_descuento: "25.00" },
  ]);
  assert.equal(empate.tarifa_id, 7);

  // Una tarifa de otra persona al 100% (que no es bebe) sigue valiendo.
  const cortesia = await noche(
    conexionFalsa({ ...TARIFAS_POR_TIPO, [INVITADO_FAMILIAR]: { id: 600, usa_porcentaje: 1, porcentaje_descuento: 100 } }),
    [persona(AFILIADO, 36), persona(INVITADO_FAMILIAR, 54)]
  );
  assert.equal(cortesia.porcentaje_puntos_base, 10000);
  assert.equal(cortesia.tarifa_id, 600);
});

test("ignora personas sin tipo o sin edad y tarifas sin porcentaje", async () => {
  const connection = conexionFalsa();
  const resultado = await noche(connection, [{ edad: 30 }, { tipo_persona_id: AFILIADO }, persona(INVITADO_GENERAL, 30)]);
  assert.equal(resultado.porcentaje_puntos_base, 0);
  assert.deepEqual(connection.consultas, [INVITADO_GENERAL]);
  assert.deepEqual(
    elegirMayorDescuentoTarifas([{ id: 1, usa_porcentaje: 0, porcentaje_descuento: 90 }, null]),
    { porcentaje_descuento: 0, porcentaje_puntos_base: 0, tarifa_id: null }
  );
});

test("mantiene los errores de tarifa ambigua o porcentaje invalido", async () => {
  const ambigua = {
    async query() {
      return [[{ id: 1, usa_porcentaje: 1, porcentaje_descuento: 10 }, { id: 2, usa_porcentaje: 1, porcentaje_descuento: 20 }]];
    },
  };
  await assert.rejects(noche(ambigua, [persona(AFILIADO, 36)]), (error) => {
    assert.equal(error.codigo, "TARIFA_AMBIGUA");
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.throws(
    () => elegirMayorDescuentoTarifas([{ id: 1, usa_porcentaje: 1, porcentaje_descuento: "abc" }], { fecha: "2026-10-14" }),
    (error) => error.codigo === "TARIFA_INVALIDA" && /2026-10-14/.test(error.message)
  );
});

test("identifica a los menores de 2 años por tipo de persona", () => {
  assert.equal(TIPO_PERSONA_MENOR_2, 5);
  assert.equal(esMenorDe2({ tipo_persona_id: 5 }), true);
  assert.equal(esMenorDe2({ tipo_persona_id: "5" }), true);
  assert.equal(esMenorDe2({ tipo_persona_id: 1 }), false);
  assert.equal(esMenorDe2(null), false);
  assert.deepEqual(
    personasParaDescuentoAdicionales([persona(1, 30), persona(5, 1), persona(3, 20)]).map((p) => p.tipo_persona_id),
    [1, 3]
  );
  assert.deepEqual(personasParaDescuentoAdicionales(undefined), []);
});

test("la cotizacion de adicionales de user.js delega en el servicio", () => {
  const fuente = fs.readFileSync(path.resolve(__dirname, "../api/routes/user.js"), "utf8");
  assert.match(fuente, /require\("\.\.\/services\/descuento-adicionales"\)/);
  const inicio = fuente.indexOf("function obtenerMejorDescuentoDia(");
  assert.ok(inicio > 0);
  const cuerpo = fuente.slice(inicio, fuente.indexOf("\n}\n", inicio));
  assert.match(cuerpo, /obtenerMejorDescuentoAdicionalesDia\(connection/);
  assert.doesNotMatch(cuerpo, /FROM tarifa/);
});
