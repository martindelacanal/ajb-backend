"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { huella, huellaPassword, igualesSeguros, secretoAleatorio } = require("./auth-crypto");
const { usuarioHabilitado } = require("./autorizacion-sesion");
const { esCorreoValido } = require("../services/correo/config");

const MENSAJE_SOLICITUD = "Si los datos corresponden a una cuenta habilitada, te enviaremos un código a su correo electrónico.";
const MENSAJE_CODIGO = "El código no es válido o venció. Revisalo o solicitá uno nuevo.";
class ErrorRecuperacion extends Error {
  constructor(message, statusCode = 400, retryAfter) { super(message); this.statusCode = statusCode; this.retryAfter = retryAfter; }
}

function normalizarIdentificador(valor) {
  if (typeof valor !== "string" || valor.length > 254) return null;
  const texto = valor.trim().toLowerCase();
  if (/^\d{1,10}$/.test(texto)) return { tipo: "documento", valor: String(Number(texto)) };
  if (esCorreoValido(texto) && !/[,;\r\n]/.test(texto)) return { tipo: "email", valor: texto };
  return null;
}

function validarPassword(password) {
  if (typeof password !== "string" || [...password].length < 12 || Buffer.byteLength(password, "utf8") > 72 || !password.trim()) {
    throw new ErrorRecuperacion("Usá al menos 12 caracteres y como máximo 72 bytes para tu contraseña.");
  }
}

async function limitar(db, clave, maximo, segundos, jwtSecret) {
  const key = huella(clave, "auth-rate", jwtSecret);
  await db.query("DELETE FROM auth_limite WHERE vence_en < NOW(6) LIMIT 100");
  // UPDATE atómico; se conserva en MySQL al reiniciar el servidor o usar varios workers.
  await db.query(`INSERT INTO auth_limite (clave, cantidad, vence_en) VALUES (?, 1, DATE_ADD(NOW(6), INTERVAL ? SECOND))
    ON DUPLICATE KEY UPDATE cantidad = IF(vence_en <= NOW(6), 1, cantidad + 1),
      vence_en = IF(vence_en <= NOW(6), VALUES(vence_en), vence_en)`, [key, segundos]);
  const [rows] = await db.query("SELECT cantidad, GREATEST(1, TIMESTAMPDIFF(SECOND, NOW(6), vence_en)) AS espera FROM auth_limite WHERE clave = ?", [key]);
  if (Number(rows[0].cantidad) > maximo) {
    throw new ErrorRecuperacion("Demasiados intentos. Esperá unos minutos y volvé a probar.", 429, Number(rows[0].espera));
  }
}

async function buscarCuenta(db, identificador, bloquear = false) {
  if (!identificador) return null;
  const [rows] = await db.query(`SELECT id, email, password, habilitado, rol_id, es_familiar, usuario_familiar_id
    FROM usuario WHERE ${identificador.tipo === "email" ? "LOWER(TRIM(email))" : "documento"} = ?
      AND password IS NOT NULL LIMIT 2${bloquear ? " FOR UPDATE" : ""}`, [identificador.valor]);
  // Un correo compartido no identifica una cuenta: el documento sí puede hacerlo.
  if (rows.length !== 1) return null;
  const u = rows[0];
  if (!usuarioHabilitado(u.habilitado) || !esCorreoValido(u.email || "") || /[,;\r\n]/.test(u.email)
    || (Number(u.rol_id) === 4 && !(u.es_familiar === "S" && u.usuario_familiar_id))) return null;
  return u;
}

