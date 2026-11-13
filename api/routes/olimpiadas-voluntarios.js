"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mysqlConnection = require("../connection/connection");
const { enviarCorreoPlantilla, urlAplicacion } = require("../services/correo");
const { esCorreoValido } = require("../services/correo/config");
const { validarPassword } = require("../security/password-policy");
const { limitar } = require("../security/recuperacion-password");
const { registrarAccesoVoluntarios } = require("./olimpiadas-acceso");
const { usuarioHabilitado } = require("../security/autorizacion-sesion");
const { exigirAccesoCuenta } = require("../security/restricciones-cuenta");
const {
  verifyToken, getCabecera, esSuperior, crearErrorHttp, normalizarIds,
  normalizarIdPositivo, normalizarBooleano01, registrarHistorial,
} = require("../services/olimpiadas-comun");
const {
  autenticarVoluntario, cargarCuentaVoluntario, puedeEditarEdicion, validarPasswordVeedor, esCorreoInterno, DOMINIO_INTERNO,
} = require("../security/olimpiadas-voluntarios");
const { crearSesionVoluntario } = require("../security/olimpiadas-acceso");

function normalizarCuenta(body, actual = null) {
  const nombre = String(body.nombre ?? actual?.nombre ?? "").trim();
  const usuario = String(body.usuario ?? actual?.usuario ?? "").trim().toLowerCase();
  if (!nombre || nombre.length > 160) throw crearErrorHttp("Ingresá un nombre de hasta 160 caracteres");
  if (!/^[a-z0-9][a-z0-9._-]{2,59}$/.test(usuario)) {
    throw crearErrorHttp("El usuario debe tener entre 3 y 60 letras, números, puntos, guiones o guiones bajos");
  }
  // El correo es opcional: un invitado sin correo queda con una dirección interna que no recibe mensajes.
  const ingresado = body.email === undefined ? (esCorreoInterno(actual?.email) ? "" : actual?.email ?? "") : body.email ?? "";
  let email = String(ingresado).trim().toLowerCase();
  if (!email) email = `veedor-${usuario}${DOMINIO_INTERNO}`;
  else if (esCorreoInterno(email) || !esCorreoValido(email) || email.length > 254 || /[,;\r\n]/.test(email)) throw crearErrorHttp("Ingresá un correo electrónico válido o dejalo vacío");
  const habilitado = body.habilitado === undefined ? Number(actual?.habilitado ?? 1) : normalizarBooleano01(body.habilitado);
  if (habilitado === null) throw crearErrorHttp("Indicá si el acceso está habilitado");
  if (!actual || (body.password !== undefined && body.password !== "")) validarPasswordVeedor(body.password);
  return { nombre, usuario, email, habilitado };
}

function leerIds(valor, etiqueta, { permiteVacio = false, maximo = 100 } = {}) {
  const ids = normalizarIds(valor);
  if (!Array.isArray(valor) || !ids || (!permiteVacio && !ids.length) || ids.length > maximo) {
    throw crearErrorHttp(`Indicá ${etiqueta}${permiteVacio ? "" : " (al menos uno)"}, hasta ${maximo}`);
  }
  return ids;
}

async function obtenerEdicion(db, valor) {
  const id = normalizarIdPositivo(valor);
  if (!id) throw crearErrorHttp("La olimpiada no es válida");
  const [rows] = await db.query("SELECT id, nombre, fecha_inicio, fecha_fin, habilitado, eliminado FROM olimpiada WHERE id = ? AND eliminado = 0 LIMIT 1", [id]);
  if (!rows[0]) throw crearErrorHttp("No encontramos esta olimpiada", 404);
  return rows[0];
}

async function validarDisciplinas(db, olimpiadaId, ids) {
  if (!ids.length) return;
  const [rows] = await db.query("SELECT disciplina_id FROM olimpiada_disciplina_config WHERE olimpiada_id = ? AND disciplina_id IN (?)", [olimpiadaId, ids]);
  if (new Set(rows.map((r) => Number(r.disciplina_id))).size !== ids.length) {
    throw crearErrorHttp("Todas las disciplinas deben pertenecer a esta olimpiada");
  }
}

