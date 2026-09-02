"use strict";

const crypto = require("crypto");
const {
  normalizarFechaCivil,
  obtenerNochesReserva,
  validarRangoReservaTemporal,
} = require("./valores-dominio");

const TABLA_HOLDS = "turismo_reserva_hold";
const HOLD_TTL_MINUTOS = 20;
const HOLD_ESTADO_ACTIVO = "ACTIVO";
const HOLD_ESTADO_CONSUMIDO = "CONSUMIDO";
const HOLD_ESTADO_LIBERADO = "LIBERADO";
const HOLD_ESTADO_VENCIDO = "VENCIDO";
const MODALIDAD_FECHA_LIBRE = "FECHA_LIBRE";
const MODALIDAD_BLOQUE = "BLOQUE";
const LOCK_EXPIRACION_HOLDS = "ajb:turismo:reserva-holds:expiracion:v1";
const TOKEN_MIN_LENGTH = 32;
const TOKEN_MAX_LENGTH = 200;

const HOLD_VENCIDO_MENSAJE =
  "Se terminó el tiempo para completar la reserva. Liberamos el alojamiento para que otras personas puedan elegirlo.";
const HOLD_CONFLICTO_MENSAJE =
  "Este alojamiento acaba de ser elegido por otra persona. Te ayudamos a buscar otra opción.";

const SELECT_HOLD_FIELDS = `
  h.id,
  h.actor_usuario_id,
  h.titular_usuario_id,
  h.servicio_id,
  h.recurso_id,
  h.bloque_fecha_id,
  h.modalidad,
  DATE_FORMAT(h.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
  DATE_FORMAT(h.fecha_fin, '%Y-%m-%d') AS fecha_fin,
  h.numero_parcela,
  h.estado,
  h.reserva_id,
  ROUND(UNIX_TIMESTAMP(h.vence_en) * 1000) AS expira_en_ms,
  ROUND(UNIX_TIMESTAMP(NOW(6)) * 1000) AS servidor_ahora_ms
`;

function crearErrorHold(message, statusCode, codigo, detalles = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.codigo = codigo;
  if (detalles) error.detalles = detalles;
  return error;
}

function crearErrorHoldVencido() {
  return crearErrorHold(HOLD_VENCIDO_MENSAJE, 410, "HOLD_VENCIDO");
}

function esErrorTablaHoldNoMigrada(error) {
  return error?.code === "ER_NO_SUCH_TABLE" || error?.errno === 1146;
}

function convertirErrorTablaHold(error) {
  if (!esErrorTablaHoldNoMigrada(error)) return error;
  return crearErrorHold(
    "La reserva temporal de Turismo todavía no está disponible.",
    503,
    "TURISMO_HOLDS_NO_MIGRADO"
  );
}

function normalizarIdPositivo(valor) {
  if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) return null;
  if (!["string", "number"].includes(typeof valor)) return null;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

function normalizarModalidadHold(valor) {
  const modalidad = String(valor || MODALIDAD_FECHA_LIBRE).trim().toUpperCase();
  return [MODALIDAD_FECHA_LIBRE, MODALIDAD_BLOQUE].includes(modalidad) ? modalidad : null;
}

function normalizarTokenHold(token, { requerido = true } = {}) {
  if (token === undefined || token === null || token === "") {
    if (!requerido) return null;
    throw crearErrorHold("Falta el token de la reserva temporal.", 400, "HOLD_TOKEN_REQUERIDO");
  }
  if (typeof token !== "string") {
    throw crearErrorHold("El token de la reserva temporal no es válido.", 400, "HOLD_TOKEN_INVALIDO");
  }
  const normalizado = token.trim();
  if (
    normalizado.length < TOKEN_MIN_LENGTH ||
    normalizado.length > TOKEN_MAX_LENGTH ||
    !/^[A-Za-z0-9._~-]+$/.test(normalizado)
  ) {
    throw crearErrorHold("El token de la reserva temporal no es válido.", 400, "HOLD_TOKEN_INVALIDO");
  }
  return normalizado;
}

