"use strict";

// Tabla única de rutas de la API del predio. La usa el servidor local del camping y
// también el sistema general (modo remoto), con la misma lógica de negocio.

const U = require("../util");
const listados = require("../listados");
const N = require("../negocio");

const modulos = [
  require("./sesion"),
  require("./catalogo"),
  require("./stock"),
  require("./compras"),
  require("./ventas"),
  require("./caja"),
  require("./afiliados"),
  require("./permisos"),
];

async function metaListado(ctx) {
  return listados.meta(ctx, ctx.params.nombre);
}

async function verListado(ctx) {
  const nombre = ctx.params.nombre;
  if (nombre === "productos") {
    const almacen = await N.bocaAlmacen(ctx.db, ctx);
    ctx.almacenId = almacen ? almacen.id : null;
  }
  if (nombre === "ventas" && ctx.query.ambito === "caja" && ctx.usuario?.rol !== "ADMIN" && ctx.sesion?.caja_id) {
    const p = await ctx.db.get(
      `SELECT id FROM predio_permiso WHERE predio_id = ? AND usuario_id = ? AND tipo = 'VER_VENTAS_CAJA'
       AND estado IN ('APROBADO', 'USADO') AND referencia_id = ? AND vence >= ? ORDER BY id DESC LIMIT 1`,
      [ctx.pid, ctx.usuario.id, ctx.sesion.caja_id, U.fechaHora()]);
    if (!p) throw U.error("Para ver todas las ventas de la caja necesitás la autorización del administrador", 403, { codigo: "SIN_AUTORIZACION", tipo: "VER_VENTAS_CAJA" });
    ctx.verVentasCaja = true;
  }
  return listados.ejecutar(ctx, nombre, ctx.query);
}

const RUTAS = [
  ...modulos.flatMap((m) => m.rutas),
  { m: "GET", p: "/listados/:nombre/meta", h: metaListado },
  { m: "GET", p: "/listados/:nombre", h: verListado },
];

const COMPILADAS = RUTAS.map((r) => {
  const nombres = [];
  const patron = r.p.replace(/:([a-z_]+)/g, (_m, n) => { nombres.push(n); return "([^/]+)"; });
  return { ...r, regex: new RegExp(`^${patron}/?$`), nombres };
});

function buscarRuta(metodo, ruta) {
  for (const r of COMPILADAS) {
    if (r.m !== metodo) continue;
    const m = r.regex.exec(ruta);
    if (m) {
      const params = {};
      r.nombres.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { ruta: r, params };
    }
  }
  return null;
}

// Ejecuta una ruta con un contexto ya autenticado (o público si la ruta lo permite).
async function ejecutar(ctx, metodo, ruta) {
  const encontrada = buscarRuta(metodo, ruta);
  if (!encontrada) throw U.error("No encontramos esa operación", 404);
  const r = encontrada.ruta;
  if (ctx.modo === "central" && r.soloLocal) throw U.error("Esta operación se hace desde el camping", 409);
  if (!r.publica && !ctx.usuario) throw U.error("Iniciá sesión para continuar", 401, { codigo: "SIN_SESION" });
  if (r.roles && !r.roles.includes(ctx.usuario?.rol)) throw U.error("Esta acción la hace un administrador", 403);
  ctx.params = encontrada.params;
  ctx.query = ctx.query || {};
  ctx.body = ctx.body && typeof ctx.body === "object" ? ctx.body : {};
  return r.h(ctx);
}

module.exports = { RUTAS, buscarRuta, ejecutar };
