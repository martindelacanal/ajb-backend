"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { huella, huellaPassword, igualesSeguros, secretoAleatorio } = require("./auth-crypto");
const { usuarioHabilitado } = require("./autorizacion-sesion");
const { esCorreoValido } = require("../services/correo/config");
const { validarPassword, politicaPassword } = require("./password-policy");
const { limitar, ErrorRecuperacion, MENSAJE_SOLICITUD, MENSAJE_CODIGO } = require("./recuperacion-password");

function normalizarIdentificador(valor) {
  if (typeof valor !== "string" || valor.length > 254) return null;
  const texto = valor.trim().toLowerCase();
  if (esCorreoValido(texto) && !/[,;\r\n]/.test(texto)) return { tipo: "email", valor: texto };
  if (/^[a-z0-9][a-z0-9._-]{2,59}$/.test(texto)) return { tipo: "usuario", valor: texto };
  return null;
}

async function buscarCuenta(db, identificador, bloquear = false) {
  if (!identificador) return null;
  const [rows] = await db.query(`SELECT id, email, password_hash AS password, habilitado
    FROM olimpiada_voluntario WHERE ${identificador.tipo === "email" ? "LOWER(TRIM(email))" : "usuario"} = ?
      AND usuario_sistema_id IS NULL LIMIT 2${bloquear ? " FOR UPDATE" : ""}`, [identificador.valor]);
  // El usuario de colaboración evita las ambigüedades del correo compartido.
  if (rows.length !== 1) return null;
  const u = rows[0];
  if (!usuarioHabilitado(u.habilitado) || !esCorreoValido(u.email || "") || /[,;\r\n]/.test(u.email)
    ) return null;
  return u;
}