function generarTokenHold() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashTokenHold(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

function hashTokenCoincide(valorPersistido, hashEsperado) {
  const persistido = Buffer.from(valorPersistido || []);
  return persistido.length === hashEsperado.length && crypto.timingSafeEqual(persistido, hashEsperado);
}

function isoDesdeEpoch(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return new Date(numero).toISOString();
}

function mapearHold(row, { incluirToken = null, reemplazado = undefined } = {}) {
  if (!row) return null;
  const expiraEnMs = Number(row.expira_en_ms);
  const servidorAhoraMs = Number(row.servidor_ahora_ms);
  const resultado = {
    id: Number(row.id),
    estado: String(row.estado || ""),
    actor_usuario_id: Number(row.actor_usuario_id),
    titular_usuario_id: row.titular_usuario_id == null ? null : Number(row.titular_usuario_id),
    servicio_id: Number(row.servicio_id),
    recurso_id: Number(row.recurso_id),
    bloque_fecha_id: row.bloque_fecha_id == null ? null : Number(row.bloque_fecha_id),
    modalidad: row.modalidad,
    fecha_inicio: normalizarFechaCivil(row.fecha_inicio),
    fecha_fin: normalizarFechaCivil(row.fecha_fin),
    numero_parcela: row.numero_parcela == null ? null : Number(row.numero_parcela),
    expira_en: isoDesdeEpoch(expiraEnMs),
    servidor_ahora: isoDesdeEpoch(servidorAhoraMs),
    segundos_restantes: Math.max(0, Math.floor((expiraEnMs - servidorAhoraMs) / 1000)),
  };
  if (incluirToken) resultado.hold_token = incluirToken;
  if (reemplazado !== undefined) resultado.reemplazado = Boolean(reemplazado);
  return resultado;
}

function mismoCriterioHold(row, datos) {
  return (
    Number(row.servicio_id) === Number(datos.servicioId) &&
    Number(row.recurso_id) === Number(datos.recursoId) &&
    (row.bloque_fecha_id == null ? null : Number(row.bloque_fecha_id)) === datos.bloqueFechaId &&
    String(row.modalidad) === datos.modalidad &&
    normalizarFechaCivil(row.fecha_inicio) === datos.fechaInicio &&
    normalizarFechaCivil(row.fecha_fin) === datos.fechaFin &&
    (row.titular_usuario_id == null ? null : Number(row.titular_usuario_id)) === datos.titularUsuarioId
  );
}

function normalizarDatosAdquisicion(params) {
  const actorUsuarioId = normalizarIdPositivo(params.actorUsuarioId);
  const titularUsuarioId = params.titularUsuarioId == null
    ? null
    : normalizarIdPositivo(params.titularUsuarioId);
  const servicioId = normalizarIdPositivo(params.servicioId);
  const recursoId = normalizarIdPositivo(params.recursoId);
  const modalidad = normalizarModalidadHold(params.modalidad);
  const bloqueFechaId = params.bloqueFechaId == null
    ? null
    : normalizarIdPositivo(params.bloqueFechaId);
  const fechaInicio = normalizarFechaCivil(params.fechaInicio);
  const fechaFin = normalizarFechaCivil(params.fechaFin);
  const validacionTemporal = fechaInicio && fechaFin
    ? validarRangoReservaTemporal(fechaInicio, fechaFin)
    : { valido: false };

  if (
    !actorUsuarioId || !servicioId || !recursoId || !modalidad || !fechaInicio || !fechaFin ||
    fechaInicio >= fechaFin || !validacionTemporal.valido ||
    (params.titularUsuarioId != null && !titularUsuarioId) ||
    (params.totalPersonas != null && (!Number.isSafeInteger(Number(params.totalPersonas)) || Number(params.totalPersonas) <= 0)) ||
    (modalidad === MODALIDAD_BLOQUE && !bloqueFechaId) ||
    (modalidad === MODALIDAD_FECHA_LIBRE && bloqueFechaId !== null)
  ) {
    throw crearErrorHold(
      "Los datos para reservar temporalmente el alojamiento no son válidos.",
      400,
      "HOLD_DATOS_INVALIDOS"
    );
  }
  return {
    actorUsuarioId,
    actorRol: String(params.actorRol || "").trim().toLowerCase(),
    actorDepartamentalId: normalizarIdPositivo(params.actorDepartamentalId),
    titularUsuarioId,
    servicioId,
    recursoId,
    modalidad,
    bloqueFechaId,
    fechaInicio,
    fechaFin,
    totalPersonas: params.totalPersonas == null ? null : Number(params.totalPersonas),
  };
}

async function bloquearYValidarUsuarios(connection, datos) {
  const ids = [...new Set([datos.actorUsuarioId, datos.titularUsuarioId].filter(Boolean))].sort((a, b) => a - b);
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await connection.query(
    `SELECT u.id, u.habilitado, u.departamental_id, u.area_turismo, u.modulo_turismo, r.nombre AS rol
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.id IN (${placeholders})
      ORDER BY u.id
      FOR UPDATE`,
    ids
  );
  const usuarios = new Map(rows.map((row) => [Number(row.id), row]));
  const actor = usuarios.get(datos.actorUsuarioId);
  if (!actor || actor.habilitado !== "Y") {
    throw crearErrorHold("La sesión ya no está habilitada.", 403, "HOLD_NO_AUTORIZADO");
  }
  const rolActual = String(actor.rol || "").trim().toLowerCase();
  datos.actorRol = rolActual;
  datos.actorDepartamentalId = normalizarIdPositivo(actor.departamental_id);
  if (!['admin', 'departamental', 'afiliado'].includes(rolActual)) {
    throw crearErrorHold("No tienes permisos para reservar este alojamiento.", 403, "HOLD_NO_AUTORIZADO");
  }
  if (rolActual === "departamental" && actor.area_turismo != null && Number(actor.area_turismo) !== 1) {
    throw crearErrorHold("No tienes habilitada el área Turismo.", 403, "HOLD_NO_AUTORIZADO");
  }

  if (rolActual === "afiliado") {
    if (datos.titularUsuarioId !== datos.actorUsuarioId) {
      throw crearErrorHold("No tienes permisos para reservar para otra persona.", 403, "HOLD_NO_AUTORIZADO");
    }
    if (actor.modulo_turismo != null && Number(actor.modulo_turismo) !== 1) {
      throw crearErrorHold("No tienes habilitado el módulo Turismo.", 403, "HOLD_NO_AUTORIZADO");
    }
    datos.departamentalVisibilidadId = normalizarIdPositivo(actor.departamental_id);
    return;
  }

  if (datos.titularUsuarioId == null) {
    datos.departamentalVisibilidadId = normalizarIdPositivo(actor.departamental_id);
    return;
  }
  const titular = usuarios.get(datos.titularUsuarioId);
  if (
    !titular || titular.habilitado !== "Y" ||
    String(titular.rol || "").trim().toLowerCase() !== "afiliado" ||
    (titular.modulo_turismo != null && Number(titular.modulo_turismo) !== 1)
  ) {
    throw crearErrorHold(
      "El titular debe ser un afiliado habilitado para Turismo.",
      422,
      "HOLD_TITULAR_INVALIDO"
    );
  }
  if (
    rolActual === "departamental" &&
    Number(actor.departamental_id) !== Number(titular.departamental_id)
  ) {
    throw crearErrorHold(
      "No puedes reservar para afiliados de otra departamental.",
      403,
      "HOLD_NO_AUTORIZADO"
    );
  }
  datos.departamentalVisibilidadId = normalizarIdPositivo(titular.departamental_id);
}

async function obtenerHoldPorId(connection, holdId, { forUpdate = false } = {}) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.query(
    `SELECT ${SELECT_HOLD_FIELDS}
       FROM ${TABLA_HOLDS} h
      WHERE h.id = ?
      LIMIT 1${lock}`,
    [holdId]
  );
  return rows[0] || null;
}

