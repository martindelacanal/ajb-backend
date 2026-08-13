"use strict";

const SQL_RED = `
  /* dashboard:red */
  SELECT
    COUNT(*) AS usuarios_total,
    COALESCE(SUM(u.habilitado = 'Y'), 0) AS usuarios_habilitados,
    COALESCE(SUM(u.fecha_creacion >= NOW() - INTERVAL 30 DAY), 0) AS usuarios_nuevos_30_dias,
    (SELECT COUNT(*) FROM departamental) AS departamentales_total,
    (SELECT COUNT(*) FROM departamental d WHERE d.habilitado = 'Y') AS departamentales_habilitadas
  FROM usuario u`;

const SQL_TURISMO = `
  /* dashboard:turismo */
  SELECT
    er.id AS estado_id,
    er.nombre,
    COUNT(r.id) AS cantidad,
    COALESCE(SUM(r.fecha_creacion >= NOW() - INTERVAL 30 DAY), 0) AS actividad_30_dias,
    COALESCE(SUM(
      r.fecha_inicio >= CURDATE()
      AND r.fecha_inicio < DATE_ADD(CURDATE(), INTERVAL 31 DAY)
      AND er.nombre IN ('Aprobada', 'Adjudicada', 'Convenio aceptado')
    ), 0) AS proximas_30_dias
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
    COALESCE(SUM(s.fecha_creacion >= NOW() - INTERVAL 30 DAY), 0) AS actividad_30_dias,
    COALESCE(SUM(COALESCE(s.importe_autorizado, s.importe, 0)), 0) AS importe_total
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
    SUM(actividad.modulo = 'noticias') AS noticias
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
  ) actividad
  GROUP BY DATE_FORMAT(actividad.fecha_creacion, '%Y-%m')
  ORDER BY mes`;

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
    };
  });
}

function construirRespuesta({
  generadoEn,
  meses,
  redRows,
  turismoRows,
  coseguroRows,
  trasladosRows,
  noticiasRows,
  olimpiadasRows,
  evolucionRows,
}) {
  const red = redRows[0] || {};
  const olimpiadas = olimpiadasRows[0] || {};
  const coseguroPendienteAcreditacion = filaEstado(coseguroRows, "Pendiente de acreditación");

  const turismo = {
    total: aEntero(sumar(turismoRows, "cantidad")),
    por_aprobar: cantidadEstado(turismoRows, "Verificada"),
    proximas_30_dias: aEntero(sumar(turismoRows, "proximas_30_dias")),
    actividad_30_dias: aEntero(sumar(turismoRows, "actividad_30_dias")),
    por_estado: porEstado(turismoRows),
  };

  const coseguro = {
    total: aEntero(sumar(coseguroRows, "cantidad")),
    por_revisar: cantidadEstado(coseguroRows, ["Solicitud iniciada", "Solicitud revisada"]),
    pendientes_central: cantidadEstado(coseguroRows, "Aprobado por departamental"),
    pendientes_acreditacion: cantidadEstado(coseguroRows, "Pendiente de acreditación"),
    importe_pendiente_acreditacion: aNumero(coseguroPendienteAcreditacion?.importe_total),
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

  const itemsAtencion = [
    {
      modulo: "turismo",
      clave: "reservas_por_aprobar",
      etiqueta: "Reservas por aprobar",
      cantidad: turismo.por_aprobar,
      ruta: "/reservas",
      prioridad: PRIORIDAD_ATENCION.ALTA,
    },
    {
      modulo: "coseguro",
      clave: "coseguro_por_revisar",
      etiqueta: "Reintegros por revisar",
      cantidad: coseguro.por_revisar + coseguro.pendientes_central,
      ruta: "/coseguro-medico",
      prioridad: PRIORIDAD_ATENCION.ALTA,
    },
    {
      modulo: "traslados",
      clave: "traslados_activos",
      etiqueta: "Traslados activos",
      cantidad: traslados.activos,
      ruta: "/traslados-admin",
      prioridad: PRIORIDAD_ATENCION.MEDIA,
    },
    {
      modulo: "noticias",
      clave: "noticias_borrador",
      etiqueta: "Noticias en borrador",
      cantidad: noticias.borradores,
      ruta: "/noticias-admin",
      prioridad: PRIORIDAD_ATENCION.MEDIA,
    },
  ];

  return {
    generado_en: generadoEn.toISOString(),
    atencion: {
      total: itemsAtencion.reduce((total, item) => total + item.cantidad, 0),
      items: itemsAtencion,
    },
    resumen_red: {
      usuarios: {
        total: aEntero(red.usuarios_total),
        habilitados: aEntero(red.usuarios_habilitados),
        nuevos_30_dias: aEntero(red.usuarios_nuevos_30_dias),
      },
      departamentales: {
        total: aEntero(red.departamentales_total),
        habilitadas: aEntero(red.departamentales_habilitadas),
      },
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
    },
    evolucion: completarEvolucion(evolucionRows, meses),
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
    const desde = `${meses[0]}-01`;
    const db = conexion.promise();
    const resultados = await Promise.all([
      db.query(SQL_RED),
      db.query(SQL_TURISMO),
      db.query(SQL_COSEGURO),
      db.query(SQL_TRASLADOS),
      db.query(SQL_NOTICIAS),
      db.query(SQL_OLIMPIADAS),
      db.query(SQL_EVOLUCION, [desde, desde, desde, desde, desde]),
    ]);

    return construirRespuesta({
      generadoEn,
      meses,
      redRows: resultados[0][0],
      turismoRows: resultados[1][0],
      coseguroRows: resultados[2][0],
      trasladosRows: resultados[3][0],
      noticiasRows: resultados[4][0],
      olimpiadasRows: resultados[5][0],
      evolucionRows: resultados[6][0],
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
  __test: {
    construirRespuesta,
    completarEvolucion,
    obtenerVentanaMeses,
    SQL_EVOLUCION,
  },
};
