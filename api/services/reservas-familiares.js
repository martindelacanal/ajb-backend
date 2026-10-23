"use strict";
const { crearNotificacion } = require("./notificaciones");

const { calcularEdadEnFecha, normalizarFechaCivil } = require("./valores-dominio");
const { obtenerFechaCivilArgentina } = require("./valores-dominio");
const ESTADO_PENDIENTE_TITULAR = "Pendiente_Aprobacion_Titular";
const MENSAJE_CBU = "Para realizar reservas de hospedaje es obligatorio tener cargado tu CBU en tu perfil. Haz clic aquí para actualizar tus datos bancarios";
const MENSAJE_ADULTO = "Debe viajar al menos un adulto responsable en la reserva";

function errorReserva(message, statusCode, codigo) {
  return Object.assign(new Error(message), { statusCode, codigo });
}

function esFamiliar(usuario) {
  return Number(usuario?.usuario_familiar_id) > 0 && (
    String(usuario.es_familiar || "").toUpperCase() === "S" ||
    [2, 3, 4].includes(Number(usuario.parentesco_id)) ||
    String(usuario.rol || "").toLowerCase() === "familiar"
  );
}

async function obtenerGrupoReserva(connection, usuario, { forUpdate = false } = {}) {
  let titular = usuario;
  const requiereAprobacionTitular = esFamiliar(usuario);
  const visitados = new Set([Number(usuario.id)]);
  // Acompañantes no familiares nunca adquieren derechos sobre una cuenta vinculada.
  if (requiereAprobacionTitular) {
    while (Number(titular.usuario_familiar_id) > 0) {
      const id = Number(titular.usuario_familiar_id);
      if (visitados.has(id) || visitados.size > 10) {
        throw errorReserva("El vínculo con el titular del grupo familiar no es válido", 409, "TITULAR_INVALIDO");
      }
      visitados.add(id);
      const [rows] = await connection.query(
        `SELECT u.id, u.nombre, u.apellido, u.cbu, u.email, u.usuario_familiar_id,
                u.es_familiar, u.parentesco_id, u.departamental_id, u.habilitado,
                u.modulo_turismo, r.nombre AS rol, u.bloqueo_tipo, u.bloqueo_modulos, u.bloqueo_mensaje
           FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
          WHERE u.id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
      titular = rows[0];
      if (!titular) throw errorReserva("No se encontró al titular del grupo familiar", 409, "TITULAR_INVALIDO");
    }
    if (titular.habilitado !== "Y" || titular.rol !== "afiliado" || Number(titular.modulo_turismo) !== 1) {
      throw errorReserva("El titular del grupo familiar no está habilitado para Turismo", 403, "TITULAR_NO_HABILITADO");
    }
  }
  return { titular, requiereAprobacionTitular, cbuCompleto: String(titular.cbu ?? "").trim().length > 0 };
}

function exigirCbu(grupo) {
  if (!grupo.cbuCompleto) throw errorReserva(MENSAJE_CBU, 422, "CBU_REQUERIDO");
}

function validarAdultoResponsable(personas, fechaIngreso) {
  const fecha = normalizarFechaCivil(fechaIngreso);
  const edades = (personas || []).map((persona) => calcularEdadEnFecha(
    normalizarFechaCivil(persona.fecha_nacimiento ?? persona.fechaNacimiento), fecha));
  if (edades.some((edad) => !Number.isInteger(edad) || edad < 0 || edad > 130)) {
    throw errorReserva("La fecha de nacimiento no es válida para la fecha de ingreso", 422, "FECHA_NACIMIENTO_INVALIDA");
  }
  if (!edades.some((edad) => edad >= 18)) throw errorReserva(MENSAJE_ADULTO, 422, "ADULTO_RESPONSABLE_REQUERIDO");
  return edades;
}

const PLAZO_RESPUESTA_TITULAR_HORAS = 48;
const ESTADO_RECHAZADA = "Rechazada";
const LOCK_VENCIMIENTO_TITULAR = "ajb:reservas:titular-vencidas:v1";

/** Fin del día civil (hora de Argentina) como instante. */
function finDelDiaArgentina(fecha) {
  const civil = fecha ? normalizarFechaCivil(typeof fecha === "string" ? fecha.slice(0, 10) : fecha) : null;
  return civil ? new Date(`${civil}T23:59:59-03:00`) : null;
}

/**
 * Hasta cuándo puede responder el titular: 48 horas desde la solicitud, sin pasar del día
 * del ingreso (después ya no se puede aprobar) ni, en un sorteo, del último día de
 * inscripción. Devuelve un Date sin milisegundos.
 */
function calcularVencimientoTitular({ fechaInicio, finInscripcion = null, ahora = new Date() }) {
  const topes = [
    ahora.getTime() + PLAZO_RESPUESTA_TITULAR_HORAS * 3600 * 1000,
    finDelDiaArgentina(fechaInicio)?.getTime(),
    finDelDiaArgentina(finInscripcion)?.getTime(),
  ].filter((valor) => Number.isFinite(valor));
  return new Date(Math.floor(Math.min(...topes) / 1000) * 1000);
}

function fechaHoraTexto(valor) {
  // Diferido: reservas-firma ya requiere este módulo.
  return require("./reservas-firma").fechaHoraTexto(valor);
}

async function registrarSolicitudTitular(connection, { reservaId, solicitanteId, titularId, estadoDestino }) {
  const [estados] = await connection.query("SELECT id FROM estado_reserva WHERE nombre = ?", [ESTADO_PENDIENTE_TITULAR]);
  if (!estados.length) throw errorReserva("Falta aplicar la migración de aprobación del titular", 503, "APROBACION_TITULAR_NO_MIGRADA");
  const [datos] = await connection.query(
    `SELECT r.fecha_inicio, s.fecha_fin_inscripcion FROM reserva r
       LEFT JOIN sorteo s ON s.id = r.sorteo_id WHERE r.id = ?`, [reservaId]);
  const venceEn = calcularVencimientoTitular({
    fechaInicio: datos[0]?.fecha_inicio,
    finInscripcion: estadoDestino === "Solicitud sorteo" ? datos[0]?.fecha_fin_inscripcion : null,
  });
  await connection.query("UPDATE reserva SET estado_reserva_id = ? WHERE id = ?", [estados[0].id, reservaId]);
  await connection.query(
    `INSERT INTO reserva_aprobacion_titular (reserva_id, solicitante_usuario_id, titular_usuario_id, estado_destino, vence_en)
     VALUES (?, ?, ?, ?, ?)`, [reservaId, solicitanteId, titularId, estadoDestino, venceEn]);
  await crearNotificacion(connection, {
    usuarioId: titularId,
    tipo: "RESERVA_APROBACION_TITULAR",
    titulo: `Reserva T-${reservaId} pendiente de tu aprobación`,
    mensaje: "Un familiar solicitó una reserva. Revisá los pasajeros, las fechas y el importe para aprobarla o rechazarla "
      + `antes del ${fechaHoraTexto(venceEn)}: si no respondés, se da de baja sola.`,
    payload: { reserva_id: reservaId, estado: ESTADO_PENDIENTE_TITULAR, url: `/mis-gestiones?aprobacion_reserva=${reservaId}` },
  });
  await connection.query(
    `INSERT INTO historial_reserva (reserva_id, tipo_operacion, campo_modificado, valor_anterior,
       valor_nuevo, usuario_modificador_id, observaciones) VALUES (?, 'UPDATE', 'estado_reserva_id', NULL, ?, ?, ?)`,
    [reservaId, estados[0].id, solicitanteId,
      `Solicitud del familiar pendiente de aprobación del titular (vence el ${fechaHoraTexto(venceEn)})`]);
  return { vence_en: venceEn };
}

/**
 * Da de baja una solicitud que el titular no respondió a tiempo: Rechazada, decisión
 * VENCIDA, lugar liberado, historial automático y avisos al familiar y al titular.
 * Devuelve false si otra transacción ya la resolvió.
 */
async function expirarSolicitudTitularEnTransaccion(connection, { reserva_id: reservaId }) {
  const [estados] = await connection.query(
    "SELECT id, nombre FROM estado_reserva WHERE nombre IN (?, ?)", [ESTADO_PENDIENTE_TITULAR, ESTADO_RECHAZADA]);
  const pendienteId = estados.find((estado) => estado.nombre === ESTADO_PENDIENTE_TITULAR)?.id;
  const rechazadaId = estados.find((estado) => estado.nombre === ESTADO_RECHAZADA)?.id;
  if (!pendienteId || !rechazadaId) throw errorReserva("Faltan estados de reserva", 503, "ESTADO_RESERVA_FALTANTE");
  const [cambio] = await connection.query(
    "UPDATE reserva SET estado_reserva_id = ?, fecha_modificacion = NOW() WHERE id = ? AND estado_reserva_id = ?",
    [rechazadaId, reservaId, pendienteId]);
  if (Number(cambio?.affectedRows) !== 1) return false;
  const [solicitudes] = await connection.query(
    `SELECT a.titular_usuario_id, a.vence_en, r.usuario_id, u.nombre, u.apellido
       FROM reserva_aprobacion_titular a INNER JOIN reserva r ON r.id = a.reserva_id
       LEFT JOIN usuario u ON u.id = r.usuario_id WHERE a.reserva_id = ?`, [reservaId]);
  const solicitud = solicitudes[0] || {};
  await connection.query(
    "UPDATE reserva_aprobacion_titular SET decision = 'VENCIDA', fecha_respuesta = NOW() WHERE reserva_id = ? AND decision = 'PENDIENTE'",
    [reservaId]);
  const { liberarRecursoBloque } = require("./reservas-turismo");
  await liberarRecursoBloque(connection, reservaId);
  await connection.query(
    `INSERT INTO historial_reserva (reserva_id, tipo_operacion, campo_modificado, valor_anterior,
       valor_nuevo, usuario_modificador_id, observaciones) VALUES (?, 'UPDATE', 'estado_reserva_id', ?, ?, NULL, ?)`,
    [reservaId, pendienteId, rechazadaId,
      `Se dio de baja sola: el titular no respondió a tiempo (vencía el ${fechaHoraTexto(solicitud.vence_en)}). Se liberó el lugar.`]);
  await connection.query(
    `UPDATE notificacion SET leida = 1, fecha_lectura = COALESCE(fecha_lectura, NOW())
      WHERE tipo = 'RESERVA_APROBACION_TITULAR' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.reserva_id')) = ?`,
    [String(reservaId)]);
  const familiar = [solicitud.nombre, solicitud.apellido].filter(Boolean).join(" ") || "tu familiar";
  await crearNotificacion(connection, {
    usuarioId: solicitud.usuario_id,
    tipo: "RESERVA_RESPUESTA_TITULAR",
    titulo: `Reserva T-${reservaId} dada de baja`,
    mensaje: "Tu titular no respondió la solicitud a tiempo, así que se dio de baja y se liberó el lugar. "
      + "Si todavía querés viajar, volvé a reservar.",
    payload: { reserva_id: reservaId, estado: ESTADO_RECHAZADA, motivo: "TITULAR_SIN_RESPUESTA", url: "/mis-gestiones" },
    categoria: "estados",
  });
  await crearNotificacion(connection, {
    usuarioId: solicitud.titular_usuario_id,
    tipo: "RESERVA_APROBACION_TITULAR_VENCIDA",
    titulo: `Reserva T-${reservaId}: venció el plazo para responder`,
    mensaje: `No respondiste a tiempo la solicitud de ${familiar}, así que se dio de baja y se liberó el lugar.`,
    payload: { reserva_id: reservaId, estado: ESTADO_RECHAZADA, motivo: "TITULAR_SIN_RESPUESTA", url: "/mis-gestiones" },
    categoria: "estados",
  });
  return { reservaId };
}

async function asegurarSinSolicitudTitularPendiente(connection, usuarioId) {
  const [rows] = await connection.query(
    `SELECT r.id, (a.vence_en IS NOT NULL AND a.vence_en <= NOW()) AS vencida
       FROM reserva r INNER JOIN estado_reserva er ON er.id = r.estado_reserva_id
       LEFT JOIN reserva_aprobacion_titular a ON a.reserva_id = r.id AND a.decision = 'PENDIENTE'
      WHERE r.usuario_id = ? AND er.nombre = ? LIMIT 1 FOR UPDATE`, [usuarioId, ESTADO_PENDIENTE_TITULAR]);
  for (const fila of rows) {
    // La que ya venció (y el mantenimiento todavía no dio de baja) no frena una nueva.
    if (Number(fila.vencida) === 1 && await expirarSolicitudTitularEnTransaccion(connection, { reserva_id: fila.id })) continue;
    throw errorReserva("Ya tenés una reserva pendiente de aprobación del titular", 409, "RESERVA_PENDIENTE_TITULAR_EXISTENTE");
  }
}

/**
 * Mantenimiento (cada 5 minutos, junto con los demás vencimientos): da de baja las
 * solicitudes que el titular no respondió a tiempo. Conexión, lock y transacción propios.
 * Sin la columna vence_en (falta la migración) no hace nada.
 */
async function expirarSolicitudesTitularVencidas(db, { limite = 100 } = {}) {
  const limiteSeguro = Number.isInteger(Number(limite)) ? Math.max(1, Math.min(500, Number(limite))) : 100;
  const connection = await db.getConnection();
  let lockTomado = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 0) AS adquirido", [LOCK_VENCIMIENTO_TITULAR]);
    lockTomado = Number(locks[0]?.adquirido) === 1;
    if (!lockTomado) return { ejecutado: false, solicitudes: 0 };
    await connection.beginTransaction();
    const [filas] = await connection.query(
      `SELECT a.reserva_id
         FROM reserva_aprobacion_titular a
         STRAIGHT_JOIN reserva r ON r.id = a.reserva_id
         INNER JOIN estado_reserva er ON er.id = r.estado_reserva_id
        WHERE a.decision = 'PENDIENTE' AND a.vence_en <= NOW() AND er.nombre = ?
        ORDER BY a.vence_en ASC, a.reserva_id ASC
        LIMIT ${limiteSeguro}
        FOR UPDATE SKIP LOCKED`, [ESTADO_PENDIENTE_TITULAR]);
    let vencidas = 0;
    for (const fila of filas) {
      if (await expirarSolicitudTitularEnTransaccion(connection, fila)) vencidas += 1;
    }
    await connection.commit();
    return { ejecutado: true, solicitudes: vencidas };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* conexión cerrada tras el error */ }
    if (error?.code === "ER_BAD_FIELD_ERROR" && /vence_en/.test(String(error?.message))) {
      return { ejecutado: false, solicitudes: 0, omitido: "SIN_MIGRACION" };
    }
    throw error;
  } finally {
    if (lockTomado) {
      try { await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_VENCIMIENTO_TITULAR]); } catch (_) { /* se libera al cerrar */ }
    }
    connection.release();
  }
}