async function obtenerHoldActivoActor(connection, actorUsuarioId, { forUpdate = false } = {}) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.query(
    `SELECT ${SELECT_HOLD_FIELDS}, h.token_hash
       FROM ${TABLA_HOLDS} h
      WHERE h.actor_usuario_id = ?
        AND h.estado = 'ACTIVO'
      LIMIT 1${lock}`,
    [actorUsuarioId]
  );
  return rows[0] || null;
}

async function bloquearRecursos(connection, recursoIds, servicioIdEsperado, datos) {
  const ids = [...new Set(recursoIds.filter(Boolean).map(Number))].sort((a, b) => a - b);
  const placeholders = ids.map(() => "?").join(",");
  const params = [...ids];
  let visibilidad = "";
  if (datos.actorRol !== "admin") {
    const dep = normalizarIdPositivo(datos.departamentalVisibilidadId);
    if (dep) {
      visibilidad = `AND (
        s.alcance_departamental = 'TODAS'
        OR (s.alcance_departamental = 'PROPIA' AND s.propietario_departamental_id = ?)
        OR (s.alcance_departamental = 'SELECCIONADAS' AND EXISTS (
          SELECT 1 FROM servicio_departamental_visible sdv
           WHERE sdv.servicio_id = s.id AND sdv.departamental_id = ?
        ))
      )`;
      params.push(dep, dep);
    } else {
      visibilidad = "AND s.alcance_departamental = 'TODAS'";
    }
  }
  const [rows] = await connection.query(
    `SELECT r.id, r.servicio_id, r.cupo_maximo, r.es_recurso_principal,
            s.max_personas_reserva, s.modelo_tarifa, ts.codigo AS tipo_codigo
       FROM recurso r
       INNER JOIN servicio s ON s.id = r.servicio_id
       INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
      WHERE r.id IN (${placeholders}) AND r.activo = 1
        AND s.activo = 1 AND s.estado_aprobacion = 'APROBADO' AND ts.activo = 1
        ${visibilidad}
      ORDER BY r.id
      FOR UPDATE`,
    params
  );
  const nuevo = rows.find((row) => Number(row.id) === Number(recursoIds.at(-1)));
  if (!nuevo || Number(nuevo.servicio_id) !== Number(servicioIdEsperado)) {
    throw crearErrorHold(
      "El alojamiento no pertenece al destino seleccionado.",
      422,
      "HOLD_RECURSO_INVALIDO"
    );
  }
  const maxPersonas = Number(nuevo.max_personas_reserva);
  if (nuevo.modelo_tarifa === "PRECIO_UNICO" && Number.isInteger(datos.totalPersonas) && datos.totalPersonas !== 1) {
    throw crearErrorHold(
      "Este servicio sólo admite la reserva del titular.",
      422,
      "PRECIO_UNICO_SOLO_TITULAR"
    );
  }
  if (
    Number.isInteger(datos.totalPersonas) && Number.isInteger(maxPersonas) && maxPersonas > 0 &&
    datos.totalPersonas > maxPersonas
  ) {
    throw crearErrorHold("La cantidad de personas supera el máximo del servicio.", 422, "HOLD_CAPACIDAD_EXCEDIDA");
  }
  return nuevo;
}

async function validarBloque(connection, datos) {
  const [rows] = await connection.query(
    `SELECT bf.id, bf.servicio_id, bf.modalidad, bf.estado,
            DATE_FORMAT(bf.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(bf.fecha_fin, '%Y-%m-%d') AS fecha_fin,
            s.estado AS sorteo_estado,
            bfr.estado AS recurso_estado,
            bfr.reserva_id
       FROM bloque_fecha bf
       INNER JOIN bloque_fecha_recurso bfr
         ON bfr.bloque_fecha_id = bf.id AND bfr.recurso_id = ?
       LEFT JOIN sorteo s ON s.id = bf.sorteo_id
      WHERE bf.id = ?
      LIMIT 1
      FOR UPDATE`,
    [datos.recursoId, datos.bloqueFechaId]
  );
  const bloque = rows[0];
  const ventaDirectaSorteo = bloque?.modalidad === "SORTEO" && bloque?.recurso_estado === "VENTA_DIRECTA";
  if (
    !bloque || bloque.estado !== "ACTIVO" ||
    Number(bloque.servicio_id) !== datos.servicioId ||
    normalizarFechaCivil(bloque.fecha_inicio) !== datos.fechaInicio ||
    normalizarFechaCivil(bloque.fecha_fin) !== datos.fechaFin ||
    !(bloque.modalidad === "BLOQUE" || ventaDirectaSorteo) ||
    !["DISPONIBLE", "VENTA_DIRECTA"].includes(bloque.recurso_estado) ||
    bloque.reserva_id != null
  ) {
    throw crearErrorHold(
      "El bloque seleccionado ya no está disponible. Elegí otra opción.",
      409,
      "HOLD_BLOQUE_NO_DISPONIBLE"
    );
  }
}

async function validarFechaLibreFueraDeBloque(connection, datos) {
  const [rows] = await connection.query(
    `SELECT bf.id, bf.modalidad, bfr.estado AS recurso_estado
       FROM bloque_fecha bf
       INNER JOIN bloque_fecha_recurso bfr
         ON bfr.bloque_fecha_id = bf.id AND bfr.recurso_id = ?
      WHERE bf.estado = 'ACTIVO'
        AND bfr.estado IN ('DISPONIBLE','SORTEO','VENTA_DIRECTA')
        AND bf.fecha_inicio < ?
        AND bf.fecha_fin > ?
      LIMIT 1
      FOR UPDATE`,
    [datos.recursoId, datos.fechaFin, datos.fechaInicio]
  );
  if (rows.length > 0) {
    const esSorteoAbierto = rows[0].modalidad === "SORTEO" && rows[0].recurso_estado !== "VENTA_DIRECTA";
    throw crearErrorHold(
      esSorteoAbierto
        ? "Esas fechas pertenecen a un sorteo y no necesitan una reserva temporal."
        : "Esas fechas se venden como bloque completo. Elegí el bloque disponible.",
      409,
      esSorteoAbierto ? "HOLD_MODALIDAD_SORTEO" : "HOLD_BLOQUE_REQUERIDO"
    );
  }
}