async function asignacionesDe(db, voluntarioId) {
  const [rows] = await db.query(`SELECT a.olimpiada_id, a.disciplina_id, d.nombre AS disciplina_nombre,
      o.nombre AS olimpiada_titulo, o.fecha_inicio, o.fecha_fin, o.habilitado, o.eliminado, o.veedores_carga_abierta
    FROM olimpiada_voluntario_disciplina a
    INNER JOIN olimpiada o ON o.id = a.olimpiada_id AND o.eliminado = 0 AND o.habilitado = 'Y'
    INNER JOIN olimpiada_disciplina d ON d.id = a.disciplina_id
    INNER JOIN olimpiada_disciplina_config c ON c.olimpiada_id = a.olimpiada_id AND c.disciplina_id = a.disciplina_id
    WHERE a.voluntario_id = ? ORDER BY o.fecha_inicio DESC, d.nombre`, [voluntarioId]);
  const ediciones = new Map();
  for (const row of rows) {
    const id = Number(row.olimpiada_id);
    if (!ediciones.has(id)) ediciones.set(id, {
      olimpiada_id: id, olimpiada_titulo: row.olimpiada_titulo,
      fecha_inicio: row.fecha_inicio, fecha_fin: row.fecha_fin,
      puede_editar: puedeEditarEdicion(row), disciplinas: [],
    });
    ediciones.get(id).disciplinas.push({ id: Number(row.disciplina_id), nombre: row.disciplina_nombre });
  }
  return [...ediciones.values()];
}

function cuentaPublica(v) { return { id: Number(v.id ?? v.voluntario_id), nombre: v.nombre, usuario: v.usuario, email: esCorreoInterno(v.email) ? "" : v.email,
  usuario_sistema_id: v.usuario_sistema_id ? Number(v.usuario_sistema_id) : null, cuenta_sistema: Boolean(v.usuario_sistema_id) }; }

async function transaccion(db, trabajo) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const resultado = await trabajo(connection);
    await connection.commit();
    return resultado;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function reemplazarAsignaciones(connection, voluntarioId, olimpiadaId, ids) {
  await connection.query("DELETE FROM olimpiada_voluntario_disciplina WHERE voluntario_id = ? AND olimpiada_id = ?", [voluntarioId, olimpiadaId]);
  for (const disciplinaId of ids) await connection.query(
    "INSERT INTO olimpiada_voluntario_disciplina (voluntario_id, olimpiada_id, disciplina_id) VALUES (?, ?, ?)",
    [voluntarioId, olimpiadaId, disciplinaId]);
}

function registrarCambio(connection, { cabecera, id, olimpiadaId, operacion, anterior, nuevo, observacion }) {
  return registrarHistorial(connection, {
    entidad: "VOLUNTARIO", entidad_id: id, olimpiada_id: olimpiadaId,
    usuario_id: cabecera.id, usuario_rol: cabecera.rol, tipo_operacion: operacion,
    campo_modificado: "voluntario", valor_anterior: anterior ? JSON.stringify(anterior) : null,
    valor_nuevo: nuevo ? JSON.stringify(nuevo) : null, observacion,
  });
}

