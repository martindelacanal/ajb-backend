/* Public Olympics use explicit projections and an edition publication gate.
 * No request reaches private registration, medical, payment or volunteer data. */
const express = require('express');
const db = require('../connection/connection').promise();
const { normalizarFechaCivil } = require('../services/valores-dominio');
const { crearErrorHttp, responderError, obtenerOlimpiada, firmarSeguro, fechaHoyBuenosAires, estaVentanaInscripcionAbierta, calcularGanadores } = require('../services/olimpiadas-comun');
const { partidoPublico, calcularPosiciones, listarTorneos, filtroId } = require('../services/olimpiadas-competicion');
const lectura = require('./olimpiadas-contenido').lecturasPublicas;
const router = express.Router();

function edicionPublica(o) {
  return { id: o.id, nombre: o.nombre, edicion: o.edicion, localidad: o.localidad, descripcion: o.descripcion,
    fecha_inicio: o.fecha_inicio, fecha_fin: o.fecha_fin, fecha_inicio_inscripcion: o.fecha_inicio_inscripcion,
    fecha_fin_inscripcion: o.fecha_fin_inscripcion, estado: lectura.estadoEdicion(o), inscripcion_abierta: estaVentanaInscripcionAbierta(o),
    valor_bono: Number(o.valor_bono) || 0, bonos_afiliado: Number(o.bonos_afiliado) || 0,
    fecha_sorteo: o.fecha_sorteo, sorteo_publicado: Number(o.sorteo_publicado) || 0 };
}

const endpoint = (fn, obtener = obtenerOlimpiada) => async (req, res) => {
  try {
    const olimpiada = await obtener(db, Number(req.params.id));
    if (!olimpiada || olimpiada.habilitado !== 'Y' || Number(olimpiada.publicada_publico) !== 1) throw crearErrorHttp('La olimpiada no está publicada', 404);
    res.set('Cache-Control', 'no-store');
    res.json(await fn(req, olimpiada));
  } catch (error) { responderError(res, error, 'No se pudo cargar la olimpiada pública'); }
};
const ruta = (sufijo, fn) => router.get(`/olimpiadas/publico/:id(\\d+)/${sufijo}`, endpoint(fn));