async function validarReservaDefinitivaNoCamping(connection, datos) {
  const [rows] = await connection.query(
    `SELECT r.id
       FROM reserva r
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.recurso_id = ?
        AND r.fecha_inicio < ?
        AND r.fecha_fin > ?
        AND COALESCE(er.nombre, '') NOT IN ('Cancelada','Rechazada','No adjudicada')
      LIMIT 1
      FOR UPDATE`,
    [datos.recursoId, datos.fechaFin, datos.fechaInicio]
  );
  if (rows.length > 0) {
    throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
  }
}

async function obtenerHoldsSolapados(connection, datos, holdIdExcluir = null, { forUpdate = true } = {}) {
  const params = [datos.recursoId, datos.fechaFin, datos.fechaInicio];
  let filtroExclusion = "";
  if (holdIdExcluir) {
    filtroExclusion = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.query(
    `SELECT id, actor_usuario_id, numero_parcela
       FROM ${TABLA_HOLDS}
      WHERE recurso_id = ?
        AND estado = 'ACTIVO'
        AND vence_en > NOW(6)
        AND fecha_inicio < ?
        AND fecha_fin > ?${filtroExclusion}
      ORDER BY id${lock}`,
    params
  );
  return rows;
}

async function obtenerParcelasCamping(connection, datos, configuracion, holdIdExcluir = null) {
  const noches = obtenerNochesReserva(datos.fechaInicio, datos.fechaFin, 366);
  if (noches.length === 0) {
    throw crearErrorHold("El rango de fechas no es válido.", 400, "HOLD_DATOS_INVALIDOS");
  }
  let minimo = null;
  for (const fecha of noches) {
    const [cupos] = await connection.query(
      `SELECT MIN(cupo_total) AS cupo
         FROM recurso_cupo_periodo
        WHERE recurso_id = ? AND activo = 1
          AND fecha_inicio <= ? AND fecha_fin >= ?`,
      [datos.recursoId, fecha, fecha]
    );
    let parcelas = Number(cupos[0]?.cupo);
    const [rows] = await connection.query(
      `SELECT MIN(parcelas_disponibles) AS parcelas
         FROM tarifa
        WHERE recurso_id = ?
          AND fecha_inicio <= ?
          AND fecha_fin >= ?
          AND parcelas_disponibles IS NOT NULL`,
      [datos.recursoId, fecha, fecha]
    );
    if (!Number.isInteger(parcelas) || parcelas <= 0) parcelas = Number(rows[0]?.parcelas);
    if (!Number.isInteger(parcelas) || parcelas <= 0) parcelas = Number(configuracion.cupo_maximo);
    if (!Number.isInteger(parcelas) || parcelas <= 0) {
      throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
    }
    minimo = minimo === null ? parcelas : Math.min(minimo, parcelas);
  }

  const [reservas] = await connection.query(
    `SELECT r.numero_parcela
       FROM reserva r
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.recurso_id = ?
        AND r.numero_parcela IS NOT NULL
        AND r.fecha_inicio < ?
        AND r.fecha_fin > ?
        AND COALESCE(er.nombre, '') NOT IN ('Cancelada','Rechazada','No adjudicada')
      ORDER BY r.numero_parcela
      FOR UPDATE`,
    [datos.recursoId, datos.fechaFin, datos.fechaInicio]
  );
  const holds = await obtenerHoldsSolapados(connection, datos, holdIdExcluir, { forUpdate: true });
  const ocupadas = new Set([
    ...reservas.map((row) => Number(row.numero_parcela)),
    ...holds.map((row) => Number(row.numero_parcela)),
  ].filter((numero) => Number.isInteger(numero) && numero > 0));
  for (let numero = 1; numero <= minimo; numero += 1) {
    if (!ocupadas.has(numero)) return numero;
  }
  throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
}

async function validarDisponibilidad(connection, datos, configuracion, holdActual = null) {
  if (datos.modalidad === MODALIDAD_BLOQUE) {
    await validarBloque(connection, datos);
  } else {
    await validarFechaLibreFueraDeBloque(connection, datos);
  }

  if (configuracion.tipo_codigo === "CUPO_NUMERADO") {
    return obtenerParcelasCamping(connection, datos, configuracion, holdActual?.id || null);
  }
  await validarReservaDefinitivaNoCamping(connection, datos);
  const holds = await obtenerHoldsSolapados(connection, datos, holdActual?.id || null, { forUpdate: true });
  if (holds.length > 0) {
    throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
  }
  return null;
}

async function recargarHold(connection, holdId) {
  const row = await obtenerHoldPorId(connection, holdId);
  if (!row) throw crearErrorHold("Reserva temporal no encontrada.", 404, "HOLD_NO_ENCONTRADO");
  return row;
}

async function adquirirHoldTurismo(db, params) {
  const datos = normalizarDatosAdquisicion(params);
  const tokenSolicitado = normalizarTokenHold(params.holdToken, { requerido: false });
  const token = tokenSolicitado || generarTokenHold();
  const tokenHash = hashTokenHold(token);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await bloquearYValidarUsuarios(connection, datos);

    // Todos los flujos que consumen disponibilidad bloquean primero las filas
    // de recurso. La lectura preliminar sólo sirve para incluir también el
    // recurso anterior en un reemplazo; la fila del hold se relee con lock.
    const holdObservado = await obtenerHoldActivoActor(connection, datos.actorUsuarioId);
    const recursosABloquear = holdObservado
      ? [Number(holdObservado.recurso_id), datos.recursoId]
      : [datos.recursoId];
    const configuracion = await bloquearRecursos(connection, recursosABloquear, datos.servicioId, datos);

    let holdActual = await obtenerHoldActivoActor(connection, datos.actorUsuarioId, { forUpdate: true });
    if (holdActual && Number(holdActual.expira_en_ms) <= Number(holdActual.servidor_ahora_ms)) {
      const tokenDelHoldVencido = tokenSolicitado
        ? hashTokenCoincide(holdActual.token_hash, tokenHash)
        : false;
      const [actualizacion] = await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = 'VENCIDO', fecha_cierre = COALESCE(fecha_cierre, NOW(6))
          WHERE id = ? AND estado = 'ACTIVO'`,
        [holdActual.id]
      );
      if (Number(actualizacion.affectedRows) !== 1) throw crearErrorHoldVencido();
      holdActual = null;
      if (tokenDelHoldVencido) {
        await connection.commit();
        throw crearErrorHoldVencido();
      }
    }

    if (holdActual && !tokenSolicitado) {
      throw crearErrorHold(
        "Ya tenés un alojamiento reservado temporalmente. Volvé a ese formulario o cancelalo antes de elegir otro.",
        409,
        "HOLD_ACTIVO_EXISTENTE",
        { hold: mapearHold(holdActual) }
      );
    }
    if (holdActual && !hashTokenCoincide(holdActual.token_hash, tokenHash)) {
      throw crearErrorHold(
        "Ya tenés un alojamiento reservado temporalmente en otra pestaña.",
        409,
        "HOLD_ACTIVO_EXISTENTE",
        { hold: mapearHold(holdActual) }
      );
    }

    if (!holdActual) {
      const [tokenExistente] = await connection.query(
        `SELECT id, actor_usuario_id, estado
           FROM ${TABLA_HOLDS}
          WHERE token_hash = ?
          LIMIT 1
          FOR UPDATE`,
        [tokenHash]
      );
      if (tokenExistente.length > 0) {
        throw crearErrorHold(
          "Generá un nuevo token para iniciar otra reserva temporal.",
          409,
          "HOLD_TOKEN_REUTILIZADO"
        );
      }
    }

    const numeroParcela = await validarDisponibilidad(connection, datos, configuracion, holdActual);
    let holdId;
    let reemplazado = false;
    if (holdActual) {
      holdId = Number(holdActual.id);
      reemplazado = !mismoCriterioHold(holdActual, datos) ||
        (holdActual.numero_parcela == null ? null : Number(holdActual.numero_parcela)) !== numeroParcela;
      const [actualizacionHold] = await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET titular_usuario_id = ?, servicio_id = ?, recurso_id = ?, bloque_fecha_id = ?,
                modalidad = ?, fecha_inicio = ?, fecha_fin = ?, numero_parcela = ?
          WHERE id = ? AND estado = 'ACTIVO' AND vence_en > NOW(6)`,
        [
          datos.titularUsuarioId,
          datos.servicioId,
          datos.recursoId,
          datos.bloqueFechaId,
          datos.modalidad,
          datos.fechaInicio,
          datos.fechaFin,
          numeroParcela,
          holdId,
        ]
      );
      if (Number(actualizacionHold.affectedRows) !== 1) throw crearErrorHoldVencido();
      // vence_en y token_hash se conservan: cambiar de opción nunca reinicia los 20 minutos.
    } else {
      const [resultado] = await connection.query(
        `INSERT INTO ${TABLA_HOLDS}
          (token_hash, actor_usuario_id, titular_usuario_id, servicio_id, recurso_id,
           bloque_fecha_id, modalidad, fecha_inicio, fecha_fin, numero_parcela, estado, vence_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', DATE_ADD(NOW(6), INTERVAL ${HOLD_TTL_MINUTOS} MINUTE))`,
        [
          tokenHash,
          datos.actorUsuarioId,
          datos.titularUsuarioId,
          datos.servicioId,
          datos.recursoId,
          datos.bloqueFechaId,
          datos.modalidad,
          datos.fechaInicio,
          datos.fechaFin,
          numeroParcela,
        ]
      );
      holdId = Number(resultado.insertId);
    }

    const row = await recargarHold(connection, holdId);
    await connection.commit();
    return {
      ...mapearHold(row, { incluirToken: token, reemplazado }),
      creado: !holdActual,
      hold_anterior: holdActual && reemplazado ? mapearHold(holdActual) : null,
      mensaje: reemplazado
        ? "Actualizamos tu alojamiento y conservamos el tiempo que ya tenías disponible."
        : "Guardamos este alojamiento para vos durante 20 minutos.",
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // Se conserva el error original.
    }
    if (error?.code === "ER_DUP_ENTRY") {
      throw crearErrorHold(
        "Ya tenés una reserva temporal activa.",
        409,
        "HOLD_ACTIVO_EXISTENTE"
      );
    }
    throw convertirErrorTablaHold(error);
  } finally {
    connection.release();
  }
}

