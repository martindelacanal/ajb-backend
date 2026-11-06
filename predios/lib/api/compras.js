"use strict";

// La factura ingresa stock a la proveeduría; sus costos sólo pasan al catálogo
// para los productos que la persona eligió al confirmar.

const U = require("../util");
const N = require("../negocio");
const PB = require("../precio-boca");
const limiteRedondeoCompra = require("../../public/js/redondeo-compra");
const { resolverRevisionProducto, fuentePrecioVigente } = require("../precios");
const { esAdmin, bocasDe } = require("./comun");

async function puedeComprar(t, ctx, bocaId) {
  if (esAdmin(ctx)) return;
  const boca = await N.obtener(t, ctx, "predio_boca", bocaId);
  if (!boca || !Number(boca.es_almacen) || !bocasDe(ctx).includes(Number(bocaId))) {
    throw U.error("Las compras las carga el almacén o un administrador", 403);
  }
}

async function lineasTemporales(t, ctx, id, revision) {
  const items = await t.all("SELECT id, producto_id, cantidad FROM predio_compra_item WHERE predio_id = ? AND compra_id = ? ORDER BY id", [ctx.pid, id]);
  // Al reemplazar los renglones se generan IDs nuevos, aun para dos ediciones en el mismo segundo.
  if (!items.length || Number(items[items.length - 1].id) !== revision) {
    throw U.error("Otra persona cambió esta compra. Volvé a abrirla para ver la última versión.", 409);
  }
  return items;
}

async function conciliarRecepcion(t, ctx, bocaId, compraId, anteriores, nuevas, tipo, detalle) {
  const diferencias = new Map(anteriores.map(l => [Number(l.producto_id), -Number(l.cantidad)]));
  for (const l of nuevas) diferencias.set(l.producto_id, U.redondear((diferencias.get(l.producto_id) || 0) + l.cantidad, 3));
  for (const [productoId, cantidad] of diferencias) {
    if (!cantidad) continue;
    const saldo = await N.bloquearSaldoStock(t, ctx, bocaId, productoId);
    if (cantidad < 0 && saldo < -cantidad) {
      const producto = await N.exigir(t, ctx, "predio_producto", productoId);
      throw U.error(`Para corregir «${producto.nombre}» hay que retirar ${-cantidad} y quedan ${saldo} en la proveeduría. Revisá sus ventas y traspasos antes de modificar la recepción.`, 409);
    }
    await N.moverStock(t, ctx, { bocaId, productoId, cantidad, tipo, referenciaTipo: "compra", referenciaId: compraId, detalle });
  }
}

