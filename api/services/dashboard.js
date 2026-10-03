"use strict";

const SQL_RED = `
  /* dashboard:red */
  SELECT
    COUNT(*) AS usuarios_total,
    COALESCE(SUM(u.habilitado = 'Y'), 0) AS usuarios_habilitados,
    COALESCE(SUM(u.fecha_creacion >= NOW() - INTERVAL 30 DAY), 0) AS usuarios_nuevos_30_dias,
    COALESCE(SUM(u.es_familiar = 'S'), 0) AS usuarios_familiares,
    COALESCE(SUM(u.rol_id IN (1, 3, 5, 6)), 0) AS usuarios_staff,
    -- Composición del padrón habilitado (roles: 1 admin, 2 afiliado,
    -- 3 departamental, 4 invitado, 5 admin-central, 6 auditor, 7 prensa).
    COALESCE(SUM(u.habilitado = 'Y' AND u.rol_id = 2 AND u.usuario_familiar_id IS NULL), 0) AS composicion_titulares,
    COALESCE(SUM(u.habilitado = 'Y' AND u.es_familiar = 'S'), 0) AS composicion_familiares,
    COALESCE(SUM(u.habilitado = 'Y' AND u.rol_id IN (1, 3, 5, 6, 7)), 0) AS composicion_personal,
    (SELECT COUNT(*) FROM departamental) AS departamentales_total,
    (SELECT COUNT(*) FROM departamental d WHERE d.habilitado = 'Y') AS departamentales_habilitadas,
    (
      SELECT COUNT(DISTINCT u2.departamental_id)
      FROM usuario u2
      INNER JOIN departamental d2 ON d2.id = u2.departamental_id AND d2.habilitado = 'Y'
      WHERE u2.habilitado = 'Y'
    ) AS departamentales_con_usuarios
  FROM usuario u`;

const SQL_TURISMO = `
  /* dashboard:turismo */
  SELECT
    er.id AS estado_id,
    er.nombre,
    COUNT(r.id) AS cantidad,
    MIN(r.fecha_creacion) AS mas_antiguo,
    COALESCE(SUM(r.fecha_creacion >= NOW() - INTERVAL 30 DAY), 0) AS actividad_30_dias,
    COALESCE(SUM(
      r.fecha_inicio >= CURDATE()
      AND r.fecha_inicio < DATE_ADD(CURDATE(), INTERVAL 31 DAY)
      AND er.nombre IN ('Aprobada', 'Adjudicada', 'Convenio aceptado')
    ), 0) AS proximas_30_dias,
    COALESCE(SUM(
      r.fecha_inicio >= CURDATE()
      AND r.fecha_inicio < DATE_ADD(CURDATE(), INTERVAL 8 DAY)
      AND er.nombre IN ('Aprobada', 'Adjudicada', 'Convenio aceptado')
    ), 0) AS proximas_7_dias
  FROM estado_reserva er
  LEFT JOIN reserva r ON r.estado_reserva_id = er.id
  GROUP BY er.id, er.nombre
  ORDER BY er.id`;

const SQL_COSEGURO = `
  /* dashboard:coseguro */
  SELECT
    ce.id AS estado_id,
    ce.nombre,
    COUNT(s.id) AS cantidad,
    MIN(s.fecha_creacion) AS mas_antiguo,
    COALESCE(SUM(s.fecha_creacion >= NOW() - INTERVAL 30 DAY), 0) AS actividad_30_dias,
    COALESCE(SUM(COALESCE(s.importe_autorizado, s.importe, 0)), 0) AS importe_total,
    COALESCE(SUM(
      (s.fecha_pago IS NOT NULL AND s.fecha_pago >= NOW() - INTERVAL 30 DAY)
      * COALESCE(s.importe_autorizado, s.importe, 0)
    ), 0) AS importe_acreditado_30_dias
  FROM coseguro_estado ce
  LEFT JOIN coseguro_solicitud s
    ON s.estado_id = ce.id AND s.eliminado = 0
  GROUP BY ce.id, ce.nombre, ce.orden
  ORDER BY ce.orden, ce.id`;

const SQL_TRASLADOS = `
  /* dashboard:traslados */
  SELECT
    te.id AS estado_id,
    te.nombre,
    COUNT(ts.id) AS cantidad,
    MIN(ts.fecha_creacion) AS mas_antiguo,
    COALESCE(SUM(ts.fecha_creacion >= NOW() - INTERVAL 30 DAY), 0) AS actividad_30_dias,
    COALESCE(SUM(ts.fecha_concretada >= NOW() - INTERVAL 30 DAY), 0) AS concretados_30_dias
  FROM traslado_estado te
  LEFT JOIN traslado_solicitud ts
    ON ts.estado_id = te.id AND ts.eliminado = 0
  GROUP BY te.id, te.nombre, te.orden
  ORDER BY te.orden, te.id`;