async function obtenerEstadoHold(db, { actorUsuarioId, holdId = null } = {}) {
  const actorId = normalizarIdPositivo(actorUsuarioId);
  const id = holdId == null ? null : normalizarIdPositivo(holdId);
  if (!actorId || (holdId != null && !id)) {
    throw crearErrorHold("Reserva temporal no válida.", 400, "HOLD_DATOS_INVALIDOS");
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    let row;
    if (id) {
      row = await obtenerHoldPorId(connection, id, { forUpdate: true });
      if (row && Number(row.actor_usuario_id) !== actorId) {
        throw crearErrorHold("Reserva temporal no encontrada.", 404, "HOLD_NO_ENCONTRADO");
      }
    } else {
      row = await obtenerHoldActivoActor(connection, actorId, { forUpdate: true });
    }
    if (row && row.estado === HOLD_ESTADO_ACTIVO && Number(row.expira_en_ms) <= Number(row.servidor_ahora_ms)) {
      await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = 'VENCIDO', fecha_cierre = COALESCE(fecha_cierre, NOW(6))
          WHERE id = ? AND estado = 'ACTIVO'`,
        [row.id]
      );
      row = await recargarHold(connection, row.id);
    }
    await connection.commit();
    const hold = row ? mapearHold(row) : null;
    return {
      activo: Boolean(hold && hold.estado === HOLD_ESTADO_ACTIVO && hold.segundos_restantes > 0),
      hold,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw convertirErrorTablaHold(error);
  } finally {
    connection.release();
  }
}

async function liberarHoldTurismo(db, { actorUsuarioId, holdId, holdToken }) {
  const actorId = normalizarIdPositivo(actorUsuarioId);
  const id = normalizarIdPositivo(holdId);
  const token = normalizarTokenHold(holdToken);
  if (!actorId || !id) {
    throw crearErrorHold("Reserva temporal no válida.", 400, "HOLD_DATOS_INVALIDOS");
  }
  const tokenHash = hashTokenHold(token);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT ${SELECT_HOLD_FIELDS}, h.token_hash
         FROM ${TABLA_HOLDS} h
        WHERE h.id = ?
        LIMIT 1
        FOR UPDATE`,
      [id]
    );
    const row = rows[0];
    if (
      !row || Number(row.actor_usuario_id) !== actorId ||
      !hashTokenCoincide(row.token_hash, tokenHash)
    ) {
      throw crearErrorHold("Reserva temporal no encontrada.", 404, "HOLD_NO_ENCONTRADO");
    }

    let liberado = false;
    let estado = row.estado;
    if (estado === HOLD_ESTADO_ACTIVO) {
      estado = Number(row.expira_en_ms) <= Number(row.servidor_ahora_ms)
        ? HOLD_ESTADO_VENCIDO
        : HOLD_ESTADO_LIBERADO;
      const [resultado] = await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = ?, fecha_cierre = COALESCE(fecha_cierre, NOW(6))
          WHERE id = ? AND estado = 'ACTIVO'`,
        [estado, id]
      );
      liberado = estado === HOLD_ESTADO_LIBERADO && Number(resultado.affectedRows) === 1;
    }
    await connection.commit();
    const holdCerrado = {
      ...row,
      estado,
      servidor_ahora_ms: Date.now(),
    };
    return {
      liberado,
      estado,
      hold: mapearHold(holdCerrado),
      mensaje: liberado
        ? "Listo, liberamos el alojamiento para que puedas elegir otra opción."
        : (estado === HOLD_ESTADO_VENCIDO ? HOLD_VENCIDO_MENSAJE : "La reserva temporal ya estaba cerrada."),
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw convertirErrorTablaHold(error);
  } finally {
    connection.release();
  }
}

async function validarHoldParaReservaEnTransaccion(connection, params) {
  const actorUsuarioId = normalizarIdPositivo(params.actorUsuarioId);
  const titularUsuarioId = params.titularUsuarioId == null ? null : normalizarIdPositivo(params.titularUsuarioId);
  const servicioId = normalizarIdPositivo(params.servicioId);
  const recursoId = normalizarIdPositivo(params.recursoId);
  const bloqueFechaId = params.bloqueFechaId == null ? null : normalizarIdPositivo(params.bloqueFechaId);
  const modalidad = normalizarModalidadHold(params.modalidad);
  const fechaInicio = normalizarFechaCivil(params.fechaInicio);
  const fechaFin = normalizarFechaCivil(params.fechaFin);
  const holdIdSolicitado = params.holdId == null ? null : normalizarIdPositivo(params.holdId);
  if (params.holdId != null && !holdIdSolicitado) {
    throw crearErrorHold("La reserva temporal no es válida.", 400, "HOLD_DATOS_INVALIDOS");
  }
  const token = normalizarTokenHold(params.holdToken);
  const tokenHash = hashTokenHold(token);

  try {
    const filtros = ["h.token_hash = ?"];
    const valores = [tokenHash];
    if (holdIdSolicitado) {
      filtros.push("h.id = ?");
      valores.push(holdIdSolicitado);
    }
    const [rows] = await connection.query(
      `SELECT ${SELECT_HOLD_FIELDS}
         FROM ${TABLA_HOLDS} h
        WHERE ${filtros.join(" AND ")}
        LIMIT 1
        FOR UPDATE`,
      valores
    );
    const row = rows[0];
    if (!row || Number(row.actor_usuario_id) !== actorUsuarioId) {
      throw crearErrorHold("La reserva temporal no corresponde a tu sesión.", 403, "HOLD_NO_AUTORIZADO");
    }
    if (row.estado !== HOLD_ESTADO_ACTIVO) {
      if (row.estado === HOLD_ESTADO_VENCIDO) throw crearErrorHoldVencido();
      throw crearErrorHold("La reserva temporal ya fue utilizada o liberada.", 409, "HOLD_NO_ACTIVO");
    }
    if (Number(row.expira_en_ms) <= Number(row.servidor_ahora_ms)) {
      await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = 'VENCIDO', fecha_cierre = COALESCE(fecha_cierre, NOW(6))
          WHERE id = ? AND estado = 'ACTIVO'`,
        [row.id]
      );
      throw crearErrorHoldVencido();
    }
    const coincide = (
      Number(row.servicio_id) === servicioId &&
      Number(row.recurso_id) === recursoId &&
      (row.bloque_fecha_id == null ? null : Number(row.bloque_fecha_id)) === bloqueFechaId &&
      row.modalidad === modalidad &&
      normalizarFechaCivil(row.fecha_inicio) === fechaInicio &&
      normalizarFechaCivil(row.fecha_fin) === fechaFin &&
      (row.titular_usuario_id == null ? null : Number(row.titular_usuario_id)) === titularUsuarioId
    );
    if (!coincide) {
      throw crearErrorHold(
        "La reserva temporal no coincide con el alojamiento o las fechas enviadas.",
        409,
        "HOLD_DATOS_NO_COINCIDEN"
      );
    }
    return {
      id: Number(row.id),
      numeroParcela: row.numero_parcela == null ? null : Number(row.numero_parcela),
      hold: mapearHold(row),
    };
  } catch (error) {
    throw convertirErrorTablaHold(error);
  }
}

