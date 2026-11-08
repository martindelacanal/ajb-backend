"use strict";

const N = require("./negocio");
const U = require("./util");

// Dos claves indexadas por porción conservan el formato de las réplicas y respaldos LAN.
const PREFIJO_INSUMO = "porcion.insumo.";
const PREFIJO_RINDE = "porcion.rinde.";
const joinReceta = `LEFT JOIN predio_config ri ON p.destino = 'VENTA_COMPUESTA' AND ri.predio_id = p.predio_id AND ri.clave = CONCAT('${PREFIJO_INSUMO}', p.id)
  LEFT JOIN predio_config rr ON rr.predio_id = ri.predio_id AND rr.clave = CONCAT('${PREFIJO_RINDE}', p.id)
  LEFT JOIN predio_producto ins ON ins.predio_id = p.predio_id AND ins.id = ri.valor + 0`;
// El stock físico tiene precisión de milésimas; el rendimiento es entero.
const joinStockVenta = `${joinReceta}
  LEFT JOIN predio_stock s ON s.predio_id = p.predio_id AND s.producto_id = COALESCE(ri.valor + 0, p.id) AND s.boca_id = b.id`;
const stockVentaSql = `CASE WHEN ri.id IS NULL THEN COALESCE(s.cantidad, 0)
  WHEN ins.activo = 1 AND s.cantidad > 0 THEN FLOOR(ROUND(s.cantidad * 1000) * (rr.valor + 0) / 1000.0) ELSE 0 END`;

const porcionesDisponiblesSql = `CASE WHEN ri.id IS NOT NULL THEN ${stockVentaSql} END`;

function disponibles(saldo, rendimiento) {
  return Math.max(0, Math.floor(Math.round(saldo * 1000) * rendimiento / 1000));
}

// Distribuye las milésimas entre las porciones. Un paquete que rinde seis
// alcanza para seis cobros separados (0,166 y 0,167), igual que para uno de seis.
function consumo(saldo, rendimiento, cantidad) {
  const antes = disponibles(saldo, rendimiento);
  if (cantidad > antes) return Math.ceil(cantidad * 1000 / rendimiento) / 1000;
  return (Math.ceil(antes * 1000 / rendimiento) - Math.ceil((antes - cantidad) * 1000 / rendimiento)) / 1000;
}

async function leer(t, ctx, id) {
  const fila = await t.get(`SELECT ri.valor + 0 AS insumo_id, rr.valor + 0 AS rendimiento, ins.nombre, ins.activo
    FROM predio_producto p ${joinReceta} WHERE p.predio_id = ? AND p.id = ?`, [ctx.pid, id]);
  return fila?.insumo_id ? fila : null;
}

async function esInsumo(t, ctx, id) {
  return !!await t.get(`SELECT p.id FROM predio_config ri JOIN predio_producto p ON p.predio_id = ri.predio_id
    AND ri.clave = CONCAT('${PREFIJO_INSUMO}', p.id)
    WHERE ri.predio_id = ? AND ri.valor = ? AND p.activo = 1 AND p.destino = 'VENTA_COMPUESTA' LIMIT 1`, [ctx.pid, String(id)]);
}

async function quitar(t, ctx, ids) {
  const claves = ids.flatMap(id => [PREFIJO_INSUMO + id, PREFIJO_RINDE + id]);
  await t.run(`DELETE FROM predio_config WHERE predio_id = ? AND clave IN (${t.lista(claves.length)})`, [ctx.pid, ...claves]);
}

async function guardar(t, ctx, id, destino, receta) {
  if (receta === undefined && destino === "VENTA_COMPUESTA") return;
  if (!receta || destino !== "VENTA_COMPUESTA") {
    if (receta && destino !== "VENTA_COMPUESTA") throw U.error("Sólo una venta compuesta admite un insumo base.");
    return quitar(t, ctx, [id]);
  }
  const insumoId = U.id(receta.insumo_id, "El insumo base");
  const rendimiento = Number(receta.rendimiento);
  if (!Number.isInteger(rendimiento) || rendimiento < 1 || rendimiento > 1000) throw U.error("Ingresá un rendimiento de 1 a 1000 porciones por unidad.");
  if (id === insumoId || await esInsumo(t, ctx, id)) throw U.error("Elegí un insumo físico independiente para preparar la porción.");
  const insumo = await N.exigir(t, ctx, "predio_producto", insumoId, "No encontramos el insumo base");
  if (!Number(insumo.activo) || insumo.destino === "ALQUILER" || await leer(t, ctx, insumoId))
    throw U.error("Elegí un insumo activo que tenga stock propio y no sea un alquiler.");
  await N.guardarConfig(t, ctx, PREFIJO_INSUMO + id, String(insumoId));
  await N.guardarConfig(t, ctx, PREFIJO_RINDE + id, String(rendimiento));
}

module.exports = { joinReceta, joinStockVenta, stockVentaSql, porcionesDisponiblesSql, leer, guardar, quitar, esInsumo, disponibles, consumo };
