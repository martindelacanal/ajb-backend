"use strict";

const {
  crearErrorHttp, esSuperior, getCabecera, normalizarIdPositivo, normalizarIds,
  responderError, verificarSesionOlimpiadas, verifyToken,
} = require("../services/olimpiadas-comun");

const EDICION = "o.id, o.nombre, o.edicion, o.localidad, o.fecha_inicio, o.fecha_fin";
const { recursoDeEnlace } = require("../services/olimpiadas-drive");
const ASIGNACION = `JOIN olimpiada_prensa a ON a.olimpiada_id = o.id AND a.usuario_id = ?
  WHERE o.eliminado = 0`;

async function exigirAsignacion(db, usuarioId, params, body) {
  if (params.id) {
    const [rows] = await db.query(`SELECT o.id FROM olimpiada o ${ASIGNACION} AND o.id = ?`, [usuarioId, params.id]);
    if (rows.length === 1) return;
  } else {
    const esVideo = Boolean(params.videoId);
    const tabla = esVideo ? "olimpiada_video" : "olimpiada_foto";
    const id = params.videoId || params.fotoId;
    const ids = id ? [normalizarIdPositivo(id)] : normalizarIds(body?.ids);
    if (!ids?.length || ids.includes(null) || ids.length > 200) throw crearErrorHttp("Selección de archivos inválida");
    const condicionSubida = esVideo ? " AND (m.estado <> 'SUBIENDO' OR m.usuario_id = ?)" : "";
    const parametros = esVideo ? [usuarioId, ids, usuarioId] : [usuarioId, ids];
    const [rows] = await db.query(
      `SELECT m.id FROM ${tabla} m JOIN olimpiada o ON o.id = m.olimpiada_id
       ${ASIGNACION} AND m.id IN (?) AND m.eliminado = 0${condicionSubida}`, parametros);
    if (rows.length === ids.length) return;
  }
  throw crearErrorHttp("No tenés acceso de Prensa a esta edición o archivo", 403);
}

function soloGestionMultimedia(req, res, next) {
  const cabecera = getCabecera(req);
  if (esSuperior(cabecera) || cabecera.rol === "prensa") return next();
  return res.status(403).json("No tenés permiso para gestionar fotos y videos");
}

