"use strict";

// «Pendiente de firma» (estado 15) y la firma de las condiciones en la carga del staff
// (2026-10-22). Espejo de reservas-familiares.js (aprobación del titular).
//
// La carga del staff (admin o departamental) responde «¿Quién firma?»:
//   PRESENCIAL + AFILIADO        la persona afiliada está en la oficina y firma en la pantalla;
//   TELEFONO   + ADMINISTRATIVO  reserva telefónica: el administrativo le lee las condiciones y firma;
//   ENVIO                         se la envía para que la firme desde Mi AJB.
// Con ENVIO la reserva se crea normal y en la misma transacción pasa a «Pendiente de firma»
// (registrarSolicitudFirma): ocupa el lugar, la persona recibe un aviso obligatorio con las
// condiciones y tiene hasta 72 horas (o el fin del día anterior al ingreso, lo que ocurra
// primero) para firmar. Al firmar se acepta la política que se le envió (la de la solicitud,
// aunque la vigente haya cambiado) y la reserva sigue a su estado de destino: Iniciada si la
// cargó administración, Verificada si la cargó la departamental. Si no la quiere, se da de
// baja sin penalidad; si no firma a tiempo, vence (Rechazada) y se libera el lugar.
//
// Concurrencia: se bloquea en el mismo orden que el alta (persona, reserva, solicitud) y cada
// transición es un UPDATE … WHERE estado_reserva_id = <Pendiente de firma> que tiene que
// afectar exactamente una fila.

const { crearNotificacion } = require("./notificaciones");
const {
  diferenciaDiasCivil,
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
  sumarDiasFechaCivil,
} = require("./valores-dominio");
const { esFamiliar, obtenerGrupoReserva, exigirCbu } = require("./reservas-familiares");
const { exigirAltaParaUsuario } = require("../security/restricciones-cuenta");
const {
  confirmarCancelacionPolitica,
  cotizarCancelacion,
  guardarAceptacionPolitica,
  resumenPoliticaTexto,
} = require("./politica-cancelacion");
// reservas-turismo se pide dentro de las funciones (como en reservas-familiares.js): así
// reservas-turismo puede usar este archivo en su mantenimiento sin un ciclo de require.

const ESTADO_PENDIENTE_FIRMA = "Pendiente de firma";
// Alta con id fijo por scripts/migrar-firma-condiciones-reserva.js. El código lo busca por nombre.
const ESTADO_PENDIENTE_FIRMA_ID = 15;
const ESTADO_INICIADA = "Iniciada";
const ESTADO_VERIFICADA = "Verificada";
const ESTADO_RECHAZADA = "Rechazada";
const ESTADO_CANCELADA = "Cancelada";
const DESTINOS_FIRMA = new Set([ESTADO_INICIADA, ESTADO_VERIFICADA]);

const PLAZO_FIRMA_HORAS = 72;
const MINIMO_FIRMA_HORAS = 12;
const MAX_AVISOS_FIRMA = 3;
const MINUTOS_ENTRE_AVISOS = 60;
const MAX_MOTIVO_FIRMA = 500;
const MAX_FIRMA_BYTES = 3 * 1024 * 1024;
const LIMITE_FIRMAS_PENDIENTES = 50;
const LOCK_VENCIMIENTO_FIRMAS = "ajb:reservas:firmas-vencidas:v1";

// Canal de las condiciones en la carga del staff → quién firma.
const CANALES_CARGA_STAFF = Object.freeze({ PRESENCIAL: "AFILIADO", TELEFONO: "ADMINISTRATIVO", ENVIO: null });
const CANALES_FIRMA_EN_PANTALLA = Object.freeze({ PRESENCIAL: "AFILIADO", TELEFONO: "ADMINISTRATIVO" });
const ROLES_CARGA = new Set(["admin", "departamental"]);
const ACCIONES_AFILIADO = new Set(["FIRMAR", "RECHAZAR"]);
const ACCIONES_STAFF = new Set(["FIRMAR_EN_PANTALLA", "REENVIAR"]);

const TIPO_FIRMA_PENDIENTE = "RESERVA_FIRMA_PENDIENTE";
const TIPO_FIRMA_RECIBIDA = "RESERVA_FIRMA_RECIBIDA";
const TIPO_FIRMA_REGISTRADA = "RESERVA_FIRMA_REGISTRADA";
const TIPO_FIRMA_RECHAZADA = "RESERVA_FIRMA_RECHAZADA";
const TIPO_FIRMA_VENCIDA = "RESERVA_FIRMA_VENCIDA";

const MENSAJE_CANAL_REQUERIDO =
  "Elegí quién firma: la persona afiliada en la oficina, vos por teléfono o enviársela para que la firme desde Mi AJB.";
// La pantalla de carga anterior a «¿Quién firma?» no manda el campo: la muestra tal cual en
// un aviso, así que tiene que decir qué hacer (si no, reintenta y recibe el mismo error).
const MENSAJE_PANTALLA_VIEJA =
  "Mi AJB se actualizó y esta pantalla quedó vieja: la reserva no se creó. Recargá la página (F5) y volvé a cargarla; "
  + "en «Resumen» vas a elegir «¿Quién firma?». Si al recargar no aparece, esperá unos minutos y recargá de nuevo.";

function errorFirma(message, statusCode, codigo, detalles = null) {
  const error = Object.assign(new Error(message), { statusCode, codigo });
  if (detalles) error.detalles = detalles;
  return error;
}

function texto(valor) {
  return valor === null || valor === undefined ? "" : String(valor).trim();
}

function parsearJson(valor) {
  if (valor === null || valor === undefined) return null;
  return typeof valor === "string" ? JSON.parse(valor) : valor;
}

function nombrePersona(fila, porDefecto = "La persona afiliada") {
  const nombre = [fila?.nombre ?? fila?.afiliado_nombre, fila?.apellido ?? fila?.afiliado_apellido]
    .map(texto).filter(Boolean).join(" ");
  return nombre || porDefecto;
}

// --- Formatos de los avisos (hora de Argentina) ---------------------------------
function fechaTexto(valor) {
  const fecha = normalizarFechaCivil(typeof valor === "string" ? valor.slice(0, 10) : valor);
  if (!fecha) return "";
  const [anio, mes, dia] = fecha.split("-");
  return `${dia}/${mes}/${anio}`;
}

