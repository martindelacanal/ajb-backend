"use strict";

const U = require("./util");
const N = require("./negocio");
const { emitirAviso } = require("./avisos");

const VENTANA_MS = 15 * 60 * 1000;
const MAX_FALLOS = 10;
const colas = new WeakMap();

// Una cola por base impide que peticiones simultáneas salteen el décimo intento.
function serializarIngreso(ctx, trabajo) {
  const anterior = colas.get(ctx.db) || Promise.resolve();
  const actual = anterior.then(trabajo);
  colas.set(ctx.db, actual.catch(() => {}));
  return actual;
}

function clavesDe(ctx, identificador, usuario) {
  const cuenta = usuario ? `id:${usuario.id}` : `nombre:${identificador}`;
  return [`ip:${ctx.pid}:${ctx.ip || "sin-ip"}`, `cuenta:${ctx.pid}:${U.sha256(cuenta)}`];
}

function errorBloqueo(hasta, ahora = Date.now()) {
  const segundos = Math.max(1, Math.ceil((hasta - ahora) / 1000));
  return U.error(`Demasiados intentos fallidos. Esperá ${Math.ceil(segundos / 60)} minuto(s) y volvé a probar.`, 429,
    { codigo: "ACCESO_BLOQUEADO", reintentar_en: segundos, bloqueado_hasta: U.fechaHora(new Date(hasta)) });
}

async function controlarIntentos(ctx, claves) {
  const ahora = Date.now();
  for (const clave of claves) {
    const fila = await ctx.db.get("SELECT bloqueado_hasta_ms FROM predio_acceso_control WHERE clave = ?", [clave]);
    if (Number(fila?.bloqueado_hasta_ms) > ahora) throw errorBloqueo(Number(fila.bloqueado_hasta_ms), ahora);
  }
}

function dispositivoId(ctx) {
  const valor = String(ctx.body?.dispositivo_id || "");
  return /^[a-zA-Z0-9_-]{16,80}$/.test(valor) ? valor : null;
}

async function registrarPuesto(ctx, bocaId, cajaId) {
  const id = dispositivoId(ctx);
  if (!id) return;
  await ctx.db.run(
    `INSERT INTO predio_dispositivo (id, boca_id, caja_id, actualizado, ip, agente) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET boca_id = excluded.boca_id, caja_id = excluded.caja_id,
       actualizado = excluded.actualizado, ip = excluded.ip, agente = excluded.agente`,
    [id, bocaId, cajaId, U.fechaHora(), String(ctx.ip || "").slice(0, 45), String(ctx.agenteHttp || "").slice(0, 200)]);
}

async function origenDispositivo(t, ctx) {
  const id = dispositivoId(ctx);
  const guardado = id ? await t.get("SELECT * FROM predio_dispositivo WHERE id = ?", [id]) : null;
  let puesto = guardado;
  let origen = guardado ? "Ultimo puesto autenticado de este dispositivo" : null;
  if (!puesto && ctx.body?.ultimo_puesto && typeof ctx.body.ultimo_puesto === "object") {
    puesto = ctx.body.ultimo_puesto;
    origen = "Cache del navegador (dato informado por la PC)";
  }
  if (!puesto && ctx.ip) {
    puesto = await t.get("SELECT * FROM predio_dispositivo WHERE ip = ? ORDER BY actualizado DESC LIMIT 1", [String(ctx.ip).slice(0, 45)]);
    if (puesto) origen = "Ultimo puesto registrado desde esta IP";
  }
  const bocaId = Number(puesto?.boca_id);
  const cajaId = Number(puesto?.caja_id);
  const boca = Number.isSafeInteger(bocaId) && bocaId > 0
    ? await t.get("SELECT id, nombre FROM predio_boca WHERE predio_id = ? AND id = ?", [ctx.pid, bocaId]) : null;
  const caja = boca && Number.isSafeInteger(cajaId) && cajaId > 0
    ? await t.get("SELECT id, nombre FROM predio_caja WHERE predio_id = ? AND id = ? AND boca_id = ?", [ctx.pid, cajaId, boca.id]) : null;
  return {
    dispositivo_id: id, boca_id: boca?.id || null, boca: boca?.nombre || null,
    caja_id: caja?.id || null, caja: caja?.nombre || null,
    puesto_registrado_en: guardado?.actualizado || null, origen_puesto: origen,
    ip: String(ctx.ip || "").slice(0, 45), agente: String(ctx.agenteHttp || "").slice(0, 200),
  };
}

