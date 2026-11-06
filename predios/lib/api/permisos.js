"use strict";

// Pedidos de autorización (pedir productos, anular ventas, ver todas las ventas de la caja),
// avisos para la campana y estadísticas.

const U = require("../util");
const N = require("../negocio");
const { listarAvisos, leerAviso } = require("../avisos");
const { revisarPreciosVencidos } = require("../precios");
const { TIPOS_PERMISO, textoDe } = require("../listados");
const { exigirAdmin, esAdmin, bocasDe, validarClave, exigirPuesto } = require("./comun");

const TIPOS = TIPOS_PERMISO.map((t) => t.valor);

async function pedir(ctx) {
  if (esAdmin(ctx)) throw U.error("Como administrador no necesitás pedir autorización");
  const tipo = U.opcion(ctx.body.tipo, TIPOS, "El tipo de autorización");
  const referenciaId = ctx.body.referencia_id ? U.id(ctx.body.referencia_id, "La referencia") : (tipo === "VER_VENTAS_CAJA" ? ctx.sesion?.caja_id || null : null);
  const detalle = U.texto(ctx.body.detalle, { max: 255 });
  if (tipo === "ANULAR_VENTA" && !referenciaId) throw U.error("Indicá qué venta querés anular");
  return ctx.db.tx(async (t) => {
    if (tipo === "ANULAR_VENTA") {
      const v = await N.exigir(t, ctx, "predio_venta", referenciaId, "No encontramos la venta");
      if (Number(v.caja_id) !== Number(ctx.sesion?.caja_id)) throw U.error("Sólo podés pedir anular ventas de tu caja", 403);
    }
    const abierto = await t.get(
      `SELECT id FROM predio_permiso WHERE predio_id = ? AND usuario_id = ? AND tipo = ? AND estado = 'PENDIENTE'
       AND (referencia_id = ? OR (referencia_id IS NULL AND ? IS NULL)) ORDER BY id DESC LIMIT 1`,
      [ctx.pid, ctx.usuario.id, tipo, referenciaId, referenciaId]);
    if (abierto) return { id: abierto.id, mensaje: "Ya pediste esta autorización: esperá la respuesta del administrador" };
    const id = await N.insertar(t, ctx, "predio_permiso", {
      tipo, estado: "PENDIENTE", usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      boca_id: ctx.sesion?.boca_id || null, caja_id: ctx.sesion?.caja_id || null, referencia_id: referenciaId,
      detalle, fecha_solicitud: U.fechaHora(),
    });
    await N.auditar(t, ctx, "Pedido de autorización", "permiso", id, { tipo, referencia_id: referenciaId, detalle });
    return { id, mensaje: "Le avisamos al administrador. Cuando lo apruebe vas a poder seguir." };
  });
}

async function verPermiso(ctx) {
  const id = U.id(ctx.params.id);
  const p = await N.exigir(ctx.db, ctx, "predio_permiso", id, "No encontramos el pedido");
  if (!esAdmin(ctx) && Number(p.usuario_id) !== Number(ctx.usuario.id)) throw U.error("No tenés acceso a este pedido", 403);
  const vencido = p.estado === "APROBADO" && p.vence && p.vence < U.fechaHora();
  return { permiso: { ...p, estado: vencido ? "VENCIDO" : p.estado } };
}

async function resolver(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id);
  const aprobar = ctx.body.aprobar === true || ctx.body.aprobar === 1 || ctx.body.aprobar === "1";
  return ctx.db.tx(async (t) => {
    const p = await N.exigir(t, ctx, "predio_permiso", id, "No encontramos el pedido", { bloquear: true });
    if (p.estado !== "PENDIENTE") throw U.error("Ese pedido ya fue resuelto", 409);
    const config = await N.leerConfig(t, ctx);
    const ahora = new Date();
    await N.actualizar(t, ctx, "predio_permiso", id, {
      estado: aprobar ? "APROBADO" : "RECHAZADO", resuelto_por: N.nombreActor(ctx), resuelto_fecha: U.fechaHora(ahora), metodo: "REMOTO",
      vence: aprobar ? U.fechaHora(new Date(ahora.getTime() + Number(config.minutos_permiso || 30) * 60000)) : null,
    });
    await N.auditar(t, ctx, aprobar ? "Autorización aprobada" : "Autorización rechazada", "permiso", id, { tipo: p.tipo, usuario: p.usuario_nombre });
    return { id, mensaje: aprobar ? `Aprobaste: ${textoDe(TIPOS_PERMISO, p.tipo).toLowerCase()} para ${p.usuario_nombre}` : "Pedido rechazado" };
  });
}

