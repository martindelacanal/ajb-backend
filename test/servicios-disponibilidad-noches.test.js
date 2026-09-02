"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calcularNochesNoCamping,
  calcularNochesCamping,
  interseccionRecursos,
  obtenerCalendarioAlternativoServicio,
  calcularDisponibilidadServicio,
  obtenerOcupacionNochesRecurso,
  recursoAdmitePersonas,
} = require("../api/services/servicios-disponibilidad");

function crearConexion(datos) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params = []) {
      consultas.push({ sql, params });
      if (/FROM servicio s INNER JOIN tipo_servicio/i.test(sql)) return [datos.servicios || []];
      if (/SELECT id, cupo_maximo, es_recurso_principal FROM recurso/i.test(sql)) return [datos.recursosCamping || []];
      if (/SELECT id FROM recurso WHERE servicio_id/i.test(sql)) return [datos.recursos || []];
      if (/personas_filtro/i.test(sql)) return [datos.capacidades || []];
      if (/FROM recurso_cupo_periodo/i.test(sql)) return [datos.cupos || []];
      if (/parcelas_disponibles IS NOT NULL/i.test(sql)) return [datos.tarifasCamping || []];
      if (/FROM tarifa\b/i.test(sql)) {
        assert.match(sql, /turismo_tarifa_regla_id IS NULL/);
        return [datos.tarifas || []];
      }
      if (/FROM recurso rr[\s\S]+turismo_tarifa_regla tr/i.test(sql)) return [datos.reglas || []];
      if (/FROM reserva r/i.test(sql)) return [datos.reservas || []];
      if (/FROM turismo_reserva_hold/i.test(sql)) return [datos.holds || []];
      if (/FROM bloque_fecha_recurso/i.test(sql)) return [datos.bloques || []];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
}

const SERVICIO = {
  id: 5,
  nombre: "Cabañas",
  lugar: "Miramar",
  tipo_codigo: "ALOJAMIENTO_RECURSO",
  modelo_tarifa: "TEMPORADAS",
  max_personas_reserva: 6,
  anticipacion_minima_dias: 0,
  propietario_departamental_id: null,
};