router.get('/olimpiadas/publico/ediciones', async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT o.id, o.nombre, o.edicion, o.localidad, o.descripcion, o.fecha_inicio, o.fecha_fin,
      o.fecha_inicio_inscripcion, o.fecha_fin_inscripcion, o.valor_bono, o.bonos_afiliado, o.fecha_sorteo, o.sorteo_publicado,
      (SELECT COUNT(*) FROM olimpiada_foto f WHERE f.olimpiada_id = o.id AND f.eliminado = 0) AS fotos,
      (SELECT COUNT(*) FROM olimpiada_novedad n WHERE n.olimpiada_id = o.id AND n.eliminado = 0 AND n.publicada = 1 AND n.fecha_publicacion <= NOW()) AS novedades
      FROM olimpiada o WHERE o.eliminado = 0 AND o.habilitado = 'Y' AND o.publicada_publico = 1 ORDER BY o.fecha_inicio DESC, o.id DESC`);
    res.set('Cache-Control', 'no-store');
    res.json(rows.map(o => ({ ...edicionPublica(o), fotos: Number(o.fotos), novedades: Number(o.novedades), mi_inscripcion: null })));
  } catch (error) { responderError(res, error, 'No se pudieron cargar las ediciones públicas'); }
});

ruta('portal', async (req, o) => {
  const conteos = {};
  const especificaciones = {
    novedades: ['olimpiada_novedad', 'eliminado = 0 AND publicada = 1 AND fecha_publicacion <= NOW()'],
    eventos: ['olimpiada_evento', 'eliminado = 0'], partidos: ['olimpiada_partido', 'eliminado = 0'],
    en_vivo: ['olimpiada_partido', "eliminado = 0 AND estado = 'EN_JUEGO'"], fotos: ['olimpiada_foto', 'eliminado = 0'],
    medallas: ['olimpiada_medalla', '1 = 1'], sedes: ['olimpiada_sede', "eliminado = 0 AND tipo <> 'HOTEL'"],
    hoteles: ['olimpiada_sede', "eliminado = 0 AND tipo = 'HOTEL'"], contactos: ['olimpiada_contacto', 'eliminado = 0'],
    premios: ['olimpiada_premio', '1 = 1'], enlaces: ['olimpiada_enlace', 'eliminado = 0'],
    secciones_reglamento: ['olimpiada_seccion', "eliminado = 0 AND visible = 1 AND ubicacion = 'REGLAMENTO'"],
  };
  const sql = Object.entries(especificaciones).map(([nombre, [tabla, condicion]]) => `(SELECT COUNT(*) FROM ${tabla} WHERE olimpiada_id = ? AND ${condicion}) AS ${nombre}`).join(', ');
  const [[counts]] = await db.query(`SELECT ${sql}`, Object.keys(especificaciones).map(() => o.id));
  for (const nombre of Object.keys(especificaciones)) conteos[nombre] = Number(counts[nombre]) || 0;
  const [videos] = await db.query("SELECT id, titulo, url FROM olimpiada_enlace WHERE olimpiada_id = ? AND eliminado = 0 AND tipo = 'VIDEOS' ORDER BY orden, id", [o.id]);
  return { olimpiada: { ...edicionPublica(o), videos }, conteos, mi_inscripcion: null, hoteles_mi_departamental: [], departamental_id: null };
});

async function partidosFiltrados(req, o) {
  const condiciones = ['p.olimpiada_id = ?'], params = [o.id];
  for (const campo of ['disciplina_id', 'torneo_id', 'lugar_id']) { const id = filtroId(req.query, campo); if (id) { condiciones.push(`p.${campo} = ?`); params.push(id); } }
  return lectura.consultarPartidos(db, { condiciones, params });
}
async function conLogos(tabla) {
  if (!tabla.length) return tabla;
  const [rows] = await db.query('SELECT id, logo_archivo FROM departamental WHERE id IN (?)', [tabla.map(d => d.departamental_id)]);
  const logos = new Map(await Promise.all(rows.map(async d => [Number(d.id), await firmarSeguro(d.logo_archivo)])));
  return tabla.map(d => ({ ...d, logo_url: logos.get(Number(d.departamental_id)) || null }));
}
ruta('fixture', async (req, o) => {
  const [disciplinas, partidos, torneos] = await Promise.all([lectura.listarDisciplinasFixture(db, o.id), partidosFiltrados(req, o), listarTorneos(db, o.id)]);
  return { olimpiada: edicionPublica(o), puede_editar: false, disciplinas, partidos: partidos.map(partidoPublico), torneos,
    posiciones: await conLogos(calcularPosiciones(partidos)) };
});
ruta('torneos', (req, o) => listarTorneos(db, o.id, filtroId(req.query, 'disciplina_id') ? [filtroId(req.query, 'disciplina_id')] : null));
ruta('posiciones', async (req, o) => ({ tabla: await conLogos(calcularPosiciones(await partidosFiltrados(req, o))), criterio: 'Victoria 3 puntos · empate 1 punto' }));
ruta('medallero', async (req, o) => { const medallero = await lectura.armarMedallero(db, o); return { ...medallero, tabla: await conLogos(medallero.tabla) }; });
ruta('en-vivo', async (req, o) => {
  const partidos = await partidosFiltrados(req, o), hoy = fechaHoyBuenosAires();
  return { actualizado: new Date().toISOString(), en_juego: partidos.filter(p => p.estado === 'EN_JUEGO').map(partidoPublico),
    recientes: partidos.filter(p => p.estado === 'FINALIZADO').sort((a, b) => new Date(b.fecha_modificacion) - new Date(a.fecha_modificacion)).slice(0, 20).map(partidoPublico),
    proximos: partidos.filter(p => p.estado === 'PROGRAMADO' && normalizarFechaCivil(p.fecha) >= hoy).slice(0, 20).map(partidoPublico) };
});
ruta('novedades', async (req, o) => {
  const [rows] = await db.query(`SELECT id, titulo, cuerpo, imagen_archivo, fijada, fecha_publicacion, fecha_modificacion FROM olimpiada_novedad
    WHERE olimpiada_id = ? AND eliminado = 0 AND publicada = 1 AND fecha_publicacion <= NOW() ORDER BY fijada DESC, fecha_publicacion DESC, id DESC`, [o.id]);
  return Promise.all(rows.map(async ({ imagen_archivo, ...n }) => ({ ...n, olimpiada_id: o.id, publicada: 1, imagen_url: await firmarSeguro(imagen_archivo), imagen_ancho: null, imagen_alto: null })));
});
ruta('eventos', async (req, o) => {
  const tipo = String(req.query.tipo || '').toUpperCase();
  if (tipo && !['GENERAL', 'ACTIVIDAD'].includes(tipo)) throw crearErrorHttp('El tipo de actividad es inválido');
  const [rows] = await db.query(`${lectura.SELECT_EVENTO} WHERE e.olimpiada_id = ? AND e.eliminado = 0 ${tipo ? 'AND e.tipo = ?' : ''} ORDER BY e.fecha, e.hora_inicio IS NULL, e.hora_inicio, e.orden, e.id`, tipo ? [o.id, tipo] : [o.id]);
  return Promise.all(rows.map(lectura.serializarEvento));
});
ruta('sedes', (req, o) => lectura.listarSedes(db, o.id));
ruta('contactos', async (req, o) => {
  const [rows] = await db.query('SELECT id, grupo, nombre, cargo, telefono, email, orden FROM olimpiada_contacto WHERE olimpiada_id = ? AND eliminado = 0 ORDER BY grupo, orden, id', [o.id]);
  return rows;
});
ruta('secciones', async (req, o) => {
  const ubicacion = String(req.query.ubicacion || '').toUpperCase();
  if (ubicacion && !['INFO', 'REGLAMENTO', 'BONOS', 'DATOS_UTILES'].includes(ubicacion)) throw crearErrorHttp('La ubicación es inválida');
  const [rows] = await db.query(`SELECT id, clave, ubicacion, titulo, contenido, orden, visible FROM olimpiada_seccion
    WHERE olimpiada_id = ? AND eliminado = 0 AND visible = 1 ${ubicacion ? 'AND ubicacion = ?' : ''} ORDER BY orden, id`, ubicacion ? [o.id, ubicacion] : [o.id]);
  return rows;
});
ruta('enlaces', async (req, o) => { const [rows] = await db.query('SELECT id, tipo, titulo, url, descripcion, orden FROM olimpiada_enlace WHERE olimpiada_id = ? AND eliminado = 0 ORDER BY orden, id', [o.id]); return rows; });
ruta('fotos', async (req, o) => {
  const page = filtroId(req.query, 'page') || 1, pageSize = filtroId(req.query, 'pageSize') || 24;
  if (page > 100000 || pageSize > 60) throw crearErrorHttp('La paginación es inválida');
  const condiciones = ['f.olimpiada_id = ?', 'f.eliminado = 0'], params = [o.id];
  const disciplina = filtroId(req.query, 'disciplina_id');
  if (disciplina) { condiciones.push('f.disciplina_id = ?'); params.push(disciplina); }
  if (req.query.fecha) { const fecha = normalizarFechaCivil(req.query.fecha); if (!fecha) throw crearErrorHttp('La fecha es inválida'); condiciones.push('f.fecha = ?'); params.push(fecha); }
  if (req.query.etiqueta) { condiciones.push('f.etiqueta = ?'); params.push(String(req.query.etiqueta).slice(0, 60)); }
  const [[cuenta]] = await db.query(`SELECT COUNT(*) AS total FROM olimpiada_foto f WHERE ${condiciones.join(' AND ')}`, params);
  const [rows] = await db.query(`${lectura.SELECT_FOTO} WHERE ${condiciones.join(' AND ')} ORDER BY f.fecha DESC, f.orden, f.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  const [[disciplinas], [fechas], [etiquetas]] = await Promise.all([
    db.query('SELECT d.id, d.nombre, COUNT(*) AS cantidad FROM olimpiada_foto f INNER JOIN olimpiada_disciplina d ON d.id = f.disciplina_id WHERE f.olimpiada_id = ? AND f.eliminado = 0 GROUP BY d.id, d.nombre ORDER BY d.nombre', [o.id]),
    db.query('SELECT fecha, COUNT(*) AS cantidad FROM olimpiada_foto WHERE olimpiada_id = ? AND eliminado = 0 AND fecha IS NOT NULL GROUP BY fecha ORDER BY fecha DESC', [o.id]),
    db.query('SELECT etiqueta, COUNT(*) AS cantidad FROM olimpiada_foto WHERE olimpiada_id = ? AND eliminado = 0 AND etiqueta IS NOT NULL GROUP BY etiqueta ORDER BY etiqueta', [o.id]),
  ]);
  return { results: await Promise.all(rows.map(lectura.serializarFoto)), totalItems: Number(cuenta.total), page, pageSize, filtros: { disciplinas, fechas, etiquetas } };
});
ruta('bonos/reglas', async (req, o) => {
  const [tramos] = await db.query('SELECT id, edad_desde, edad_hasta, bonos, etiqueta, orden FROM olimpiada_bono_tramo WHERE olimpiada_id = ? ORDER BY orden, edad_desde', [o.id]);
  return require('./olimpiadas-bonos').__test.armarReglas(o, tramos);
});
ruta('premios', async (req, o) => {
  const [premios] = await db.query('SELECT id, orden, descripcion, sorteo, numero_ganador FROM olimpiada_premio WHERE olimpiada_id = ? ORDER BY orden, id', [o.id]);
  const publicado = Number(o.sorteo_publicado) === 1;
  const numeros = [...new Set(premios.filter(p => publicado && p.numero_ganador != null).map(p => Number(p.numero_ganador)))];
  const [vendidos] = numeros.length ? await db.query('SELECT numero FROM olimpiada_bono WHERE olimpiada_id = ? AND numero IN (?)', [o.id, numeros]) : [[]];
  const resultados = calcularGanadores(premios.map(p => ({ ...p, numero_ganador: publicado ? p.numero_ganador : null })), new Map(vendidos.map(b => [Number(b.numero), true])));
  return { fecha_sorteo: o.fecha_sorteo, sorteo_detalle: o.sorteo_detalle, sorteo_publicado: publicado ? 1 : 0, valor_bono: Number(o.valor_bono) || 0,
    premios: resultados.map(({ bono, ...p }) => ({ ...p,
      numero_texto: publicado && p.numero_ganador != null ? String(p.numero_ganador).padStart(String(o.bono_numero_hasta || 9999).length, '0') : null,
      ganador: null })) };
});

router.__test = { edicionPublica, endpoint };
module.exports = router;
