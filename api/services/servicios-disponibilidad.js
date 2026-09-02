const ESTADO_RESERVA_CANCELADA_ID = 4;
const UMBRAL_ULTIMOS_LUGARES = 10;
const HORIZONTE_ALTERNATIVAS_DIAS = 120;
const MAX_RANGOS_ALTERNATIVOS = 30;
const MAX_PERSONAS_BUSQUEDA = 100;
const MAX_DIAS_BUSQUEDA = 366;
// Estados terminales que liberan el recurso; el resto (Iniciada, Verificada,
// Aprobada, Solicitud sorteo, Adjudicada, ...) sigue ocupando.
const ESTADOS_RESERVA_LIBERAN = ["Cancelada", "Rechazada", "No adjudicada"];
const {
  diferenciaDiasCivil,
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
  obtenerNochesReserva,
  sumarDiasFechaCivil,
  validarRangoReservaTemporal,
} = require("./valores-dominio");
const {
  listarHoldsActivosRecursos,
} = require("./turismo-reserva-holds");

function normalizarEnteroNoNegativo(valor, porDefecto = 0) {
  if (valor === undefined || valor === null || valor === "") {
    return porDefecto;
  }

  const texto = String(valor).trim();
  if (!/^\d+$/.test(texto)) {
    return null;
  }
  const numero = Number(texto);
  if (!Number.isInteger(numero) || numero < 0) {
    return null;
  }

  return numero;
}

