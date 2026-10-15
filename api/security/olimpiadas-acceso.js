"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { huella, huellaPassword, igualesSeguros, secretoAleatorio } = require("./auth-crypto");
const { crearTokenVoluntario, cargarCuentaVoluntario, secretoVoluntarios, AUDIENCIA } = require("./olimpiadas-voluntarios");
const { crearErrorHttp } = require("../services/olimpiadas-comun");
const REFRESH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[a-f0-9-]{36}$/;

async function buscarCuentaVoluntario(db, identificador) {
  // Una coincidencia ambigua nunca autentica otra cuenta por coincidencia de email/DNI.
  const [rows] = await db.query(`SELECT DISTINCT v.id FROM olimpiada_voluntario v
    LEFT JOIN usuario u ON u.id=v.usuario_sistema_id
    WHERE (v.usuario_sistema_id IS NULL AND (v.usuario=? OR v.email=?))
      OR (v.usuario_sistema_id IS NOT NULL AND (CAST(u.documento AS CHAR)=? OR LOWER(TRIM(u.email))=?)) LIMIT 2`,
  [identificador, identificador, identificador, identificador]);
  return rows.length === 1 ? cargarCuentaVoluntario(db, rows[0].id) : null;
}
async function crearSesionVoluntario({ db, cuenta, recordar = false, jwtSecret }) {
  if (Number(cuenta.habilitado) !== 1) throw crearErrorHttp("La cuenta está deshabilitada", 401);
  const sid = crypto.randomUUID();
  const refreshToken = recordar ? secretoAleatorio() : null;
  await db.query(`INSERT INTO olimpiada_voluntario_sesion
    (id,voluntario_id,refresh_hash,password_version,sesion_version,vence_en)
    VALUES (?,?,?,?,?,${recordar ? "NULL" : "DATE_ADD(NOW(6),INTERVAL 8 HOUR)"})`,
  [sid, cuenta.id, refreshToken ? huella(refreshToken, "oli-refresh", jwtSecret) : null, huellaPassword(cuenta.password_hash, jwtSecret), cuenta.sesion_version]);
  return { token: crearTokenVoluntario(cuenta, jwtSecret, sid), ...(refreshToken ? { refreshToken } : {}) };
}
async function renovarSesionVoluntario({ db, refreshToken, jwtSecret }) {
  const invalida = () => crearErrorHttp("Tu sesión ya no es válida. Volvé a ingresar.", 401);
  if (typeof refreshToken !== "string" || !REFRESH_PATTERN.test(refreshToken)) throw invalida();
  const hash = huella(refreshToken, "oli-refresh", jwtSecret);
  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();
    const [candidatos] = await cx.query("SELECT voluntario_id FROM olimpiada_voluntario_sesion WHERE refresh_hash=? OR refresh_anterior_hash=? LIMIT 1", [hash, hash]);
    if (!candidatos[0]) throw invalida();
    const cuenta = await cargarCuentaVoluntario(cx, candidatos[0].voluntario_id, true);
    const [sesiones] = await cx.query(`SELECT *, (gracia_hasta>NOW(6)) AS en_gracia FROM olimpiada_voluntario_sesion
      WHERE (refresh_hash=? OR refresh_anterior_hash=?) AND revocado_en IS NULL AND vence_en IS NULL
      AND (? IS NULL OR creada_en>?) LIMIT 1 FOR UPDATE`, [hash, hash, cuenta?.usuario_sistema?.auth_revocado_desde || null, cuenta?.usuario_sistema?.auth_revocado_desde || null]);
    const s = sesiones[0];
    if (!cuenta || Number(cuenta.habilitado)!==1 || !s || Number(s.sesion_version)!==Number(cuenta.sesion_version)
      || !igualesSeguros(s.password_version, huellaPassword(cuenta.password_hash, jwtSecret))) throw invalida();
    const actual = igualesSeguros(hash, s.refresh_hash);
    if (!actual && !Number(s.en_gracia)) throw invalida();
    const siguiente = (!actual || !Number(s.en_gracia)) ? Buffer.from(huella(refreshToken, "oli-refresh-next", jwtSecret), "hex").toString("base64url") : refreshToken;
    if (actual && !Number(s.en_gracia)) await cx.query(`UPDATE olimpiada_voluntario_sesion SET refresh_anterior_hash=refresh_hash,
      refresh_hash=?, gracia_hasta=DATE_ADD(NOW(6),INTERVAL 60 SECOND) WHERE id=?`, [huella(siguiente, "oli-refresh", jwtSecret), s.id]);
    await cx.commit();
    return { cuenta, token: crearTokenVoluntario(cuenta, jwtSecret, s.id), refreshToken: siguiente };
  } catch (e) { await cx.rollback(); throw e; } finally { cx.release(); }
}
async function cerrarSesionVoluntario({ db, token, refreshToken, jwtSecret }) {
  if (typeof refreshToken === "string" && REFRESH_PATTERN.test(refreshToken)) {
    const hash = huella(refreshToken, "oli-refresh", jwtSecret);
    await db.query("UPDATE olimpiada_voluntario_sesion SET revocado_en=NOW(6) WHERE refresh_hash=? OR refresh_anterior_hash=?", [hash, hash]);
  }
  if (token) {
    let payload;
    try { payload = jwt.verify(token, secretoVoluntarios(jwtSecret), { audience: AUDIENCIA, issuer: "mi-ajb", algorithms: ["HS256"], ignoreExpiration: true }); } catch (_) { return; }
    if (UUID_PATTERN.test(String(payload.sid || ""))) await db.query("UPDATE olimpiada_voluntario_sesion SET revocado_en=NOW(6) WHERE id=? AND voluntario_id=?", [payload.sid, payload.sub]);
    else if (!payload.sid && /^[1-9]\d*$/.test(String(payload.sub)) && Number.isSafeInteger(payload.version)) {
      // Compatibilidad con las sesiones de 8 horas emitidas antes de acceso-v2:
      // carecen de sid, por lo que cerrar una revoca esa generación completa.
      await db.query("UPDATE olimpiada_voluntario SET sesion_version=sesion_version+1 WHERE id=? AND sesion_version=?",[payload.sub,payload.version]);
    }
  }
}
module.exports = { buscarCuentaVoluntario, crearSesionVoluntario, renovarSesionVoluntario, cerrarSesionVoluntario };