const SQL_NOTICIAS = `
  /* dashboard:noticias */
  SELECT
    estados.estado,
    COUNT(n.id) AS cantidad,
    MIN(n.fecha_creacion) AS mas_antiguo,
    COALESCE(SUM(n.fecha_creacion >= NOW() - INTERVAL 30 DAY), 0) AS actividad_30_dias,
    COALESCE(SUM(
      n.estado = 'PUBLICADA'
      AND (n.fecha_publicacion IS NULL OR n.fecha_publicacion <= NOW())
    ), 0) AS publicadas,
    COALESCE(SUM(
      n.estado = 'PUBLICADA' AND n.fecha_publicacion > NOW()
    ), 0) AS programadas,
    COALESCE(SUM(
      n.destacada = 1
      AND n.estado = 'PUBLICADA'
      AND (n.fecha_publicacion IS NULL OR n.fecha_publicacion <= NOW())
    ), 0) AS destacadas
  FROM (
    SELECT 'BORRADOR' AS estado, 1 AS orden
    UNION ALL SELECT 'PUBLICADA', 2
    UNION ALL SELECT 'ARCHIVADA', 3
  ) estados
  LEFT JOIN noticia n ON n.estado = estados.estado AND n.eliminado = 0
  GROUP BY estados.estado, estados.orden
  ORDER BY estados.orden`;

const SQL_OLIMPIADAS = `
  /* dashboard:olimpiadas */
  SELECT
    (
      SELECT COUNT(*)
      FROM olimpiada o
      WHERE o.eliminado = 0
        AND o.habilitado = 'Y'
        AND CURDATE() BETWEEN o.fecha_inicio_inscripcion AND o.fecha_fin_inscripcion
    ) AS ediciones_activas,
    (
      SELECT COUNT(*)
      FROM olimpiada_inscripcion oi
      INNER JOIN olimpiada o ON o.id = oi.olimpiada_id
      WHERE oi.eliminado = 0
        AND oi.estado = 'VALIDADO'
        AND o.eliminado = 0
        AND o.habilitado = 'Y'
        AND CURDATE() BETWEEN o.fecha_inicio_inscripcion AND o.fecha_fin_inscripcion
    ) AS inscripciones_activas,
    (
      SELECT COUNT(*)
      FROM olimpiada_inscripcion oi
      WHERE oi.eliminado = 0
        AND oi.fecha_creacion >= NOW() - INTERVAL 30 DAY
    ) AS actividad_30_dias`;

const SQL_EVOLUCION = `
  /* dashboard:evolucion */
  SELECT
    DATE_FORMAT(actividad.fecha_creacion, '%Y-%m') AS mes,
    SUM(actividad.modulo = 'reservas') AS reservas,
    SUM(actividad.modulo = 'usuarios') AS usuarios,
    SUM(actividad.modulo = 'coseguro') AS coseguro,
    SUM(actividad.modulo = 'traslados') AS traslados,
    SUM(actividad.modulo = 'noticias') AS noticias,
    SUM(actividad.modulo = 'olimpiadas') AS olimpiadas,
    SUM(actividad.modulo = 'beneficios') AS beneficios
  FROM (
    SELECT fecha_creacion, 'reservas' AS modulo
    FROM reserva
    WHERE fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion, 'usuarios' AS modulo
    FROM usuario
    WHERE fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion, 'coseguro' AS modulo
    FROM coseguro_solicitud
    WHERE eliminado = 0 AND fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion, 'traslados' AS modulo
    FROM traslado_solicitud
    WHERE eliminado = 0 AND fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion, 'noticias' AS modulo
    FROM noticia
    WHERE eliminado = 0 AND fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion, 'olimpiadas' AS modulo
    FROM olimpiada_inscripcion
    WHERE eliminado = 0 AND fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion, 'beneficios' AS modulo
    FROM beneficio_inscripcion
    WHERE eliminado = 0 AND fecha_creacion >= ?
  ) actividad
  GROUP BY DATE_FORMAT(actividad.fecha_creacion, '%Y-%m')
  ORDER BY mes`;

const SQL_CONVERSACIONES = `
  /* dashboard:conversaciones */
  -- mas_antiguo: el último mensaje del afiliado más viejo entre los hilos que
  -- esperan respuesta (la antigüedad de la bandeja de mensajes).
  SELECT 'reservas' AS modulo, COUNT(*) AS sin_responder, MIN(ro.fecha_creacion) AS mas_antiguo
  FROM reserva_observacion ro
  INNER JOIN (
    SELECT reserva_id, MAX(id) AS ultimo_id
    FROM reserva_observacion
    GROUP BY reserva_id
  ) ult ON ult.ultimo_id = ro.id
  WHERE ro.usuario_rol = 'afiliado'
  UNION ALL
  SELECT 'coseguro', COUNT(*), MIN(co.fecha_creacion)
  FROM coseguro_observacion co
  INNER JOIN (
    SELECT solicitud_id, MAX(id) AS ultimo_id
    FROM coseguro_observacion
    GROUP BY solicitud_id
  ) ult ON ult.ultimo_id = co.id
  INNER JOIN coseguro_solicitud cs ON cs.id = co.solicitud_id AND cs.eliminado = 0
  INNER JOIN coseguro_estado ces ON ces.id = cs.estado_id AND ces.nombre <> 'Solicitud cancelada'
  WHERE co.usuario_rol = 'afiliado'
  UNION ALL
  SELECT 'traslados', COUNT(*), MIN(tro.fecha_creacion)
  FROM traslado_observacion tro
  INNER JOIN (
    SELECT solicitud_id, MAX(id) AS ultimo_id
    FROM traslado_observacion
    GROUP BY solicitud_id
  ) ult ON ult.ultimo_id = tro.id
  INNER JOIN traslado_solicitud tsol ON tsol.id = tro.solicitud_id AND tsol.eliminado = 0
  INNER JOIN traslado_estado tes ON tes.id = tsol.estado_id AND tes.nombre <> 'Cancelada'
  WHERE tro.usuario_rol = 'afiliado'
  UNION ALL
  SELECT 'olimpiadas', COUNT(*), MIN(oo.fecha_creacion)
  FROM olimpiada_inscripcion_observacion oo
  INNER JOIN (
    SELECT inscripcion_id, MAX(id) AS ultimo_id
    FROM olimpiada_inscripcion_observacion
    GROUP BY inscripcion_id
  ) ult ON ult.ultimo_id = oo.id
  INNER JOIN olimpiada_inscripcion oi
    ON oi.id = oo.inscripcion_id AND oi.eliminado = 0 AND oi.estado <> 'CANCELADO'
  WHERE oo.usuario_rol = 'afiliado'`;

