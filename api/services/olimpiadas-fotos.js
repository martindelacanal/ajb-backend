'use strict';

const { crearErrorHttp, firmarSeguro, normalizarIdPositivo } = require('./olimpiadas-comun');
const { normalizarFechaCivil } = require('./valores-dominio');
const { partidosPublicos } = require('./olimpiadas-competicion');

const MAX_ETIQUETAS = 20;
const MAX_LARGO_ETIQUETA = 60;

function leerEtiquetas(valor, { historicas = false } = {}) {
  const entradas = Array.isArray(valor) ? valor : [valor ?? ''];
  const etiquetas = new Map();
  for (const entrada of entradas) {
    if (typeof entrada !== 'string') throw crearErrorHttp('Las etiquetas deben ser texto separado por comas');
    for (const parte of entrada.split(',')) {
      const etiqueta = parte.normalize('NFC').trim().replace(/^#+/, '').trim().replace(/\s+/g, ' ');
      if (!etiqueta) continue;
      if ([...etiqueta].length > MAX_LARGO_ETIQUETA) throw crearErrorHttp('Cada etiqueta admite hasta 60 caracteres');
      const clave = etiqueta.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');
      if (!etiquetas.has(clave)) etiquetas.set(clave, etiqueta);
    }
  }
  if (!historicas && etiquetas.size > MAX_ETIQUETAS) throw crearErrorHttp('Podés usar hasta 20 etiquetas por foto');
  return [...etiquetas.values()];
}

// Las inserciones anteriores a la migración conservan su etiqueta original.
const ETIQUETAS_SQL = "COALESCE(f.etiquetas, IF(f.etiqueta IS NULL, JSON_ARRAY(), JSON_ARRAY(f.etiqueta)))";
const TABLA_ETIQUETAS = `JSON_TABLE(${ETIQUETAS_SQL}, '$[*]' COLUMNS (
  etiqueta VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci PATH '$'
)) AS tag`;

const SELECT_FOTO = `SELECT f.id, f.olimpiada_id, f.archivo, f.miniatura_archivo, f.mime, f.ancho, f.alto, f.epigrafe,
  f.disciplina_id, d.nombre AS disciplina_nombre, p.id AS partido_id, f.fecha, f.etiqueta, f.etiquetas, f.orden, f.fecha_creacion
  FROM olimpiada_foto f
  LEFT JOIN olimpiada_disciplina d ON d.id = f.disciplina_id
  LEFT JOIN olimpiada_partido p ON p.id = f.partido_id AND p.eliminado = 0 AND p.olimpiada_id = f.olimpiada_id`;

async function serializarFoto(fila, partidoNombre = null) {
  const extensionGuardada = /\.(webp|jpe?g|png|heic|heif|avif|gif)$/i.exec(fila.archivo)?.[1];
  const formato = /^image\/(webp|jpe?g|png|heic|heif|avif|gif)$/i.exec(fila.mime)?.[1];
  const extension = extensionGuardada?.toLowerCase() || formato?.toLowerCase().replace('jpeg', 'jpg');
  const nombre = `olimpiadas-${fila.olimpiada_id}-foto-${fila.id}${extension ? '.' + extension : ''}`;
  const [url, miniatura, descargaUrl] = await Promise.all([
    firmarSeguro(fila.archivo), firmarSeguro(fila.miniatura_archivo),
    firmarSeguro(fila.archivo, undefined, `attachment; filename="${nombre}"`),
  ]);
  const etiquetas = fila.etiquetas == null ? (fila.etiqueta ? [fila.etiqueta] : [])
    : Array.isArray(fila.etiquetas) ? fila.etiquetas : JSON.parse(fila.etiquetas);
  return {
    id: fila.id, olimpiada_id: fila.olimpiada_id, url, url_miniatura: miniatura, descarga_url: descargaUrl, ancho: fila.ancho, alto: fila.alto,
    epigrafe: fila.epigrafe, disciplina_id: fila.disciplina_id, disciplina_nombre: fila.disciplina_nombre || null,
    partido_id: fila.partido_id ?? null, partido_nombre: partidoNombre, fecha: fila.fecha,
    etiquetas, etiqueta: etiquetas.join(', ') || null, orden: fila.orden, fecha_creacion: fila.fecha_creacion,
  };
}

async function opcionesPartidos(conexion, olimpiadaId, consultarPartidos, ids = null) {
  if (ids && !ids.length) return [];
  const condiciones = ['p.olimpiada_id = ?'], params = [olimpiadaId];
  if (ids) { condiciones.push('p.id IN (?)'); params.push(ids); }
  const partidos = partidosPublicos(await consultarPartidos(conexion, { condiciones, params }));
  return partidos.map(p => ({
    id: p.id, disciplina_id: p.disciplina_id,
    nombre: [`#${p.id}`, p.disciplina_nombre, [p.participante1, p.participante2].filter(Boolean).join(' vs. '), p.etiqueta].filter(Boolean).join(' · '),
  }));
}

function filtroEntero(query, campo, defecto = null) {
  if (query[campo] === undefined || query[campo] === '') return defecto;
  const valor = normalizarIdPositivo(query[campo]);
  if (!valor) throw crearErrorHttp(`El filtro ${campo} es inválido`);
  return valor;
}

async function listarFotos(conexion, olimpiadaId, query, consultarPartidos, { gestion = false } = {}) {
  const estadoVisible = gestion ? '' : " AND p.estado IN ('EN_JUEGO', 'FINALIZADO')";
  const page = filtroEntero(query, 'page', 1), pageSize = filtroEntero(query, 'pageSize', 24);
  if (page > 1000000 || pageSize > 60) throw crearErrorHttp('La paginación es inválida');
  const condiciones = ['f.olimpiada_id = ?', 'f.eliminado = 0'], params = [olimpiadaId];
  for (const campo of ['disciplina_id', 'partido_id']) {
    const valor = filtroEntero(query, campo);
    if (!valor) continue;
    condiciones.push(`f.${campo} = ?`);
    params.push(valor);
    if (campo === 'partido_id') {
      condiciones.push(`EXISTS (SELECT 1 FROM olimpiada_partido p WHERE p.id = f.partido_id AND p.olimpiada_id = f.olimpiada_id AND p.eliminado = 0${estadoVisible})`);
    }
  }
  if (query.fecha) {
    const fecha = normalizarFechaCivil(query.fecha);
    if (!fecha) throw crearErrorHttp('La fecha debe tener formato YYYY-MM-DD');
    condiciones.push('f.fecha = ?');
    params.push(fecha);
  }
  for (const etiqueta of leerEtiquetas(query.etiquetas ?? query.etiqueta)) {
    condiciones.push(`EXISTS (SELECT 1 FROM ${TABLA_ETIQUETAS} WHERE tag.etiqueta = ?)`);
    params.push(etiqueta);
  }
  const where = condiciones.join(' AND ');
  const [[[cuenta]], [rows], [disciplinas], [fechas], [etiquetas], [cuentasPartidos]] = await Promise.all([
    conexion.query(`SELECT COUNT(*) AS total FROM olimpiada_foto f WHERE ${where}`, params),
    conexion.query(`${SELECT_FOTO}${estadoVisible} WHERE ${where} ORDER BY f.fecha DESC, f.orden, f.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]),
    conexion.query(`SELECT d.id, d.nombre, COUNT(*) AS cantidad FROM olimpiada_foto f INNER JOIN olimpiada_disciplina d ON d.id = f.disciplina_id
      WHERE f.olimpiada_id = ? AND f.eliminado = 0 GROUP BY d.id, d.nombre ORDER BY d.nombre`, [olimpiadaId]),
    conexion.query(`SELECT fecha, COUNT(*) AS cantidad FROM olimpiada_foto WHERE olimpiada_id = ? AND eliminado = 0 AND fecha IS NOT NULL
      GROUP BY fecha ORDER BY fecha DESC`, [olimpiadaId]),
    conexion.query(`SELECT tag.etiqueta, COUNT(*) AS cantidad FROM olimpiada_foto f CROSS JOIN ${TABLA_ETIQUETAS}
      WHERE f.olimpiada_id = ? AND f.eliminado = 0 GROUP BY tag.etiqueta ORDER BY tag.etiqueta`, [olimpiadaId]),
    conexion.query(`SELECT f.partido_id, COUNT(*) AS cantidad FROM olimpiada_foto f JOIN olimpiada_partido p
      ON p.id = f.partido_id AND p.olimpiada_id = f.olimpiada_id AND p.eliminado = 0${estadoVisible}
      WHERE f.olimpiada_id = ? AND f.eliminado = 0 GROUP BY f.partido_id`, [olimpiadaId]),
  ]);
  const cantidades = new Map(cuentasPartidos.map(p => [Number(p.partido_id), Number(p.cantidad)]));
  const opciones = await opcionesPartidos(conexion, olimpiadaId, consultarPartidos, [...cantidades.keys()]);
  const partidos = opciones.map(p => ({ ...p, cantidad: cantidades.get(Number(p.id)) }));
  const nombres = new Map(partidos.map(p => [Number(p.id), p.nombre]));
  return {
    results: await Promise.all(rows.map(f => serializarFoto(f, nombres.get(Number(f.partido_id))))),
    totalItems: Number(cuenta.total), page, pageSize, filtros: { disciplinas, fechas, etiquetas, partidos },
  };
}

module.exports = { leerEtiquetas, opcionesPartidos, SELECT_FOTO, serializarFoto, listarFotos };
