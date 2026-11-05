"use strict";

// Ventas en las cajas de cada boca. El precio sale siempre del producto (el servidor manda),
// el efectivo genera movimiento de caja y el descuento de haberes consume el disponible.

const U = require("../util");
const N = require("../negocio");
const { FORMAS_PAGO } = require("../listados");
const { esAdmin, bocasDe, exigirPuesto, autorizar, disponibleAfiliado } = require("./comun");

const FORMAS = FORMAS_PAGO.map((f) => f.valor);
const MOVEDORES_STOCK = ["VENTA_DIRECTA"];

async function datosTicket(db, ctx, ventaId) {
  const v = await db.get(
    `SELECT v.*, b.nombre AS boca, c.nombre AS caja, c.ancho_ticket
     FROM predio_venta v
     JOIN predio_boca b ON b.predio_id = v.predio_id AND b.id = v.boca_id
     JOIN predio_caja c ON c.predio_id = v.predio_id AND c.id = v.caja_id
     WHERE v.predio_id = ? AND v.id = ?`, [ctx.pid, ventaId]);
  if (!v) throw U.error("No encontramos la venta", 404);
  const items = await db.all("SELECT * FROM predio_venta_item WHERE predio_id = ? AND venta_id = ? ORDER BY id", [ctx.pid, ventaId]);
  const config = await N.leerConfig(db, ctx);
  let afiliado = null;
  if (v.afiliado_id) {
    const a = await db.get(
      `SELECT a.*, d.nombre AS departamental FROM predio_afiliado a
       LEFT JOIN predio_departamental d ON d.predio_id = a.predio_id AND d.id = a.departamental_id
       WHERE a.predio_id = ? AND a.id = ?`, [ctx.pid, v.afiliado_id]);
    if (a) {
      const disp = await disponibleAfiliado(db, ctx, a.id);
      afiliado = { id: a.id, nombre: a.nombre, dni: a.dni, legajo: a.legajo, departamental: a.departamental, disponible: disp.disponible };
    }
  }
  return {
    venta: v,
    items,
    afiliado,
    ancho: Number(v.ancho_ticket) === 58 ? 58 : 80,
    empresa: {
      nombre_predio: config.nombre_predio,
      razon_social: config.razon_social,
      cuit: config.cuit,
      direccion: config.direccion,
      leyenda: config.leyenda_ticket,
      texto_autorizacion: config.texto_autorizacion,
    },
  };
}

function puedeVerVenta(ctx, v) {
  if (esAdmin(ctx)) return true;
  return bocasDe(ctx).includes(Number(v.boca_id));
}