async function consumirHoldEnTransaccion(connection, { holdId, reservaId }) {
  const id = normalizarIdPositivo(holdId);
  const reserva = normalizarIdPositivo(reservaId);
  if (!id || !reserva) {
    throw crearErrorHold("No se pudo vincular la reserva temporal.", 500, "HOLD_CONSUMO_INVALIDO");
  }
  try {
    const [resultado] = await connection.query(
      `UPDATE ${TABLA_HOLDS}
          SET estado = 'CONSUMIDO', reserva_id = ?, fecha_cierre = NOW(6)
        WHERE id = ? AND estado = 'ACTIVO' AND vence_en > NOW(6)`,
      [reserva, id]
    );
    if (Number(resultado.affectedRows) !== 1) throw crearErrorHoldVencido();
  } catch (error) {
    throw convertirErrorTablaHold(error);
  }
}

async function asegurarSinHoldAjenoEnTransaccion(connection, {
  recursoId,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
}) {
  const datos = {
    recursoId: normalizarIdPositivo(recursoId),
    fechaInicio: normalizarFechaCivil(fechaInicio),
    fechaFin: normalizarFechaCivil(fechaFin),
  };
  if (!datos.recursoId || !datos.fechaInicio || !datos.fechaFin) {
    throw crearErrorHold("Los datos de disponibilidad no son válidos.", 400, "HOLD_DATOS_INVALIDOS");
  }
  try {
    const rows = await obtenerHoldsSolapados(connection, datos, holdIdExcluir, { forUpdate: true });
    if (rows.length > 0) {
      throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
    }
  } catch (error) {
    throw convertirErrorTablaHold(error);
  }
}