const BASE = {
  servicios: [SERVICIO],
  recursos: [{ id: 1 }, { id: 2 }],
  capacidades: [
    { id: 1, cupo_maximo: null, personas_filtro: "2.00" },
    { id: 2, cupo_maximo: null, personas_filtro: "6.00" },
  ],
  tarifas: [
    { recurso_id: 1, edad_minima: null, edad_maxima: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31" },
    { recurso_id: 2, edad_minima: null, edad_maxima: null, fecha_inicio: "2040-01-10", fecha_fin: "2040-01-31" },
  ],
  reservas: [{ recurso_id: 2, fecha_inicio: "2040-01-12", fecha_fin: "2040-01-14" }],
};

test("la capacidad del recurso sale del cupo o del filtro Personas", () => {
  const capacidades = new Map([[1, 2], [2, null]]);
  assert.equal(recursoAdmitePersonas(capacidades, 1, 2), true);
  assert.equal(recursoAdmitePersonas(capacidades, 1, 3), false);
  assert.equal(recursoAdmitePersonas(capacidades, 2, 40), true);
  assert.equal(recursoAdmitePersonas(capacidades, 99, 4), true);
});

test("el mapa por noche descuenta reservas, holds y bloques con checkout exclusivo", () => {
  const contexto = {
    recursoIds: [1, 2, 3],
    tarifas: [
      { recurso_id: 1, edad_minima: null, edad_maxima: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-05" },
      { recurso_id: 2, edad_minima: 6, edad_maxima: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-05" },
      { recurso_id: 2, edad_minima: 0, edad_maxima: 5, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-05" },
      { recurso_id: 3, edad_minima: null, edad_maxima: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-05" },
    ],
    reservas: [{ recurso_id: 1, fecha_inicio: "2040-01-02", fecha_fin: "2040-01-04" }],
    holds: [{ recurso_id: 2, fecha_inicio: "2040-01-04", fecha_fin: "2040-01-05" }],
    bloques: [{ recurso_id: 3, modalidad: "BLOQUE", estado_recurso: "DISPONIBLE", fecha_inicio: "2040-01-01", fecha_fin: "2040-01-06" }],
    capacidades: new Map([[1, 4], [2, 4], [3, 4]]),
  };
  const noches = ["2040-01-01", "2040-01-02", "2040-01-03", "2040-01-04", "2040-01-05"];
  const mapa = calcularNochesNoCamping(contexto, {
    noches,
    categorias: [{ tipo: "adultos", edadRepresentativa: 30 }, { tipo: "ninos", edadRepresentativa: 4 }],
    totalPersonas: 2,
  });

  assert.deepEqual([...mapa.get("2040-01-01").libres].sort(), [1, 2]);
  // La reserva de 1 ocupa las noches del 2 y del 3 (checkout el 4 libre).
  assert.deepEqual([...mapa.get("2040-01-02").libres].sort(), [2]);
  assert.deepEqual([...mapa.get("2040-01-03").libres].sort(), [2]);
  assert.deepEqual([...mapa.get("2040-01-04").libres].sort(), [1]);
  // El bloque de venta directa se exime solo cuando la busqueda es exacta.
  const exacto = calcularNochesNoCamping(contexto, {
    noches,
    categorias: [{ tipo: "adultos", edadRepresentativa: 30 }],
    totalPersonas: 1,
    bloqueExacto: { fechaInicio: "2040-01-01", fechaFin: "2040-01-06" },
  });
  assert.ok(exacto.get("2040-01-01").libres.has(3));
  assert.equal(interseccionRecursos(mapa, ["2040-01-01", "2040-01-02"], "libres").size, 1);
  assert.equal(interseccionRecursos(mapa, noches, "conTarifa").size, 3);
});

test("el snapshot excluye unidades chicas para el grupo y respeta ocupacion", async () => {
  const dos = await calcularDisponibilidadServicio(crearConexion(BASE), {
    servicioId: 5,
    tipoCodigo: "ALOJAMIENTO_RECURSO",
    modeloTarifa: "TEMPORADAS",
    maxPersonasReserva: 6,
    fechaInicio: "2040-01-12",
    fechaFin: "2040-01-14",
    adultos: 2, ninos: 0, bebes: 0, totalPersonas: 2,
    hoy: "2040-01-01",
  });
  // Recurso 1 (cap. 2) libre; recurso 2 reservado esas noches.
  assert.equal(dos.total, 2);
  assert.equal(dos.disponibles, 1);

  const tres = await calcularDisponibilidadServicio(crearConexion(BASE), {
    servicioId: 5,
    tipoCodigo: "ALOJAMIENTO_RECURSO",
    modeloTarifa: "TEMPORADAS",
    maxPersonasReserva: 6,
    fechaInicio: "2040-01-12",
    fechaFin: "2040-01-14",
    adultos: 3, ninos: 0, bebes: 0, totalPersonas: 3,
    hoy: "2040-01-01",
  });
  assert.equal(tres.total, 1);
  assert.equal(tres.disponibles, 0);
  assert.equal(tres.sin_disponibilidad, true);
});

test("las alternativas buscan hacia atras y adelante y sugieren la mas cercana", async () => {
  const conexion = crearConexion(BASE);
  const calendario = await obtenerCalendarioAlternativoServicio(conexion, {
    servicioId: 5,
    fechaInicio: "2040-01-13",
    fechaFin: "2040-01-15",
    adultos: 3, ninos: 0, bebes: 0, totalPersonas: 3,
    horizonteDias: 6,
    maxResultados: 4,
    hoy: "2040-01-01",
  });
  // Solo el recurso 2 admite 3 personas y tiene tarifa desde el 10; la
  // reserva del 12 al 14 anula los inicios 11, 12 y 13.
  assert.deepEqual(calendario.fechas_habilitadas, ["2040-01-10", "2040-01-14", "2040-01-15", "2040-01-16", "2040-01-17", "2040-01-18", "2040-01-19"]);
  assert.equal(calendario.sugerencia.fecha_inicio, "2040-01-14");
  assert.equal(calendario.sugerencia.fecha_fin, "2040-01-16");
  assert.equal(calendario.sugerencia.distancia_dias, 1);
  assert.equal(calendario.rangos_disponibles.length, 4);
  assert.deepEqual(calendario.rangos_disponibles.map((rango) => rango.fecha_inicio), ["2040-01-10", "2040-01-14", "2040-01-15", "2040-01-16"]);
  assert.equal(calendario.noches_cantidad, 2);
  assert.ok(calendario.noches.some((noche) => noche.fecha === "2040-01-12" && noche.disponibles === 0));
  // Toda la ventana se resolvio con una unica carga de contexto.
  assert.ok(conexion.consultas.filter((consulta) => /FROM reserva r/i.test(consulta.sql)).length === 1);

  const anticipacion = await obtenerCalendarioAlternativoServicio(crearConexion({
    ...BASE,
    servicios: [{ ...SERVICIO, anticipacion_minima_dias: 12 }],
  }), {
    servicioId: 5,
    fechaInicio: "2040-01-05",
    fechaFin: "2040-01-07",
    adultos: 1, ninos: 0, bebes: 0, totalPersonas: 1,
    horizonteDias: 10,
    hoy: "2040-01-01",
  });
  assert.equal(anticipacion.fechas_habilitadas[0], "2040-01-13");
});

test("el camping calcula parcelas libres por noche con cupos, reservas y holds", () => {
  const contexto = {
    recursoCampingId: 9,
    cupoMaximo: null,
    tarifas: [{ fecha_inicio: "2040-02-01", fecha_fin: "2040-02-10", parcelas_disponibles: 5 }],
    cupos: [{ fecha_inicio: "2040-02-01", fecha_fin: "2040-02-05", cupo_total: 3 }],
    reservas: [
      { recurso_id: 9, fecha_inicio: "2040-02-02", fecha_fin: "2040-02-04" },
      { recurso_id: 9, fecha_inicio: "2040-02-03", fecha_fin: "2040-02-04" },
    ],
    holds: [{ recurso_id: 9, fecha_inicio: "2040-02-03", fecha_fin: "2040-02-05" }],
  };
  const mapa = calcularNochesCamping(contexto, { noches: ["2040-02-01", "2040-02-02", "2040-02-03", "2040-02-04", "2040-02-06", "2040-02-20"] });
  assert.deepEqual(mapa.get("2040-02-01"), { parcelas: 3, libres: 3 });
  assert.deepEqual(mapa.get("2040-02-02"), { parcelas: 3, libres: 2 });
  assert.deepEqual(mapa.get("2040-02-03"), { parcelas: 3, libres: 0 });
  assert.deepEqual(mapa.get("2040-02-04"), { parcelas: 3, libres: 2 });
  // Fuera del cupo cae en la tarifa (5 parcelas); fuera de todo no hay cupo.
  assert.deepEqual(mapa.get("2040-02-06"), { parcelas: 5, libres: 5 });
  assert.deepEqual(mapa.get("2040-02-20"), { parcelas: null, libres: 0 });
});

test("la ocupacion por noche de un recurso distingue reserva, hold y bloque", async () => {
  const ocupacion = await obtenerOcupacionNochesRecurso(crearConexion({
    reservas: [{ recurso_id: 2, fecha_inicio: "2040-01-02", fecha_fin: "2040-01-03" }],
    holds: [{ recurso_id: 2, fecha_inicio: "2040-01-03", fecha_fin: "2040-01-04" }],
    bloques: [{ recurso_id: 2, modalidad: "SORTEO", estado_recurso: "SORTEO", fecha_inicio: "2040-01-04", fecha_fin: "2040-01-05" }],
  }), {
    servicio: { id: 5, tipo_codigo: "ALOJAMIENTO_RECURSO" },
    recursoId: 2,
    fechaDesde: "2040-01-01",
    fechaHasta: "2040-01-06",
  });
  assert.equal(ocupacion.get("2040-01-01").ocupado, false);
  assert.equal(ocupacion.get("2040-01-02").motivo, "RESERVADO");
  assert.equal(ocupacion.get("2040-01-03").motivo, "RETENIDO");
  assert.equal(ocupacion.get("2040-01-04").motivo, "SORTEO");
  assert.equal(ocupacion.get("2040-01-05").ocupado, false);
});