// Valida la clave del día sin consumir nada (para abrir pantallas protegidas en esa PC).
async function probarClave(ctx) {
  validarClave(ctx, ctx.body.clave, "PRUEBA", null);
  return { ok: true };
}

async function avisos(ctx) {
  if (esAdmin(ctx) && !ctx.soloLectura) await revisarPreciosVencidos(ctx.db, ctx);
  const db = ctx.db;
  const pid = ctx.pid;
  const hoy = U.hoy();
  const salida = { permisos: [], solicitudes_despachar: 0, solicitudes_recibir: 0, aperturas: [], vencimientos: 0, stock_negativo: 0, mis_permisos: [] };
  salida.notificaciones = await listarAvisos(ctx);
  if (esAdmin(ctx)) {
    salida.permisos = await db.all(
      `SELECT x.id, x.tipo, x.usuario_nombre, x.detalle, x.fecha_solicitud, b.nombre AS boca, c.nombre AS caja
       FROM predio_permiso x LEFT JOIN predio_boca b ON b.predio_id = x.predio_id AND b.id = x.boca_id
       LEFT JOIN predio_caja c ON c.predio_id = x.predio_id AND c.id = x.caja_id
       WHERE x.predio_id = ? AND x.estado = 'PENDIENTE' ORDER BY x.id DESC LIMIT 30`, [pid]);
    const d = await db.get("SELECT COUNT(*) AS n FROM predio_solicitud WHERE predio_id = ? AND estado = 'PENDIENTE'", [pid]);
    const r = await db.get("SELECT COUNT(*) AS n FROM predio_solicitud WHERE predio_id = ? AND estado = 'DESPACHADA'", [pid]);
    salida.solicitudes_despachar = Number(d.n);
    salida.solicitudes_recibir = Number(r.n);
    salida.aperturas = await db.all(
      `SELECT a.id, a.caja_id, a.importe, a.verificado_por, a.observacion, c.nombre AS caja, b.nombre AS boca
       FROM predio_apertura a JOIN predio_caja c ON c.predio_id = a.predio_id AND c.id = a.caja_id
       JOIN predio_boca b ON b.predio_id = c.predio_id AND b.id = c.boca_id
       WHERE a.predio_id = ? AND a.fecha = ? AND a.verificacion = 'NO_COINCIDE'`, [pid, hoy]);
    const v = await db.get(
      "SELECT COUNT(*) AS n FROM predio_producto WHERE predio_id = ? AND activo = 1 AND fecha_caducidad IS NOT NULL AND fecha_caducidad <= ?",
      [pid, U.sumarDias(hoy, 7)]);
    salida.vencimientos = Number(v.n);
    const neg = await db.get("SELECT COUNT(*) AS n FROM predio_stock WHERE predio_id = ? AND cantidad < 0", [pid]);
    salida.stock_negativo = Number(neg.n);
  } else {
    const bocas = bocasDe(ctx);
    if (bocas.length) {
      const l = bocas.map(() => "?").join(", ");
      const d = await db.get(`SELECT COUNT(*) AS n FROM predio_solicitud WHERE predio_id = ? AND estado = 'PENDIENTE' AND boca_origen_id IN (${l})`, [pid, ...bocas]);
      const r = await db.get(`SELECT COUNT(*) AS n FROM predio_solicitud WHERE predio_id = ? AND estado = 'DESPACHADA' AND boca_destino_id IN (${l})`, [pid, ...bocas]);
      salida.solicitudes_despachar = Number(d.n);
      salida.solicitudes_recibir = Number(r.n);
    }
    salida.mis_permisos = await db.all(
      `SELECT id, tipo, estado, referencia_id, vence, resuelto_por, resuelto_fecha FROM predio_permiso
       WHERE predio_id = ? AND usuario_id = ? AND (estado = 'PENDIENTE' OR (estado IN ('APROBADO', 'RECHAZADO') AND resuelto_fecha >= ?))
       ORDER BY id DESC LIMIT 10`, [pid, ctx.usuario.id, U.fechaHora(new Date(Date.now() - 2 * 3600000))]);
    if (ctx.sesion?.caja_id) {
      salida.apertura = await db.get(
        "SELECT id, importe, verificacion FROM predio_apertura WHERE predio_id = ? AND caja_id = ? AND fecha = ?",
        [pid, ctx.sesion.caja_id, hoy]) || null;
    }
  }
  salida.total = salida.notificaciones.length + salida.permisos.length + salida.aperturas.length + salida.solicitudes_despachar + salida.solicitudes_recibir;
  return salida;
}

// ------------------------------------------------------------------ estadísticas

