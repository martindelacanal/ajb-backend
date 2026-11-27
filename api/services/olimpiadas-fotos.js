'use strict';

const { crearErrorHttp, firmarSeguro, normalizarIdPositivo } = require('./olimpiadas-comun');
const { normalizarFechaCivil } = require('./valores-dominio');
const { partidosPublicos } = require('./olimpiadas-competicion');

const MAX_ETIQUETAS = 20;
const MAX_LARGO_ETIQUETA = 60;
const MAX_DEPARTAMENTALES = 40;
const MAX_OPCIONES_FILTRO = 60;

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
  if (!historicas && etiquetas.size > MAX_ETIQUETAS) throw crearErrorHttp('Podés usar hasta 20 etiquetas por archivo');
  return [...etiquetas.values()];
}

// Departamentales de una foto: una lista de ids, o el mismo dato como texto (JSON o separado por
// comas), que es como llega en la subida. Devuelve los ids sin repetir.
function leerDepartamentales(valor) {
  let entradas = valor ?? [];
  if (typeof entradas === 'string') {
    const texto = entradas.trim();
    if (texto.startsWith('[')) {
      try { entradas = JSON.parse(texto); } catch { throw crearErrorHttp('Las departamentales elegidas son inválidas'); }
    } else {
      entradas = texto ? texto.split(',') : [];
    }
  }
  if (!Array.isArray(entradas)) entradas = [entradas];
  const ids = new Set();
  for (const entrada of entradas) {
    const id = normalizarIdPositivo(entrada);
    if (!id) throw crearErrorHttp('Las departamentales elegidas son inválidas');
    ids.add(id);
  }
  if (ids.size > MAX_DEPARTAMENTALES) throw crearErrorHttp(`Podés elegir hasta ${MAX_DEPARTAMENTALES} departamentales por archivo`);
  return [...ids];
}

// Las inserciones anteriores a la migración conservan su etiqueta original.
const ETIQUETAS_SQL = "COALESCE(f.etiquetas, IF(f.etiqueta IS NULL, JSON_ARRAY(), JSON_ARRAY(f.etiqueta)))";
const tablaEtiquetas = datos => `JSON_TABLE(${datos}, '$[*]' COLUMNS (
  etiqueta VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci PATH '$'
)) AS tag`;
const TABLA_ETIQUETAS = tablaEtiquetas(ETIQUETAS_SQL);
const TABLA_DEPARTAMENTALES = "JSON_TABLE(COALESCE(f.departamentales, JSON_ARRAY()), '$[*]' COLUMNS (id INT PATH '$')) AS dep";

const SELECT_FOTO = `SELECT f.id, f.olimpiada_id, f.archivo, f.miniatura_archivo, f.mime, f.ancho, f.alto, f.epigrafe,
  f.disciplina_id, d.nombre AS disciplina_nombre, p.id AS partido_id, f.fecha, f.etiqueta, f.etiquetas, f.departamentales, f.orden, f.fecha_creacion
  FROM olimpiada_foto f
  LEFT JOIN olimpiada_disciplina d ON d.id = f.disciplina_id
  LEFT JOIN olimpiada_partido p ON p.id = f.partido_id AND p.eliminado = 0 AND p.olimpiada_id = f.olimpiada_id`;

function idsDepartamentales(fila) {
  const valor = fila?.departamentales;
  if (valor == null || valor === '') return [];
  const lista = Array.isArray(valor) ? valor : JSON.parse(valor);
  return Array.isArray(lista) ? lista.map(Number).filter(id => Number.isSafeInteger(id) && id > 0) : [];
}

// Nombres de las departamentales que aparecen en esas fotos (una sola consulta; ninguna si no hay).
async function nombresDepartamentales(conexion, filas) {
  const ids = [...new Set((filas || []).flatMap(idsDepartamentales))];
  if (!ids.length) return new Map();
  const [rows] = await conexion.query('SELECT id, nombre FROM departamental WHERE id IN (?)', [ids]);
  return new Map(rows.map(d => [Number(d.id), d.nombre]));
}

