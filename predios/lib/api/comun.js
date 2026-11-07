"use strict";

const { error, claveDelDia, fechaHora, redondear, igualesSeguros } = require("../util");
const { insertar, actualizar, auditar, leerConfig } = require("../negocio");

function esAdmin(ctx) {
  return ctx.usuario?.rol === "ADMIN";
}

function exigirAdmin(ctx) {
  if (!esAdmin(ctx)) throw error("Esta acción la hace un administrador", 403);
}

function bocasDe(ctx) {
  return (ctx.usuario?.bocas || []).map(Number);
}

function exigirBoca(ctx, bocaId, mensaje = "No tenés asignada esa boca") {
  if (esAdmin(ctx)) return;
  if (!bocasDe(ctx).includes(Number(bocaId))) throw error(mensaje, 403);
}

function exigirPuesto(ctx) {
  const s = ctx.sesion || {};
  if (!s.caja_id || !s.boca_id) throw error("Elegí la boca y la caja en la que vas a trabajar", 409, { codigo: "SIN_PUESTO" });
  return s;
}

// Intentos fallidos de la clave del día por usuario (en memoria): 5 cada 10 minutos.
const fallosClave = new Map();
const VENTANA_CLAVE_MS = 10 * 60 * 1000;

function claveIntentos(ctx) {
  const generalId = ctx.usuario?.general_usuario_id;
  return `${ctx.pid}:${generalId ? "general-" + generalId : ctx.usuario?.id || ctx.ip || "anon"}`;
}

function controlarIntentosClave(ctx) {
  const k = claveIntentos(ctx);
  const e = fallosClave.get(k);
  if (e && Date.now() - e.inicio < VENTANA_CLAVE_MS && e.n >= 5) {
    throw error("Demasiados intentos con la clave. Esperá unos minutos o pedí la autorización a distancia.", 429, { codigo: "CLAVE_BLOQUEADA" });
  }
}

function registrarFalloClave(ctx, tipo, referenciaId) {
  const k = claveIntentos(ctx);
  const e = fallosClave.get(k);
  if (!e || Date.now() - e.inicio >= VENTANA_CLAVE_MS) fallosClave.set(k, { inicio: Date.now(), n: 1 });
  else e.n++;
  if (fallosClave.size > 2000) fallosClave.delete(fallosClave.keys().next().value);
  // La auditoría del intento fallido va fuera de la transacción (que se revierte).
  const detalle = { tipo, referencia_id: referenciaId || null };
  const db = ctx.dbAuditoria || ctx.db;
  const registro = ctx.auditarFalloClave ? ctx.auditarFalloClave(detalle)
    : db.tx((t) => auditar(t, { ...ctx, db: t }, "Clave del día incorrecta", "permiso", null, detalle));
  registro.catch(() => {});
}

function claveCorrecta(clave) {
  const limpia = String(clave || "").replace(/\D/g, "");
  return limpia.length > 0 && igualesSeguros(limpia, claveDelDia());
}

function validarClave(ctx, clave, tipo, referenciaId, mensaje = "La clave no es correcta. Pedile al administrador que la escriba.") {
  controlarIntentosClave(ctx);
  if (!claveCorrecta(clave)) {
    registrarFalloClave(ctx, tipo, referenciaId);
    throw error(mensaje, 403, { codigo: "CLAVE_INCORRECTA" });
  }
}

