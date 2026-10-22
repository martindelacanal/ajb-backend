"use strict";

const crypto = require("crypto");
const {
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
  diferenciaDiasCivil,
  sumarDiasFechaCivil,
  decimalACentavos,
  centavosANumero,
} = require("./valores-dominio");
const { normalizarIdPositivo } = require("./turismo-catalogo");

// Cancelación a pedido y «Pendiente de firma». Los mismos valores que reservas-turismo.js: se repiten
// para no crear un ciclo de require (reservas-turismo no depende de este archivo).
const ESTADO_PENDIENTE_FIRMA = "Pendiente de firma";
const ORIGEN_CANCELACION_AFILIADO = "AFILIADO";
const ORIGEN_CANCELACION_STAFF_A_PEDIDO = "STAFF_A_PEDIDO";
const REGLA_CANCELACION_POLITICA = "POLITICA";
const REGLA_CANCELACION_SIN_FIRMA = "SIN_FIRMA";
const CANALES_PEDIDO_CANCELACION = Object.freeze(["PRESENCIAL", "TELEFONO", "ESCRITO"]);
const TEXTO_CANAL_PEDIDO = Object.freeze({ PRESENCIAL: "en persona", TELEFONO: "por teléfono", ESCRITO: "por escrito" });
const MAX_MOTIVO_CANCELACION = 1000;
const ESTADOS_RESERVA_CERRADOS = new Set(["Cancelada", "Rechazada", "Utilizada", "No adjudicada", "Convenio rechazado"]);
const ROLES_STAFF_CONDICIONES = new Set(["admin", "admin-central", "departamental"]);
const ROLES_CARGA_ADMINISTRATIVA = new Set(["admin", "departamental"]);
const MAX_ARCHIVOS_CONSTANCIA = 5;

const ZONA_HORARIA = "America/Argentina/Buenos_Aires";
const REGLAS_INICIALES = Object.freeze([
  Object.freeze({ dias_desde: 0, dias_hasta: 6, porcentaje_reintegro: 0 }),
  Object.freeze({ dias_desde: 7, dias_hasta: 14, porcentaje_reintegro: 50 }),
  Object.freeze({ dias_desde: 15, dias_hasta: null, porcentaje_reintegro: 100 }),
]);

function errorPolitica(message, statusCode = 400, codigo = "POLITICA_INVALIDA") {
  return Object.assign(new Error(message), { statusCode, codigo });
}

function entero(valor) {
  if (typeof valor !== "number" && !(typeof valor === "string" && /^\d+$/.test(valor))) return null;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero >= 0 ? numero : null;
}

function validarReglas(reglas) {
  if (!Array.isArray(reglas) || !reglas.length || reglas.length > 30) {
    throw errorPolitica("La política debe contener entre 1 y 30 rangos");
  }
  const normalizadas = reglas.map((regla) => {
    const desde = entero(regla?.dias_desde);
    const hasta = regla?.dias_hasta === null ? null : entero(regla?.dias_hasta);
    const reintegro = regla?.porcentaje_reintegro;
    const porcentaje = typeof reintegro === "number" || (typeof reintegro === "string" && /^\d+(\.\d{1,2})?$/.test(reintegro))
      ? Number(reintegro) : NaN;
    if (desde === null || desde > 36500 || (regla?.dias_hasta !== null && hasta === null)
      || (hasta !== null && (hasta < desde || hasta > 36500))
      || !Number.isFinite(porcentaje) || porcentaje < 0 || porcentaje > 100
      || Math.abs(porcentaje * 100 - Math.round(porcentaje * 100)) > 0.000001) {
      throw errorPolitica("Los rangos deben usar días enteros y porcentajes entre 0 y 100 (hasta dos decimales)");
    }
    return { dias_desde: desde, dias_hasta: hasta, porcentaje_reintegro: porcentaje };
  }).sort((a, b) => a.dias_desde - b.dias_desde);
  let siguiente = 0;
  for (const [indice, regla] of normalizadas.entries()) {
    if (regla.dias_desde !== siguiente || (regla.dias_hasta === null && indice !== normalizadas.length - 1)) {
      throw errorPolitica("Los rangos deben cubrir todos los días desde 0, sin huecos ni superposiciones");
    }
    siguiente = regla.dias_hasta === null ? null : regla.dias_hasta + 1;
  }
  if (siguiente !== null) throw errorPolitica("El último rango debe quedar sin límite superior");
  return normalizadas;
}

function mapearPolitica(row) {
  if (!row) throw errorPolitica("No hay una política de cancelación vigente", 503, "POLITICA_NO_CONFIGURADA");
  const reglas = typeof row.reglas_json === "string" ? JSON.parse(row.reglas_json) : row.reglas_json;
  return {
    id: Number(row.id),
    version: Number(row.version),
    titulo: row.titulo,
    reglas: validarReglas(reglas),
    motivo: row.motivo || null,
    creada_en: row.creada_en || null,
    creada_por: row.creada_por === null ? null : Number(row.creada_por),
    autor_nombre: row.autor_nombre || null,
  };
}

// El servicio ya fue resuelto/autorizado desde el recurso, bloque o convenio.
// La lectura con lock usa el valor actual aun bajo REPEATABLE READ.
async function obtenerPoliticaVigente(connection, { servicioId, bloquear = false } = {}) {
  const id = normalizarIdPositivo(servicioId);
  if (!id) throw errorPolitica("Indicá el servicio para consultar su política", 400, "SERVICIO_REQUERIDO");
  const [rows] = await connection.query(
    `SELECT p.* FROM politica_cancelacion p
      INNER JOIN politica_cancelacion_servicio_vigente v ON v.politica_id = p.id
      WHERE v.servicio_id = ?${bloquear ? " LOCK IN SHARE MODE" : ""}`, [id]
  );
  if (!rows.length) throw errorPolitica("El servicio no tiene una política de cancelación configurada", 503, "POLITICA_NO_CONFIGURADA");
  return { ...mapearPolitica(rows[0]), servicio_id: id };
}