async function crearCompra(ctx, temporal = false) {
  const b = ctx.body;
  const temporalId = ctx.params.id ? U.id(ctx.params.id) : null;
  let recibo = null;
  if (temporal && !temporalId) {
    if (!/^[a-f0-9]{32}$/.test(b.operacion || "")) throw U.error("Falta el identificador de esta recepción. Volvé a abrir la carga.", 400);
    recibo = { clave: "compra:" + b.operacion, huella: U.sha256(JSON.stringify([ctx.usuario.id, b])) };
  }
  const proveedorId = U.id(b.proveedor_id, "El proveedor");
  const factura = U.texto(b.factura, { max: 40, campo: "El número de factura" });
  const remito = U.texto(b.remito, { max: 40, campo: "El número de remito" });
  const fechaFactura = U.fecha(b.fecha_factura, { campo: "La fecha de la factura" });
  const fechaRemito = U.fecha(b.fecha_remito, { campo: "La fecha del remito" });
  const observaciones = U.textoLargo(b.observaciones, { max: 2000 });
  const problemas = [];
  if (!temporal && !factura && !remito) problemas.push("Cargá el número de factura o el de remito.");
  if (!temporal && factura && !fechaFactura) problemas.push("Falta la fecha de la factura.");
  if (!temporal && remito && !fechaRemito) problemas.push("Falta la fecha del remito.");
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
    if (!Number.isFinite(cantidad) || U.redondear(cantidad, 3) <= 0) problemas.push(`En la fila ${n} la cantidad tiene que ser mayor que cero.`);
    if (it.precio_unitario == null || it.precio_unitario === "" || !Number.isFinite(precio) || precio < 0 || precio > 99999999) problemas.push(`En la fila ${n} el precio unitario no es válido.`);
    lineas.push({
      producto_id: productoId,
      cantidad: U.redondear(cantidad, 3),
      precio_unitario: U.redondear(precio, 2),
      actualizar: !temporal && !!U.bool(it.actualizar_precio),
      costo_referencia: it.costo_referencia == null ? null : U.numero(it.costo_referencia, { min: 0, campo: "El costo de referencia" }),
      subtotal: U.redondear(U.redondear(cantidad, 3) * U.redondear(precio), 2),
    });
  });
  const totalItems = U.redondear(lineas.reduce((s, l) => s + l.subtotal, 0), 2);
  let totalFactura = null;
  let redondeo = 0;
  if (b.total_factura === undefined || b.total_factura === null || b.total_factura === "") {
    if (!temporal) problemas.push("Cargá el total de la factura para controlar las cuentas.");
  } else {
    totalFactura = Number(String(b.total_factura).replace(",", "."));
    if (!Number.isFinite(totalFactura) || totalFactura < 0) problemas.push("El total de la factura no es válido.");
    else if (!temporal) {
      redondeo = U.redondear(U.redondear(totalFactura) - totalItems);
      const limite = limiteRedondeoCompra(lineas);
      if (Math.abs(redondeo) > limite) {
        problemas.push(`En la suma de los productos ${redondeo > 0 ? "faltan" : "sobran"} ${U.pesos(Math.abs(redondeo))}. Supera el redondeo admisible de ${U.pesos(limite)}. Revisá cantidades y precios unitarios.`);
      } else if (Math.abs(redondeo) > 0.05 && b.redondeo_confirmado !== redondeo) {
        problemas.push(`Confirmá el redondeo de ${U.pesos(redondeo)} para cargar la factura.`);
      }
    }
  }
  if (problemas.length) throw U.error(problemas[0], 422, { codigo: "COMPRA_CON_ERRORES", problemas });

  return ctx.db.tx(async (t) => {
    await PB.bloquearPrecios(t, ctx);
    if (recibo) {
      const previo = await t.get("SELECT huella, respuesta FROM predio_recepcion_recibo WHERE predio_id = ? AND clave = ?" + t.forUpdate, [ctx.pid, recibo.clave]);
      if (previo) {
        if (previo.huella !== recibo.huella) throw U.error("Esta recepción ya fue registrada. Abrila en Compras para corregirla.", 409);
        return JSON.parse(previo.respuesta);
      }
    }
    const proveedor = await N.exigir(t, ctx, "predio_proveedor", proveedorId, "No encontramos el proveedor");
    if (!Number(proveedor.activo)) throw U.error("El proveedor está dado de baja");
    const anterior = temporalId ? await N.exigir(t, ctx, "predio_compra", temporalId, "No encontramos la compra temporal", { bloquear: true }) : null;
    const almacen = anterior ? await N.exigir(t, ctx, "predio_boca", anterior.boca_id) : await N.bocaAlmacen(t, ctx);
    if (!almacen) throw U.error("Elegí una proveeduría en Gestión → Bocas para recibir las compras", 409);
    const bocaId = Number(almacen.id);
    if (b.boca_id != null && U.id(b.boca_id, "La boca") !== bocaId)
      throw U.error(`Las compras ingresan a la proveeduría ${almacen.nombre}. Volvé a revisar la compra.`, 409);
    await puedeComprar(t, ctx, bocaId);
    if (anterior && anterior.estado !== "TEMPORAL") throw U.error("La compra ya se finalizó o se descartó.", 409);
    const recibidos = anterior ? await lineasTemporales(t, ctx, temporalId, b.revision) : [];
    if (!temporal && factura) {
      const dup = await t.get(
        "SELECT id FROM predio_compra WHERE predio_id = ? AND proveedor_id = ? AND factura = ? AND estado = 'CARGADA'",
        [ctx.pid, proveedorId, factura]);
      if (dup) throw U.error(`Esa factura de ${proveedor.razon_social} ya está cargada (compra N° ${dup.id})`, 409);
    }
    const cabecera = {
      proveedor_id: proveedorId, boca_id: bocaId, factura, fecha_factura: temporal && !factura ? null : fechaFactura, remito, fecha_remito: fechaRemito,
      total_factura: totalFactura == null ? null : U.redondear(totalFactura), total_items: totalItems, observaciones, estado: temporal ? "TEMPORAL" : "CARGADA", usuario_id: ctx.usuario.id,
    };
    const compraId = temporalId || await N.insertar(t, ctx, "predio_compra", cabecera);
    if (temporalId) {
      await N.actualizar(t, ctx, "predio_compra", compraId, cabecera);
      await t.run("DELETE FROM predio_compra_item WHERE predio_id = ? AND compra_id = ?", [ctx.pid, compraId]);
    }
    const avisos = [];
    for (const l of lineas) {
      const p = await N.exigir(t, ctx, "predio_producto", l.producto_id, "Uno de los productos no existe", { bloquear: true });
      if (!Number(p.activo)) throw U.error(`«${p.nombre}» está dado de baja. Revisá la compra.`, 409);
      const anterior = Number(p.precio_compra || 0);
      if (l.actualizar && l.costo_referencia !== null && l.costo_referencia !== anterior)
        throw U.error(`El costo de referencia de «${p.nombre}» cambió. Quitá el producto y volvé a agregarlo para revisar el precio.`, 409);
      // El margen vigente se lee al confirmar; un formulario viejo no lo sobrescribe.
      const margen = Number(p.margen || 0);
      const nuevoVenta = l.actualizar ? PB.precioVenta(l.precio_unitario, margen) : PB.redondearVenta(p.precio_venta);
      const fuenteAnterior = l.actualizar ? await fuentePrecioVigente(t, ctx, l.producto_id) : null;
      await N.insertar(t, ctx, "predio_compra_item", {
        compra_id: compraId, producto_id: l.producto_id, cantidad: l.cantidad, precio_unitario: l.precio_unitario,
        precio_anterior: anterior, margen, precio_venta: nuevoVenta,
        venta_anterior: PB.redondearVenta(p.precio_venta), historial_anterior_id: fuenteAnterior?.id || null,
        actualizo_precio: l.actualizar ? 1 : 0, subtotal: l.subtotal,
      });
      if (!l.actualizar) continue;
      const preciosAntes = await PB.preciosDeProducto(t, ctx, l.producto_id);
      const cambios = { precio_compra: l.precio_unitario, precio_venta: nuevoVenta, fecha_revision_precio: U.fechaHora() };
      await N.actualizar(t, ctx, "predio_producto", l.producto_id, cambios);
      await PB.registrarCambioProducto(t, ctx, l.producto_id, preciosAntes, "COMPRA_BOCA", compraId);
      await N.insertar(t, ctx, "predio_precio_historial", {
        producto_id: l.producto_id, fecha: U.fechaHora(), precio_compra: l.precio_unitario, margen,
        precio_venta: nuevoVenta, origen: "COMPRA", referencia_id: compraId,
        usuario_nombre: N.nombreActor(ctx),
      });
      await resolverRevisionProducto(t, ctx, l.producto_id);
    }
    const tipo = temporalId ? "CORRECCION_RECEPCION" : temporal ? "COMPRA_TEMPORAL" : "COMPRA";
    await conciliarRecepcion(t, ctx, bocaId, compraId, recibidos, lineas, tipo,
      `Compra N° ${compraId} · ${proveedor.razon_social}${factura ? ` · Fc ${factura}` : ""}`);
    const accion = temporal ? "Guardado de compra temporal" : temporalId ? "Confirmación de compra temporal" : "Carga de compra";
    await N.auditar(t, ctx, accion, "compra", compraId, {
      proveedor: proveedor.razon_social, factura, remito, total: cabecera.total_factura, total_items: totalItems, redondeo, productos: lineas.length,
    });
    if (redondeo) avisos.push(`Redondeo aplicado a la factura: ${U.pesos(redondeo)}.`);
    const respuesta = { id: compraId, total: cabecera.total_factura ?? totalItems, avisos,
      mensaje: temporal ? `Compra temporal N° ${compraId} guardada` : `Compra N° ${compraId} cargada` };
    if (recibo) await N.insertar(t, ctx, "predio_recepcion_recibo", { ...recibo, respuesta: JSON.stringify(respuesta) });
    return respuesta;
  });
}

