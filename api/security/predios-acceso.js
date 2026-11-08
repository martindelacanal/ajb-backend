"use strict";

// Cuentas propias del predio: firma, audiencia y sesiones independientes del
// sistema general. La identidad pública siempre se reconstruye desde la réplica.
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { verificarPassword, hashPassword } = require("../../predios/lib/util");
const AUDIENCIA = "ajb:predios:cuentas", EMISOR = "mi-ajb", TIPO = "predio-cuenta";
const REFRESH_PATTERN = /^predio\.[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH_PATTERN = /^scrypt\$16384\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/;
let dummyHash;
function fallo(mensaje = "El usuario o la contraseña no son correctos", statusCode = 401, code = "PREDIO_ACCESO_INVALIDO") { return Object.assign(new Error(mensaje), { statusCode, status: statusCode, code, codigo: code }); }
function invalida() { return fallo("Tu sesión del predio ya no es válida. Volvé a ingresar."); }
function secreto(jwtSecret = process.env.JWT_SECRET) { if (!jwtSecret) throw new Error("Falta JWT_SECRET"); return crypto.createHmac("sha256", jwtSecret).update("ajb:predios:cuentas:v1").digest(); }
function huella(valor, uso, jwtSecret) { return crypto.createHmac("sha256", secreto(jwtSecret)).update(`${uso}\0${valor}`).digest("hex"); }
function igual(a, b) { return typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function versionCuenta(c, jwtSecret) { return huella(JSON.stringify([Number(c.predio_id), Number(c.id), c.password_hash, Number(c.activo), c.rol, String(c.revision_cuenta || 0)]), "password-version", jwtSecret); }
function habilitada(c) { return !!c && Number(c.predio_activo) === 1 && Number(c.activo) === 1 && ["ADMIN", "SUPERVISOR", "SEGURIDAD"].includes(c.rol) && Number(c.es_admin_general) === 0 && c.es_admin_general != null && HASH_PATTERN.test(c.password_hash || ""); }
function identidad(sub) {
  const m = /^([1-9]\d{0,9}):([1-9]\d{0,9})$/.exec(String(sub || ""));
  if (!m) throw invalida(); const predioId = Number(m[1]), usuarioId = Number(m[2]);
  if (predioId > 2147483647 || usuarioId > 2147483647) throw invalida();
  return { predioId, usuarioId };
}
function datosPublicos(c) { return { id: Number(c.id), rol: "predio_" + c.rol.toLowerCase(), usuario: c.usuario, nombre: c.nombre, apellido: "", predio_id: Number(c.predio_id), predio_codigo: c.predio_codigo, predio_nombre: c.predio_nombre, debe_cambiar_clave: !!Number(c.debe_cambiar_clave), acceso_predio: true, habilitado: "S", area_turismo: 0, area_coseguro: 0, modulo_turismo: 0, modulo_coseguro: 0, modulo_olimpiadas: 0 }; }
function crearToken(c, sid, recordar, jwtSecret) { return jwt.sign({ tipo: TIPO, sid, pv: versionCuenta(c, jwtSecret), data: JSON.stringify(datosPublicos(c)) }, secreto(jwtSecret), { algorithm: "HS256", audience: AUDIENCIA, issuer: EMISOR, subject: `${c.predio_id}:${c.id}`, expiresIn: recordar ? "15m" : "8h" }); }
function verificarToken(token, jwtSecret, ignorarVencimiento = false) {
  let p;
  try { if (typeof token !== "string" || token.length > 16384) throw new Error(); p = jwt.verify(token, secreto(jwtSecret), { algorithms: ["HS256"], audience: AUDIENCIA, issuer: EMISOR, ignoreExpiration: ignorarVencimiento === true }); }
  catch (_e) { throw invalida(); }
  if (!p || p.tipo !== TIPO || p.aud !== AUDIENCIA || p.iss !== EMISOR || !UUID_PATTERN.test(p.sid || "") || !/^[a-f0-9]{64}$/.test(p.pv || "")) throw invalida();
  return { payload: p, ...identidad(p.sub) };
}
function esTokenPredio(token) { try { return typeof token === "string" && token.length <= 16384 && jwt.decode(token)?.aud === AUDIENCIA; } catch (_e) { return false; } }

async function cargarCuenta(db, predioId, usuarioId) {
  // Orden p -> u -> auditoría -> sesión, compartido con la administración remota.
  // Los locking reads evitan reutilizar una instantánea anterior de MySQL al
  // revalidar dentro de una transacción que ya había hecho otras consultas.
  await db.query("SELECT id FROM predio WHERE id = ? FOR UPDATE", [predioId]);
  const [rows] = await db.query(`SELECT u.id, u.predio_id, u.usuario, u.nombre, u.rol, u.activo, u.es_admin_general, u.password_hash, u.debe_cambiar_clave,
    p.codigo AS predio_codigo, p.nombre AS predio_nombre, p.activo AS predio_activo
    FROM predio_usuario u JOIN predio p ON p.id=u.predio_id WHERE u.predio_id=? AND u.id=? LIMIT 1 FOR UPDATE`, [predioId, usuarioId]);
  const c = rows[0]; if (!c) return null;
  const [auditoria] = await db.query(`SELECT id FROM predio_auditoria WHERE predio_id=? AND entidad='usuario' AND entidad_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE`, [predioId, usuarioId]);
  c.revision_cuenta = String(auditoria[0]?.id || 0);
  return c;
}
async function transaccion(db, trabajo) {
  const cx = await db.getConnection();
  try { await cx.beginTransaction(); const r = await trabajo(cx); await cx.commit(); return r; }
  catch (e) { await cx.rollback(); throw e; }
  finally { cx.release(); }
}
function comprobarPassword(password, almacenado) { return HASH_PATTERN.test(almacenado || "") && verificarPassword(password, almacenado); }
function comprobarDummy(password) { dummyHash ||= hashPassword("cuenta-inexistente-predio"); verificarPassword(password, dummyHash); }

async function ingresarPredio({ db, identificador, password, recordar = false, predioCodigo, jwtSecret = process.env.JWT_SECRET }) {
  secreto(jwtSecret);
  if (typeof identificador !== "string" || typeof password !== "string" || !password.length || password.length > 1024) throw fallo();
  const nombre = identificador.trim().toLowerCase();
  if (!nombre || nombre.length > 60 || (predioCodigo != null && (typeof predioCodigo !== "string" || !/^[A-Za-z0-9_-]{1,30}$/.test(predioCodigo)))) throw fallo();
  const documento = /^\d[\d.\s-]*$/.test(nombre) ? nombre.replace(/\D/g, "") : "";
  const [rows] = await db.query(`SELECT DISTINCT u.id, u.predio_id, u.usuario, u.nombre, u.rol, u.activo, u.es_admin_general, u.password_hash,
    p.codigo AS predio_codigo, p.nombre AS predio_nombre, p.activo AS predio_activo, COUNT(*) OVER () AS coincidencias
    FROM predio_usuario u JOIN predio p ON p.id=u.predio_id
    WHERE p.activo=1 AND u.activo=1 AND u.rol IN ('ADMIN','SUPERVISOR','SEGURIDAD') AND u.es_admin_general=0
      AND (LOWER(TRIM(u.usuario))=? OR (?<>'' AND REPLACE(REPLACE(REPLACE(TRIM(u.documento),'.',''),'-',''),' ','')=?))
      ${predioCodigo ? "AND p.codigo=?" : ""} ORDER BY p.id, u.id LIMIT 20`, [nombre, documento, documento, ...(predioCodigo ? [predioCodigo.toUpperCase()] : [])]);
  if (!rows.length || Number(rows[0].coincidencias || rows.length) > 20) { comprobarDummy(password); throw fallo(); }
  const correctas = rows.filter((c) => habilitada(c) && comprobarPassword(password, c.password_hash));
  if (!correctas.length) throw fallo();
  if (correctas.length > 1) {
    const e = fallo("Elegí el predio al que querés ingresar", 409, "PREDIO_REQUERIDO");
    e.predios = [...new Map(correctas.map((c) => [Number(c.predio_id), { codigo: c.predio_codigo, nombre: c.predio_nombre }])).values()]; throw e;
  }
  const elegida = correctas[0];
  return transaccion(db, async (cx) => {
    const c = await cargarCuenta(cx, elegida.predio_id, elegida.id);
    if (!habilitada(c) || !comprobarPassword(password, c.password_hash)) throw fallo();
    const sid = crypto.randomUUID(), persistente = recordar === true, refreshToken = persistente ? "predio." + crypto.randomBytes(32).toString("base64url") : null;
    await cx.query(`INSERT INTO predio_acceso_sesion (id,predio_id,usuario_id,refresh_hash,password_version,vence_en)
      VALUES (?,?,?,?,?,${persistente ? "NULL" : "DATE_ADD(NOW(6), INTERVAL 8 HOUR)"})`, [sid, c.predio_id, c.id, refreshToken ? huella(refreshToken, "refresh", jwtSecret) : null, versionCuenta(c, jwtSecret)]);
    return { token: crearToken(c, sid, persistente, jwtSecret), data: datosPublicos(c), ...(refreshToken ? { refreshToken } : {}) };
  });
}

async function autenticarCuentaPredio({ db, token, jwtSecret = process.env.JWT_SECRET, ignorarVencimiento = false }) {
  const { payload, predioId, usuarioId } = verificarToken(token, jwtSecret, ignorarVencimiento);
  const c = await cargarCuenta(db, predioId, usuarioId);
  if (!habilitada(c)) throw invalida();
  const [sesiones] = await db.query(`SELECT id,password_version FROM predio_acceso_sesion WHERE id=? AND predio_id=? AND usuario_id=?
    AND revocado_en IS NULL AND (vence_en IS NULL OR vence_en>NOW(6)) LIMIT 1`, [payload.sid, predioId, usuarioId]);
  const s = sesiones[0], version = versionCuenta(c, jwtSecret);
  if (!s || !igual(s.password_version, version) || !igual(payload.pv, version)) throw invalida();
  return { ...datosPublicos(c), sid: payload.sid };
}

async function renovarSesionPredio({ db, refreshToken, jwtSecret = process.env.JWT_SECRET }) {
  if (typeof refreshToken !== "string" || !REFRESH_PATTERN.test(refreshToken)) throw invalida();
  const hash = huella(refreshToken, "refresh", jwtSecret);
  return transaccion(db, async (cx) => {
    const [candidatos] = await cx.query("SELECT predio_id,usuario_id FROM predio_acceso_sesion WHERE refresh_hash=? OR refresh_anterior_hash=? LIMIT 1", [hash, hash]);
    if (!candidatos[0]) throw invalida();
    const c = await cargarCuenta(cx, candidatos[0].predio_id, candidatos[0].usuario_id);
    const [sesiones] = await cx.query(`SELECT id,refresh_hash,refresh_anterior_hash,password_version,(gracia_hasta>NOW(6)) AS en_gracia
      FROM predio_acceso_sesion WHERE predio_id=? AND usuario_id=? AND (refresh_hash=? OR refresh_anterior_hash=?)
      AND revocado_en IS NULL AND vence_en IS NULL LIMIT 1 FOR UPDATE`, [candidatos[0].predio_id, candidatos[0].usuario_id, hash, hash]);
    const s = sesiones[0];
    if (!habilitada(c) || !s || !igual(s.password_version, versionCuenta(c, jwtSecret))) throw invalida();
    const actual = igual(hash, s.refresh_hash), anterior = igual(hash, s.refresh_anterior_hash);
    if (!actual && !anterior) throw invalida();
    let siguiente = refreshToken;
    if (anterior || !Number(s.en_gracia)) siguiente = "predio." + Buffer.from(huella(refreshToken, "refresh-next", jwtSecret), "hex").toString("base64url");
    if (anterior && !igual(huella(siguiente, "refresh", jwtSecret), s.refresh_hash)) throw invalida();
    if (actual && !Number(s.en_gracia)) await cx.query(`UPDATE predio_acceso_sesion SET refresh_anterior_hash=refresh_hash,refresh_hash=?,
      gracia_hasta=DATE_ADD(NOW(6), INTERVAL 60 SECOND),ultimo_uso=NOW(6) WHERE id=? AND predio_id=? AND usuario_id=?`, [huella(siguiente, "refresh", jwtSecret), s.id, c.predio_id, c.id]);
    return { token: crearToken(c, s.id, true, jwtSecret), data: datosPublicos(c), refreshToken: siguiente };
  });
}

async function cerrarSesionPredio({ db, token, refreshToken, jwtSecret = process.env.JWT_SECRET }) {
  if (typeof refreshToken === "string" && REFRESH_PATTERN.test(refreshToken)) {
    const hash = huella(refreshToken, "refresh", jwtSecret);
    await db.query("UPDATE predio_acceso_sesion SET revocado_en=NOW(6) WHERE refresh_hash=? OR refresh_anterior_hash=?", [hash, hash]);
  }
  if (token) {
    let v; try { v = verificarToken(token, jwtSecret, true); } catch (_e) { return { ok: true }; }
    await db.query("UPDATE predio_acceso_sesion SET revocado_en=NOW(6) WHERE id=? AND predio_id=? AND usuario_id=?", [v.payload.sid, v.predioId, v.usuarioId]);
  }
  return { ok: true };
}
module.exports = { ingresarPredio, autenticarCuentaPredio, renovarSesionPredio, cerrarSesionPredio, esTokenPredio, REFRESH_PATTERN, AUDIENCIA };