async function enviarBienvenida({ db, voluntarioId, olimpiada, cabecera, enviar }) {
  // La clave existe en memoria sólo durante este envío. Ante un rechazo SMTP,
  // rollback conserva la clave anterior; ningún listado ni historial guarda claves.
  const password = `AJB!${crypto.randomBytes(15).toString("base64url")}9a`;
  const passwordHash = await bcrypt.hash(password, 12);
  return transaccion(db, async (connection) => {
    const v = await cargarCuentaVoluntario(connection, voluntarioId, true);
    if (!v || Number(v.habilitado) !== 1) throw crearErrorHttp("La cuenta no existe o está deshabilitada", 400);
    if (esCorreoInterno(v.email)) throw crearErrorHttp("La cuenta no tiene correo: pasale el usuario y la contraseña en persona, o cargale un correo para enviarle la invitación.", 400);
    if (!esCorreoValido(v.email || "") || /[,;\r\n]/.test(v.email)) throw crearErrorHttp("La cuenta necesita un correo válido para enviar la invitación. Actualizalo desde Usuarios.", 400);
    const ediciones = await asignacionesDe(connection, voluntarioId);
    const asignacion = ediciones.find((e) => e.olimpiada_id === Number(olimpiada.id));
    if (!asignacion) throw crearErrorHttp("El veedor no tiene disciplinas asignadas en esta olimpiada", 400);
    const respuesta = await enviar({
      para: v.email, autenticacion: true,
      asunto: `Sos veedor de ${olimpiada.nombre}`,
      titulo: "¡Gracias por acompañar las Olimpiadas!", saludo: `Hola, ${v.nombre}:`,
      previsualizacion: "Tu acceso como veedor y las disciplinas que tenés a cargo.",
      parrafos: [
        `Te damos la bienvenida al equipo de veedores de ${olimpiada.nombre}.`,
        "Vas a ver sólo los partidos de tus disciplinas. Durante las fechas del evento cargás los resultados desde el teléfono; antes y después podés consultarlos.",
        v.usuario_sistema_id ? "Entrá a Mi AJB con tu documento y tu contraseña de siempre, andá a Olimpiadas y presioná el botón «Veedor»." : "Esta es tu nueva contraseña de acceso; reemplaza cualquier contraseña anterior.",
      ],
      datos: [
        { etiqueta: "Usuario", valor: v.usuario }, { etiqueta: "Correo", valor: v.email },
        ...(v.usuario_sistema_id ? [] : [{ etiqueta: "Nueva contraseña", valor: password }]),
        { etiqueta: "Disciplinas asignadas", valor: asignacion.disciplinas.map((d) => d.nombre).join(", ") },
        { etiqueta: "Fechas del evento", valor: `${String(olimpiada.fecha_inicio).slice(0, 10)} al ${String(olimpiada.fecha_fin).slice(0, 10)}` },
      ],
      boton: { texto: "Ingresar como veedor", url: urlAplicacion("/olimpiadas-veedores") },
    });
    if (!respuesta?.enviado) throw crearErrorHttp("No se pudo enviar el correo. La contraseña anterior sigue vigente.", 503);
    if (v.usuario_sistema_id) await connection.query("UPDATE olimpiada_voluntario SET ultimo_correo_en=NOW() WHERE id=?", [voluntarioId]);
    else await connection.query("UPDATE olimpiada_voluntario SET password_hash = ?, sesion_version = sesion_version + 1, ultimo_correo_en = NOW() WHERE id = ?", [passwordHash, voluntarioId]);
    await registrarCambio(connection, {
      cabecera, id: voluntarioId, olimpiadaId: olimpiada.id, operacion: "UPDATE",
      observacion: v.usuario_sistema_id ? `Invitación enviada a ${v.email}; conserva su contraseña habitual de Mi AJB.` : `Bienvenida enviada a ${v.email}; nueva contraseña generada y sesiones anteriores cerradas.`,
    });
    return { id: voluntarioId, enviado: true, mensaje: v.usuario_sistema_id ? "Invitación enviada; usa su contraseña habitual" : "Bienvenida enviada con una nueva contraseña" };
  });
}

