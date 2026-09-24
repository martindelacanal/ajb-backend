const test = require("node:test");
const assert = require("node:assert/strict");

const router = require("../api/routes/coseguro");
const {
  consultarSolicitudesParaExportar,
  filtrosEstadisticas,
  idsPositivosIguales,
  normalizarEnteroSeguro,
  normalizarIdPositivo,
  normalizarListaIdsPositivos,
  parsearCsvLiquidacion,
} = router.__test;

test("coseguro acepta solamente IDs enteros positivos estrictos", () => {
  assert.equal(normalizarIdPositivo(42), 42);
  assert.equal(normalizarIdPositivo("0042"), 42);

  for (const invalido of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "0",
    "-1",
    "1.5",
    "1e3",
    "NaN",
    "Infinity",
    "12abc",
    null,
    undefined,
    [42],
    { value: 42 },
  ]) {
    assert.equal(normalizarIdPositivo(invalido), null, String(invalido));
  }
});

test("coseguro valida paginación sin truncar ni aplicar coerciones", () => {
  assert.equal(normalizarEnteroSeguro("1", { minimo: 1 }), 1);
  assert.equal(normalizarEnteroSeguro(100, { minimo: 1, maximo: 100 }), 100);
  for (const invalido of ["1e2", "2.9", "Infinity", "NaN", 2.9, 101, [], null]) {
    assert.equal(normalizarEnteroSeguro(invalido, { minimo: 1, maximo: 100 }), null, String(invalido));
  }
});

test("coseguro rechaza la lista completa si contiene un ID inválido", () => {
  assert.deepEqual(normalizarListaIdsPositivos("1,002,2"), [1, 2]);
  assert.deepEqual(normalizarListaIdsPositivos([1, "2", "003"]), [1, 2, 3]);
  for (const invalida of [
    [],
    "1,",
    "1,2.5",
    "1,1e2",
    [1, null],
    [1, Number.NaN],
    [1, Number.POSITIVE_INFINITY],
    [1, {}],
  ]) {
    assert.equal(normalizarListaIdsPositivos(invalida), null, JSON.stringify(invalida));
  }
});

test("coseguro nunca considera iguales dos IDs nulos o inválidos", () => {
  assert.equal(idsPositivosIguales(7, "007"), true);
  assert.equal(idsPositivosIguales(null, null), false);
  assert.equal(idsPositivosIguales(undefined, undefined), false);
  assert.equal(idsPositivosIguales("1e2", 100), false);
  assert.equal(idsPositivosIguales(0, 0), false);
});

test("coseguro falla cerrado ante filtros numéricos, fechas o rangos inválidos", () => {
  const cabecera = { rol: "admin" };
  for (const query of [
    { departamental_id: "1e2" },
    { tipo_reintegro_id: "2.5" },
    { concepto_id: "NaN" },
    { usuario_id: "Infinity" },
    { fecha_desde: "31/12/2026" },
    { importe_min: "1e3" },
    { fecha_desde: "2026-12-02", fecha_hasta: "2026-12-01" },
    { importe_min: "10.00", importe_max: "9.99" },
  ]) {
    assert.throws(
      () => filtrosEstadisticas(cabecera, query),
      (error) => error.statusCode === 400,
      JSON.stringify(query)
    );
  }

  assert.deepEqual(
    filtrosEstadisticas(cabecera, {
      departamental_id: "7",
      usuario_id: "9",
      fecha_desde: "2026-01-01",
      fecha_hasta: "2026-01-31",
      importe_min: "10.00",
      importe_max: "20.00",
    }).params,
    [7, "2026-01-01", "2026-01-31", 9, 10, 20]
  );
});

test("coseguro exporta con el mismo filtro por fecha de solicitud que el listado", async () => {
  const consultas = [];
  const db = {
    query: async (sql, params) => {
      consultas.push({ sql, params });
      return [[]];
    },
  };
  const cabecera = { rol: "admin" };

  const filas = await consultarSolicitudesParaExportar(db, cabecera, {
    estado_id: [7],
    fecha_solicitud_desde: "2026-03-01",
    fecha_solicitud_hasta: "2026-03-31",
  });
  assert.deepEqual(filas, []);
  assert.equal(consultas.length, 1);
  const { sql, params } = consultas[0];
  assert.ok(sql.includes("DATE(s.fecha_creacion) >= ?"), sql);
  assert.ok(sql.includes("DATE(s.fecha_creacion) <= ?"), sql);
  // La fecha de solicitud no se confunde con la del comprobante
  assert.ok(!sql.includes("s.fecha_comprobante >=") && !sql.includes("s.fecha_comprobante <="), sql);
  assert.deepEqual(params, [7, "2026-03-01", "2026-03-31"]);

  for (const filtros of [
    { fecha_solicitud_desde: "31/03/2026" },
    { fecha_solicitud_hasta: "2026-02-30" },
    { fecha_solicitud_desde: "2026-03-31", fecha_solicitud_hasta: "2026-03-01" },
  ]) {
    await assert.rejects(
      consultarSolicitudesParaExportar(db, cabecera, filtros),
      (error) => error.statusCode === 400,
      JSON.stringify(filtros)
    );
  }
  assert.equal(consultas.length, 1);
});

test("coseguro no admite IDs decimales o exponenciales en el CSV", () => {
  const csv = Buffer.from([
    "ID;fecha_pago",
    "1e3;07/08/2026 10:00",
    "2.5;07/08/2026 10:00",
    "42;07/08/2026 10:00",
  ].join("\n"));
  const resultado = parsearCsvLiquidacion(csv);
  assert.deepEqual(resultado.items.map((item) => item.id), [42]);
  assert.equal(resultado.errores.length, 2);
});