async function detalleCompra(ctx) {
  const id = U.id(ctx.params.id);
  const c = await ctx.db.get(
    `SELECT c.*, pr.razon_social AS proveedor, pr.cuit AS proveedor_cuit, pr.codigo AS proveedor_codigo, b.nombre AS boca,
      (SELECT MAX(i.id) FROM predio_compra_item i WHERE i.predio_id = c.predio_id AND i.compra_id = c.id) AS revision
     FROM predio_compra c
     JOIN predio_proveedor pr ON pr.predio_id = c.predio_id AND pr.id = c.proveedor_id
     JOIN predio_boca b ON b.predio_id = c.predio_id AND b.id = c.boca_id
     WHERE c.predio_id = ? AND c.id = ?`, [ctx.pid, id]);
  if (!c) throw U.error("No encontramos la compra", 404);
  if (!esAdmin(ctx) && !bocasDe(ctx).includes(Number(c.boca_id))) throw U.error("No tenés acceso a esta compra", 403);
  const items = await ctx.db.all(
    `SELECT i.*, p.nombre AS producto, p.codigo, p.precio_compra AS costo_vigente,
      p.precio_venta AS venta_vigente, p.margen AS margen_vigente FROM predio_compra_item i
     JOIN predio_producto p ON p.predio_id = i.predio_id AND p.id = i.producto_id
     WHERE i.predio_id = ? AND i.compra_id = ? ORDER BY i.id`, [ctx.pid, id]);
  return { compra: c, items, revision: Number(c.revision) };
}

