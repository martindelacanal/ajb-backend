"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mysqlConnection = require("../connection/connection");
const { enviarCorreoPlantilla, urlAplicacion } = require("../services/correo");
const { esCorreoValido } = require("../services/correo/config");
const { validarPassword } = require("../security/password-policy");
const { limitar } = require("../security/recuperacion-password");
const {
  verifyToken, getCabecera, esSuperior, crearErrorHttp, normalizarIds,
  normalizarIdPositivo, normalizarBooleano01, registrarHistorial,
} = require("../services/olimpiadas-comun");
const {
  autenticarVoluntario, crearTokenVoluntario, puedeEditarEdicion,
} = require("../security/olimpiadas-voluntarios");

// Compara también cuentas inexistentes con bcrypt para evitar diferencias obvias
// de coste. Este hash es ficticio y nunca permite autenticar a una persona.
const HASH_FICTICIO = "$2a$12$5WoEYBFTIUBIirQmH.M9BuQ3csYvrZlCZZh3uT7ld3vPvVYpBpD1O";

function normalizarCuenta(body, actual = null) {
  const nombre = String(body.nombre ?? actual?.nombre ?? "").trim();
  const usuario = String(body.usuario ?? actual?.usuario ?? "").trim().toLowerCase();
  const email = String(body.email ?? actual?.email ?? "").trim().toLowerCase();
  if (!nombre || nombre.length > 160) throw crearErrorHttp("Ingresá un nombre de hasta 160 caracteres");
  if (!/^[a-z0-9][a-z0-9._-]{2,59}$/.test(usuario)) {
    throw crearErrorHttp("El usuario debe tener entre 3 y 60 letras, números, puntos, guiones o guiones bajos");
  }
  if (!esCorreoValido(email) || email.length > 254 || /[,;\r\n]/.test(email)) throw crearErrorHttp("Ingresá un correo electrónico válido");
  const habilitado = body.habilitado === undefined ? Number(actual?.habilitado ?? 1) : normalizarBooleano01(body.habilitado);
  if (habilitado === null) throw crearErrorHttp("Indicá si el acceso está habilitado");
  if (!actual || (body.password !== undefined && body.password !== "")) validarPassword(body.password, "personal");
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
      o.nombre AS olimpiada_titulo, o.fecha_inicio, o.fecha_fin, o.habilitado, o.eliminado
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

function cuentaPublica(v) { return { id: Number(v.id ?? v.voluntario_id), nombre: v.nombre, usuario: v.usuario, email: v.email }; }

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
    const [rows] = await connection.query("SELECT id, nombre, usuario, email, habilitado FROM olimpiada_voluntario WHERE id = ? FOR UPDATE", [voluntarioId]);
    const v = rows[0];
    if (!v || Number(v.habilitado) !== 1) throw crearErrorHttp("La cuenta no existe o está deshabilitada", 400);
    const ediciones = await asignacionesDe(connection, voluntarioId);
    const asignacion = ediciones.find((e) => e.olimpiada_id === Number(olimpiada.id));
    if (!asignacion) throw crearErrorHttp("El colaborador no tiene disciplinas asignadas en esta olimpiada", 400);
    const respuesta = await enviar({
      para: v.email, autenticacion: true,
      asunto: `Bienvenida al equipo de ${olimpiada.nombre}`,
      titulo: "¡Gracias por acompañar las Olimpiadas!", saludo: `Hola, ${v.nombre}:`,
      previsualizacion: "Tu acceso y disciplinas asignadas para colaborar con los resultados.",
      parrafos: [
        `Te damos la bienvenida al equipo de colaboración de ${olimpiada.nombre}.`,
        "Podés consultar los partidos de tus disciplinas. Durante las fechas del evento también podés crear partidos y actualizar resultados. Al finalizar, tu acceso continúa en modo lectura.",
        "Esta es tu nueva contraseña de acceso; reemplaza cualquier contraseña anterior. Guardala en un lugar seguro.",
      ],
      datos: [
        { etiqueta: "Usuario", valor: v.usuario }, { etiqueta: "Correo", valor: v.email },
        { etiqueta: "Nueva contraseña", valor: password },
        { etiqueta: "Disciplinas asignadas", valor: asignacion.disciplinas.map((d) => d.nombre).join(", ") },
        { etiqueta: "Fechas del evento", valor: `${String(olimpiada.fecha_inicio).slice(0, 10)} al ${String(olimpiada.fecha_fin).slice(0, 10)}` },
      ],
      boton: { texto: "Ingresar como colaborador", url: urlAplicacion("/olimpiadas-colaboradores") },
    });
    if (!respuesta?.enviado) throw crearErrorHttp("No se pudo enviar el correo. La contraseña anterior sigue vigente.", 503);
    await connection.query("UPDATE olimpiada_voluntario SET password_hash = ?, sesion_version = sesion_version + 1, ultimo_correo_en = NOW() WHERE id = ?", [passwordHash, voluntarioId]);
    await registrarCambio(connection, {
      cabecera, id: voluntarioId, olimpiadaId: olimpiada.id, operacion: "UPDATE",
      observacion: `Bienvenida enviada a ${v.email}; nueva contraseña generada y sesiones anteriores cerradas.`,
    });
    return { id: voluntarioId, enviado: true, mensaje: "Bienvenida enviada con una nueva contraseña" };
  });
}