const SQL_ACTIVIDAD_DIARIA = `
  /* dashboard:actividad_diaria */
  SELECT
    DATE_FORMAT(actividad.fecha_creacion, '%Y-%m-%d') AS dia,
    COUNT(*) AS total
  FROM (
    SELECT fecha_creacion FROM reserva WHERE fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion FROM usuario WHERE fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion FROM coseguro_solicitud WHERE eliminado = 0 AND fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion FROM traslado_solicitud WHERE eliminado = 0 AND fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion FROM noticia WHERE eliminado = 0 AND fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion FROM olimpiada_inscripcion WHERE eliminado = 0 AND fecha_creacion >= ?
    UNION ALL
    SELECT fecha_creacion FROM beneficio_inscripcion WHERE eliminado = 0 AND fecha_creacion >= ?
  ) actividad
  GROUP BY DATE_FORMAT(actividad.fecha_creacion, '%Y-%m-%d')
  ORDER BY dia`;

// Bandejas nuevas: cada una va en una consulta opcional (si falla, el tablero
// responde igual y ese ítem no se agrega).
const SQL_FAMILIARES_PENDIENTES = `
  /* dashboard:familiares_pendientes */
  SELECT COUNT(*) AS cantidad, MIN(f.fecha_creacion) AS mas_antiguo
  FROM familiar_cambio_solicitud f
  WHERE f.estado = 'PENDIENTE'`;

const SQL_OLIMPIADAS_POR_VALIDAR = `
  /* dashboard:olimpiadas_por_validar */
  SELECT COUNT(*) AS cantidad, MIN(oi.fecha_creacion) AS mas_antiguo
  FROM olimpiada_inscripcion oi
  INNER JOIN olimpiada o ON o.id = oi.olimpiada_id AND o.eliminado = 0
  WHERE oi.eliminado = 0 AND oi.estado = 'PENDIENTE'`;

// "Por aprobar" cuenta sólo Pendiente (estado_id = 1): Observado (2) espera a
// la departamental, no al staff central.
const SQL_BENEFICIOS = `
  /* dashboard:beneficios */
  SELECT
    COALESCE(SUM(b.estado_id = 3 AND b.habilitado = 1
      AND (b.fecha_vigencia_desde IS NULL OR b.fecha_vigencia_desde <= CURDATE())
      AND (b.fecha_vigencia_hasta IS NULL OR b.fecha_vigencia_hasta >= CURDATE())), 0) AS publicados,
    COALESCE(SUM(b.estado_id = 1), 0) AS por_aprobar,
    MIN(CASE WHEN b.estado_id = 1 THEN b.fecha_creacion END) AS mas_antiguo,
    (
      SELECT COUNT(*)
      FROM beneficio_inscripcion bi
      WHERE bi.eliminado = 0 AND bi.fecha_creacion >= NOW() - INTERVAL 30 DAY
    ) AS inscripciones_30_dias
  FROM beneficio b
  WHERE b.eliminado = 0`;

const SQL_DESTINOS = `
  /* dashboard:destinos */
  SELECT
    COALESCE(s.lugar, ch.ciudad) AS destino,
    COUNT(*) AS cantidad
  FROM reserva r
  LEFT JOIN servicio s ON s.id = r.servicio_id
  LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
  WHERE r.fecha_creacion >= NOW() - INTERVAL 90 DAY
    AND COALESCE(s.lugar, ch.ciudad) IS NOT NULL
  GROUP BY destino
  ORDER BY cantidad DESC, destino ASC
  LIMIT 3`;

const SQL_PRESENCIA = `
  /* dashboard:presencia */
  SELECT
    d.nombre,
    COUNT(u.id) AS usuarios
  FROM departamental d
  LEFT JOIN usuario u ON u.departamental_id = d.id AND u.habilitado = 'Y'
  WHERE d.habilitado = 'Y'
  GROUP BY d.id, d.nombre
  ORDER BY usuarios DESC, d.nombre ASC
  LIMIT 5`;

// Actividad agrupada a demanda (selector de período del gráfico del tablero).
// El formato SQL sale de esta whitelist, nunca del request.
const GRANULARIDADES = Object.freeze({
  dia: { formatoSql: "%Y-%m-%d", maxPeriodos: 92 },
  semana: { formatoSql: "%x-W%v", maxPeriodos: 60 },
  mes: { formatoSql: "%Y-%m", maxPeriodos: 36 },
  anio: { formatoSql: "%Y", maxPeriodos: 15 },
});

