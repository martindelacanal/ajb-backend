"use strict";

const N = require("./negocio");
const U = require("./util");
const { emitirAviso } = require("./avisos");
const revisados = new WeakMap();
const INTERVALO_MS = 60000;

function claveDe(bocaId, productoId) { return `${Number(bocaId)}:${Number(productoId)}`; }
function cantidadTexto(cantidad) { return Number(cantidad).toLocaleString("es-AR", { maximumFractionDigits: 3 }); }

// El stock de cada boca tiene su propio episodio. La fila de stock se bloquea
// antes de consultar los avisos: ventas simultáneas no duplican la notificación.
async function revisarPar(t, ctx, bocaId, productoId) {
  const stock = await t.get(`SELECT id, cantidad FROM predio_stock
    WHERE predio_id = ? AND boca_id = ? AND producto_id = ?${t.forUpdate}`, [ctx.pid, bocaId, productoId]);
  const producto = await t.get("SELECT nombre, unidad, stock_minimo, activo FROM predio_producto WHERE predio_id = ? AND id = ?", [ctx.pid, productoId]);
  const boca = await t.get("SELECT nombre, activo FROM predio_boca WHERE predio_id = ? AND id = ?", [ctx.pid, bocaId]);
  const clave = claveDe(bocaId, productoId);
  const abiertos = await t.all(`SELECT id, usuario_id FROM predio_aviso
    WHERE predio_id = ? AND tipo = 'STOCK_MINIMO' AND resuelto_fecha IS NULL AND detalle LIKE ?${t.forUpdate}`,
  [ctx.pid, `%"stock_minimo_clave":"${clave}"%`]);
  const minimo = Number(producto?.stock_minimo || 0);
  // La eliminación física también resuelve el episodio. La consulta bloqueada
  // del par y la lectura actual de avisos conservan la serialización aun sin fila.
  const bajo = !!stock && Number(producto?.activo) === 1 && Number(boca?.activo) === 1 && minimo > 0 && Number(stock.cantidad) < minimo;
  if (!bajo) {
    const fecha = U.fechaHora();
    for (const aviso of abiertos) await N.actualizar(t, ctx, "predio_aviso", aviso.id, { resuelto_fecha: fecha });
    return { emitidos: 0, resueltos: abiertos.length };
  }

  // El aviso es para quien decide reponer: Administración (sin destinatario) y cada
  // supervisor asignado a esa boca. Los cajeros no lo reciben.
  const usuarios = await t.all(`SELECT u.id FROM predio_usuario u
    WHERE u.predio_id = ? AND u.activo = 1 AND u.rol = 'SUPERVISOR'
      AND EXISTS (SELECT 1 FROM predio_usuario_boca ub WHERE ub.predio_id = u.predio_id AND ub.usuario_id = u.id AND ub.boca_id = ?)`,
  [ctx.pid, bocaId]);
  const destinatarios = [null, ...usuarios.map((u) => Number(u.id))];
  const vigentes = new Set(destinatarios);
  const previos = new Set();
  for (const aviso of abiertos) {
    const usuarioId = aviso.usuario_id == null ? null : Number(aviso.usuario_id);
    // Avisos anteriores a este criterio (cajeros) o de alguien que ya no supervisa la boca.
    if (!vigentes.has(usuarioId)) await N.actualizar(t, ctx, "predio_aviso", aviso.id, { resuelto_fecha: U.fechaHora() });
    else previos.add(usuarioId);
  }
  const emitidos = [];
  for (const usuarioId of destinatarios) {
    if (previos.has(usuarioId)) continue;
    const id = await emitirAviso(t, ctx, {
      tipo: "STOCK_MINIMO", usuarioId,
      titulo: `Stock bajo de ${producto.nombre}`.slice(0, 180),
      mensaje: `«${producto.nombre}» en ${boca.nombre}: quedan ${cantidadTexto(stock.cantidad)}${producto.unidad ? ` ${producto.unidad}` : ""}, por debajo del mínimo de ${cantidadTexto(minimo)}. Revisá si hace falta reponer.`,
      detalle: { stock_minimo_clave: clave, boca_id: Number(bocaId), boca: boca.nombre, producto_id: Number(productoId), producto: producto.nombre, cantidad: Number(stock.cantidad), stock_minimo: minimo, unidad: producto.unidad || null },
    });
    emitidos.push(id);
  }
  if (ctx.alAvisosStock && emitidos.length) {
    const filas = await t.all(`SELECT * FROM predio_aviso WHERE predio_id = ? AND id IN (${emitidos.map(() => "?").join(", ")})`, [ctx.pid, ...emitidos]);
    await ctx.alAvisosStock(t, filas);
  }
  return { emitidos: emitidos.length, resueltos: 0 };
}

