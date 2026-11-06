"use strict";

// Compras a proveedores: una compra por factura. Suma stock en el almacén, guarda el
// precio anterior y siempre recalcula la venta con el margen vigente del producto.

const U = require("../util");
const N = require("../negocio");
const { precioVenta } = require("./catalogo");
const { resolverRevisionProducto, fuentePrecioVigente } = require("../precios");
const { esAdmin, bocasDe } = require("./comun");

async function puedeComprar(t, ctx, bocaId) {
  if (esAdmin(ctx)) return;
  const boca = await N.obtener(t, ctx, "predio_boca", bocaId);
  if (!boca || !Number(boca.es_almacen) || !bocasDe(ctx).includes(Number(bocaId))) {
    throw U.error("Las compras las carga el almacén o un administrador", 403);
  }
}

async function crearCompra(ctx) {
  const b = ctx.body;
  const proveedorId = U.id(b.proveedor_id, "El proveedor");
  const factura = U.texto(b.factura, { max: 40, campo: "El número de factura" });
  const remito = U.texto(b.remito, { max: 40, campo: "El número de remito" });
  const fechaFactura = U.fecha(b.fecha_factura, { campo: "La fecha de la factura" });
  const fechaRemito = U.fecha(b.fecha_remito, { campo: "La fecha del remito" });
  const observaciones = U.textoLargo(b.observaciones, { max: 2000 });
  const problemas = [];
  if (!factura && !remito) problemas.push("Cargá el número de factura o el de remito.");
  if (factura && !fechaFactura) problemas.push("Falta la fecha de la factura.");
  if (remito && !fechaRemito) problemas.push("Falta la fecha del remito.");
  const manana = U.sumarDias(U.hoy(), 1);
  if (fechaFactura && fechaFactura > manana) problemas.push("La fecha de la factura está en el futuro.");
  if (fechaRemito && fechaRemito > manana) problemas.push("La fecha del remito está en el futuro.");
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) problemas.push("Agregá al menos un producto a la compra.");
  if (items.length > 300) problemas.push("Una compra puede tener hasta 300 productos.");
  const lineas = [];
  const vistos = new Set();
  items.forEach((it, i) => {
    const n = i + 1;
    const productoId = Number(it.producto_id);
    if (!Number.isSafeInteger(productoId) || productoId <= 0) { problemas.push(`En la fila ${n} falta elegir el producto.`); return; }
    if (vistos.has(productoId)) { problemas.push(`El producto de la fila ${n} está repetido: dejalo en una sola fila con la cantidad total.`); return; }
    vistos.add(productoId);
    const cantidad = Number(String(it.cantidad ?? "").replace(",", "."));
    const precio = Number(String(it.precio_unitario ?? "").replace(",", "."));
    if (!Number.isFinite(cantidad) || cantidad <= 0) problemas.push(`En la fila ${n} la cantidad tiene que ser mayor que cero.`);
    if (!Number.isFinite(precio) || precio < 0) problemas.push(`En la fila ${n} el precio unitario no es válido.`);
    lineas.push({
      producto_id: productoId,
      cantidad: U.redondear(cantidad, 3),
      precio_unitario: U.redondear(precio, 2),
      subtotal: U.redondear(cantidad * precio, 2),
    });
  });
  const totalItems = U.redondear(lineas.reduce((s, l) => s + l.subtotal, 0), 2);
  let totalFactura = null;
  if (b.total_factura === undefined || b.total_factura === null || b.total_factura === "") problemas.push("Cargá el total de la factura para controlar las cuentas.");
  else {
    totalFactura = Number(String(b.total_factura).replace(",", "."));
    if (!Number.isFinite(totalFactura) || totalFactura < 0) problemas.push("El total de la factura no es válido.");
    else if (lineas.length && Math.abs(U.redondear(totalFactura, 2) - totalItems) > 0.05) {
      const dif = U.redondear(totalFactura - totalItems, 2);
      problemas.push(`La suma de los productos da ${U.pesos(totalItems)} y el total de la factura dice ${U.pesos(totalFactura)}: `
        + `${dif > 0 ? "faltan" : "sobran"} ${U.pesos(Math.abs(dif))}. Revisá cantidades y precios unitarios.`);
    }
  }
  if (problemas.length) throw U.error(problemas[0], 422, { codigo: "COMPRA_CON_ERRORES", problemas });

  return ctx.db.tx(async (t) => {
    const proveedor = await N.exigir(t, ctx, "predio_proveedor", proveedorId, "No encontramos el proveedor");
    if (!Number(proveedor.activo)) throw U.error("El proveedor está dado de baja");
    let bocaId = b.boca_id ? U.id(b.boca_id, "La boca") : null;
    if (!bocaId) {
      const almacen = await N.bocaAlmacen(t, ctx);
      if (!almacen) throw U.error("Marcá una boca como almacén en Gestión → Bocas para recibir las compras", 409);
      bocaId = almacen.id;
    }
    await puedeComprar(t, ctx, bocaId);
    if (factura) {
      const dup = await t.get(
        "SELECT id FROM predio_compra WHERE predio_id = ? AND proveedor_id = ? AND factura = ? AND estado = 'CARGADA'",
        [ctx.pid, proveedorId, factura]);
      if (dup) throw U.error(`Esa factura de ${proveedor.razon_social} ya está cargada (compra N° ${dup.id})`, 409);
    }
    const compraId = await N.insertar(t, ctx, "predio_compra", {
      proveedor_id: proveedorId, boca_id: bocaId, factura, fecha_factura: fechaFactura, remito, fecha_remito: fechaRemito,
      total_factura: U.redondear(totalFactura, 2), total_items: totalItems, observaciones, estado: "CARGADA", usuario_id: ctx.usuario.id,
    });
    const avisos = [];
    for (const l of lineas) {
      const p = await N.exigir(t, ctx, "predio_producto", l.producto_id, "Uno de los productos no existe", { bloquear: true });
      const anterior = Number(p.precio_compra || 0);
      // El margen vigente se lee al confirmar; un formulario viejo no lo sobrescribe.
      const margen = Number(p.margen || 0);
      const nuevoVenta = precioVenta(l.precio_unitario, margen);
      await N.insertar(t, ctx, "predio_compra_item", {
        compra_id: compraId, producto_id: l.producto_id, cantidad: l.cantidad, precio_unitario: l.precio_unitario,
        precio_anterior: anterior, margen, precio_venta: nuevoVenta,
        actualizo_precio: 1, subtotal: l.subtotal,
      });
      await N.moverStock(t, ctx, {
        bocaId, productoId: l.producto_id, cantidad: l.cantidad, tipo: "COMPRA", referenciaTipo: "compra", referenciaId: compraId,
        detalle: `Compra N° ${compraId} · ${proveedor.razon_social}${factura ? ` · Fc ${factura}` : ""}`,
      });
      const cambios = { precio_compra: l.precio_unitario, precio_venta: nuevoVenta, fecha_revision_precio: U.fechaHora() };
      await N.actualizar(t, ctx, "predio_producto", l.producto_id, cambios);
      await N.insertar(t, ctx, "predio_precio_historial", {
        producto_id: l.producto_id, fecha: U.fechaHora(), precio_compra: l.precio_unitario, margen,
        precio_venta: nuevoVenta, origen: "COMPRA", referencia_id: compraId,
        usuario_nombre: N.nombreActor(ctx),
      });
      await resolverRevisionProducto(t, ctx, l.producto_id);
    }
    await N.auditar(t, ctx, "Carga de compra", "compra", compraId, {
      proveedor: proveedor.razon_social, factura, remito, total: totalItems, productos: lineas.length,
    });
    return { id: compraId, total: totalItems, avisos, mensaje: `Compra N° ${compraId} cargada` };
  });
}