async function listarPoliticas(connection) {
  const [rows] = await connection.query(
    `SELECT p.*, CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, '')) AS autor_nombre
       FROM politica_cancelacion p LEFT JOIN usuario u ON u.id = p.creada_por
       ORDER BY p.version DESC, p.id DESC`
  );
  const [servicios] = await connection.query(
    `SELECT s.id, s.nombre, s.activo, v.politica_id, p.version AS politica_version
       FROM servicio s LEFT JOIN politica_cancelacion_servicio_vigente v ON v.servicio_id = s.id
       LEFT JOIN politica_cancelacion p ON p.id = v.politica_id ORDER BY s.nombre, s.id`
  );
  const [asignaciones] = await connection.query(
    `SELECT ps.politica_id, ps.servicio_id, s.nombre FROM politica_cancelacion_servicio ps
       INNER JOIN servicio s ON s.id = ps.servicio_id ORDER BY s.nombre, s.id`
  );
  const [correcciones] = await connection.query(
    "SELECT politica_id, accion, usuario_anterior_id, usuario_nuevo_id, detalle, creada_en FROM politica_cancelacion_autoria_auditoria ORDER BY id"
  );
  const historial = rows.map((row) => {
    const id = Number(row.id);
    const aplicados = asignaciones.filter(a => Number(a.politica_id) === id)
      .map(a => ({ id: Number(a.servicio_id), nombre: a.nombre }));
    const vigentes = servicios.filter(s => Number(s.politica_id) === id).map(s => Number(s.id));
    return { ...mapearPolitica(row), servicios: aplicados, servicios_ids: aplicados.map(s => s.id),
      servicios_vigentes_ids: vigentes, vigente: vigentes.length > 0,
      correcciones_autoria: correcciones.filter(c => Number(c.politica_id) === id) };
  });
  return {
    vigente: historial[0] || null,
    servicios: servicios.map(s => ({ id: Number(s.id), nombre: s.nombre, activo: Number(s.activo) === 1,
      politica_id: s.politica_id == null ? null : Number(s.politica_id),
      politica_version: s.politica_version == null ? null : Number(s.politica_version) })),
    vigentes: servicios.filter(s => s.politica_id != null).map(s => ({ servicio_id: Number(s.id),
      politica: historial.find(p => p.id === Number(s.politica_id)) })),
    historial,
  };
}

function validarSeleccionServicios(serviciosIds, versionesActuales) {
  if (!Array.isArray(serviciosIds) || !serviciosIds.length || serviciosIds.length > 10000
    || serviciosIds.some(id => !normalizarIdPositivo(id))) {
    throw errorPolitica("Seleccioná al menos un servicio válido", 400, "SERVICIOS_INVALIDOS");
  }
  const ids = serviciosIds.map(normalizarIdPositivo).sort((a, b) => a - b);
  if (new Set(ids).size !== ids.length || !Array.isArray(versionesActuales) || versionesActuales.length !== ids.length) {
    throw errorPolitica("Enviá una sola versión vigente por cada servicio seleccionado", 400, "VERSIONES_SERVICIOS_INVALIDAS");
  }
  const versiones = new Map();
  for (const item of versionesActuales) {
    const id = normalizarIdPositivo(item?.servicio_id);
    const version = item?.version === null ? null : normalizarIdPositivo(item?.version);
    if (!ids.includes(id) || versiones.has(id) || (item?.version !== null && !version)) {
      throw errorPolitica("Las versiones de servicios no son válidas", 400, "VERSIONES_SERVICIOS_INVALIDAS");
    }
    versiones.set(id, version);
  }
  return { ids, versiones };
}

async function crearVersionPolitica(connection, { serviciosIds, versionesActuales, titulo, motivo, reglas, usuarioId }) {
  const { ids, versiones } = validarSeleccionServicios(serviciosIds, versionesActuales);
  const normalizadas = validarReglas(reglas);
  const textoTitulo = typeof titulo === "string" ? titulo.trim() : "";
  const textoMotivo = typeof motivo === "string" ? motivo.trim() : "";
  if (!textoTitulo || textoTitulo.length > 160 || !textoMotivo || textoMotivo.length > 2000) {
    throw errorPolitica("Ingresá un título (hasta 160 caracteres) y un motivo del cambio (hasta 2000 caracteres)");
  }
  const autor = normalizarIdPositivo(usuarioId);
  if (!autor) throw errorPolitica("Usuario no autorizado", 403, "POLITICA_NO_AUTORIZADA");
  // Serializa la numeración global de publicaciones. Las reservas sólo toman
  // locks compartidos sobre la asignación de su propio servicio.
  const [puntero] = await connection.query("SELECT politica_id FROM politica_cancelacion_vigente WHERE id = 1 FOR UPDATE");
  if (!puntero.length) throw errorPolitica("Falta la configuración inicial", 503, "POLITICA_NO_CONFIGURADA");
  const [actuales] = await connection.query(
    `SELECT s.id AS servicio_id, p.version FROM servicio s
       LEFT JOIN politica_cancelacion_servicio_vigente v ON v.servicio_id = s.id
       LEFT JOIN politica_cancelacion p ON p.id = v.politica_id WHERE s.id IN (?) ORDER BY s.id FOR UPDATE`, [ids]
  );
  if (actuales.length !== ids.length) throw errorPolitica("Uno de los servicios seleccionados no existe", 400, "SERVICIOS_INVALIDOS");
  for (const actual of actuales) {
    if (versiones.get(Number(actual.servicio_id)) !== (actual.version == null ? null : Number(actual.version))) {
      throw errorPolitica("Cambió la política de un servicio seleccionado. Volvé a cargarla antes de publicar", 409, "POLITICA_ACTUALIZADA");
    }
  }
  const [ultima] = await connection.query("SELECT version FROM politica_cancelacion ORDER BY version DESC, id DESC LIMIT 1 LOCK IN SHARE MODE");
  const [insert] = await connection.query(
    `INSERT INTO politica_cancelacion (version, titulo, reglas_json, motivo, creada_por)
     VALUES (?, ?, ?, ?, ?)`,
    [Number(ultima[0].version) + 1, textoTitulo, JSON.stringify(normalizadas), textoMotivo, autor]
  );
  for (const servicioId of ids) {
    await connection.query("INSERT INTO politica_cancelacion_servicio (politica_id, servicio_id) VALUES (?, ?)", [insert.insertId, servicioId]);
    await connection.query(
      `INSERT INTO politica_cancelacion_servicio_vigente (servicio_id, politica_id) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE politica_id = VALUES(politica_id)`, [servicioId, insert.insertId]
    );
  }
  await connection.query("UPDATE politica_cancelacion_vigente SET politica_id = ? WHERE id = 1", [insert.insertId]);
  const [rows] = await connection.query("SELECT * FROM politica_cancelacion WHERE id = ?", [insert.insertId]);
  return { ...mapearPolitica(rows[0]), servicios_ids: ids, servicios_vigentes_ids: ids };
}

