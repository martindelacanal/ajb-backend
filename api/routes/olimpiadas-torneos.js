/* Registers competition management on the content router, sharing its validation and audit helpers. */
const { verificarAccesoCompeticion, exigirEdicionVoluntario, exigirDisciplinaVoluntario, esVoluntario } = require('../security/olimpiadas-voluntarios');
const { getCabecera, esSuperior, crearErrorHttp, responderError, normalizarIds, normalizarIdPositivo, firmarSeguro } = require('../services/olimpiadas-comun');
const { calcularPosiciones, listarTorneos, filtroId } = require('../services/olimpiadas-competicion');

module.exports = function registrarTorneos(router, helpers) {
  const { db, cargarOlimpiada, enTransaccion, historial, historialCambios, leerTexto, leerIdOpcional, leerEnum, leerEntero, leerUrl, validarDisciplinaDeOlimpiada, consultarPartidos, bloquearSinCambios } = helpers;
  const idRuta = valor => { const id = normalizarIdPositivo(valor); if (!id) throw crearErrorHttp('ID inválido'); return id; };
  function soloGestion(cabecera) { if (!esSuperior(cabecera) && !esVoluntario(cabecera)) throw crearErrorHttp('No autorizado', 403); }
  function soloSuperior(cabecera) { if (!esSuperior(cabecera)) throw crearErrorHttp('No autorizado', 403); }
  const endpoint = fn => async (req, res) => { try { await fn(req, res); } catch (error) { responderError(res, error, 'No se pudo completar la operación del torneo'); } };

  async function catalogos(req) {
    const cabecera = getCabecera(req);
    soloGestion(cabecera);
    const olimpiadaId = idRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const asignadas = await exigirEdicionVoluntario({ db, cabecera, olimpiadaId });
    const disciplinaId = filtroId(req.query, 'disciplina_id');
    if (disciplinaId) await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId });
    const condiciones = ["i.olimpiada_id = ?", "i.estado = 'VALIDADO'", 'i.eliminado = 0'];
    const params = [olimpiadaId];
    if (asignadas) { condiciones.push('d.disciplina_id IN (?)'); params.push(asignadas.length ? asignadas : [0]); }
    if (disciplinaId) { condiciones.push('d.disciplina_id = ?'); params.push(disciplinaId); }
    const [[lugares], [instancias], [departamentales], [participantes], [sedes]] = await Promise.all([
      db.query('SELECT id, nombre, predio, direccion, url_mapa, descripcion FROM olimpiada_lugar WHERE eliminado = 0 ORDER BY predio, nombre'),
      db.query('SELECT id, nombre, orden FROM olimpiada_instancia WHERE eliminado = 0 ORDER BY orden, nombre'),
      db.query('SELECT id, nombre, logo_archivo FROM departamental ORDER BY nombre'),
      db.query(`SELECT i.id, u.nombre, u.apellido, i.departamental_id, dep.nombre AS departamental_nombre, d.disciplina_id
        FROM olimpiada_inscripcion i INNER JOIN usuario u ON u.id = i.usuario_id
        INNER JOIN olimpiada_inscripcion_disciplina d ON d.inscripcion_id = i.id
        LEFT JOIN departamental dep ON dep.id = i.departamental_id WHERE ${condiciones.join(' AND ')} ORDER BY u.apellido, u.nombre`, params),
      db.query("SELECT id, nombre, direccion FROM olimpiada_sede WHERE olimpiada_id = ? AND eliminado = 0 AND tipo <> 'HOTEL' ORDER BY nombre", [olimpiadaId]),
    ]);
    return { lugares, instancias, participantes, sedes, departamentales: await Promise.all(departamentales.map(async ({ logo_archivo, ...dep }) => ({ ...dep, logo_url: await firmarSeguro(logo_archivo) }))) };
  }

  router.get('/olimpiadas/:id(\\d+)/competicion/catalogos', verificarAccesoCompeticion, endpoint(async (req, res) => res.json(await catalogos(req))));

  for (const tipo of ['lugares', 'instancias']) {
    const tabla = tipo === 'lugares' ? 'olimpiada_lugar' : 'olimpiada_instancia';
    router.get(`/olimpiadas/competicion/${tipo}`, verificarAccesoCompeticion, endpoint(async (req, res) => {
      soloSuperior(getCabecera(req));
      const q = String(req.query.q || '').slice(0, 160);
      const [rows] = await db.query(`SELECT * FROM ${tabla} WHERE eliminado = 0 AND nombre LIKE ? ORDER BY nombre`, [`%${q}%`]);
      res.json(rows);
    }));
    const guardar = async (req, res) => {
      const cabecera = getCabecera(req); soloSuperior(cabecera);
      const id = req.params.catalogoId ? idRuta(req.params.catalogoId) : null;
      let actual = {};
      if (id) { const [[fila]] = await db.query(`SELECT * FROM ${tabla} WHERE id = ? AND eliminado = 0`, [id]); if (!fila) throw crearErrorHttp('El registro no existe', 404); actual = fila; }
      const body = req.body || {};
      const datos = { nombre: leerTexto(body, 'nombre', actual, { requerido: true, maximo: tipo === 'lugares' ? 160 : 60 }) };
      if (tipo === 'lugares') Object.assign(datos, { predio: leerTexto(body, 'predio', actual, { maximo: 160 }), direccion: leerTexto(body, 'direccion', actual, { maximo: 200 }), url_mapa: leerUrl(body, 'url_mapa', actual, { maximo: 400 }), descripcion: leerTexto(body, 'descripcion', actual, { maximo: 400 }) });
      else datos.orden = leerEntero(body, 'orden', actual);
      const nuevoId = await enTransaccion(async connection => {
        let entidadId = id;
        if (id) await connection.query(`UPDATE ${tabla} SET ? WHERE id = ?`, [datos, id]);
        else { const [insert] = await connection.query(`INSERT INTO ${tabla} SET ?`, [datos]); entidadId = insert.insertId; }
        const base = { entidad: tipo === 'lugares' ? 'LUGAR' : 'INSTANCIA', entidad_id: entidadId };
        if (id) await historialCambios(connection, cabecera, base, actual, datos, Object.keys(datos));
        else await historial(connection, cabecera, { ...base, tipo_operacion: 'CREATE', valor_nuevo: datos.nombre });
        return entidadId;
      });
      res.status(id ? 200 : 201).json({ success: true, id: nuevoId, message: 'Catálogo guardado' });
    };
    router.post(`/olimpiadas/competicion/${tipo}`, verificarAccesoCompeticion, endpoint(guardar));
    router.put(`/olimpiadas/competicion/${tipo}/:catalogoId(\\d+)`, verificarAccesoCompeticion, endpoint(guardar));
  }

  router.get('/olimpiadas/:id(\\d+)/torneos', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const cabecera = getCabecera(req), olimpiadaId = idRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const asignadas = await exigirEdicionVoluntario({ db, cabecera, olimpiadaId });
    const disciplinaId = filtroId(req.query, 'disciplina_id');
    if (disciplinaId) await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId });
    res.json(await listarTorneos(db, olimpiadaId, disciplinaId ? [disciplinaId] : asignadas));
  }));

  const guardarTorneo = async (req, res) => {
    const cabecera = getCabecera(req); soloGestion(cabecera);
    const id = req.params.torneoId ? idRuta(req.params.torneoId) : null;
    let actual = {};
    if (id) { const [[fila]] = await db.query('SELECT * FROM olimpiada_torneo WHERE id = ? AND eliminado = 0', [id]); if (!fila) throw crearErrorHttp('El torneo no existe', 404); actual = fila; }
    const olimpiadaId = id ? actual.olimpiada_id : idRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const datos = {
      disciplina_id: leerIdOpcional(body, 'disciplina_id', actual), nombre: leerTexto(body, 'nombre', actual, { requerido: true, maximo: 160 }),
      formato: leerEnum(body, 'formato', actual, ['ELIMINACION', 'GRUPOS', 'LIGA', 'MIXTO'], { porDefecto: 'ELIMINACION' }),
      descripcion: leerTexto(body, 'descripcion', actual, { maximo: 1000 }),
    };
    if (!datos.disciplina_id) throw crearErrorHttp('Elegí una disciplina');
    if (id) await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId: actual.disciplina_id, escritura: true });
    await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId: datos.disciplina_id, escritura: true });
    await validarDisciplinaDeOlimpiada(db, olimpiadaId, datos.disciplina_id);
    let instanciaIds = null;
    if (body.instancia_ids !== undefined) { instanciaIds = normalizarIds(body.instancia_ids); if (!instanciaIds || !instanciaIds.length || instanciaIds.length > 32) throw crearErrorHttp('Elegí entre 1 y 32 instancias'); }
    const nuevoId = await enTransaccion(async connection => {
      if (id) await bloquearSinCambios(connection, 'olimpiada_torneo', actual);
      if (id && Number(actual.disciplina_id) !== Number(datos.disciplina_id)) {
        const [[cuenta]] = await connection.query('SELECT COUNT(*) AS cantidad FROM olimpiada_partido WHERE torneo_id = ? AND eliminado = 0', [id]);
        if (Number(cuenta.cantidad)) throw crearErrorHttp('Un torneo con partidos no puede cambiar de disciplina');
      }
      let entidadId = id;
      if (id) await connection.query('UPDATE olimpiada_torneo SET ? WHERE id = ?', [datos, id]);
      else { const [insert] = await connection.query('INSERT INTO olimpiada_torneo SET ?', [{ olimpiada_id: olimpiadaId, ...datos }]); entidadId = insert.insertId; }
      const base = { entidad: 'TORNEO', entidad_id: entidadId, olimpiada_id: olimpiadaId };
      if (id) await historialCambios(connection, cabecera, base, actual, datos, Object.keys(datos));
      else await historial(connection, cabecera, { ...base, tipo_operacion: 'CREATE', valor_nuevo: datos.nombre });
      if (instanciaIds) {
        const [validas] = await connection.query('SELECT id FROM olimpiada_instancia WHERE id IN (?) AND eliminado = 0', [instanciaIds]);
        if (validas.length !== instanciaIds.length) throw crearErrorHttp('Una de las instancias no existe');
        const [anteriores] = await connection.query('SELECT instancia_id FROM olimpiada_torneo_instancia WHERE torneo_id = ? ORDER BY orden', [entidadId]);
        const [enUso] = await connection.query('SELECT DISTINCT instancia_id FROM olimpiada_partido WHERE torneo_id = ? AND eliminado = 0 AND instancia_id IS NOT NULL', [entidadId]);
        if (enUso.some(f => !instanciaIds.includes(Number(f.instancia_id)))) throw crearErrorHttp('No se puede quitar una instancia con partidos');
        await connection.query('DELETE FROM olimpiada_torneo_instancia WHERE torneo_id = ?', [entidadId]);
        for (let orden = 0; orden < instanciaIds.length; orden++) await connection.query('INSERT INTO olimpiada_torneo_instancia (torneo_id, instancia_id, orden) VALUES (?, ?, ?)', [entidadId, instanciaIds[orden], orden]);
        await historial(connection, cabecera, { ...base, tipo_operacion: 'UPDATE', campo_modificado: 'instancias', valor_anterior: anteriores.map(i => i.instancia_id).join(', '), valor_nuevo: instanciaIds.join(', ') });
      }
      return entidadId;
    });
    res.status(id ? 200 : 201).json({ success: true, id: nuevoId, message: 'Torneo guardado' });
  };
  router.post('/olimpiadas/:id(\\d+)/torneos', verificarAccesoCompeticion, endpoint(guardarTorneo));
  router.put('/olimpiadas/torneos/:torneoId(\\d+)', verificarAccesoCompeticion, endpoint(guardarTorneo));
  router.delete('/olimpiadas/torneos/:torneoId(\\d+)', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const cabecera = getCabecera(req); soloGestion(cabecera);
    const id = idRuta(req.params.torneoId);
    const [[torneo]] = await db.query('SELECT * FROM olimpiada_torneo WHERE id = ? AND eliminado = 0', [id]);
    if (!torneo) throw crearErrorHttp('El torneo no existe', 404);
    await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId: torneo.olimpiada_id, disciplinaId: torneo.disciplina_id, escritura: true });
    await enTransaccion(async connection => {
      await bloquearSinCambios(connection, 'olimpiada_torneo', torneo);
      const [[cuenta]] = await connection.query('SELECT COUNT(*) AS cantidad FROM olimpiada_partido WHERE torneo_id = ? AND eliminado = 0', [id]);
      if (Number(cuenta.cantidad)) throw crearErrorHttp('Primero quitá los partidos del torneo');
      await connection.query('UPDATE olimpiada_torneo SET eliminado = 1 WHERE id = ?', [id]);
      await historial(connection, cabecera, { entidad: 'TORNEO', entidad_id: id, olimpiada_id: torneo.olimpiada_id, tipo_operacion: 'DELETE', valor_anterior: torneo.nombre });
    });
    res.json({ success: true, message: 'Torneo eliminado' });
  }));

  router.get('/olimpiadas/:id(\\d+)/posiciones', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const cabecera = getCabecera(req), olimpiadaId = idRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const asignadas = await exigirEdicionVoluntario({ db, cabecera, olimpiadaId });
    const condiciones = ['p.olimpiada_id = ?'], params = [olimpiadaId];
    if (asignadas) { condiciones.push('p.disciplina_id IN (?)'); params.push(asignadas.length ? asignadas : [0]); }
    for (const campo of ['disciplina_id', 'torneo_id']) { const id = filtroId(req.query, campo); if (id) { if (campo === 'disciplina_id') await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId: id }); condiciones.push(`p.${campo} = ?`); params.push(id); } }
    res.set('Cache-Control', 'no-store');
    res.json({ tabla: calcularPosiciones(await consultarPartidos(db, { condiciones, params })), criterio: 'Victoria 3 puntos · empate 1 punto' });
  }));

  router.get('/olimpiadas/:id(\\d+)/competicion/historial', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const cabecera = getCabecera(req); soloGestion(cabecera);
    const olimpiadaId = idRuta(req.params.id), asignadas = await exigirEdicionVoluntario({ db, cabecera, olimpiadaId });
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const page = filtroId(req.query, 'page') || 1;
    if (page > 100000) throw crearErrorHttp('La página es inválida');
    const condiciones = ["h.olimpiada_id = ?", "h.entidad IN ('PARTIDO', 'TORNEO', 'DISCIPLINA_INFO')"], params = [olimpiadaId];
    const disciplinaId = filtroId(req.query, 'disciplina_id');
    if (disciplinaId) await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId });
    if (asignadas || disciplinaId) { condiciones.push('COALESCE(p.disciplina_id, t.disciplina_id, IF(h.entidad = \'DISCIPLINA_INFO\', h.entidad_id, NULL)) IN (?)'); params.push(disciplinaId ? [disciplinaId] : asignadas.length ? asignadas : [0]); }
    const from = `FROM olimpiada_historial h LEFT JOIN usuario u ON u.id = h.usuario_id LEFT JOIN olimpiada_partido p ON h.entidad = 'PARTIDO' AND p.id = h.entidad_id LEFT JOIN olimpiada_torneo t ON h.entidad = 'TORNEO' AND t.id = h.entidad_id WHERE ${condiciones.join(' AND ')}`;
    const [[count]] = await db.query(`SELECT COUNT(*) AS cantidad ${from}`, params);
    const [rows] = await db.query(`SELECT h.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido ${from} ORDER BY h.id DESC LIMIT 50 OFFSET ?`, [...params, (page - 1) * 50]);
    res.json({ results: rows, totalItems: Number(count.cantidad), page, pageSize: 50 });
  }));
};
