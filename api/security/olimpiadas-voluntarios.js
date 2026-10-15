"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mysqlConnection = require("../connection/connection");
const { verifyToken, crearErrorHttp, normalizarIdPositivo, fechaHoyBuenosAires } = require("../services/olimpiadas-comun");
const { normalizarFechaCivil } = require("../services/valores-dominio");
const { huellaPassword, igualesSeguros } = require("./auth-crypto");
const { usuarioHabilitado } = require("./autorizacion-sesion");
const { exigirAccesoCuenta, exigirOperacionCuenta } = require("./restricciones-cuenta");

const AUDIENCIA = "ajb:olimpiadas:voluntarios";
const ROL = "olimpiadas-voluntario";

// Un token de colaboración nunca verifica con JWT_SECRET: incluso los handlers
// legados que sólo verifican una firma quedan fuera de este acceso limitado.
function secretoVoluntarios(secret = process.env.JWT_SECRET) {
  if (!secret) throw new Error("Falta JWT_SECRET");
  return crypto.createHmac("sha256", secret).update("ajb:olimpiadas:voluntarios:v1").digest();
}

function crearTokenVoluntario(voluntario, secret = process.env.JWT_SECRET, sid = null) {
  return jwt.sign({ tipo: ROL, version: Number(voluntario.sesion_version), ...(sid ? { sid } : {}) }, secretoVoluntarios(secret), {
    algorithm: "HS256", audience: AUDIENCIA, issuer: "mi-ajb", subject: String(voluntario.id), expiresIn: "8h",
  });
}

async function cargarCuentaVoluntario(db, id, bloquear = false) {
  const consulta = `SELECT id, nombre, usuario, email, password_hash, habilitado, sesion_version, usuario_sistema_id
    FROM olimpiada_voluntario WHERE id = ? LIMIT 1`;
  let [rows] = await db.query(consulta, [id]);
  let v = rows[0];
  if (!v) return null;
  if (v.usuario_sistema_id) {
    const [usuarios] = await db.query(`SELECT u.id, u.nombre, u.apellido, u.documento, u.email, u.password,
      u.habilitado, u.rol_id, r.nombre AS rol, u.auth_revocado_desde, u.bloqueo_tipo,
      u.bloqueo_modulos, u.bloqueo_mensaje, u.requiere_cambio_clave
      FROM usuario u INNER JOIN rol r ON r.id=u.rol_id WHERE u.id=? LIMIT 1${bloquear ? " FOR UPDATE" : ""}`, [v.usuario_sistema_id]);
    const u = usuarios[0];
    if (!u || !usuarioHabilitado(u.habilitado) || Number(u.rol_id) === 4
      || String(u.rol).toLowerCase() === "invitado") throw crearErrorHttp("La cuenta del sistema vinculada ya no tiene acceso de colaboración", 401);
    exigirAccesoCuenta(u);
    if (Number(u.requiere_cambio_clave) === 1) throw crearErrorHttp("Ingresá a Mi AJB para actualizar tu contraseña habitual antes de colaborar.", 403);
    if (bloquear) {
      // Orden compartido con vinculación: usuario habitual, después colaboración.
      [rows] = await db.query(`${consulta} FOR UPDATE`, [id]);
      v = rows[0];
      if (!v || Number(v.usuario_sistema_id)!==Number(u.id)) throw crearErrorHttp("El vínculo de la cuenta cambió. Volvé a ingresar.", 401);
    }
    Object.assign(v, { nombre: `${u.nombre || ""} ${u.apellido || ""}`.trim(), usuario: String(u.documento), email: u.email,
      password_hash: u.password, usuario_sistema: u });
  } else if (bloquear) { [rows] = await db.query(`${consulta} FOR UPDATE`, [id]); v = rows[0]; }
  return v;
}

function esVoluntario(cabecera) { return cabecera?.rol === ROL; }

function puedeEditarEdicion(olimpiada, hoy = fechaHoyBuenosAires()) {
  const inicio = normalizarFechaCivil(olimpiada?.fecha_inicio);
  const fin = normalizarFechaCivil(olimpiada?.fecha_fin);
  return Boolean(inicio && fin && inicio <= hoy && hoy <= fin
    && Number(olimpiada?.eliminado || 0) === 0 && olimpiada?.habilitado === "Y");
}

