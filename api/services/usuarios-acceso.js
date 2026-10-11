"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { enviarCorreoPlantilla } = require("./correo");
const { validarPassword } = require("../security/recuperacion-password");
const { MODULOS, MODULOS_ECONOMICOS, MENSAJE_DEUDA, obtenerBloqueo } = require("../security/restricciones-cuenta");

function errorAcceso(mensaje, statusCode = 400) { return Object.assign(new Error(mensaje), { statusCode }); }
function idValido(valor) { return /^\d+$/.test(String(valor)) && Number.isSafeInteger(Number(valor)) && Number(valor) > 0; }

function autorizarGestionAcceso(actor, objetivo) {
  if (!actor || !objetivo) throw errorAcceso("Usuario inexistente", 404);
  if (Number(actor.id) === Number(objetivo.id)) throw errorAcceso("No podés bloquear ni resetear tu propia cuenta desde esta acción.", 403);
  if (["admin", "admin-central"].includes(actor.rol)) return;
  if (actor.rol === "departamental" && objetivo.rol === "afiliado"
    && Number(actor.departamental_id) > 0 && Number(actor.departamental_id) === Number(objetivo.departamental_id)) return;
  throw errorAcceso("No tenés permisos para administrar el acceso de este usuario.", 403);
}

function normalizarBloqueo(body) {
  if (!["total", "modulos"].includes(body?.tipo)) throw errorAcceso("Elegí un tipo de bloqueo válido.");
  if (body.mensaje != null && (typeof body.mensaje !== "string" || body.mensaje.length > 1000)) throw errorAcceso("El mensaje admite hasta 1000 caracteres.");
  if (body.economicos !== undefined && typeof body.economicos !== "boolean") throw errorAcceso("La selección de módulos económicos es inválida.");
  if (body.modulos !== undefined && (!Array.isArray(body.modulos) || body.modulos.some((m) => !MODULOS.includes(m)))) throw errorAcceso("La selección de módulos es inválida.");
  const modulos = body.tipo === "total" ? [...MODULOS]
    : [...new Set([...(body.modulos || []), ...(body.economicos ? MODULOS_ECONOMICOS : [])])];
  if (body.tipo === "modulos" && !modulos.length) throw errorAcceso("Seleccioná al menos un módulo para bloquear.");
  return { tipo: body.tipo, modulos, mensaje: body.mensaje?.trim() || MENSAJE_DEUDA };
}

async function auditar(connection, actorId, objetivoId, campo, anterior, nuevo, observaciones) {
  await connection.query(`INSERT INTO historial_usuario
    (usuario_id, tipo_operacion, tabla_afectada, campo_modificado, valor_anterior, valor_nuevo, usuario_modificador_id, observaciones)
    VALUES (?, 'UPDATE', 'usuario', ?, ?, ?, ?, ?)`, [objetivoId, campo, anterior, nuevo, actorId, observaciones]);
}

async function revocarCredenciales(connection, usuarioId, { passkeys = false } = {}) {
  await connection.query("UPDATE auth_sesion SET revocado_en = NOW(6) WHERE usuario_id = ? AND revocado_en IS NULL", [usuarioId]);
  await connection.query("UPDATE auth_recuperacion SET consumido_en = NOW(6), reset_hash = NULL, codigo_hash = NULL WHERE usuario_id = ?", [usuarioId]);
  if (passkeys) await connection.query("DELETE FROM webauthn_credencial WHERE usuario_id = ?", [usuarioId]);
}

async function enviarClaveTemporal({ para, nombre, passwordTemporal }) {
  return enviarCorreoPlantilla({ para, autenticacion: true,
    asunto: "Se restableció tu contraseña de Mi AJB", titulo: "Tu acceso a Mi AJB",
    previsualizacion: "Ingresá con tu clave temporal y elegí una nueva contraseña.",
    saludo: `Hola ${nombre || ""},`,
    parrafos: ["La administración restableció tu contraseña. Usá tu documento y esta clave temporal para ingresar a Mi AJB.",
      "Al iniciar sesión, deberás elegir una nueva contraseña personal antes de realizar cualquier gestión.",
      "Si no solicitaste este cambio, contactá a tu departamental."],
    datos: [{ etiqueta: "Clave temporal", valor: passwordTemporal }],
  });
}

