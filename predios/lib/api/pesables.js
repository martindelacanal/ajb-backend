"use strict";

// Pasar productos a «venta por peso» (en kilos), de a uno o varios juntos.
//
// El sistema anterior guardaba los productos de la balanza (código 2000XXX: fiambres, quesos,
// verduras, pan) con precio por GRAMO —el jamón cocido figura a $22—. En este sistema el
// precio se redondea a $100, así que esos productos tienen que pasar a precio por KILO.
// Con «el precio está por gramo» se multiplican por 1.000 el costo y el precio de venta, y
// el stock y el stock mínimo (que estaban en gramos) se dividen por 1.000. Con «el precio
// ya está por kilo» sólo se marca la unidad. Todo queda en el historial y en la auditoría.

const U = require("../util");
const N = require("../negocio");
const { bloquearPrecios, registrarCambioProducto, preciosDeProducto } = require("../precio-boca");
const { revisarProducto } = require("../stock-minimo");
const { elegidos } = require("./eliminar");
const { exigirAdmin } = require("./comun");

function leerOpciones(body) {
  return { precioPor: U.opcion(body.precio_por || "KILO", ["GRAMO", "KILO"], "Cómo está cargado el precio") };
}

async function planificar(t, ctx, precioPor) {
  const filas = await elegidos(t, ctx, "productos");
  if (!filas.length) throw U.error("No elegiste ningún producto");
  const ids = filas.map((f) => Number(f.id));
  const productos = [];
  for (let i = 0; i < ids.length; i += 400) {
    const lote = ids.slice(i, i + 400);
    productos.push(...await t.all(`SELECT id, nombre, codigo, unidad, precio_compra, precio_venta, stock_minimo, destino FROM predio_producto
      WHERE predio_id = ? AND id IN (${lote.map(() => "?").join(", ")}) ORDER BY id`, [ctx.pid, ...lote]));
  }
  const factor = precioPor === "GRAMO" ? 1000 : 1;
  const cambian = [];
  const sinCambios = [];
  for (const p of productos) {
    if (p.unidad === "KG" || p.destino === "ALQUILER") { sinCambios.push(p); continue; }
    cambian.push({
      ...p,
      precio_compra_nuevo: U.redondear(Number(p.precio_compra || 0) * factor, 2),
      precio_venta_nuevo: U.redondear(Number(p.precio_venta || 0) * factor, 2),
      stock_minimo_nuevo: U.redondear(Number(p.stock_minimo || 0) / factor, 3),
    });
  }
  return { factor, cambian, sinCambios };
}

async function previa(ctx) {
  exigirAdmin(ctx);
  const { precioPor } = leerOpciones(ctx.body);
  const p = await planificar(ctx.db, ctx, precioPor);
  const conStock = p.factor === 1 ? 0 : Number((await ctx.db.get(
    `SELECT COUNT(*) AS n FROM predio_stock WHERE predio_id = ? AND cantidad <> 0 AND producto_id IN (${p.cambian.map(() => "?").join(", ") || "NULL"})`,
    [ctx.pid, ...p.cambian.map((x) => x.id)]))?.n || 0);
  return {
    precio_por: precioPor, cantidad: p.cambian.length + p.sinCambios.length, cambian: p.cambian.length, sin_cambios: p.sinCambios.length,
    existencias_a_convertir: conStock,
    muestra: p.cambian.slice(0, 12).map((x) => ({
      id: x.id, nombre: x.nombre, codigo: x.codigo,
      precio_venta: Number(x.precio_venta || 0), precio_venta_nuevo: x.precio_venta_nuevo,
      precio_compra: Number(x.precio_compra || 0), precio_compra_nuevo: x.precio_compra_nuevo,
    })),
  };
}

async function aplicar(ctx) {
  exigirAdmin(ctx);
  const { precioPor } = leerOpciones(ctx.body);
  return ctx.db.tx(async (t) => {
    if (t.forUpdate) await bloquearPrecios(t, ctx);
    const p = await planificar(t, ctx, precioPor);
    const ahora = U.fechaHora();
    for (const x of p.cambian) {
      const antes = await N.exigir(t, ctx, "predio_producto", x.id, "No encontramos el producto", { bloquear: true });
      const preciosAntes = await preciosDeProducto(t, ctx, x.id);
      const datos = { unidad: "KG" };
      if (p.factor !== 1) {
        Object.assign(datos, { precio_compra: x.precio_compra_nuevo, precio_venta: x.precio_venta_nuevo, stock_minimo: x.stock_minimo_nuevo, fecha_revision_precio: ahora });
      }
      await N.actualizar(t, ctx, "predio_producto", x.id, datos);
      const stock = [];
      if (p.factor !== 1) {
        const existencias = await t.all(`SELECT boca_id, cantidad FROM predio_stock WHERE predio_id = ? AND producto_id = ? AND cantidad <> 0 ORDER BY boca_id${t.forUpdate}`,
          [ctx.pid, x.id]);
        for (const e of existencias) {
          const gramos = Number(e.cantidad);
          const kilos = U.redondear(gramos / p.factor, 3);
          await N.moverStock(t, ctx, {
            bocaId: e.boca_id, productoId: x.id, cantidad: U.redondear(kilos - gramos, 3), tipo: "CONVERSION_UNIDAD",
            referenciaTipo: "producto", referenciaId: x.id, detalle: `Paso a venta por kilo: ${gramos} g = ${kilos} kg`,
          });
          stock.push({ boca_id: Number(e.boca_id), gramos, kilos });
        }
        await N.insertar(t, ctx, "predio_precio_historial", {
          producto_id: x.id, fecha: ahora, precio_compra: x.precio_compra_nuevo, margen: antes.margen,
          precio_venta: x.precio_venta_nuevo, origen: "VENTA_POR_KILO", usuario_nombre: N.nombreActor(ctx),
        });
        await registrarCambioProducto(t, ctx, x.id, preciosAntes, "VENTA_POR_KILO");
      }
      await revisarProducto(t, ctx, x.id);
      await N.auditar(t, ctx, "Producto pasado a venta por peso", "producto", x.id, {
        nombre: antes.nombre, codigo: antes.codigo, precio_estaba: precioPor === "GRAMO" ? "por gramo" : "por kilo",
        precio_compra: { antes: Number(antes.precio_compra || 0), despues: datos.precio_compra ?? Number(antes.precio_compra || 0) },
        precio_venta: { antes: Number(antes.precio_venta || 0), despues: datos.precio_venta ?? Number(antes.precio_venta || 0) },
        stock_minimo: { antes: Number(antes.stock_minimo || 0), despues: datos.stock_minimo ?? Number(antes.stock_minimo || 0) },
        stock,
      });
    }
    const n = p.cambian.length;
    return {
      cambiados: n, sin_cambios: p.sinCambios.length,
      mensaje: n ? `${n === 1 ? "Un producto pasó" : `${n} productos pasaron`} a venta por kilo${p.factor !== 1 ? " (precios × 1.000, stock en kilos)" : ""}.` : "No había productos para cambiar",
    };
  });
}

module.exports = {
  rutas: [
    { m: "POST", p: "/productos/peso/previa", h: previa, roles: ["ADMIN"] },
    { m: "POST", p: "/productos/peso", h: aplicar, escritura: true, roles: ["ADMIN"] },
  ],
};
