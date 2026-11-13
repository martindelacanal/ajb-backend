/* Equipos interdepartamentales y escudos. Se registra sobre el router de contenido y comparte sus ayudantes. */
const { verificarAccesoCompeticion, exigirEdicionVoluntario, exigirDisciplinaVoluntario, esVoluntario } = require('../security/olimpiadas-voluntarios');
const {
  verifyToken, getCabecera, esSuperior, crearErrorHttp, responderError, normalizarIds, normalizarIdPositivo, normalizarTexto,
  firmarSeguro, subirImagenOptimizada, eliminarObjetosS3Seguro, manejarUploadOlimpiadas,
} = require('../services/olimpiadas-comun');
const { listarEquipos, filtroId } = require('../services/olimpiadas-competicion');

const MIN_DEPARTAMENTALES = 2;
const MAX_DEPARTAMENTALES = 6;

module.exports = function registrarEquipos(router, helpers) {
  const { db, cargarOlimpiada, enTransaccion, historial, validarDisciplinaDeOlimpiada, validarDepartamentales, exigirSuperior, soloSuperior, idDeRuta, archivoDeSlot, aplicarEfectosCompeticion, listarEscudos } = helpers;
  const endpoint = (fn, mensaje) => async (req, res) => { try { await fn(req, res); } catch (error) { responderError(res, error, mensaje); } };
  function soloGestion(cabecera) { if (!esSuperior(cabecera) && !esVoluntario(cabecera)) throw crearErrorHttp('No autorizado', 403); }

  function leerEquipo(body) {
    const ids = normalizarIds(body?.departamental_ids);
    if (!Array.isArray(body?.departamental_ids) || !ids || ids.length < MIN_DEPARTAMENTALES || ids.length > MAX_DEPARTAMENTALES) {
      throw crearErrorHttp(`Un equipo interdepartamental reúne entre ${MIN_DEPARTAMENTALES} y ${MAX_DEPARTAMENTALES} departamentales`);
    }
    const nombre = body.nombre === undefined || body.nombre === null ? null : normalizarTexto(String(body.nombre), 160);
    return { ids, nombre };
  }

  // Sin nombre propio, el equipo se llama como sus departamentales: «Dolores + Mar del Plata».
  function nombreEquipo(nombre, departamentales, ids) {
    if (nombre) return nombre;
    const porId = new Map(departamentales.map(d => [Number(d.id), d.nombre]));
    return ids.map(id => porId.get(Number(id))).sort((a, b) => String(a).localeCompare(String(b), 'es')).join(' + ').slice(0, 160);
  }

  router.get('/olimpiadas/:id(\\d+)/equipos', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const cabecera = getCabecera(req), olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const asignadas = await exigirEdicionVoluntario({ db, cabecera, olimpiadaId });
    const disciplinaId = filtroId(req.query, 'disciplina_id');
    if (disciplinaId) await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId });
    res.set('Cache-Control', 'no-store');
    res.json(await listarEquipos(db, olimpiadaId, disciplinaId ? [disciplinaId] : asignadas));
  }, 'No se pudieron cargar los equipos'));

  const guardarEquipo = async (req, res) => {
    const cabecera = getCabecera(req); soloGestion(cabecera);
    const equipoId = req.params.equipoId ? idDeRuta(req.params.equipoId) : null;
    let actual = null;
    if (equipoId) {
      const [[fila]] = await db.query('SELECT * FROM olimpiada_equipo WHERE id = ? AND eliminado = 0', [equipoId]);
      if (!fila) throw crearErrorHttp('El equipo no existe', 404);
      actual = fila;
    }
    const olimpiadaId = actual ? actual.olimpiada_id : idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const disciplinaId = actual ? Number(actual.disciplina_id) : normalizarIdPositivo(req.body?.disciplina_id);
    if (!disciplinaId) throw crearErrorHttp('Elegí la disciplina del equipo');
    await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId, escritura: true });
    const disciplina = await validarDisciplinaDeOlimpiada(db, olimpiadaId, disciplinaId);
    const { ids, nombre } = leerEquipo(req.body || {});
    const departamentales = await validarDepartamentales(db, ids);
    const nombreFinal = nombreEquipo(nombre, departamentales, ids);
    const clave = lista => [...lista].map(Number).sort((a, b) => a - b).join('-');
    const existentes = await listarEquipos(db, olimpiadaId, [disciplinaId]);
    if (existentes.some(e => Number(e.id) !== equipoId && clave(e.departamental_ids) === clave(ids))) {
      throw crearErrorHttp(`Ya hay un equipo de ${disciplina.nombre} con esas mismas departamentales`, 409);
    }
    const id = await enTransaccion(async (connection) => {
      let entidadId = equipoId;
      const anterior = existentes.find(e => Number(e.id) === equipoId);
      if (equipoId) await connection.query('UPDATE olimpiada_equipo SET nombre = ? WHERE id = ?', [nombreFinal, equipoId]);
      else {
        const [insert] = await connection.query('INSERT INTO olimpiada_equipo (olimpiada_id, disciplina_id, nombre) VALUES (?, ?, ?)', [olimpiadaId, disciplinaId, nombreFinal]);
        entidadId = insert.insertId;
      }
      await connection.query('DELETE FROM olimpiada_equipo_departamental WHERE equipo_id = ?', [entidadId]);
      for (const departamentalId of ids) await connection.query('INSERT INTO olimpiada_equipo_departamental (equipo_id, departamental_id) VALUES (?, ?)', [entidadId, departamentalId]);
      if (equipoId) {
        // Los partidos y las medallas del equipo acompañan el cambio de nombre y de integrantes.
        await connection.query('UPDATE olimpiada_partido SET participante1 = ? WHERE equipo1_id = ? AND eliminado = 0', [nombreFinal.slice(0, 120), equipoId]);
        await connection.query('UPDATE olimpiada_partido SET participante2 = ? WHERE equipo2_id = ? AND eliminado = 0', [nombreFinal.slice(0, 120), equipoId]);
        const [medallas] = await connection.query('SELECT DISTINCT puesto, origen FROM olimpiada_medalla WHERE equipo_id = ?', [equipoId]);
        await connection.query('DELETE FROM olimpiada_medalla WHERE equipo_id = ?', [equipoId]);
        for (const medalla of medallas) {
          for (const departamentalId of ids) {
            await connection.query('INSERT IGNORE INTO olimpiada_medalla (olimpiada_id, disciplina_id, puesto, departamental_id, equipo_id, origen) VALUES (?, ?, ?, ?, ?, ?)',
              [olimpiadaId, disciplinaId, medalla.puesto, departamentalId, equipoId, medalla.origen]);
          }
        }
      }
      await historial(connection, cabecera, {
        entidad: 'EQUIPO', entidad_id: entidadId, olimpiada_id: olimpiadaId, tipo_operacion: equipoId ? 'UPDATE' : 'CREATE',
        campo_modificado: disciplina.nombre, valor_anterior: anterior ? anterior.nombre : null, valor_nuevo: nombreFinal,
      });
      if (equipoId) await aplicarEfectosCompeticion(connection, cabecera, olimpiadaId, disciplinaId);
      return entidadId;
    });
    res.status(equipoId ? 200 : 201).json({ success: true, id, message: equipoId ? 'Equipo actualizado' : `Equipo ${nombreFinal} creado`, equipo: (await listarEquipos(db, olimpiadaId, [disciplinaId])).find(e => Number(e.id) === Number(id)) || null });
  };
  router.post('/olimpiadas/:id(\\d+)/equipos', verificarAccesoCompeticion, endpoint(guardarEquipo, 'No se pudo guardar el equipo'));
  router.put('/olimpiadas/equipos/:equipoId(\\d+)', verificarAccesoCompeticion, endpoint(guardarEquipo, 'No se pudo guardar el equipo'));

  router.delete('/olimpiadas/equipos/:equipoId(\\d+)', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const cabecera = getCabecera(req); soloGestion(cabecera);
    const equipoId = idDeRuta(req.params.equipoId);
    const [[equipo]] = await db.query('SELECT * FROM olimpiada_equipo WHERE id = ? AND eliminado = 0', [equipoId]);
    if (!equipo) throw crearErrorHttp('El equipo no existe', 404);
    await cargarOlimpiada(db, equipo.olimpiada_id, cabecera);
    await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId: equipo.olimpiada_id, disciplinaId: equipo.disciplina_id, escritura: true });
    const [[uso]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM olimpiada_partido WHERE eliminado = 0 AND (equipo1_id = ? OR equipo2_id = ?)) AS partidos,
              (SELECT COUNT(*) FROM olimpiada_medalla WHERE equipo_id = ?) AS medallas`, [equipoId, equipoId, equipoId]);
    if (Number(uso.partidos)) throw crearErrorHttp('El equipo juega partidos del fixture: primero cambiá esos partidos', 409);
    if (Number(uso.medallas)) throw crearErrorHttp('El equipo figura en el medallero: primero quitalo de ahí', 409);
    await enTransaccion(async (connection) => {
      await connection.query('UPDATE olimpiada_equipo SET eliminado = 1 WHERE id = ?', [equipoId]);
      await historial(connection, cabecera, { entidad: 'EQUIPO', entidad_id: equipoId, olimpiada_id: equipo.olimpiada_id, tipo_operacion: 'DELETE', valor_anterior: equipo.nombre });
    });
    res.json({ success: true, message: 'Equipo eliminado' });
  }, 'No se pudo eliminar el equipo'));

  // ---------------------------------------------------------------------------
  // Escudos: el de cada departamental y el de los equipos interdepartamentales
  // ---------------------------------------------------------------------------
  router.get('/olimpiadas/escudos', verifyToken, endpoint(async (req, res) => {
    if (!exigirSuperior(req, res)) return;
    res.set('Cache-Control', 'no-store');
    res.json(await listarEscudos(db));
  }, 'No se pudieron cargar los escudos'));

  router.put('/olimpiadas/escudos/departamentales/:departamentalId(\\d+)', verifyToken, soloSuperior, manejarUploadOlimpiadas, endpoint(async (req, res) => {
    const cabecera = exigirSuperior(req, res);
    if (!cabecera) return;
    const departamentalId = idDeRuta(req.params.departamentalId);
    const [[departamental]] = await db.query('SELECT id, nombre, logo_archivo FROM departamental WHERE id = ?', [departamentalId]);
    if (!departamental) throw crearErrorHttp('La departamental no existe', 404);
    const archivo = archivoDeSlot(req, 'LOGO');
    if (!archivo) throw crearErrorHttp('Adjuntá la imagen del escudo');
    const imagen = await subirImagenOptimizada(archivo, `escudos/departamental_${departamentalId}`, { anchoMaximo: 512 });
    try {
      await enTransaccion(async (connection) => {
        await connection.query('UPDATE departamental SET logo_archivo = ? WHERE id = ?', [imagen.key, departamentalId]);
        await historial(connection, cabecera, { entidad: 'ESCUDO', entidad_id: departamentalId, tipo_operacion: 'UPDATE', campo_modificado: 'escudo', valor_nuevo: departamental.nombre });
      });
    } catch (error) { await eliminarObjetosS3Seguro(imagen.keys); throw error; }
    await eliminarObjetosS3Seguro([departamental.logo_archivo]);
    res.json({ success: true, message: `Escudo de ${departamental.nombre} actualizado`, logo_url: await firmarSeguro(imagen.key) });
  }, 'No se pudo actualizar el escudo'));

  router.put('/olimpiadas/escudos/interdepartamental', verifyToken, soloSuperior, manejarUploadOlimpiadas, endpoint(async (req, res) => {
    const cabecera = exigirSuperior(req, res);
    if (!cabecera) return;
    const archivo = archivoDeSlot(req, 'LOGO');
    if (!archivo) throw crearErrorHttp('Adjuntá la imagen del escudo');
    const imagen = await subirImagenOptimizada(archivo, 'escudos/interdepartamental', { anchoMaximo: 512 });
    let anterior = null;
    try {
      await enTransaccion(async (connection) => {
        await connection.query('INSERT INTO olimpiada_config (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id');
        const [[config]] = await connection.query('SELECT logo_interdepartamental_archivo FROM olimpiada_config WHERE id = 1 FOR UPDATE');
        anterior = config?.logo_interdepartamental_archivo || null;
        await connection.query('UPDATE olimpiada_config SET logo_interdepartamental_archivo = ? WHERE id = 1', [imagen.key]);
        await historial(connection, cabecera, { entidad: 'ESCUDO', entidad_id: 0, tipo_operacion: 'UPDATE', campo_modificado: 'escudo', valor_nuevo: 'Equipos interdepartamentales' });
      });
    } catch (error) { await eliminarObjetosS3Seguro(imagen.keys); throw error; }
    await eliminarObjetosS3Seguro([anterior]);
    res.json({ success: true, message: 'Escudo de los equipos interdepartamentales actualizado', logo_url: await firmarSeguro(imagen.key) });
  }, 'No se pudo actualizar el escudo'));

  // Quitar el escudo propio vuelve al que trae el sistema.
  router.delete('/olimpiadas/escudos/interdepartamental', verifyToken, endpoint(async (req, res) => {
    const cabecera = exigirSuperior(req, res);
    if (!cabecera) return;
    const [[config]] = await db.query('SELECT logo_interdepartamental_archivo FROM olimpiada_config WHERE id = 1');
    await enTransaccion(async (connection) => {
      await connection.query('UPDATE olimpiada_config SET logo_interdepartamental_archivo = NULL WHERE id = 1');
      await historial(connection, cabecera, { entidad: 'ESCUDO', entidad_id: 0, tipo_operacion: 'DELETE', campo_modificado: 'escudo', valor_anterior: 'Equipos interdepartamentales' });
    });
    await eliminarObjetosS3Seguro([config?.logo_interdepartamental_archivo]);
    res.json({ success: true, message: 'Los equipos interdepartamentales vuelven a usar el escudo del sistema' });
  }, 'No se pudo quitar el escudo'));
};