async function decidirSolicitudTitular(connection, { reservaId, actorId, accion }) {
  if (!["APROBAR", "RECHAZAR"].includes(accion)) throw errorReserva("Acción de aprobación inválida", 400, "ACCION_INVALIDA");
  // Sólo el titular persistido puede resolver; ni siquiera staff puede suplantarlo.
  const [referencias] = await connection.query(
    "SELECT solicitante_usuario_id FROM reserva_aprobacion_titular WHERE reserva_id = ? AND titular_usuario_id = ?",
    [reservaId, actorId]);
  if (!referencias.length) throw errorReserva("No tenés permisos para resolver esta solicitud", 403, "APROBACION_TITULAR_NO_AUTORIZADA");
  // Mismo orden que el alta: solicitante, titular y finalmente reserva.
  const [usuarios] = await connection.query(
    `SELECT u.id, u.cbu, u.usuario_familiar_id, u.es_familiar, u.parentesco_id, u.habilitado,
            u.modulo_turismo, r.nombre AS rol
       FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.id = ? FOR UPDATE`, [referencias[0].solicitante_usuario_id]);
  const solicitante = usuarios.find((u) => Number(u.id) === Number(referencias[0].solicitante_usuario_id));
  if (!solicitante || solicitante.habilitado !== "Y" || !esFamiliar(solicitante)) {
    throw errorReserva("El vínculo con el titular ya no está habilitado", 403, "APROBACION_TITULAR_NO_AUTORIZADA");
  }
  const grupo = await obtenerGrupoReserva(connection, solicitante, { forUpdate: true });
  if (Number(grupo.titular.id) !== Number(actorId)) throw errorReserva("El titular del grupo familiar cambió", 403, "APROBACION_TITULAR_NO_AUTORIZADA");
  const [rows] = await connection.query(
    `SELECT r.*, er.nombre AS estado_nombre, a.decision, a.estado_destino,
            (a.vence_en IS NOT NULL AND a.vence_en <= NOW()) AS vencida
       FROM reserva r INNER JOIN reserva_aprobacion_titular a ON a.reserva_id = r.id
       INNER JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.id = ? AND a.titular_usuario_id = ? FOR UPDATE`, [reservaId, actorId]);
  const reserva = rows[0];
  if (!reserva || reserva.decision !== "PENDIENTE" || reserva.estado_nombre !== ESTADO_PENDIENTE_TITULAR) {
    throw errorReserva("Esta solicitud ya fue resuelta o cancelada", 409, "APROBACION_TITULAR_RESUELTA");
  }
  // Pasó el plazo y el mantenimiento todavía no la dio de baja: se da de baja ahora (la ruta
  // confirma la baja y responde 409).
  if (Number(reserva.vencida) === 1) {
    await expirarSolicitudTitularEnTransaccion(connection, { reserva_id: reservaId });
    return { ...reserva, estado: ESTADO_RECHAZADA, vencida: true };
  }
  if (accion === "APROBAR") {
    exigirCbu(grupo);
    if (normalizarFechaCivil(reserva.fecha_inicio) < obtenerFechaCivilArgentina()) {
      throw errorReserva("La fecha de ingreso ya pasó", 409, "RESERVA_FECHA_VENCIDA");
    }
    if (reserva.estado_destino === "Iniciada") {
      const { asegurarSinReservaIniciadaAfiliado } = require("./reservas-turismo");
      const existente = await asegurarSinReservaIniciadaAfiliado(connection, reserva.usuario_id);
      if (existente) throw errorReserva("El familiar ya tiene una reserva iniciada", 409, "RESERVA_INICIADA_EXISTENTE");
    } else if (reserva.estado_destino === "Solicitud sorteo") {
      const [bloques] = await connection.query(
        `SELECT bf.estado, s.estado AS sorteo_estado, s.fecha_inicio_inscripcion, s.fecha_fin_inscripcion FROM bloque_fecha bf
           INNER JOIN sorteo s ON s.id = bf.sorteo_id WHERE bf.id = ? FOR UPDATE`, [reserva.bloque_fecha_id]);
      if (!bloques.length || bloques[0].estado !== "ACTIVO" || bloques[0].sorteo_estado !== "ACTIVO" || normalizarFechaCivil(bloques[0].fecha_inicio_inscripcion) > obtenerFechaCivilArgentina() || normalizarFechaCivil(bloques[0].fecha_fin_inscripcion) < obtenerFechaCivilArgentina()) {
        throw errorReserva("El sorteo ya no admite inscripciones", 409, "SORTEO_CERRADO");
      }
    }
  }
  const destino = accion === "APROBAR" ? reserva.estado_destino : "Rechazada";
  const [estados] = await connection.query("SELECT id FROM estado_reserva WHERE nombre = ?", [destino]);
  if (!estados.length) throw errorReserva("No existe el estado de destino de la reserva", 503, "ESTADO_RESERVA_FALTANTE");
  const [cambio] = await connection.query(
    "UPDATE reserva SET estado_reserva_id = ?, fecha_modificacion = NOW() WHERE id = ? AND estado_reserva_id = ?",
    [estados[0].id, reservaId, reserva.estado_reserva_id]);
  if (cambio.affectedRows !== 1) throw errorReserva("La reserva cambió de estado", 409, "RESERVA_MODIFICADA");
  await connection.query(
    "UPDATE reserva_aprobacion_titular SET decision = ?, fecha_respuesta = NOW() WHERE reserva_id = ? AND decision = 'PENDIENTE'",
    [accion === "APROBAR" ? "APROBADA" : "RECHAZADA", reservaId]);
  await connection.query(
    `INSERT INTO historial_reserva (reserva_id, tipo_operacion, campo_modificado, valor_anterior,
       valor_nuevo, usuario_modificador_id, observaciones) VALUES (?, 'UPDATE', 'estado_reserva_id', ?, ?, ?, ?)`,
    [reservaId, reserva.estado_reserva_id, estados[0].id, actorId, `${accion === "APROBAR" ? "Aprobación" : "Rechazo"} del titular del grupo familiar`]);
  if (accion === "RECHAZAR") {
    const { liberarRecursoBloque } = require("./reservas-turismo");
    await liberarRecursoBloque(connection, reservaId);
  }
  await connection.query(
    `UPDATE notificacion SET leida = 1, fecha_lectura = COALESCE(fecha_lectura, NOW())
      WHERE usuario_id = ? AND tipo = 'RESERVA_APROBACION_TITULAR'
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.reserva_id')) = ?`, [actorId, String(reservaId)]);
  await crearNotificacion(connection, {
    usuarioId: reserva.usuario_id,
    tipo: "RESERVA_RESPUESTA_TITULAR",
    titulo: `Reserva T-${reservaId}: ${destino}`,
    mensaje: `El titular ${accion === "APROBAR" ? "aprobó" : "rechazó"} tu solicitud.`,
    payload: { reserva_id: reservaId, estado: destino, url: "/mis-gestiones" },
  });
  return { ...reserva, estado: destino };
}