function crearServicioRecuperacion({ db, jwtSecret = process.env.JWT_SECRET, enviarCodigo }) {
  async function solicitar({ identificador: valor, ip }) {
    const identificador = normalizarIdentificador(valor);
    await limitar(db, `solicitar:ip:${ip}`, 12, 3600, jwtSecret);
    await limitar(db, `solicitar:identificador:${identificador?.valor || "invalido"}`, 5, 3600, jwtSecret);
    const connection = await db.getConnection();
    let envio = null;
    try {
      await connection.beginTransaction();
      const usuario = await buscarCuenta(connection, identificador, true);
      if (usuario) {
        // Una sola fila por usuario serializa pedidos hechos por documento y por email.
        const [previos] = await connection.query(`SELECT usuario_id, (solicitado_en > DATE_SUB(NOW(6), INTERVAL 60 SECOND)) AS reciente
          FROM auth_recuperacion WHERE usuario_id = ? FOR UPDATE`, [usuario.id]);
        if (!Number(previos[0]?.reciente)) {
          // Cuenta además de identificador: no se puede evadir alternando documento/correo.
          try { await limitar(connection, `solicitar:cuenta:${usuario.id}`, 5, 3600, jwtSecret); }
          catch (error) { if (!(error instanceof ErrorRecuperacion)) throw error; }
          const [limites] = await connection.query("SELECT cantidad FROM auth_limite WHERE clave = ?", [huella(`solicitar:cuenta:${usuario.id}`, "auth-rate", jwtSecret)]);
          if (Number(limites[0]?.cantidad) <= 5) {
            const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
            const codeHash = huella(`${usuario.id}:${codigo}`, "reset-code", jwtSecret);
            await connection.query(`INSERT INTO auth_recuperacion
              (usuario_id, codigo_hash, password_version, correo_hash, vence_en, solicitado_en, intentos)
              VALUES (?, ?, ?, ?, DATE_ADD(NOW(6), INTERVAL 10 MINUTE), NOW(6), 0)
              ON DUPLICATE KEY UPDATE codigo_hash = VALUES(codigo_hash), password_version = VALUES(password_version),
                correo_hash = VALUES(correo_hash), vence_en = VALUES(vence_en), solicitado_en = NOW(6), intentos = 0,
                reset_hash = NULL, reset_vence_en = NULL, consumido_en = NULL`,
              [usuario.id, codeHash, huellaPassword(usuario.password, jwtSecret), huella(usuario.email.trim().toLowerCase(), "reset-email", jwtSecret)]);
            envio = { usuarioId: usuario.id, para: usuario.email.trim(), codigo, codeHash };
          }
        }
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return envio;
  }

  async function entregar(envio) {
    if (!envio) return;
    let enviado = false;
    try { enviado = Boolean((await enviarCodigo(envio)).enviado); }
    catch (_error) { /* El SMTP nunca se refleja en la respuesta anónima. */ }
    if (!enviado) {
      await db.query("UPDATE auth_recuperacion SET consumido_en = NOW(6) WHERE usuario_id = ? AND codigo_hash = ?", [envio.usuarioId, envio.codeHash]);
      console.error("[auth] No se pudo entregar un correo de recuperación; verificar configuración SMTP.");
    }
  }

  async function verificar({ identificador: valor, codigo, ip }) {
    const identificador = normalizarIdentificador(valor);
    await limitar(db, `verificar:ip:${ip}`, 40, 900, jwtSecret);
    await limitar(db, `verificar:identificador:${identificador?.valor || "invalido"}`, 15, 900, jwtSecret);
    if (typeof codigo !== "string" || !/^\d{6}$/.test(codigo)) throw new ErrorRecuperacion(MENSAJE_CODIGO);
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const usuario = await buscarCuenta(connection, identificador, true);
      const [rows] = usuario ? await connection.query(`SELECT *, (vence_en > NOW(6)) AS vigente
        FROM auth_recuperacion WHERE usuario_id = ? FOR UPDATE`, [usuario.id]) : [[]];
      const row = rows[0];
      if (!row || row.consumido_en || row.reset_hash || !Number(row.vigente) || Number(row.intentos) >= 5
        || !igualesSeguros(row.password_version, huellaPassword(usuario.password, jwtSecret))
        || !igualesSeguros(row.correo_hash, huella(usuario.email.trim().toLowerCase(), "reset-email", jwtSecret))) {
        throw new ErrorRecuperacion(MENSAJE_CODIGO);
      }
      if (!igualesSeguros(row.codigo_hash, huella(`${usuario.id}:${codigo}`, "reset-code", jwtSecret))) {
        await connection.query("UPDATE auth_recuperacion SET intentos = intentos + 1 WHERE usuario_id = ?", [usuario.id]);
        await connection.commit();
        throw new ErrorRecuperacion(MENSAJE_CODIGO);
      }
      const resetToken = secretoAleatorio();
      await connection.query(`UPDATE auth_recuperacion SET reset_hash = ?, codigo_hash = NULL,
        reset_vence_en = DATE_ADD(NOW(6), INTERVAL 10 MINUTE) WHERE usuario_id = ?`,
        [huella(resetToken, "reset-ticket", jwtSecret), usuario.id]);
      await connection.commit();
      return { resetToken, venceEn: 600 };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  async function restablecer({ resetToken, password, ip }) {
    await limitar(db, `restablecer:ip:${ip}`, 20, 900, jwtSecret);
    validarPassword(password);
    if (typeof resetToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(resetToken)) throw new ErrorRecuperacion(MENSAJE_CODIGO);
    const tokenHash = huella(resetToken, "reset-ticket", jwtSecret);
    // Evitar bcrypt costoso si el ticket no existe. Se vuelve a validar con bloqueo al consumirlo.
    const [candidatos] = await db.query("SELECT usuario_id FROM auth_recuperacion WHERE reset_hash = ? AND consumido_en IS NULL AND reset_vence_en > NOW(6)", [tokenHash]);
    if (!candidatos.length) throw new ErrorRecuperacion(MENSAJE_CODIGO);
    const passwordHash = await bcrypt.hash(password, 12);
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      // Siempre usuario antes de recuperación: mismo orden que solicitar/verificar.
      const [usuarios] = await connection.query("SELECT id, password, email, habilitado FROM usuario WHERE id = ? FOR UPDATE", [candidatos[0].usuario_id]);
      const usuario = usuarios[0];
      const [rows] = await connection.query(`SELECT * FROM auth_recuperacion WHERE usuario_id = ? AND reset_hash = ?
        AND consumido_en IS NULL AND reset_vence_en > NOW(6) FOR UPDATE`, [candidatos[0].usuario_id, tokenHash]);
      const row = rows[0];
      if (!row || !usuario || !usuarioHabilitado(usuario.habilitado)
        || !igualesSeguros(row.password_version, huellaPassword(usuario.password, jwtSecret))
        || !igualesSeguros(row.correo_hash, huella(usuario.email.trim().toLowerCase(), "reset-email", jwtSecret))) throw new ErrorRecuperacion(MENSAJE_CODIGO);
      await connection.query("UPDATE usuario SET password = ?, auth_revocado_desde = NOW(6) WHERE id = ?", [passwordHash, usuario.id]);
      await connection.query("UPDATE auth_recuperacion SET consumido_en = NOW(6), reset_hash = NULL, codigo_hash = NULL WHERE usuario_id = ?", [usuario.id]);
      await connection.query("UPDATE auth_sesion SET revocado_en = NOW(6) WHERE usuario_id = ? AND revocado_en IS NULL", [usuario.id]);
      // Las claves de acceso también permiten entrar: quitar las anteriores tras recuperar una cuenta.
      await connection.query("DELETE FROM webauthn_credencial WHERE usuario_id = ?", [usuario.id]);
      await connection.commit();
      return { mensaje: "Tu contraseña fue actualizada. Ya podés iniciar sesión." };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  return { solicitar, entregar, verificar, restablecer };
}

module.exports = { crearServicioRecuperacion, ErrorRecuperacion, normalizarIdentificador, validarPassword, limitar, MENSAJE_SOLICITUD, MENSAJE_CODIGO };
