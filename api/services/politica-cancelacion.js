"use strict";

const crypto = require("crypto");
const {
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
  diferenciaDiasCivil,
  decimalACentavos,
  centavosANumero,
} = require("./valores-dominio");
const { normalizarIdPositivo } = require("./turismo-catalogo");

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
       ORDER BY p.version DESC`
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
  const [ultima] = await connection.query("SELECT version FROM politica_cancelacion ORDER BY version DESC LIMIT 1 LOCK IN SHARE MODE");
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

async function validarAceptacionPolitica(connection, { aceptada, politicaId, version, servicioId }) {
  if (aceptada !== true) {
    throw errorPolitica("Debés leer y aceptar la política de cancelación para enviar la reserva", 400, "POLITICA_NO_ACEPTADA");
  }
  const politica = await obtenerPoliticaVigente(connection, { servicioId, bloquear: true });
  if (normalizarIdPositivo(politicaId) !== politica.id || normalizarIdPositivo(version) !== politica.version) {
    throw errorPolitica("La política de cancelación cambió. Revisala y aceptala nuevamente", 409, "POLITICA_ACTUALIZADA");
  }
  return politica;
}

async function guardarAceptacionPolitica(connection, { reservaId, usuarioId, politica }) {
  await connection.query(
    `INSERT INTO reserva_politica_cancelacion
       (reserva_id, politica_id, version, snapshot_json, aceptada_por) VALUES (?, ?, ?, ?, ?)`,
    [reservaId, politica.id, politica.version, JSON.stringify(politica), usuarioId]
  );
}

function calcularCotizacion({ reserva, politica, origenPolitica = "ACEPTADA", ahora = new Date() }) {
  const fechaActual = obtenerFechaCivilArgentina(ahora);
  const fechaCheckin = normalizarFechaCivil(reserva?.fecha_inicio);
  if (!fechaActual || !fechaCheckin) throw errorPolitica("No se pudo determinar la fecha de ingreso", 409, "FECHA_CHECKIN_INVALIDA");
  const diasPrevios = diferenciaDiasCivil(fechaActual, fechaCheckin);
  const dias = Math.max(0, diasPrevios);
  const reglas = validarReglas(politica.reglas);
  const regla = reglas.find((r) => dias >= r.dias_desde && (r.dias_hasta === null || dias <= r.dias_hasta));
  // precio_total ya incluye adicionales y descuentos. Es una estimación sobre
  // el total de la reserva, no acredita un pago ni ordena una transferencia.
  const baseCentavos = decimalACentavos(reserva.precio_total);
  if (baseCentavos === null) throw errorPolitica("No se pudo determinar el total de la reserva", 409, "TOTAL_RESERVA_INVALIDO");
  const puntosBase = Math.round(regla.porcentaje_reintegro * 100);
  const reintegroCentavos = Number((BigInt(baseCentavos) * BigInt(puntosBase) + 5000n) / 10000n);
  const resultado = {
    reserva_id: Number(reserva.id),
    fecha_actual: fechaActual,
    fecha_calculo: fechaActual,
    fecha_checkin: fechaCheckin,
    dias_previos: diasPrevios,
    porcentaje_reintegro: regla.porcentaje_reintegro,
    monto_base: centavosANumero(baseCentavos),
    monto_reintegro: centavosANumero(reintegroCentavos),
    tipo_base: "TOTAL_RESERVA",
    moneda: "ARS",
    es_estimado: true,
    politica,
    origen_politica: origenPolitica,
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
  resultado.mensaje = `Si cancelas hoy, el reintegro estimado será del ${resultado.porcentaje_reintegro}% sobre el total de la reserva. ¿Deseas confirmar la cancelación?`;
  return resultado;
}

async function cotizarCancelacion(connection, { reserva, ahora, bloquear = false }) {
  const [rows] = await connection.query(
    "SELECT snapshot_json FROM reserva_politica_cancelacion WHERE reserva_id = ?", [reserva.id]
  );
  if (rows[0]) {
    const snapshot = typeof rows[0].snapshot_json === "string" ? JSON.parse(rows[0].snapshot_json) : rows[0].snapshot_json;
    return calcularCotizacion({ reserva, politica: snapshot, ahora });
  }
  let servicioId = normalizarIdPositivo(reserva.servicio_id);
  if (!servicioId) {
    const [servicios] = await connection.query(
      `SELECT COALESCE(r.servicio_id, rec.servicio_id, ch.servicio_id) AS servicio_id
         FROM reserva r LEFT JOIN recurso rec ON rec.id = r.recurso_id
         LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id WHERE r.id = ?`, [reserva.id]
    );
    servicioId = normalizarIdPositivo(servicios[0]?.servicio_id);
  }
  const politica = await obtenerPoliticaVigente(connection, { servicioId, bloquear });
  return calcularCotizacion({ reserva, politica, ahora, origenPolitica: "VIGENTE_RESERVA_ANTERIOR" });
}

// Llamar después de autorizar la transición y bloquear reserva FOR UPDATE,
// dentro de la misma transacción que cambia estado y libera disponibilidad.
async function confirmarCancelacionPolitica(connection, { reserva, usuarioId, confirmada, cotizacion, ahora }) {
  if (confirmada !== true) throw errorPolitica("Confirmá el reintegro antes de cancelar la reserva", 400, "CANCELACION_NO_CONFIRMADA");
  const actual = await cotizarCancelacion(connection, { reserva, ahora, bloquear: true });
  if (typeof cotizacion !== "string" || cotizacion !== actual.cotizacion) {
    throw errorPolitica("Las condiciones de cancelación cambiaron. Revisá el reintegro y confirmá nuevamente", 409, "COTIZACION_CANCELACION_ACTUALIZADA");
  }
  await connection.query(
    `INSERT INTO reserva_cancelacion_politica
      (reserva_id, politica_id, version, porcentaje_reintegro, fecha_calculo, fecha_checkin, dias_previos, snapshot_json, cancelada_por,
       monto_base, monto_reintegro, tipo_base)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [reserva.id, actual.politica.id, actual.politica.version, actual.porcentaje_reintegro,
      actual.fecha_actual, actual.fecha_checkin, actual.dias_previos, JSON.stringify(actual), usuarioId,
      actual.monto_base, actual.monto_reintegro, actual.tipo_base]
  );
  await connection.query(
    `INSERT INTO historial_reserva
      (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, usuario_modificador_id, observaciones)
     VALUES (?, 'UPDATE', 'porcentaje_reintegro', NULL, ?, ?, ?)`,
    [reserva.id, String(actual.porcentaje_reintegro), usuarioId,
      `Cancelación confirmada: política versión ${actual.politica.version}; ${actual.dias_previos} días previos al check-in; reintegro estimado ${actual.porcentaje_reintegro}%: ARS ${actual.monto_reintegro.toFixed(2)} sobre total de reserva ARS ${actual.monto_base.toFixed(2)}.`]
  );
  return actual;
}

// Se consulta después de autorizar el detalle de reserva. Nunca vuelve a
// cotizar una cancelación histórica ni infiere importes con precios actuales.
async function obtenerCancelacionRegistrada(connection, { reservaId }) {
  const [rows] = await connection.query(
    `SELECT *, DATE_FORMAT(fecha_calculo, '%Y-%m-%d') AS fecha_calculo_civil,
       DATE_FORMAT(fecha_checkin, '%Y-%m-%d') AS fecha_checkin_civil
       FROM reserva_cancelacion_politica WHERE reserva_id = ?`, [reservaId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const snapshot = typeof row.snapshot_json === "string" ? JSON.parse(row.snapshot_json) : row.snapshot_json;
  const { motivo, creada_por, autor_nombre, ...politica } = snapshot.politica || {};
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
  };
}

module.exports = {
  REGLAS_INICIALES, ZONA_HORARIA, errorPolitica, validarReglas, mapearPolitica,
  obtenerPoliticaVigente, listarPoliticas, crearVersionPolitica, validarAceptacionPolitica,
  guardarAceptacionPolitica, calcularCotizacion, cotizarCancelacion, confirmarCancelacionPolitica,
  obtenerCancelacionRegistrada,
};
