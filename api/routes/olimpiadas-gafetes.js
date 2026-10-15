const express = require('express');
const mysqlConnection = require('../connection/connection');
const { generarGafetes } = require('../services/olimpiadas-gafetes');
const { verifyToken, getCabecera, esStaff, esSuperior, puedeVerInscripcion, normalizarIdPositivo, getObjectBufferFromS3, registrarHistorial, responderError } = require('../services/olimpiadas-comun');
const router = express.Router();
const SELECT_GAFETE = `SELECT i.id, i.usuario_id, i.olimpiada_id, i.departamental_id, i.estado,
  COALESCE(i.foto_archivo,u.foto_archivo) AS foto_archivo, u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido,
  d.nombre AS departamental_nombre, t.nombre AS categoria_nombre, o.nombre AS olimpiada_nombre,
  o.localidad AS olimpiada_localidad, o.fecha_inicio, o.fecha_fin
  FROM olimpiada_inscripcion i JOIN usuario u ON u.id=i.usuario_id
  JOIN olimpiada o ON o.id=i.olimpiada_id
  LEFT JOIN departamental d ON d.id=i.departamental_id
  LEFT JOIN olimpiada_disciplina_tipo t ON t.id=i.categoria_tipo_id
  WHERE i.eliminado=0 AND o.eliminado=0`;

async function enviarPdf(db, res, registros, cabecera) {
  const ids = registros.map(r => r.id);
  const [disciplinas] = await db.query(`SELECT x.inscripcion_id,d.nombre FROM olimpiada_inscripcion_disciplina x JOIN olimpiada_disciplina d ON d.id=x.disciplina_id WHERE x.inscripcion_id IN (?) ORDER BY d.nombre`, [ids]);
  registros.forEach(r => { r.disciplinas = disciplinas.filter(d => Number(d.inscripcion_id) === Number(r.id)).map(d => d.nombre); });
  const buffer = await generarGafetes(registros, { cargarFoto: async key => (await getObjectBufferFromS3(key))?.buffer });
  await registrarHistorial(db, { entidad: 'INSCRIPCION', entidad_id: ids.length === 1 ? ids[0] : null,
    olimpiada_id: registros[0].olimpiada_id, inscripcion_id: ids.length === 1 ? ids[0] : null,
    usuario_id: cabecera.id, usuario_rol: cabecera.rol, tipo_operacion: 'PDF',
    observacion: `Generación de ${ids.length} gafete(s) PDF. Inscripciones: ${ids.join(', ')}` });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="gafetes-olimpiada-${registros[0].olimpiada_id}.pdf"`, 'Cache-Control': 'private, no-store' });
  return res.send(buffer);
}

router.get('/olimpiadas/inscripciones/:id(\\d+)/gafete.pdf', verifyToken, async (req, res) => {
  try {
    const db = mysqlConnection.promise(), cabecera = getCabecera(req);
    const [rows] = await db.query(`${SELECT_GAFETE} AND i.id=?`, [req.params.id]);
    if (!rows.length) return res.status(404).json('Inscripción no encontrada');
    if (!puedeVerInscripcion(cabecera, rows[0])) return res.status(403).json('No tenés acceso a esta inscripción');
    if (rows[0].estado !== 'VALIDADO') return res.status(409).json('El gafete estará disponible cuando se apruebe la inscripción');
    return await enviarPdf(db, res, rows, cabecera);
  } catch (error) { responderError(res, error, 'No se pudo generar el gafete'); }
});

router.get('/olimpiadas/:id(\\d+)/gafetes.pdf', verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(403).json('Sólo el equipo responsable puede imprimir un lote');
    const db = mysqlConnection.promise(), params = [req.params.id];
    let sql = `${SELECT_GAFETE} AND i.olimpiada_id=? AND i.estado='VALIDADO'`;
    if (!esSuperior(cabecera)) {
      const departamento = normalizarIdPositivo(cabecera.departamental_id);
      if (!departamento) return res.status(403).json('No tenés una departamental asignada');
      sql += ' AND i.departamental_id=?'; params.push(departamento);
    }
    for (const campo of ['departamental_id', 'disciplina_id']) {
      if (req.query[campo] === undefined || req.query[campo] === '') continue;
      const id = normalizarIdPositivo(req.query[campo]);
      if (!id) return res.status(400).json('Filtro inválido');
      sql += campo === 'departamental_id' ? ' AND i.departamental_id=?' : ' AND EXISTS (SELECT 1 FROM olimpiada_inscripcion_disciplina x WHERE x.inscripcion_id=i.id AND x.disciplina_id=?)';
      params.push(id);
    }
    if (req.query.inscripcion_ids !== undefined) {
      const ids = String(req.query.inscripcion_ids).split(',').map(normalizarIdPositivo);
      if (!ids.length || ids.length > 100 || ids.some(id => !id)) return res.status(400).json('Elegí entre 1 y 100 inscripciones válidas');
      sql += ' AND i.id IN (?)'; params.push(ids);
    }
    const [rows] = await db.query(sql + ' ORDER BY d.nombre,u.apellido,u.nombre LIMIT 101', params);
    if (!rows.length) return res.status(404).json('No hay inscripciones aprobadas para estos filtros');
    if (rows.length > 100) return res.status(422).json('El lote supera 100 gafetes. Filtrá por departamental, disciplina o elegí inscripciones');
    return await enviarPdf(db, res, rows, cabecera);
  } catch (error) { responderError(res, error, 'No se pudieron generar los gafetes'); }
});

router.__test = { SELECT_GAFETE, enviarPdf };
module.exports = router;
