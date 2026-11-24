/**
 * Disciplinas que no se juegan 1 contra 1: categorías por tiempo (maratón, natación), pesca
 * (piezas y peso) y mesas de póker. Se registra sobre el router de contenido y comparte sus ayudantes.
 *
 * Lectura: cualquier sesión (el veedor, sólo sus disciplinas). Escritura: administración
 * provincial y veedores de la disciplina mientras su carga está abierta. Cada cambio deja historial.
 */
const { verificarAccesoCompeticion, exigirEdicionVoluntario, exigirDisciplinaVoluntario, esVoluntario, puedeEditarEdicion } = require('../security/olimpiadas-voluntarios');
const { getCabecera, esSuperior, crearErrorHttp, responderError, normalizarIdPositivo, firmarSeguro } = require('../services/olimpiadas-comun');
const { filtroId } = require('../services/olimpiadas-competicion');
const P = require('../services/olimpiadas-pruebas');

const SELECT_PRUEBA = `SELECT id, olimpiada_id, disciplina_id, nombre, descripcion, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha,
  TIME_FORMAT(hora_inicio, '%H:%i:%s') AS hora_inicio, estado, orden FROM olimpiada_prueba`;
const SELECT_PARTICIPANTE = `SELECT p.id, p.olimpiada_id, p.disciplina_id, p.prueba_id, p.nombre, p.departamental_id, dep.nombre AS departamental_nombre,
  p.inscripcion_id, p.tiempo_ms, p.piezas, p.peso_gramos, p.puesto, p.orden
  FROM olimpiada_prueba_participante p LEFT JOIN departamental dep ON dep.id = p.departamental_id`;
const NOMBRES_ESTADO = { PROGRAMADA: 'Programada', EN_JUEGO: 'En juego', FINALIZADA: 'Finalizada' };

// ---------------------------------------------------------------------------
// Esquema: el código puede llegar antes que la migración. Mientras falte, todo se comporta
// como siempre (ninguna disciplina por categorías) en lugar de romper el fixture.
// ---------------------------------------------------------------------------
const RECHEQUEO_ESQUEMA_MS = 30000;
let esquemaListo = false;
let ultimoChequeo = 0;

async function esquemaDisponible(conexion) {
  if (esquemaListo) return true;
  if (Date.now() - ultimoChequeo < RECHEQUEO_ESQUEMA_MS) return false;
  ultimoChequeo = Date.now();
  try {
    const [rows] = await conexion.query(
      `SELECT
         (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada_disciplina' AND COLUMN_NAME = 'formato_competencia') AS columna,
         (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('olimpiada_prueba', 'olimpiada_prueba_participante')) AS tablas`
    );
    esquemaListo = Number(rows[0]?.columna) === 1 && Number(rows[0]?.tablas) === 2;
  } catch (_error) {
    esquemaListo = false;
  }
  return esquemaListo;
}

const numero = valor => (valor === null || valor === undefined ? null : Number(valor));

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

/** Disciplinas por categorías de la edición, con sus categorías o mesas ya ordenadas y con medallas. */
async function listarPruebas(conexion, olimpiadaId, { disciplinaIds = null, gestion = false } = {}) {
  if (!(await esquemaDisponible(conexion))) return [];
  const params = [olimpiadaId];
  if (disciplinaIds) params.push(disciplinaIds.length ? disciplinaIds : [0]);
  const [disciplinas] = await conexion.query(
    `SELECT d.id, d.nombre, d.formato_competencia AS formato, d.icono_archivo,
            c.sede_id, s.nombre AS sede_nombre, s.direccion AS sede_direccion, s.url_mapa AS sede_url_mapa, s.lat AS sede_lat, s.lng AS sede_lng
     FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     LEFT JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
     LEFT JOIN olimpiada_sede s ON s.id = c.sede_id AND s.eliminado = 0
     WHERE c.olimpiada_id = ? AND d.habilitado = 'Y' AND COALESCE(t.competitiva, 1) = 1 AND d.formato_competencia <> 'PARTIDOS'
       ${disciplinaIds ? 'AND d.id IN (?)' : ''}
     ORDER BY d.nombre`,
    params
  );
  if (!disciplinas.length) return [];
  const ids = disciplinas.map(d => d.id);
  const [[pruebas], [participantes]] = await Promise.all([
    conexion.query(
      `SELECT id, disciplina_id, nombre, descripcion, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, TIME_FORMAT(hora_inicio, '%H:%i') AS hora_inicio, estado, orden
       FROM olimpiada_prueba WHERE olimpiada_id = ? AND disciplina_id IN (?) AND eliminado = 0 ORDER BY orden, id`,
      [olimpiadaId, ids]
    ),
    conexion.query(`${SELECT_PARTICIPANTE} WHERE p.olimpiada_id = ? AND p.disciplina_id IN (?) AND p.eliminado = 0 ORDER BY p.orden, p.id`, [olimpiadaId, ids]),
  ]);
  return Promise.all(disciplinas.map(async ({ icono_archivo, ...disciplina }) => P.armarDisciplina(
    { ...disciplina, sede_lat: numero(disciplina.sede_lat), sede_lng: numero(disciplina.sede_lng), icono_url: await firmarSeguro(icono_archivo) },
    pruebas, participantes, { gestion }
  )));
}

