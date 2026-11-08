"use strict";

const { error, fechaHora, redondear } = require("../util");
const { actualizar } = require("../negocio");

const ROLES_GESTION_CAJA = ["ADMIN", "SUPERVISOR"];

function esAdmin(ctx) {
  return ctx.usuario?.rol === "ADMIN";
}

function esSupervisor(ctx) {
  return ctx.usuario?.rol === "SUPERVISOR";
}

function puedeGestionarCajas(ctx) {
  return ROLES_GESTION_CAJA.includes(ctx.usuario?.rol);
}

function puedeGestionarReservas(usuario) {
  return usuario?.rol === "ADMIN" ||
    ["CAJERO", "SUPERVISOR"].includes(usuario?.rol) && Number(usuario.gestionar_reservas) === 1;
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

// Autoriza una acción restringida para un usuario de boca. Un administrador no la necesita.
// El permiso lo aprueba el administrador: a distancia (desde su cuenta, en el camping o en
// el sistema general) o en esa misma PC, escribiendo su usuario y su contraseña
// (POST /permisos/presencial). En los dos casos llega acá como un permiso APROBADO.
async function autorizar(t, ctx, tipo, { permisoId, referenciaId } = {}) {
  if (esAdmin(ctx)) return { metodo: "ADMIN", permisoId: null };
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
    return { metodo: permiso.metodo === "PRESENCIAL" ? "PRESENCIAL" : "REMOTO", permisoId: permiso.id };
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
  ROLES_GESTION_CAJA,
  esAdmin,
  esSupervisor,
  puedeGestionarCajas,
  puedeGestionarReservas,
  exigirAdmin,
  bocasDe,
  exigirBoca,
  exigirPuesto,
  turnoDeCaja,
  autorizar,
  disponibleAfiliado,
};