async function obtenerHoldIdActivoPorToken(connection, { actorUsuarioId, holdToken }) {
  const actorId = normalizarIdPositivo(actorUsuarioId);
  const token = normalizarTokenHold(holdToken, { requerido: false });
  if (!actorId || !token) return null;
  try {
    const [rows] = await connection.query(
      `SELECT id
         FROM ${TABLA_HOLDS}
        WHERE actor_usuario_id = ?
          AND token_hash = ?
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)
        LIMIT 1`,
      [actorId, hashTokenHold(token)]
    );
    return rows.length === 1 ? Number(rows[0].id) : null;
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return null;
    throw error;
  }
}

async function obtenerRecursosRetenidos(connection, {
  recursoIds,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
}) {
  const ids = [...new Set((recursoIds || []).map(normalizarIdPositivo).filter(Boolean))];
  const inicio = normalizarFechaCivil(fechaInicio);
  const fin = normalizarFechaCivil(fechaFin);
  if (ids.length === 0 || !inicio || !fin) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const params = [...ids, fin, inicio];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT DISTINCT recurso_id
         FROM ${TABLA_HOLDS}
        WHERE recurso_id IN (${placeholders})
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)
          AND fecha_inicio < ?
          AND fecha_fin > ?${filtro}`,
      params
    );
    return new Set(rows.map((row) => Number(row.recurso_id)));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return new Set();
    throw error;
  }
}

async function listarHoldsActivosRecursos(connection, {
  recursoIds,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
}) {
  const ids = [...new Set((recursoIds || []).map(normalizarIdPositivo).filter(Boolean))];
  const inicio = normalizarFechaCivil(fechaInicio);
  const fin = normalizarFechaCivil(fechaFin);
  if (ids.length === 0 || !inicio || !fin) return [];
  const placeholders = ids.map(() => "?").join(",");
  const params = [...ids, fin, inicio];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT id, recurso_id, numero_parcela,
              DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
              DATE_FORMAT(fecha_fin, '%Y-%m-%d') AS fecha_fin
         FROM ${TABLA_HOLDS}
        WHERE recurso_id IN (${placeholders})
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)
          AND fecha_inicio < ?
          AND fecha_fin > ?${filtro}`,
      params
    );
    return rows.map((row) => ({
      id: Number(row.id),
      recurso_id: Number(row.recurso_id),
      numero_parcela: row.numero_parcela == null ? null : Number(row.numero_parcela),
      fecha_inicio: row.fecha_inicio,
      fecha_fin: row.fecha_fin,
    }));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return [];
    throw error;
  }
}

async function contarHoldsActivosRecurso(connection, {
  recursoId,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
}) {
  const id = normalizarIdPositivo(recursoId);
  const inicio = normalizarFechaCivil(fechaInicio);
  const fin = normalizarFechaCivil(fechaFin);
  if (!id || !inicio || !fin) return 0;
  const params = [id, fin, inicio];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS total
         FROM ${TABLA_HOLDS}
        WHERE recurso_id = ?
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)
          AND fecha_inicio < ?
          AND fecha_fin > ?${filtro}`,
      params
    );
    return Number(rows[0]?.total || 0);
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return 0;
    throw error;
  }
}

async function obtenerNumerosParcelasRetenidas(connection, {
  recursoId,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
  forUpdate = false,
}) {
  const datos = {
    recursoId: normalizarIdPositivo(recursoId),
    fechaInicio: normalizarFechaCivil(fechaInicio),
    fechaFin: normalizarFechaCivil(fechaFin),
  };
  if (!datos.recursoId || !datos.fechaInicio || !datos.fechaFin) return new Set();
  try {
    const rows = await obtenerHoldsSolapados(connection, datos, holdIdExcluir, { forUpdate });
    return new Set(rows
      .map((row) => Number(row.numero_parcela))
      .filter((numero) => Number.isInteger(numero) && numero > 0));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return new Set();
    throw error;
  }
}

async function obtenerBloquesRecursosRetenidos(connection, {
  bloqueFechaIds,
  holdIdExcluir = null,
}) {
  const ids = [...new Set((bloqueFechaIds || []).map(normalizarIdPositivo).filter(Boolean))];
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const params = [...ids];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT bloque_fecha_id, recurso_id
         FROM ${TABLA_HOLDS}
        WHERE bloque_fecha_id IN (${placeholders})
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)${filtro}`,
      params
    );
    return new Set(rows.map((row) => `${Number(row.bloque_fecha_id)}:${Number(row.recurso_id)}`));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return new Set();
    throw error;
  }
}