function construirSqlActividadAgrupada(formatoSql) {
  return `
  /* dashboard:actividad_agrupada */
  SELECT
    DATE_FORMAT(actividad.fecha_creacion, '${formatoSql}') AS periodo,
    SUM(actividad.modulo = 'reservas') AS reservas,
    SUM(actividad.modulo = 'usuarios') AS usuarios,
    SUM(actividad.modulo = 'coseguro') AS coseguro,
    SUM(actividad.modulo = 'traslados') AS traslados,
    SUM(actividad.modulo = 'noticias') AS noticias,
    SUM(actividad.modulo = 'olimpiadas') AS olimpiadas,
    SUM(actividad.modulo = 'beneficios') AS beneficios
  FROM (
    SELECT fecha_creacion, 'reservas' AS modulo
    FROM reserva
    WHERE fecha_creacion >= ? AND fecha_creacion < ?
    UNION ALL
    SELECT fecha_creacion, 'usuarios' AS modulo
    FROM usuario
    WHERE fecha_creacion >= ? AND fecha_creacion < ?
    UNION ALL
    SELECT fecha_creacion, 'coseguro' AS modulo
    FROM coseguro_solicitud
    WHERE eliminado = 0 AND fecha_creacion >= ? AND fecha_creacion < ?
    UNION ALL
    SELECT fecha_creacion, 'traslados' AS modulo
    FROM traslado_solicitud
    WHERE eliminado = 0 AND fecha_creacion >= ? AND fecha_creacion < ?
    UNION ALL
    SELECT fecha_creacion, 'noticias' AS modulo
    FROM noticia
    WHERE eliminado = 0 AND fecha_creacion >= ? AND fecha_creacion < ?
    UNION ALL
    SELECT fecha_creacion, 'olimpiadas' AS modulo
    FROM olimpiada_inscripcion
    WHERE eliminado = 0 AND fecha_creacion >= ? AND fecha_creacion < ?
    UNION ALL
    SELECT fecha_creacion, 'beneficios' AS modulo
    FROM beneficio_inscripcion
    WHERE eliminado = 0 AND fecha_creacion >= ? AND fecha_creacion < ?
  ) actividad
  GROUP BY periodo
  ORDER BY periodo`;
}

// Cantidad de subconsultas de la UNION de actividad (un par desde/hasta cada una).
const MODULOS_ACTIVIDAD = 7;