async function crearVenta(ctx) {
  const puesto = exigirPuesto(ctx);
  const b = ctx.body;
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw U.error("Agregá al menos un producto a la venta");
  if (items.length > 200) throw U.error("Una venta puede tener hasta 200 renglones");
  let forma = U.opcion(b.forma_pago || "EFECTIVO", FORMAS, "La forma de pago");
  if (U.bool(b.devolucion)) forma = "DESCUENTO";
  const codigoPago = ["QR", "TARJETA_DEBITO", "TARJETA_CREDITO", "TRANSFERENCIA"].includes(forma)
    ? U.texto(b.codigo_pago, { max: 60, campo: "El código de pago" }) : null;
  const afiliadoId = b.afiliado_id ? U.id(b.afiliado_id, "El afiliado") : null;
  if (forma === "DESCUENTO" && !afiliadoId) throw U.error("Para cobrar con descuento de haberes indicá el DNI o legajo del afiliado");

  const agrupados = new Map();
  for (const it of items) {
    const productoId = U.id(it.producto_id, "El producto");
    const cantidad = U.numero(it.cantidad, { min: 0.001, max: 99999, decimales: 3, campo: "La cantidad" });
    agrupados.set(productoId, U.redondear((agrupados.get(productoId) || 0) + cantidad, 3));
  }

  return ctx.db.tx(async (t) => {
    const caja = await N.exigir(t, ctx, "predio_caja", puesto.caja_id, "La caja ya no existe");
    if (!Number(caja.activo)) throw U.error("La caja está deshabilitada", 409);
    const config = await N.leerConfig(t, ctx);
    const lineas = [];
    const faltantes = [];
    for (const [productoId, cantidad] of agrupados) {
      const p = await N.exigir(t, ctx, "predio_producto", productoId, "Uno de los productos no existe");
      if (!Number(p.activo)) throw U.error(`«${p.nombre}» está dado de baja`);
      if (p.destino === "USO_INTERNO") throw U.error(`«${p.nombre}» es de uso interno y no se vende`);
      const precio = U.redondear(Number(p.precio_venta || 0), 2);
      if (precio <= 0) throw U.error(`«${p.nombre}» no tiene precio de venta: pedile al administrador que lo cargue`, 409, { codigo: "SIN_PRECIO" });
      if (MOVEDORES_STOCK.includes(p.destino)) {
        const stock = await N.stockActual(t, ctx, caja.boca_id, productoId);
        if (stock < cantidad) faltantes.push({ producto_id: productoId, producto: p.nombre, pedido: cantidad, disponible: stock });
      }
      lineas.push({ producto: p, cantidad, precio, subtotal: U.redondear(precio * cantidad, 2) });
    }
    if (faltantes.length) {
      if (config.vender_sin_stock === "0") {
        throw U.error(`No hay stock suficiente de «${faltantes[0].producto}» en esta boca`, 409, { codigo: "SIN_STOCK", faltantes });
      }
      if (!b.confirmar_sin_stock) {
        throw U.error("Hay productos que figuran sin stock suficiente en esta boca", 409, { codigo: "STOCK_INSUFICIENTE", faltantes });
      }
    }
    const total = U.redondear(lineas.reduce((s, l) => s + l.subtotal, 0), 2);
    if (total <= 0 && forma !== "EFECTIVO") throw U.error("El total de la venta tiene que ser mayor que cero");

    let afiliado = null;
    if (afiliadoId) {
      afiliado = await N.exigir(t, ctx, "predio_afiliado", afiliadoId, "No encontramos al afiliado");
      if (forma === "DESCUENTO") {
        const disp = await disponibleAfiliado(t, ctx, afiliadoId);
        if (!disp.habilitado) throw U.error("El afiliado no está habilitado para comprar con descuento de haberes", 409, { codigo: "SIN_DISPONIBLE", disponible: 0 });
        if (disp.disponible < total) {
          throw U.error(
            disp.disponible <= 0
              ? "Al afiliado no le queda disponible para descuento de haberes: tiene que pagar de otra forma."
              : `Al afiliado le quedan ${U.pesos(disp.disponible)} de descuento y la venta es de ${U.pesos(total)}. Tiene que pagar de otra forma o sacar productos.`,
            409, { codigo: "SIN_DISPONIBLE", disponible: disp.disponible, total });
        }
      }
    }

    let recibido = null;
    let vuelto = null;
    if (forma === "EFECTIVO") {
      recibido = b.recibido === undefined || b.recibido === null || b.recibido === "" ? total : U.numero(b.recibido, { min: 0, max: 99999999, campo: "El efectivo recibido" });
      if (recibido < total) throw U.error(`El efectivo recibido (${U.pesos(recibido)}) no alcanza para el total (${U.pesos(total)})`);
      vuelto = U.redondear(recibido - total, 2);
    }

    const ahora = U.fechaHora();
    const ventaId = await N.insertar(t, ctx, "predio_venta", {
      boca_id: caja.boca_id, caja_id: caja.id, turno_id: puesto.turno_id || null, usuario_id: ctx.usuario.id,
      usuario_nombre: N.nombreActor(ctx), fecha: ahora, afiliado_id: afiliado ? afiliado.id : null,
      afiliado_dni: afiliado?.dni || null, afiliado_legajo: afiliado?.legajo || null, afiliado_nombre: afiliado?.nombre || null,
      forma_pago: forma, codigo_pago: codigoPago, total, recibido, vuelto, estado: "CONFIRMADA", impresiones: 0,
      observaciones: U.texto(b.observaciones, { max: 255 }),
    });
    for (const l of lineas) {
      await N.insertar(t, ctx, "predio_venta_item", {
        venta_id: ventaId, producto_id: l.producto.id, descripcion: l.producto.nombre, codigo: l.producto.codigo,
        cantidad: l.cantidad, precio_unitario: l.precio, subtotal: l.subtotal, destino: l.producto.destino,
      });
      if (MOVEDORES_STOCK.includes(l.producto.destino)) {
        await N.moverStock(t, ctx, {
          bocaId: caja.boca_id, productoId: l.producto.id, cantidad: -l.cantidad, tipo: "VENTA",
          referenciaTipo: "venta", referenciaId: ventaId, detalle: `Venta N° ${ventaId}`,
        });
      }
    }
    if (forma === "EFECTIVO" && total > 0) {
      await N.insertar(t, ctx, "predio_caja_movimiento", {
        caja_id: caja.id, boca_id: caja.boca_id, fecha: ahora, concepto: "VENTA", tipo: "INGRESO", importe: total,
        observaciones: `Venta N° ${ventaId}`, venta_id: ventaId, turno_id: puesto.turno_id || null,
        usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      });
    }
    if (faltantes.length) {
      await N.auditar(t, ctx, "Venta sin stock suficiente", "venta", ventaId, { faltantes });
    }
    return { id: ventaId, total, vuelto, mensaje: `Venta N° ${ventaId} registrada`, ticket: await datosTicket(t, ctx, ventaId) };
  });
}

async function verVenta(ctx) {
  const id = U.id(ctx.params.id);
  const datos = await datosTicket(ctx.db, ctx, id);
  if (!puedeVerVenta(ctx, datos.venta)) throw U.error("No tenés acceso a esta venta", 403);
  return datos;
}

