"use strict";

const { calcularEdadEnFecha, normalizarFechaCivil } = require("./valores-dominio");
const { enviarCorreoPlantilla, urlAplicacion } = require("./correo");
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
                u.modulo_turismo, r.nombre AS rol
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

async function registrarSolicitudTitular(connection, { reservaId, solicitanteId, titularId, estadoDestino }) {
  const [estados] = await connection.query("SELECT id FROM estado_reserva WHERE nombre = ?", [ESTADO_PENDIENTE_TITULAR]);
  if (!estados.length) throw errorReserva("Falta aplicar la migración de aprobación del titular", 503, "APROBACION_TITULAR_NO_MIGRADA");
  await connection.query("UPDATE reserva SET estado_reserva_id = ? WHERE id = ?", [estados[0].id, reservaId]);
  await connection.query(
    `INSERT INTO reserva_aprobacion_titular (reserva_id, solicitante_usuario_id, titular_usuario_id, estado_destino)
     VALUES (?, ?, ?, ?)`, [reservaId, solicitanteId, titularId, estadoDestino]);
  await connection.query(
    `INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, 'RESERVA_APROBACION_TITULAR', ?, ?, ?)`,
    [titularId, `Reserva #${reservaId} pendiente de tu aprobación`,
      "Un familiar solicitó una reserva. Revisá los pasajeros, las fechas y el importe para aprobarla o rechazarla.",
      JSON.stringify({ reserva_id: reservaId, estado: ESTADO_PENDIENTE_TITULAR, url: `/mis-gestiones?aprobacion_reserva=${reservaId}` })]);
  await connection.query(
    `INSERT INTO historial_reserva (reserva_id, tipo_operacion, campo_modificado, valor_anterior,
       valor_nuevo, usuario_modificador_id, observaciones) VALUES (?, 'UPDATE', 'estado_reserva_id', NULL, ?, ?, ?)`,
    [reservaId, estados[0].id, solicitanteId, "Solicitud del familiar pendiente de aprobación del titular"]);
}

async function asegurarSinSolicitudTitularPendiente(connection, usuarioId) {
  const [rows] = await connection.query(
    `SELECT r.id FROM reserva r INNER JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.usuario_id = ? AND er.nombre = ? LIMIT 1 FOR UPDATE`, [usuarioId, ESTADO_PENDIENTE_TITULAR]);
  if (rows.length) throw errorReserva("Ya tenés una reserva pendiente de aprobación del titular", 409, "RESERVA_PENDIENTE_TITULAR_EXISTENTE");
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
    `SELECT r.*, er.nombre AS estado_nombre, a.decision, a.estado_destino
       FROM reserva r INNER JOIN reserva_aprobacion_titular a ON a.reserva_id = r.id
       INNER JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.id = ? AND a.titular_usuario_id = ? FOR UPDATE`, [reservaId, actorId]);
  const reserva = rows[0];
  if (!reserva || reserva.decision !== "PENDIENTE" || reserva.estado_nombre !== ESTADO_PENDIENTE_TITULAR) {
    throw errorReserva("Esta solicitud ya fue resuelta o cancelada", 409, "APROBACION_TITULAR_RESUELTA");
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
  await connection.query(
    "INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, 'RESERVA_RESPUESTA_TITULAR', ?, ?, ?)",
    [reserva.usuario_id, `Reserva #${reservaId}: ${destino}`, `El titular ${accion === "APROBAR" ? "aprobó" : "rechazó"} tu solicitud.`,
      JSON.stringify({ reserva_id: reservaId, estado: destino, url: "/mis-gestiones" })]);
  return { ...reserva, estado: destino };
}

async function enviarCorreoSolicitudTitular(db, reservaId) {
  // Outbox durable: la solicitud se confirma primero; una caída SMTP se reintenta.
  const [rows] = await db.query(
    `SELECT a.reserva_id, u.email, u.nombre, r.fecha_inicio, r.fecha_fin
       FROM reserva_aprobacion_titular a
       INNER JOIN usuario u ON u.id = a.titular_usuario_id
       INNER JOIN reserva r ON r.id = a.reserva_id
      WHERE a.reserva_id = ? AND a.decision = 'PENDIENTE' AND a.correo_enviado_en IS NULL`, [reservaId]);
  if (!rows.length) return;
  const row = rows[0];
  const [claim] = await db.query(
    `UPDATE reserva_aprobacion_titular SET correo_ultimo_intento_en = NOW(), correo_intentos = correo_intentos + 1
      WHERE reserva_id = ? AND correo_enviado_en IS NULL
        AND (correo_ultimo_intento_en IS NULL OR correo_ultimo_intento_en < DATE_SUB(NOW(), INTERVAL 5 MINUTE))`, [reservaId]);
  if (claim.affectedRows !== 1) return;
  const resultado = await enviarCorreoPlantilla({
    para: row.email, asunto: `Reserva #${reservaId}: aprobación del titular`,
    titulo: "Un familiar solicita tu aprobación", saludo: `Hola, ${row.nombre}`,
    parrafos: ["Un integrante de tu grupo familiar envió una solicitud de hospedaje. Ingresá con tu cuenta para revisar y aprobar o rechazar la reserva."],
    datos: [{ etiqueta: "Reserva", valor: `#${reservaId}` },
      { etiqueta: "Ingreso", valor: normalizarFechaCivil(row.fecha_inicio) },
      { etiqueta: "Salida", valor: normalizarFechaCivil(row.fecha_fin) }],
    boton: { texto: "Revisar y aprobar reserva", url: urlAplicacion(`/mis-gestiones?aprobacion_reserva=${reservaId}`) },
  });
  await db.query(`UPDATE reserva_aprobacion_titular SET correo_enviado_en = IF(?, NOW(), NULL), correo_error = ? WHERE reserva_id = ?`,
    [resultado.enviado ? 1 : 0, resultado.enviado ? null : String(resultado.motivo || "error_smtp").slice(0, 255), reservaId]);
}

function iniciarReintentosCorreoTitular(db) {
  let activo = false;
  const ejecutar = async () => {
    if (activo) return;
    activo = true;
    try {
      const [rows] = await db.query(`SELECT reserva_id FROM reserva_aprobacion_titular
        WHERE decision = 'PENDIENTE' AND correo_enviado_en IS NULL
          AND (correo_ultimo_intento_en IS NULL OR correo_ultimo_intento_en < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
        ORDER BY fecha_solicitud LIMIT 30`);
      for (const row of rows) await enviarCorreoSolicitudTitular(db, row.reserva_id);
    } catch (error) { console.error("No se pudo reintentar correo de aprobación del titular:", error.code || error.message); }
    finally { activo = false; }
  };
  const timer = setInterval(() => void ejecutar(), 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { ESTADO_PENDIENTE_TITULAR, MENSAJE_CBU, MENSAJE_ADULTO, esFamiliar,
  obtenerGrupoReserva, exigirCbu, validarAdultoResponsable, registrarSolicitudTitular,
  asegurarSinSolicitudTitularPendiente, decidirSolicitudTitular,
  enviarCorreoSolicitudTitular, iniciarReintentosCorreoTitular };