async function detalleCompra(ctx) {
  const id = U.id(ctx.params.id);
  const c = await ctx.db.get(
    `SELECT c.*, pr.razon_social AS proveedor, pr.cuit AS proveedor_cuit, pr.codigo AS proveedor_codigo, b.nombre AS boca
     FROM predio_compra c
     JOIN predio_proveedor pr ON pr.predio_id = c.predio_id AND pr.id = c.proveedor_id
     JOIN predio_boca b ON b.predio_id = c.predio_id AND b.id = c.boca_id
     WHERE c.predio_id = ? AND c.id = ?`, [ctx.pid, id]);
  if (!c) throw U.error("No encontramos la compra", 404);
  if (!esAdmin(ctx) && !bocasDe(ctx).includes(Number(c.boca_id))) throw U.error("No tenés acceso a esta compra", 403);
  const items = await ctx.db.all(
    `SELECT i.*, p.nombre AS producto, p.codigo FROM predio_compra_item i
     JOIN predio_producto p ON p.predio_id = i.predio_id AND p.id = i.producto_id
     WHERE i.predio_id = ? AND i.compra_id = ? ORDER BY i.id`, [ctx.pid, id]);
  return { compra: c, items };
}

async function anularCompra(ctx) {
  if (!esAdmin(ctx)) throw U.error("Sólo un administrador puede anular una compra", 403);
  const id = U.id(ctx.params.id);
  const motivo = U.texto(ctx.body.motivo, { max: 255, campo: "El motivo", requerido: true });
  return ctx.db.tx(async (t) => {
    const c = await N.exigir(t, ctx, "predio_compra", id, "No encontramos la compra", { bloquear: true });
    if (c.estado === "ANULADA") throw U.error("La compra ya está anulada", 409);
    const items = await t.all("SELECT * FROM predio_compra_item WHERE predio_id = ? AND compra_id = ? ORDER BY producto_id", [ctx.pid, id]);
    const preciosRestaurados = [];
    const avisos = [];
    for (const it of items) {
      const p = await N.exigir(t, ctx, "predio_producto", it.producto_id, "Uno de los productos ya no existe", { bloquear: true });
      const vigente = await fuentePrecioVigente(t, ctx, it.producto_id);
      // Una edición/revisión posterior es una decisión distinta: anular una
      // compra nunca la revierte, aunque los importes sean iguales o del mismo segundo.
      if (vigente?.origen === "COMPRA" && Number(vigente.referencia_id) === id
        && Number(p.precio_compra || 0) === Number(vigente.precio_compra || 0)
        && Number(p.precio_venta || 0) === Number(vigente.precio_venta || 0)) {
        const anterior = await fuentePrecioVigente(t, ctx, it.producto_id, id);
        const costo = Number(anterior?.precio_compra ?? it.precio_anterior ?? 0);
        const venta = precioVenta(costo, Number(p.margen || 0));
        await N.actualizar(t, ctx, "predio_producto", it.producto_id, {
          precio_compra: costo, precio_venta: venta, fecha_revision_precio: anterior?.fecha || null,
        });
        await N.insertar(t, ctx, "predio_precio_historial", {
          producto_id: it.producto_id, fecha: U.fechaHora(), precio_compra: costo, margen: Number(p.margen || 0),
          precio_venta: venta, origen: "ANULACION_COMPRA", referencia_id: id, usuario_nombre: N.nombreActor(ctx),
        });
        preciosRestaurados.push({ producto_id: p.id, producto: p.nombre, costo_anterior: Number(p.precio_compra || 0), costo_restaurado: costo, venta_restaurada: venta, fuente_historial_id: anterior?.id || null });
        if (!anterior) avisos.push(`«${p.nombre}»: se recuperó el costo anterior guardado en la compra; no hay una revisión de precio previa en el historial. Revisá su ficha.`);
      }
      await N.moverStock(t, ctx, {
        bocaId: c.boca_id, productoId: it.producto_id, cantidad: -Number(it.cantidad), tipo: "ANULACION_COMPRA",
        referenciaTipo: "compra", referenciaId: id, detalle: `Anulación de la compra N° ${id}`,
      });
    }
    await N.actualizar(t, ctx, "predio_compra", id, { estado: "ANULADA", anulada_fecha: U.fechaHora(), anulada_por: N.nombreActor(ctx), anulacion_motivo: motivo });
    await N.auditar(t, ctx, "Anulación de compra", "compra", id, { motivo, precios_restaurados: preciosRestaurados });
    return { id, avisos, precios_restaurados: preciosRestaurados, mensaje: "Compra anulada. El stock del almacén se descontó."
      + (preciosRestaurados.length ? " Se restauraron los precios que dependían de esta compra, conservando las revisiones posteriores." : "")
      + (avisos.length ? " Hay productos sin historial previo: revisá sus precios en Gestión → Productos." : "") };
  });
}

module.exports = {
  rutas: [
    { m: "POST", p: "/compras", h: crearCompra, escritura: true },
    { m: "GET", p: "/compras/:id", h: detalleCompra },
    { m: "POST", p: "/compras/:id/anular", h: anularCompra, escritura: true, roles: ["ADMIN"] },
  ],
};
