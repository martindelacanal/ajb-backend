"use strict";

const crypto = require("crypto");
const {
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
  diferenciaDiasCivil,
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

// En altas/ediciones usar una transacción. El singleton serializa los cambios
// de versión y su bloqueo compartido mantiene vigente la versión aceptada.
async function obtenerPoliticaVigente(connection, { bloquear = false, exclusivo = false } = {}) {
  if (bloquear || exclusivo) {
    const [punteros] = await connection.query(
      `SELECT politica_id FROM politica_cancelacion_vigente WHERE id = 1 ${exclusivo ? "FOR UPDATE" : "LOCK IN SHARE MODE"}`
    );
    if (!punteros[0]) throw errorPolitica("No hay una política de cancelación vigente", 503, "POLITICA_NO_CONFIGURADA");
    // El alta puede haber establecido una read view antes de obtener este lock.
    // La lectura actual evita que REPEATABLE READ oculte una versión recién
    // publicada cuyo id ya devolvió el singleton bloqueado.
    const [rows] = await connection.query("SELECT * FROM politica_cancelacion WHERE id = ? LOCK IN SHARE MODE", [punteros[0].politica_id]);
    return mapearPolitica(rows[0]);
  }
  const [rows] = await connection.query(
    `SELECT p.* FROM politica_cancelacion p
      INNER JOIN politica_cancelacion_vigente v ON v.politica_id = p.id WHERE v.id = 1`
  );
  return mapearPolitica(rows[0]);
}

async function listarPoliticas(connection) {
  const [rows] = await connection.query(
    `SELECT p.*, CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, '')) AS autor_nombre,
            CASE WHEN v.politica_id = p.id THEN 1 ELSE 0 END AS vigente
       FROM politica_cancelacion p LEFT JOIN usuario u ON u.id = p.creada_por
       LEFT JOIN politica_cancelacion_vigente v ON v.id = 1 ORDER BY p.version DESC`
  );
  return {
    vigente: rows.find((row) => Number(row.vigente) === 1) ? mapearPolitica(rows.find((row) => Number(row.vigente) === 1)) : null,
    historial: rows.map((row) => ({ ...mapearPolitica(row), vigente: Number(row.vigente) === 1 })),
  };
}

async function crearVersionPolitica(connection, { versionActual, titulo, motivo, reglas, usuarioId }) {
  const normalizadas = validarReglas(reglas);
  const textoTitulo = typeof titulo === "string" ? titulo.trim() : "";
  const textoMotivo = typeof motivo === "string" ? motivo.trim() : "";
  if (!textoTitulo || textoTitulo.length > 160 || !textoMotivo || textoMotivo.length > 2000) {
    throw errorPolitica("Ingresá un título (hasta 160 caracteres) y un motivo del cambio (hasta 2000 caracteres)");
  }
  const autor = normalizarIdPositivo(usuarioId);
  if (!autor) throw errorPolitica("Usuario no autorizado", 403, "POLITICA_NO_AUTORIZADA");
  const vigente = await obtenerPoliticaVigente(connection, { exclusivo: true });
  if (normalizarIdPositivo(versionActual) !== vigente.version) {
    throw errorPolitica("La política cambió. Volvé a cargarla antes de guardar", 409, "POLITICA_ACTUALIZADA");
  }
  const [insert] = await connection.query(
    `INSERT INTO politica_cancelacion (version, titulo, reglas_json, motivo, creada_por)
     VALUES (?, ?, ?, ?, ?)`,
    [vigente.version + 1, textoTitulo, JSON.stringify(normalizadas), textoMotivo, autor]
  );
  await connection.query("UPDATE politica_cancelacion_vigente SET politica_id = ? WHERE id = 1", [insert.insertId]);
  const [rows] = await connection.query("SELECT * FROM politica_cancelacion WHERE id = ?", [insert.insertId]);
  return mapearPolitica(rows[0]);
}

async function validarAceptacionPolitica(connection, { aceptada, politicaId, version }) {
  if (aceptada !== true) {
    throw errorPolitica("Debés leer y aceptar la política de cancelación para enviar la reserva", 400, "POLITICA_NO_ACEPTADA");
  }
  const politica = await obtenerPoliticaVigente(connection, { bloquear: true });
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
  const resultado = {
    reserva_id: Number(reserva.id),
    fecha_actual: fechaActual,
    fecha_checkin: fechaCheckin,
    dias_previos: diasPrevios,
    porcentaje_reintegro: regla.porcentaje_reintegro,
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
  })).digest("hex");
  resultado.mensaje = `Si cancelas hoy, el reintegro correspondiente será del ${resultado.porcentaje_reintegro}%. ¿Deseas confirmar la cancelación?`;
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
  const politica = await obtenerPoliticaVigente(connection, { bloquear });
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
      (reserva_id, politica_id, version, porcentaje_reintegro, fecha_calculo, fecha_checkin, dias_previos, snapshot_json, cancelada_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [reserva.id, actual.politica.id, actual.politica.version, actual.porcentaje_reintegro,
      actual.fecha_actual, actual.fecha_checkin, actual.dias_previos, JSON.stringify(actual), usuarioId]
  );
  await connection.query(
    `INSERT INTO historial_reserva
      (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, usuario_modificador_id, observaciones)
     VALUES (?, 'UPDATE', 'porcentaje_reintegro', NULL, ?, ?, ?)`,
    [reserva.id, String(actual.porcentaje_reintegro), usuarioId,
      `Cancelación confirmada: política versión ${actual.politica.version}; ${actual.dias_previos} días previos al check-in; reintegro ${actual.porcentaje_reintegro}%.`]
  );
  return actual;
}

module.exports = {
  REGLAS_INICIALES, ZONA_HORARIA, errorPolitica, validarReglas, mapearPolitica,
  obtenerPoliticaVigente, listarPoliticas, crearVersionPolitica, validarAceptacionPolitica,
  guardarAceptacionPolitica, calcularCotizacion, cotizarCancelacion, confirmarCancelacionPolitica,
};
