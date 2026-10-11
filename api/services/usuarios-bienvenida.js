"use strict";

const crypto = require("crypto");
const { enviarCorreoPlantilla, urlAplicacion } = require("./correo");
const { configuracionCorreo } = require("./correo/config");

async function encolarBienvenida({ connection, usuarioId, para, nombre, apellido }) {
  const id = crypto.randomUUID();
  await connection.query(`INSERT INTO correo_bienvenida (id, usuario_id, email, nombre)
    VALUES (?, ?, ?, ?)`, [id, usuarioId, para.trim().toLowerCase(), [nombre, apellido].filter(Boolean).join(" ").slice(0, 255)]);
  return id;
}

function bienvenidaDisponible() {
  const c = configuracionCorreo();
  return c.habilitado && !c.modoPruebas && !c.redirigirA && c.tlsEstricto && !c.depurar;
}

async function enviarBienvenida(fila) {
  if (!bienvenidaDisponible()) return { enviado: false, motivo: "correo_no_disponible" };
  return enviarCorreoPlantilla({
    para: fila.email, asunto: "Te damos la bienvenida a Mi AJB", titulo: "Tu cuenta de Mi AJB ya está creada",
    saludo: `Hola ${fila.nombre},`, previsualizacion: "Creá tu contraseña y empezá a usar Mi AJB.",
    parrafos: ["Ya podés ingresar a Mi AJB y consultar los servicios disponibles para tu cuenta.",
      "Para crear tu contraseña, entrá a Mi AJB, elegí «Olvidé mi contraseña» e ingresá tu documento o este correo. Recibirás un código para verificar tu identidad y elegir una contraseña personal.",
      "Si necesitás ayuda o no reconocés este registro, contactá a tu departamental."],
    boton: { texto: "Crear mi contraseña en Mi AJB", url: urlAplicacion("/login") },
    encabezados: {
      ...(process.env.MAIL_SES_CONFIGURATION_SET ? { "X-SES-CONFIGURATION-SET": process.env.MAIL_SES_CONFIGURATION_SET } : {}),
      "X-SES-MESSAGE-TAGS": `bienvenida_id=${fila.id}`,
    },
  });
}

function resultadoEnvio(resultado) {
  if (resultado?.enviado && !resultado.rechazados?.length) return { estado: "enviado", detalle: null };
  return { estado: "error", detalle: resultado?.rechazados?.length
    ? "El servidor de correo rechazó el destinatario. Revisá el email declarado."
    : "No se pudo enviar la bienvenida. Revisá el email y la configuración de correo." };
}

async function procesarBienvenidas({ db, enviar = enviarBienvenida, disponible = bienvenidaDisponible }) {
  if (!disponible()) return 0; // Conserva los pendientes mientras SMTP esté apagado.
  const connection = await db.getConnection();
  let locked = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK('ajb:correo-bienvenida', 0) tomado");
    if (Number(locks[0]?.tomado) !== 1) return 0;
    locked = true;
    // Una caída entre SMTP y la confirmación no debe duplicar bienvenidas.
    await connection.query(`UPDATE correo_bienvenida SET estado='error',
      detalle='Envío interrumpido: no se pudo confirmar el resultado. Revisá el estado antes de reenviar.'
      WHERE estado='pendiente' AND procesando_en < DATE_SUB(NOW(6), INTERVAL 10 MINUTE)`);
    const [filas] = await connection.query(`SELECT b.*, u.email AS email_actual, u.habilitado, u.bloqueo_tipo
      FROM correo_bienvenida b INNER JOIN usuario u ON u.id=b.usuario_id
      WHERE b.estado='pendiente' AND b.procesando_en IS NULL ORDER BY b.creada_en LIMIT 10`);
    for (const fila of filas) {
      if (String(fila.email_actual || "").trim().toLowerCase() !== fila.email.toLowerCase()
        || ["N", "0"].includes(String(fila.habilitado)) || fila.bloqueo_tipo === "total") {
        await connection.query("UPDATE correo_bienvenida SET estado='error', detalle=? WHERE id=? AND estado='pendiente'",
          ["El email o la habilitación de la cuenta cambió antes del envío. Revisá los datos.", fila.id]);
        continue;
      }
      await connection.query("UPDATE correo_bienvenida SET procesando_en=NOW(6) WHERE id=? AND estado='pendiente'", [fila.id]);
      let resultado;
      try { resultado = await enviar(fila); } catch (_) { resultado = { enviado: false }; }
      const estado = resultadoEnvio(resultado);
      // SES devuelve SU messageId en la respuesta SMTP, no el Message-ID local de Nodemailer.
      const sesId = /^250\s+Ok\s+([A-Za-z0-9-]+)\s*$/i.exec(resultado?.respuesta || "")?.[1] || null;
      await connection.query(`UPDATE correo_bienvenida SET estado=?, detalle=?, message_id=COALESCE(message_id,?),
        enviada_en=IF(?='enviado',NOW(6),enviada_en) WHERE id=? AND estado='pendiente'`,
        [estado.estado, estado.detalle, sesId, estado.estado, fila.id]);
    }
    return filas.length;
  } finally {
    try {
      if (locked) await connection.query("SELECT RELEASE_LOCK('ajb:correo-bienvenida')");
    } finally {
      connection.release();
    }
  }
}

function iniciarBienvenidas(db) {
  let activo = false;
  const timer = setInterval(async () => {
    if (activo) return;
    activo = true;
    try { await procesarBienvenidas({ db }); }
    catch (error) { console.error("[bienvenida] Cola no disponible:", error?.code || "error_interno"); }
    finally { activo = false; }
  }, 15000);
  timer.unref();
  return timer;
}

module.exports = { encolarBienvenida, bienvenidaDisponible, enviarBienvenida, resultadoEnvio, procesarBienvenidas, iniciarBienvenidas };