async function contarHoldsActivosPorBloque(connection, { bloqueFechaIds, holdIdExcluir = null }) {
  const ids = [...new Set((bloqueFechaIds || []).map(normalizarIdPositivo).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const params = [...ids];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT bloque_fecha_id, COUNT(*) AS total
         FROM ${TABLA_HOLDS}
        WHERE bloque_fecha_id IN (${ids.map(() => "?").join(",")})
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)${filtro}
        GROUP BY bloque_fecha_id`,
      params
    );
    return new Map(rows.map((row) => [Number(row.bloque_fecha_id), Number(row.total || 0)]));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return new Map();
    throw error;
  }
}

async function expirarHoldsVencidos(db, { limite = 200 } = {}) {
  const limiteSeguro = Number.isInteger(Number(limite))
    ? Math.max(1, Math.min(1000, Number(limite)))
    : 200;
  const connection = await db.getConnection();
  let lockTomado = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 0) AS adquirido", [LOCK_EXPIRACION_HOLDS]);
    lockTomado = Number(locks[0]?.adquirido) === 1;
    if (!lockTomado) return { ejecutado: false, holds: [] };
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT ${SELECT_HOLD_FIELDS}
         FROM ${TABLA_HOLDS} h
        WHERE h.estado = 'ACTIVO' AND h.vence_en <= NOW(6)
        ORDER BY h.vence_en, h.id
        LIMIT ${limiteSeguro}
        FOR UPDATE SKIP LOCKED`
    );
    if (rows.length > 0) {
      const ids = rows.map((row) => Number(row.id));
      await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = 'VENCIDO', fecha_cierre = COALESCE(fecha_cierre, NOW(6))
          WHERE id IN (${ids.map(() => "?").join(",")}) AND estado = 'ACTIVO'`,
        ids
      );
    }
    await connection.commit();
    return { ejecutado: true, holds: rows.map((row) => mapearHold(row)) };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    if (esErrorTablaHoldNoMigrada(error)) return { ejecutado: false, holds: [], noMigrado: true };
    throw error;
  } finally {
    if (lockTomado) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_EXPIRACION_HOLDS]);
      } catch (_) {}
    }
    connection.release();
  }
}

function iniciarMantenimientoHolds(db, {
  intervaloMs = Number(process.env.TURISMO_HOLDS_EXPIRACION_INTERVALO_MS || 15000),
  demoraInicialMs = Number(process.env.TURISMO_HOLDS_EXPIRACION_DEMORA_INICIAL_MS || 5000),
  onExpirados = null,
} = {}) {
  const intervaloSeguro = Number.isFinite(intervaloMs)
    ? Math.max(5000, Math.min(60000, Math.trunc(intervaloMs)))
    : 15000;
  const demoraSegura = Number.isFinite(demoraInicialMs)
    ? Math.max(0, Math.min(60000, Math.trunc(demoraInicialMs)))
    : 5000;
  let ejecutando = false;
  const ejecutar = async () => {
    if (ejecutando) return;
    ejecutando = true;
    try {
      const resultado = await expirarHoldsVencidos(db);
      if (resultado.holds.length > 0 && typeof onExpirados === "function") {
        await onExpirados(resultado.holds);
      }
    } catch (error) {
      console.error("Error en mantenimiento de reservas temporales de Turismo:", error?.code || error?.message);
    } finally {
      ejecutando = false;
    }
  };
  const inicio = setTimeout(() => void ejecutar(), demoraSegura);
  const intervalo = setInterval(() => void ejecutar(), intervaloSeguro);
  inicio.unref?.();
  intervalo.unref?.();
  return () => {
    clearTimeout(inicio);
    clearInterval(intervalo);
  };
}

function crearEventoInvalidacionHold(hold, motivo) {
  if (!hold) return null;
  return {
    motivo,
    servicio_ids: [Number(hold.servicio_id)],
    servicio_id: Number(hold.servicio_id),
    recurso_id: Number(hold.recurso_id),
    bloque_fecha_id: hold.bloque_fecha_id == null ? null : Number(hold.bloque_fecha_id),
    fecha_inicio: hold.fecha_inicio,
    fecha_fin: hold.fecha_fin,
    emitido_en: new Date().toISOString(),
  };
}

module.exports = {
  HOLD_CONFLICTO_MENSAJE,
  HOLD_ESTADO_ACTIVO,
  HOLD_ESTADO_CONSUMIDO,
  HOLD_ESTADO_LIBERADO,
  HOLD_ESTADO_VENCIDO,
  HOLD_TTL_MINUTOS,
  HOLD_VENCIDO_MENSAJE,
  MODALIDAD_BLOQUE,
  MODALIDAD_FECHA_LIBRE,
  TABLA_HOLDS,
  adquirirHoldTurismo,
  asegurarSinHoldAjenoEnTransaccion,
  consumirHoldEnTransaccion,
  contarHoldsActivosPorBloque,
  contarHoldsActivosRecurso,
  crearErrorHold,
  crearEventoInvalidacionHold,
  esErrorTablaHoldNoMigrada,
  expirarHoldsVencidos,
  generarTokenHold,
  hashTokenHold,
  iniciarMantenimientoHolds,
  liberarHoldTurismo,
  listarHoldsActivosRecursos,
  mapearHold,
  normalizarTokenHold,
  obtenerBloquesRecursosRetenidos,
  obtenerEstadoHold,
  obtenerHoldIdActivoPorToken,
  obtenerNumerosParcelasRetenidas,
  obtenerRecursosRetenidos,
  validarHoldParaReservaEnTransaccion,
};