async function revisarProducto(t, ctx, productoId) {
  const bocas = await t.all("SELECT boca_id FROM predio_stock WHERE predio_id = ? AND producto_id = ? ORDER BY boca_id", [ctx.pid, productoId]);
  for (const boca of bocas) await revisarPar(t, ctx, boca.boca_id, productoId);
}

async function bloquearStockProducto(t, ctx, productoId) {
  // La edición del mínimo evalúa varias bocas de forma atómica. Toma sus locks
  // antes de emitir avisos y bloquear la secuencia compartida de identificadores.
  await t.all(`SELECT id FROM predio_stock WHERE predio_id = ? AND producto_id = ? ORDER BY boca_id${t.forUpdate}`, [ctx.pid, productoId]);
}

// Recupera existencias previas a esta función y nuevos usuarios de boca. No se
// generan escrituras desde una réplica cuyo dueño sigue siendo la notebook.
async function revisarStockMinimo(db, ctx, { forzar = false } = {}) {
  if (ctx.soloLectura || (ctx.modo === "central" && ctx.revisarPreciosCentral !== true)) return;
  let porPredio = revisados.get(db);
  if (!porPredio) { porPredio = new Map(); revisados.set(db, porPredio); }
  const ahora = Date.now();
  if (!forzar && porPredio.has(ctx.pid) && ahora - porPredio.get(ctx.pid) < INTERVALO_MS) return;
  const filas = await db.all(`SELECT s.boca_id, s.producto_id FROM predio_stock s
      JOIN predio_producto p ON p.predio_id = s.predio_id AND p.id = s.producto_id
      JOIN predio_boca b ON b.predio_id = s.predio_id AND b.id = s.boca_id
      WHERE s.predio_id = ? AND p.activo = 1 AND b.activo = 1 AND p.stock_minimo > 0 AND s.cantidad < p.stock_minimo`, [ctx.pid]);
  const pares = new Map(filas.map((s) => [claveDe(s.boca_id, s.producto_id), s]));
  const abiertos = await db.all("SELECT detalle FROM predio_aviso WHERE predio_id = ? AND tipo = 'STOCK_MINIMO' AND resuelto_fecha IS NULL", [ctx.pid]);
  for (const aviso of abiertos) {
    try {
      const d = JSON.parse(aviso.detalle);
      if (Number.isSafeInteger(d.boca_id) && d.boca_id > 0 && Number.isSafeInteger(d.producto_id) && d.producto_id > 0) {
        pares.set(claveDe(d.boca_id, d.producto_id), { boca_id: d.boca_id, producto_id: d.producto_id });
      }
    } catch (_e) { /* detalle anterior incompleto */ }
  }
  // Una transacción por par: el sondeo no retiene una boca mientras espera otra.
  for (const par of [...pares.values()].sort((a, b) => a.producto_id - b.producto_id || a.boca_id - b.boca_id)) {
    await db.tx((t) => revisarPar(t, ctx, par.boca_id, par.producto_id));
  }
  porPredio.set(ctx.pid, ahora);
}

module.exports = { revisarPar, revisarProducto, bloquearStockProducto, revisarStockMinimo };
