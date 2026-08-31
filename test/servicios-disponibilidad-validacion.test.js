const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calcularDisponibilidadServicio,
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

test("una tarifa historica desligada respeta la audiencia departamental", async () => {
  const consultasLegacy = [];
  const connection = {
    async query(sql, params = []) {
      if (/SELECT id FROM recurso WHERE servicio_id/i.test(sql)) return [[{ id: 11 }]];
      if (/FROM tarifa\b/i.test(sql)) {
        consultasLegacy.push({ sql, params });
        assert.match(sql, /turismo_tarifa_regla_id IS NULL/);
        assert.match(sql, /COALESCE\(audiencia_departamental, 'TODAS'\) IN \('TODAS', \?\)/);
        const audiencia = params[1];
        return [[audiencia === "PROPIA" ? {
          recurso_id: 11,
          edad_minima: null,
          edad_maxima: null,
          fecha_inicio: "2099-01-01",
          fecha_fin: "2099-12-31",
        } : []].flat()];
      }
      if (/FROM recurso rr[\s\S]+turismo_tarifa_regla tr/i.test(sql)) return [[]];
      if (/FROM reserva\b/i.test(sql)) return [[]];
      if (/FROM turismo_reserva_hold\b/i.test(sql)) return [[]];
      if (/FROM bloque_fecha_recurso\b/i.test(sql)) return [[]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  const base = {
    servicioId: 5,
    tipoCodigo: "ALOJAMIENTO_RECURSO",
    modeloTarifa: "TEMPORADAS",
    maxPersonasReserva: 4,
    anticipacionMinimaDias: 0,
    propietarioDepartamentalId: 7,
    fechaInicio: "2099-01-10",
    fechaFin: "2099-01-12",
    adultos: 1,
    ninos: 0,
    bebes: 0,
    totalPersonas: 1,
  };

  const ajena = await calcularDisponibilidadServicio(connection, {
    ...base,
    departamentalId: 8,
  });
  const propia = await calcularDisponibilidadServicio(connection, {
    ...base,
    departamentalId: 7,
  });

  assert.equal(ajena.disponibles, 0);
  assert.equal(propia.disponibles, 1);
  assert.deepEqual(consultasLegacy.map(({ params }) => params[1]), ["OTRAS", "PROPIA"]);
});