async function anularCompra(ctx) {
  if (!esAdmin(ctx)) throw U.error("Sólo un administrador puede anular una compra", 403);
  const id = U.id(ctx.params.id);
  const motivo = U.texto(ctx.body.motivo, { max: 255, campo: "El motivo", requerido: true });
  return ctx.db.tx(async (t) => {
    await PB.bloquearPrecios(t, ctx);
    const c = await N.exigir(t, ctx, "predio_compra", id, "No encontramos la compra", { bloquear: true });
    if (c.estado === "ANULADA") throw U.error("La compra ya está anulada", 409);
    if (c.estado === "TEMPORAL") {
      if (ctx.body.temporal !== true) throw U.error("Volvé a abrir la compra temporal para descartarla.", 409);
      const recibidos = await lineasTemporales(t, ctx, id, ctx.body.revision);
      await conciliarRecepcion(t, ctx, c.boca_id, id, recibidos, [], "CORRECCION_RECEPCION", `Descarte de la compra temporal N° ${id}`);
      await N.actualizar(t, ctx, "predio_compra", id, { estado: "DESCARTADA", anulada_fecha: U.fechaHora(), anulada_por: N.nombreActor(ctx), anulacion_motivo: motivo });
      await N.auditar(t, ctx, "Descarte de compra temporal", "compra", id, { motivo });
      return { id, mensaje: "Compra temporal descartada." };
    }
    if (c.estado !== "CARGADA" || ctx.body.temporal === true) throw U.error("La compra cambió de estado. Volvé a abrirla.", 409);
    const items = await t.all("SELECT * FROM predio_compra_item WHERE predio_id = ? AND compra_id = ? ORDER BY producto_id", [ctx.pid, id]);
    const preciosRestaurados = [];
    const avisos = [];
    for (const it of items) {
      const p = await N.exigir(t, ctx, "predio_producto", it.producto_id, "Uno de los productos ya no existe", { bloquear: true });
      const vigente = await fuentePrecioVigente(t, ctx, it.producto_id);
      // Una edición/revisión posterior es una decisión distinta: anular una
      // compra nunca la revierte, aunque los importes sean iguales o del mismo segundo.
      if (Number(it.actualizo_precio) && vigente?.origen === "COMPRA" && Number(vigente.referencia_id) === id
        && Number(p.precio_compra || 0) === Number(vigente.precio_compra || 0)
        && PB.redondearVenta(p.precio_venta) === PB.redondearVenta(vigente.precio_venta)) {
        const anterior = await fuentePrecioVigente(t, ctx, it.producto_id, id);
        // Una referencia importada puede contener el precio histórico del sistema anterior.
        // La compra nueva guarda lo que realmente estaba vigente antes de aplicarse.
        const usarCaptura = it.venta_anterior != null && (!anterior || Number(anterior.id) === Number(it.historial_anterior_id));
        const costo = Number(usarCaptura ? it.precio_anterior : (anterior?.precio_compra ?? it.precio_anterior ?? 0));
        const ventaAnterior = usarCaptura ? it.venta_anterior : anterior?.precio_venta;
        const venta = ventaAnterior != null ? PB.redondearVenta(ventaAnterior) : PB.precioVenta(costo, p.margen);
        const preciosAntes = await PB.preciosDeProducto(t, ctx, it.producto_id);
        await N.actualizar(t, ctx, "predio_producto", it.producto_id, {
          precio_compra: costo, precio_venta: venta, fecha_revision_precio: anterior?.fecha || null,
        });
        await PB.registrarCambioProducto(t, ctx, it.producto_id, preciosAntes, "ANULACION_BOCA", id);
        await N.insertar(t, ctx, "predio_precio_historial", {
          producto_id: it.producto_id, fecha: U.fechaHora(), precio_compra: costo, margen: Number(p.margen || 0),
          precio_venta: venta, origen: "ANULACION_COMPRA", referencia_id: id, usuario_nombre: N.nombreActor(ctx),
        });
        preciosRestaurados.push({ producto_id: p.id, producto: p.nombre, costo_anterior: Number(p.precio_compra || 0), costo_restaurado: costo, venta_restaurada: venta, fuente_historial_id: anterior?.id || null });
        if (!anterior) avisos.push(`«${p.nombre}»: se recuperó el costo anterior guardado en la compra; no hay una revisión de precio previa en el historial. Revisá su ficha.`);
      }
    }
    await conciliarRecepcion(t, ctx, c.boca_id, id, items, [], "ANULACION_COMPRA", `Anulación de la compra N° ${id}`);
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
    { m: "POST", p: "/compras/temporal", h: ctx => crearCompra(ctx, true), escritura: true },
    { m: "POST", p: "/compras/:id/revisar", h: ctx => crearCompra(ctx, ctx.body.temporal === true), escritura: true },
    { m: "GET", p: "/compras/:id", h: detalleCompra },
    { m: "POST", p: "/compras/:id/anular", h: anularCompra, escritura: true, roles: ["ADMIN"] },
  ],
};