// DATETIME llega como Date (mysql2) o como texto 'YYYY-MM-DD HH:mm:ss' en hora de Argentina.
function instante(valor) {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  const limpio = texto(valor);
  if (!limpio) return null;
  const fecha = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(limpio)
    ? new Date(`${limpio.replace(" ", "T")}-03:00`)
    : new Date(limpio);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/** «25/10/2026 a las 18:30» (hora de Argentina). */
function fechaHoraTexto(valor) {
  const fecha = instante(valor);
  if (!fecha) return "";
  const partes = Object.fromEntries(new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(fecha).map((parte) => [parte.type, parte.value]));
  return `${partes.day}/${partes.month}/${partes.year} a las ${partes.hour}:${partes.minute}`;
}

function importeTexto(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  const conCentavos = Math.round(numero * 100) % 100 !== 0;
  return `$ ${numero.toLocaleString("es-AR", { minimumFractionDigits: conCentavos ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function minusculaInicial(oracion) {
  const limpio = texto(oracion);
  return limpio ? `${limpio[0].toLocaleLowerCase("es-AR")}${limpio.slice(1)}` : "";
}

/** «Hotel Solís, del 10/01/2027 al 17/01/2027, por $ 480.000» (sin cargo si es 0). */
function descripcionReserva(datos) {
  const partes = [texto(datos?.servicio) || "Turismo"];
  const desde = fechaTexto(datos?.fecha_inicio);
  const hasta = fechaTexto(datos?.fecha_fin);
  if (desde && hasta) partes.push(`del ${desde} al ${hasta}`);
  const importe = importeTexto(datos?.precio_total);
  if (importe !== null) partes.push(Number(datos.precio_total) === 0 ? "sin cargo" : `por ${importe}`);
  return partes.join(", ");
}

function quienCargo(rol) {
  return rol === "departamental" ? "Tu departamental" : "El equipo de Turismo";
}

function condicionesTexto(politica) {
  try {
    return resumenPoliticaTexto(politica);
  } catch (_) {
    return "Las podés ver en el detalle de la reserva.";
  }
}

/**
 * Aviso a la persona afiliada cuando el staff carga una reserva con la firma ya tomada
 * (en la oficina o por teléfono), o una solicitud de convenio / inscripción a sorteo:
 * lleva las condiciones de cancelación en una oración. Quién la leyó o cómo se firmó va en
 * la misma oración que quién cargó (así «te leyó» no queda pegado a otro sujeto) y el paso
 * siguiente, al final.
 */
function textoAvisoCargaStaff({ rolSolicitante, canal = null, estado, datos, politica, tipoAlta = "RESERVA", sorteoNombre = null }) {
  const quien = quienCargo(rolSolicitante);
  const condiciones = minusculaInicial(condicionesTexto(politica));
  if (tipoAlta === "SORTEO") {
    const sorteo = texto(sorteoNombre) ? ` «${texto(sorteoNombre)}»` : "";
    const desde = fechaTexto(datos?.fecha_inicio);
    const hasta = fechaTexto(datos?.fecha_fin);
    return `${quien} te anotó en el sorteo${sorteo}${desde && hasta ? ` para la estadía del ${desde} al ${hasta}` : ""}. `
      + `Si salís sorteado, se aplican estas condiciones de cancelación: ${condiciones} `
      + "Las podés ver siempre en el detalle de la inscripción.";
  }
  let carga;
  let siguiente = "";
  if (tipoAlta === "CONVENIO") {
    carga = `${quien} cargó a tu nombre una solicitud de convenio hotelero (${descripcionReserva({ ...datos, precio_total: null })})`;
  } else {
    const verbo = estado === ESTADO_VERIFICADA ? "cargó y verificó" : "cargó";
    carga = `${quien} ${verbo}${canal === "TELEFONO" ? " por teléfono" : ""} una reserva a tu nombre (${descripcionReserva(datos)})`;
    if (estado === ESTADO_INICIADA) siguiente = " La departamental tiene 72 horas para verificarla.";
  }
  if (canal === "TELEFONO") {
    return `${carga} y te leyó estas condiciones de cancelación: ${condiciones}${siguiente} `
      + "Si no estás de acuerdo, avisale a tu departamental cuanto antes.";
  }
  if (canal === "PRESENCIAL") {
    return `${carga} y la firmaste en la oficina con estas condiciones de cancelación: ${condiciones} `
      + `Las podés ver siempre en el detalle de la reserva.${siguiente}`;
  }
  return `${carga}. Condiciones de cancelación: ${condiciones} Las podés ver siempre en el detalle de la reserva.${siguiente}`;
}

/**
 * Aviso a la persona cuando el staff registra en pantalla la firma de una reserva que se le
 * había enviado (vino a la oficina o lo confirmó por teléfono): con las condiciones, en la
 * misma oración que quién la registró, y el paso siguiente al final.
 */
function textoAvisoFirmaRegistrada({ reservaId, rolActor, canal, estado, datos, politica }) {
  const condiciones = minusculaInicial(condicionesTexto(politica));
  const siguiente = estado === ESTADO_VERIFICADA
    ? "Ya pasó a administración para aprobarla."
    : "La departamental tiene 72 horas para verificarla.";
  if (canal === "TELEFONO") {
    return `${quienCargo(rolActor)} registró por teléfono tu conformidad con la reserva T-${reservaId} (${descripcionReserva(datos)}) `
      + `y te leyó estas condiciones de cancelación: ${condiciones} ${siguiente} `
      + "Si no estás de acuerdo, avisale a tu departamental cuanto antes.";
  }
  return `Firmaste en la oficina la reserva T-${reservaId} (${descripcionReserva(datos)}) con estas condiciones de cancelación: `
    + `${condiciones} Las podés ver siempre en el detalle de la reserva. ${siguiente}`;
}

/** Aviso obligatorio de una reserva enviada a firmar (también el recordatorio). */
function textoAvisoFirmaPendiente({ reservaId, rolSolicitante, datos, politica, venceEn, recordatorio = false }) {
  const condiciones = minusculaInicial(condicionesTexto(politica));
  const inicio = recordatorio
    ? `Te recordamos que ${minusculaInicial(quienCargo(rolSolicitante))} cargó a tu nombre la reserva T-${reservaId}`
    : `${quienCargo(rolSolicitante)} cargó a tu nombre la reserva T-${reservaId}`;
  return `${inicio} (${descripcionReserva(datos)}). `
    + `Para confirmarla, leé las condiciones y firmá desde Mi AJB antes del ${fechaHoraTexto(venceEn)}. `
    + `Condiciones de cancelación: ${condiciones} `
    + "Si no la firmás a tiempo, se da de baja y se libera el lugar.";
}

// --- Firma (PNG en base64), con la misma validación que el alta -----------------
function decodificarFirmaPng(valor) {
  if (typeof valor !== "string" || !valor.trim()) {
    throw errorFirma("Falta la firma en el recuadro.", 400, "FIRMA_REQUERIDA");
  }
  if (valor.length > MAX_FIRMA_BYTES) throw errorFirma("La firma supera el tamaño permitido.", 400, "FIRMA_INVALIDA");
  const dataUri = valor.match(/^data:(image\/png);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (valor.startsWith("data:") && !dataUri) throw errorFirma("La firma debe ser una imagen PNG.", 400, "FIRMA_INVALIDA");
  const base64 = (dataUri ? dataUri[2] : valor).replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw errorFirma("La firma no es válida.", 400, "FIRMA_INVALIDA");
  const buffer = Buffer.from(base64, "base64");
  const firmaPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(firmaPng)) {
    throw errorFirma("La firma no es una imagen PNG válida.", 400, "FIRMA_INVALIDA");
  }
  return buffer;
}

/**
 * «¿Quién firma?» de la carga del staff. El afiliado que reserva solo no elige: modo
 * AFILIADO, canal APP (si manda los campos del staff, se ignoran). `canalObligatorio:
 * false` (convenio y sorteo, sin pantalla del staff): sin canal, la carga queda sin dato.
 * `permiteEnvio: false`: el envío a firmar es sólo para reservas de alojamiento.
 */
function resolverFirmaCarga({ rol, body = {}, permiteEnvio = true, canalObligatorio = true }) {
  if (!ROLES_CARGA.has(rol)) {
    return { modo: "AFILIADO", canal: "APP", firmaPor: "AFILIADO", esEnvio: false, esCargaAdministrativa: false };
  }
  // Sin la clave (no vacía: ausente) es la pantalla de antes de «¿Quién firma?», abierta desde
  // antes del deploy. Con la clave vacía o inválida sigue CANAL_POLITICA_REQUERIDO.
  if (canalObligatorio && !Object.prototype.hasOwnProperty.call(body || {}, "politica_cancelacion_canal")) {
    throw errorFirma(MENSAJE_PANTALLA_VIEJA, 400, "PANTALLA_DESACTUALIZADA");
  }
  const valorCanal = texto(body?.politica_cancelacion_canal).toUpperCase();
  if (!valorCanal) {
    if (canalObligatorio) throw errorFirma(MENSAJE_CANAL_REQUERIDO, 400, "CANAL_POLITICA_REQUERIDO");
    return { modo: "CARGA_ADMINISTRATIVA", canal: null, firmaPor: null, esEnvio: false, esCargaAdministrativa: true };
  }
  if (!Object.prototype.hasOwnProperty.call(CANALES_CARGA_STAFF, valorCanal)) {
    throw errorFirma(MENSAJE_CANAL_REQUERIDO, 400, "CANAL_POLITICA_REQUERIDO");
  }
  if (valorCanal === "ENVIO") {
    if (!permiteEnvio) {
      throw errorFirma("El envío para firmar está disponible sólo para reservas de alojamiento.", 400, "ENVIO_NO_DISPONIBLE");
    }
    // Nadie firma ahora: la firma (y la aceptación) llegan cuando la persona firme desde Mi AJB.
    return { modo: null, canal: "ENVIO", firmaPor: null, esEnvio: true, esCargaAdministrativa: true };
  }
  const firmaPor = CANALES_CARGA_STAFF[valorCanal];
  if (texto(body?.firma_por).toUpperCase() !== firmaPor) {
    throw errorFirma(
      valorCanal === "PRESENCIAL"
        ? "Si la persona afiliada está en la oficina, firma ella."
        : "En una reserva por teléfono firma el administrativo que la carga.",
      400, "FIRMA_POR_INVALIDA"
    );
  }
  if (!texto(body?.firma)) {
    throw errorFirma(
      valorCanal === "PRESENCIAL"
        ? "Falta la firma de la persona afiliada en el recuadro de las condiciones."
        : "Falta tu firma en el recuadro de las condiciones.",
      400, "FIRMA_REQUERIDA"
    );
  }
  return { modo: "CARGA_ADMINISTRATIVA", canal: valorCanal, firmaPor, esEnvio: false, esCargaAdministrativa: true };
}

/**
 * Hasta cuándo puede firmar: 72 horas o el fin del día anterior al ingreso, lo que ocurra
 * primero. Con menos de 12 horas no se envía (409 FIRMA_SIN_TIEMPO). Devuelve un Date sin
 * milisegundos.
 */
function calcularVencimientoFirma({ fechaInicio, ahora = new Date() }) {
  const inicio = normalizarFechaCivil(typeof fechaInicio === "string" ? fechaInicio.slice(0, 10) : fechaInicio);
  const diaAnterior = inicio ? sumarDiasFechaCivil(inicio, -1) : null;
  if (!diaAnterior) throw errorFirma("La fecha de ingreso no es válida.", 400, "FECHA_INICIO_INVALIDA");
  const finDiaAnterior = new Date(`${diaAnterior}T23:59:59-03:00`).getTime();
  const tope = ahora.getTime() + PLAZO_FIRMA_HORAS * 3600 * 1000;
  const vence = Math.floor(Math.min(finDiaAnterior, tope) / 1000) * 1000;
  if (vence - ahora.getTime() < MINIMO_FIRMA_HORAS * 3600 * 1000) {
    throw errorFirma(
      "La estadía empieza muy pronto para enviarla a firmar. Que la persona afiliada firme en la oficina o firmá vos por teléfono.",
      409, "FIRMA_SIN_TIEMPO"
    );
  }
  return new Date(vence);
}

/**
 * Desde cuándo corren las 72 horas de verificación de una reserva Iniciada: la aprobación
 * del titular (reserva de un familiar), la firma de la persona afiliada (reserva que le
 * envió administración) o la creación. Un solo fragmento para el mantenimiento, la
 * edición y el detalle.
 */
function sqlInicioPlazoVerificacion(alias = "r") {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("Alias SQL inválido");
  return `COALESCE(
      (SELECT a.fecha_respuesta FROM reserva_aprobacion_titular a WHERE a.reserva_id = ${alias}.id AND a.decision = 'APROBADA'),
      (SELECT f.fecha_respuesta FROM reserva_firma_afiliado f WHERE f.reserva_id = ${alias}.id AND f.decision = 'FIRMADA'),
      ${alias}.fecha_creacion)`;
}

// --- Lecturas -------------------------------------------------------------------
async function obtenerEstadoReservaIdPorNombre(connection, nombre) {
  const [rows] = await connection.query("SELECT id FROM estado_reserva WHERE nombre = ? LIMIT 1", [nombre]);
  return rows.length > 0 ? Number(rows[0].id) : null;
}

async function exigirEstadoReserva(connection, nombre) {
  const id = await obtenerEstadoReservaIdPorNombre(connection, nombre);
  if (!id) {
    throw errorFirma(
      nombre === ESTADO_PENDIENTE_FIRMA
        ? "Falta aplicar la migración de la firma de las condiciones (estado «Pendiente de firma»)."
        : `No existe el estado de reserva «${nombre}».`,
      503,
      nombre === ESTADO_PENDIENTE_FIRMA ? "FIRMA_AFILIADO_NO_MIGRADA" : "ESTADO_RESERVA_FALTANTE"
    );
  }
  return id;
}

/** Servicio, fechas, importe y persona de la reserva, para los textos de los avisos. */
async function datosAvisoReserva(connection, reservaId) {
  const [rows] = await connection.query(
    `SELECT r.id, r.usuario_id, r.precio_total, r.servicio_id, r.recurso_id, r.bloque_fecha_id, r.modalidad,
            DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin,
            COALESCE(s.nombre, ch.nombre, 'Turismo') AS servicio, rec.nombre AS recurso,
            u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido,
            u.departamental_id AS usuario_departamental_id
       FROM reserva r
       INNER JOIN usuario u ON u.id = r.usuario_id
       LEFT JOIN recurso rec ON rec.id = r.recurso_id
       LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
       LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
      WHERE r.id = ?
      LIMIT 1`,
    [reservaId]
  );
  return rows[0] || null;
}

function eventoDisponibilidad(datos) {
  if (!datos || !Number(datos.servicio_id)) return null;
  return {
    servicio_id: Number(datos.servicio_id),
    recurso_id: datos.recurso_id == null ? null : Number(datos.recurso_id),
    bloque_fecha_id: datos.bloque_fecha_id == null ? null : Number(datos.bloque_fecha_id),
    fecha_inicio: datos.fecha_inicio,
    fecha_fin: datos.fecha_fin,
  };
}

// --- Historial y avisos ---------------------------------------------------------
function valorHistorial(valor) {
  return valor === null || valor === undefined ? null : String(valor);
}

/** Historial estricto (con IP y navegador): la auditoría confirma o revierte con el cambio. */
async function insertarHistorial(connection, { reservaId, usuarioId = null, campos, observaciones, contexto = {} }) {
  const ip = texto(contexto.ip).slice(0, 45) || null;
  const navegador = texto(contexto.userAgent).slice(0, 255) || null;
  for (const campo of campos) {
    await connection.query(
      `INSERT INTO historial_reserva
         (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo,
          usuario_modificador_id, ip_address, user_agent, observaciones)
       VALUES (?, 'UPDATE', ?, ?, ?, ?, ?, ?, ?)`,
      [reservaId, campo.campo, valorHistorial(campo.valorAnterior), valorHistorial(campo.valorNuevo),
        usuarioId, ip, navegador, observaciones]
    );
  }
}

async function marcarAvisoFirmaLeido(connection, { usuarioId, reservaId }) {
  await connection.query(
    `UPDATE notificacion SET leida = 1, fecha_lectura = COALESCE(fecha_lectura, NOW())
      WHERE usuario_id = ? AND tipo = ? AND leida = 0
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.reserva_id')) = ?`,
    [usuarioId, TIPO_FIRMA_PENDIENTE, String(reservaId)]
  );
}

