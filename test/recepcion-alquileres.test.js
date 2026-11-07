"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { seleccionArticulos, cotizarAlquileres } = require("../api/services/recepcion-alquileres");

const estadia = {
  inicio: "2026-11-01", fin: "2026-11-06", tipo: "GENERAL", recursoId: 12, regimenId: 3,
  personas: [{ salida: "2026-11-03" }, { salida: "2026-11-04" }]
};
const uso = { adicional_id: 4, cantidad: 2, fecha_desde: "2026-11-03", fecha_hasta: "2026-11-06" };

test("la última salida corta los alquileres y quita los futuros, sin cortar los de un grupo aún presente", () => {
  const futuro = { ...uso, adicional_id: 7, fecha_desde: "2026-11-05" };
  const cerrados = seleccionArticulos([uso, futuro], estadia);
  assert.equal(cerrados.length, 1);
  assert.equal(cerrados[0].fecha_hasta, "2026-11-04");
  const abiertos = seleccionArticulos([uso, futuro], { ...estadia, personas: [{ salida: "2026-11-03" }, { entrada: "2026-11-01" }] });
  assert.equal(abiertos.length, 2);
  assert.equal(abiertos[0].fecha_hasta, "2026-11-06");
  assert.throws(() => seleccionArticulos([{ ...uso, fecha_hasta: "2026-11-02" }], estadia), /alquiler/);
  assert.throws(() => seleccionArticulos([{ ...uso, cantidad: 1.5 }], estadia), /cantidad/);
});

test("conserva el precio aceptado al cambiar la cantidad y cotiza el nuevo día inclusive en el recurso original", async () => {
  const anterior = { ...uso, recurso_tarifa_id: 11, regimen_tarifa_id: 2 };
  const seleccion = seleccionArticulos([uso], { ...estadia, anteriores: [anterior] });
  const llamadas = [];
  const T = { calcularAdicionalesReserva: async (_db, [item], recurso, regimen, desde, fin) => {
    llamadas.push([recurso, regimen, desde, fin]);
    return { items: [{ nombre_adicional: "Silla", detalles: [{ fecha: desde, cantidad: item.cantidad, precio_unitario: 150, subtotal: 300 }] }] };
  } };
  const [item] = await cotizarAlquileres(null, T, seleccion, [], null, [
    { adicional_id: 4, nombre_adicional: "Silla", fecha: "2026-11-03", precio_unitario: 100.75, tarifa_adicional_id: 3 }
  ]);
  assert.deepEqual(llamadas, [[11, 2, "2026-11-04", "2026-11-05"]]);
  assert.equal(item.dias, 2);
  assert.equal(item.subtotal, 501.5);
  assert.equal(item.detalles[0].tarifa_adicional_id, 3);
});
