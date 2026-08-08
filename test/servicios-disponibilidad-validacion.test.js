const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parsearParametrosBusquedaDisponibilidad,
  parsearServicioIdsCsv,
} = require("../api/services/servicios-disponibilidad");

test("los IDs de servicio se aceptan solo si son enteros positivos completos", () => {
  assert.deepEqual(parsearServicioIdsCsv(["1", "2x", "3.5", 4, 0, -1]), [1, 4]);
  assert.deepEqual(parsearServicioIdsCsv("1,02,3e2,4"), [1, 2, 4]);
});

test("la busqueda rechaza cantidades no enteras o excesivas", () => {
  const base = { fecha_inicio: "2040-08-10", fecha_fin: "2040-08-12", adultos: 1 };
  const opciones = { hoy: "2040-08-01" };
  assert.ok(parsearParametrosBusquedaDisponibilidad({ ...base, adultos: "1e2" }, opciones).error);
  assert.ok(parsearParametrosBusquedaDisponibilidad({ ...base, adultos: 101 }, opciones).error);
  assert.equal(parsearParametrosBusquedaDisponibilidad(base, opciones).value.total_personas, 1);
});

test("la busqueda usa fechas civiles validas y limita el horizonte", () => {
  const personas = { adultos: 1, ninos: 0, bebes: 0 };
  assert.ok(parsearParametrosBusquedaDisponibilidad({
    ...personas,
    fecha_inicio: "2040-02-30",
    fecha_fin: "2040-03-02",
  }, { hoy: "2040-01-01" }).error);
  assert.ok(parsearParametrosBusquedaDisponibilidad({
    ...personas,
    fecha_inicio: "2040-01-01",
    fecha_fin: "2041-01-03",
  }, { hoy: "2040-01-01" }).error);
});

test("la busqueda rechaza inicios anteriores al hoy civil inyectado", () => {
  const personas = { adultos: 1, ninos: 0, bebes: 0 };
  assert.match(parsearParametrosBusquedaDisponibilidad({
    ...personas,
    fecha_inicio: "2040-04-30",
    fecha_fin: "2040-05-02",
  }, { hoy: "2040-05-01" }).error, /anterior a hoy/);
  assert.ok(parsearParametrosBusquedaDisponibilidad({
    ...personas,
    fecha_inicio: "2040-05-01",
    fecha_fin: "2040-05-02",
  }, { hoy: "2040-05-01" }).value);
});