// Autoriza una acción restringida para un usuario de boca. Un administrador no la necesita.
// Formas: la clave del día que escribe el administrador en esa PC, o un permiso aprobado
// a distancia (desde la cuenta del administrador, en el camping o en el sistema general).
async function autorizar(t, ctx, tipo, { clave, permisoId, referenciaId, detalle } = {}) {
  if (esAdmin(ctx)) return { metodo: "ADMIN", permisoId: null };
  if (clave !== undefined && clave !== null && String(clave).trim() !== "") {
    validarClave(ctx, clave, tipo, referenciaId);
    const config = await leerConfig(t, ctx);
    const ahora = new Date();
    const id = await insertar(t, ctx, "predio_permiso", {
      tipo,
      estado: "USADO",
      usuario_id: ctx.usuario.id,
      usuario_nombre: ctx.usuario.nombre,
      boca_id: ctx.sesion?.boca_id || null,
      caja_id: ctx.sesion?.caja_id || null,
      referencia_id: referenciaId || null,
      detalle: detalle ? String(detalle).slice(0, 255) : null,
      fecha_solicitud: fechaHora(ahora),
      resuelto_por: "Clave del día",
      resuelto_fecha: fechaHora(ahora),
      metodo: "CLAVE",
      vence: fechaHora(new Date(ahora.getTime() + Number(config.minutos_permiso || 30) * 60000)),
      usado_fecha: fechaHora(ahora),
    });
    await auditar(t, ctx, "Autorizado con la clave del día", "permiso", id, { tipo, referencia_id: referenciaId || null });
    return { metodo: "CLAVE", permisoId: id };
  }
  if (permisoId) {
    const permiso = await t.get(
      `SELECT * FROM predio_permiso WHERE predio_id = ? AND id = ?${t.forUpdate}`,
      [ctx.pid, Number(permisoId)]
    );
    if (!permiso || Number(permiso.usuario_id) !== Number(ctx.usuario.id) || permiso.tipo !== tipo) {
      throw error("La autorización no corresponde a esta acción", 403);
    }
    if (permiso.estado !== "APROBADO") throw error("El administrador todavía no aprobó el pedido", 403, { codigo: "SIN_AUTORIZACION" });
    if (permiso.vence && permiso.vence < fechaHora()) throw error("La autorización venció. Pedila de nuevo.", 403, { codigo: "SIN_AUTORIZACION" });
    // Si la acción es sobre algo puntual (una venta, una caja), el permiso tiene que ser para eso mismo.
    if (referenciaId && Number(permiso.referencia_id) !== Number(referenciaId)) {
      throw error("La autorización es para otra operación", 403);
    }
    // VER_VENTAS_CAJA se puede usar varias veces mientras esté vigente.
    if (tipo !== "VER_VENTAS_CAJA") {
      await actualizar(t, ctx, "predio_permiso", permiso.id, { estado: "USADO", usado_fecha: fechaHora() });
    }
    return { metodo: "REMOTO", permisoId: permiso.id };
  }
  throw error("Necesitás la autorización del administrador", 403, { codigo: "SIN_AUTORIZACION", tipo });
}

async function disponibleAfiliado(t, ctx, afiliadoId) {
  const fila = await t.get(
    `SELECT a.limite, a.habilitado_descuento,
       (SELECT COALESCE(SUM(COALESCE(v.importe_haberes,v.total)), 0) FROM predio_venta v
        WHERE v.predio_id = a.predio_id AND v.afiliado_id = a.id AND (v.forma_pago = 'DESCUENTO' OR v.importe_haberes>0)
          AND v.estado = 'CONFIRMADA' AND v.liquidacion_id IS NULL) AS pendiente
     FROM predio_afiliado a WHERE a.predio_id = ? AND a.id = ?`,
    [ctx.pid, afiliadoId]
  );
  if (!fila) return { limite: 0, pendiente: 0, disponible: 0, habilitado: false };
  const limite = redondear(Number(fila.limite || 0));
  const pendiente = redondear(Number(fila.pendiente || 0));
  return { limite, pendiente, disponible: redondear(limite - pendiente), habilitado: Number(fila.habilitado_descuento) === 1 };
}

function turnoDeCaja(ctx, cajaId) {
  return Number(ctx.sesion?.caja_id) === Number(cajaId) ? ctx.sesion?.turno_id || null : null;
}

module.exports = {
  esAdmin,
  exigirAdmin,
  bocasDe,
  exigirBoca,
  exigirPuesto,
  turnoDeCaja,
  autorizar,
  claveCorrecta,
  validarClave,
  disponibleAfiliado,
};