async function estadisticas(ctx) {
  exigirAdmin(ctx);
  const db = ctx.db;
  const pid = ctx.pid;
  const hasta = U.esFechaIso(ctx.query.hasta) ? ctx.query.hasta : U.hoy();
  const desde = U.esFechaIso(ctx.query.desde) ? ctx.query.desde : U.sumarDias(hasta, -29);
  const bocaId = Number(ctx.query.boca_id) || null;
  const filtroBoca = bocaId ? " AND v.boca_id = ?" : "";
  const p = [pid, desde, U.sumarDias(hasta, 1), ...(bocaId ? [bocaId] : [])];
  const base = `FROM predio_venta v WHERE v.predio_id = ? AND v.estado = 'CONFIRMADA' AND v.fecha >= ? AND v.fecha < ?${filtroBoca}`;
  const kpi = await db.get(`SELECT COUNT(*) AS ventas, COALESCE(SUM(v.total), 0) AS total, COALESCE(AVG(v.total), 0) AS promedio,
      COUNT(DISTINCT v.afiliado_id) AS afiliados ${base}`, p);
  const porDia = await db.all(`SELECT SUBSTR(v.fecha, 1, 10) AS dia, COUNT(*) AS ventas, COALESCE(SUM(v.total), 0) AS total ${base} GROUP BY SUBSTR(v.fecha, 1, 10) ORDER BY dia`, p);
  const porForma = await db.all(`SELECT v.forma_pago AS clave, COUNT(*) AS ventas, COALESCE(SUM(v.total), 0) AS total ${base} GROUP BY v.forma_pago ORDER BY total DESC`, p);
  const porBoca = await db.all(
    `SELECT b.nombre AS clave, COUNT(*) AS ventas, COALESCE(SUM(v.total), 0) AS total FROM predio_venta v
     JOIN predio_boca b ON b.predio_id = v.predio_id AND b.id = v.boca_id
     WHERE v.predio_id = ? AND v.estado = 'CONFIRMADA' AND v.fecha >= ? AND v.fecha < ?${filtroBoca} GROUP BY b.nombre ORDER BY total DESC`, p);
  const porHora = await db.all(`SELECT SUBSTR(v.fecha, 12, 2) AS hora, COUNT(*) AS ventas, COALESCE(SUM(v.total), 0) AS total ${base} GROUP BY SUBSTR(v.fecha, 12, 2) ORDER BY hora`, p);
  const topProductos = await db.all(
    `SELECT i.descripcion AS producto, SUM(i.cantidad) AS unidades, SUM(i.subtotal) AS total
     FROM predio_venta_item i JOIN predio_venta v ON v.predio_id = i.predio_id AND v.id = i.venta_id
     WHERE v.predio_id = ? AND v.estado = 'CONFIRMADA' AND v.fecha >= ? AND v.fecha < ?${filtroBoca}
     GROUP BY i.descripcion ORDER BY total DESC LIMIT 10`, p);
  const compras = await db.get(
    `SELECT COUNT(*) AS cantidad, COALESCE(SUM(total_items), 0) AS total FROM predio_compra
     WHERE predio_id = ? AND estado = 'CARGADA' AND fecha_factura >= ? AND fecha_factura <= ?`, [pid, desde, hasta]);
  const comprasProveedor = await db.all(
    `SELECT pr.razon_social AS clave, COUNT(*) AS compras, COALESCE(SUM(c.total_items), 0) AS total FROM predio_compra c
     JOIN predio_proveedor pr ON pr.predio_id = c.predio_id AND pr.id = c.proveedor_id
     WHERE c.predio_id = ? AND c.estado = 'CARGADA' AND c.fecha_factura >= ? AND c.fecha_factura <= ?
     GROUP BY pr.razon_social ORDER BY total DESC LIMIT 8`, [pid, desde, hasta]);
  const bajas = await db.all(
    `SELECT x.motivo AS clave, COUNT(*) AS cantidad, COALESCE(SUM(x.cantidad * COALESCE(p.precio_compra, 0)), 0) AS total
     FROM predio_baja x JOIN predio_producto p ON p.predio_id = x.predio_id AND p.id = x.producto_id
     WHERE x.predio_id = ? AND x.fecha >= ? AND x.fecha < ? GROUP BY x.motivo ORDER BY total DESC`, [pid, desde, U.sumarDias(hasta, 1)]);
  const ganancia = await db.get(
    `SELECT COALESCE(SUM(i.subtotal - i.cantidad * COALESCE(pr.precio_compra, 0)), 0) AS ganancia
     FROM predio_venta_item i JOIN predio_venta v ON v.predio_id = i.predio_id AND v.id = i.venta_id
     LEFT JOIN predio_producto pr ON pr.predio_id = i.predio_id AND pr.id = i.producto_id
     WHERE v.predio_id = ? AND v.estado = 'CONFIRMADA' AND v.fecha >= ? AND v.fecha < ?${filtroBoca}`, p);
  const stockValor = await db.get(
    `SELECT COALESCE(SUM(s.cantidad * COALESCE(p.precio_compra, 0)), 0) AS valor, COUNT(DISTINCT s.producto_id) AS productos
     FROM predio_stock s JOIN predio_producto p ON p.predio_id = s.predio_id AND p.id = s.producto_id WHERE s.predio_id = ? AND s.cantidad > 0`, [pid]);
  const numeros = (filas) => filas.map((f) => {
    const o = { ...f };
    for (const k of Object.keys(o)) if (k !== "clave" && k !== "dia" && k !== "hora" && k !== "producto") o[k] = U.redondear(Number(o[k] || 0), 2);
    return o;
  });
  return {
    desde, hasta,
    kpi: {
      ventas: Number(kpi.ventas), total: U.redondear(Number(kpi.total)), promedio: U.redondear(Number(kpi.promedio)), afiliados: Number(kpi.afiliados),
      compras: Number(compras.cantidad), compras_total: U.redondear(Number(compras.total)), ganancia: U.redondear(Number(ganancia.ganancia)),
      stock_valor: U.redondear(Number(stockValor.valor)), stock_productos: Number(stockValor.productos),
    },
    por_dia: numeros(porDia), por_forma: numeros(porForma), por_boca: numeros(porBoca), por_hora: numeros(porHora),
    top_productos: numeros(topProductos), compras_proveedor: numeros(comprasProveedor), bajas: numeros(bajas),
  };
}

