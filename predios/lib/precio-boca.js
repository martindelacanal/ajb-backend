"use strict";

const N = require("./negocio");
const U = require("./util");
const precioVenta = require("../public/js/precio-venta");
const redondearVenta = importe => precioVenta(importe);

// Usamos los mismos enteros (centavos de costo y centésimas de porcentaje)
// en SQLite y MySQL. Un margen nulo hereda, mientras que 0 es un margen válido.
const margenSql = "COALESCE(mb.margen, b.margen_venta)";
const centavosSql = "ROUND(COALESCE(p.precio_compra, 0) * 100)";
const factorSql = `(10000 + ROUND(${margenSql} * 100))`;
const precioGeneralSql = "CEIL(COALESCE(p.precio_venta, 0) * 0.01) * 100";
const precioBocaSql = `CASE WHEN ${margenSql} IS NULL OR COALESCE(p.precio_compra, 0) <= 0 THEN ${precioGeneralSql}
  ELSE (FLOOR(${centavosSql} * 0.00000001) * ${factorSql}
        + CEIL((${centavosSql} % 100000000) * ${factorSql} * 0.00000001)) * 100 END`;
const joinMargenSql = "LEFT JOIN predio_producto_margen_boca mb ON mb.predio_id = p.predio_id AND mb.producto_id = p.id AND mb.boca_id = b.id";

async function bloquearPrecios(t, ctx) {
  await t.run(`${t.insertIgnore} INTO predio_secuencia (predio_id, tabla, ultimo) VALUES (?, 'config_precios', 0)`, [ctx.pid]);
  await t.get(`SELECT ultimo FROM predio_secuencia WHERE predio_id = ? AND tabla = 'config_precios'${t.forUpdate}`, [ctx.pid]);
}

function preciosDeProducto(t, ctx, productoId) {
  return t.all(`SELECT b.id AS boca_id, b.nombre AS boca, b.activo, b.margen_venta AS margen_boca,
      mb.id AS excepcion_id, mb.margen, p.precio_compra, COALESCE(${margenSql}, p.margen) AS margen_aplicado,
      ${precioBocaSql} AS precio_venta
    FROM predio_producto p JOIN predio_boca b ON b.predio_id = p.predio_id ${joinMargenSql}
    WHERE p.predio_id = ? AND p.id = ? AND (b.activo = 1 OR mb.id IS NOT NULL) ORDER BY b.nombre`,
  [ctx.pid, productoId]);
}

async function guardarExcepciones(t, ctx, productoId, excepciones, actuales) {
  if (excepciones === undefined) return;
  if (!Array.isArray(excepciones)) throw U.error("Revisá los márgenes por boca");
  const bocas = new Map(actuales.map(f => [Number(f.boca_id), f]));
  const cargadas = new Set();
  for (const item of excepciones) {
    const id = U.id(item?.boca_id, "La boca");
    const boca = bocas.get(id);
    if (!boca || cargadas.has(id)) throw U.error("Revisá las bocas elegidas para los márgenes");
    cargadas.add(id);
    const margen = U.numero(item.margen, { min: -100, max: 10000, campo: "El margen por producto" });
    if (boca.excepcion_id == null) {
      await N.insertar(t, ctx, "predio_producto_margen_boca", { producto_id: productoId, boca_id: id, margen });
    } else if (Number(boca.margen) !== margen) {
      await N.actualizar(t, ctx, "predio_producto_margen_boca", boca.excepcion_id, { margen });
    }
  }
  for (const boca of actuales) {
    if (boca.excepcion_id != null && !cargadas.has(Number(boca.boca_id))) {
      await t.run("DELETE FROM predio_producto_margen_boca WHERE predio_id = ? AND id = ?", [ctx.pid, boca.excepcion_id]);
    }
  }
}

async function historialBoca(t, ctx, productoId, fila, origen, referenciaId) {
  await N.insertar(t, ctx, "predio_precio_historial", {
    producto_id: productoId, boca_id: fila.boca_id, fecha: U.fechaHora(),
    precio_compra: fila.precio_compra, margen: fila.margen_aplicado, precio_venta: fila.precio_venta,
    origen, referencia_id: referenciaId, usuario_nombre: N.nombreActor(ctx),
  });
}

async function registrarCambioProducto(t, ctx, productoId, antes, origen, referenciaId = null) {
  const porBoca = new Map(antes.map(f => [Number(f.boca_id), f]));
  for (const fila of await preciosDeProducto(t, ctx, productoId)) {
    const previa = porBoca.get(Number(fila.boca_id));
    // El historial general cubre las bocas sin un margen propio.
    if (fila.margen == null && fila.margen_boca == null && previa?.margen == null && previa?.margen_boca == null) continue;
    if (!previa || Number(fila.precio_venta) !== Number(previa.precio_venta) || String(fila.margen) !== String(previa.margen)
      || Number(fila.margen_aplicado) !== Number(previa.margen_aplicado)) {
      await historialBoca(t, ctx, productoId, fila, origen, referenciaId);
    }
  }
}

async function registrarMargenBoca(t, ctx, bocaId) {
  // Las excepciones por producto conservan su precio y su historial.
  const filas = await t.all(`SELECT p.id, b.id AS boca_id, p.precio_compra, COALESCE(b.margen_venta, p.margen) AS margen_aplicado,
       ${precioBocaSql} AS precio_venta
     FROM predio_producto p JOIN predio_boca b ON b.predio_id = p.predio_id AND b.id = ? ${joinMargenSql}
     WHERE p.predio_id = ? AND p.activo = 1 AND p.destino <> 'USO_INTERNO' AND mb.id IS NULL ORDER BY p.id`, [bocaId, ctx.pid]);
  for (const fila of filas) await historialBoca(t, ctx, fila.id, fila, "MARGEN_BOCA", bocaId);
}

async function productoEnBoca(t, ctx, productoId, bocaId, { bloquear = false } = {}) {
  return t.get(`SELECT p.*, ${precioBocaSql} AS precio_caja FROM predio_producto p
    JOIN predio_boca b ON b.predio_id = p.predio_id AND b.id = ? ${joinMargenSql}
    WHERE p.predio_id = ? AND p.id = ?${bloquear ? t.forUpdate : ""}`, [bocaId, ctx.pid, productoId]);
}

module.exports = { redondearVenta, precioVenta, precioGeneralSql, precioBocaSql, joinMargenSql, bloquearPrecios,
  preciosDeProducto, guardarExcepciones, registrarCambioProducto, registrarMargenBoca, productoEnBoca };