// `exigirAceptacion: false` es para la carga del staff que se envía a firmar: el
// staff no acepta nada, sólo fija la versión vigente que se le presenta a la
// persona afiliada (la acepta ella al firmar).
async function validarAceptacionPolitica(connection, { aceptada, politicaId, version, servicioId, exigirAceptacion = true }) {
  if (exigirAceptacion && aceptada !== true) {
    throw errorPolitica("Debés leer y aceptar la política de cancelación para enviar la reserva", 400, "POLITICA_NO_ACEPTADA");
  }
  const politica = await obtenerPoliticaVigente(connection, { servicioId, bloquear: true });
  if (normalizarIdPositivo(politicaId) !== politica.id || normalizarIdPositivo(version) !== politica.version) {
    throw errorPolitica("La política de cancelación cambió. Revisala y aceptala nuevamente", 409, "POLITICA_ACTUALIZADA");
  }
  return politica;
}

const MODOS_ACEPTACION = new Set(["AFILIADO", "CARGA_ADMINISTRATIVA"]);
const CANALES_ACEPTACION = new Set(["APP", "PRESENCIAL", "TELEFONO", "ENVIO"]);
const FIRMANTES_ACEPTACION = new Set(["AFILIADO", "ADMINISTRATIVO"]);

/**
 * Cómo se aceptaron las condiciones (todo opcional: sin estos datos queda NULL, «sin dato»):
 *   modo          AFILIADO (la persona afiliada, en la app o al firmar lo que le enviaron)
 *                 | CARGA_ADMINISTRATIVA (el staff, con la persona en la oficina o por teléfono)
 *   canal         APP | PRESENCIAL | TELEFONO | ENVIO
 *   firmaPor      AFILIADO | ADMINISTRATIVO (sólo si hay firma)
 *   firmaArchivo  clave S3 de la firma tomada con la aceptación: copia inmutable que una
 *                 edición posterior de la reserva no pisa. firmada_en = ahora.
 * Las columnas nuevas van al final: las posiciones anteriores no cambian.
 */
async function guardarAceptacionPolitica(connection, {
  reservaId, usuarioId, politica, modo = null, canal = null, firmaPor = null, firmaArchivo = null,
}) {
  if (modo !== null && !MODOS_ACEPTACION.has(modo)) throw new Error(`Modo de aceptación inválido: ${modo}`);
  if (canal !== null && !CANALES_ACEPTACION.has(canal)) throw new Error(`Canal de aceptación inválido: ${canal}`);
  if (firmaPor !== null && !FIRMANTES_ACEPTACION.has(firmaPor)) throw new Error(`Firmante inválido: ${firmaPor}`);
  const firma = typeof firmaArchivo === "string" && firmaArchivo.trim() ? firmaArchivo.trim() : null;
  await connection.query(
    `INSERT INTO reserva_politica_cancelacion
       (reserva_id, politica_id, version, snapshot_json, aceptada_por, modo, canal, firma_por, firma_archivo, firmada_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${firma ? "NOW()" : "NULL"})`,
    [reservaId, politica.id, politica.version, JSON.stringify(politica), usuarioId,
      modo, canal, firma ? firmaPor : null, firma]
  );
}

const porcentajeTexto = (valor) => `${Number(valor).toLocaleString("es-AR", { maximumFractionDigits: 2 })}%`;
const diasTexto = (dias) => `${dias} ${dias === 1 ? "día" : "días"}`;

/**
 * Las condiciones en una oración, de más anticipación a menos: el guion para leerlas por
 * teléfono y el texto del aviso a la persona afiliada. Con la política inicial:
 * «Si cancelás con 15 días o más de anticipación, te devolvemos el 100%; de 7 a 14 días,
 * el 50%; con menos de 7 días, no hay devolución.»
 * Para usarla después de dos puntos, pasá la inicial a minúscula.
 */
function resumenPoliticaTexto(politica) {
  const reglas = validarReglas(politica?.reglas).slice().reverse();
  if (reglas.every((regla) => regla.porcentaje_reintegro === 0)) {
    return "Esta reserva no tiene devolución: si la cancelás, el reintegro es del 0%, sin importar la anticipación.";
  }
  if (reglas.length === 1) {
    return `Si cancelás, te devolvemos el ${porcentajeTexto(reglas[0].porcentaje_reintegro)}, sin importar la anticipación.`;
  }
  let yaDevuelve = false;
  const partes = reglas.map((regla) => {
    let plazo;
    if (regla.dias_hasta === null) plazo = `con ${diasTexto(regla.dias_desde)} o más de anticipación`;
    else if (regla.dias_desde === 0) plazo = regla.dias_hasta === 0 ? "el mismo día del ingreso" : `con menos de ${diasTexto(regla.dias_hasta + 1)}`;
    else if (regla.dias_desde === regla.dias_hasta) plazo = `con ${diasTexto(regla.dias_desde)}`;
    else plazo = `de ${regla.dias_desde} a ${diasTexto(regla.dias_hasta)}`;
    let resultado;
    if (regla.porcentaje_reintegro === 0) {
      resultado = "no hay devolución";
    } else if (!yaDevuelve) {
      resultado = `te devolvemos el ${porcentajeTexto(regla.porcentaje_reintegro)}`;
      yaDevuelve = true;
    } else {
      resultado = `el ${porcentajeTexto(regla.porcentaje_reintegro)}`;
    }
    return `${plazo}, ${resultado}`;
  });
  return `Si cancelás ${partes.join("; ")}.`;
}

function esPendienteFirma(estado) {
  return String(estado || "").trim().toLowerCase() === ESTADO_PENDIENTE_FIRMA.toLowerCase();
}

function parsearJson(valor) {
  if (valor === null || valor === undefined) return null;
  return typeof valor === "string" ? JSON.parse(valor) : valor;
}

