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

function claveCorrecta(clave) {
  const limpia = String(clave || "").replace(/\D/g, "");
  return limpia.length > 0 && igualesSeguros(limpia, claveDelDia());
}

// Autoriza una acción restringida para un usuario de boca. Un administrador no la necesita.
// Formas: la clave del día que escribe el administrador en esa PC, o un permiso aprobado
// a distancia (desde la cuenta del administrador, en el camping o en el sistema general).
async function autorizar(t, ctx, tipo, { clave, permisoId, referenciaId, detalle } = {}) {
  if (esAdmin(ctx)) return { metodo: "ADMIN", permisoId: null };
  if (clave !== undefined && clave !== null && String(clave).trim() !== "") {
    if (!claveCorrecta(clave)) {
      await auditar(t, ctx, "Clave del día incorrecta", "permiso", null, { tipo, referencia_id: referenciaId || null });
      throw error("La clave no es correcta. Pedile al administrador que la escriba.", 403, { codigo: "CLAVE_INCORRECTA" });
    }
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
    if (permiso.referencia_id && referenciaId && Number(permiso.referencia_id) !== Number(referenciaId)) {
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
       (SELECT COALESCE(SUM(v.total), 0) FROM predio_venta v
        WHERE v.predio_id = a.predio_id AND v.afiliado_id = a.id AND v.forma_pago = 'DESCUENTO'
          AND v.estado = 'CONFIRMADA' AND v.liquidacion_id IS NULL) AS pendiente
     FROM predio_afiliado a WHERE a.predio_id = ? AND a.id = ?`,
    [ctx.pid, afiliadoId]
  );
  if (!fila) return { limite: 0, pendiente: 0, disponible: 0, habilitado: false };
  const limite = redondear(Number(fila.limite || 0));
  const pendiente = redondear(Number(fila.pendiente || 0));
  return { limite, pendiente, disponible: redondear(limite - pendiente), habilitado: Number(fila.habilitado_descuento) === 1 };
}

module.exports = {
  esAdmin,
  exigirAdmin,
  bocasDe,
  exigirBoca,
  exigirPuesto,
  autorizar,
  claveCorrecta,
  disponibleAfiliado,
};