function parsearServicioIdsCsv(servicioIdsRaw) {
  if (!servicioIdsRaw) {
    return [];
  }

  const entradas = Array.isArray(servicioIdsRaw)
    ? servicioIdsRaw
    : String(servicioIdsRaw).split(",");

  return entradas
    .map((id) => String(id).trim())
    .filter((id) => /^\d+$/.test(id))
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

function parsearParametrosBusquedaDisponibilidad(
  query,
  { requireFechas = true, requirePersonas = true, hoy = obtenerFechaCivilArgentina() } = {}
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
  // Ningún sitio de reservas acepta una estadía sin un adulto responsable.
  if (requirePersonas && adultos <= 0) {
    return { error: "La búsqueda necesita al menos 1 adulto" };
  }
  if (!Number.isSafeInteger(totalPersonas) || totalPersonas > MAX_PERSONAS_BUSQUEDA) {
    return { error: `No se permiten mas de ${MAX_PERSONAS_BUSQUEDA} personas por busqueda` };
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

  const fechaInicio = normalizarFechaCivil(fechaInicioRaw);
  const fechaFin = normalizarFechaCivil(fechaFinRaw);

  if (!fechaInicio || !fechaFin) {
    return { error: "Las fechas deben tener formato YYYY-MM-DD" };
  }

  if (fechaInicio >= fechaFin) {
    return { error: "fecha_inicio debe ser menor que fecha_fin" };
  }
  const validacionTemporal = validarRangoReservaTemporal(fechaInicio, fechaFin, { hoy });
  if (!validacionTemporal.valido) {
    return {
      error: validacionTemporal.codigo === "FECHA_INICIO_PASADA"
        ? "fecha_inicio no puede ser anterior a hoy"
        : "No se pudo validar el rango respecto de la fecha actual",
    };
  }
  const dias = diferenciaDiasCivil(fechaInicio, fechaFin);
  if (!Number.isInteger(dias) || dias > MAX_DIAS_BUSQUEDA) {
    return { error: `El rango no puede superar ${MAX_DIAS_BUSQUEDA} dias` };
  }

  return {
    value: {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
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

// Las tarifas son inclusivas en ambos extremos (fecha_fin = ultima noche cubierta).
function cubreNoche(tarifa, noche) {
  const inicio = normalizarFechaCivil(tarifa.fecha_inicio);
  const fin = normalizarFechaCivil(tarifa.fecha_fin);
  return Boolean(inicio && fin && inicio <= noche && fin >= noche);
}

// Reservas, holds y bloques usan checkout exclusivo: ocupan [inicio, fin).
function ocupaNoche(rango, noche) {
  const inicio = normalizarFechaCivil(rango.fecha_inicio);
  const fin = normalizarFechaCivil(rango.fecha_fin);
  return Boolean(inicio && fin && inicio <= noche && fin > noche);
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
  const condiciones = [
    "s.activo = 1",
    "s.estado_aprobacion = 'APROBADO'",
    "ts.activo = 1",
    "ts.codigo <> 'CONVENIO_HOTELERO'",
  ];
  const params = [];

  if (lugar) {
    condiciones.push("s.lugar = ?");
    params.push(lugar);
  }

  if (Number.isInteger(servicioId) && servicioId > 0) {
    condiciones.push("s.id = ?");
    params.push(servicioId);
  } else if (Array.isArray(servicioIds) && servicioIds.length > 0) {
    const placeholders = servicioIds.map(() => "?").join(",");
    condiciones.push(`s.id IN (${placeholders})`);
    params.push(...servicioIds);
  }

  let query = `SELECT s.id, s.nombre, s.lugar, s.modelo_tarifa, s.max_personas_reserva,
                      s.anticipacion_minima_dias, s.propietario_departamental_id,
                      ts.codigo AS tipo_codigo
                 FROM servicio s INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id`;
  if (condiciones.length > 0) {
    query += ` WHERE ${condiciones.join(" AND ")}`;
  }
  query += " ORDER BY s.orden ASC, s.id ASC";

  const [rows] = await connection.query(query, params);
  return rows;
}

/**
 * Capacidad efectiva de cada recurso: el cupo del catalogo o, si no esta
 * cargado, la caracteristica "Personas" (filtro PERSONAS). null = sin dato.
 */
async function obtenerCapacidadRecursos(connection, recursoIds) {
  const ids = [...new Set((recursoIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const capacidades = new Map();
  if (ids.length === 0) return capacidades;
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await connection.query(
    `SELECT r.id, r.cupo_maximo,
            (SELECT COALESCE(fr.valor_numero, fr.cantidad)
               FROM filtro_recurso fr
               INNER JOIN filtro f ON f.id = fr.filtro_id
              WHERE fr.recurso_id = r.id AND f.codigo = 'PERSONAS'
              LIMIT 1) AS personas_filtro
       FROM recurso r
      WHERE r.id IN (${placeholders})`,
    ids
  );
  for (const row of rows) {
    const cupo = Number(row.cupo_maximo);
    const personas = Number(row.personas_filtro);
    let capacidad = null;
    if (Number.isFinite(cupo) && cupo > 0) capacidad = Math.trunc(cupo);
    else if (Number.isFinite(personas) && personas > 0) capacidad = Math.trunc(personas);
    capacidades.set(Number(row.id), capacidad);
  }
  return capacidades;
}

function recursoAdmitePersonas(capacidades, recursoId, totalPersonas) {
  const capacidad = capacidades.get(Number(recursoId));
  if (!Number.isInteger(capacidad) || capacidad <= 0) return true;
  const personas = Number(totalPersonas);
  if (!Number.isFinite(personas) || personas <= 0) return true;
  return personas <= capacidad;
}

async function consultarTolerante(connection, sql, params, valorPorDefecto = []) {
  try {
    const [rows] = await connection.query(sql, params);
    return rows;
  } catch (error) {
    if (esErrorTemporadaAltaNoMigrada(error)) return valorPorDefecto;
    throw error;
  }
}

/**
 * Carga en una sola pasada todo lo necesario para evaluar noche por noche la
 * disponibilidad de los recursos de un servicio "por recurso" dentro de la
 * ventana [fechaDesde, fechaHasta).
 */
async function cargarContextoNoCamping(connection, {
  servicioId,
  fechaDesde,
  fechaHasta,
  modeloTarifa,
  audienciaDepartamental = "TODAS",
  reservaExcluirId = null,
  holdIdExcluir = null,
}) {
  const [recursos] = await connection.query(
    "SELECT id FROM recurso WHERE servicio_id = ? AND activo = 1 ORDER BY orden ASC, id ASC",
    [servicioId]
  );
  const recursoIds = recursos.map((recurso) => Number(recurso.id));
  if (recursoIds.length === 0) {
    return { recursoIds, tarifas: [], reservas: [], holds: [], bloques: [], capacidades: new Map() };
  }
  const placeholders = recursoIds.map(() => "?").join(",");
  const ultimaNoche = sumarDiasFechaCivil(fechaHasta, -1) || fechaHasta;

  let tarifas = [];
  if (modeloTarifa !== "PRECIO_UNICO") {
    // Solo cuentan las tarifas que la cotizacion realmente usaria: temporadas
    // generales o temporadas de un bloque todavia activo (mismo criterio que
    // validarSolapamientoTarifasExistentes).
    [tarifas] = await connection.query(
      `
        SELECT recurso_id, edad_minima, edad_maxima, fecha_inicio, fecha_fin
        FROM tarifa
        WHERE recurso_id IN (${placeholders})
          AND turismo_tarifa_regla_id IS NULL
          AND COALESCE(audiencia_departamental, 'TODAS') IN ('TODAS', ?)
          AND fecha_inicio <= ?
          AND fecha_fin >= ?
          AND (
            temporada_tarifa_id IS NULL
            OR temporada_tarifa_id IN (
              SELECT tt.id FROM temporada_tarifa tt
               WHERE COALESCE(tt.origen, 'GENERAL') = 'GENERAL'
                  OR EXISTS (
                    SELECT 1 FROM bloque_fecha bfv
                     WHERE bfv.temporada_tarifa_id = tt.id AND bfv.estado = 'ACTIVO'
                  )
            )
          )
      `,
      [...recursoIds, audienciaDepartamental, ultimaNoche, fechaDesde]
    );
  }
  const [reglas] = await connection.query(
    `SELECT rr.id AS recurso_id, tr.fecha_inicio, tr.fecha_fin,
            NULL AS edad_minima, NULL AS edad_maxima
       FROM recurso rr
       INNER JOIN turismo_tarifa_regla tr
         ON tr.servicio_id = rr.servicio_id
        AND (tr.recurso_id IS NULL OR tr.recurso_id = rr.id)
      WHERE rr.id IN (${placeholders}) AND tr.activo = 1
        AND tr.audiencia_departamental IN ('TODAS', ?)
        AND tr.fecha_inicio <= ? AND tr.fecha_fin >= ?`,
    [...recursoIds, audienciaDepartamental, ultimaNoche, fechaDesde]
  );
  tarifas.push(...reglas);

  const filtroExclusion = reservaExcluirId ? " AND r.id <> ?" : "";
  const paramsExclusion = reservaExcluirId ? [reservaExcluirId] : [];
  const [reservas] = await connection.query(
    `
      SELECT r.recurso_id,
             DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
             DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin
      FROM reserva r
      LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.recurso_id IN (${placeholders})
        AND r.fecha_inicio < ?
        AND r.fecha_fin > ?
        AND COALESCE(r.estado_reserva_id, 1) <> ?
        AND COALESCE(er.nombre, '') NOT IN (${ESTADOS_RESERVA_LIBERAN.map(() => "?").join(",")})${filtroExclusion}
    `,
    [...recursoIds, fechaHasta, fechaDesde, ESTADO_RESERVA_CANCELADA_ID, ...ESTADOS_RESERVA_LIBERAN, ...paramsExclusion]
  );

  const holds = await listarHoldsActivosRecursos(connection, {
    recursoIds,
    fechaInicio: fechaDesde,
    fechaFin: fechaHasta,
    holdIdExcluir,
  });

  const bloques = await consultarTolerante(
    connection,
    `
      SELECT bfr.recurso_id, bf.modalidad, bfr.estado AS estado_recurso,
             DATE_FORMAT(bf.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
             DATE_FORMAT(bf.fecha_fin, '%Y-%m-%d') AS fecha_fin
      FROM bloque_fecha_recurso bfr
      INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
      WHERE bfr.recurso_id IN (${placeholders})
        AND bf.estado = 'ACTIVO'
        AND bfr.estado IN ('DISPONIBLE', 'SORTEO', 'VENTA_DIRECTA')
        AND bf.fecha_inicio < ?
        AND bf.fecha_fin > ?
    `,
    [...recursoIds, fechaHasta, fechaDesde]
  );

  const capacidades = await obtenerCapacidadRecursos(connection, recursoIds);

  return { recursoIds, tarifas, reservas, holds, bloques, capacidades };
}

/**
 * Para cada noche devuelve los recursos con tarifa completa para las
 * categorias buscadas y, de ellos, cuales estan libres (sin reserva, hold ni
 * bloque). `bloqueExacto` permite que una busqueda que coincide exactamente
 * con un bloque de venta directa no vea bloqueados sus recursos.
 */
function calcularNochesNoCamping(contexto, { noches, categorias, totalPersonas, bloqueExacto = null }) {
  const tarifasPorRecurso = new Map();
  for (const tarifa of contexto.tarifas) {
    const recursoId = Number(tarifa.recurso_id);
    if (!tarifasPorRecurso.has(recursoId)) tarifasPorRecurso.set(recursoId, []);
    tarifasPorRecurso.get(recursoId).push(tarifa);
  }
  const bloqueoExento = (bloque) => Boolean(
    bloqueExacto
    && (bloque.modalidad === "BLOQUE" || bloque.estado_recurso === "VENTA_DIRECTA")
    && normalizarFechaCivil(bloque.fecha_inicio) === bloqueExacto.fechaInicio
    && normalizarFechaCivil(bloque.fecha_fin) === bloqueExacto.fechaFin
  );
  const recursosAdmitidos = contexto.recursoIds.filter((recursoId) =>
    recursoAdmitePersonas(contexto.capacidades, recursoId, totalPersonas)
  );

  const resultado = new Map();
  for (const noche of noches) {
    const conTarifa = new Set();
    const libres = new Set();
    for (const recursoId of recursosAdmitidos) {
      const tarifasRecurso = tarifasPorRecurso.get(recursoId) || [];
      if (tarifasRecurso.length === 0) continue;
      const cubre = categorias.every((categoria) =>
        tarifasRecurso.some((tarifa) => tarifaAplicaParaEdad(tarifa, categoria.edadRepresentativa) && cubreNoche(tarifa, noche))
      );
      if (!cubre) continue;
      conTarifa.add(recursoId);
      const ocupado = contexto.reservas.some((reserva) => Number(reserva.recurso_id) === recursoId && ocupaNoche(reserva, noche))
        || contexto.holds.some((hold) => Number(hold.recurso_id) === recursoId && ocupaNoche(hold, noche))
        || contexto.bloques.some((bloque) => Number(bloque.recurso_id) === recursoId && !bloqueoExento(bloque) && ocupaNoche(bloque, noche));
      if (!ocupado) libres.add(recursoId);
    }
    resultado.set(noche, { conTarifa, libres });
  }
  return resultado;
}

function interseccionRecursos(mapaNoches, noches, clave) {
  let acumulado = null;
  for (const noche of noches) {
    const datos = mapaNoches.get(noche);
    const conjunto = datos ? datos[clave] : new Set();
    if (acumulado === null) {
      acumulado = new Set(conjunto);
    } else {
      for (const recursoId of [...acumulado]) {
        if (!conjunto.has(recursoId)) acumulado.delete(recursoId);
      }
    }
    if (acumulado.size === 0) break;
  }
  return acumulado || new Set();
}

async function cargarContextoCamping(connection, {
  servicioId,
  fechaDesde,
  fechaHasta,
  reservaExcluirId = null,
  holdIdExcluir = null,
}) {
  const [recursosCamping] = await connection.query(
    `SELECT id, cupo_maximo, es_recurso_principal FROM recurso
      WHERE servicio_id = ? AND activo = 1
      ORDER BY es_recurso_principal DESC, orden ASC, id ASC`,
    [servicioId]
  );
  if (recursosCamping.length === 0) {
    return null;
  }
  const recursoCamping = recursosCamping[0];
  const recursoCampingId = Number(recursoCamping.id);
  const ultimaNoche = sumarDiasFechaCivil(fechaHasta, -1) || fechaHasta;

  const [tarifasCamping] = await connection.query(
    `
      SELECT fecha_inicio, fecha_fin, parcelas_disponibles
      FROM tarifa
      WHERE recurso_id = ?
        AND fecha_inicio <= ?
        AND fecha_fin >= ?
        AND parcelas_disponibles IS NOT NULL
    `,
    [recursoCampingId, ultimaNoche, fechaDesde]
  );
  const [cuposConfigurados] = await connection.query(
    `SELECT fecha_inicio, fecha_fin, cupo_total
       FROM recurso_cupo_periodo
      WHERE recurso_id = ? AND activo = 1
        AND fecha_inicio <= ? AND fecha_fin >= ?`,
    [recursoCampingId, ultimaNoche, fechaDesde]
  );

  const filtroExclusion = reservaExcluirId ? " AND r.id <> ?" : "";
  const paramsExclusion = reservaExcluirId ? [reservaExcluirId] : [];
  const [reservas] = await connection.query(
    `
      SELECT r.recurso_id,
             DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
             DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin
      FROM reserva r
      LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.recurso_id = ?
        AND r.fecha_inicio < ?
        AND r.fecha_fin > ?
        AND COALESCE(r.estado_reserva_id, 1) <> ?
        AND COALESCE(er.nombre, '') NOT IN (${ESTADOS_RESERVA_LIBERAN.map(() => "?").join(",")})${filtroExclusion}
    `,
    [recursoCampingId, fechaHasta, fechaDesde, ESTADO_RESERVA_CANCELADA_ID, ...ESTADOS_RESERVA_LIBERAN, ...paramsExclusion]
  );
  const holds = await listarHoldsActivosRecursos(connection, {
    recursoIds: [recursoCampingId],
    fechaInicio: fechaDesde,
    fechaFin: fechaHasta,
    holdIdExcluir,
  });

  return {
    recursoCampingId,
    cupoMaximo: Number.isInteger(Number(recursoCamping.cupo_maximo)) ? Number(recursoCamping.cupo_maximo) : null,
    tarifas: tarifasCamping,
    cupos: cuposConfigurados,
    reservas,
    holds,
  };
}

function parcelasConfiguradasNoche(contexto, noche) {
  let parcelasNoche = null;
  for (const cupo of contexto.cupos) {
    if (cubreNoche(cupo, noche)) {
      const cantidad = Number(cupo.cupo_total);
      if (Number.isInteger(cantidad) && cantidad >= 0) {
        parcelasNoche = parcelasNoche === null ? cantidad : Math.min(parcelasNoche, cantidad);
      }
    }
  }
  if (parcelasNoche === null) {
    for (const tarifa of contexto.tarifas) {
      if (cubreNoche(tarifa, noche)) {
        const parcelas = Number(tarifa.parcelas_disponibles);
        if (Number.isFinite(parcelas) && (parcelasNoche === null || parcelas < parcelasNoche)) {
          parcelasNoche = parcelas;
        }
      }
    }
  }
  if (parcelasNoche === null && Number.isInteger(contexto.cupoMaximo)) {
    parcelasNoche = contexto.cupoMaximo;
  }
  return parcelasNoche;
}

/**
 * Para cada noche: parcelas configuradas (null si no hay cupo ni tarifa) y
 * parcelas libres descontando reservas y holds que ocupan esa noche.
 */
function calcularNochesCamping(contexto, { noches }) {
  const resultado = new Map();
  for (const noche of noches) {
    const parcelas = parcelasConfiguradasNoche(contexto, noche);
    if (parcelas === null) {
      resultado.set(noche, { parcelas: null, libres: 0 });
      continue;
    }
    const ocupadas = contexto.reservas.filter((reserva) => ocupaNoche(reserva, noche)).length
      + contexto.holds.filter((hold) => ocupaNoche(hold, noche)).length;
    resultado.set(noche, { parcelas, libres: Math.max(parcelas - ocupadas, 0) });
  }
  return resultado;
}

async function obtenerDisponibilidadCamping(connection, {
  servicioId,
  fechaInicio,
  fechaFin,
  totalPersonas,
  maxPersonasReserva,
  reservaExcluirId = null,
  holdIdExcluir = null,
}) {
  const noches = obtenerNochesReserva(fechaInicio, fechaFin);
  if (noches.length === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }
  const contexto = await cargarContextoCamping(connection, {
    servicioId,
    fechaDesde: fechaInicio,
    fechaHasta: fechaFin,
    reservaExcluirId,
    holdIdExcluir,
  });
  if (!contexto) {
    return construirPayloadDisponibilidad(0, 0);
  }

  const mapaNoches = calcularNochesCamping(contexto, { noches });
  let parcelasMinimas = null;
  let libresMinimas = null;
  for (const noche of noches) {
    const datos = mapaNoches.get(noche);
    if (!datos || datos.parcelas === null) return construirPayloadDisponibilidad(0, 0);
    parcelasMinimas = parcelasMinimas === null ? datos.parcelas : Math.min(parcelasMinimas, datos.parcelas);
    libresMinimas = libresMinimas === null ? datos.libres : Math.min(libresMinimas, datos.libres);
  }

  const parcelasTotales = Math.max(Number(parcelasMinimas) || 0, 0);
  if (parcelasTotales <= 0) {
    return construirPayloadDisponibilidad(0, parcelasTotales);
  }

  const maxPersonas = Number(maxPersonasReserva);
  if (Number.isInteger(maxPersonas) && maxPersonas > 0 && totalPersonas > maxPersonas) {
    return construirPayloadDisponibilidad(0, parcelasTotales);
  }

  return construirPayloadDisponibilidad(Math.max(Number(libresMinimas) || 0, 0), parcelasTotales);
}

async function obtenerDisponibilidadNoCamping(connection, {
  servicioId,
  fechaInicio,
  fechaFin,
  adultos,
  ninos,
  bebes,
  totalPersonas = null,
  modeloTarifa,
  audienciaDepartamental = "TODAS",
  reservaExcluirId = null,
  holdIdExcluir = null,
}) {
  const noches = obtenerNochesReserva(fechaInicio, fechaFin);
  if (noches.length === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }
  const contexto = await cargarContextoNoCamping(connection, {
    servicioId,
    fechaDesde: fechaInicio,
    fechaHasta: fechaFin,
    modeloTarifa,
    audienciaDepartamental,
    reservaExcluirId,
    holdIdExcluir,
  });
  if (contexto.recursoIds.length === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }

  const categorias = categoriasBusquedaDesdePersonas({ adultos, ninos, bebes });
  const personas = Number.isFinite(Number(totalPersonas)) && Number(totalPersonas) > 0
    ? Number(totalPersonas)
    : Number(adultos || 0) + Number(ninos || 0) + Number(bebes || 0);
  const mapaNoches = calcularNochesNoCamping(contexto, {
    noches,
    categorias,
    totalPersonas: personas,
    bloqueExacto: { fechaInicio, fechaFin },
  });

  const total = interseccionRecursos(mapaNoches, noches, "conTarifa").size;
  if (total === 0) {
    return construirPayloadDisponibilidad(0, 0);
  }
  const disponibles = interseccionRecursos(mapaNoches, noches, "libres").size;
  return construirPayloadDisponibilidad(disponibles, total);
}

function audienciaDesdeConfiguracion(configuracion, departamentalId) {
  if (configuracion.propietario_departamental_id == null) return "TODAS";
  return Number(departamentalId) === Number(configuracion.propietario_departamental_id) ? "PROPIA" : "OTRAS";
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
    tipoCodigo = null,
    modeloTarifa = null,
    maxPersonasReserva = null,
    anticipacionMinimaDias = null,
    propietarioDepartamentalId = null,
    departamentalId = null,
    reservaExcluirId = null,
    holdIdExcluir = null,
    hoy = obtenerFechaCivilArgentina(),
  } = params;

  let configuracion = {
    tipo_codigo: tipoCodigo,
    modelo_tarifa: modeloTarifa,
    max_personas_reserva: maxPersonasReserva,
    anticipacion_minima_dias: anticipacionMinimaDias,
    propietario_departamental_id: propietarioDepartamentalId,
  };
  if (!configuracion.tipo_codigo) {
    const [filas] = await connection.query(
      `SELECT ts.codigo AS tipo_codigo, s.modelo_tarifa, s.max_personas_reserva,
              s.anticipacion_minima_dias, s.propietario_departamental_id
         FROM servicio s INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
        WHERE s.id = ? AND s.activo = 1 AND s.estado_aprobacion = 'APROBADO' AND ts.activo = 1
        LIMIT 1`,
      [servicioId]
    );
    if (!filas.length) return { ...construirPayloadDisponibilidad(0, 0), actualizado_en: new Date().toISOString() };
    [configuracion] = filas;
  }
  const anticipacion = Number(configuracion.anticipacion_minima_dias || 0);
  const fechaMinima = sumarDiasFechaCivil(hoy, anticipacion);
  if (fechaMinima && fechaInicio < fechaMinima) {
    return { ...construirPayloadDisponibilidad(0, 0), actualizado_en: new Date().toISOString() };
  }

  const actualizadoEn = new Date().toISOString();
  if (configuracion.modelo_tarifa === "PRECIO_UNICO" && Number(totalPersonas) !== 1) {
    return { ...construirPayloadDisponibilidad(0, 0), actualizado_en: actualizadoEn };
  }
  const disponibilidad =
    configuracion.tipo_codigo === "CUPO_NUMERADO"
      ? await obtenerDisponibilidadCamping(connection, {
          servicioId,
          fechaInicio,
          fechaFin,
          totalPersonas,
          maxPersonasReserva: configuracion.max_personas_reserva,
          reservaExcluirId,
          holdIdExcluir,
        })
      : await obtenerDisponibilidadNoCamping(connection, {
          servicioId,
          fechaInicio,
          fechaFin,
          adultos,
          ninos,
          bebes,
          totalPersonas,
          modeloTarifa: configuracion.modelo_tarifa,
          audienciaDepartamental: audienciaDesdeConfiguracion(configuracion, departamentalId),
          reservaExcluirId,
          holdIdExcluir,
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
    departamentalId = null,
    reservaExcluirId = null,
    holdIdExcluir = null,
  } = params;

  const servicios = await obtenerServicios(connection, { lugar, servicioIds });
  const resultados = [];

  for (const servicio of servicios) {
    const disponibilidad = await calcularDisponibilidadServicio(connection, {
      servicioId: Number(servicio.id),
      tipoCodigo: servicio.tipo_codigo,
      modeloTarifa: servicio.modelo_tarifa,
      maxPersonasReserva: servicio.max_personas_reserva,
      anticipacionMinimaDias: servicio.anticipacion_minima_dias,
      propietarioDepartamentalId: servicio.propietario_departamental_id,
      departamentalId,
      fechaInicio,
      fechaFin,
      adultos,
      ninos,
      bebes,
      totalPersonas,
      reservaExcluirId,
      holdIdExcluir,
    });

    resultados.push({
      servicio_id: Number(servicio.id),
      ...disponibilidad,
    });
  }

  return resultados;
}

function maximoFechaCivil(...fechas) {
  return fechas.filter(Boolean).sort().pop() || null;
}

function calendarioVacio({ fechaInicio, fechaFin, nochesCantidad = 0, horizonteDias = HORIZONTE_ALTERNATIVAS_DIAS }) {
  return {
    fechas_habilitadas: [],
    rangos_disponibles: [],
    sugerencia: null,
    noches: [],
    noches_cantidad: nochesCantidad,
    fecha_inicio_solicitada: fechaInicio || null,
    fecha_fin_solicitada: fechaFin || null,
    horizonte_dias: horizonteDias,
  };
}

/**
 * Busca estadias alternativas de la misma cantidad de noches alrededor de la
 * fecha pedida (hacia atras hasta hoy + anticipacion y hacia adelante hasta el
 * horizonte). Todo se resuelve en memoria con una sola carga de contexto:
 * evita las ~5 consultas por dia candidato del enfoque anterior.
 *
 * Devuelve las fechas de inicio validas, los rangos mas cercanos ordenados por
 * fecha, la sugerencia (el rango mas proximo a lo pedido) y el estado de cada
 * noche de la ventana para pintar calendarios.
 */
async function obtenerCalendarioAlternativoServicio(connection, params) {
  const {
    servicioId,
    fechaInicio,
    fechaFin,
    adultos,
    ninos,
    bebes,
    totalPersonas,
    departamentalId = null,
    horizonteDias = HORIZONTE_ALTERNATIVAS_DIAS,
    maxResultados = MAX_RANGOS_ALTERNATIVOS,
    holdIdExcluir = null,
    reservaExcluirId = null,
    hoy = obtenerFechaCivilArgentina(),
    servicio: servicioPrecargado = null,
    incluirNoches = true,
  } = params;

  const noches = obtenerNochesReserva(fechaInicio, fechaFin);
  const nochesCantidad = noches.length;
  const vacio = calendarioVacio({ fechaInicio, fechaFin, nochesCantidad, horizonteDias });
  if (nochesCantidad === 0) return vacio;

  const servicio = servicioPrecargado
    || (await obtenerServicios(connection, { servicioId: Number(servicioId) }))[0]
    || null;
  if (!servicio) return vacio;

  const personas = Number.isFinite(Number(totalPersonas)) && Number(totalPersonas) > 0
    ? Number(totalPersonas)
    : Number(adultos || 0) + Number(ninos || 0) + Number(bebes || 0);
  if (servicio.modelo_tarifa === "PRECIO_UNICO" && personas !== 1) return vacio;

  const horizonte = Number.isInteger(Number(horizonteDias)) && Number(horizonteDias) >= 0
    ? Number(horizonteDias)
    : HORIZONTE_ALTERNATIVAS_DIAS;
  const anticipacion = Number(servicio.anticipacion_minima_dias || 0);
  const primerInicioPermitido = maximoFechaCivil(hoy, sumarDiasFechaCivil(hoy, anticipacion));
  const inicioVentana = maximoFechaCivil(primerInicioPermitido, sumarDiasFechaCivil(fechaInicio, -horizonte));
  const ultimoInicio = sumarDiasFechaCivil(fechaInicio, horizonte);
  if (!inicioVentana || !ultimoInicio || inicioVentana > ultimoInicio) return vacio;
  const finVentana = sumarDiasFechaCivil(ultimoInicio, nochesCantidad);
  const nochesVentana = obtenerNochesReserva(inicioVentana, finVentana, 2000);
  if (nochesVentana.length === 0) return vacio;

  const esCamping = servicio.tipo_codigo === "CUPO_NUMERADO";
  let disponiblesPorNoche = new Map();
  let conTarifaPorNoche = new Map();
  let lugaresRango;

  if (esCamping) {
    const maxPersonas = Number(servicio.max_personas_reserva);
    if (Number.isInteger(maxPersonas) && maxPersonas > 0 && personas > maxPersonas) return vacio;
    const contexto = await cargarContextoCamping(connection, {
      servicioId: Number(servicio.id),
      fechaDesde: inicioVentana,
      fechaHasta: finVentana,
      reservaExcluirId,
      holdIdExcluir,
    });
    if (!contexto) return vacio;
    const mapa = calcularNochesCamping(contexto, { noches: nochesVentana });
    for (const noche of nochesVentana) {
      const datos = mapa.get(noche);
      disponiblesPorNoche.set(noche, datos && datos.parcelas !== null ? datos.libres : 0);
      conTarifaPorNoche.set(noche, Boolean(datos && datos.parcelas !== null));
    }
    lugaresRango = (nochesEstadia) => {
      let minimo = null;
      for (const noche of nochesEstadia) {
        if (!conTarifaPorNoche.get(noche)) return 0;
        const libres = disponiblesPorNoche.get(noche) || 0;
        minimo = minimo === null ? libres : Math.min(minimo, libres);
        if (minimo === 0) return 0;
      }
      return minimo || 0;
    };
  } else {
    const contexto = await cargarContextoNoCamping(connection, {
      servicioId: Number(servicio.id),
      fechaDesde: inicioVentana,
      fechaHasta: finVentana,
      modeloTarifa: servicio.modelo_tarifa,
      audienciaDepartamental: audienciaDesdeConfiguracion(servicio, departamentalId),
      reservaExcluirId,
      holdIdExcluir,
    });
    if (contexto.recursoIds.length === 0) return vacio;
    const categorias = categoriasBusquedaDesdePersonas({ adultos, ninos, bebes });
    const mapa = calcularNochesNoCamping(contexto, {
      noches: nochesVentana,
      categorias,
      totalPersonas: personas,
      bloqueExacto: null,
    });
    for (const noche of nochesVentana) {
      const datos = mapa.get(noche);
      disponiblesPorNoche.set(noche, datos ? datos.libres.size : 0);
      conTarifaPorNoche.set(noche, Boolean(datos && datos.conTarifa.size > 0));
    }
    lugaresRango = (nochesEstadia) => interseccionRecursos(mapa, nochesEstadia, "libres").size;
  }

  const candidatos = [];
  for (let inicio = inicioVentana; inicio && inicio <= ultimoInicio; inicio = sumarDiasFechaCivil(inicio, 1)) {
    const nochesEstadia = obtenerNochesReserva(inicio, sumarDiasFechaCivil(inicio, nochesCantidad));
    const lugares = lugaresRango(nochesEstadia);
    if (lugares > 0) {
      const distancia = Math.abs(diferenciaDiasCivil(fechaInicio, inicio) || 0);
      candidatos.push({
        fecha_inicio: inicio,
        fecha_fin: sumarDiasFechaCivil(inicio, nochesCantidad),
        lugares_disponibles: lugares,
        distancia_dias: distancia,
      });
    }
  }

  const porCercania = [...candidatos].sort((a, b) =>
    a.distancia_dias - b.distancia_dias
    // A igual distancia, primero la fecha posterior a la pedida.
    || (b.fecha_inicio >= fechaInicio ? 1 : 0) - (a.fecha_inicio >= fechaInicio ? 1 : 0)
    || a.fecha_inicio.localeCompare(b.fecha_inicio)
  );
  const limite = Number.isInteger(Number(maxResultados)) && Number(maxResultados) > 0
    ? Number(maxResultados)
    : MAX_RANGOS_ALTERNATIVOS;
  const masCercanos = porCercania.slice(0, limite)
    .sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio));

  return {
    fechas_habilitadas: candidatos.map((candidato) => candidato.fecha_inicio),
    rangos_disponibles: masCercanos,
    sugerencia: porCercania[0] || null,
    noches: incluirNoches
      ? nochesVentana.map((noche) => ({
        fecha: noche,
        disponibles: disponiblesPorNoche.get(noche) || 0,
        con_tarifa: Boolean(conTarifaPorNoche.get(noche)),
      }))
      : [],
    noches_cantidad: nochesCantidad,
    fecha_inicio_solicitada: fechaInicio,
    fecha_fin_solicitada: fechaFin,
    horizonte_dias: horizonte,
  };
}

/**
 * Estado noche por noche de UN recurso concreto (para el calendario del paso
 * "Fechas" de la reserva): ocupado por reserva/hold/bloque o sin cupo.
 */
async function obtenerOcupacionNochesRecurso(connection, {
  servicio,
  recursoId,
  fechaDesde,
  fechaHasta,
  reservaExcluirId = null,
  holdIdExcluir = null,
}) {
  const noches = obtenerNochesReserva(fechaDesde, fechaHasta, 2000);
  const resultado = new Map();
  if (noches.length === 0) return resultado;

  if (servicio.tipo_codigo === "CUPO_NUMERADO") {
    const contexto = await cargarContextoCamping(connection, {
      servicioId: Number(servicio.id),
      fechaDesde,
      fechaHasta,
      reservaExcluirId,
      holdIdExcluir,
    });
    if (!contexto) {
      for (const noche of noches) resultado.set(noche, { ocupado: true, motivo: "SIN_CUPO" });
      return resultado;
    }
    const mapa = calcularNochesCamping(contexto, { noches });
    for (const noche of noches) {
      const datos = mapa.get(noche);
      if (!datos || datos.parcelas === null) {
        resultado.set(noche, { ocupado: true, motivo: "SIN_CUPO" });
      } else if (datos.libres <= 0) {
        resultado.set(noche, { ocupado: true, motivo: "COMPLETO" });
      } else {
        resultado.set(noche, { ocupado: false, motivo: null, lugares: datos.libres });
      }
    }
    return resultado;
  }

  const id = Number(recursoId);
  const placeholders = "?";
  const filtroExclusion = reservaExcluirId ? " AND r.id <> ?" : "";
  const paramsExclusion = reservaExcluirId ? [reservaExcluirId] : [];
  const [reservas] = await connection.query(
    `
      SELECT r.recurso_id,
             DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
             DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin
      FROM reserva r
      LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.recurso_id IN (${placeholders})
        AND r.fecha_inicio < ?
        AND r.fecha_fin > ?
        AND COALESCE(r.estado_reserva_id, 1) <> ?
        AND COALESCE(er.nombre, '') NOT IN (${ESTADOS_RESERVA_LIBERAN.map(() => "?").join(",")})${filtroExclusion}
    `,
    [id, fechaHasta, fechaDesde, ESTADO_RESERVA_CANCELADA_ID, ...ESTADOS_RESERVA_LIBERAN, ...paramsExclusion]
  );
  const holds = await listarHoldsActivosRecursos(connection, {
    recursoIds: [id],
    fechaInicio: fechaDesde,
    fechaFin: fechaHasta,
    holdIdExcluir,
  });
  const bloques = await consultarTolerante(
    connection,
    `
      SELECT bfr.recurso_id, bf.modalidad, bfr.estado AS estado_recurso,
             DATE_FORMAT(bf.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
             DATE_FORMAT(bf.fecha_fin, '%Y-%m-%d') AS fecha_fin
      FROM bloque_fecha_recurso bfr
      INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
      WHERE bfr.recurso_id IN (${placeholders})
        AND bf.estado = 'ACTIVO'
        AND bfr.estado IN ('DISPONIBLE', 'SORTEO', 'VENTA_DIRECTA')
        AND bf.fecha_inicio < ?
        AND bf.fecha_fin > ?
    `,
    [id, fechaHasta, fechaDesde]
  );
  for (const noche of noches) {
    if (reservas.some((reserva) => ocupaNoche(reserva, noche))) {
      resultado.set(noche, { ocupado: true, motivo: "RESERVADO" });
    } else if (holds.some((hold) => ocupaNoche(hold, noche))) {
      resultado.set(noche, { ocupado: true, motivo: "RETENIDO" });
    } else {
      const bloque = bloques.find((item) => ocupaNoche(item, noche));
      if (bloque) {
        resultado.set(noche, {
          ocupado: true,
          motivo: bloque.modalidad === "SORTEO" && bloque.estado_recurso !== "VENTA_DIRECTA" ? "SORTEO" : "BLOQUE",
          bloque: { fecha_inicio: bloque.fecha_inicio, fecha_fin: bloque.fecha_fin, modalidad: bloque.modalidad },
        });
      } else {
        resultado.set(noche, { ocupado: false, motivo: null });
      }
    }
  }
  return resultado;
}

module.exports = {
  HORIZONTE_ALTERNATIVAS_DIAS,
  MAX_RANGOS_ALTERNATIVOS,
  UMBRAL_ULTIMOS_LUGARES,
  calcularNochesCamping,
  calcularNochesNoCamping,
  categoriasBusquedaDesdePersonas,
  cubreNoche,
  interseccionRecursos,
  obtenerCapacidadRecursos,
  obtenerOcupacionNochesRecurso,
  ocupaNoche,
  parsearParametrosBusquedaDisponibilidad,
  parsearServicioIdsCsv,
  obtenerServicios,
  calcularDisponibilidadServicio,
  obtenerSnapshotDisponibilidad,
  obtenerCalendarioAlternativoServicio,
  recursoAdmitePersonas,
  tarifasCubrenTodasLasNoches,
};
