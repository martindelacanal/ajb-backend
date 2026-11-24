const { verifyToken, getCabecera, crearErrorHttp, responderError } = require('../services/olimpiadas-comun');

module.exports = function registrarCanchas(router, { enTransaccion, historial, leerTexto, soloSuperior, idDeRuta }) {
  const ruta = '/olimpiadas/sedes/:sedeId(\\d+)/canchas';
  const gestionar = operacion => async (req, res) => {
    try {
      const sedeId = idDeRuta(req.params.sedeId);
      const canchaId = req.params.canchaId ? idDeRuta(req.params.canchaId) : null;
      const id = await enTransaccion(async connection => {
        const [[sede]] = await connection.query(
          'SELECT id, olimpiada_id, tipo FROM olimpiada_sede WHERE id = ? AND eliminado = 0 FOR UPDATE', [sedeId]);
        if (!sede) throw crearErrorHttp('La sede no existe', 404);
        if (sede.tipo === 'HOTEL') throw crearErrorHttp('Elegí una sede deportiva u otra sede para gestionar sus canchas');
        let cancha;
        if (canchaId) {
          [[cancha]] = await connection.query(
            'SELECT id, nombre FROM olimpiada_lugar WHERE id = ? AND sede_id = ? AND eliminado = 0 FOR UPDATE', [canchaId, sedeId]);
          if (!cancha) throw crearErrorHttp('La cancha no pertenece a esta sede', 404);
        }
        const auditoria = { entidad: 'LUGAR', entidad_id: canchaId, olimpiada_id: sede.olimpiada_id, tipo_operacion: operacion };
        if (operacion === 'DELETE') {
          // Los encuentros conservan su sede general incluso si se retira una cancha.
          await connection.query('UPDATE olimpiada_partido SET lugar_id = NULL, sede_id = ? WHERE lugar_id = ? AND olimpiada_id = ?', [sedeId, canchaId, sede.olimpiada_id]);
          await connection.query('UPDATE olimpiada_lugar SET eliminado = 1 WHERE id = ?', [canchaId]);
          auditoria.valor_anterior = cancha.nombre;
        } else {
          const nombre = leerTexto(req.body || {}, 'nombre', cancha || {}, { maximo: 160, requerido: true, etiqueta: 'el nombre de la cancha' });
          const [[duplicada]] = await connection.query(
            'SELECT id FROM olimpiada_lugar WHERE sede_id = ? AND nombre = ? AND eliminado = 0 AND id <> ? LIMIT 1', [sedeId, nombre, canchaId || 0]);
          if (duplicada) throw crearErrorHttp('Ya existe una cancha con ese nombre en esta sede', 409);
          if (cancha) {
            await connection.query('UPDATE olimpiada_lugar SET nombre = ? WHERE id = ?', [nombre, canchaId]);
            auditoria.valor_anterior = cancha.nombre;
            auditoria.campo_modificado = 'nombre';
          } else {
            const [insert] = await connection.query('INSERT INTO olimpiada_lugar (sede_id, nombre) VALUES (?, ?)', [sedeId, nombre]);
            auditoria.entidad_id = insert.insertId;
          }
          auditoria.valor_nuevo = nombre;
        }
        await historial(connection, getCabecera(req), auditoria);
        return auditoria.entidad_id;
      });
      res.status(operacion === 'CREATE' ? 201 : 200).json({ success: true, id });
    } catch (error) { responderError(res, error, 'No se pudo guardar el cambio en la cancha'); }
  };
  router.post(ruta, verifyToken, soloSuperior, gestionar('CREATE'));
  router.put(ruta + '/:canchaId(\\d+)', verifyToken, soloSuperior, gestionar('UPDATE'));
  router.delete(ruta + '/:canchaId(\\d+)', verifyToken, soloSuperior, gestionar('DELETE'));
};