async function serializarFoto(fila, partidoNombre = null, departamentales = new Map()) {
  const extensionGuardada = /\.(webp|jpe?g|png|heic|heif|avif|gif)$/i.exec(fila.archivo)?.[1];
  const formato = /^image\/(webp|jpe?g|png|heic|heif|avif|gif)$/i.exec(fila.mime)?.[1];
  const extension = extensionGuardada?.toLowerCase() || formato?.toLowerCase().replace('jpeg', 'jpg');
  const nombre = `olimpiadas-${fila.olimpiada_id}-foto-${fila.id}${extension ? '.' + extension : ''}`;
  const [url, miniatura, descargaUrl] = await Promise.all([
    firmarSeguro(fila.archivo), firmarSeguro(fila.miniatura_archivo),
    firmarSeguro(fila.archivo, undefined, `attachment; filename="${nombre}"`),
  ]);
  return {
    id: fila.id, olimpiada_id: fila.olimpiada_id, url, url_miniatura: miniatura, descarga_url: descargaUrl, ancho: fila.ancho, alto: fila.alto,
    ...clasificacionGaleria(fila, partidoNombre, departamentales), orden: fila.orden, fecha_creacion: fila.fecha_creacion,
  };
}

function clasificacionGaleria(fila, partidoNombre = null, departamentales = new Map()) {
  const etiquetas = fila.etiquetas == null ? (fila.etiqueta ? [fila.etiqueta] : [])
    : Array.isArray(fila.etiquetas) ? fila.etiquetas : JSON.parse(fila.etiquetas);
  // Una departamental que ya no existe deja de mostrarse, sin romper la foto.
  const deLaFoto = idsDepartamentales(fila).filter(id => departamentales.has(id))
    .map(id => ({ id, nombre: departamentales.get(id) }))
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
  return {
    epigrafe: fila.epigrafe ?? null, disciplina_id: fila.disciplina_id ?? null, disciplina_nombre: fila.disciplina_nombre || null,
    partido_id: fila.partido_id ?? null, partido_nombre: partidoNombre, fecha: fila.fecha,
    etiquetas, etiqueta: etiquetas.join(', ') || null, departamentales: deLaFoto,
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

// Un filtro admite varias opciones (separadas por comas o con el parámetro repetido) y también la
// forma anterior, de una sola. Con varias, alcanza con que la foto coincida con alguna.
function opcionesFiltro(query, plural, singular, leer) {
  const campo = query[plural] !== undefined && query[plural] !== '' ? plural : singular;
  const crudo = query[campo];
  if (crudo === undefined || crudo === null || crudo === '') return [];
  const partes = (Array.isArray(crudo) ? crudo : [crudo])
    .flatMap(valor => (typeof valor === 'string' ? valor.split(',') : [valor]))
    .map(valor => (typeof valor === 'string' ? valor.trim() : valor))
    .filter(valor => valor !== '');
  if (partes.length > MAX_OPCIONES_FILTRO) throw crearErrorHttp(`El filtro ${campo} admite hasta ${MAX_OPCIONES_FILTRO} opciones`);
  const valores = new Set();
  for (const parte of partes) {
    const valor = leer(parte);
    if (!valor) throw crearErrorHttp(`El filtro ${campo} es inválido`);
    valores.add(valor);
  }
  return [...valores];
}

function condicionesGaleria(olimpiadaId, query, estadoVisible, etiquetasSql = TABLA_ETIQUETAS) {
  const condiciones = ['f.olimpiada_id = ?', 'f.eliminado = 0'], params = [olimpiadaId];
  const disciplinas = opcionesFiltro(query, 'disciplinas', 'disciplina_id', normalizarIdPositivo);
  if (disciplinas.length) {
    condiciones.push('f.disciplina_id IN (?)');
    params.push(disciplinas);
  }
  const partidosElegidos = opcionesFiltro(query, 'partidos', 'partido_id', normalizarIdPositivo);
  if (partidosElegidos.length) {
    condiciones.push('f.partido_id IN (?)');
    params.push(partidosElegidos);
    condiciones.push(`EXISTS (SELECT 1 FROM olimpiada_partido p WHERE p.id = f.partido_id AND p.olimpiada_id = f.olimpiada_id AND p.eliminado = 0${estadoVisible})`);
  }
  const fechasElegidas = opcionesFiltro(query, 'fechas', 'fecha', valor => (typeof valor === 'string' ? normalizarFechaCivil(valor) : null));
  if (fechasElegidas.length) {
    condiciones.push('f.fecha IN (?)');
    params.push(fechasElegidas);
  }
  // Las listas guardadas en JSON se comparan contando coincidencias: con EXISTS, MySQL 8.0 convierte la
  // subconsulta en un semijoin que pierde la relación con la foto y devuelve totales equivocados.
  const etiquetasElegidas = leerEtiquetas(query.etiquetas ?? query.etiqueta);
  if (etiquetasElegidas.length) {
    condiciones.push(`(SELECT COUNT(*) FROM ${etiquetasSql} WHERE tag.etiqueta IN (?)) > 0`);
    params.push(etiquetasElegidas);
  }
  const departamentalesElegidas = opcionesFiltro(query, 'departamentales', 'departamental_id', normalizarIdPositivo);
  if (departamentalesElegidas.length) {
    condiciones.push(`(SELECT COUNT(*) FROM ${TABLA_DEPARTAMENTALES} WHERE dep.id IN (?)) > 0`);
    params.push(departamentalesElegidas);
  }
  return { condiciones, params };
}
async function listarFotos(conexion, olimpiadaId, query, consultarPartidos, { gestion = false, porSubida = false } = {}) {
  const estadoVisible = gestion ? '' : " AND p.estado IN ('EN_JUEGO', 'FINALIZADO')";
  const page = filtroEntero(query, 'page', 1), pageSize = filtroEntero(query, 'pageSize', 24);
  if (page > 1000000 || pageSize > 60) throw crearErrorHttp('La paginación es inválida');
  const { condiciones, params } = condicionesGaleria(olimpiadaId, query, estadoVisible);
  const where = condiciones.join(' AND ');
  const orden = porSubida ? 'f.fecha_creacion DESC, f.id DESC' : 'f.fecha DESC, f.orden, f.id DESC';
  const [[[cuenta]], [rows], [disciplinasConFotos], [fechas], [etiquetas], [cuentasPartidos], [departamentales]] = await Promise.all([
    conexion.query(`SELECT COUNT(*) AS total FROM olimpiada_foto f WHERE ${where}`, params),
    conexion.query(`${SELECT_FOTO}${estadoVisible} WHERE ${where} ORDER BY ${orden} LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]),
    conexion.query(`SELECT d.id, d.nombre, COUNT(*) AS cantidad FROM olimpiada_foto f INNER JOIN olimpiada_disciplina d ON d.id = f.disciplina_id
      WHERE f.olimpiada_id = ? AND f.eliminado = 0 GROUP BY d.id, d.nombre ORDER BY d.nombre`, [olimpiadaId]),
    conexion.query(`SELECT fecha, COUNT(*) AS cantidad FROM olimpiada_foto WHERE olimpiada_id = ? AND eliminado = 0 AND fecha IS NOT NULL
      GROUP BY fecha ORDER BY fecha DESC`, [olimpiadaId]),
    conexion.query(`SELECT tag.etiqueta, COUNT(*) AS cantidad FROM olimpiada_foto f CROSS JOIN ${TABLA_ETIQUETAS}
      WHERE f.olimpiada_id = ? AND f.eliminado = 0 GROUP BY tag.etiqueta ORDER BY tag.etiqueta`, [olimpiadaId]),
    conexion.query(`SELECT f.partido_id, COUNT(*) AS cantidad FROM olimpiada_foto f JOIN olimpiada_partido p
      ON p.id = f.partido_id AND p.olimpiada_id = f.olimpiada_id AND p.eliminado = 0${estadoVisible}
      WHERE f.olimpiada_id = ? AND f.eliminado = 0 GROUP BY f.partido_id`, [olimpiadaId]),
    conexion.query(`SELECT dp.id, dp.nombre, COUNT(DISTINCT f.id) AS cantidad FROM olimpiada_foto f CROSS JOIN ${TABLA_DEPARTAMENTALES}
      INNER JOIN departamental dp ON dp.id = dep.id
      WHERE f.olimpiada_id = ? AND f.eliminado = 0 GROUP BY dp.id, dp.nombre ORDER BY dp.nombre`, [olimpiadaId]),
  ]);
  const cantidades = new Map(cuentasPartidos.map(p => [Number(p.partido_id), Number(p.cantidad)]));
  const opciones = await opcionesPartidos(conexion, olimpiadaId, consultarPartidos, [...cantidades.keys()]);
  const partidos = opciones.map(p => ({ ...p, cantidad: cantidades.get(Number(p.id)) }));
  const nombres = new Map(partidos.map(p => [Number(p.id), p.nombre]));
  // Los nombres salen del mismo listado de opciones: toda departamental de una foto visible está ahí.
  const nombresDeDepartamentales = new Map(departamentales.map(d => [Number(d.id), d.nombre]));
  return {
    results: await Promise.all(rows.map(f => serializarFoto(f, nombres.get(Number(f.partido_id)), nombresDeDepartamentales))),
    totalItems: Number(cuenta.total), page, pageSize,
    filtros: { disciplinas: disciplinasConFotos, fechas, etiquetas, partidos, departamentales: departamentales.map(d => ({ ...d, cantidad: Number(d.cantidad) })) },
  };
}

module.exports = {
  condicionesGaleria, tablaEtiquetas, clasificacionGaleria, leerEtiquetas, leerDepartamentales, idsDepartamentales, nombresDepartamentales, opcionesPartidos, SELECT_FOTO, serializarFoto, listarFotos,
};