/**
 * Staff de Turismo de la reserva (el mismo criterio que notificarStaffTurismo de
 * user.js): admins, admin-central con Turismo y la departamental de la persona afiliada.
 * `sinAdmins`: para no duplicar el aviso cuando los admins reciben RESERVA_PARA_APROBAR.
 * El staff que envió la reserva entra si sigue habilitado; `excluirId` (quien hizo la
 * acción) no recibe aviso de lo que acaba de hacer.
 */
async function avisarStaffTurismo(connection, {
  departamentalId, solicitanteId = null, excluirId = null, sinAdmins = false, tipo, titulo, mensaje, payload,
}) {
  const [usuarios] = await connection.query(
    `SELECT u.id, r.nombre AS rol FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.habilitado = 'Y'
        AND (r.nombre = 'admin'
          OR (r.nombre = 'admin-central' AND (u.area_turismo IS NULL OR u.area_turismo = 1))
          OR (r.nombre = 'departamental' AND u.departamental_id = ?
              AND (u.area_turismo IS NULL OR u.area_turismo = 1)))`,
    [departamentalId || 0]
  );
  const destinatarios = new Set();
  for (const usuario of usuarios) {
    const id = Number(usuario.id);
    if (sinAdmins && usuario.rol === "admin" && id !== Number(solicitanteId)) continue;
    destinatarios.add(id);
  }
  if (excluirId) destinatarios.delete(Number(excluirId));
  for (const usuarioId of destinatarios) {
    await crearNotificacion(connection, { usuarioId, tipo, titulo, mensaje, payload, categoria: "estados" });
  }
  return [...destinatarios];
}

async function avisarAdministradoresParaAprobar(connection, { reservaId, excluirId = null, mensaje }) {
  const [admins] = await connection.query(
    `SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.habilitado = 'Y' AND r.nombre = 'admin'`
  );
  for (const admin of admins) {
    if (excluirId && Number(admin.id) === Number(excluirId)) continue;
    await crearNotificacion(connection, {
      usuarioId: admin.id,
      tipo: "RESERVA_PARA_APROBAR",
      titulo: `Reserva #${reservaId} verificada`,
      mensaje,
      payload: { reserva_id: reservaId, estado: ESTADO_VERIFICADA },
    });
  }
}

/**
 * Aviso obligatorio a la persona afiliada cuando el staff carga a su nombre con la firma
 * ya tomada (o una solicitud de convenio / inscripción a sorteo): con las condiciones.
 */
async function avisarAfiliadoCargaStaff(connection, {
  reservaId, afiliadoId, rolSolicitante, canal = null, estado, politica, tipo, titulo,
  tipoAlta = "RESERVA", sorteoNombre = null,
}) {
  const datos = await datosAvisoReserva(connection, reservaId);
  return crearNotificacion(connection, {
    usuarioId: afiliadoId,
    tipo,
    titulo,
    mensaje: textoAvisoCargaStaff({ rolSolicitante, canal, estado, datos, politica, tipoAlta, sorteoNombre }),
    payload: { reserva_id: reservaId, estado },
    obligatoria: true,
  });
}