function nombreCompleto(nombre, apellido) {
  const texto = [nombre, apellido].map((valor) => (valor == null ? "" : String(valor).trim())).filter(Boolean).join(" ");
  return texto || null;
}

// `regla` SIN_FIRMA: la reserva todavía espera la firma de la persona afiliada,
// nadie aceptó condiciones y la baja no tiene penalidad (reintegro del 100%).
function calcularCotizacion({ reserva, politica, origenPolitica = "ACEPTADA", ahora = new Date(), regla = REGLA_CANCELACION_POLITICA }) {
  const fechaActual = obtenerFechaCivilArgentina(ahora);
  const fechaCheckin = normalizarFechaCivil(reserva?.fecha_inicio);
  if (!fechaActual || !fechaCheckin) throw errorPolitica("No se pudo determinar la fecha de ingreso", 409, "FECHA_CHECKIN_INVALIDA");
  const diasPrevios = diferenciaDiasCivil(fechaActual, fechaCheckin);
  const dias = Math.max(0, diasPrevios);
  const reglas = validarReglas(politica.reglas);
  const tramo = reglas.find((r) => dias >= r.dias_desde && (r.dias_hasta === null || dias <= r.dias_hasta));
  const sinPenalidad = regla === REGLA_CANCELACION_SIN_FIRMA;
  const porcentaje = sinPenalidad ? 100 : tramo.porcentaje_reintegro;
  // precio_total ya incluye adicionales y descuentos. Es una estimación sobre
  // el total de la reserva, no acredita un pago ni ordena una transferencia.
  const baseCentavos = decimalACentavos(reserva.precio_total);
  if (baseCentavos === null) throw errorPolitica("No se pudo determinar el total de la reserva", 409, "TOTAL_RESERVA_INVALIDO");
  const puntosBase = Math.round(porcentaje * 100);
  // Redondear directamente el porcentaje al peso, sin redondeo intermedio a
  // centavos (por ejemplo, $5,499 debe quedar en $5 y $5,50 en $6).
  const reintegroCentavos = Number((BigInt(baseCentavos) * BigInt(puntosBase) + 500000n) / 1000000n) * 100;
  if (centavosANumero(reintegroCentavos) === null) throw errorPolitica("El reintegro redondeado excede el máximo permitido", 409, "TOTAL_RESERVA_INVALIDO");
  const resultado = {
    reserva_id: Number(reserva.id),
    fecha_actual: fechaActual,
    fecha_calculo: fechaActual,
    fecha_checkin: fechaCheckin,
    dias_previos: diasPrevios,
    porcentaje_reintegro: porcentaje,
    monto_base: centavosANumero(baseCentavos),
    monto_reintegro: centavosANumero(reintegroCentavos),
    tipo_base: "TOTAL_RESERVA",
    moneda: "ARS",
    es_estimado: true,
    politica,
    origen_politica: origenPolitica,
    regla: sinPenalidad ? REGLA_CANCELACION_SIN_FIRMA : REGLA_CANCELACION_POLITICA,
    zona_horaria: ZONA_HORARIA,
  };
  // Huella del contenido del diálogo, no una credencial. Los permisos se
  // verifican por separado y nunca se confía en porcentajes del navegador.
  resultado.cotizacion = crypto.createHash("sha256").update(JSON.stringify({
    reserva_id: resultado.reserva_id,
    estado: reserva.estado_nombre,
    fecha_actual: fechaActual,
    fecha_checkin: fechaCheckin,
    politica_id: politica.id,
    version: politica.version,
    reglas,
    monto_base_centavos: baseCentavos,
    monto_reintegro_centavos: reintegroCentavos,
    tipo_base: resultado.tipo_base,
  })).digest("hex");
  resultado.mensaje = sinPenalidad
    ? "Todavía no se firmó: se cancela sin penalidad y no tiene ningún cargo. ¿Confirmás la cancelación?"
    : `Si cancelas hoy, el reintegro estimado será del ${resultado.porcentaje_reintegro}% sobre el total de la reserva. ¿Deseas confirmar la cancelación?`;
  return resultado;
}

// Las reservas anteriores al registro de aceptación conservan la política
// histórica de su servicio. La fecha y el servicio se leen de BD: nunca se
// aceptan datos del cliente para elegir una versión más favorable.
// DATETIME guarda segundos; si publicación y reserva coinciden, se prefiere
// la política anterior. Versiones con la misma fecha desempatan por la menor
// versión/id. Si la reserva precede el registro, se usa la primera política.
// El historial es inmutable y sólo necesita SELECT. Al confirmar, el caller
// ya bloqueó la reserva; no se requieren privilegios de escritura/locking
// sobre las políticas para conservar sus condiciones históricas.
async function obtenerPoliticaHistoricaReserva(connection, reservaId) {
  const [historicas] = await connection.query(
    `SELECT p.*, ps.servicio_id FROM politica_cancelacion p
       INNER JOIN politica_cancelacion_servicio ps ON ps.politica_id = p.id
       INNER JOIN reserva r ON r.id = ?
       LEFT JOIN recurso rec ON rec.id = r.recurso_id
       LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
       WHERE ps.servicio_id = COALESCE(r.servicio_id, rec.servicio_id, ch.servicio_id)
         AND r.fecha_creacion IS NOT NULL
       ORDER BY CASE WHEN p.creada_en < r.fecha_creacion THEN 0 ELSE 1 END,
         CASE WHEN p.creada_en < r.fecha_creacion THEN p.creada_en END DESC,
         p.creada_en ASC, p.version ASC, p.id ASC
       LIMIT 1`, [reservaId]
  );
  if (!historicas.length) {
    throw errorPolitica("No se pudo determinar la política histórica de esta reserva", 503, "POLITICA_HISTORICA_NO_CONFIGURADA");
  }
  return { ...mapearPolitica(historicas[0]), servicio_id: Number(historicas[0].servicio_id) };
}

// La política que se le envió a firmar a la persona afiliada: vale ésa aunque
// después cambie la vigente del servicio.
function politicaDeSolicitudFirma(fila) {
  const snapshot = parsearJson(fila?.politica_snapshot_json) || {};
  return {
    ...snapshot,
    id: normalizarIdPositivo(snapshot.id) || normalizarIdPositivo(fila?.politica_id),
    version: normalizarIdPositivo(snapshot.version) || normalizarIdPositivo(fila?.politica_version),
  };
}