function crearServicioRecuperacionExterna({ db, jwtSecret = process.env.JWT_SECRET, enviarCodigo }) {
  async function solicitar({ identificador: valor, ip }) {
    const identificador = normalizarIdentificador(valor);
    await limitar(db, `oli-solicitar:ip:${ip}`, 12, 3600, jwtSecret);
    await limitar(db, `oli-solicitar:identificador:${identificador?.valor || "invalido"}`, 5, 3600, jwtSecret);
    const connection = await db.getConnection();
    let envio = null;
    try {
      await connection.beginTransaction();
      const usuario = await buscarCuenta(connection, identificador, true);
      if (usuario) {
        // Una sola fila por usuario serializa pedidos hechos por documento y por email.
        const [previos] = await connection.query(`SELECT usuario_id, (solicitado_en > DATE_SUB(NOW(6), INTERVAL 60 SECOND)) AS reciente
          FROM olimpiada_voluntario_recuperacion WHERE usuario_id = ? FOR UPDATE`, [usuario.id]);
        if (!Number(previos[0]?.reciente)) {
          // Cuenta además de identificador: no se puede evadir alternando documento/correo.
          try { await limitar(connection, `oli-solicitar:cuenta:${usuario.id}`, 5, 3600, jwtSecret); }
          catch (error) { if (!(error instanceof ErrorRecuperacion)) throw error; }
          const [limites] = await connection.query("SELECT cantidad FROM auth_limite WHERE clave = ?", [huella(`oli-solicitar:cuenta:${usuario.id}`, "auth-rate", jwtSecret)]);
          if (Number(limites[0]?.cantidad) <= 5) {
            const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
            const codeHash = huella(`${usuario.id}:${codigo}`, "oli-reset-code", jwtSecret);
            await connection.query(`INSERT INTO olimpiada_voluntario_recuperacion
              (usuario_id, codigo_hash, password_version, correo_hash, vence_en, solicitado_en, intentos)
              VALUES (?, ?, ?, ?, DATE_ADD(NOW(6), INTERVAL 10 MINUTE), NOW(6), 0)
              ON DUPLICATE KEY UPDATE codigo_hash = VALUES(codigo_hash), password_version = VALUES(password_version),
                correo_hash = VALUES(correo_hash), vence_en = VALUES(vence_en), solicitado_en = NOW(6), intentos = 0,
                reset_hash = NULL, reset_vence_en = NULL, consumido_en = NULL`,
              [usuario.id, codeHash, huellaPassword(usuario.password, jwtSecret), huella(usuario.email.trim().toLowerCase(), "oli-reset-email", jwtSecret)]);
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
      await db.query("UPDATE olimpiada_voluntario_recuperacion SET consumido_en = NOW(6) WHERE usuario_id = ? AND codigo_hash = ?", [envio.usuarioId, envio.codeHash]);
      console.error("[auth] No se pudo entregar un correo de recuperación; verificar configuración SMTP.");
    }
  }

  async function verificar({ identificador: valor, codigo, ip }) {
    const identificador = normalizarIdentificador(valor);
    await limitar(db, `oli-verificar:ip:${ip}`, 40, 900, jwtSecret);
    await limitar(db, `oli-verificar:identificador:${identificador?.valor || "invalido"}`, 15, 900, jwtSecret);
    if (typeof codigo !== "string" || !/^\d{6}$/.test(codigo)) throw new ErrorRecuperacion(MENSAJE_CODIGO);
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const usuario = await buscarCuenta(connection, identificador, true);
      const [rows] = usuario ? await connection.query(`SELECT *, (vence_en > NOW(6)) AS vigente
        FROM olimpiada_voluntario_recuperacion WHERE usuario_id = ? FOR UPDATE`, [usuario.id]) : [[]];
      const row = rows[0];
      if (!row || row.consumido_en || row.reset_hash || !Number(row.vigente) || Number(row.intentos) >= 5
        || !igualesSeguros(row.password_version, huellaPassword(usuario.password, jwtSecret))
        || !igualesSeguros(row.correo_hash, huella(usuario.email.trim().toLowerCase(), "oli-reset-email", jwtSecret))) {
        throw new ErrorRecuperacion(MENSAJE_CODIGO);
      }
      if (!igualesSeguros(row.codigo_hash, huella(`${usuario.id}:${codigo}`, "oli-reset-code", jwtSecret))) {
        await connection.query("UPDATE olimpiada_voluntario_recuperacion SET intentos = intentos + 1 WHERE usuario_id = ?", [usuario.id]);
        await connection.commit();
        throw new ErrorRecuperacion(MENSAJE_CODIGO);
      }
      const resetToken = secretoAleatorio();
      await connection.query(`UPDATE olimpiada_voluntario_recuperacion SET reset_hash = ?, codigo_hash = NULL,
        reset_vence_en = DATE_ADD(NOW(6), INTERVAL 10 MINUTE) WHERE usuario_id = ?`,
        [huella(resetToken, "oli-reset-ticket", jwtSecret), usuario.id]);
      await connection.commit();
      return { resetToken, venceEn: 600, politicaPassword: politicaPassword("personal") };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  async function restablecer({ resetToken, password, ip }) {
    await limitar(db, `oli-restablecer:ip:${ip}`, 20, 900, jwtSecret);
    if (typeof resetToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(resetToken)) throw new ErrorRecuperacion(MENSAJE_CODIGO);
    const tokenHash = huella(resetToken, "oli-reset-ticket", jwtSecret);
    // Evitar bcrypt costoso si el ticket no existe. Se vuelve a validar con bloqueo al consumirlo.
    const [candidatos] = await db.query("SELECT usuario_id FROM olimpiada_voluntario_recuperacion WHERE reset_hash = ? AND consumido_en IS NULL AND reset_vence_en > NOW(6)", [tokenHash]);
    if (!candidatos.length) throw new ErrorRecuperacion(MENSAJE_CODIGO);
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      // Siempre usuario antes de recuperación: mismo orden que solicitar/verificar.
      const [usuarios] = await connection.query("SELECT id, password_hash AS password, email, habilitado FROM olimpiada_voluntario WHERE id = ? AND usuario_sistema_id IS NULL FOR UPDATE", [candidatos[0].usuario_id]);
      const usuario = usuarios[0];
      const [rows] = await connection.query(`SELECT * FROM olimpiada_voluntario_recuperacion WHERE usuario_id = ? AND reset_hash = ?
        AND consumido_en IS NULL AND reset_vence_en > NOW(6) FOR UPDATE`, [candidatos[0].usuario_id, tokenHash]);
      const row = rows[0];
      if (!row || !usuario || !usuarioHabilitado(usuario.habilitado)
        || !igualesSeguros(row.password_version, huellaPassword(usuario.password, jwtSecret))
        || !igualesSeguros(row.correo_hash, huella(usuario.email.trim().toLowerCase(), "oli-reset-email", jwtSecret))) throw new ErrorRecuperacion(MENSAJE_CODIGO);
      validarPassword(password, "personal");
      const passwordHash = await bcrypt.hash(password, 12);
      await connection.query("UPDATE olimpiada_voluntario SET password_hash = ?, sesion_version=sesion_version+1 WHERE id = ? AND usuario_sistema_id IS NULL", [passwordHash, usuario.id]);
      await connection.query("UPDATE olimpiada_voluntario_recuperacion SET consumido_en = NOW(6), reset_hash = NULL, codigo_hash = NULL WHERE usuario_id = ?", [usuario.id]);
      await connection.query("UPDATE olimpiada_voluntario_sesion SET revocado_en = NOW(6) WHERE voluntario_id = ? AND revocado_en IS NULL", [usuario.id]);
      // Las claves de acceso también permiten entrar: quitar las anteriores tras recuperar una cuenta.
      await connection.query("DELETE FROM olimpiada_voluntario_passkey WHERE voluntario_id = ?", [usuario.id]);
      await connection.commit();
      return { mensaje: "Tu contraseña fue actualizada. Ya podés iniciar sesión." };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  return { solicitar, entregar, verificar, restablecer };
}

module.exports = { crearServicioRecuperacionExterna, ErrorRecuperacion, normalizarIdentificador, validarPassword, limitar, MENSAJE_SOLICITUD, MENSAJE_CODIGO };