function esFechaIso(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(texto || ""))) return false;
  const fecha = new Date(`${texto}T00:00:00.000Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === texto;
}

function aFechaUtc(texto) {
  return new Date(`${texto}T00:00:00.000Z`);
}

function aTextoIso(fecha) {
  return fecha.toISOString().slice(0, 10);
}

function inicioSemanaIso(fecha) {
  const lunes = new Date(fecha);
  const dia = lunes.getUTCDay() || 7;
  lunes.setUTCDate(lunes.getUTCDate() - dia + 1);
  return lunes;
}

// Clave "2026-W33" con la misma convención que DATE_FORMAT '%x-W%v' (ISO 8601).
function claveSemanaIso(fecha) {
  const jueves = new Date(fecha);
  const dia = jueves.getUTCDay() || 7;
  jueves.setUTCDate(jueves.getUTCDate() + 4 - dia);
  const anio = jueves.getUTCFullYear();
  const inicioAnio = new Date(Date.UTC(anio, 0, 1));
  const semana = Math.ceil(((jueves.getTime() - inicioAnio.getTime()) / 86400000 + 1) / 7);
  return `${anio}-W${String(semana).padStart(2, "0")}`;
}

// Enumera los períodos naturales completos que cubren [desde, hasta].
// Cada período lleva su clave (la que produce DATE_FORMAT) y su fecha de
// inicio, que el frontend usa para las etiquetas del eje.
function enumerarPeriodos(granularidad, desde, hasta) {
  const periodos = [];
  if (granularidad === "dia") {
    for (let f = new Date(desde); f <= hasta; f.setUTCDate(f.getUTCDate() + 1)) {
      periodos.push({ periodo: aTextoIso(f), inicio: aTextoIso(f) });
    }
  } else if (granularidad === "semana") {
    for (let f = inicioSemanaIso(desde); f <= hasta; f.setUTCDate(f.getUTCDate() + 7)) {
      periodos.push({ periodo: claveSemanaIso(f), inicio: aTextoIso(f) });
    }
  } else if (granularidad === "mes") {
    for (
      let f = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth(), 1));
      f <= hasta;
      f.setUTCMonth(f.getUTCMonth() + 1)
    ) {
      periodos.push({ periodo: aTextoIso(f).slice(0, 7), inicio: aTextoIso(f) });
    }
  } else {
    for (
      let f = new Date(Date.UTC(desde.getUTCFullYear(), 0, 1));
      f <= hasta;
      f.setUTCFullYear(f.getUTCFullYear() + 1)
    ) {
      periodos.push({ periodo: String(f.getUTCFullYear()), inicio: aTextoIso(f) });
    }
  }
  return periodos;
}

function finExclusivoPeriodos(granularidad, hasta) {
  const fin = new Date(hasta);
  if (granularidad === "dia") {
    fin.setUTCDate(fin.getUTCDate() + 1);
  } else if (granularidad === "semana") {
    const lunes = inicioSemanaIso(fin);
    lunes.setUTCDate(lunes.getUTCDate() + 7);
    return lunes;
  } else if (granularidad === "mes") {
    return new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() + 1, 1));
  } else {
    return new Date(Date.UTC(fin.getUTCFullYear() + 1, 0, 1));
  }
  return fin;
}

function validarActividadAgrupada({ granularidad, desde, hasta }) {
  const config = GRANULARIDADES[granularidad];
  if (!config) {
    return { error: "Granularidad inválida: usá dia, semana, mes o anio" };
  }
  if (!esFechaIso(desde) || !esFechaIso(hasta)) {
    return { error: "Las fechas deben tener formato YYYY-MM-DD" };
  }
  const fechaDesde = aFechaUtc(desde);
  const fechaHasta = aFechaUtc(hasta);
  if (fechaDesde > fechaHasta) {
    return { error: "La fecha desde no puede ser posterior a la fecha hasta" };
  }
  const periodos = enumerarPeriodos(granularidad, fechaDesde, fechaHasta);
  if (periodos.length > config.maxPeriodos) {
    return { error: `El rango es demasiado amplio para esa agrupación (máximo ${config.maxPeriodos} períodos)` };
  }
  return { config, fechaDesde, fechaHasta, periodos };
}

function completarPeriodos(rows, periodos) {
  const porPeriodo = new Map(rows.map((row) => [String(row.periodo), row]));
  return periodos.map(({ periodo, inicio }) => {
    const row = porPeriodo.get(periodo) || {};
    return {
      periodo,
      inicio,
      reservas: aEntero(row.reservas),
      usuarios: aEntero(row.usuarios),
      coseguro: aEntero(row.coseguro),
      traslados: aEntero(row.traslados),
      noticias: aEntero(row.noticias),
      olimpiadas: aEntero(row.olimpiadas),
      beneficios: aEntero(row.beneficios),
    };
  });
}

function crearServicioActividad({ conexion }) {
  async function obtener(params) {
    const validacion = validarActividadAgrupada(params);
    if (validacion.error) {
      return { error: validacion.error };
    }
    const { config, periodos } = validacion;
    const desdeSql = periodos[0].inicio;
    const hastaSql = aTextoIso(finExclusivoPeriodos(params.granularidad, validacion.fechaHasta));
    const parametros = Array.from({ length: MODULOS_ACTIVIDAD }, () => [desdeSql, hastaSql]).flat();
    const [rows] = await conexion.promise().query(construirSqlActividadAgrupada(config.formatoSql), parametros);
    return {
      granularidad: params.granularidad,
      desde: periodos[0].inicio,
      hasta: params.hasta,
      buckets: completarPeriodos(rows, periodos),
    };
  }

  return { obtener };
}

const PRIORIDAD_ATENCION = Object.freeze({
  ALTA: "alta",
  MEDIA: "media",
});

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero >= 0 ? numero : 0;
}

function aEntero(valor) {
  return Math.trunc(aNumero(valor));
}

function sumar(rows, campo) {
  return rows.reduce((total, row) => total + aNumero(row[campo]), 0);
}

function cantidadEstado(rows, nombres) {
  const permitidos = new Set(Array.isArray(nombres) ? nombres : [nombres]);
  return rows.reduce(
    (total, row) => total + (permitidos.has(row.nombre) ? aEntero(row.cantidad) : 0),
    0
  );
}

function filaEstado(rows, nombre) {
  return rows.find((row) => row.nombre === nombre) || null;
}

function porEstado(rows) {
  return rows.map((row) => ({
    estado_id: aEntero(row.estado_id),
    nombre: String(row.nombre || ""),
    cantidad: aEntero(row.cantidad),
  }));
}

// --- Antigüedad de las bandejas ---------------------------------------------
// mysql2 entrega los DATETIME como Date (la conexión usa -03:00); los textos
// sin huso que pudieran llegar se leen en hora argentina.
const HUSO_ARGENTINA = "-03:00";

function aInstante(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  const texto = String(valor).trim();
  const partes = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?))?$/.exec(texto);
  const fecha = partes
    ? new Date(`${partes[1]}T${partes[2] || "00:00:00"}${HUSO_ARGENTINA}`)
    : new Date(texto);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

// El más viejo de los valores, en ISO; null si la bandeja está en cero o no
// hay fecha válida.
function masAntiguoIso(cantidad, valores) {
  if (!(cantidad > 0)) return null;
  let minimo = null;
  for (const valor of valores) {
    const instante = aInstante(valor);
    if (instante && (!minimo || instante.getTime() < minimo.getTime())) minimo = instante;
  }
  return minimo ? minimo.toISOString() : null;
}

// Mismas listas de estados que cantidadEstado: sólo cuentan las filas con
// solicitudes en ese estado.
function fechasEstado(rows, nombres, campo = "nombre") {
  const permitidos = new Set(Array.isArray(nombres) ? nombres : [nombres]);
  return rows
    .filter((row) => permitidos.has(row[campo]) && aEntero(row.cantidad) > 0)
    .map((row) => row.mas_antiguo);
}

function fechasConversacion(rows, modulo) {
  return rows
    .filter((row) => String(row.modulo) === modulo && aEntero(row.sin_responder) > 0)
    .map((row) => row.mas_antiguo);
}

// Consulta de una bandeja opcional: si falla (tabla o permiso ausente en un
// entorno), el tablero responde igual y ese ítem no se agrega.
async function consultaOpcional(db, sql, params = []) {
  try {
    const [rows] = await db.query(sql, params);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn("Consulta opcional del tablero omitida:", error?.code || error?.message);
    return null;
  }
}

function mesActualArgentina(fecha) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(fecha);
  const year = partes.find((parte) => parte.type === "year")?.value;
  const month = partes.find((parte) => parte.type === "month")?.value;
  return `${year}-${month}`;
}

function diaActualArgentina(fecha) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(fecha);
}

function obtenerVentanaDias(fecha, cantidad) {
  const [year, month, day] = diaActualArgentina(fecha).split("-").map(Number);
  const dias = [];
  for (let offset = cantidad - 1; offset >= 0; offset -= 1) {
    const item = new Date(Date.UTC(year, month - 1, day - offset));
    dias.push(item.toISOString().slice(0, 10));
  }
  return dias;
}

function completarActividadDiaria(rows, dias) {
  const porDia = new Map(rows.map((row) => [String(row.dia), aEntero(row.total)]));
  return dias.map((dia) => ({ dia, total: porDia.get(dia) || 0 }));
}

function resumirConversaciones(rows) {
  const porModulo = new Map(
    rows.map((row) => [String(row.modulo), aEntero(row.sin_responder)])
  );
  const conversaciones = {
    reservas: porModulo.get("reservas") || 0,
    coseguro: porModulo.get("coseguro") || 0,
    traslados: porModulo.get("traslados") || 0,
    olimpiadas: porModulo.get("olimpiadas") || 0,
  };
  conversaciones.total = conversaciones.reservas + conversaciones.coseguro
    + conversaciones.traslados + conversaciones.olimpiadas;
  return conversaciones;
}

function obtenerVentanaMeses(fecha) {
  const [year, month] = mesActualArgentina(fecha).split("-").map(Number);
  const meses = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const item = new Date(Date.UTC(year, month - 1 - offset, 1));
    meses.push(`${item.getUTCFullYear()}-${String(item.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return meses;
}

function completarEvolucion(rows, meses) {
  const porMes = new Map(rows.map((row) => [String(row.mes), row]));
  return meses.map((mes) => {
    const row = porMes.get(mes) || {};
    return {
      mes,
      reservas: aEntero(row.reservas),
      usuarios: aEntero(row.usuarios),
      coseguro: aEntero(row.coseguro),
      traslados: aEntero(row.traslados),
      noticias: aEntero(row.noticias),
      olimpiadas: aEntero(row.olimpiadas),
      beneficios: aEntero(row.beneficios),
    };
  });
}

function construirRespuesta({
  generadoEn,
  meses,
  dias,
  redRows,
  turismoRows,
  coseguroRows,
  trasladosRows,
  noticiasRows,
  olimpiadasRows,
  evolucionRows,
  conversacionesRows,
  actividadDiariaRows,
  destinosRows,
  presenciaRows,
  // Consultas opcionales: null (o ausentes) = la consulta falló → sin ítem.
  familiaresRows = null,
  olimpiadasPorValidarRows = null,
  beneficiosRows = null,
}) {
  const red = redRows[0] || {};
  const olimpiadas = olimpiadasRows[0] || {};
  const coseguroPendienteAcreditacion = filaEstado(coseguroRows, "Pendiente de acreditación");
  const conversaciones = resumirConversaciones(conversacionesRows);

  const turismo = {
    total: aEntero(sumar(turismoRows, "cantidad")),
    por_aprobar: cantidadEstado(turismoRows, "Verificada"),
    proximas_30_dias: aEntero(sumar(turismoRows, "proximas_30_dias")),
    proximas_7_dias: aEntero(sumar(turismoRows, "proximas_7_dias")),
    actividad_30_dias: aEntero(sumar(turismoRows, "actividad_30_dias")),
    destinos_90_dias: destinosRows.map((row) => ({
      destino: String(row.destino || ""),
      cantidad: aEntero(row.cantidad),
    })),
    por_estado: porEstado(turismoRows),
  };

  const coseguro = {
    total: aEntero(sumar(coseguroRows, "cantidad")),
    por_revisar: cantidadEstado(coseguroRows, ["Solicitud iniciada", "Solicitud revisada"]),
    pendientes_central: cantidadEstado(coseguroRows, "Aprobado por departamental"),
    pendientes_acreditacion: cantidadEstado(coseguroRows, "Pendiente de acreditación"),
    importe_pendiente_acreditacion: aNumero(coseguroPendienteAcreditacion?.importe_total),
    importe_acreditado_30_dias: aNumero(sumar(coseguroRows, "importe_acreditado_30_dias")),
    actividad_30_dias: aEntero(sumar(coseguroRows, "actividad_30_dias")),
    por_estado: porEstado(coseguroRows),
  };

  const traslados = {
    total: aEntero(sumar(trasladosRows, "cantidad")),
    activos: cantidadEstado(trasladosRows, "Iniciada"),
    concretados_30_dias: aEntero(sumar(trasladosRows, "concretados_30_dias")),
    actividad_30_dias: aEntero(sumar(trasladosRows, "actividad_30_dias")),
    por_estado: porEstado(trasladosRows),
  };

  const noticias = {
    total: aEntero(sumar(noticiasRows, "cantidad")),
    publicadas: aEntero(sumar(noticiasRows, "publicadas")),
    borradores: noticiasRows.reduce(
      (total, row) => total + (row.estado === "BORRADOR" ? aEntero(row.cantidad) : 0),
      0
    ),
    programadas: aEntero(sumar(noticiasRows, "programadas")),
    destacadas: aEntero(sumar(noticiasRows, "destacadas")),
    actividad_30_dias: aEntero(sumar(noticiasRows, "actividad_30_dias")),
    por_estado: noticiasRows.map((row) => ({
      estado: String(row.estado || ""),
      cantidad: aEntero(row.cantidad),
    })),
  };

  const coseguroPorRevisar = ["Solicitud iniciada", "Solicitud revisada", "Aprobado por departamental"];
  const itemsAtencion = [
    {
      modulo: "turismo",
      clave: "reservas_por_aprobar",
      etiqueta: "Reservas por aprobar",
      cantidad: turismo.por_aprobar,
      ruta: "/reservas",
      prioridad: PRIORIDAD_ATENCION.ALTA,
      mas_antiguo: masAntiguoIso(turismo.por_aprobar, fechasEstado(turismoRows, "Verificada")),
    },
    {
      modulo: "coseguro",
      clave: "coseguro_por_revisar",
      etiqueta: "Reintegros por revisar",
      cantidad: coseguro.por_revisar + coseguro.pendientes_central,
      ruta: "/coseguro-medico",
      prioridad: PRIORIDAD_ATENCION.ALTA,
      mas_antiguo: masAntiguoIso(
        coseguro.por_revisar + coseguro.pendientes_central,
        fechasEstado(coseguroRows, coseguroPorRevisar)
      ),
    },
    {
      modulo: "coseguro",
      clave: "coseguro_por_acreditar",
      etiqueta: "Reintegros por acreditar",
      cantidad: coseguro.pendientes_acreditacion,
      ruta: "/coseguro-medico",
      prioridad: PRIORIDAD_ATENCION.MEDIA,
      mas_antiguo: masAntiguoIso(
        coseguro.pendientes_acreditacion,
        fechasEstado(coseguroRows, "Pendiente de acreditación")
      ),
    },
    {
      modulo: "traslados",
      clave: "traslados_activos",
      etiqueta: "Traslados activos",
      cantidad: traslados.activos,
      ruta: "/traslados-admin",
      prioridad: PRIORIDAD_ATENCION.MEDIA,
      mas_antiguo: masAntiguoIso(traslados.activos, fechasEstado(trasladosRows, "Iniciada")),
    },
    {
      modulo: "noticias",
      clave: "noticias_borrador",
      etiqueta: "Noticias en borrador",
      cantidad: noticias.borradores,
      ruta: "/noticias-admin",
      prioridad: PRIORIDAD_ATENCION.MEDIA,
      mas_antiguo: masAntiguoIso(noticias.borradores, fechasEstado(noticiasRows, "BORRADOR", "estado")),
    },
  ];

  if (Array.isArray(familiaresRows)) {
    const fila = familiaresRows[0] || {};
    const cantidad = aEntero(fila.cantidad);
    itemsAtencion.push({
      modulo: "familiares",
      clave: "familiares_por_aprobar",
      etiqueta: "Cambios de familiares por aprobar",
      cantidad,
      ruta: "/cambios-familiares",
      prioridad: PRIORIDAD_ATENCION.ALTA,
      mas_antiguo: masAntiguoIso(cantidad, [fila.mas_antiguo]),
    });
  }

  if (Array.isArray(olimpiadasPorValidarRows)) {
    const fila = olimpiadasPorValidarRows[0] || {};
    const cantidad = aEntero(fila.cantidad);
    itemsAtencion.push({
      modulo: "olimpiadas",
      clave: "olimpiadas_por_validar",
      etiqueta: "Inscripciones por validar",
      cantidad,
      ruta: "/olimpiadas-admin",
      prioridad: PRIORIDAD_ATENCION.ALTA,
      mas_antiguo: masAntiguoIso(cantidad, [fila.mas_antiguo]),
    });
  }

  let beneficios = null;
  if (Array.isArray(beneficiosRows)) {
    const fila = beneficiosRows[0] || {};
    beneficios = {
      publicados: aEntero(fila.publicados),
      por_aprobar: aEntero(fila.por_aprobar),
      inscripciones_30_dias: aEntero(fila.inscripciones_30_dias),
    };
    itemsAtencion.push({
      modulo: "beneficios",
      clave: "beneficios_por_aprobar",
      etiqueta: "Beneficios por aprobar",
      cantidad: beneficios.por_aprobar,
      ruta: "/beneficios-admin",
      prioridad: PRIORIDAD_ATENCION.ALTA,
      mas_antiguo: masAntiguoIso(beneficios.por_aprobar, [fila.mas_antiguo]),
    });
  }

  itemsAtencion.push(
    {
      modulo: "turismo",
      clave: "chat_reservas",
      etiqueta: "Mensajes sin responder",
      cantidad: conversaciones.reservas,
      ruta: "/reservas",
      prioridad: PRIORIDAD_ATENCION.MEDIA,
      mas_antiguo: masAntiguoIso(conversaciones.reservas, fechasConversacion(conversacionesRows, "reservas")),
    },
    {
      modulo: "coseguro",
      clave: "chat_coseguro",
      etiqueta: "Mensajes sin responder",
      cantidad: conversaciones.coseguro,
      ruta: "/coseguro-medico",
      prioridad: PRIORIDAD_ATENCION.MEDIA,
      mas_antiguo: masAntiguoIso(conversaciones.coseguro, fechasConversacion(conversacionesRows, "coseguro")),
    },
    {
      modulo: "traslados",
      clave: "chat_traslados",
      etiqueta: "Mensajes sin responder",
      cantidad: conversaciones.traslados,
      ruta: "/traslados-admin",
      prioridad: PRIORIDAD_ATENCION.MEDIA,
      mas_antiguo: masAntiguoIso(conversaciones.traslados, fechasConversacion(conversacionesRows, "traslados")),
    },
    {
      modulo: "olimpiadas",
      clave: "chat_olimpiadas",
      etiqueta: "Mensajes sin responder",
      cantidad: conversaciones.olimpiadas,
      ruta: "/olimpiadas-admin",
      prioridad: PRIORIDAD_ATENCION.MEDIA,
      mas_antiguo: masAntiguoIso(conversaciones.olimpiadas, fechasConversacion(conversacionesRows, "olimpiadas")),
    }
  );

  return {
    generado_en: generadoEn.toISOString(),
    atencion: {
      total: itemsAtencion.reduce((total, item) => total + item.cantidad, 0),
      items: itemsAtencion,
    },
    conversaciones,
    resumen_red: {
      usuarios: {
        total: aEntero(red.usuarios_total),
        habilitados: aEntero(red.usuarios_habilitados),
        nuevos_30_dias: aEntero(red.usuarios_nuevos_30_dias),
        familiares: aEntero(red.usuarios_familiares),
        staff: aEntero(red.usuarios_staff),
        composicion: {
          titulares: aEntero(red.composicion_titulares),
          familiares: aEntero(red.composicion_familiares),
          personal: aEntero(red.composicion_personal),
        },
      },
      departamentales: {
        total: aEntero(red.departamentales_total),
        habilitadas: aEntero(red.departamentales_habilitadas),
        con_usuarios: aEntero(red.departamentales_con_usuarios),
      },
      presencia: presenciaRows.map((row) => ({
        nombre: String(row.nombre || ""),
        usuarios: aEntero(row.usuarios),
      })),
    },
    modulos: {
      turismo,
      coseguro,
      traslados,
      noticias,
      olimpiadas: {
        ediciones_activas: aEntero(olimpiadas.ediciones_activas),
        inscripciones_activas: aEntero(olimpiadas.inscripciones_activas),
        actividad_30_dias: aEntero(olimpiadas.actividad_30_dias),
      },
      ...(beneficios ? { beneficios } : {}),
    },
    evolucion: completarEvolucion(evolucionRows, meses),
    actividad_diaria: completarActividadDiaria(actividadDiariaRows, dias),
  };
}

function cacheMsDesdeEntorno() {
  const valor = Number(process.env.DASHBOARD_CACHE_MS || 30000);
  return Number.isFinite(valor) && valor >= 5000 && valor <= 300000 ? valor : 30000;
}

function crearServicioDashboard({ conexion, ahora = () => new Date(), cacheMs = cacheMsDesdeEntorno() }) {
  let cache = null;
  let cargaEnCurso = null;

  async function cargar() {
    const generadoEn = ahora();
    const meses = obtenerVentanaMeses(generadoEn);
    const dias = obtenerVentanaDias(generadoEn, 14);
    const desde = `${meses[0]}-01`;
    const desdeDia = dias[0];
    const db = conexion.promise();
    const [resultados, opcionales] = await Promise.all([
      Promise.all([
        db.query(SQL_RED),
        db.query(SQL_TURISMO),
        db.query(SQL_COSEGURO),
        db.query(SQL_TRASLADOS),
        db.query(SQL_NOTICIAS),
        db.query(SQL_OLIMPIADAS),
        db.query(SQL_EVOLUCION, Array(MODULOS_ACTIVIDAD).fill(desde)),
        db.query(SQL_CONVERSACIONES),
        db.query(SQL_ACTIVIDAD_DIARIA, Array(MODULOS_ACTIVIDAD).fill(desdeDia)),
        db.query(SQL_DESTINOS),
        db.query(SQL_PRESENCIA),
      ]),
      Promise.all([
        consultaOpcional(db, SQL_FAMILIARES_PENDIENTES),
        consultaOpcional(db, SQL_OLIMPIADAS_POR_VALIDAR),
        consultaOpcional(db, SQL_BENEFICIOS),
      ]),
    ]);

    return construirRespuesta({
      generadoEn,
      meses,
      dias,
      redRows: resultados[0][0],
      turismoRows: resultados[1][0],
      coseguroRows: resultados[2][0],
      trasladosRows: resultados[3][0],
      noticiasRows: resultados[4][0],
      olimpiadasRows: resultados[5][0],
      evolucionRows: resultados[6][0],
      conversacionesRows: resultados[7][0],
      actividadDiariaRows: resultados[8][0],
      destinosRows: resultados[9][0],
      presenciaRows: resultados[10][0],
      familiaresRows: opcionales[0],
      olimpiadasPorValidarRows: opcionales[1],
      beneficiosRows: opcionales[2],
    });
  }

  async function obtener() {
    const timestamp = Date.now();
    if (cache && timestamp - cache.timestamp < cacheMs) return cache.valor;
    if (cargaEnCurso) return cargaEnCurso;

    cargaEnCurso = cargar()
      .then((valor) => {
        cache = { timestamp: Date.now(), valor };
        return valor;
      })
      .finally(() => {
        cargaEnCurso = null;
      });
    return cargaEnCurso;
  }

  return { obtener };
}

module.exports = {
  crearServicioDashboard,
  crearServicioActividad,
  __test: {
    enumerarPeriodos,
    claveSemanaIso,
    validarActividadAgrupada,
    completarPeriodos,
    finExclusivoPeriodos,
    construirRespuesta,
    completarEvolucion,
    obtenerVentanaMeses,
    obtenerVentanaDias,
    completarActividadDiaria,
    resumirConversaciones,
    consultaOpcional,
    masAntiguoIso,
    SQL_EVOLUCION,
    SQL_ACTIVIDAD_DIARIA,
    SQL_FAMILIARES_PENDIENTES,
    SQL_OLIMPIADAS_POR_VALIDAR,
    SQL_BENEFICIOS,
  },
};