// --- Una reserva esperando firma por persona --------------------------------------
/**
 * Solicitudes PENDIENTES de la persona, bloqueadas. Las vencidas se dan de baja acá mismo
 * (vencimiento al acceder) y no cuentan. Sin la migración no hay ninguna.
 */
async function firmasPendientesDeUsuario(connection, usuarioId) {
  const estadoId = await obtenerEstadoReservaIdPorNombre(connection, ESTADO_PENDIENTE_FIRMA);
  if (!estadoId) return [];
  const [filas] = await connection.query(
    `SELECT f.reserva_id, f.estado_destino, f.vence_en, (f.vence_en <= NOW()) AS vencida,
            r.modalidad, DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin, r.fecha_creacion
       FROM reserva_firma_afiliado f
       INNER JOIN reserva r ON r.id = f.reserva_id
      WHERE f.afiliado_usuario_id = ? AND f.decision = 'PENDIENTE' AND r.estado_reserva_id = ?
      ORDER BY f.fecha_solicitud, f.reserva_id
      FOR UPDATE OF f, r`,
    [usuarioId, estadoId]
  );
  const activas = [];
  for (const fila of filas) {
    if (Number(fila.vencida) === 1) await expirarFirmaEnTransaccion(connection, { reserva_id: fila.reserva_id });
    else activas.push(fila);
  }
  return activas;
}

async function detalleReservaFirma(connection, fila) {
  const datos = await datosAvisoReserva(connection, fila.reserva_id);
  return {
    id: Number(fila.reserva_id),
    numero_reserva: String(fila.reserva_id),
    codigo: `T-${fila.reserva_id}`,
    estado: ESTADO_PENDIENTE_FIRMA,
    modalidad: fila.modalidad || datos?.modalidad || null,
    servicio: datos?.servicio || "Turismo",
    recurso: datos?.recurso || "Recurso de turismo",
    fecha_inicio: fila.fecha_inicio || datos?.fecha_inicio || null,
    fecha_fin: fila.fecha_fin || datos?.fecha_fin || null,
    fecha_creacion: fila.fecha_creacion || null,
    firma_vence_en: fila.vence_en || null,
  };
}

/** 409 FIRMA_PENDIENTE_EXISTENTE: una sola reserva esperando firma por persona. */
async function asegurarSinFirmaPendiente(connection, { usuarioId, nombre = null }) {
  const [pendiente] = await firmasPendientesDeUsuario(connection, usuarioId);
  if (!pendiente) return;
  throw errorFirma(
    `${texto(nombre) || "La persona afiliada"} ya tiene la reserva T-${pendiente.reserva_id} esperando su firma. `
      + "Dala de baja o esperá que la firme antes de enviarle otra.",
    409, "FIRMA_PENDIENTE_EXISTENTE", { reserva: await detalleReservaFirma(connection, pendiente) }
  );
}

/**
 * Una firma pendiente que al firmarse queda «Iniciada» cuenta como la Iniciada de la
 * persona: no puede tener otra. Devuelve la reserva (con el formato del 409
 * RESERVA_INICIADA_EXISTENTE) o null.
 */
async function buscarFirmaPendienteIniciada(connection, usuarioId) {
  const activas = await firmasPendientesDeUsuario(connection, usuarioId);
  const fila = activas.find((pendiente) => pendiente.estado_destino === ESTADO_INICIADA);
  return fila ? detalleReservaFirma(connection, fila) : null;
}

// --- Envío a firmar ---------------------------------------------------------------
/**
 * Pasa a «Pendiente de firma» una reserva recién creada por el staff, en la misma
 * transacción del alta: guarda la solicitud con la política que se le envía, le avisa a
 * la persona (aviso obligatorio) y deja el historial con el estado anterior real.
 * No inserta reserva_politica_cancelacion: eso pasa al firmar.
 */