// Política aceptada al reservar o, si la reserva es anterior a ese registro,
// la histórica (congelada en reserva_politica_cancelacion_historica o
// reconstruida desde el historial de políticas del servicio).
async function obtenerPoliticaCotizacion(connection, reserva) {
  const [rows] = await connection.query(
    `SELECT snapshot_json, 'ACEPTADA' AS origen_politica FROM reserva_politica_cancelacion WHERE reserva_id = ?
       UNION ALL
     SELECT snapshot_json, 'HISTORICA_RESERVA_ANTERIOR' AS origen_politica
       FROM reserva_politica_cancelacion_historica WHERE reserva_id = ?
       AND NOT EXISTS (SELECT 1 FROM reserva_politica_cancelacion WHERE reserva_id = ?)
       LIMIT 1`, [reserva.id, reserva.id, reserva.id]
  );
  if (rows[0]) return { politica: parsearJson(rows[0].snapshot_json), origen: rows[0].origen_politica || "ACEPTADA" };
  return { politica: await obtenerPoliticaHistoricaReserva(connection, reserva.id), origen: "HISTORICA_RESERVA_ANTERIOR" };
}

async function cotizarCancelacion(connection, { reserva, ahora }) {
  if (esPendienteFirma(reserva?.estado_nombre)) {
    // Todavía no aceptó ninguna condición: la baja es sin penalidad. Queda
    // registrada con la política que se le envió a firmar.
    const [solicitudes] = await connection.query(
      "SELECT politica_id, politica_version, politica_snapshot_json FROM reserva_firma_afiliado WHERE reserva_id = ? LIMIT 1",
      [reserva.id]
    );
    const politica = solicitudes[0]
      ? politicaDeSolicitudFirma(solicitudes[0])
      : (await obtenerPoliticaCotizacion(connection, reserva)).politica;
    return calcularCotizacion({
      reserva, politica, ahora, origenPolitica: REGLA_CANCELACION_SIN_FIRMA, regla: REGLA_CANCELACION_SIN_FIRMA,
    });
  }
  const { politica, origen } = await obtenerPoliticaCotizacion(connection, reserva);
  return calcularCotizacion({ reserva, politica, ahora, origenPolitica: origen });
}

// Quién pidió la baja y por dónde: la persona afiliada desde la app, o el staff
// a su pedido (en persona, por teléfono o por escrito). El motivo se guarda con
// la cancelación y no pisa las observaciones de la reserva.
function normalizarPedidoCancelacion({ origen = ORIGEN_CANCELACION_AFILIADO, canal = null, motivo = null } = {}) {
  if (![ORIGEN_CANCELACION_AFILIADO, ORIGEN_CANCELACION_STAFF_A_PEDIDO].includes(origen)) {
    throw errorPolitica("No se reconoce quién pidió la cancelación", 400, "CANCELACION_ORIGEN_INVALIDO");
  }
  const canalPedido = origen === ORIGEN_CANCELACION_STAFF_A_PEDIDO
    ? (typeof canal === "string" ? canal.trim().toUpperCase() : "")
    : "APP";
  if (origen === ORIGEN_CANCELACION_STAFF_A_PEDIDO && !CANALES_PEDIDO_CANCELACION.includes(canalPedido)) {
    throw errorPolitica("Indicá cómo pidió la cancelación la persona afiliada: en persona, por teléfono o por escrito", 400, "CANCELACION_CANAL_INVALIDO");
  }
  const texto = typeof motivo === "string" ? motivo.trim() : "";
  if ([...texto].length > MAX_MOTIVO_CANCELACION) {
    throw errorPolitica(`El motivo puede tener hasta ${MAX_MOTIVO_CANCELACION} caracteres`, 400, "MOTIVO_DEMASIADO_LARGO");
  }
  return { origen, canal: canalPedido, motivo: texto || null };
}

function textoHistorialCancelacion(actual, { origen, canal, motivo }) {
  const encabezado = origen === ORIGEN_CANCELACION_STAFF_A_PEDIDO
    ? `Cancelación a pedido de la persona afiliada (${TEXTO_CANAL_PEDIDO[canal]})`
    : "Cancelación confirmada por la persona afiliada desde la app";
  // Sin firma no se aplicaron las condiciones ni hubo pago: no se anota un «reintegro» con importes.
  const calculo = actual.regla === REGLA_CANCELACION_SIN_FIRMA
    ? "todavía no estaba firmada, sin penalidad (no se aplicaron las condiciones de cancelación)"
    : `política versión ${actual.politica.version}; ${actual.dias_previos} días previos al check-in; `
      + `reintegro estimado ${actual.porcentaje_reintegro}%: ARS ${actual.monto_reintegro.toFixed(2)} sobre total de reserva ARS ${actual.monto_base.toFixed(2)}`;
  return `${encabezado}: ${calculo}.${motivo ? ` Motivo: ${motivo}` : ""}`;
}