function registrarPrensa(router, { db, soloSuperior, cargarOlimpiada, idDeRuta, enTransaccion, historial }) {
  const manejar = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { responderError(res, error, "No pudimos cargar los datos de Prensa"); }
  };
  const verifyTokenMultimedia = (req, res, next) => verificarSesionOlimpiadas(req, res, async () => {
    const cabecera = getCabecera(req);
    try {
      if (cabecera.rol === "prensa") await exigirAsignacion(db, cabecera.id, req.params, req.body);
      return next();
    } catch (error) { return responderError(res, error, "No pudimos verificar el acceso de Prensa"); }
  });

  router.get("/olimpiadas/prensa/ediciones", verificarSesionOlimpiadas, manejar(async (req, res) => {
    const cabecera = getCabecera(req);
    if (cabecera.rol !== "prensa") throw crearErrorHttp("Acceso exclusivo para Prensa", 403);
    const [ediciones] = await db.query(`SELECT ${EDICION} FROM olimpiada o ${ASIGNACION}
      ORDER BY o.fecha_inicio DESC, o.id DESC`, [cabecera.id]);
    res.set("Cache-Control", "no-store").json(ediciones);
  }));

  router.get("/olimpiadas/:id(\\d+)/fotos/contexto", verifyTokenMultimedia, soloGestionMultimedia, manejar(async (req, res) => {
    const id = idDeRuta(req.params.id);
    const [[edicion]] = await db.query(`SELECT ${EDICION}, o.drive_publico_url FROM olimpiada o WHERE o.id = ? AND o.eliminado = 0`, [id]);
    if (!edicion) throw crearErrorHttp("La edición no existe", 404);
    const [disciplinas] = await db.query(`SELECT d.id, d.nombre FROM olimpiada_disciplina_config c
      JOIN olimpiada_disciplina d ON d.id = c.disciplina_id WHERE c.olimpiada_id = ? ORDER BY d.nombre`, [id]);
    const [departamentales] = await db.query("SELECT id, nombre FROM departamental WHERE habilitado = 'Y' ORDER BY nombre");
    res.set("Cache-Control", "no-store").json({ ...edicion, disciplinas, departamentales });
  }));

  router.put("/olimpiadas/:id(\\d+)/fotos/drive-publico", verifyTokenMultimedia, soloGestionMultimedia, manejar(async (req, res) => {
    const id = idDeRuta(req.params.id);
    const cabecera = getCabecera(req);
    const valor = req.body?.drive_publico_url;
    let enlace = null;
    if (valor !== null) {
      const recurso = recursoDeEnlace(valor);
      const legado = new URL(valor.trim()).pathname === "/open";
      const ruta = legado ? "/open" : recurso.tipo === "archivo" ? `/file/d/${recurso.id}/view` : `/drive/folders/${recurso.id}`;
      const destino = new URL(ruta, "https://drive.google.com");
      if (legado) destino.searchParams.set("id", recurso.id);
      if (recurso.clave) destino.searchParams.set("resourcekey", recurso.clave);
      enlace = destino.href;
    }
    await enTransaccion(async conexion => {
      const edicion = await cargarOlimpiada(conexion, id, cabecera, { forUpdate: true });
      if ((edicion.drive_publico_url ?? null) === enlace) return;
      await conexion.query("UPDATE olimpiada SET drive_publico_url = ? WHERE id = ?", [enlace, id]);
      await historial(conexion, cabecera, { entidad: "OLIMPIADA", entidad_id: id, olimpiada_id: id, tipo_operacion: "UPDATE",
        campo_modificado: "drive_publico_url", observacion: enlace ? "Actualizó el enlace público de Google Drive" : "Ocultó el enlace público de Google Drive" });
    });
    res.json({ drive_publico_url: enlace });
  }));

  const ruta = "/olimpiadas/:id(\\d+)/prensa";
  router.get(ruta, verifyToken, soloSuperior, manejar(async (req, res) => {
    const id = idDeRuta(req.params.id);
    await cargarOlimpiada(db, id, getCabecera(req));
    const [cuentas] = await db.query(`SELECT u.id, u.nombre, u.apellido, a.usuario_id IS NOT NULL AS asignado
      FROM usuario u JOIN rol r ON r.id = u.rol_id AND r.nombre = 'prensa'
      LEFT JOIN olimpiada_prensa a ON a.olimpiada_id = ? AND a.usuario_id = u.id
      ORDER BY u.apellido, u.nombre, u.id`, [id]);
    res.set("Cache-Control", "no-store").json(cuentas);
  }));
  router.put(ruta + "/:usuarioId(\\d+)", verifyToken, soloSuperior, manejar(async (req, res) => {
    const id = idDeRuta(req.params.id);
    await cargarOlimpiada(db, id, getCabecera(req));
    const usuarioId = idDeRuta(req.params.usuarioId);
    const [cuentas] = await db.query(`SELECT u.id FROM usuario u JOIN rol r ON r.id = u.rol_id
      WHERE u.id = ? AND r.nombre = 'prensa'`, [usuarioId]);
    if (!cuentas.length) throw crearErrorHttp("La cuenta no tiene el rol Prensa", 400);
    await db.query(`INSERT INTO olimpiada_prensa (olimpiada_id, usuario_id) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE usuario_id = VALUES(usuario_id)`, [id, usuarioId]);
    res.status(204).end();
  }));
  router.delete(ruta + "/:usuarioId(\\d+)", verifyToken, soloSuperior, manejar(async (req, res) => {
    await db.query("DELETE FROM olimpiada_prensa WHERE olimpiada_id = ? AND usuario_id = ?",
      [idDeRuta(req.params.id), idDeRuta(req.params.usuarioId)]);
    res.status(204).end();
  }));
  return { verifyTokenMultimedia, soloGestionMultimedia };
}

module.exports = { registrarPrensa, exigirAsignacion, soloGestionMultimedia };