async function autenticarVoluntario({ token, db, jwtSecret = process.env.JWT_SECRET }) {
  let payload;
  try {
    payload = jwt.verify(token, secretoVoluntarios(jwtSecret), {
      algorithms: ["HS256"], audience: AUDIENCIA, issuer: "mi-ajb",
    });
  } catch (_error) { throw crearErrorHttp("Tu sesión de colaboración venció o no es válida. Volvé a ingresar.", 401); }
  const id = normalizarIdPositivo(payload.sub);
  if (!id || payload.tipo !== ROL || !Number.isSafeInteger(payload.version)) {
    throw crearErrorHttp("La sesión de colaboración no es válida", 401);
  }
  const v = await cargarCuentaVoluntario(db, id);
  if (!v || Number(v.habilitado) !== 1 || Number(v.sesion_version) !== payload.version) {
    throw crearErrorHttp("Tu acceso de colaboración fue actualizado o deshabilitado. Volvé a ingresar.", 401);
  }
  if (payload.sid) {
    if (!/^[a-f0-9-]{36}$/.test(payload.sid)) throw crearErrorHttp("La sesión no es válida", 401);
    const [sesiones] = await db.query(`SELECT id, password_version FROM olimpiada_voluntario_sesion
      WHERE id=? AND voluntario_id=? AND sesion_version=? AND revocado_en IS NULL
      AND (vence_en IS NULL OR vence_en>NOW(6)) AND (? IS NULL OR creada_en>?) LIMIT 1`,
    [payload.sid, id, payload.version, v.usuario_sistema?.auth_revocado_desde || null, v.usuario_sistema?.auth_revocado_desde || null]);
    if (!sesiones[0] || !igualesSeguros(sesiones[0].password_version, huellaPassword(v.password_hash, jwtSecret))) throw crearErrorHttp("Tu sesión fue cerrada. Volvé a ingresar.", 401);
  } else if (v.usuario_sistema_id) throw crearErrorHttp("Volvé a ingresar con tu cuenta vinculada", 401);
  return { id: null, rol: ROL, voluntario_id: Number(v.id), nombre: v.nombre, usuario: v.usuario, email: v.email,
    usuario_sistema_id: v.usuario_sistema_id || null, cuenta_sistema: Boolean(v.usuario_sistema_id),
    sesion_version: Number(v.sesion_version), sesion_id: payload.sid || null,
    ...(v.usuario_sistema ? { bloqueo_tipo: v.usuario_sistema.bloqueo_tipo, bloqueo_modulos: v.usuario_sistema.bloqueo_modulos, bloqueo_mensaje: v.usuario_sistema.bloqueo_mensaje } : {}) };
}

function crearVerificadorCompeticion({ db = mysqlConnection.promise(), jwtSecret = process.env.JWT_SECRET, verificarNormal = verifyToken } = {}) {
  return async function verificarAccesoCompeticion(req, res, next) {
    const bearer = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ""));
    const payload = bearer ? jwt.decode(bearer[1]) : null;
    if (payload?.aud !== AUDIENCIA) return verificarNormal(req, res, next);
    try {
      const cabecera = await autenticarVoluntario({ token: bearer[1], db, jwtSecret });
      exigirOperacionCuenta(cabecera, req);
      req.data = { data: JSON.stringify(cabecera) };
      return next();
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.statusCode ? error.message : "No pudimos verificar el acceso de colaboración");
    }
  };
}

async function exigirEdicionVoluntario({ db, cabecera, olimpiadaId, escritura = false, hoy = fechaHoyBuenosAires() }) {
  if (!esVoluntario(cabecera)) return null;
  const id = normalizarIdPositivo(olimpiadaId);
  const voluntarioId = normalizarIdPositivo(cabecera.voluntario_id);
  if (!id || !voluntarioId) throw crearErrorHttp("No tenés acceso a esta olimpiada", 403);
  const [rows] = await db.query(`SELECT a.disciplina_id, o.fecha_inicio, o.fecha_fin, o.habilitado, o.eliminado
    FROM olimpiada_voluntario_disciplina a
    INNER JOIN olimpiada_voluntario v ON v.id = a.voluntario_id AND v.habilitado = 1
    INNER JOIN olimpiada o ON o.id = a.olimpiada_id AND o.eliminado = 0 AND o.habilitado = 'Y'
    INNER JOIN olimpiada_disciplina_config c ON c.olimpiada_id = a.olimpiada_id AND c.disciplina_id = a.disciplina_id
    WHERE a.voluntario_id = ? AND a.olimpiada_id = ?`, [voluntarioId, id]);
  if (!rows.length) throw crearErrorHttp("No tenés disciplinas asignadas en esta olimpiada", 403);
  if (escritura && !puedeEditarEdicion(rows[0], hoy)) {
    throw crearErrorHttp("La carga de resultados sólo está habilitada durante las fechas de la olimpiada. Conservás el acceso de lectura.", 403);
  }
  return [...new Set(rows.map((r) => Number(r.disciplina_id)))];
}

async function exigirDisciplinaVoluntario(opciones) {
  const ids = await exigirEdicionVoluntario(opciones);
  if (ids !== null && !ids.includes(normalizarIdPositivo(opciones.disciplinaId))) {
    throw crearErrorHttp("Esta disciplina no está asignada a tu usuario de colaboración", 403);
  }
  return ids;
}

module.exports = {
  AUDIENCIA, ROL, secretoVoluntarios, crearTokenVoluntario, autenticarVoluntario,
  cargarCuentaVoluntario,
  crearVerificadorCompeticion, verificarAccesoCompeticion: crearVerificadorCompeticion(),
  esVoluntario, puedeEditarEdicion, exigirEdicionVoluntario, exigirDisciplinaVoluntario,
};
