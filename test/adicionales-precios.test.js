"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../api/services/adicionales-precios");

// Dos servicios del predio: Cabañas (recursos 1 y 2) y Camping (recurso 3), todos con régimen 3.
const destinos = [
  { servicio_id: 10, recurso_id: 1, regimen_id: 3 },
  { servicio_id: 10, recurso_id: 2, regimen_id: 3 },
  { servicio_id: 20, recurso_id: 3, regimen_id: 3 },
];
const regla = (x) => ({ clave: x.clave ?? 0, adicional_id: 7, servicio_id: null, recurso_id: null, regimen_id: null, precio: 1000, ...x });

test("un precio para todos los servicios se materializa en cada recurso y régimen", () => {
  const { filas, conflictos } = P.resolver([regla({ fecha_inicio: "2026-12-01", fecha_fin: "2027-03-01" })], destinos);
  assert.equal(conflictos.length, 0);
  assert.deepEqual(filas.map(f => [f.recurso_id, f.fecha_inicio, f.fecha_fin, f.precio]), [
    [1, "2026-12-01", "2027-03-01", 1000], [2, "2026-12-01", "2027-03-01", 1000], [3, "2026-12-01", "2027-03-01", 1000],
  ]);
});

test("el precio de un recurso reemplaza al general sólo en sus fechas", () => {
  const { filas, conflictos } = P.resolver([
    regla({ clave: 0, fecha_inicio: "2026-12-01", fecha_fin: "2026-12-31" }),
    regla({ clave: 1, servicio_id: 10, recurso_id: 2, fecha_inicio: "2026-12-10", fecha_fin: "2026-12-20", precio: 1500 }),
    regla({ clave: 2, servicio_id: 20, fecha_inicio: "2026-12-01", fecha_fin: "2026-12-31", precio: 800 }),
  ], destinos);
  assert.equal(conflictos.length, 0);
  const del2 = filas.filter(f => f.recurso_id === 2).map(f => [f.fecha_inicio, f.fecha_fin, f.precio]);
  assert.deepEqual(del2, [["2026-12-01", "2026-12-09", 1000], ["2026-12-10", "2026-12-20", 1500], ["2026-12-21", "2026-12-31", 1000]]);
  assert.deepEqual(filas.filter(f => f.recurso_id === 3).map(f => f.precio), [800]);
});

test("dos precios igual de particulares el mismo día son un conflicto", () => {
  const { conflictos } = P.resolver([
    regla({ clave: 0, fecha_inicio: "2026-12-01", fecha_fin: "2026-12-15" }),
    regla({ clave: 1, fecha_inicio: "2026-12-10", fecha_fin: "2026-12-31", precio: 2000 }),
  ], destinos);
  assert.equal(conflictos.length, 3);
  assert.deepEqual([conflictos[0].desde, conflictos[0].hasta, conflictos[0].reglas], ["2026-12-10", "2026-12-15", [0, 1]]);
});

test("en una temporada las filas se recortan y se parten en los tramos de tarifa", () => {
  const conRangos = [{ servicio_id: 10, recurso_id: 1, regimen_id: 3, rangos: [
    { desde: "2026-12-15", hasta: "2027-01-01" }, { desde: "2027-01-02", hasta: "2027-01-31" }, { desde: "2027-02-10", hasta: "2027-03-07" },
  ] }];
  const { filas } = P.resolver([regla({ fecha_inicio: "2026-12-01", fecha_fin: "2027-03-31" })], conRangos);
  assert.deepEqual(filas.map(f => [f.fecha_inicio, f.fecha_fin]), [
    ["2026-12-15", "2027-01-01"], ["2027-01-02", "2027-01-31"], ["2027-02-10", "2027-03-07"],
  ]);
});

test("las filas por recurso cargadas antes se agrupan en pocas reglas", () => {
  const filas = [];
  for (const recurso_id of [1, 2, 3]) {
    filas.push({ adicional_id: 7, recurso_id, regimen_id: 3, fecha_inicio: "2026-09-08", fecha_fin: "2026-12-14", precio: "5000.00" });
    filas.push({ adicional_id: 7, recurso_id, regimen_id: 3, fecha_inicio: "2026-12-15", fecha_fin: "2027-01-01", precio: "6500.00" });
    filas.push({ adicional_id: 7, recurso_id, regimen_id: 3, fecha_inicio: "2027-01-02", fecha_fin: "2027-03-07", precio: recurso_id === 3 ? "6000.00" : "6500.00" });
  }
  const reglas = P.inferirReglas(filas, destinos);
  assert.deepEqual(reglas.map(r => [r.servicio_id, r.recurso_id, r.fecha_inicio, r.fecha_fin, r.precio]), [
    [null, null, "2026-09-08", "2026-12-14", 5000],
    [null, null, "2026-12-15", "2027-01-01", 6500],
    [10, null, "2026-12-15", "2027-03-07", 6500],
    [20, null, "2027-01-02", "2027-03-07", 6000],
  ]);
  // Volver a materializar las reglas reproduce los mismos precios por día.
  const { filas: otra, conflictos } = P.resolver(reglas.map((r, i) => ({ ...r, clave: i })), destinos);
  assert.equal(conflictos.length, 0);
  const precio = (rs, recurso, dia) => rs.find(f => Number(f.recurso_id) === recurso && f.fecha_inicio <= dia && f.fecha_fin >= dia)?.precio;
  for (const [recurso, dia] of [[1, "2026-10-01"], [2, "2026-12-31"], [3, "2027-01-10"], [1, "2027-03-07"]]) {
    assert.equal(Number(precio(otra, recurso, dia)), Number(precio(filas, recurso, dia)));
  }
});

test("las reglas de una pantalla se validan contra los recursos del ámbito", () => {
  const [r] = P.normalizarReglas([{ recurso_id: 2, fecha_desde: "2026-12-01", fecha_hasta: "2026-12-02", precio: "1.500,5".replace(".", "").replace(",", ".") }],
    { destinos, adicionalId: 7 });
  assert.deepEqual([r.servicio_id, r.recurso_id, r.precio], [10, 2, 1500.5]);
  assert.throws(() => P.normalizarReglas([{ recurso_id: 99, fecha_desde: "2026-12-01", fecha_hasta: "2026-12-02", precio: 1 }], { destinos, adicionalId: 7 }), /recurso/);
  assert.throws(() => P.normalizarReglas([{ servicio_id: 20, recurso_id: 1, fecha_desde: "2026-12-01", fecha_hasta: "2026-12-02", precio: 1 }], { destinos, adicionalId: 7 }), /no pertenece/);
  assert.throws(() => P.normalizarReglas([{ fecha_desde: "2026-12-05", fecha_hasta: "2026-12-02", precio: 1 }], { destinos, adicionalId: 7 }), /anterior/);
  assert.throws(() => P.normalizarReglas([{ regimen_id: 1, fecha_desde: "2026-12-01", fecha_hasta: "2026-12-02", precio: 1 }], { destinos, adicionalId: 7 }), /régimen/);
});