function crearRouterVoluntarios({ db = mysqlConnection.promise(), jwtSecret = process.env.JWT_SECRET,
  verificarAdmin = verifyToken, enviar = enviarCorreoPlantilla, limitador = limitar, webauthnLib, origenesPermitidos } = {}) {
  const router = express.Router();
  const manejar = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      if (error.code === "PASSWORD_POLICY") return res.status(400).json({ mensaje:error.message,code:error.code,politicaPassword:error.politicaPassword });
      if (error.code === "ER_DUP_ENTRY") return res.status(409).json("Ya existe un veedor con ese usuario o correo. Buscalo para reutilizarlo.");
      if (!error.statusCode) console.error("[olimpiadas-voluntarios] Operación fallida:", error.code || "error_interno");
      res.status(error.statusCode || 500).json(error.statusCode ? error.message : "No pudimos completar la operación de veedores");
    }
  };
  const admin = (req, res, next) => {
    if (!esSuperior(getCabecera(req))) return res.status(403).json("Sólo la administración provincial puede gestionar veedores");
    next();
  };

  registrarAccesoVoluntarios({ router, db, jwtSecret, enviar, manejar, limitador, cuentaPublica, asignacionesDe, webauthnLib, origenesPermitidos });

  router.get("/olimpiadas/voluntarios/me", manejar(async (req, res) => {
    const bearer = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ""));
    if (!bearer) throw crearErrorHttp("Ingresá con tu usuario de veedor", 401);
    const v = await autenticarVoluntario({ token: bearer[1], db, jwtSecret });
    res.set("Cache-Control", "no-store");
    res.json({ voluntario: cuentaPublica(v), asignaciones: await asignacionesDe(db, v.voluntario_id) });
  }));

  // ---- Veedores que ya tienen cuenta en Mi AJB: entran desde Olimpiadas, sin otro usuario ni otra clave ----
  async function veedorDeLaSesion(req) {
    const cabecera = getCabecera(req);
    const usuarioId = normalizarIdPositivo(cabecera.id);
    if (!usuarioId) return null;
    const [rows] = await db.query("SELECT id FROM olimpiada_voluntario WHERE usuario_sistema_id = ? AND habilitado = 1 LIMIT 1", [usuarioId]);
    return rows[0] ? Number(rows[0].id) : null;
  }

  // ¿La persona que está usando Mi AJB es veedora? Decide si se le muestra el botón «Veedor».
  router.get("/olimpiadas/veedor/mi-acceso", verificarAdmin, manejar(async (req, res) => {
    const voluntarioId = await veedorDeLaSesion(req);
    const asignaciones = voluntarioId ? await asignacionesDe(db, voluntarioId) : [];
    res.set("Cache-Control", "no-store");
    res.json({ es_veedor: asignaciones.length > 0, asignaciones });
  }));

  // Abre la sesión de veedor de quien ya inició sesión en Mi AJB. La sesión sigue siendo la limitada:
  // sólo los partidos de sus disciplinas, con las mismas comprobaciones que el ingreso con contraseña.
  router.post("/olimpiadas/veedor/ingresar", verificarAdmin, manejar(async (req, res) => {
    const cabecera = getCabecera(req);
    await limitador(db, `voluntarios:desde-mi-ajb:${cabecera.id}`, 60, 900, jwtSecret);
    const voluntarioId = await veedorDeLaSesion(req);
    if (!voluntarioId) throw crearErrorHttp("Tu cuenta no está asignada como veedor. Pedile a la organización que te asigne una disciplina.", 403);
    const cuenta = await cargarCuentaVoluntario(db, voluntarioId);
    if (!cuenta || Number(cuenta.habilitado) !== 1 || Number(cuenta.usuario_sistema_id) !== Number(cabecera.id)) {
      throw crearErrorHttp("Tu acceso de veedor no está habilitado.", 403);
    }
    const asignaciones = await asignacionesDe(db, voluntarioId);
    if (!asignaciones.length) throw crearErrorHttp("Todavía no tenés disciplinas asignadas como veedor.", 403);
    const sesion = await crearSesionVoluntario({ db, cuenta, recordar: false, jwtSecret });
    res.set("Cache-Control", "no-store");
    res.json({ ...sesion, voluntario: cuentaPublica(cuenta), asignaciones });
  }));

  router.get("/olimpiadas/:id/voluntarios", verificarAdmin, admin, manejar(async (req, res) => {
    const olimpiada = await obtenerEdicion(db, req.params.id);
    const q = String(req.query.q || "").trim().slice(0, 160);
    const [cuentas] = await db.query(`SELECT v.id, CASE WHEN u.id IS NULL THEN v.nombre ELSE CONCAT_WS(' ',u.nombre,u.apellido) END AS nombre,
      CASE WHEN u.id IS NULL THEN v.usuario ELSE CAST(u.documento AS CHAR) END AS usuario,
      CASE WHEN u.id IS NULL THEN IF(v.email LIKE '%@cuentas.internas.invalid', '', v.email) ELSE u.email END AS email,
      v.habilitado, v.ultimo_correo_en, v.fecha_creacion, v.usuario_sistema_id
      FROM olimpiada_voluntario v LEFT JOIN usuario u ON u.id=v.usuario_sistema_id
      WHERE (? = '' OR v.nombre LIKE ? OR v.usuario LIKE ? OR v.email LIKE ? OR CONCAT_WS(' ',u.nombre,u.apellido,u.documento,u.email) LIKE ?)
      ORDER BY nombre, v.id LIMIT 500`, [q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]);
    const [asignaciones] = await db.query(`SELECT a.voluntario_id, a.disciplina_id, d.nombre
      FROM olimpiada_voluntario_disciplina a INNER JOIN olimpiada_disciplina d ON d.id = a.disciplina_id AND d.habilitado = 'Y'
      INNER JOIN olimpiada_disciplina_config c ON c.olimpiada_id = a.olimpiada_id AND c.disciplina_id = a.disciplina_id
      WHERE a.olimpiada_id = ? ORDER BY d.nombre`, [olimpiada.id]);
    res.set("Cache-Control", "no-store");
    res.json(cuentas.map((v) => {
      const disciplinas = asignaciones.filter((a) => Number(a.voluntario_id) === Number(v.id)).map((a) => ({ id: Number(a.disciplina_id), nombre: a.nombre }));
      return { ...v, cuenta_sistema: Boolean(v.usuario_sistema_id), disciplinas, asignado: disciplinas.length > 0 };
    }));
  }));

  router.post("/olimpiadas/:id/voluntarios", verificarAdmin, admin, manejar(async (req, res) => {
    const olimpiada = await obtenerEdicion(db, req.params.id);
    const cuenta = normalizarCuenta(req.body || {});
    const ids = leerIds(req.body?.disciplina_ids, "las disciplinas", { permiteVacio: true });
    const hash = await bcrypt.hash(req.body.password, 12);
    const id = await transaccion(db, async (connection) => {
      await validarDisciplinas(connection, olimpiada.id, ids);
      const [result] = await connection.query("INSERT INTO olimpiada_voluntario (nombre, usuario, email, password_hash, habilitado, creado_por_usuario_id) VALUES (?, ?, ?, ?, ?, ?)",
        [cuenta.nombre, cuenta.usuario, cuenta.email, hash, cuenta.habilitado, getCabecera(req).id]);
      await reemplazarAsignaciones(connection, result.insertId, olimpiada.id, ids);
      await registrarCambio(connection, { cabecera: getCabecera(req), id: result.insertId, olimpiadaId: olimpiada.id,
        operacion: "CREATE", nuevo: { ...cuenta, disciplina_ids: ids }, observacion: "Veedor creado. El correo de bienvenida se envía sólo por acción expresa del administrador." });
      return result.insertId;
    });
    res.status(201).json({ success: true, id, message: "Veedor creado y disciplinas asignadas" });
  }));

  router.get("/olimpiadas/:id/usuarios-disponibles", verificarAdmin, admin, manejar(async (req, res) => {
    await obtenerEdicion(db, req.params.id);
    const q = String(req.query.q || "").trim().slice(0,160);
    if (q.length<2) return res.json([]);
    const [rows] = await db.query(`SELECT u.id,u.nombre,u.apellido,u.documento,u.email,r.nombre AS rol,v.id AS voluntario_id
      FROM usuario u INNER JOIN rol r ON r.id=u.rol_id LEFT JOIN olimpiada_voluntario v ON v.usuario_sistema_id=u.id
      WHERE u.rol_id<>4 AND LOWER(r.nombre)<>'invitado' AND UPPER(COALESCE(u.habilitado,'S')) NOT IN ('N','NO','0','FALSE')
      AND COALESCE(u.bloqueo_tipo,'')<>'total' AND u.password IS NOT NULL
      AND CONCAT_WS(' ',u.nombre,u.apellido,u.documento,u.email) LIKE ? ORDER BY u.apellido,u.nombre LIMIT 50`, [`%${q}%`]);
    res.set("Cache-Control","no-store"); res.json(rows);
  }));

  router.post("/olimpiadas/:id/voluntarios/vincular", verificarAdmin, admin, manejar(async (req,res) => {
    const olimpiada = await obtenerEdicion(db,req.params.id);
    const usuarioId = normalizarIdPositivo(req.body?.usuario_sistema_id);
    if (!usuarioId) throw crearErrorHttp("Seleccioná una cuenta del sistema");
    const ids = leerIds(req.body?.disciplina_ids,"las disciplinas",{permiteVacio:true});
    const id = await transaccion(db,async(cx) => {
      const [usuarios] = await cx.query(`SELECT u.id,u.nombre,u.apellido,u.email,u.documento,u.habilitado,u.rol_id,u.password,
        u.bloqueo_tipo,u.bloqueo_modulos,u.bloqueo_mensaje,r.nombre AS rol FROM usuario u INNER JOIN rol r ON r.id=u.rol_id
        WHERE u.id=? LIMIT 1 FOR UPDATE`,[usuarioId]);
      const u=usuarios[0];
      if(!u || !usuarioHabilitado(u.habilitado) || Number(u.rol_id)===4 || String(u.rol).toLowerCase()==="invitado" || !u.password) throw crearErrorHttp("La cuenta no está habilitada para ser veedora",400);
      exigirAccesoCuenta(u);
      await validarDisciplinas(cx,olimpiada.id,ids);
      const [existentes] = await cx.query("SELECT id FROM olimpiada_voluntario WHERE usuario_sistema_id=? FOR UPDATE",[usuarioId]);
      let voluntarioId=existentes[0]?.id;
      if(!voluntarioId) {
        // Este hash aleatorio no se utiliza: la autenticación siempre verifica la cuenta original.
        // La dirección interna tampoco se envía: el correo se lee de usuario.
        // Así una familia/equipo con correo compartido puede usar su DNI individual.
        const hash=await bcrypt.hash(crypto.randomBytes(32).toString("base64url"),12);
        const [r]=await cx.query("INSERT INTO olimpiada_voluntario (nombre,usuario,email,password_hash,habilitado,creado_por_usuario_id,usuario_sistema_id) VALUES (?,?,?,?,1,?,?)",
          [`${u.nombre||""} ${u.apellido||""}`.trim(),`miajb-${u.id}`,`miajb-${u.id}@cuentas.internas.invalid`,hash,getCabecera(req).id,u.id]);
        voluntarioId=r.insertId;
      } else await cx.query("UPDATE olimpiada_voluntario SET habilitado=1,sesion_version=sesion_version+1 WHERE id=?",[voluntarioId]);
      await reemplazarAsignaciones(cx,voluntarioId,olimpiada.id,ids);
      await registrarCambio(cx,{cabecera:getCabecera(req),id:voluntarioId,olimpiadaId:olimpiada.id,operacion:existentes.length?"UPDATE":"CREATE",
        nuevo:{usuario_sistema_id:u.id,disciplina_ids:ids},observacion:"Cuenta de Mi AJB vinculada como veedora; conserva su contraseña y rol habituales."});
      return voluntarioId;
    });
    res.status(201).json({success:true,id,message:"Cuenta vinculada y disciplinas asignadas"});
  }));

  router.put("/olimpiadas/:id/voluntarios/:voluntarioId", verificarAdmin, admin, manejar(async (req, res) => {
    const olimpiada = await obtenerEdicion(db, req.params.id);
    const voluntarioId = normalizarIdPositivo(req.params.voluntarioId);
    if (!voluntarioId) throw crearErrorHttp("El veedor no es válido");
    const ids = leerIds(req.body?.disciplina_ids, "las disciplinas", { permiteVacio: true });
    const cambiaPassword = req.body?.password !== undefined && req.body.password !== "";
    if (cambiaPassword) validarPasswordVeedor(req.body.password);
    const hash = cambiaPassword ? await bcrypt.hash(req.body.password, 12) : null;
    await transaccion(db, async (connection) => {
      const [rows] = await connection.query("SELECT id, nombre, usuario, email, habilitado, usuario_sistema_id FROM olimpiada_voluntario WHERE id = ? FOR UPDATE", [voluntarioId]);
      if (!rows[0]) throw crearErrorHttp("No encontramos ese veedor", 404);
      if (rows[0].usuario_sistema_id && ["nombre","usuario","email","password"].some(c=>req.body?.[c]!==undefined)) throw crearErrorHttp("Esta cuenta conserva los datos y contraseña del sistema. Editá sólo su habilitación y disciplinas.",400);
      const cuenta = normalizarCuenta(req.body || {}, rows[0]);
      await validarDisciplinas(connection, olimpiada.id, ids);
      const [anteriores] = await connection.query("SELECT disciplina_id FROM olimpiada_voluntario_disciplina WHERE voluntario_id = ? AND olimpiada_id = ?", [voluntarioId, olimpiada.id]);
      await connection.query(`UPDATE olimpiada_voluntario SET nombre = ?, usuario = ?, email = ?, habilitado = ?,
        password_hash = COALESCE(?, password_hash), sesion_version = sesion_version + 1 WHERE id = ?`,
      [cuenta.nombre, cuenta.usuario, cuenta.email, cuenta.habilitado, hash, voluntarioId]);
      await reemplazarAsignaciones(connection, voluntarioId, olimpiada.id, ids);
      await registrarCambio(connection, { cabecera: getCabecera(req), id: voluntarioId, olimpiadaId: olimpiada.id,
        operacion: "UPDATE", anterior: { ...rows[0], disciplina_ids: anteriores.map((a) => Number(a.disciplina_id)) },
        nuevo: { ...cuenta, disciplina_ids: ids }, observacion: cambiaPassword ? "Cuenta y asignaciones actualizadas; contraseña restablecida por administración." : "Cuenta y disciplinas asignadas actualizadas." });
    });
    res.json({ success: true, id: voluntarioId, message: "Veedor actualizado" });
  }));

  router.post("/olimpiadas/:id/voluntarios/enviar-bienvenida", verificarAdmin, admin, manejar(async (req, res) => {
    const olimpiada = await obtenerEdicion(db, req.params.id);
    const ids = leerIds(req.body?.voluntario_ids, "los veedores");
    const cabecera = getCabecera(req);
    await limitador(db, `voluntarios:bienvenida:admin:${cabecera.id}`, 20, 3600, jwtSecret);
    const resultados = [];
    for (const id of ids) {
      try { resultados.push(await enviarBienvenida({ db, voluntarioId: id, olimpiada, cabecera, enviar })); }
      catch (error) {
        resultados.push({ id, enviado: false, mensaje: error.statusCode ? error.message : "No se pudo completar el envío; volvé a intentar." });
      }
    }
    const enviados = resultados.filter((r) => r.enviado).length;
    res.json({ success: enviados === ids.length, enviados, fallidos: ids.length - enviados, resultados });
  }));
  return router;
}

module.exports = crearRouterVoluntarios();
module.exports.crearRouterVoluntarios = crearRouterVoluntarios;
module.exports.__test = { normalizarCuenta, leerIds, asignacionesDe, cuentaPublica, enviarBienvenida, validarDisciplinas };