/** Para el listado de disciplinas del fixture: formato, cuántas categorías tiene y cuántas se están disputando. */
async function resumenDisciplinas(conexion, olimpiadaId) {
  const resumen = new Map();
  if (!(await esquemaDisponible(conexion))) return resumen;
  const [rows] = await conexion.query(
    `SELECT d.id, d.formato_competencia AS formato,
            (SELECT COUNT(*) FROM olimpiada_prueba x WHERE x.olimpiada_id = c.olimpiada_id AND x.disciplina_id = d.id AND x.eliminado = 0) AS pruebas,
            (SELECT COUNT(*) FROM olimpiada_prueba x WHERE x.olimpiada_id = c.olimpiada_id AND x.disciplina_id = d.id AND x.eliminado = 0 AND x.estado = 'EN_JUEGO') AS en_juego
     FROM olimpiada_disciplina_config c INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     WHERE c.olimpiada_id = ?`,
    [olimpiadaId]
  );
  for (const fila of rows) resumen.set(Number(fila.id), { formato: fila.formato, pruebas: Number(fila.pruebas) || 0, en_juego: Number(fila.en_juego) || 0 });
  return resumen;
}

/** Categorías y mesas que se están disputando ahora (para el aviso «en vivo»). */
async function pruebasEnJuego(conexion, olimpiadaId, disciplinaIds = null) {
  if (!(await esquemaDisponible(conexion))) return [];
  const params = [olimpiadaId];
  if (disciplinaIds) params.push(disciplinaIds.length ? disciplinaIds : [0]);
  const [rows] = await conexion.query(
    `SELECT x.id, x.disciplina_id, d.nombre AS disciplina_nombre, d.formato_competencia AS formato, x.nombre
     FROM olimpiada_prueba x INNER JOIN olimpiada_disciplina d ON d.id = x.disciplina_id
     WHERE x.olimpiada_id = ? AND x.eliminado = 0 AND x.estado = 'EN_JUEGO' AND d.formato_competencia <> 'PARTIDOS'
       ${disciplinaIds ? 'AND x.disciplina_id IN (?)' : ''}
     ORDER BY d.nombre, x.orden, x.id`,
    params
  );
  return rows;
}