// Resumen del día para la portada del administrador.
async function inicio(ctx) {
  const db = ctx.db;
  const pid = ctx.pid;
  const hoy = U.hoy();
  if (!esAdmin(ctx)) {
    const s = exigirPuesto(ctx);
    const r = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS t FROM predio_venta WHERE predio_id = ? AND turno_id = ? AND estado = 'CONFIRMADA'", [pid, s.turno_id || -1]);
    return { turno: { ventas: Number(r.n), total: U.redondear(Number(r.t)) } };
  }
  const ventas = await db.get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS t FROM predio_venta WHERE predio_id = ? AND estado = 'CONFIRMADA' AND fecha >= ?", [pid, hoy]);
  const porBoca = await db.all(
    `SELECT b.nombre AS boca, COUNT(*) AS ventas, COALESCE(SUM(v.total), 0) AS total FROM predio_venta v
     JOIN predio_boca b ON b.predio_id = v.predio_id AND b.id = v.boca_id
     WHERE v.predio_id = ? AND v.estado = 'CONFIRMADA' AND v.fecha >= ? GROUP BY b.nombre ORDER BY total DESC`, [pid, hoy]);
  const enPredio = await db.get(
    "SELECT COUNT(DISTINCT afiliado_id) AS n FROM predio_estadia WHERE predio_id = ? AND activo = 1 AND fecha_inicio <= ? AND fecha_fin >= ?", [pid, hoy, hoy]);
  const efectivo = await db.get(
    "SELECT COALESCE(SUM(CASE WHEN tipo = 'INGRESO' THEN importe ELSE -importe END), 0) AS s FROM predio_caja_movimiento WHERE predio_id = ?", [pid]);
  const ultimas = await db.all(
    `SELECT v.id, v.fecha, v.total, v.forma_pago, v.afiliado_nombre, b.nombre AS boca FROM predio_venta v
     JOIN predio_boca b ON b.predio_id = v.predio_id AND b.id = v.boca_id
     WHERE v.predio_id = ? AND v.estado = 'CONFIRMADA' ORDER BY v.id DESC LIMIT 8`, [pid]);
  return {
    hoy: { ventas: Number(ventas.n), total: U.redondear(Number(ventas.t)), por_boca: porBoca.map((b) => ({ ...b, total: U.redondear(Number(b.total)) })) },
    afiliados_en_predio: Number(enPredio.n),
    efectivo_en_cajas: U.redondear(Number(efectivo.s)),
    ultimas_ventas: ultimas,
  };
}

module.exports = {
  rutas: [
    { m: "POST", p: "/permisos", h: pedir, escritura: true },
    { m: "GET", p: "/permisos/:id", h: verPermiso },
    { m: "POST", p: "/permisos/:id/resolver", h: resolver, escritura: true, roles: ["ADMIN"] },
    { m: "POST", p: "/permisos/probar-clave", h: probarClave, soloLocal: true },
    { m: "GET", p: "/avisos", h: avisos },
    { m: "POST", p: "/avisos/:id/leer", h: leerAviso, escritura: true },
    { m: "GET", p: "/estadisticas", h: estadisticas, roles: ["ADMIN"] },
    { m: "GET", p: "/inicio", h: inicio },
  ],
};