const CIERRES_SORTEO = {
  CERRADO: { destino: "No adjudicada", mensaje: "El sorteo cerró antes de que el titular aprobara tu solicitud, así que no participó." },
  CANCELADO: { destino: "Cancelada", mensaje: "Se canceló el sorteo, así que tu solicitud ya no necesita la aprobación del titular." },
};

/**
 * El sorteo se cerró o se canceló con inscripciones que esperaban al titular: sus
 * solicitudes quedan CANCELADA (si no, siguen PENDIENTE para siempre), el aviso del
 * titular se marca leído (ya no hay nada que aprobar) y se le avisa al familiar.
 * Recibe todas las reservas que cambian de estado; sólo toca las que esperaban.
 */
async function cerrarSolicitudesTitularDelSorteo(connection, { reservaIds, cierre }) {
  const datos = CIERRES_SORTEO[cierre];
  const ids = [...new Set((reservaIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!datos || !ids.length) return 0;
  const [pendientes] = await connection.query(
    `SELECT a.reserva_id, r.usuario_id FROM reserva_aprobacion_titular a INNER JOIN reserva r ON r.id = a.reserva_id
      WHERE a.reserva_id IN (?) AND a.decision = 'PENDIENTE' FOR UPDATE`, [ids]);
  if (!pendientes.length) return 0;
  const cerradas = pendientes.map((fila) => Number(fila.reserva_id));
  await connection.query(
    "UPDATE reserva_aprobacion_titular SET decision = 'CANCELADA', fecha_respuesta = NOW() WHERE reserva_id IN (?) AND decision = 'PENDIENTE'",
    [cerradas]);
  await connection.query(
    `UPDATE notificacion SET leida = 1, fecha_lectura = COALESCE(fecha_lectura, NOW())
      WHERE tipo = 'RESERVA_APROBACION_TITULAR' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.reserva_id')) IN (?)`,
    [cerradas.map(String)]);
  for (const fila of pendientes) {
    await crearNotificacion(connection, {
      usuarioId: fila.usuario_id,
      tipo: "RESERVA_RESPUESTA_TITULAR",
      titulo: `Reserva T-${fila.reserva_id}: ${datos.destino}`,
      mensaje: datos.mensaje,
      payload: { reserva_id: Number(fila.reserva_id), estado: datos.destino, url: "/mis-gestiones" },
    });
  }
  return cerradas.length;
}

/** Pasajeros de cada solicitud que ve el titular (edad al ingreso, como se guardó). */
async function obtenerPersonasSolicitudes(connection, reservaIds) {
  const ids = [...new Set((reservaIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const porReserva = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return porReserva;
  const [personas] = await connection.query(
    `SELECT rf.reserva_id, u.nombre, u.apellido, rf.edad FROM reserva_familiar rf
       INNER JOIN usuario u ON u.id = rf.usuario_id
      WHERE rf.reserva_id IN (?) ORDER BY rf.reserva_id, rf.parentesco_id, rf.id`, [ids]);
  for (const persona of personas) {
    porReserva.get(Number(persona.reserva_id))?.push({
      nombre: persona.nombre, apellido: persona.apellido, edad: persona.edad === null ? null : Number(persona.edad),
    });
  }
  return porReserva;
}

module.exports = { ESTADO_PENDIENTE_TITULAR, MENSAJE_CBU, MENSAJE_ADULTO, esFamiliar,
  obtenerGrupoReserva, exigirCbu, validarAdultoResponsable, registrarSolicitudTitular,
  asegurarSinSolicitudTitularPendiente, decidirSolicitudTitular, cerrarSolicitudesTitularDelSorteo,
  obtenerPersonasSolicitudes, PLAZO_RESPUESTA_TITULAR_HORAS, calcularVencimientoTitular,
  expirarSolicitudTitularEnTransaccion, expirarSolicitudesTitularVencidas };