function registrarPruebas(router, helpers) {
  const { db, cargarOlimpiada, enTransaccion, historial, historialCambios, leerTexto, leerFecha, leerHora, validarDisciplinaDeOlimpiada, idDeRuta, listarEscudos } = helpers;
  const endpoint = (fn, mensaje = 'No se pudo completar la operación') => async (req, res) => { try { await fn(req, res); } catch (error) { responderError(res, error, mensaje); } };

  async function exigirEsquema() {
    if (!(await esquemaDisponible(db))) throw crearErrorHttp('Las disciplinas por categorías todavía no están habilitadas en este servidor', 503);
  }

  async function formatoDe(conexion, disciplinaId) {
    const [[fila]] = await conexion.query('SELECT formato_competencia AS formato FROM olimpiada_disciplina WHERE id = ?', [disciplinaId]);
    return fila?.formato || 'PARTIDOS';
  }

  /** Quién escribe y sobre qué: administración o veedor de la disciplina con la carga abierta. */
  async function contextoEscritura(req, olimpiadaId, disciplinaId) {
    await exigirEsquema();
    const cabecera = getCabecera(req);
    if (!esSuperior(cabecera) && !esVoluntario(cabecera)) throw crearErrorHttp('No autorizado', 403);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId, escritura: true });
    const disciplina = await validarDisciplinaDeOlimpiada(db, olimpiadaId, disciplinaId);
    const formato = await formatoDe(db, disciplinaId);
    if (!P.esPorCategorias(formato)) throw crearErrorHttp(`${disciplina.nombre} se juega por partidos: sus resultados se cargan en el fixture`, 409);
    return { cabecera, olimpiada, disciplina: { id: disciplinaId, nombre: disciplina.nombre, formato }, grupo: P.nombreGrupo(formato) };
  }

  async function cargarPrueba(conexion, pruebaId, { bloquear = false } = {}) {
    const [[fila]] = await conexion.query(`${SELECT_PRUEBA} WHERE id = ? AND eliminado = 0${bloquear ? ' FOR UPDATE' : ''}`, [pruebaId]);
    if (!fila) throw crearErrorHttp('La categoría o la mesa ya no existe', 404);
    return fila;
  }

  async function cargarParticipante(conexion, participanteId, { bloquear = false } = {}) {
    const [[fila]] = await conexion.query(`${SELECT_PARTICIPANTE} WHERE p.id = ? AND p.eliminado = 0${bloquear ? ' FOR UPDATE' : ''}`, [participanteId]);
    if (!fila) throw crearErrorHttp('El participante ya no existe', 404);
    return fila;
  }

  // Después de cada cambio se devuelve la disciplina completa: la pantalla se actualiza sin otra consulta.
  async function respuesta(olimpiadaId, disciplinaId, datos) {
    const [disciplina] = await listarPruebas(db, olimpiadaId, { disciplinaIds: [disciplinaId], gestion: true });
    return { success: true, ...datos, disciplina: disciplina || null };
  }

  async function exigirLugarEnMesa(conexion, prueba, cantidadNueva, exceptoId = null) {
    const [[cuenta]] = await conexion.query(
      'SELECT COUNT(*) AS cantidad FROM olimpiada_prueba_participante WHERE prueba_id = ? AND eliminado = 0 AND id <> ?', [prueba.id, exceptoId || 0]);
    if (Number(cuenta.cantidad) + cantidadNueva > P.MAX_JUGADORES_MESA) {
      throw crearErrorHttp(`En ${prueba.nombre} entran hasta ${P.MAX_JUGADORES_MESA} jugadores. Armá otra mesa para el resto.`, 409);
    }
  }

  async function siguienteOrden(conexion, olimpiadaId, disciplinaId, pruebaId) {
    const [[fila]] = await conexion.query(
      'SELECT COALESCE(MAX(orden), 0) AS maximo FROM olimpiada_prueba_participante WHERE olimpiada_id = ? AND disciplina_id = ? AND prueba_id <=> ? AND eliminado = 0',
      [olimpiadaId, disciplinaId, pruebaId]);
    return Number(fila.maximo) + 1;
  }

  async function nombreDepartamental(conexion, departamentalId) {
    if (!departamentalId) return null;
    const [[fila]] = await conexion.query('SELECT nombre FROM departamental WHERE id = ?', [departamentalId]);
    if (!fila) throw crearErrorHttp('La departamental elegida no existe', 404);
    return fila.nombre;
  }

  // Los resultados que admite cada formato. Devuelve sólo lo que vino en el cuerpo.
  function leerResultado(body, formato) {
    const datos = {};
    if (formato === 'TIEMPO') {
      const tiempo = P.leerTiempo(body.tiempo_ms !== undefined ? body.tiempo_ms : body.tiempo);
      if (tiempo !== undefined) datos.tiempo_ms = tiempo;
    } else if (formato === 'PESCA') {
      const piezas = P.leerPiezas(body.piezas), peso = P.leerPeso(body);
      if (piezas !== undefined) datos.piezas = piezas;
      if (peso !== undefined) datos.peso_gramos = peso;
    }
    return datos;
  }

  const describir = (participante, departamental) => [participante, departamental].filter(Boolean).join(' · ');
  const textoResultado = (campo, valor) => (valor === null || valor === undefined ? null
    : campo === 'tiempo_ms' ? P.formatearTiempo(valor) : campo === 'peso_gramos' ? P.formatearPeso(valor) : String(valor));

  // -------------------------------------------------------------------------
  // Lectura para la gestión, el veedor y el portal con sesión
  // -------------------------------------------------------------------------
  router.get('/olimpiadas/:id(\\d+)/pruebas', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const cabecera = getCabecera(req), olimpiadaId = idDeRuta(req.params.id);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    const asignadas = await exigirEdicionVoluntario({ db, cabecera, olimpiadaId });
    const disciplinaId = filtroId(req.query, 'disciplina_id');
    if (disciplinaId) await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId });
    const gestion = esSuperior(cabecera) || esVoluntario(cabecera);
    const [disciplinas, escudos] = await Promise.all([
      listarPruebas(db, olimpiadaId, { disciplinaIds: disciplinaId ? [disciplinaId] : asignadas, gestion }),
      listarEscudos(db),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      puede_editar: esSuperior(cabecera) || (esVoluntario(cabecera) && puedeEditarEdicion(olimpiada)),
      max_jugadores_mesa: P.MAX_JUGADORES_MESA,
      disciplinas, departamentales: escudos.departamentales,
    });
  }, 'No se pudieron cargar las categorías'));

  // -------------------------------------------------------------------------
  // Categorías y mesas
  // -------------------------------------------------------------------------
  router.post('/olimpiadas/:id(\\d+)/pruebas', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const olimpiadaId = idDeRuta(req.params.id), body = req.body || {};
    const disciplinaId = normalizarIdPositivo(body.disciplina_id);
    if (!disciplinaId) throw crearErrorHttp('Elegí la disciplina');
    const { cabecera, disciplina, grupo } = await contextoEscritura(req, olimpiadaId, disciplinaId);
    let nombreFinal = '';
    const id = await enTransaccion(async connection => {
      const [existentes] = await connection.query(
        'SELECT id, nombre, orden FROM olimpiada_prueba WHERE olimpiada_id = ? AND disciplina_id = ? AND eliminado = 0 FOR UPDATE', [olimpiadaId, disciplinaId]);
      if (existentes.length >= P.MAX_PRUEBAS_DISCIPLINA) throw crearErrorHttp(`${disciplina.nombre} ya tiene ${P.MAX_PRUEBAS_DISCIPLINA} ${grupo}s`, 409);
      let nombre = leerTexto(body, 'nombre', {}, { maximo: 120, etiqueta: 'el nombre' });
      if (!nombre && disciplina.formato === 'MESAS') {
        // Las mesas se numeran solas: «Mesa 1», «Mesa 2»…
        let n = existentes.length + 1;
        while (existentes.some(e => P.sinAcentos(e.nombre) === `mesa ${n}`)) n++;
        nombre = `Mesa ${n}`;
      }
      if (!nombre) throw crearErrorHttp(`Ingresá el nombre de la ${grupo}`);
      if (existentes.some(e => P.sinAcentos(e.nombre) === P.sinAcentos(nombre))) throw crearErrorHttp(`Ya hay una ${grupo} «${nombre}» en ${disciplina.nombre}`, 409);
      const datos = {
        olimpiada_id: olimpiadaId, disciplina_id: disciplinaId, nombre,
        descripcion: leerTexto(body, 'descripcion', {}, { maximo: 300, etiqueta: 'la aclaración' }),
        fecha: leerFecha(body, 'fecha', {}, { etiqueta: 'el día' }), hora_inicio: leerHora(body, 'hora_inicio', {}, { etiqueta: 'la hora' }),
        orden: existentes.reduce((maximo, e) => Math.max(maximo, Number(e.orden) || 0), 0) + 1,
      };
      const [insert] = await connection.query('INSERT INTO olimpiada_prueba SET ?', [datos]);
      await historial(connection, cabecera, { entidad: 'PRUEBA', entidad_id: insert.insertId, olimpiada_id: olimpiadaId, tipo_operacion: 'CREATE', campo_modificado: disciplina.nombre, valor_nuevo: nombre });
      nombreFinal = nombre;
      return insert.insertId;
    });
    res.status(201).json(await respuesta(olimpiadaId, disciplinaId, { id, message: `${nombreFinal} creada` }));
  }, 'No se pudo crear la categoría'));

  router.put('/olimpiadas/pruebas/:pruebaId(\\d+)', verificarAccesoCompeticion, endpoint(async (req, res) => {
    await exigirEsquema();
    const pruebaId = idDeRuta(req.params.pruebaId), body = req.body || {};
    const previa = await cargarPrueba(db, pruebaId);
    const { cabecera, disciplina, grupo } = await contextoEscritura(req, previa.olimpiada_id, previa.disciplina_id);
    let mensaje = 'Cambios guardados';
    await enTransaccion(async connection => {
      const actual = await cargarPrueba(connection, pruebaId, { bloquear: true });
      const datos = {
        nombre: leerTexto(body, 'nombre', actual, { requerido: true, maximo: 120, etiqueta: `el nombre de la ${grupo}` }),
        descripcion: leerTexto(body, 'descripcion', actual, { maximo: 300, etiqueta: 'la aclaración' }),
        fecha: leerFecha(body, 'fecha', actual, { etiqueta: 'el día' }), hora_inicio: leerHora(body, 'hora_inicio', actual, { etiqueta: 'la hora' }),
        estado: actual.estado,
      };
      if (body.estado !== undefined && body.estado !== null) {
        const estado = String(body.estado).trim().toUpperCase();
        if (!P.ESTADOS_PRUEBA.includes(estado)) throw crearErrorHttp('El estado es inválido');
        datos.estado = estado;
      }
      if (P.sinAcentos(datos.nombre) !== P.sinAcentos(actual.nombre)) {
        const [repetida] = await connection.query(
          'SELECT nombre FROM olimpiada_prueba WHERE olimpiada_id = ? AND disciplina_id = ? AND eliminado = 0 AND id <> ?', [actual.olimpiada_id, actual.disciplina_id, pruebaId]);
        if (repetida.some(e => P.sinAcentos(e.nombre) === P.sinAcentos(datos.nombre))) throw crearErrorHttp(`Ya hay una ${grupo} «${datos.nombre}» en ${disciplina.nombre}`, 409);
      }
      await connection.query('UPDATE olimpiada_prueba SET ? WHERE id = ?', [datos, pruebaId]);
      await historialCambios(connection, cabecera, { entidad: 'PRUEBA', entidad_id: pruebaId, olimpiada_id: actual.olimpiada_id }, actual, datos, Object.keys(datos));
      if (datos.estado !== actual.estado) mensaje = `${datos.nombre}: ${NOMBRES_ESTADO[datos.estado].toLowerCase()}`;
    });
    res.json(await respuesta(previa.olimpiada_id, previa.disciplina_id, { id: pruebaId, message: mensaje }));
  }, 'No se pudieron guardar los cambios'));

  router.delete('/olimpiadas/pruebas/:pruebaId(\\d+)', verificarAccesoCompeticion, endpoint(async (req, res) => {
    await exigirEsquema();
    const pruebaId = idDeRuta(req.params.pruebaId);
    const previa = await cargarPrueba(db, pruebaId);
    const { cabecera, disciplina, grupo } = await contextoEscritura(req, previa.olimpiada_id, previa.disciplina_id);
    const conParticipantes = ['1', 'true'].includes(String(req.query.con_participantes || ''));
    let mensaje = `${previa.nombre} eliminada`;
    await enTransaccion(async connection => {
      const actual = await cargarPrueba(connection, pruebaId, { bloquear: true });
      const [[cuenta]] = await connection.query('SELECT COUNT(*) AS cantidad FROM olimpiada_prueba_participante WHERE prueba_id = ? AND eliminado = 0', [pruebaId]);
      const cantidad = Number(cuenta.cantidad);
      if (disciplina.formato === 'MESAS') {
        // Desarmar una mesa no saca a nadie del torneo: sus jugadores quedan sin mesa.
        if (cantidad) {
          await connection.query('UPDATE olimpiada_prueba_participante SET prueba_id = NULL WHERE prueba_id = ? AND eliminado = 0', [pruebaId]);
          mensaje = `${actual.nombre} eliminada: sus ${cantidad} jugadores quedaron sin mesa`;
        }
      } else if (cantidad) {
        if (!conParticipantes) throw crearErrorHttp(`${actual.nombre} tiene ${cantidad} participante(s) cargados. Confirmá que querés eliminarla con sus participantes.`, 409);
        await connection.query('UPDATE olimpiada_prueba_participante SET eliminado = 1 WHERE prueba_id = ? AND eliminado = 0', [pruebaId]);
        mensaje = `${actual.nombre} eliminada con sus ${cantidad} participante(s)`;
      }
      await connection.query('UPDATE olimpiada_prueba SET eliminado = 1 WHERE id = ?', [pruebaId]);
      await historial(connection, cabecera, {
        entidad: 'PRUEBA', entidad_id: pruebaId, olimpiada_id: actual.olimpiada_id, tipo_operacion: 'DELETE', campo_modificado: disciplina.nombre,
        valor_anterior: actual.nombre, observacion: cantidad ? `Tenía ${cantidad} participante(s)` : null,
      });
    });
    res.json(await respuesta(previa.olimpiada_id, previa.disciplina_id, { message: mensaje, grupo }));
  }, 'No se pudo eliminar'));

  // -------------------------------------------------------------------------
  // Participantes
  // -------------------------------------------------------------------------

  /**
   * Alta de uno o varios participantes: `participantes: [{ nombre, departamental_id }]` o tomados de
   * las inscripciones aprobadas de la disciplina (`inscripcion_id`: el nombre y la departamental
   * salen de ahí). Los que ya estaban cargados se omiten y se avisa.
   */
  router.post('/olimpiadas/:id(\\d+)/pruebas/participantes', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const olimpiadaId = idDeRuta(req.params.id), body = req.body || {};
    const disciplinaId = normalizarIdPositivo(body.disciplina_id);
    if (!disciplinaId) throw crearErrorHttp('Elegí la disciplina');
    const { cabecera, disciplina, grupo } = await contextoEscritura(req, olimpiadaId, disciplinaId);
    const pruebaId = body.prueba_id === null || body.prueba_id === undefined || body.prueba_id === '' ? null : normalizarIdPositivo(body.prueba_id);
    if (body.prueba_id && !pruebaId) throw crearErrorHttp(`La ${grupo} es inválida`);
    if (!pruebaId && disciplina.formato !== 'MESAS') throw crearErrorHttp('Elegí la categoría del participante');
    const lista = Array.isArray(body.participantes) ? body.participantes : body.nombre || body.inscripcion_id ? [body] : [];
    if (!lista.length) throw crearErrorHttp('Ingresá al menos un participante');
    if (lista.length > P.MAX_PARTICIPANTES_CARGA) throw crearErrorHttp(`Se pueden agregar hasta ${P.MAX_PARTICIPANTES_CARGA} participantes por vez`);

    const agregados = [], omitidos = [];
    await enTransaccion(async connection => {
      const prueba = pruebaId ? await cargarPrueba(connection, pruebaId, { bloquear: true }) : null;
      if (prueba && (Number(prueba.olimpiada_id) !== olimpiadaId || Number(prueba.disciplina_id) !== disciplinaId)) throw crearErrorHttp(`La ${grupo} no es de esta disciplina`);
      const [existentes] = await connection.query(
        'SELECT id, prueba_id, nombre, departamental_id, inscripcion_id FROM olimpiada_prueba_participante WHERE olimpiada_id = ? AND disciplina_id = ? AND eliminado = 0 FOR UPDATE',
        [olimpiadaId, disciplinaId]);
      if (existentes.length + lista.length > P.MAX_PARTICIPANTES_DISCIPLINA) throw crearErrorHttp(`${disciplina.nombre} admite hasta ${P.MAX_PARTICIPANTES_DISCIPLINA} participantes`);

      const idsInscripcion = [...new Set(lista.map(p => normalizarIdPositivo(p?.inscripcion_id)).filter(Boolean))];
      const inscripciones = new Map();
      if (idsInscripcion.length) {
        const [rows] = await connection.query(
          `SELECT i.id, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) AS nombre, i.departamental_id
           FROM olimpiada_inscripcion i
           INNER JOIN usuario u ON u.id = i.usuario_id
           INNER JOIN olimpiada_inscripcion_disciplina x ON x.inscripcion_id = i.id AND x.disciplina_id = ?
           WHERE i.id IN (?) AND i.olimpiada_id = ? AND i.estado = 'VALIDADO' AND i.eliminado = 0`,
          [disciplinaId, idsInscripcion, olimpiadaId]);
        for (const fila of rows) inscripciones.set(Number(fila.id), fila);
      }

      const nuevos = [];
      // Una persona figura una sola vez por disciplina; por nombre, una sola vez por categoría o mesa.
      const clave = (nombre, departamentalId) => `${P.sinAcentos(nombre)}|${departamentalId || 0}`;
      const yaInscriptos = new Set(existentes.map(e => Number(e.inscripcion_id)).filter(Boolean));
      const yaCargados = new Set(existentes.filter(e => disciplina.formato === 'MESAS' || numero(e.prueba_id) === pruebaId).map(e => clave(e.nombre, e.departamental_id)));
      for (const item of lista) {
        if (!item || typeof item !== 'object') throw crearErrorHttp('Hay un participante con formato inválido');
        const inscripcionId = normalizarIdPositivo(item.inscripcion_id);
        let nombre, departamentalId;
        if (inscripcionId) {
          const inscripcion = inscripciones.get(inscripcionId);
          if (!inscripcion) throw crearErrorHttp(`Una de las personas elegidas no tiene una inscripción aprobada en ${disciplina.nombre}`);
          nombre = inscripcion.nombre; departamentalId = numero(inscripcion.departamental_id);
        } else {
          nombre = leerTexto(item, 'nombre', {}, { requerido: true, maximo: 160, etiqueta: 'el nombre del participante' });
          departamentalId = item.departamental_id === null || item.departamental_id === undefined || item.departamental_id === '' ? null : normalizarIdPositivo(item.departamental_id);
          if (item.departamental_id && !departamentalId) throw crearErrorHttp('La departamental es inválida');
        }
        if ((inscripcionId && yaInscriptos.has(inscripcionId)) || yaCargados.has(clave(nombre, departamentalId))) { omitidos.push(nombre); continue; }
        if (inscripcionId) yaInscriptos.add(inscripcionId);
        yaCargados.add(clave(nombre, departamentalId));
        nuevos.push({ nombre, departamental_id: departamentalId, inscripcion_id: inscripcionId || null, ...leerResultado(item, disciplina.formato) });
      }
      if (!nuevos.length) return;

      const departamentales = new Map();
      for (const id of new Set(nuevos.map(n => n.departamental_id).filter(Boolean))) departamentales.set(id, await nombreDepartamental(connection, id));
      if (prueba && disciplina.formato === 'MESAS') await exigirLugarEnMesa(connection, prueba, nuevos.length);
      let orden = await siguienteOrden(connection, olimpiadaId, disciplinaId, pruebaId);
      for (const nuevo of nuevos) {
        const [insert] = await connection.query('INSERT INTO olimpiada_prueba_participante SET ?', [{ olimpiada_id: olimpiadaId, disciplina_id: disciplinaId, prueba_id: pruebaId, orden: orden++, ...nuevo }]);
        await historial(connection, cabecera, {
          entidad: 'PRUEBA_PARTICIPANTE', entidad_id: insert.insertId, olimpiada_id: olimpiadaId, tipo_operacion: 'CREATE',
          campo_modificado: prueba ? prueba.nombre : disciplina.nombre, valor_nuevo: describir(nuevo.nombre, departamentales.get(nuevo.departamental_id)),
        });
        agregados.push(insert.insertId);
      }
    });

    const avisos = omitidos.length ? [`Ya ${omitidos.length === 1 ? 'estaba cargado' : 'estaban cargados'}: ${omitidos.slice(0, 12).join(', ')}${omitidos.length > 12 ? '…' : ''}`] : [];
    const message = agregados.length === 0 ? 'No se agregó a nadie: ya estaban cargados'
      : agregados.length === 1 ? 'Participante agregado' : `${agregados.length} participantes agregados`;
    res.status(agregados.length ? 201 : 200).json(await respuesta(olimpiadaId, disciplinaId, { ids: agregados, message, avisos }));
  }, 'No se pudieron agregar los participantes'));

  router.put('/olimpiadas/pruebas/participantes/:participanteId(\\d+)', verificarAccesoCompeticion, endpoint(async (req, res) => {
    await exigirEsquema();
    const participanteId = idDeRuta(req.params.participanteId), body = req.body || {};
    const previo = await cargarParticipante(db, participanteId);
    const { cabecera, disciplina, grupo } = await contextoEscritura(req, previo.olimpiada_id, previo.disciplina_id);
    let mensaje = 'Cambios guardados';
    await enTransaccion(async connection => {
      const actual = await cargarParticipante(connection, participanteId, { bloquear: true });
      const datos = { nombre: leerTexto(body, 'nombre', actual, { requerido: true, maximo: 160, etiqueta: 'el nombre del participante' }) };
      if (body.departamental_id !== undefined) {
        datos.departamental_id = body.departamental_id === null || body.departamental_id === '' ? null : normalizarIdPositivo(body.departamental_id);
        if (body.departamental_id && !datos.departamental_id) throw crearErrorHttp('La departamental es inválida');
        await nombreDepartamental(connection, datos.departamental_id);
      }
      Object.assign(datos, leerResultado(body, disciplina.formato));

      // Cambiar de categoría o de mesa (null = sin mesa, sólo en póker)
      let destino = null;
      if (body.prueba_id !== undefined) {
        const pruebaId = body.prueba_id === null || body.prueba_id === '' ? null : normalizarIdPositivo(body.prueba_id);
        if (body.prueba_id && !pruebaId) throw crearErrorHttp(`La ${grupo} es inválida`);
        if (!pruebaId && disciplina.formato !== 'MESAS') throw crearErrorHttp('El participante tiene que estar en una categoría');
        if (pruebaId !== numero(actual.prueba_id)) {
          if (pruebaId) {
            destino = await cargarPrueba(connection, pruebaId, { bloquear: true });
            if (Number(destino.olimpiada_id) !== Number(actual.olimpiada_id) || Number(destino.disciplina_id) !== Number(actual.disciplina_id)) throw crearErrorHttp(`La ${grupo} no es de esta disciplina`);
            if (disciplina.formato === 'MESAS') await exigirLugarEnMesa(connection, destino, 1, participanteId);
          }
          datos.prueba_id = pruebaId;
          datos.orden = await siguienteOrden(connection, actual.olimpiada_id, actual.disciplina_id, pruebaId);
          mensaje = pruebaId ? `${datos.nombre} pasó a ${destino.nombre}` : `${datos.nombre} quedó sin mesa`;
        }
      }

      await connection.query('UPDATE olimpiada_prueba_participante SET ? WHERE id = ?', [datos, participanteId]);
      const base = { entidad: 'PRUEBA_PARTICIPANTE', entidad_id: participanteId, olimpiada_id: actual.olimpiada_id };
      await historialCambios(connection, cabecera, base, actual, datos, ['nombre', 'departamental_id', 'prueba_id'].filter(campo => campo in datos));
      for (const campo of ['tiempo_ms', 'piezas', 'peso_gramos']) {
        if (!(campo in datos) || numero(actual[campo]) === datos[campo]) continue;
        await historial(connection, cabecera, {
          ...base, tipo_operacion: 'UPDATE', campo_modificado: campo,
          valor_anterior: textoResultado(campo, actual[campo]), valor_nuevo: textoResultado(campo, datos[campo]), observacion: datos.nombre,
        });
        if (mensaje === 'Cambios guardados') mensaje = `Resultado de ${datos.nombre} guardado`;
      }
    });
    res.json(await respuesta(previo.olimpiada_id, previo.disciplina_id, { id: participanteId, message: mensaje }));
  }, 'No se pudieron guardar los cambios'));

  router.delete('/olimpiadas/pruebas/participantes/:participanteId(\\d+)', verificarAccesoCompeticion, endpoint(async (req, res) => {
    await exigirEsquema();
    const participanteId = idDeRuta(req.params.participanteId);
    const previo = await cargarParticipante(db, participanteId);
    const { cabecera } = await contextoEscritura(req, previo.olimpiada_id, previo.disciplina_id);
    await enTransaccion(async connection => {
      const actual = await cargarParticipante(connection, participanteId, { bloquear: true });
      await connection.query('UPDATE olimpiada_prueba_participante SET eliminado = 1, puesto = NULL WHERE id = ?', [participanteId]);
      await historial(connection, cabecera, {
        entidad: 'PRUEBA_PARTICIPANTE', entidad_id: participanteId, olimpiada_id: actual.olimpiada_id, tipo_operacion: 'DELETE',
        valor_anterior: describir(actual.nombre, actual.departamental_nombre),
      });
    });
    res.json(await respuesta(previo.olimpiada_id, previo.disciplina_id, { message: `${previo.nombre} ya no figura` }));
  }, 'No se pudo quitar al participante'));

  // -------------------------------------------------------------------------
  // Póker: los tres ganadores se eligen a mano, sin contar fichas ni puntos
  // -------------------------------------------------------------------------
  router.put('/olimpiadas/:id(\\d+)/disciplinas/:disciplinaId(\\d+)/podio', verificarAccesoCompeticion, endpoint(async (req, res) => {
    const olimpiadaId = idDeRuta(req.params.id), disciplinaId = idDeRuta(req.params.disciplinaId);
    const { cabecera, disciplina } = await contextoEscritura(req, olimpiadaId, disciplinaId);
    if (disciplina.formato !== 'MESAS') throw crearErrorHttp(`En ${disciplina.nombre} los puestos salen de los resultados cargados`, 409);
    const puestos = req.body?.puestos;
    if (!Array.isArray(puestos) || puestos.length > P.MEDALLAS.length) throw crearErrorHttp('Indicá el 1.º, el 2.º y el 3.º puesto');
    const elegidos = P.MEDALLAS.map((_medalla, indice) => {
      const valor = puestos[indice];
      if (valor === null || valor === undefined || valor === '') return null;
      const id = normalizarIdPositivo(valor);
      if (!id) throw crearErrorHttp('Uno de los ganadores es inválido');
      return id;
    });
    const conGanador = elegidos.filter(Boolean);
    if (new Set(conGanador).size !== conGanador.length) throw crearErrorHttp('Una misma persona no puede ocupar dos puestos');
    await enTransaccion(async connection => {
      const [jugadores] = await connection.query(
        'SELECT id, nombre, puesto FROM olimpiada_prueba_participante WHERE olimpiada_id = ? AND disciplina_id = ? AND eliminado = 0 FOR UPDATE', [olimpiadaId, disciplinaId]);
      const porId = new Map(jugadores.map(j => [Number(j.id), j]));
      if (conGanador.some(id => !porId.has(id))) throw crearErrorHttp('Uno de los ganadores ya no figura entre los jugadores', 409);
      for (const jugador of jugadores) {
        const indice = elegidos.indexOf(Number(jugador.id));
        const nuevo = indice === -1 ? null : indice + 1;
        if (numero(jugador.puesto) === nuevo) continue;
        await connection.query('UPDATE olimpiada_prueba_participante SET puesto = ? WHERE id = ?', [nuevo, jugador.id]);
        await historial(connection, cabecera, {
          entidad: 'PRUEBA_PARTICIPANTE', entidad_id: jugador.id, olimpiada_id: olimpiadaId, tipo_operacion: 'UPDATE', campo_modificado: 'puesto',
          valor_anterior: jugador.puesto ? `${jugador.puesto}.º` : null, valor_nuevo: nuevo ? `${nuevo}.º` : null, observacion: jugador.nombre,
        });
      }
    });
    res.json(await respuesta(olimpiadaId, disciplinaId, { message: conGanador.length ? 'Ganadores guardados' : 'Se quitaron los ganadores' }));
  }, 'No se pudieron guardar los ganadores'));

  return { listarPruebas, resumenDisciplinas, pruebasEnJuego, esquemaDisponible };
}

module.exports = registrarPruebas;
module.exports.listarPruebas = listarPruebas;
module.exports.resumenDisciplinas = resumenDisciplinas;
module.exports.pruebasEnJuego = pruebasEnJuego;
module.exports.esquemaDisponible = esquemaDisponible;
module.exports.__test = { reiniciarEsquema: () => { esquemaListo = false; ultimoChequeo = 0; } };
