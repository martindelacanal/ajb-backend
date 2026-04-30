const SERVICIO_CAMPING_ID = 4;
const RECURSO_CAMPING_ID = 1;
const MAX_PERSONAS_CAMPING = 6;
const ESTADO_RESERVA_CANCELADA_ID = 4;
const UMBRAL_ULTIMOS_LUGARES = 10;
const HORIZONTE_ALTERNATIVAS_DIAS = 120;
const MAX_RANGOS_ALTERNATIVOS = 30;

function formatearFecha(fecha) {
  return fecha.toISOString().split("T")[0];
}

function sumarDias(fechaString, dias) {
  const fecha = new Date(fechaString);
  fecha.setDate(fecha.getDate() + dias);
  return formatearFecha(fecha);
}

function obtenerNochesReserva(fechaInicio, fechaFin) {
  const inicio = new Date(fechaInicio);
  const fin = new Date(fechaFin);

  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime()) || inicio >= fin) {
    return [];
  }

  const noches = [];
  const cursor = new Date(inicio);

  while (cursor < fin) {
    noches.push(formatearFecha(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return noches;
}

function normalizarEnteroNoNegativo(valor, porDefecto = 0) {
  if (valor === undefined || valor === null || valor === "") {
    return porDefecto;
  }

  const numero = Number.parseInt(valor, 10);
  if (!Number.isInteger(numero) || numero < 0) {
    return null;
  }

  return numero;
}

function parsearServicioIdsCsv(servicioIdsRaw) {
  if (!servicioIdsRaw) {
    return [];
  }

  if (Array.isArray(servicioIdsRaw)) {
    return servicioIdsRaw
      .map((id) => Number.parseInt(id, 10))
      .filter((id) => Number.isInteger(id) && id > 0);
  }

  return String(servicioIdsRaw)
    .split(",")
    .map((id) => Number.parseInt(id.trim(), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function parsearParametrosBusquedaDisponibilidad(
  query,
  { requireFechas = true, requirePersonas = true } = {}
) {
  const fechaInicioRaw = query.fecha_inicio;
  const fechaFinRaw = query.fecha_fin;

  if (requireFechas && (!fechaInicioRaw || !fechaFinRaw)) {
    return { error: "fecha_inicio y fecha_fin son requeridas" };
  }

  const adultos = normalizarEnteroNoNegativo(query.adultos, 0);
  const ninos = normalizarEnteroNoNegativo(query.ninos, 0);
  const bebes = normalizarEnteroNoNegativo(query.bebes, 0);

  if (adultos === null || ninos === null || bebes === null) {
    return { error: "adultos, ninos y bebes deben ser enteros mayores o iguales a 0" };
  }

  const totalPersonas = adultos + ninos + bebes;
  if (requirePersonas && totalPersonas <= 0) {
    return { error: "Debe indicar al menos 1 persona" };
  }

  if (!fechaInicioRaw && !fechaFinRaw && !requireFechas) {
    return {
      value: {
        fecha_inicio: null,
        fecha_fin: null,
        adultos,
        ninos,
        bebes,
        total_personas: totalPersonas,
      },
    };
  }

  const fechaInicio = new Date(fechaInicioRaw);
  const fechaFin = new Date(fechaFinRaw);

  if (Number.isNaN(fechaInicio.getTime()) || Number.isNaN(fechaFin.getTime())) {
    return { error: "Las fechas deben tener formato YYYY-MM-DD" };
  }

  const fechaInicioNormalizada = formatearFecha(fechaInicio);
  const fechaFinNormalizada = formatearFecha(fechaFin);
  if (fechaInicioNormalizada !== fechaInicioRaw || fechaFinNormalizada !== fechaFinRaw) {
    return { error: "Las fechas deben tener formato YYYY-MM-DD" };
  }

  if (fechaInicio >= fechaFin) {
    return { error: "fecha_inicio debe ser menor que fecha_fin" };
  }

  return {
    value: {
      fecha_inicio: fechaInicioRaw,
      fecha_fin: fechaFinRaw,
      adultos,
      ninos,
      bebes,
      total_personas: totalPersonas,
    },
  };
}

function categoriasBusquedaDesdePersonas({ adultos, ninos, bebes }) {
  const categorias = [];
  if (adultos > 0) {
    categorias.push({ tipo: "adultos", edadRepresentativa: 30 });
  }
  if (ninos > 0) {
    categorias.push({ tipo: "ninos", edadRepresentativa: 4 });
  }
  if (bebes > 0) {
    categorias.push({ tipo: "bebes", edadRepresentativa: 1 });
  }
  return categorias;
}

function tarifaAplicaParaEdad(tarifa, edad) {
  const edadMinima = tarifa.edad_minima;
  const edadMaxima = tarifa.edad_maxima;
  return (edadMinima === null || edadMinima <= edad) && (edadMaxima === null || edadMaxima >= edad);
}

function cubreNoche(tarifa, noche) {
  const inicio = formatearFecha(new Date(tarifa.fecha_inicio));
  const fin = formatearFecha(new Date(tarifa.fecha_fin));
  return inicio <= noche && fin >= noche;
}

function tarifasCubrenTodasLasNoches(tarifas, noches) {
  if (!Array.isArray(tarifas) || tarifas.length === 0 || !Array.isArray(noches) || noches.length === 0) {
    return false;
  }

  return noches.every((noche) => tarifas.some((tarifa) => cubreNoche(tarifa, noche)));
}

function esErrorTemporadaAltaNoMigrada(error) {
  return (
    error?.code === "ER_NO_SUCH_TABLE" ||
    error?.code === "ER_BAD_FIELD_ERROR" ||
    error?.errno === 1146 ||
    error?.errno === 1054
  );
}

async function obtenerRecursosBloqueadosPorBloques(connection, { recursoIds, fechaInicio, fechaFin }) {
  if (!Array.isArray(recursoIds) || recursoIds.length === 0) {
    return new Set();
  }

  try {
    const placeholders = recursoIds.map(() => "?").join(",");
    const [rows] = await connection.query(
      `
        SELECT DISTINCT bfr.recurso_id
        FROM bloque_fecha_recurso bfr
        INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
        WHERE bfr.recurso_id IN (${placeholders})
          AND bf.estado = 'ACTIVO'
          AND bfr.estado IN ('DISPONIBLE', 'SORTEO', 'VENTA_DIRECTA')
          AND bf.fecha_inicio < ?
          AND bf.fecha_fin > ?
          AND NOT (
            (bf.modalidad = 'BLOQUE' OR bfr.estado = 'VENTA_DIRECTA')
            AND bf.fecha_inicio = ?
            AND bf.fecha_fin = ?
          )
      `,
      [...recursoIds, fechaFin, fechaInicio, fechaInicio, fechaFin]
    );

    return new Set(rows.map((row) => Number(row.recurso_id)));
  } catch (error) {
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return new Set();
    }
    throw error;
  }
}

function construirPayloadDisponibilidad(disponibles, total, actualizadoEn = new Date().toISOString()) {
  const disponiblesNormalizado = Number.isFinite(disponibles) ? Number(disponibles) : 0;
  const totalNormalizado = Number.isFinite(total) ? Number(total) : 0;

  return {
    disponibles: disponiblesNormalizado,
    lugares_disponibles: disponiblesNormalizado,
    cupo_disponible: disponiblesNormalizado,
    total: totalNormalizado,
    total_disponibles: totalNormalizado,
    ultimos_lugares: disponiblesNormalizado > 0 && disponiblesNormalizado <= UMBRAL_ULTIMOS_LUGARES,
    sin_disponibilidad: disponiblesNormalizado <= 0,
    actualizado_en: actualizadoEn,
  };
}

async function obtenerServicios(connection, { lugar = null, servicioIds = null, servicioId = null } = {}) {
  const condiciones = [];
  const params = [];

  if (lugar) {
    condiciones.push("lugar = ?");
    params.push(lugar);
  }

  if (Number.isInteger(servicioId) && servicioId > 0) {
    condiciones.push("id = ?");
    params.push(servicioId);
  } else if (Array.isArray(servicioIds) && servicioIds.length > 0) {
    const placeholders = servicioIds.map(() => "?").join(",");
    condiciones.push(`id IN (${placeholders})`);
    params.push(...servicioIds);
  }

  let query = "SELECT id, nombre, lugar FROM servicio";
  if (condiciones.length > 0) {
    query += ` WHERE ${condiciones.join(" AND ")}`;
  }
  query += " ORDER BY id ASC";

  const [rows] = await connection.query(query, params);
  return rows;
}

async function obtenerDisponibilidadCamping(connection, { servicioId, fechaInicio, fechaFin, totalPersonas }) {
  const [recursosCamping] = await connection.query(
    "SELECT id FROM recurso WHERE servicio_id = ? ORDER BY id ASC",
    [servicioId]
  );

  if (recursosCamping.length === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }

  const recursoCamping = recursosCamping.find((r) => Number(r.id) === RECURSO_CAMPING_ID) || recursosCamping[0];
  const recursoCampingId = Number(recursoCamping.id);
  const noches = obtenerNochesReserva(fechaInicio, fechaFin);

  if (noches.length === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }

  const [tarifasCamping] = await connection.query(
    `
      SELECT fecha_inicio, fecha_fin, parcelas_disponibles
      FROM tarifa
      WHERE recurso_id = ?
        AND fecha_inicio <= ?
        AND fecha_fin >= ?
        AND parcelas_disponibles IS NOT NULL
    `,
    [recursoCampingId, fechaFin, fechaInicio]
  );

  if (tarifasCamping.length === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }

  let parcelasMinimas = null;
  for (const noche of noches) {
    let parcelasNoche = null;
    for (const tarifa of tarifasCamping) {
      if (cubreNoche(tarifa, noche)) {
        const parcelas = Number(tarifa.parcelas_disponibles);
        if (Number.isFinite(parcelas)) {
          if (parcelasNoche === null || parcelas < parcelasNoche) {
            parcelasNoche = parcelas;
          }
        }
      }
    }

    if (parcelasNoche === null) {
      return construirPayloadDisponibilidad(0, 0);
    }

    if (parcelasMinimas === null || parcelasNoche < parcelasMinimas) {
      parcelasMinimas = parcelasNoche;
    }
  }

  const parcelasTotales = Number.isFinite(parcelasMinimas) ? Math.max(Number(parcelasMinimas), 0) : 0;
  if (parcelasTotales <= 0) {
    return construirPayloadDisponibilidad(0, parcelasTotales);
  }

  if (totalPersonas > MAX_PERSONAS_CAMPING) {
    return construirPayloadDisponibilidad(0, parcelasTotales);
  }

  const [reservasSolapadas] = await connection.query(
    `
      SELECT COUNT(*) AS total
      FROM reserva
      WHERE recurso_id = ?
        AND fecha_inicio < ?
        AND fecha_fin > ?
        AND COALESCE(estado_reserva_id, 1) <> ?
    `,
    [recursoCampingId, fechaFin, fechaInicio, ESTADO_RESERVA_CANCELADA_ID]
  );

  const ocupadas = Number(reservasSolapadas?.[0]?.total || 0);
  const disponibles = Math.max(parcelasTotales - ocupadas, 0);

  return construirPayloadDisponibilidad(disponibles, parcelasTotales);
}

async function obtenerDisponibilidadNoCamping(connection, { servicioId, fechaInicio, fechaFin, adultos, ninos, bebes }) {
  const [recursos] = await connection.query(
    "SELECT id FROM recurso WHERE servicio_id = ? ORDER BY id ASC",
    [servicioId]
  );

  if (recursos.length === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }

  const recursoIds = recursos.map((recurso) => Number(recurso.id));
  const placeholders = recursoIds.map(() => "?").join(",");

  const [tarifas] = await connection.query(
    `
      SELECT recurso_id, edad_minima, edad_maxima, fecha_inicio, fecha_fin
      FROM tarifa
      WHERE recurso_id IN (${placeholders})
        AND fecha_inicio <= ?
        AND fecha_fin >= ?
    `,
    [...recursoIds, fechaFin, fechaInicio]
  );

  const [reservasSolapadas] = await connection.query(
    `
      SELECT DISTINCT recurso_id
      FROM reserva
      WHERE recurso_id IN (${placeholders})
        AND fecha_inicio < ?
        AND fecha_fin > ?
        AND COALESCE(estado_reserva_id, 1) <> ?
    `,
    [...recursoIds, fechaFin, fechaInicio, ESTADO_RESERVA_CANCELADA_ID]
  );

  const recursoOcupadoSet = new Set(reservasSolapadas.map((r) => Number(r.recurso_id)));
  const recursoBloqueadoPorBloqueSet = await obtenerRecursosBloqueadosPorBloques(connection, {
    recursoIds,
    fechaInicio,
    fechaFin,
  });
  const tarifasPorRecurso = new Map();
  for (const tarifa of tarifas) {
    const recursoId = Number(tarifa.recurso_id);
    if (!tarifasPorRecurso.has(recursoId)) {
      tarifasPorRecurso.set(recursoId, []);
    }
    tarifasPorRecurso.get(recursoId).push(tarifa);
  }

  const noches = obtenerNochesReserva(fechaInicio, fechaFin);
  if (noches.length === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }

  const categorias = categoriasBusquedaDesdePersonas({ adultos, ninos, bebes });
  const recursosCompatibles = [];

  for (const recursoId of recursoIds) {
    const tarifasRecurso = tarifasPorRecurso.get(recursoId) || [];
    if (tarifasRecurso.length === 0) {
      continue;
    }

    const cumpleTodasCategorias = categorias.every((categoria) => {
      const tarifasCategoria = tarifasRecurso.filter((tarifa) =>
        tarifaAplicaParaEdad(tarifa, categoria.edadRepresentativa)
      );
      return tarifasCubrenTodasLasNoches(tarifasCategoria, noches);
    });

    if (cumpleTodasCategorias) {
      recursosCompatibles.push(recursoId);
    }
  }

  const total = recursosCompatibles.length;
  if (total === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }

  const disponibles = recursosCompatibles.reduce((acumulado, recursoId) => {
    const noDisponible = recursoOcupadoSet.has(recursoId) || recursoBloqueadoPorBloqueSet.has(recursoId);
    return acumulado + (noDisponible ? 0 : 1);
  }, 0);

  return construirPayloadDisponibilidad(disponibles, total);
}

async function calcularDisponibilidadServicio(connection, params) {
  const {
    servicioId,
    fechaInicio,
    fechaFin,
    adultos,
    ninos,
    bebes,
    totalPersonas,
  } = params;

  const actualizadoEn = new Date().toISOString();
  const disponibilidad =
    Number(servicioId) === SERVICIO_CAMPING_ID
      ? await obtenerDisponibilidadCamping(connection, {
          servicioId,
          fechaInicio,
          fechaFin,
          totalPersonas,
        })
      : await obtenerDisponibilidadNoCamping(connection, {
          servicioId,
          fechaInicio,
          fechaFin,
          adultos,
          ninos,
          bebes,
        });

  return {
    ...disponibilidad,
    actualizado_en: actualizadoEn,
  };
}

async function obtenerSnapshotDisponibilidad(connection, params) {
  const {
    lugar = null,
    servicioIds = [],
    fechaInicio,
    fechaFin,
    adultos,
    ninos,
    bebes,
    totalPersonas,
  } = params;

  const servicios = await obtenerServicios(connection, { lugar, servicioIds });
  const resultados = [];

  for (const servicio of servicios) {
    const disponibilidad = await calcularDisponibilidadServicio(connection, {
      servicioId: Number(servicio.id),
      fechaInicio,
      fechaFin,
      adultos,
      ninos,
      bebes,
      totalPersonas,
    });

    resultados.push({
      servicio_id: Number(servicio.id),
      ...disponibilidad,
    });
  }

  return resultados;
}

async function obtenerCalendarioAlternativoServicio(connection, params) {
  const {
    servicioId,
    fechaInicio,
    fechaFin,
    adultos,
    ninos,
    bebes,
    totalPersonas,
    horizonteDias = HORIZONTE_ALTERNATIVAS_DIAS,
    maxResultados = MAX_RANGOS_ALTERNATIVOS,
  } = params;

  const noches = obtenerNochesReserva(fechaInicio, fechaFin);
  if (noches.length === 0) {
    return {
      fechas_habilitadas: [],
      rangos_disponibles: [],
    };
  }

  const nochesCantidad = noches.length;
  const fechasHabilitadas = [];
  const rangosDisponibles = [];

  for (let i = 0; i <= horizonteDias; i++) {
    if (fechasHabilitadas.length >= maxResultados) {
      break;
    }

    const nuevaFechaInicio = sumarDias(fechaInicio, i);
    const nuevaFechaFin = sumarDias(nuevaFechaInicio, nochesCantidad);

    const disponibilidad = await calcularDisponibilidadServicio(connection, {
      servicioId,
      fechaInicio: nuevaFechaInicio,
      fechaFin: nuevaFechaFin,
      adultos,
      ninos,
      bebes,
      totalPersonas,
    });

    if (disponibilidad.disponibles > 0) {
      fechasHabilitadas.push(nuevaFechaInicio);
      rangosDisponibles.push({
        fecha_inicio: nuevaFechaInicio,
        fecha_fin: nuevaFechaFin,
        lugares_disponibles: disponibilidad.disponibles,
      });
    }
  }

  return {
    fechas_habilitadas: fechasHabilitadas,
    rangos_disponibles: rangosDisponibles,
  };
}

module.exports = {
  HORIZONTE_ALTERNATIVAS_DIAS,
  MAX_PERSONAS_CAMPING,
  SERVICIO_CAMPING_ID,
  UMBRAL_ULTIMOS_LUGARES,
  parsearParametrosBusquedaDisponibilidad,
  parsearServicioIdsCsv,
  obtenerServicios,
  calcularDisponibilidadServicio,
  obtenerSnapshotDisponibilidad,
  obtenerCalendarioAlternativoServicio,
};