async function registrarFallo(ctx, claves, identificador, usuario) {
  const ahora = Date.now();
  return ctx.db.tx(async (t) => {
    const conteos = [];
    for (const clave of claves) {
      const anterior = await t.get("SELECT * FROM predio_acceso_control WHERE clave = ?", [clave]);
      const vigente = anterior && ahora - Number(anterior.inicio_ms) < VENTANA_MS;
      const fallos = vigente ? Number(anterior.fallos) + 1 : 1;
      const inicio = vigente ? Number(anterior.inicio_ms) : ahora;
      const hasta = fallos >= MAX_FALLOS ? ahora + VENTANA_MS : null;
      await t.run(
        `INSERT INTO predio_acceso_control (clave, fallos, inicio_ms, ultimo_ms, bloqueado_hasta_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, inicio_ms = excluded.inicio_ms,
           ultimo_ms = excluded.ultimo_ms, bloqueado_hasta_ms = excluded.bloqueado_hasta_ms`,
        [clave, fallos, inicio, ahora, hasta]);
      conteos.push({ fallos, hasta, inicio });
    }
    // La espera empieza en el décimo fallo, no en el primero, y sobrevive a reinicios.
    const bloqueo = Math.max(...conteos.map((c) => c.hasta || 0));
    const fallosCuenta = conteos[1].fallos;
    const dni = /^\d{6,9}$/.test(identificador) ? String(Number(identificador)) : null;
    const origen = await origenDispositivo(t, ctx);
    const fecha = U.fechaHora(new Date(ahora));
    const intento = { fecha, ...origen };
    await t.run("INSERT INTO predio_acceso_intento (cuenta_clave, fecha_ms, detalle) VALUES (?, ?, ?)", [claves[1], ahora, JSON.stringify(intento)]);
    await N.auditar(t, ctx, "Contraseña de ingreso incorrecta", "usuario", usuario?.id || null,
      { usuario: usuario?.usuario || identificador.slice(0, 60), intentos: fallosCuenta, ...intento });
    if (fallosCuenta >= 5 && (usuario || dni)) {
      const recientes = await t.all("SELECT detalle FROM predio_acceso_intento WHERE cuenta_clave = ? AND fecha_ms >= ? ORDER BY id DESC LIMIT 10", [claves[1], conteos[1].inicio]);
      const detalle = {
        usuario: usuario?.usuario || identificador.slice(0, 60), intentos: fallosCuenta,
        intentos_pc: conteos[0].fallos, fecha, ...origen,
        intentos_recientes: recientes.reverse().map((r) => JSON.parse(r.detalle)),
        bloqueado_hasta: bloqueo ? U.fechaHora(new Date(bloqueo)) : null,
      };
      const lugar = origen.boca ? `${origen.boca}${origen.caja ? ` · ${origen.caja}` : ""}` : "sin boca ni caja registradas";
      await emitirAviso(t, ctx, {
        tipo: "ACCESO_FALLIDO", usuarioId: usuario?.id || null,
        generalUsuarioId: usuario?.general_usuario_id || null,
        generalDocumento: Number(usuario?.es_admin_general) ? usuario.documento || dni : (usuario ? null : dni),
        titulo: `${fallosCuenta} intentos fallidos de acceso a tu cuenta`,
        mensaje: `Se intentó acceder a tu cuenta ${fallosCuenta} veces sin éxito en los últimos 15 minutos. Último puesto registrado: ${lugar}. Hora: ${fecha} (Argentina). IP: ${origen.ip || "sin datos"}.${bloqueo ? " El acceso quedó bloqueado durante 15 minutos." : ""}`,
        detalle,
      });
      await N.auditar(t, ctx, "Alerta de acceso fallido", "usuario", usuario?.id || null, detalle);
    }
    await t.run("DELETE FROM predio_acceso_control WHERE ultimo_ms < ? AND (bloqueado_hasta_ms IS NULL OR bloqueado_hasta_ms < ?)", [ahora - 24 * 3600000, ahora]);
    await t.run("DELETE FROM predio_acceso_intento WHERE fecha_ms < ?", [ahora - 24 * 3600000]);
    return bloqueo ? errorBloqueo(bloqueo, ahora) : null;
  });
}

async function registrarExito(ctx, claves) {
  // Entrar a otra cuenta no borra los fallos de la PC.
  await ctx.db.tx(async (t) => {
    await t.run("DELETE FROM predio_acceso_control WHERE clave = ?", [claves[1]]);
    await t.run("DELETE FROM predio_acceso_intento WHERE cuenta_clave = ?", [claves[1]]);
  });
}

module.exports = { clavesDe, controlarIntentos, registrarFallo, registrarExito, registrarPuesto, serializarIngreso };