function crearServicioAccesoUsuarios({ db, enviar = enviarClaveTemporal }) {
  async function gestionar(actorId, usuarioId, operacion) {
    if (!idValido(usuarioId)) throw errorAcceso("Usuario inválido.");
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      // Orden estable para operaciones simultáneas entre administradores.
      const [usuarios] = await connection.query(`SELECT u.*, r.nombre AS rol FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
        WHERE u.id IN (?, ?) ORDER BY u.id FOR UPDATE`, [actorId, usuarioId]);
      const actor = usuarios.find((u) => Number(u.id) === Number(actorId));
      const objetivo = usuarios.find((u) => Number(u.id) === Number(usuarioId));
      autorizarGestionAcceso(actor, objetivo);
      if (["N", "0"].includes(String(actor.habilitado)) || actor.bloqueo_tipo === "total" || Number(actor.requiere_cambio_clave) === 1) {
        throw errorAcceso("Tu cuenta no está habilitada para esta operación.", 403);
      }
      const resultado = await operacion(connection, objetivo);
      await connection.commit();
      return resultado;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  async function bloquear({ actorId, usuarioId, body }) {
    const bloqueo = normalizarBloqueo(body);
    return gestionar(actorId, usuarioId, async (connection, objetivo) => {
      await connection.query(`UPDATE usuario SET bloqueo_tipo = ?, bloqueo_modulos = ?, bloqueo_mensaje = ?
        ${bloqueo.tipo === "total" ? ", auth_revocado_desde = NOW(6)" : ""} WHERE id = ?`,
      [bloqueo.tipo, JSON.stringify(bloqueo.modulos), bloqueo.mensaje, usuarioId]);
      if (bloqueo.tipo === "total") await revocarCredenciales(connection, usuarioId);
      await auditar(connection, actorId, usuarioId, "bloqueo", JSON.stringify(obtenerBloqueo(objetivo)), JSON.stringify(bloqueo), "Bloqueo manual de acceso");
      return { success: true, bloqueo };
    });
  }

  async function desbloquear({ actorId, usuarioId }) {
    return gestionar(actorId, usuarioId, async (connection, objetivo) => {
      await connection.query("UPDATE usuario SET bloqueo_tipo = NULL, bloqueo_modulos = NULL, bloqueo_mensaje = NULL WHERE id = ?", [usuarioId]);
      await auditar(connection, actorId, usuarioId, "bloqueo", JSON.stringify(obtenerBloqueo(objetivo)), null, "Desbloqueo manual de acceso");
      return { success: true, bloqueo: null };
    });
  }

  async function resetear({ actorId, usuarioId }) {
    const passwordTemporal = `AJB-${crypto.randomBytes(12).toString("base64url")}`;
    const hash = await bcrypt.hash(passwordTemporal, 12);
    const destinatario = await gestionar(actorId, usuarioId, async (connection, objetivo) => {
      await connection.query("UPDATE usuario SET password = ?, requiere_cambio_clave = 1, auth_revocado_desde = NOW(6) WHERE id = ?", [hash, usuarioId]);
      await revocarCredenciales(connection, usuarioId, { passkeys: true });
      await auditar(connection, actorId, usuarioId, "password", "[PROTEGIDA]", "[TEMPORAL]", "Blanqueo de contraseña; cambio obligatorio en el próximo ingreso");
      return { para: objetivo.email, nombre: objetivo.nombre };
    });
    let emailEnviado = false;
    try { emailEnviado = Boolean((await enviar({ ...destinatario, passwordTemporal }))?.enviado); }
    catch (_) { /* La clave ya fue restablecida y sigue disponible para copiar. */ }
    return { success: true, passwordTemporal, emailEnviado, mensaje: emailEnviado
      ? "Contraseña temporal generada y enviada por correo. Se solicitará una nueva al ingresar."
      : "Contraseña temporal generada. No se pudo enviar el correo; copiá la clave para entregársela al usuario." };
  }

  async function cambiarObligatoria({ usuarioId, passwordActual, password }) {
    validarPassword(password);
    if (typeof passwordActual !== "string" || Buffer.byteLength(passwordActual) > 72) throw errorAcceso("Ingresá tu contraseña actual.");
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [usuarios] = await connection.query("SELECT id, password, requiere_cambio_clave, bloqueo_tipo, habilitado FROM usuario WHERE id = ? FOR UPDATE", [usuarioId]);
      const usuario = usuarios[0];
      if (!usuario || usuario.bloqueo_tipo === "total" || usuario.habilitado === "N") throw errorAcceso("Usuario inhabilitado.", 403);
      if (Number(usuario.requiere_cambio_clave) !== 1) throw errorAcceso("No hay un cambio obligatorio de contraseña pendiente.", 409);
      if (!await bcrypt.compare(passwordActual, usuario.password)) throw errorAcceso("La contraseña actual no es correcta.");
      if (await bcrypt.compare(password, usuario.password)) throw errorAcceso("Elegí una contraseña distinta de la temporal.");
      const hash = await bcrypt.hash(password, 12);
      await connection.query("UPDATE usuario SET password = ?, requiere_cambio_clave = 0, auth_revocado_desde = NOW(6) WHERE id = ?", [hash, usuarioId]);
      await revocarCredenciales(connection, usuarioId);
      await auditar(connection, usuarioId, usuarioId, "password", "[TEMPORAL]", "[PROTEGIDA]", "Cambio obligatorio de contraseña completado");
      await connection.commit();
      return { mensaje: "Contraseña actualizada. Volvé a iniciar sesión." };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  return { bloquear, desbloquear, resetear, cambiarObligatoria };
}

module.exports = { crearServicioAccesoUsuarios, normalizarBloqueo, autorizarGestionAcceso, enviarClaveTemporal };