// Llamar después de autorizar la transición y bloquear reserva FOR UPDATE,
// dentro de la misma transacción que cambia estado y libera disponibilidad.
// Cancelar a pedido da el mismo cálculo que si la persona afiliada cancelara
// desde la app: sólo se agrega quién lo cargó, cómo lo pidió y el motivo.
async function confirmarCancelacionPolitica(connection, {
  reserva, usuarioId, confirmada, cotizacion, ahora, origen, canal, rol = null, motivo = null,
}) {
  if (confirmada !== true) throw errorPolitica("Confirmá el reintegro antes de cancelar la reserva", 400, "CANCELACION_NO_CONFIRMADA");
  const pedido = normalizarPedidoCancelacion({ origen, canal, motivo });
  const actual = await cotizarCancelacion(connection, { reserva, ahora });
  if (typeof cotizacion !== "string" || cotizacion !== actual.cotizacion) {
    throw errorPolitica("Las condiciones de cancelación cambiaron. Revisá el reintegro y confirmá nuevamente", 409, "COTIZACION_CANCELACION_ACTUALIZADA");
  }
  // Las columnas nuevas van al final: las posiciones anteriores no cambian.
  await connection.query(
    `INSERT INTO reserva_cancelacion_politica
      (reserva_id, politica_id, version, porcentaje_reintegro, fecha_calculo, fecha_checkin, dias_previos, snapshot_json, cancelada_por,
       monto_base, monto_reintegro, tipo_base, origen, canal, cancelada_por_rol, motivo, regla)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [reserva.id, actual.politica.id, actual.politica.version, actual.porcentaje_reintegro,
      actual.fecha_actual, actual.fecha_checkin, actual.dias_previos, JSON.stringify(actual), usuarioId,
      actual.monto_base, actual.monto_reintegro, actual.tipo_base,
      pedido.origen, pedido.canal, typeof rol === "string" && rol.trim() ? rol.trim().slice(0, 30) : null,
      pedido.motivo, actual.regla]
  );
  await connection.query(
    `INSERT INTO historial_reserva
      (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, usuario_modificador_id, observaciones)
     VALUES (?, 'UPDATE', 'porcentaje_reintegro', NULL, ?, ?, ?)`,
    [reserva.id, String(actual.porcentaje_reintegro), usuarioId, textoHistorialCancelacion(actual, pedido)]
  );
  return { ...actual, origen: pedido.origen, canal: pedido.canal, motivo: pedido.motivo };
}

// Se consulta después de autorizar el detalle de reserva. Nunca vuelve a
// cotizar una cancelación histórica ni infiere importes con precios actuales.
// El nombre de quien la cargó (incluirAutor) es sólo para el staff.
async function obtenerCancelacionRegistrada(connection, { reservaId, incluirAutor = false }) {
  const [rows] = await connection.query(
    `SELECT rcp.*, DATE_FORMAT(rcp.fecha_calculo, '%Y-%m-%d') AS fecha_calculo_civil,
       DATE_FORMAT(rcp.fecha_checkin, '%Y-%m-%d') AS fecha_checkin_civil,
       u.nombre AS cancelada_por_nombre_pila, u.apellido AS cancelada_por_apellido
       FROM reserva_cancelacion_politica rcp LEFT JOIN usuario u ON u.id = rcp.cancelada_por
      WHERE rcp.reserva_id = ?`, [reservaId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const snapshot = parsearJson(row.snapshot_json) || {};
  const { motivo: _motivoInterno, creada_por, autor_nombre, ...politica } = snapshot.politica || {};
  const tieneImportes = row.tipo_base === "TOTAL_RESERVA" && row.monto_base != null && row.monto_reintegro != null;
  return {
    fecha_cancelacion: row.cancelada_en,
    fecha_calculo: row.fecha_calculo_civil,
    fecha_checkin: row.fecha_checkin_civil,
    dias_previos: Number(row.dias_previos),
    porcentaje_reintegro: Number(row.porcentaje_reintegro),
    monto_base: tieneImportes ? Number(row.monto_base) : null,
    monto_reintegro: tieneImportes ? Number(row.monto_reintegro) : null,
    tipo_base: tieneImportes ? "TOTAL_RESERVA" : "NO_REGISTRADO_HISTORICO",
    moneda: "ARS", es_estimado: true,
    politica: normalizarIdPositivo(politica.id) ? politica : null,
    origen_politica: snapshot.origen_politica || "NO_REGISTRADO_HISTORICO",
    zona_horaria: ZONA_HORARIA,
    // Quién la pidió y cómo. Cancelaciones anteriores a este registro: null.
    origen: row.origen || null,
    canal: row.canal || null,
    motivo: row.motivo || null,
    regla: row.regla || REGLA_CANCELACION_POLITICA,
    cancelada_por_rol: row.cancelada_por_rol || null,
    ...(incluirAutor ? { cancelada_por_nombre: nombreCompleto(row.cancelada_por_nombre_pila, row.cancelada_por_apellido) } : {}),
  };
}

// ---------------------------------------------------------------------------
// «Condiciones de cancelación» del detalle de la reserva
// ---------------------------------------------------------------------------

function fechaCivilDe(valor) {
  return normalizarFechaCivil(typeof valor === "string" ? valor.slice(0, 10) : valor);
}

// DATETIME llega como Date (mysql2) o como texto 'YYYY-MM-DD HH:mm:ss' en hora de Argentina.
function instanteDe(valor) {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  if (typeof valor !== "string" || !valor.trim()) return null;
  const texto = valor.trim();
  const fecha = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(texto)
    ? new Date(`${texto.replace(" ", "T")}-03:00`)
    : new Date(texto);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * Tramos de la política con fechas reales, de más anticipación a menos. Cuenta
 * los días igual que calcularCotizacion (ingreso − día en que se cancela, con el
 * calendario de Argentina), para que la sección, la firma y la constancia digan
 * lo mismo que la cotización. Ingreso 10/01/2027 con 0-6 / 7-14 / 15+:
 * hasta el 26/12/2026 · del 27/12/2026 al 03/01/2027 · del 04/01/2027 al 10/01/2027.
 * `activa`: la reserva sigue vigente (marca el tramo de hoy).
 */
function calcularTramosCondiciones({ reglas, fechaCheckin, hoy = obtenerFechaCivilArgentina(), activa = true }) {
  const checkin = fechaCivilDe(fechaCheckin);
  if (!checkin) throw errorPolitica("No se pudo determinar la fecha de ingreso", 409, "FECHA_CHECKIN_INVALIDA");
  const fechaHoy = fechaCivilDe(hoy);
  const dias = fechaHoy ? diferenciaDiasCivil(fechaHoy, checkin) : null;
  return validarReglas(reglas).slice().sort((a, b) => b.dias_desde - a.dias_desde).map((regla) => {
    const hasta = sumarDiasFechaCivil(checkin, -regla.dias_desde);
    const desde = regla.dias_hasta === null ? null : sumarDiasFechaCivil(checkin, -regla.dias_hasta);
    return {
      ...regla,
      desde_fecha: desde,
      hasta_fecha: hasta,
      ya_paso: Boolean(fechaHoy) && fechaHoy > hasta,
      es_hoy: Boolean(activa) && Number.isInteger(dias) && dias >= 0 && dias >= regla.dias_desde
        && (regla.dias_hasta === null || dias <= regla.dias_hasta),
    };
  });
}

// Quién cargó la reserva (reserva.creado_por_usuario_id): para decir «la cargó
// tu departamental» y para que la departamental rechace sus propias cargas.
async function obtenerCargaReserva(connection, reservaId) {
  const [rows] = await connection.query(
    `SELECT r.creado_por_usuario_id, u.nombre, u.apellido, u.departamental_id,
            ro.nombre AS rol, d.nombre AS departamental_nombre
       FROM reserva r
       LEFT JOIN usuario u ON u.id = r.creado_por_usuario_id
       LEFT JOIN rol ro ON ro.id = u.rol_id
       LEFT JOIN departamental d ON d.id = u.departamental_id
      WHERE r.id = ?`, [reservaId]
  );
  const fila = rows[0];
  const usuarioId = normalizarIdPositivo(fila?.creado_por_usuario_id);
  if (!usuarioId) return null;
  return {
    usuario_id: usuarioId,
    rol: fila.rol || null,
    departamental_id: normalizarIdPositivo(fila.departamental_id),
    nombre: nombreCompleto(fila.nombre, fila.apellido),
    departamental_nombre: fila.departamental_nombre || null,
  };
}

/**
 * Arma `condiciones_cancelacion` del resumen: la política que rige (aceptada,
 * enviada a firmar o histórica) con sus tramos y fechas, cómo se aceptó, quién
 * cargó y quién firmó, la solicitud de firma y la constancia en papel.
 * Los nombres de personas sólo van al staff; la persona afiliada recibe roles.
 * Devuelve null si no se puede determinar ninguna política.
 * `reserva`: fila con id, usuario_id, estado (o estado_nombre), fecha_inicio,
 * fecha_creacion y firma_archivo. `cancelacion`: la de obtenerCancelacionRegistrada
 * si ya se consultó (undefined para consultarla acá).
 */
async function obtenerCondicionesReserva(connection, {
  reserva, carga = null, cancelacion, rol, usuarioId,
  hoy = obtenerFechaCivilArgentina(), ahora = new Date(), firmarArchivo = null,
}) {
  const reservaId = normalizarIdPositivo(reserva?.id);
  const fechaCheckin = fechaCivilDe(reserva?.fecha_inicio);
  if (!reservaId || !fechaCheckin) return null;
  const estado = reserva.estado ?? reserva.estado_nombre ?? null;
  const esStaff = ROLES_STAFF_CONDICIONES.has(rol);
  const esPropietario = Number(usuarioId) > 0 && Number(usuarioId) === Number(reserva.usuario_id);
  const firmar = async (clave) => {
    if (!clave || typeof firmarArchivo !== "function") return null;
    try {
      return await firmarArchivo(clave);
    } catch (_) {
      return null;
    }
  };

  const [aceptaciones] = await connection.query(
    `SELECT rpc.*, u.nombre AS aceptada_por_nombre_pila, u.apellido AS aceptada_por_apellido,
            ra.nombre AS aceptada_por_rol
       FROM reserva_politica_cancelacion rpc
       LEFT JOIN usuario u ON u.id = rpc.aceptada_por
       LEFT JOIN rol ra ON ra.id = u.rol_id
      WHERE rpc.reserva_id = ?`, [reservaId]
  );
  const aceptacion = aceptaciones[0] || null;
  const [solicitudes] = await connection.query(
    `SELECT f.*, u.nombre AS solicitada_por_nombre_pila, u.apellido AS solicitada_por_apellido
       FROM reserva_firma_afiliado f LEFT JOIN usuario u ON u.id = f.solicitada_por_usuario_id
      WHERE f.reserva_id = ?`, [reservaId]
  );
  const solicitud = solicitudes[0] || null;
  const cancelada = cancelacion === undefined
    ? await obtenerCancelacionRegistrada(connection, { reservaId })
    : cancelacion;

  // Qué política rige, en este orden: la aceptada; la que se aplicó al cancelar
  // (sin volver a consultar el historial); la que se envió a firmar; la
  // histórica del servicio, para reservas anteriores al registro.
  let politica = null;
  let origen = "HISTORICA_RESERVA_ANTERIOR";
  if (aceptacion) {
    politica = parsearJson(aceptacion.snapshot_json);
    origen = "ACEPTADA";
  } else if (cancelada?.politica) {
    politica = cancelada.politica;
    if (cancelada.origen_politica === REGLA_CANCELACION_SIN_FIRMA) origen = "PENDIENTE_FIRMA";
    else if (cancelada.origen_politica === "ACEPTADA") origen = "ACEPTADA";
  } else if (solicitud) {
    politica = politicaDeSolicitudFirma(solicitud);
    origen = "PENDIENTE_FIRMA";
  } else {
    const [congeladas] = await connection.query(
      "SELECT snapshot_json FROM reserva_politica_cancelacion_historica WHERE reserva_id = ? LIMIT 1", [reservaId]
    );
    if (congeladas[0]) {
      politica = parsearJson(congeladas[0].snapshot_json);
    } else {
      try {
        politica = await obtenerPoliticaHistoricaReserva(connection, reservaId);
      } catch (error) {
        if (error?.codigo === "POLITICA_HISTORICA_NO_CONFIGURADA") return null;
        throw error;
      }
    }
  }
  let reglas;
  try {
    reglas = validarReglas(politica?.reglas);
  } catch (_) {
    return null;
  }

  const cerrada = ESTADOS_RESERVA_CERRADOS.has(estado);
  const fechaHoy = fechaCivilDe(hoy);
  const tramos = calcularTramosCondiciones({
    reglas, fechaCheckin, hoy: fechaHoy, activa: !cerrada && Boolean(fechaHoy) && fechaCheckin >= fechaHoy,
  });

  const aceptadaPorNombre = aceptacion
    ? nombreCompleto(aceptacion.aceptada_por_nombre_pila, aceptacion.aceptada_por_apellido)
    : null;

  // La firma que prueba la aceptación es la copia guardada con ella; si la
  // reserva es anterior a ese registro, la de la reserva (sin saber quién firmó).
  let firma = null;
  const claveFirma = aceptacion?.firma_archivo || reserva.firma_archivo || null;
  if (claveFirma) {
    const deLaAceptacion = Boolean(aceptacion?.firma_archivo);
    const firmante = deLaAceptacion ? (aceptacion.firma_por || null) : null;
    let reFirmadaEn = null;
    if (deLaAceptacion && reserva.firma_archivo && reserva.firma_archivo !== aceptacion.firma_archivo) {
      const [cambios] = await connection.query(
        `SELECT MAX(fecha_modificacion) AS ultima FROM historial_reserva
          WHERE reserva_id = ? AND campo_modificado = 'firma_archivo'`, [reservaId]
      );
      reFirmadaEn = cambios[0]?.ultima || null;
    }
    firma = {
      url: await firmar(claveFirma),
      firmante,
      firmada_en: deLaAceptacion ? (aceptacion.firmada_en || aceptacion.aceptada_en || null) : null,
      re_firmada_en: reFirmadaEn,
      ...(esStaff ? { firmante_nombre: firmante === "ADMINISTRATIVO" ? aceptadaPorNombre : null } : {}),
    };
  }

  // null = la cargó la propia persona afiliada (o no quedó registrado).
  const cargaAdministrativa = carga && ROLES_CARGA_ADMINISTRATIVA.has(carga.rol)
    && Number(carga.usuario_id) !== Number(reserva.usuario_id)
    ? {
      rol: carga.rol,
      fecha: reserva.fecha_creacion || null,
      ...(esStaff ? { nombre: carga.nombre || null, departamental_nombre: carga.departamental_nombre || null } : {}),
    }
    : null;

  const venceFirma = instanteDe(solicitud?.vence_en);
  const solicitudFirma = solicitud ? {
    estado: solicitud.decision,
    estado_destino: solicitud.estado_destino || null,
    solicitada_en: solicitud.fecha_solicitud || null,
    vence_en: solicitud.vence_en || null,
    respondida_en: solicitud.fecha_respuesta || null,
    motivo_rechazo: solicitud.decision === "RECHAZADA" ? (solicitud.motivo || null) : null,
    puede_firmar: rol === "afiliado" && esPropietario && solicitud.decision === "PENDIENTE"
      && esPendienteFirma(estado) && Boolean(venceFirma) && venceFirma > ahora,
    ...(esStaff ? {
      solicitada_por_nombre: nombreCompleto(solicitud.solicitada_por_nombre_pila, solicitud.solicitada_por_apellido),
      avisos_enviados: solicitud.avisos_enviados == null ? null : Number(solicitud.avisos_enviados),
      ultimo_aviso_en: solicitud.ultimo_aviso_en || null,
    } : {}),
  } : null;

  const [archivos] = await connection.query(
    `SELECT a.id, a.archivo, a.nombre_original, a.mime, a.tamanio, a.subido_por_usuario_id, a.fecha_creacion,
            u.nombre AS subido_por_nombre_pila, u.apellido AS subido_por_apellido
       FROM reserva_constancia_archivo a LEFT JOIN usuario u ON u.id = a.subido_por_usuario_id
      WHERE a.reserva_id = ? AND a.eliminado = 0
      ORDER BY a.id`, [reservaId]
  );
  // Mientras espera la firma no hay condiciones aceptadas que imprimir ni probar.
  const conCondiciones = origen !== "PENDIENTE_FIRMA";
  const constancia = {
    archivos: await Promise.all(archivos.map(async (archivo) => ({
      id: Number(archivo.id),
      nombre_original: archivo.nombre_original || null,
      mime: archivo.mime || null,
      tamanio: archivo.tamanio == null ? null : Number(archivo.tamanio),
      url: await firmar(archivo.archivo),
      fecha_creacion: archivo.fecha_creacion || null,
      ...(esStaff ? {
        subido_por_nombre: nombreCompleto(archivo.subido_por_nombre_pila, archivo.subido_por_apellido),
        puede_quitar: rol === "admin" || Number(archivo.subido_por_usuario_id) === Number(usuarioId),
      } : {}),
    }))),
    maximo_archivos: MAX_ARCHIVOS_CONSTANCIA,
    puede_imprimir: esStaff && conCondiciones && !cerrada,
    puede_adjuntar: esStaff && conCondiciones,
  };

  return {
    origen,
    politica: {
      id: normalizarIdPositivo(politica.id),
      version: normalizarIdPositivo(politica.version),
      titulo: politica.titulo || null,
      reglas,
    },
    sin_devoluciones: reglas.every((regla) => Number(regla.porcentaje_reintegro) === 0),
    fecha_checkin: fechaCheckin,
    tramos,
    aceptacion: aceptacion ? {
      aceptada_en: aceptacion.aceptada_en || null,
      modo: aceptacion.modo || null,
      canal: aceptacion.canal || null,
      // Quién la registró puede no ser quien cargó (se la envió uno y la firmó en pantalla
      // otro): sólo el rol, para todos los públicos; el nombre, sólo al staff.
      ...(aceptacion.modo === "CARGA_ADMINISTRATIVA" ? { aceptada_por_rol: aceptacion.aceptada_por_rol || null } : {}),
      ...(esStaff ? { aceptada_por_nombre: aceptadaPorNombre } : {}),
    } : null,
    firma,
    carga: cargaAdministrativa,
    solicitud_firma: solicitudFirma,
    constancia,
  };
}

module.exports = {
  REGLAS_INICIALES, ZONA_HORARIA, errorPolitica, validarReglas, mapearPolitica,
  obtenerPoliticaVigente, listarPoliticas, crearVersionPolitica, validarAceptacionPolitica,
  guardarAceptacionPolitica, calcularCotizacion, cotizarCancelacion, confirmarCancelacionPolitica,
  obtenerCancelacionRegistrada,
  // Cancelación a pedido y condiciones del detalle
  CANALES_PEDIDO_CANCELACION, ESTADO_PENDIENTE_FIRMA, MAX_ARCHIVOS_CONSTANCIA, MAX_MOTIVO_CANCELACION,
  ORIGEN_CANCELACION_AFILIADO, ORIGEN_CANCELACION_STAFF_A_PEDIDO, REGLA_CANCELACION_POLITICA, REGLA_CANCELACION_SIN_FIRMA,
  TEXTO_CANAL_PEDIDO, normalizarPedidoCancelacion, obtenerPoliticaHistoricaReserva, calcularTramosCondiciones,
  obtenerCargaReserva, obtenerCondicionesReserva,
  // Firma de las condiciones: la oración para leer por teléfono y para los avisos
  resumenPoliticaTexto,
};
