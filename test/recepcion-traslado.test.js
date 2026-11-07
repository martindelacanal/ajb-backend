"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cotizar } = require("../api/services/recepcion");

test("un traslado conserva los adicionales del tramo anterior y aplica el precio del recurso correspondiente", async () => {
  const consultas = [];
  const turismo = {
    calcularTarifaBaseReserva: async () => ({ personas: [] }),
    calcularAdicionalesReserva: async (_db, adicionales, recursoId, _regimen, inicio, fin) => {
      consultas.push({ recursoId, inicio, fin, adicionales });
      const dias = (Date.parse(fin) - Date.parse(inicio)) / 86_400_000;
      const items = adicionales.map(a => ({
        ...a, dias, subtotal: recursoId * a.cantidad * dias,
        subtotal_original: recursoId * a.cantidad * dias, detalles: [{ fecha: inicio }]
      }));
      return { items };
    }
  };
  const primerTramo = [{ adicional_id: 4, cantidad: 3 }, { adicional_id: 9, cantidad: 1 }];
  const segundoTramo = [{ adicional_id: 4, cantidad: 1 }];
  const { extras } = await cotizar(null, turismo, {
    tipo: "GENERAL", servicio: {}, inicio: "2026-11-01", fin: "2026-11-05",
    personas: [], adicionales: segundoTramo, recursoId: 12, regimenId: 3,
    tramos: [
      { desde: "2026-11-01", recurso_id: 11, adicionales: primerTramo },
      { desde: "2026-11-03", recurso_id: 12 }
    ]
  });
  assert.deepEqual(consultas, [
    {recursoId: 11, inicio: "2026-11-01", fin: "2026-11-03", adicionales: primerTramo},
    {recursoId: 12, inicio: "2026-11-03", fin: "2026-11-05", adicionales: segundoTramo}
  ]);
  assert.equal(extras.total, 112); // 2 × (3 + 1) × $11, luego 2 × $12.
  assert.deepEqual(extras.items.map(a => [a.adicional_id, a.dias, a.subtotal]), [[4, 4, 90], [9, 2, 22]]);
});

test("una reserva cotiza una cabaña y conserva el cargo de sus adicionales", async () => {
  const dias = ["2026-11-01", "2026-11-02"];
  const precios = { 11: 18000, 12: 22000 };
  const turismo = {
    calcularTarifaBaseReserva: async (_c, { recursoId, personas }) => ({
      personas: personas.map(p => ({ ...p, tarifas_por_fecha: dias.map(fecha => ({ fecha, precio: precios[recursoId] })) }))
    }),
    calcularAdicionalesReserva: async () => ({ items: [{ adicional_id: 6, cantidad: 1, dias: 2, subtotal: 2000 }] })
  };
  const r = await cotizar(null, turismo, {
    tipo: "GENERAL", servicio: { modelo_tarifa: "PRECIO_UNICO" },
    inicio: dias[0], fin: "2026-11-03", personas: [{ dni: "10555000" }], adicionales: [{ adicional_id: 6, cantidad: 1 }], recursoId: 11,
    recursos: [{ id: 11, cupo_maximo: 2 }], tramos: []
  });
  assert.equal(r.total, 36000);
  assert.equal(r.extras.total, 2000);
  assert.equal(r.personas.length, 1);
  assert.equal(r.personas[0].tarifa_individual, 36000);
  assert.deepEqual(r.personas[0].tarifas_por_fecha.map(n => n.recurso_id), [11, 11]);
});

test("las tarifas por persona del recurso respetan la salida efectiva de cada viajero", async () => {
  const turismo = {
    calcularTarifaBaseReserva: async (_c, { recursoId, personas }) => ({
      personas: personas.map(p => ({ ...p, tarifas_por_fecha: ["2026-11-01", "2026-11-02"].map(fecha => (
        { fecha, precio: recursoId === 1 ? 12000 : 10000, por_persona: true }
      )) }))
    }),
    calcularAdicionalesReserva: async () => ({ items: [] })
  };
  const r = await cotizar(null, turismo, {
    tipo: "GENERAL", servicio: {}, inicio: "2026-11-01", fin: "2026-11-03",
    personas: [{ dni: "1" }, { dni: "2", salida: "2026-11-02" }, { dni: "3" }],
    adicionales: [], recursoId: 1, recursos: [{ id: 1, cupo_maximo: 3 }], tramos: []
  });
  assert.equal(r.total, 60000);
  assert.deepEqual(r.personas.map(p => p.tarifa_individual), [24000, 12000, 24000]);
});

test("cotizar rechaza varios recursos antes de calcular tarifas o alquileres", async () => {
  await assert.rejects(cotizar(null, {}, {
    recursos: [{ id: 11 }, { id: 12 }]
  }), /Cada reserva admite un solo recurso/);
});