async function registrarImpresion(ctx) {
  const id = U.id(ctx.params.id);
  return ctx.db.tx(async (t) => {
    const v = await N.exigir(t, ctx, "predio_venta", id, "No encontramos la venta");
    if (!puedeVerVenta(ctx, v)) throw U.error("No tenés acceso a esta venta", 403);
    const impresiones = Number(v.impresiones || 0) + 1;
    await t.run("UPDATE predio_venta SET impresiones = ? WHERE predio_id = ? AND id = ?", [impresiones, ctx.pid, id]);
    if (impresiones > 1) await N.auditar(t, ctx, "Reimpresión de ticket", "venta", id, { impresion: impresiones });
    const datos = await datosTicket(t, ctx, id);
    datos.reimpresion = impresiones > 1;
    return datos;
  });
}

async function anularVenta(ctx) {
  const id = U.id(ctx.params.id);
  const b = ctx.body;
  const motivo = U.texto(b.motivo, { max: 255, campo: "El motivo de la anulación", requerido: true });
  return ctx.db.tx(async (t) => {
    const v = await N.exigir(t, ctx, "predio_venta", id, "No encontramos la venta", { bloquear: true });
    if (v.estado === "ANULADA") throw U.error("La venta ya está anulada", 409);
    if (!esAdmin(ctx)) {
      const caja = ctx.sesion?.caja_id;
      if (Number(v.caja_id) !== Number(caja)) throw U.error("Sólo podés anular ventas de la caja en la que estás trabajando", 403);
    }
    if (v.liquidacion_id) throw U.error("La venta ya está incluida en una liquidación del afiliado: anulá primero la liquidación", 409);
    const cierre = await t.get(
      "SELECT id, fecha FROM predio_cierre WHERE predio_id = ? AND caja_id = ? AND fecha >= ? ORDER BY id DESC LIMIT 1",
      [ctx.pid, v.caja_id, v.fecha]);
    if (cierre) throw U.error(`La caja se cerró después de esta venta (cierre N° ${cierre.id}): ya no se puede anular`, 409);
    const autorizacion = await autorizar(t, ctx, "ANULAR_VENTA", {
      clave: b.clave, permisoId: b.permiso_id, referenciaId: id, detalle: `Venta N° ${id} por ${U.pesos(v.total)}`,
    });
    const items = await t.all("SELECT * FROM predio_venta_item WHERE predio_id = ? AND venta_id = ?", [ctx.pid, id]);
    for (const it of items) {
      if (MOVEDORES_STOCK.includes(it.destino)) {
        await N.moverStock(t, ctx, {
          bocaId: v.boca_id, productoId: it.producto_id, cantidad: Number(it.cantidad), tipo: "ANULACION_VENTA",
          referenciaTipo: "venta", referenciaId: id, detalle: `Anulación de la venta N° ${id}`,
        });
      }
    }
    if (v.forma_pago === "EFECTIVO" && Number(v.total) > 0) {
      await N.insertar(t, ctx, "predio_caja_movimiento", {
        caja_id: v.caja_id, boca_id: v.boca_id, fecha: U.fechaHora(), concepto: "ANULACION_VENTA", tipo: "EGRESO", importe: Number(v.total),
        observaciones: `Anulación de la venta N° ${id}`, venta_id: id, turno_id: ctx.sesion?.turno_id || null,
        usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      });
    }
    await N.actualizar(t, ctx, "predio_venta", id, {
      estado: "ANULADA", anulada_fecha: U.fechaHora(), anulada_por: N.nombreActor(ctx), anulacion_motivo: motivo,
      anulacion_autorizacion: autorizacion.metodo,
    });
    await N.auditar(t, ctx, "Anulación de venta", "venta", id, { motivo, total: Number(v.total), forma_pago: v.forma_pago, autorizacion: autorizacion.metodo });
    return { id, mensaje: `Venta N° ${id} anulada`, devolver_efectivo: v.forma_pago === "EFECTIVO" ? Number(v.total) : 0 };
  });
}

// Permite a un cajero ver todas las ventas de su caja (con autorización) durante un rato.
async function habilitarVerCaja(ctx) {
  exigirPuesto(ctx);
  if (esAdmin(ctx)) return { ok: true };
  return ctx.db.tx(async (t) => {
    const r = await autorizar(t, ctx, "VER_VENTAS_CAJA", { clave: ctx.body.clave, permisoId: ctx.body.permiso_id, referenciaId: ctx.sesion.caja_id });
    return { ok: true, permiso_id: r.permisoId };
  });
}

module.exports = {
  datosTicket,
  rutas: [
    { m: "POST", p: "/ventas", h: crearVenta, escritura: true, soloLocal: true },
    { m: "GET", p: "/ventas/:id", h: verVenta },
    { m: "POST", p: "/ventas/:id/impresion", h: registrarImpresion, escritura: true },
    { m: "POST", p: "/ventas/:id/anular", h: anularVenta, escritura: true },
    { m: "POST", p: "/ventas/ver-caja", h: habilitarVerCaja, escritura: true, soloLocal: true },
  ],
};
