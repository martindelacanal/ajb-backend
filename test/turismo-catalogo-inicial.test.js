"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const catalogo = require("../api/data/turismo-catalogo-inicial");

function servicio(codigo) {
  return catalogo.SERVICIOS.find((item) => item.codigo === codigo);
}

function nombres(items) {
  return items.map((item) => item.nombre).sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
}

test("el manifiesto inicial valida los 69 recursos pedidos mas Camping", () => {
  assert.deepEqual(catalogo.validarCatalogoInicial(), {
    servicios: 4,
    recursos: 70,
    activos: 59,
    inactivos: 11,
    filtros: 19,
  });
  assert.deepEqual(catalogo.RESUMEN_ESPERADO.porServicio, {
    PARADOR_MONTANA: { total: 30, activos: 29, inactivos: 1 },
    HOTEL_SOLIS: { total: 14, activos: 11, inactivos: 3 },
    MIRAMAR_CABANAS: { total: 25, activos: 18, inactivos: 7 },
    MIRAMAR_CAMPING: { total: 1, activos: 1, inactivos: 0 },
  });
});

test("servicios y recursos visibles conservan nombres castellanos exactos", () => {
  assert.deepEqual(catalogo.SERVICIOS.map((item) => item.nombre), [
    "Parador de la Montaña",
    "Hotel Solís",
    "Miramar Cabañas",
    "Camping",
  ]);
  const parador = servicio("PARADOR_MONTANA");
  assert.equal(parador.lugar, "Córdoba");
  assert.ok(parador.recursos.some((item) => item.nombre === "Habitación 1 A"));
  assert.ok(parador.recursos.some((item) => item.nombre === "Cabaña 28"));
  assert.ok(parador.recursos.some((item) => item.descripcion.includes("Detrás del cuerpo")));
  assert.ok(servicio("MIRAMAR_CABANAS").recursos.some((item) => item.nombre === "Cabaña Nro 11 - Nueva"));
  for (const recurso of catalogo.SERVICIOS.flatMap((item) => item.recursos)) {
    assert.doesNotMatch(recurso.descripcion, /\b(?:bano|banos|cabana|cabanas)\b/i, recurso.codigo);
  }
});

test("las listas activa e inactiva son exactamente las solicitadas", () => {
  const parador = servicio("PARADOR_MONTANA");
  assert.deepEqual(nombres(parador.recursos.filter((item) => !item.activo)), ["Casa Samai"]);

  const miramar = servicio("MIRAMAR_CABANAS");
  assert.deepEqual(nombres(miramar.recursos.filter((item) => !item.activo)), nombres([
    ...[6, 7, 8, 9, 10].map((numero) => ({ nombre: `Cabaña Nro ${numero}` })),
    { nombre: "Cabaña Nro 14 Especial" },
    { nombre: "Dormi 11" },
  ]));

  const solis = servicio("HOTEL_SOLIS");
  assert.deepEqual(nombres(solis.recursos.filter((item) => !item.activo)), nombres([
    { nombre: "Habitación 2" },
    { nombre: "Habitación 3" },
    { nombre: "Habitación 14" },
  ]));
});

test("preserva IDs legacy y las tres anomalías literales sin inferencias", () => {
  const legacy = catalogo.SERVICIOS.flatMap((item) => item.recursos)
    .filter((item) => item.legacyId)
    .sort((a, b) => a.legacyId - b.legacyId);
  assert.deepEqual(legacy.map((item) => [item.legacyId, item.codigo]), [
    [1, "CAMP-PARCELA"],
    [2, "MIR-CAB-012-NUEVA"],
    [3, "MIR-CAB-011-NUEVA"],
  ]);
  assert.equal(legacy[0].esRecursoPrincipal, 1);
  assert.equal(legacy[0].cupoMaximo, null);
  const parador = servicio("PARADOR_MONTANA");
  assert.deepEqual(parador.recursos.find((item) => item.codigo === "PAR-HAB-001-A").valores, { PERSONAS: 2 });
  assert.equal(parador.recursos.find((item) => item.codigo === "PAR-DEP-017").valores.TIPO_UNIDAD, "Cabaña");
  assert.equal(Object.hasOwn(servicio("MIRAMAR_CABANAS").recursos.find((item) => item.codigo === "MIR-DORMI-011").valores, "SIN_BANO"), false);
});

test("cada característica usa un filtro tipado y las ausentes siguen ausentes", () => {
  const filtros = new Map(catalogo.FILTROS.map((item) => [item.codigo, item]));
  for (const recurso of catalogo.SERVICIOS.flatMap((item) => item.recursos)) {
    for (const [codigo, valor] of Object.entries(recurso.valores)) {
      const filtro = filtros.get(codigo);
      assert.ok(filtro, `${recurso.codigo}: ${codigo}`);
      if (filtro.tipoValor === "NUMERO") assert.equal(typeof valor, "number");
      if (filtro.tipoValor === "BOOLEANO") assert.equal(typeof valor, "boolean");
      if (filtro.tipoValor === "OPCION") assert.ok(filtro.opciones.includes(valor));
    }
  }
  const habitacion3 = servicio("PARADOR_MONTANA").recursos.find((item) => item.codigo === "PAR-HAB-003");
  assert.equal(Object.hasOwn(habitacion3.valores, "AMBIENTES"), false);
  assert.equal(Object.hasOwn(habitacion3.valores, "CAMAS_MATRIMONIALES"), false);
});

test("no se inventan tarifas en el manifiesto y se usa imagen S3 conocida solo como fallback", () => {
  assert.equal(Object.hasOwn(catalogo, "TARIFAS"), false);
  assert.equal(catalogo.IMAGEN_MUESTRA_SERVICIO, "6.png");
  assert.equal(catalogo.IMAGEN_MUESTRA_RECURSO, "10.png");
  assert.deepEqual(catalogo.CONVENIOS_A_MIGRAR.map((item) => item.codigoServicio), ["CONVENIO_HOTEL_LINZ"]);
  assert.equal(catalogo.CONVENIOS_A_MIGRAR[0].modeloTarifa, "TEMPORADAS");
  assert.equal(catalogo.CONVENIOS_A_MIGRAR[0].unidadCobro, "POR_ESTADIA");
  assert.equal(catalogo.CONVENIOS_A_MIGRAR[0].permiteAcompanantes, 1);
});
