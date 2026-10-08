"use strict";

const crypto = require("crypto");
const { emitirTokenSesion } = require("./token-sesion");
const { huella, huellaPassword, igualesSeguros, secretoAleatorio } = require("./auth-crypto");
const { usuarioHabilitado, resolverAccesoFamiliar } = require("./autorizacion-sesion");
const REFRESH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class ErrorAutenticacion extends Error {
  constructor(message = "Tu sesión ya no es válida. Volvé a iniciar sesión.", statusCode = 401) {
    super(message); this.statusCode = statusCode;
  }
}

async function crearSesion({ db, data, password, recordar = false, jwtLib, jwtSecret = process.env.JWT_SECRET }) {
  const sid = crypto.randomUUID();
  const refreshToken = recordar ? secretoAleatorio() : null;
  const passwordVersion = huellaPassword(password, jwtSecret);
  await db.query(
    `INSERT INTO auth_sesion (id, usuario_id, refresh_hash, password_version, vence_en)
     VALUES (?, ?, ?, ?, ${recordar ? "NULL" : "DATE_ADD(NOW(6), INTERVAL 8 HOUR)"})`,
    [sid, data.id, refreshToken ? huella(refreshToken, "refresh", jwtSecret) : null, passwordVersion]);
  const token = await emitirTokenSesion({ data, recordar, sid, passwordVersion, jwtLib, jwtSecret });
  return { token, data, ...(refreshToken ? { refreshToken } : {}) };
}

async function renovarSesion({ db, refreshToken, jwtSecret = process.env.JWT_SECRET, jwtLib }) {
  if (typeof refreshToken !== "string" || !REFRESH_PATTERN.test(refreshToken)) throw new ErrorAutenticacion();
  const hash = huella(refreshToken, "refresh", jwtSecret);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // Compartir el orden de bloqueos con recuperación evita una inversión
    // usuario/sesión cuando un dispositivo renueva durante un cambio de clave.
    const [candidatos] = await connection.query(`SELECT usuario_id FROM auth_sesion
      WHERE refresh_hash = ? OR refresh_anterior_hash = ? LIMIT 1`, [hash, hash]);
    if (!candidatos.length) throw new ErrorAutenticacion();
    await connection.query("SELECT id FROM usuario WHERE id = ? FOR UPDATE", [candidatos[0].usuario_id]);
    const [rows] = await connection.query(
      `SELECT s.id AS sesion_id, s.refresh_hash, s.refresh_anterior_hash, s.password_version,
              (s.gracia_hasta > NOW(6)) AS en_gracia,
              u.id, u.password, u.nombre, u.apellido, u.documento, u.email, u.rol_id,
              u.departamental_id, u.habilitado, u.area_turismo, u.area_coseguro,
              u.modulo_turismo, u.modulo_coseguro, u.modulo_olimpiadas,
              u.es_familiar, u.usuario_familiar_id, r.nombre AS rol
       FROM auth_sesion s INNER JOIN usuario u ON u.id = s.usuario_id
       INNER JOIN rol r ON r.id = u.rol_id
       WHERE (s.refresh_hash = ? OR s.refresh_anterior_hash = ?)
         AND s.revocado_en IS NULL AND s.vence_en IS NULL
         AND (u.auth_revocado_desde IS NULL OR s.creada_en > u.auth_revocado_desde) LIMIT 1 FOR UPDATE`, [hash, hash]);
    const row = rows[0];
    if (!row || !usuarioHabilitado(row.habilitado) || !igualesSeguros(row.password_version, huellaPassword(row.password, jwtSecret))) {
      throw new ErrorAutenticacion();
    }
    const esActual = igualesSeguros(hash, row.refresh_hash);
    // La derivación permite devolver el mismo sucesor a dos pestañas sin guardar
    // ninguna credencial en claro. Se conserva un único predecesor hasta la
    // siguiente rotación: permite recuperar una respuesta perdida incluso si
    // el dispositivo estuvo desconectado. Durante 60 s no se vuelve a rotar.
    let siguiente = refreshToken;
    if (!esActual || !Number(row.en_gracia)) {
      siguiente = Buffer.from(huella(refreshToken, "refresh-next", jwtSecret), "hex").toString("base64url");
    }
    if (esActual && !Number(row.en_gracia)) {
      await connection.query(
        `UPDATE auth_sesion SET refresh_anterior_hash = refresh_hash, refresh_hash = ?,
          gracia_hasta = DATE_ADD(NOW(6), INTERVAL 60 SECOND), ultimo_uso = NOW(6) WHERE id = ?`,
        [huella(siguiente, "refresh", jwtSecret), row.sesion_id]);
    }
    const { password, password_version, sesion_id, refresh_hash, refresh_anterior_hash, en_gracia, ...usuario } = row;
    const data = await resolverAccesoFamiliar(usuario, connection);
    const token = await emitirTokenSesion({ data, recordar: true, sid: sesion_id, passwordVersion: password_version, jwtSecret, jwtLib });
    await connection.commit();
    return { token, refreshToken: siguiente, data };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function cerrarSesion({ db, refreshToken, sid, jwtSecret = process.env.JWT_SECRET }) {
  if (typeof refreshToken === "string" && REFRESH_PATTERN.test(refreshToken)) {
    const hash = huella(refreshToken, "refresh", jwtSecret);
    await db.query(`UPDATE auth_sesion SET revocado_en = NOW(6)
      WHERE refresh_hash = ? OR refresh_anterior_hash = ?`, [hash, hash]);
  }
  if (typeof sid === "string" && /^[a-f0-9-]{36}$/.test(sid)) {
    await db.query("UPDATE auth_sesion SET revocado_en = NOW(6) WHERE id = ?", [sid]);
  }
}

module.exports = { crearSesion, renovarSesion, cerrarSesion, ErrorAutenticacion, REFRESH_PATTERN };