function crearRouterVoluntarios({ db = mysqlConnection.promise(), jwtSecret = process.env.JWT_SECRET,
  verificarAdmin = verifyToken, enviar = enviarCorreoPlantilla, limitador = limitar } = {}) {
  const router = express.Router();
  const manejar = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      if (error.code === "ER_DUP_ENTRY") return res.status(409).json("Ya existe un colaborador con ese usuario o correo. Buscalo para reutilizarlo.");
      if (!error.statusCode) console.error("[olimpiadas-voluntarios] Operación fallida:", error.code || "error_interno");
      res.status(error.statusCode || 500).json(error.statusCode ? error.message : "No pudimos completar la operación de colaboradores");
    }
  };
  const admin = (req, res, next) => {
    if (!esSuperior(getCabecera(req))) return res.status(403).json("Sólo la administración provincial puede gestionar colaboradores");
    next();
  };

  router.post("/olimpiadas/voluntarios/login", manejar(async (req, res) => {
    const identificador = typeof req.body?.identificador === "string" ? req.body.identificador.trim().toLowerCase() : "";
    await limitador(db, `voluntarios:login:ip:${req.ip}`, 60, 900, jwtSecret);
    await limitador(db, `voluntarios:login:cuenta:${identificador.slice(0, 254)}`, 15, 900, jwtSecret);
    if (!identificador || identificador.length > 254 || typeof req.body?.password !== "string" || Buffer.byteLength(req.body.password) > 72) {
      throw crearErrorHttp("Usuario o contraseña incorrectos", 401);
    }
    const [rows] = await db.query("SELECT id, nombre, usuario, email, password_hash, habilitado, sesion_version FROM olimpiada_voluntario WHERE usuario = ? OR email = ? LIMIT 2", [identificador, identificador]);
    const v = rows.length === 1 ? rows[0] : null;
    const valido = await bcrypt.compare(req.body.password, v?.password_hash || HASH_FICTICIO);
    if (!v || !valido || Number(v.habilitado) !== 1) throw crearErrorHttp("Usuario o contraseña incorrectos", 401);
    const asignaciones = await asignacionesDe(db, v.id);
    if (!asignaciones.length) throw crearErrorHttp("No tenés disciplinas asignadas. Contactá a la organización de las Olimpiadas.", 403);
    res.set("Cache-Control", "no-store");
    res.json({ token: crearTokenVoluntario(v, jwtSecret), voluntario: cuentaPublica(v), asignaciones });
  }));

  router.get("/olimpiadas/voluntarios/me", manejar(async (req, res) => {
    const bearer = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ""));
    if (!bearer) throw crearErrorHttp("Ingresá con tu usuario de colaboración", 401);
    const v = await autenticarVoluntario({ token: bearer[1], db, jwtSecret });
    res.set("Cache-Control", "no-store");
    res.json({ voluntario: cuentaPublica(v), asignaciones: await asignacionesDe(db, v.voluntario_id) });
  }));

  router.get("/olimpiadas/:id/voluntarios", verificarAdmin, admin, manejar(async (req, res) => {
    const olimpiada = await obtenerEdicion(db, req.params.id);
    const q = String(req.query.q || "").trim().slice(0, 160);
    const [cuentas] = await db.query(`SELECT id, nombre, usuario, email, habilitado, ultimo_correo_en,
      fecha_creacion FROM olimpiada_voluntario
      WHERE (? = '' OR nombre LIKE ? OR usuario LIKE ? OR email LIKE ?)
      ORDER BY nombre, id LIMIT 500`, [q, `%${q}%`, `%${q}%`, `%${q}%`]);
    const [asignaciones] = await db.query(`SELECT a.voluntario_id, a.disciplina_id, d.nombre
      FROM olimpiada_voluntario_disciplina a INNER JOIN olimpiada_disciplina d ON d.id = a.disciplina_id
      INNER JOIN olimpiada_disciplina_config c ON c.olimpiada_id = a.olimpiada_id AND c.disciplina_id = a.disciplina_id
      WHERE a.olimpiada_id = ? ORDER BY d.nombre`, [olimpiada.id]);
    res.set("Cache-Control", "no-store");
    res.json(cuentas.map((v) => {
      const disciplinas = asignaciones.filter((a) => Number(a.voluntario_id) === Number(v.id)).map((a) => ({ id: Number(a.disciplina_id), nombre: a.nombre }));
      return { ...v, disciplinas, asignado: disciplinas.length > 0 };
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
        operacion: "CREATE", nuevo: { ...cuenta, disciplina_ids: ids }, observacion: "Colaborador creado. El correo de bienvenida se envía sólo por acción expresa del administrador." });
      return result.insertId;
    });
    res.status(201).json({ success: true, id, message: "Colaborador creado y disciplinas asignadas" });
  }));

  router.put("/olimpiadas/:id/voluntarios/:voluntarioId", verificarAdmin, admin, manejar(async (req, res) => {
    const olimpiada = await obtenerEdicion(db, req.params.id);
    const voluntarioId = normalizarIdPositivo(req.params.voluntarioId);
    if (!voluntarioId) throw crearErrorHttp("El colaborador no es válido");
    const ids = leerIds(req.body?.disciplina_ids, "las disciplinas", { permiteVacio: true });
    const cambiaPassword = req.body?.password !== undefined && req.body.password !== "";
    if (cambiaPassword) validarPassword(req.body.password, "personal");
    const hash = cambiaPassword ? await bcrypt.hash(req.body.password, 12) : null;
    await transaccion(db, async (connection) => {
      const [rows] = await connection.query("SELECT id, nombre, usuario, email, habilitado FROM olimpiada_voluntario WHERE id = ? FOR UPDATE", [voluntarioId]);
      if (!rows[0]) throw crearErrorHttp("No encontramos ese colaborador", 404);
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
    res.json({ success: true, id: voluntarioId, message: "Colaborador actualizado" });
  }));

  router.post("/olimpiadas/:id/voluntarios/enviar-bienvenida", verificarAdmin, admin, manejar(async (req, res) => {
    const olimpiada = await obtenerEdicion(db, req.params.id);
    const ids = leerIds(req.body?.voluntario_ids, "los colaboradores");
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