async function registrarSolicitudFirma(connection, {
  reservaId, afiliadoId, solicitante, estadoAnteriorId, estadoDestino, politica, venceEn, contexto = {},
}) {
  if (!DESTINOS_FIRMA.has(estadoDestino)) throw new Error(`Estado de destino inválido para la firma: ${estadoDestino}`);
  const estadoId = await exigirEstadoReserva(connection, ESTADO_PENDIENTE_FIRMA);
  const [cambio] = await connection.query(
    "UPDATE reserva SET estado_reserva_id = ? WHERE id = ? AND estado_reserva_id = ?",
    [estadoId, reservaId, estadoAnteriorId]
  );
  if (Number(cambio?.affectedRows) !== 1) {
    throw errorFirma("La reserva cambió mientras se guardaba. Volvé a intentarlo.", 409, "RESERVA_MODIFICADA");
  }
  await connection.query(
    `INSERT INTO reserva_firma_afiliado
       (reserva_id, afiliado_usuario_id, solicitada_por_usuario_id, estado_destino,
        politica_id, politica_version, politica_snapshot_json, vence_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [reservaId, afiliadoId, solicitante.id, estadoDestino, politica.id, politica.version, JSON.stringify(politica), venceEn]
  );
  const datos = await datosAvisoReserva(connection, reservaId);
  await crearNotificacion(connection, {
    usuarioId: afiliadoId,
    tipo: TIPO_FIRMA_PENDIENTE,
    titulo: `Firmá tu reserva T-${reservaId}`,
    mensaje: textoAvisoFirmaPendiente({ reservaId, rolSolicitante: solicitante.rol, datos, politica, venceEn }),
    payload: {
      reserva_id: reservaId,
      estado: ESTADO_PENDIENTE_FIRMA,
      vence_en: instante(venceEn)?.toISOString() || null,
      url: `/turismo/reserva/detalle/${reservaId}`,
    },
    categoria: "gestiones",
    obligatoria: true,
  });
  await insertarHistorial(connection, {
    reservaId,
    usuarioId: solicitante.id,
    contexto,
    campos: [
      { campo: "estado_reserva_id", valorAnterior: estadoAnteriorId, valorNuevo: estadoId },
      { campo: "reserva_firma_afiliado.decision", valorAnterior: null, valorNuevo: "PENDIENTE" },
    ],
    observaciones: `Enviada a firmar a la persona afiliada desde Mi AJB; vence el ${fechaHoraTexto(venceEn)}. `
      + `Cuando la firme, queda «${estadoDestino}».`,
  });
  return { estado: ESTADO_PENDIENTE_FIRMA, estado_destino: estadoDestino, vence_en: venceEn };
}

// --- Vencimiento ------------------------------------------------------------------
/**
 * Da de baja una reserva que no se firmó a tiempo: Rechazada, solicitud VENCIDA, lugar
 * liberado, historial automático y avisos a la persona y al staff. Devuelve false si
 * otra transacción ya la resolvió.
 */
async function expirarFirmaEnTransaccion(connection, { reserva_id: reservaId }) {
  const pendienteId = await exigirEstadoReserva(connection, ESTADO_PENDIENTE_FIRMA);
  const rechazadaId = await exigirEstadoReserva(connection, ESTADO_RECHAZADA);
  const [cambio] = await connection.query(
    "UPDATE reserva SET estado_reserva_id = ?, fecha_modificacion = NOW() WHERE id = ? AND estado_reserva_id = ?",
    [rechazadaId, reservaId, pendienteId]
  );
  if (Number(cambio?.affectedRows) !== 1) return false;
  const [solicitudes] = await connection.query(
    "SELECT solicitada_por_usuario_id, afiliado_usuario_id, vence_en FROM reserva_firma_afiliado WHERE reserva_id = ?",
    [reservaId]
  );
  const solicitud = solicitudes[0] || {};
  await connection.query(
    `UPDATE reserva_firma_afiliado SET decision = 'VENCIDA', fecha_respuesta = NOW()
      WHERE reserva_id = ? AND decision = 'PENDIENTE'`,
    [reservaId]
  );
  const { liberarRecursoBloque } = require("./reservas-turismo");
  await liberarRecursoBloque(connection, reservaId);
  await insertarHistorial(connection, {
    reservaId,
    campos: [
      { campo: "estado_reserva_id", valorAnterior: pendienteId, valorNuevo: rechazadaId },
      { campo: "reserva_firma_afiliado.decision", valorAnterior: "PENDIENTE", valorNuevo: "VENCIDA" },
    ],
    observaciones: `Se dio de baja sola: la persona afiliada no la firmó a tiempo (vencía el ${fechaHoraTexto(solicitud.vence_en)}). Se liberó el lugar.`,
  });
  const datos = await datosAvisoReserva(connection, reservaId);
  const afiliadoId = solicitud.afiliado_usuario_id || datos?.usuario_id;
  await marcarAvisoFirmaLeido(connection, { usuarioId: afiliadoId, reservaId });
  await crearNotificacion(connection, {
    usuarioId: afiliadoId,
    tipo: TIPO_FIRMA_VENCIDA,
    titulo: `Reserva T-${reservaId} dada de baja`,
    mensaje: "No recibimos tu firma a tiempo. La reserva se dio de baja y se liberó el lugar. "
      + "Si todavía querés viajar, pedile a tu departamental que la cargue de nuevo.",
    payload: { reserva_id: reservaId, estado: ESTADO_RECHAZADA, motivo: "FIRMA_VENCIDA" },
    categoria: "estados",
  });
  await avisarStaffTurismo(connection, {
    departamentalId: datos?.usuario_departamental_id,
    solicitanteId: solicitud.solicitada_por_usuario_id,
    tipo: TIPO_FIRMA_VENCIDA,
    titulo: `Reserva T-${reservaId} dada de baja: no se firmó`,
    mensaje: `${nombrePersona(datos)} no firmó a tiempo la reserva que se le envió (${descripcionReserva(datos)}). `
      + "Se dio de baja y se liberó el lugar.",
    payload: { reserva_id: reservaId, estado: ESTADO_RECHAZADA, motivo: "FIRMA_VENCIDA" },
  });
  return { reservaId, evento: eventoDisponibilidad(datos) };
}

// Sólo la falta de la tabla o del estado 15 es «falta la migración». Una columna
// desconocida (ER_BAD_FIELD_ERROR) es un error de verdad y se propaga: si no, el
// vencimiento quedaría apagado sin rastro.
function faltaMigracionFirma(error) {
  return error?.code === "ER_NO_SUCH_TABLE"
    || error?.errno === 1146
    || error?.codigo === "FIRMA_AFILIADO_NO_MIGRADA";
}

/**
 * Mantenimiento: da de baja las reservas cuya firma venció. Conexión, lock y transacción
 * propios, así un error acá no frena los demás vencimientos. Si falta la migración, no
 * hace nada (devuelve omitido: 'SIN_MIGRACION' y, si vino de un error, su `codigo`).
 */
async function expirarFirmasVencidas(db, { limite = 100 } = {}) {
  const limiteSeguro = Number.isInteger(Number(limite)) ? Math.max(1, Math.min(500, Number(limite))) : 100;
  const connection = await db.getConnection();
  let lockTomado = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 0) AS adquirido", [LOCK_VENCIMIENTO_FIRMAS]);
    lockTomado = Number(locks[0]?.adquirido) === 1;
    if (!lockTomado) return { ejecutado: false, firmas: 0, eventos: [] };
    await connection.beginTransaction();
    const pendienteId = await obtenerEstadoReservaIdPorNombre(connection, ESTADO_PENDIENTE_FIRMA);
    if (!pendienteId) {
      await connection.rollback();
      return { ejecutado: false, firmas: 0, eventos: [], omitido: "SIN_MIGRACION" };
    }
    const [filas] = await connection.query(
      `SELECT f.reserva_id
         FROM reserva_firma_afiliado f
         STRAIGHT_JOIN reserva r ON r.id = f.reserva_id
        WHERE f.decision = 'PENDIENTE'
          AND f.vence_en <= NOW()
          AND r.estado_reserva_id = ?
        ORDER BY f.vence_en ASC, f.reserva_id ASC
        LIMIT ${limiteSeguro}
        FOR UPDATE SKIP LOCKED`,
      [pendienteId]
    );
    const eventos = [];
    for (const fila of filas) {
      const resultado = await expirarFirmaEnTransaccion(connection, fila);
      if (resultado) eventos.push(resultado.evento);
    }
    await connection.commit();
    return { ejecutado: true, firmas: eventos.length, eventos: eventos.filter(Boolean) };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // La conexión puede haberse cerrado luego del error original.
    }
    if (faltaMigracionFirma(error)) {
      return { ejecutado: false, firmas: 0, eventos: [], omitido: "SIN_MIGRACION", codigo: error.code || error.codigo || null };
    }
    throw error;
  } finally {
    if (lockTomado) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_VENCIMIENTO_FIRMAS]);
      } catch (_) {
        // El lock de sesión se libera igual al cerrar la conexión.
      }
    }
    connection.release();
  }
}

// --- Lista de la persona afiliada --------------------------------------------------
/** GET /reservas/firmas-pendientes: lo que la persona tiene para firmar (sin nombres del staff). */
async function listarFirmasPendientes(connection, usuarioId) {
  const estadoId = await obtenerEstadoReservaIdPorNombre(connection, ESTADO_PENDIENTE_FIRMA);
  if (!estadoId) return [];
  const [filas] = await connection.query(
    `SELECT r.id, COALESCE(r.modalidad, 'FECHA_LIBRE') AS modalidad, r.precio_total,
            DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin,
            COALESCE(s.nombre, ch.nombre, 'Turismo') AS servicio, COALESCE(rec.nombre, ch.nombre) AS recurso,
            f.estado_destino, f.fecha_solicitud, f.vence_en, f.politica_id, f.politica_version, f.politica_snapshot_json,
            ro.nombre AS solicitada_por_rol, d.nombre AS departamental
       FROM reserva_firma_afiliado f
       INNER JOIN reserva r ON r.id = f.reserva_id
       INNER JOIN usuario u ON u.id = r.usuario_id
       LEFT JOIN departamental d ON d.id = u.departamental_id
       LEFT JOIN usuario sol ON sol.id = f.solicitada_por_usuario_id
       LEFT JOIN rol ro ON ro.id = sol.rol_id
       LEFT JOIN recurso rec ON rec.id = r.recurso_id
       LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
       LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
      WHERE f.afiliado_usuario_id = ? AND r.usuario_id = ?
        AND f.decision = 'PENDIENTE' AND r.estado_reserva_id = ? AND f.vence_en > NOW()
      ORDER BY f.vence_en ASC, r.id ASC
      LIMIT ${LIMITE_FIRMAS_PENDIENTES}`,
    [usuarioId, usuarioId, estadoId]
  );
  if (filas.length === 0) return [];
  const [personas] = await connection.query(
    `SELECT rf.reserva_id, u.nombre, u.apellido, rf.edad
       FROM reserva_familiar rf INNER JOIN usuario u ON u.id = rf.usuario_id
      WHERE rf.reserva_id IN (?)
      ORDER BY rf.reserva_id, rf.id`,
    [filas.map((fila) => fila.id)]
  );
  return filas.map((fila) => {
    const snapshot = parsearJson(fila.politica_snapshot_json) || {};
    const politica = {
      id: Number(snapshot.id || fila.politica_id),
      version: Number(snapshot.version || fila.politica_version),
      titulo: snapshot.titulo || null,
      reglas: Array.isArray(snapshot.reglas) ? snapshot.reglas : [],
    };
    return {
      id: Number(fila.id),
      codigo: `T-${fila.id}`,
      estado: ESTADO_PENDIENTE_FIRMA,
      modalidad: fila.modalidad,
      servicio: fila.servicio,
      recurso: fila.recurso || null,
      fecha_inicio: fila.fecha_inicio,
      fecha_fin: fila.fecha_fin,
      precio_total: fila.precio_total == null ? null : Number(fila.precio_total),
      personas: personas
        .filter((persona) => Number(persona.reserva_id) === Number(fila.id))
        .map((persona) => ({ nombre: persona.nombre, apellido: persona.apellido, edad: persona.edad == null ? null : Number(persona.edad) })),
      origen: fila.solicitada_por_rol === "departamental" ? "DEPARTAMENTAL" : "TURISMO",
      departamental: fila.departamental || null,
      estado_destino: fila.estado_destino,
      fecha_solicitud: fila.fecha_solicitud,
      vence_en: fila.vence_en,
      politica,
      condiciones_resumen: condicionesTexto(politica),
    };
  });
}

// --- Respuesta: firmar, no la quiero, firmar en pantalla, volver a avisar -----------
async function autorizarActor(connection, { actor, previa, esAccionAfiliado }) {
  if (esAccionAfiliado) {
    const esDuenio = Number(actor.id) === Number(previa.usuario_id)
      && (previa.afiliado_usuario_id == null || Number(actor.id) === Number(previa.afiliado_usuario_id));
    if (!esDuenio) throw errorFirma("Sólo la persona a cuyo nombre está la reserva puede firmarla.", 403, "FIRMA_NO_AUTORIZADA");
    return;
  }
  if (actor.rol === "admin") return;
  const [editores] = await connection.query("SELECT departamental_id FROM usuario WHERE id = ? LIMIT 1", [actor.id]);
  const departamentalActor = Number(editores[0]?.departamental_id);
  if (!departamentalActor || departamentalActor !== Number(previa.usuario_departamental_id)) {
    throw errorFirma("No podés gestionar reservas de otra departamental.", 403, "FIRMA_NO_AUTORIZADA");
  }
}

async function bloquearPersona(connection, usuarioId) {
  const [rows] = await connection.query(
    `SELECT u.id, u.nombre, u.apellido, u.cbu, u.email, u.usuario_familiar_id, u.es_familiar, u.parentesco_id,
            u.departamental_id, u.habilitado, u.modulo_turismo, r.nombre AS rol,
            u.bloqueo_tipo, u.bloqueo_modulos, u.bloqueo_mensaje
       FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.id = ?
      LIMIT 1
      FOR UPDATE`,
    [usuarioId]
  );
  if (!rows[0]) throw errorFirma("No encontramos a la persona afiliada de la reserva.", 404, "AFILIADO_NO_ENCONTRADO");
  return rows[0];
}

/** Al firmar se vuelve a controlar lo mismo que en el alta: habilitación, bloqueos y CBU del grupo. */
async function controlarPersonaParaFirmar(connection, persona) {
  const invitadoFamiliar = persona.rol === "invitado" && esFamiliar(persona);
  if (persona.habilitado !== "Y" || (persona.rol !== "afiliado" && !invitadoFamiliar)) {
    throw errorFirma("La persona afiliada ya no está habilitada para reservar.", 422, "TITULAR_NO_AFILIADO");
  }
  if (Number(persona.modulo_turismo) !== 1 && !invitadoFamiliar) {
    throw errorFirma("La persona afiliada no tiene habilitado el módulo Turismo.", 403, "MODULO_TURISMO_DESHABILITADO");
  }
  const grupo = await obtenerGrupoReserva(connection, persona, { forUpdate: true });
  exigirAltaParaUsuario(persona, "turismo");
  exigirAltaParaUsuario(grupo.titular, "turismo");
  exigirCbu(grupo);
  return grupo;
}

async function cargarSolicitudBloqueada(connection, reservaId) {
  const [rows] = await connection.query(
    `SELECT r.id, r.usuario_id, r.estado_reserva_id, r.modalidad, r.servicio_id, r.recurso_id, r.bloque_fecha_id,
            r.precio_total, r.firma_archivo, r.fecha_creacion,
            DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin,
            f.reserva_id AS solicitud_reserva_id, f.afiliado_usuario_id, f.solicitada_por_usuario_id, f.estado_destino,
            f.politica_id, f.politica_version, f.politica_snapshot_json, f.decision, f.vence_en,
            f.avisos_enviados, f.ultimo_aviso_en,
            (f.vence_en <= NOW()) AS vencida,
            (f.ultimo_aviso_en > NOW() - INTERVAL ${MINUTOS_ENTRE_AVISOS} MINUTE) AS aviso_reciente
       FROM reserva r
       LEFT JOIN reserva_firma_afiliado f ON f.reserva_id = r.id
      WHERE r.id = ?
      FOR UPDATE`,
    [reservaId]
  );
  return rows[0] || null;
}

function politicaDeSolicitud(fila) {
  const snapshot = parsearJson(fila.politica_snapshot_json) || {};
  return {
    ...snapshot,
    id: Number(snapshot.id) || Number(fila.politica_id),
    version: Number(snapshot.version) || Number(fila.politica_version),
  };
}

function validarAceptacionCondiciones(body, mensaje) {
  if (body?.acepta !== true) throw errorFirma(mensaje, 400, "POLITICA_NO_ACEPTADA");
}

function validarVersionMostrada(body, fila) {
  const version = body?.politica_version;
  if (version === undefined || version === null || version === "") return;
  if (Number(version) !== Number(fila.politica_version)) {
    throw errorFirma(
      "Las condiciones que tenés en pantalla no son las que se enviaron con esta reserva. Volvé a abrirla.",
      409, "POLITICA_VERSION_DISTINTA"
    );
  }
}

async function firmarSolicitud(connection, { fila, persona, actor, accion, body, contexto, subirFirma }) {
  const enPantalla = accion === "FIRMAR_EN_PANTALLA";
  let canal = "ENVIO";
  let firmaPor = "AFILIADO";
  if (enPantalla) {
    canal = texto(body?.canal).toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(CANALES_FIRMA_EN_PANTALLA, canal)) {
      throw errorFirma("Elegí quién firma: la persona afiliada en la oficina o vos por teléfono.", 400, "CANAL_POLITICA_REQUERIDO");
    }
    firmaPor = CANALES_FIRMA_EN_PANTALLA[canal];
    if (texto(body?.firma_por).toUpperCase() !== firmaPor) {
      throw errorFirma(
        canal === "PRESENCIAL"
          ? "Si la persona afiliada está en la oficina, firma ella."
          : "En una reserva por teléfono firma el administrativo.",
        400, "FIRMA_POR_INVALIDA"
      );
    }
    validarAceptacionCondiciones(body, canal === "PRESENCIAL"
      ? "Marcá la casilla: la persona afiliada leyó las condiciones y está de acuerdo."
      : "Marcá la casilla: le leíste las condiciones por teléfono y está de acuerdo.");
  } else {
    validarAceptacionCondiciones(body, "Para firmar, marcá que leíste y aceptás las condiciones de cancelación.");
  }
  const firmaPng = decodificarFirmaPng(body?.firma);
  validarVersionMostrada(body, fila);

  await controlarPersonaParaFirmar(connection, persona);
  if (normalizarFechaCivil(fila.fecha_inicio) < obtenerFechaCivilArgentina()) {
    throw errorFirma("La fecha de ingreso ya pasó: la reserva no se puede firmar.", 409, "RESERVA_FECHA_VENCIDA");
  }
  const destino = fila.estado_destino;
  if (!DESTINOS_FIRMA.has(destino)) throw errorFirma("La reserva no tiene un estado de destino válido.", 409, "FIRMA_DESTINO_INVALIDO");
  const destinoId = await exigirEstadoReserva(connection, destino);
  if (destino === ESTADO_INICIADA) {
    const { asegurarSinReservaIniciadaAfiliado } = require("./reservas-turismo");
    const otra = await asegurarSinReservaIniciadaAfiliado(connection, fila.usuario_id);
    if (otra) {
      throw errorFirma(
        enPantalla
          ? `${nombrePersona(persona)} ya tiene otra reserva «Iniciada» (T-${otra.id}). Para firmar esta, primero hay que resolver aquella.`
          : `Ya tenés otra reserva «Iniciada» (T-${otra.id}). Para firmar esta, primero cancelá aquella o pedile ayuda a tu departamental.`,
        409, "RESERVA_INICIADA_EXISTENTE", { reserva: otra }
      );
    }
  }

  // Todo validado: recién ahora se sube la firma (si algo falla después, la ruta la borra).
  const clave = await subirFirma(firmaPng);
  const pendienteId = Number(fila.estado_reserva_id);
  const [cambio] = await connection.query(
    `UPDATE reserva SET estado_reserva_id = ?, firma_archivo = ?, fecha_modificacion = NOW()
      WHERE id = ? AND estado_reserva_id = ?`,
    [destinoId, clave, fila.id, pendienteId]
  );
  if (Number(cambio?.affectedRows) !== 1) {
    throw errorFirma("La reserva cambió mientras se firmaba. Volvé a abrirla.", 409, "RESERVA_MODIFICADA");
  }
  const politica = politicaDeSolicitud(fila);
  await guardarAceptacionPolitica(connection, {
    reservaId: fila.id,
    usuarioId: actor.id,
    politica,
    modo: enPantalla ? "CARGA_ADMINISTRATIVA" : "AFILIADO",
    canal,
    firmaPor,
    firmaArchivo: clave,
  });
  const [respuesta] = await connection.query(
    `UPDATE reserva_firma_afiliado
        SET decision = 'FIRMADA', fecha_respuesta = NOW(), respondida_por_usuario_id = ?,
            firma_ip = ?, firma_user_agent = ?
      WHERE reserva_id = ? AND decision = 'PENDIENTE'`,
    [actor.id, texto(contexto.ip).slice(0, 45) || null, texto(contexto.userAgent).slice(0, 255) || null, fila.id]
  );
  if (Number(respuesta?.affectedRows) !== 1) {
    throw errorFirma("La reserva cambió mientras se firmaba. Volvé a abrirla.", 409, "RESERVA_MODIFICADA");
  }

  let observaciones;
  if (!enPantalla) observaciones = "La persona afiliada leyó y aceptó las condiciones de cancelación y firmó desde Mi AJB.";
  else if (canal === "PRESENCIAL") observaciones = "La persona afiliada vino a la oficina, leyó las condiciones de cancelación y firmó en la pantalla.";
  else observaciones = "Reserva telefónica: se le leyeron las condiciones de cancelación a la persona afiliada y firmó el administrativo.";
  observaciones += destino === ESTADO_VERIFICADA
    ? " Queda «Verificada» (carga de la departamental) y pasa a administración."
    : " Queda «Iniciada»: la departamental tiene 72 horas para verificarla.";
  await insertarHistorial(connection, {
    reservaId: fila.id,
    usuarioId: actor.id,
    contexto,
    campos: [
      { campo: "estado_reserva_id", valorAnterior: pendienteId, valorNuevo: destinoId },
      { campo: "reserva_firma_afiliado.decision", valorAnterior: "PENDIENTE", valorNuevo: "FIRMADA" },
      { campo: "firma_archivo", valorAnterior: fila.firma_archivo, valorNuevo: clave },
    ],
    observaciones,
  });
  await marcarAvisoFirmaLeido(connection, { usuarioId: fila.usuario_id, reservaId: fila.id });

  const datos = await datosAvisoReserva(connection, fila.id);
  const nombreAfiliado = nombrePersona(datos);
  const comoFirmo = enPantalla
    ? (canal === "PRESENCIAL" ? "firmó en la oficina" : "aceptó por teléfono (firmó el administrativo)")
    : "firmó desde Mi AJB";
  await avisarStaffTurismo(connection, {
    departamentalId: datos?.usuario_departamental_id,
    solicitanteId: fila.solicitada_por_usuario_id,
    excluirId: actor.id,
    sinAdmins: destino === ESTADO_VERIFICADA,
    tipo: TIPO_FIRMA_RECIBIDA,
    titulo: `Reserva T-${fila.id} firmada`,
    mensaje: `${nombreAfiliado} ${comoFirmo} la reserva que se le envió (${descripcionReserva(datos)}). `
      + (destino === ESTADO_VERIFICADA
        ? "Quedó «Verificada» y pasó a administración para aprobarla."
        : "Quedó «Iniciada»: la departamental tiene 72 horas para verificarla."),
    payload: { reserva_id: fila.id, estado: destino },
  });
  if (destino === ESTADO_VERIFICADA) {
    // Quien aprueba tiene que saber si firmó la persona o el administrativo por teléfono.
    await avisarAdministradoresParaAprobar(connection, {
      reservaId: fila.id,
      excluirId: actor.id,
      mensaje: `La departamental cargó la reserva y ${nombrePersona(datos, "la persona afiliada")} ${comoFirmo}. `
        + "Ya está disponible para aprobación administrativa.",
    });
  }
  if (enPantalla) {
    // La persona recibe las condiciones que aceptó, como en una carga con la firma tomada.
    await crearNotificacion(connection, {
      usuarioId: fila.usuario_id,
      tipo: TIPO_FIRMA_REGISTRADA,
      titulo: `Reserva T-${fila.id} confirmada`,
      mensaje: textoAvisoFirmaRegistrada({ reservaId: fila.id, rolActor: actor.rol, canal, estado: destino, datos, politica }),
      payload: { reserva_id: fila.id, estado: destino },
      categoria: "estados",
      obligatoria: true,
    });
  }
  return {
    accion,
    estado: destino,
    reserva: { id: Number(fila.id), estado: destino },
    message: enPantalla
      ? `Firma registrada: la reserva quedó «${destino}».`
      : destino === ESTADO_VERIFICADA
        ? "¡Listo! Firmaste tu reserva: ya pasó a administración para aprobarla."
        : "¡Listo! Firmaste tu reserva: ahora tu departamental la verifica.",
  };
}

async function rechazarSolicitud(connection, { fila, actor, body, contexto }) {
  const motivo = texto(body?.motivo);
  if ([...motivo].length > MAX_MOTIVO_FIRMA) {
    throw errorFirma(`El motivo puede tener hasta ${MAX_MOTIVO_FIRMA} caracteres.`, 400, "MOTIVO_DEMASIADO_LARGO");
  }
  const canceladaId = await exigirEstadoReserva(connection, ESTADO_CANCELADA);
  const pendienteId = Number(fila.estado_reserva_id);
  // Sin penalidad (regla SIN_FIRMA): el mismo registro que la baja a pedido de una reserva
  // que espera la firma, con la política que se le envió.
  const reserva = { ...fila, estado_nombre: ESTADO_PENDIENTE_FIRMA };
  const cotizacion = await cotizarCancelacion(connection, { reserva });
  await confirmarCancelacionPolitica(connection, {
    reserva, usuarioId: actor.id, confirmada: true, cotizacion: cotizacion.cotizacion,
    origen: "AFILIADO", canal: "APP", rol: "afiliado", motivo: motivo || null,
  });
  const [cambio] = await connection.query(
    "UPDATE reserva SET estado_reserva_id = ?, fecha_modificacion = NOW() WHERE id = ? AND estado_reserva_id = ?",
    [canceladaId, fila.id, pendienteId]
  );
  if (Number(cambio?.affectedRows) !== 1) {
    throw errorFirma("La reserva cambió mientras se respondía. Volvé a abrirla.", 409, "RESERVA_MODIFICADA");
  }
  const [respuesta] = await connection.query(
    `UPDATE reserva_firma_afiliado
        SET decision = 'RECHAZADA', fecha_respuesta = NOW(), respondida_por_usuario_id = ?, motivo = ?,
            firma_ip = ?, firma_user_agent = ?
      WHERE reserva_id = ? AND decision = 'PENDIENTE'`,
    [actor.id, motivo || null, texto(contexto.ip).slice(0, 45) || null, texto(contexto.userAgent).slice(0, 255) || null, fila.id]
  );
  if (Number(respuesta?.affectedRows) !== 1) {
    throw errorFirma("La reserva cambió mientras se respondía. Volvé a abrirla.", 409, "RESERVA_MODIFICADA");
  }
  const { liberarRecursoBloque } = require("./reservas-turismo");
  await liberarRecursoBloque(connection, fila.id);
  await insertarHistorial(connection, {
    reservaId: fila.id,
    usuarioId: actor.id,
    contexto,
    campos: [
      { campo: "estado_reserva_id", valorAnterior: pendienteId, valorNuevo: canceladaId },
      { campo: "reserva_firma_afiliado.decision", valorAnterior: "PENDIENTE", valorNuevo: "RECHAZADA" },
    ],
    observaciones: "La persona afiliada no aceptó la reserva («No la quiero»): se dio de baja sin cargo y se liberó el lugar."
      + (motivo ? ` Motivo: ${motivo}` : ""),
  });
  await marcarAvisoFirmaLeido(connection, { usuarioId: fila.usuario_id, reservaId: fila.id });
  const datos = await datosAvisoReserva(connection, fila.id);
  await avisarStaffTurismo(connection, {
    departamentalId: datos?.usuario_departamental_id,
    solicitanteId: fila.solicitada_por_usuario_id,
    excluirId: actor.id,
    tipo: TIPO_FIRMA_RECHAZADA,
    titulo: `Reserva T-${fila.id}: no la aceptó`,
    mensaje: `${nombrePersona(datos)} no aceptó la reserva que se le envió (${descripcionReserva(datos)}). `
      + "Se dio de baja sin cargo y se liberó el lugar." + (motivo ? ` Motivo: ${motivo}` : ""),
    payload: { reserva_id: fila.id, estado: ESTADO_CANCELADA, decision: "RECHAZADA" },
  });
  return {
    accion: "RECHAZAR",
    estado: ESTADO_CANCELADA,
    reserva: { id: Number(fila.id), estado: ESTADO_CANCELADA },
    invalidacion: eventoDisponibilidad(datos),
    message: "Listo: la reserva se dio de baja sin cargo y se liberó el lugar.",
  };
}

async function reenviarAviso(connection, { fila, actor, contexto }) {
  const enviados = Number(fila.avisos_enviados) || 0;
  if (enviados >= MAX_AVISOS_FIRMA) {
    throw errorFirma(
      `Ya se le avisó ${MAX_AVISOS_FIRMA} veces. Si no responde, llamala o pedile que venga a firmar a la oficina.`,
      409, "AVISOS_AGOTADOS"
    );
  }
  if (Number(fila.aviso_reciente) === 1) {
    throw errorFirma("Ya se le avisó hace menos de una hora. Probá de nuevo más tarde.", 409, "AVISO_RECIENTE");
  }
  const [cambio] = await connection.query(
    `UPDATE reserva_firma_afiliado SET avisos_enviados = avisos_enviados + 1, ultimo_aviso_en = NOW()
      WHERE reserva_id = ? AND decision = 'PENDIENTE' AND avisos_enviados = ?`,
    [fila.id, enviados]
  );
  if (Number(cambio?.affectedRows) !== 1) {
    throw errorFirma("La reserva cambió mientras se avisaba. Volvé a abrirla.", 409, "RESERVA_MODIFICADA");
  }
  // El recordatorio reemplaza al aviso anterior en la campana.
  await marcarAvisoFirmaLeido(connection, { usuarioId: fila.usuario_id, reservaId: fila.id });
  const [solicitantes] = await connection.query(
    "SELECT r.nombre AS rol FROM usuario u INNER JOIN rol r ON r.id = u.rol_id WHERE u.id = ? LIMIT 1",
    [fila.solicitada_por_usuario_id]
  );
  const datos = await datosAvisoReserva(connection, fila.id);
  await crearNotificacion(connection, {
    usuarioId: fila.usuario_id,
    tipo: TIPO_FIRMA_PENDIENTE,
    titulo: `Recordatorio: firmá tu reserva T-${fila.id}`,
    mensaje: textoAvisoFirmaPendiente({
      reservaId: fila.id, rolSolicitante: solicitantes[0]?.rol, datos, politica: politicaDeSolicitud(fila),
      venceEn: fila.vence_en, recordatorio: true,
    }),
    payload: {
      reserva_id: Number(fila.id),
      estado: ESTADO_PENDIENTE_FIRMA,
      vence_en: instante(fila.vence_en)?.toISOString() || null,
      url: `/turismo/reserva/detalle/${fila.id}`,
    },
    categoria: "gestiones",
    obligatoria: true,
  });
  await insertarHistorial(connection, {
    reservaId: fila.id,
    usuarioId: actor.id,
    contexto,
    campos: [{ campo: "reserva_firma_afiliado.avisos_enviados", valorAnterior: enviados, valorNuevo: enviados + 1 }],
    observaciones: `Se le volvió a avisar a la persona afiliada que tiene la reserva para firmar (aviso ${enviados + 1} de ${MAX_AVISOS_FIRMA}).`,
  });
  return {
    accion: "REENVIAR",
    estado: ESTADO_PENDIENTE_FIRMA,
    reserva: { id: Number(fila.id), estado: ESTADO_PENDIENTE_FIRMA },
    avisos_enviados: enviados + 1,
    avisos_maximos: MAX_AVISOS_FIRMA,
    vence_en: fila.vence_en,
    message: `Le volvimos a avisar a la persona afiliada (aviso ${enviados + 1} de ${MAX_AVISOS_FIRMA}).`,
  };
}

/**
 * PUT /reserva/:id/firma-afiliado, dentro de una transacción abierta por la ruta.
 *   afiliado dueño: FIRMAR { firma, acepta: true, politica_version? } · RECHAZAR { motivo? }
 *   staff de la jurisdicción: FIRMAR_EN_PANTALLA { canal, firma_por, firma, acepta: true } · REENVIAR
 * Si la firma ya venció, la da de baja (el commit lo hace la ruta) y devuelve { vencida: true }.
 * `subirFirma(buffer)` sube el PNG y devuelve la clave.
 */
async function responderFirma(connection, { reservaId, actor, accion, body = {}, contexto = {}, subirFirma }) {
  const accionPedida = texto(accion).toUpperCase();
  const esAccionAfiliado = ACCIONES_AFILIADO.has(accionPedida);
  if (!esAccionAfiliado && !ACCIONES_STAFF.has(accionPedida)) {
    throw errorFirma("Acción inválida. Usá FIRMAR, RECHAZAR, FIRMAR_EN_PANTALLA o REENVIAR.", 400, "ACCION_INVALIDA");
  }
  if (esAccionAfiliado ? actor?.rol !== "afiliado" : !ROLES_CARGA.has(actor?.rol)) {
    throw errorFirma(
      esAccionAfiliado
        ? "Sólo la persona afiliada puede firmar o rechazar la reserva desde su cuenta."
        : "Sólo administración o la departamental de la persona pueden gestionar esta firma.",
      403, "FIRMA_NO_AUTORIZADA"
    );
  }

  // 1) Lectura sin bloqueo para autorizar antes de revelar el estado y saber a quién bloquear.
  const [previas] = await connection.query(
    `SELECT r.id, r.usuario_id, u.departamental_id AS usuario_departamental_id, f.afiliado_usuario_id
       FROM reserva r
       INNER JOIN usuario u ON u.id = r.usuario_id
       LEFT JOIN reserva_firma_afiliado f ON f.reserva_id = r.id
      WHERE r.id = ?
      LIMIT 1`,
    [reservaId]
  );
  const previa = previas[0];
  if (!previa) throw errorFirma("No encontramos la reserva.", 404, "RESERVA_NO_ENCONTRADA");
  await autorizarActor(connection, { actor, previa, esAccionAfiliado });
  if (previa.afiliado_usuario_id == null) {
    throw errorFirma("Esta reserva no se envió a firmar.", 404, "FIRMA_NO_SOLICITADA");
  }

  // 2) Bloqueos en el orden del alta: persona, reserva y solicitud.
  const persona = await bloquearPersona(connection, previa.usuario_id);
  const fila = await cargarSolicitudBloqueada(connection, reservaId);
  if (!fila || Number(fila.usuario_id) !== Number(previa.usuario_id) || fila.solicitud_reserva_id == null) {
    throw errorFirma("La reserva cambió. Volvé a abrirla.", 409, "RESERVA_MODIFICADA");
  }
  const pendienteId = await exigirEstadoReserva(connection, ESTADO_PENDIENTE_FIRMA);
  if (fila.decision !== "PENDIENTE" || Number(fila.estado_reserva_id) !== pendienteId) {
    throw errorFirma(
      "Esta reserva ya no espera la firma: ya se firmó, se dio de baja o venció. Volvé a abrirla para ver su estado.",
      409, "FIRMA_RESUELTA"
    );
  }
  if (Number(fila.vencida) === 1) {
    const vencida = await expirarFirmaEnTransaccion(connection, { reserva_id: fila.id });
    return {
      vencida: true,
      estado: ESTADO_RECHAZADA,
      reserva: { id: Number(fila.id), estado: ESTADO_RECHAZADA },
      invalidacion: vencida ? vencida.evento : null,
    };
  }

  if (accionPedida === "FIRMAR" || accionPedida === "FIRMAR_EN_PANTALLA") {
    if (typeof subirFirma !== "function") throw new Error("Falta subirFirma");
    return firmarSolicitud(connection, { fila, persona, actor, accion: accionPedida, body, contexto, subirFirma });
  }
  if (accionPedida === "RECHAZAR") return rechazarSolicitud(connection, { fila, actor, body, contexto });
  return reenviarAviso(connection, { fila, actor, contexto });
}

/**
 * ¿La persona entró alguna vez a Mi AJB? Si nunca entró, no va a ver el aviso de «Firmá tu
 * reserva»: el staff lo ve antes de elegir «Se la envío…». null = no se sabe (sin el dato).
 */
async function consultarIngresoMiAjb(connection, usuarioId) {
  try {
    const [filas] = await connection.query(
      "SELECT (primer_ingreso IS NOT NULL OR ultimo_ingreso IS NOT NULL) AS ingreso FROM usuario WHERE id = ? LIMIT 1",
      [usuarioId]);
    return filas.length ? Number(filas[0].ingreso) === 1 : null;
  } catch (error) {
    if (error?.code === "ER_BAD_FIELD_ERROR") return null;
    throw error;
  }
}

module.exports = {
  CANALES_CARGA_STAFF,
  ESTADO_PENDIENTE_FIRMA,
  ESTADO_PENDIENTE_FIRMA_ID,
  LOCK_VENCIMIENTO_FIRMAS,
  MAX_AVISOS_FIRMA,
  MINIMO_FIRMA_HORAS,
  MINUTOS_ENTRE_AVISOS,
  PLAZO_FIRMA_HORAS,
  TIPO_FIRMA_PENDIENTE,
  TIPO_FIRMA_RECHAZADA,
  TIPO_FIRMA_RECIBIDA,
  TIPO_FIRMA_REGISTRADA,
  TIPO_FIRMA_VENCIDA,
  asegurarSinFirmaPendiente,
  avisarAfiliadoCargaStaff,
  buscarFirmaPendienteIniciada,
  calcularVencimientoFirma,
  consultarIngresoMiAjb,
  datosAvisoReserva,
  decodificarFirmaPng,
  errorFirma,
  expirarFirmaEnTransaccion,
  expirarFirmasVencidas,
  fechaHoraTexto,
  listarFirmasPendientes,
  marcarAvisoFirmaLeido,
  registrarSolicitudFirma,
  resolverFirmaCarga,
  responderFirma,
  sqlInicioPlazoVerificacion,
  textoAvisoCargaStaff,
  textoAvisoFirmaPendiente,
  textoAvisoFirmaRegistrada,
};
