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
