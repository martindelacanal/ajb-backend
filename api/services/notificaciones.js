"use strict";

// Las preferencias deciden sólo la entrega de avisos nuevos. El trámite, su
// chat y el historial siguen guardándose aunque el usuario silencie avisos.
const PREFERENCIAS_POR_DEFECTO = Object.freeze({
  mensajes: true,
  estados: true,
  gestiones: true,
  novedades: true,
});
const CATEGORIAS = Object.keys(PREFERENCIAS_POR_DEFECTO);

function categoriaNotificacion(tipo) {
  const valor = String(tipo || "").toUpperCase();
  if (/(?:^|_)(?:OBSERVACION|MENSAJE|CHAT)(?:_|$)/.test(valor)) return "mensajes";
  if (/(?:^|_)(?:ESTADO|APROBADO|APROBADA|RECHAZADO|RECHAZADA|REVISADA|REVISADO|REVISION|CANCELADA|CANCELADO|ACTUALIZADA|ACTUALIZADO|RESUELTO|RESUELTA|RESPUESTA|REASIGNADA|BONOS|ADJUDICADO|VENCIDA|VENCIDO)(?:_|$)/.test(valor)) return "estados";
  if (/(?:^|_)(?:NUEVA|NUEVO|INICIADA|CREADA|INSCRIPCION|PENDIENTE|SOLICITADO|PROPUESTA|APROBACION)(?:_|$)/.test(valor)
    || /_PARA_(?:CONTROL|APROBAR)(?:_|$)/.test(valor)) return "gestiones";
  return "novedades";
}

function normalizarPreferencias(fila) {
  return Object.fromEntries(CATEGORIAS.map((categoria) => [
    categoria,
    fila?.[categoria] === undefined ? true : fila[categoria] === true || Number(fila[categoria]) === 1,
  ]));
}

function validarPreferencias(valor) {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)
    || Object.keys(valor).length !== CATEGORIAS.length
    || !CATEGORIAS.every((categoria) => Object.hasOwn(valor, categoria) && typeof valor[categoria] === "boolean")) {
    throw Object.assign(new Error("Elegí una opción válida para cada tipo de notificación"), { statusCode: 400 });
  }
  return Object.fromEntries(CATEGORIAS.map((categoria) => [categoria, valor[categoria]]));
}

function faltaTablaPreferencias(error) {
  return error?.code === "ER_NO_SUCH_TABLE" && /usuario_notificacion_preferencia/.test(String(error.sqlMessage || error.message));
}

async function obtenerPreferenciasNotificaciones(connection, usuarioId) {
  try {
    const [rows] = await connection.query(
      "SELECT mensajes, estados, gestiones, novedades FROM usuario_notificacion_preferencia WHERE usuario_id = ? LIMIT 1",
      [usuarioId]
    );
    return normalizarPreferencias(rows[0]);
  } catch (error) {
    // Permite desplegar mientras se aplica la migración sin perder avisos.
    if (faltaTablaPreferencias(error)) return { ...PREFERENCIAS_POR_DEFECTO };
    throw error;
  }
}

async function guardarPreferenciasNotificaciones(connection, usuarioId, valor) {
  const preferencias = validarPreferencias(valor);
  try {
    await connection.query(
      `INSERT INTO usuario_notificacion_preferencia (usuario_id, mensajes, estados, gestiones, novedades)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE mensajes = VALUES(mensajes), estados = VALUES(estados),
         gestiones = VALUES(gestiones), novedades = VALUES(novedades)`,
      [usuarioId, ...CATEGORIAS.map((categoria) => preferencias[categoria] ? 1 : 0)]
    );
    return preferencias;
  } catch (error) {
    if (faltaTablaPreferencias(error)) {
      throw Object.assign(new Error("La configuración todavía no está disponible. Volvé a intentar en unos minutos"), { statusCode: 503 });
    }
    throw error;
  }
}

async function crearNotificacion(connection, { usuarioId, tipo, titulo, mensaje, payload = {}, categoria }) {
  const id = Number(usuarioId);
  if (!Number.isSafeInteger(id) || id <= 0) return { insertId: null, affectedRows: 0 };
  const categoriaEntrega = categoria || categoriaNotificacion(tipo);
  if (!CATEGORIAS.includes(categoriaEntrega)) throw new Error("Categoría de notificación inválida");
  const textoTitulo = String(titulo || "").trim();
  const valores = [id, tipo, textoTitulo.length > 180 ? `${textoTitulo.slice(0, 179)}…` : textoTitulo,
    mensaje, typeof payload === "string" ? payload : JSON.stringify(payload || {})];
  let resultado;
  try {
    // INSERT ... SELECT comprueba la preferencia en la misma sentencia; no
    // necesita caché ni otra conexión y participa de la transacción del trámite.
    [resultado] = await connection.query(
      `INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload)
       SELECT ?, ?, ?, ?, ? WHERE COALESCE(
         (SELECT ${categoriaEntrega} FROM usuario_notificacion_preferencia WHERE usuario_id = ?), 1) = 1`,
      [...valores, id]
    );
  } catch (error) {
    if (!faltaTablaPreferencias(error)) throw error;
    [resultado] = await connection.query(
      "INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)", valores
    );
  }
  return { ...resultado, insertId: resultado.insertId || null };
}

module.exports = {
  PREFERENCIAS_POR_DEFECTO,
  CATEGORIAS,
  categoriaNotificacion,
  normalizarPreferencias,
  validarPreferencias,
  obtenerPreferenciasNotificaciones,
  guardarPreferenciasNotificaciones,
  crearNotificacion,
};
