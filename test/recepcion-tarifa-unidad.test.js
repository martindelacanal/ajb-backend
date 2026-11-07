"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Se usa la cotización real de Turismo y recepción, con datos de tarifa acotados.
const filename = require.resolve("../api/connection/connection");
require.cache[filename] = { id: filename, filename, loaded: true, exports: { promise: () => ({}) } };
const turismo = require("../api/routes/user").negocioRecepcion;
const { cotizar } = require("../api/services/recepcion");

const persona = {
  dni: "99067310", nombre: "Mila", apellido: "Demo", tipo_persona_id: 4,
  regimen_id: 3, fecha_nacimiento: "1990-01-01", entrada: "2026-11-05", salida: "2026-11-07"
};

function datosTarifa(recursoId, precio, unidad, porPersona, gestionada) {
  return { query: async sql => {
    if (sql.includes("FROM recurso r INNER JOIN servicio")) return [[{
      id: recursoId, servicio_id: 10, modelo_tarifa: "TEMPORADAS", unidad_cobro: unidad,
      anticipacion_minima_dias: 0
    }]];
    if (sql.includes("FROM turismo_tarifa_regla")) return [gestionada ? [{
      id: 1, recurso_id: recursoId, tarifa_id: recursoId + 100, precio, precio_por_persona: porPersona === "Y" ? 1 : 0,
      audiencia_departamental: "TODAS", fecha_inicio: "2026-01-01", fecha_fin: "2026-12-31"
    }] : []];
    if (sql.includes("FROM tarifa")) {
      assert.match(sql, /SELECT[^;]+precio_por_persona\s+FROM tarifa/);
      return [[{
        id: recursoId + 100, precio, fecha_inicio: "2026-01-01", fecha_fin: "2026-12-31",
        usa_porcentaje: 0, porcentaje_descuento: 0, precio_por_persona: porPersona
      }]];
    }
    throw new Error("Consulta inesperada: " + sql);
  } };
}

async function cotizacion(recursoId, precio, unidad, porPersona, personas = [persona], gestionada = false) {
  return cotizar(datosTarifa(recursoId, precio, unidad, porPersona, gestionada), turismo, {
    tipo: "GENERAL", servicio: { modelo_tarifa: "TEMPORADAS", unidad_cobro: unidad },
    recursoId, regimenId: 3, personas, inicio: "2026-11-05", fin: "2026-11-10",
    adicionales: [], tramos: []
  });
}

test("la tarifa por cabaña conserva sus noches al moverla a un servicio cuyo valor general es por persona", async () => {
  for (const [recursoId, precio] of [[86, 18000], [87, 20000], [88, 22000]]) {
    for (const unidad of ["POR_RECURSO_NOCHE", "POR_PERSONA_NOCHE"]) {
      const r = await cotizacion(recursoId, precio, unidad, "N");
      assert.equal(r.total, precio * 5);
      assert.equal(r.personas[0].tarifas_por_fecha.length, 5);
      assert.ok(r.personas[0].tarifas_por_fecha.every(t => t.por_persona === false));
    }
  }
});

test("una tarifa efectivamente por persona sigue recortando las noches a su salida", async () => {
  const r = await cotizacion(86, 18000, "POR_PERSONA_NOCHE", "Y");
  assert.equal(r.total, 36000);
  assert.equal(r.personas[0].tarifas_por_fecha.length, 2);
  assert.ok(r.personas[0].tarifas_por_fecha.every(t => t.por_persona === true));
});

test("el período previsto es individual y una noche adicional compartida se asigna a quien permanece", async () => {
  const personas = [
    { ...persona, salida: null, salida_prevista: "2026-11-07" },
    { ...persona, dni: "99067311", salida: "2026-11-09", salida_prevista: "2026-11-07" }
  ];
  const personal = await cotizacion(86, 18000, "POR_PERSONA_NOCHE", "Y", personas);
  assert.deepEqual(personal.personas.map(p => p.tarifa_individual), [36000, 72000]);
  const compartida = await cotizacion(86, 18000, "POR_RECURSO_NOCHE", "N", personas, true);
  assert.equal(compartida.total, 90000);
  assert.deepEqual(compartida.personas.map(p => p.peso_alojamiento), [27000, 63000]);
});
