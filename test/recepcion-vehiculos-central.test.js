"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../api/services/recepcion-vehiculos");
const { resumenCambios } = require("../api/services/recepcion");

const HOY = "2026-11-07";
const base = { inicio: "2026-11-03", fin: "2026-11-10", hoy: HOY };
const grupo = [{ dni: "1", entrada: "2026-11-03", salida: null }];

test("vehículos: patente normalizada, sector opcional y validaciones", () => {
  const [v] = V.normalizarVehiculos([{ patente: " ab 123-cd ", marca: "Fiat", color: "Gris" }], [], { ...base, personas: grupo });
  assert.deepEqual(v, { patente: "AB123CD", marca: "Fiat", color: "Gris", sector: null, entrada: "2026-11-03", salida: null });
  assert.deepEqual(V.normalizarVehiculos([{ patente: "", marca: "", color: "", sector: "" }], [], { ...base, personas: [] }), []);
  assert.throws(() => V.normalizarVehiculos([{ patente: "AB123CD", marca: "Fiat" }], [], base), /patente, marca y color/);
  assert.throws(() => V.normalizarVehiculos([{ patente: "AB123CD", marca: "a", color: "b" }, { patente: "ab123cd", marca: "c", color: "d" }], [], base), /repetida/);
  assert.throws(() => V.normalizarVehiculos([{ patente: "AB123CD", marca: "a", color: "b", entrada: "2026-11-08" }], [], base), /no ser futuro/);
  assert.throws(() => V.normalizarVehiculos([{ patente: "AB123CD", marca: "a", color: "b", entrada: "2026-11-05", salida: "2026-11-04" }], [], base), /seguir al ingreso/);
});

test("vehículos: lo que ingresó no se borra (salvo error del mismo día) y la salida no se deshace", () => {
  const anterior = [{ patente: "AB123CD", marca: "Fiat", color: "Gris", sector: "A", entrada: "2026-11-04", salida: null }];
  assert.throws(() => V.normalizarVehiculos([], anterior, { ...base, personas: grupo }), /registrá su salida/);
  const hoy = [{ ...anterior[0], entrada: HOY }];
  assert.deepEqual(V.normalizarVehiculos([], hoy, { ...base, personas: grupo }), []);
  const salio = [{ ...anterior[0], salida: "2026-11-06" }];
  assert.throws(() => V.normalizarVehiculos([{ ...salio[0], salida: null }], salio, { ...base, personas: grupo }), /no borrarla/);
  // Antes de que ingrese nadie, un vehículo cargado por error se puede quitar.
  assert.deepEqual(V.normalizarVehiculos([], [{ ...anterior[0], entrada: null }], { ...base, personas: [] }), []);
  // El vehículo único del formato anterior, con el grupo adentro, cuenta como ingresado.
  assert.throws(() => V.normalizarVehiculos([], [{ ...anterior[0], entrada: null }], { ...base, personas: grupo, ingresoAnterior: true }), /registrá su salida/);
});

test("vehículos: el formato anterior se lee como una lista y la presencia depende del grupo", () => {
  const viejo = { vehiculo: { marca: "Ford", color: "Rojo", patente: "AA111AA", sector: "B" }, personas: grupo };
  assert.deepEqual(V.vehiculosDe(viejo, "2026-11-05"), [{ patente: "AA111AA", marca: "Ford", color: "Rojo", sector: "B", entrada: null, salida: "2026-11-05" }]);
  assert.deepEqual(V.vehiculosDe({ vehiculo: { patente: "" } }), []);
  const [v] = V.vehiculosDe(viejo);
  assert.equal(V.vehiculoPresente(v, viejo, HOY), true);
  assert.equal(V.vehiculoPresente({ ...v, salida: HOY }, viejo, HOY), false);
  assert.equal(V.vehiculoPresente(v, { personas: [{ entrada: "2026-11-03", salida: "2026-11-06" }] }, HOY), false);
});

test("historial: vehículos y ubicación se registran como cambios legibles", () => {
  const antes = { recurso_id: 1, tramos: [], personas: [], adicionales: [], vehiculo: { marca: "Ford", color: "Rojo", patente: "AA111AA", sector: "" } };
  const despues = { recurso_id: 1, tramos: [], personas: [], adicionales: [], ubicacion: "Bajo los pinos", vehiculos: [
    { patente: "AA111AA", marca: "Ford", color: "Rojo", sector: null, entrada: null, salida: "2026-11-06" },
    { patente: "BB222BB", marca: "VW", color: "Azul", sector: "C", entrada: "2026-11-06", salida: null }
  ] };
  const cambios = resumenCambios(antes, despues);
  assert.deepEqual(cambios.filter(c => c[0] === "Vehículo").map(c => c[2]), [
    "AA111AA · Ford Rojo · sin ingreso / 2026-11-06",
    "BB222BB · VW Azul · Sector C · 2026-11-06 / sin salida"
  ]);
  assert.deepEqual(cambios.find(c => c[0] === "Ubicación"), ["Ubicación", null, "Bajo los pinos"]);
  assert.deepEqual(resumenCambios(despues, { ...despues }), []);
});
