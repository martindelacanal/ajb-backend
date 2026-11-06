"use strict";

// Ventas en las cajas de cada boca. El precio sale siempre del producto (el servidor manda),
// el efectivo genera movimiento de caja y el descuento de haberes consume el disponible.

const U = require("../util");
const N = require("../negocio");
const { emitirAviso } = require("../avisos");
const { FORMAS_PAGO } = require("../listados");
const { esAdmin, bocasDe, exigirPuesto, exigirBoca, autorizar, disponibleAfiliado } = require("./comun");

const FORMAS = FORMAS_PAGO.map((f) => f.valor);
const MOVEDORES_STOCK = ["VENTA_DIRECTA"];

async function stockParaVenta(t, ctx, bocaId, productoId) {
  // Una consulta previa puede ver una instantánea vieja en MySQL. Sólo se usa
  // para evitar altas innecesarias; el saldo válido sale de la lectura bloqueada.
  const fila = await t.get("SELECT id FROM predio_stock WHERE predio_id = ? AND boca_id = ? AND producto_id = ?", [ctx.pid, bocaId, productoId]);
  if (!fila) {
    const id = await N.nuevoId(t, "predio_stock", ctx.pid);
    // Si otra operación creó la fila mientras esperábamos, se conserva su saldo.
    await t.run(`${t.insertIgnore} INTO predio_stock (predio_id, id, boca_id, producto_id, cantidad, fecha_modificacion) VALUES (?, ?, ?, ?, 0, ?)`,
      [ctx.pid, id, bocaId, productoId, U.fechaHora()]);
  }
  const actual = await t.get(`SELECT cantidad FROM predio_stock WHERE predio_id = ? AND boca_id = ? AND producto_id = ?${t.forUpdate}`, [ctx.pid, bocaId, productoId]);
  if (!actual) throw U.error("No pudimos comprobar el stock del producto. Volvé a intentar.", 409);
  return Number(actual.cantidad);
}

async function avisarFaltante(t, ctx, { producto, busqueda, cantidad, stock, ventaId = null, faltantes = null }) {
  const puesto = exigirPuesto(ctx);
  const caja = await N.exigir(t, ctx, "predio_caja", puesto.caja_id, "La caja ya no existe");
  if (!Number(caja.activo) || Number(caja.boca_id) !== Number(puesto.boca_id)) throw U.error("Elegí nuevamente la boca y la caja", 409, { codigo: "SIN_PUESTO" });
  const boca = await N.exigir(t, ctx, "predio_boca", caja.boca_id, "La boca ya no existe");
  const fecha = U.fechaHora();
  const detalle = {
    fecha, boca_id: boca.id, boca: boca.nombre, caja_id: caja.id, caja: caja.nombre,
    usuario_id: ctx.usuario.id, usuario: N.nombreActor(ctx), producto_id: producto?.id || null,
    producto: producto?.nombre || null, codigo: producto?.codigo || null,
    busqueda: busqueda || producto?.codigo || producto?.nombre || null,
    cantidad: cantidad || null, stock: stock ?? null, venta_id: ventaId, faltantes,
  };
  let mensaje = ventaId
    ? `${N.nombreActor(ctx)} registró la venta N° ${ventaId} con stock insuficiente en ${boca.nombre} · ${caja.nombre}, el ${fecha}. Revisá los movimientos de stock.`
    : `${N.nombreActor(ctx)} intentó vender «${producto?.nombre || busqueda}» sin stock registrado suficiente en ${boca.nombre} · ${caja.nombre}, el ${fecha}. Revisá los movimientos de stock.`;
  if (ventaId && faltantes?.length) {
    mensaje += " Productos: " + faltantes.map((f) => `«${f.producto}»: solicitado ${f.pedido}, stock ${f.disponible}`).join("; ") + ".";
  }
  const id = await emitirAviso(t, ctx, {
    tipo: "VENTA_SIN_STOCK", titulo: ventaId ? "Venta con stock insuficiente" : "Intento de venta sin stock", mensaje, detalle,
  });
  await N.auditar(t, ctx, ventaId ? "Aviso de venta con stock insuficiente" : "Intento de venta de producto sin stock", "producto", producto?.id || null, detalle);
  return id;
}

async function avisarSinStock(ctx) {
  const puesto = exigirPuesto(ctx);
  exigirBoca(ctx, puesto.boca_id);
  if (ctx.body.confirmar !== true) throw U.error("Aceptá el aviso para informar al administrador");
  const productoId = ctx.body.producto_id ? U.id(ctx.body.producto_id, "El producto") : null;
  const busqueda = U.texto(ctx.body.busqueda, { max: 160, requerido: !productoId, campo: "El producto o código buscado" });
  const cantidad = U.numero(ctx.body.cantidad ?? 1, { min: 0.001, max: 99999, decimales: 3, campo: "La cantidad" });
  return ctx.db.tx(async (t) => {
    let producto = null;
    let stock = null;
    if (productoId) {
      producto = await N.exigir(t, ctx, "predio_producto", productoId, "No encontramos el producto");
      if (!Number(producto.activo) || producto.destino === "USO_INTERNO") throw U.error("Este producto no se puede vender", 409, { codigo: "PRODUCTO_NO_VENDIBLE" });
      stock = await N.stockActual(t, ctx, puesto.boca_id, productoId);
      if (stock >= cantidad) throw U.error("El producto ya tiene stock suficiente. Volvé a buscarlo en la lista de ventas.", 409, { codigo: "STOCK_DISPONIBLE" });
    }
    const id = await avisarFaltante(t, ctx, { producto, busqueda, cantidad, stock });
    const config = await N.leerConfig(t, ctx);
    return { id, puede_vender: !!producto && Number(producto.precio_venta || 0) > 0 && config.vender_sin_stock !== "0", mensaje: "El aviso quedó registrado para el administrador. Si no hay internet, se enviará al sistema general al sincronizar." };
  });
}

async function avisosAceptados(t, ctx, cantidades, pedidos) {
  const salida = new Map();
  if (!Array.isArray(pedidos)) return salida;
  if (pedidos.length > 200) throw U.error("La venta incluye demasiados avisos de stock");
  const candidatos = pedidos.map((p) => ({ id: Number(p?.id), productoId: Number(p?.producto_id) }))
    .filter((p) => Number.isSafeInteger(p.id) && p.id > 0 && cantidades.has(p.productoId))
    .sort((a, b) => a.id - b.id);
  const vistos = new Set();
  for (const p of candidatos) {
    if (vistos.has(p.id)) continue;
    vistos.add(p.id);
    const aviso = await t.get(`SELECT id, tipo, detalle FROM predio_aviso WHERE predio_id = ? AND id = ?${t.forUpdate}`, [ctx.pid, p.id]);
    if (!aviso || aviso.tipo !== "VENTA_SIN_STOCK") continue;
    let d;
    try { d = JSON.parse(aviso.detalle || "null"); } catch (_e) { continue; }
    if (!d || d.venta_id || d.consumido_venta_id || Number(d.usuario_id) !== Number(ctx.usuario.id)
      || Number(d.boca_id) !== Number(ctx.sesion.boca_id) || Number(d.caja_id) !== Number(ctx.sesion.caja_id)
      || Number(d.producto_id) !== p.productoId || !Number.isFinite(Number(d.cantidad))
      || Number(d.cantidad) < cantidades.get(p.productoId)) continue;
    if (!salida.has(p.productoId)) salida.set(p.productoId, { id: aviso.id, detalle: d });
  }
  return salida;
}

async function datosTicket(db, ctx, ventaId) {
  const v = await db.get(
    `SELECT v.*, b.nombre AS boca, c.nombre AS caja, c.ancho_ticket, c.imprimir_comanda
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
    imprimir_comanda: !!Number(v.imprimir_comanda),
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
  exigirBoca(ctx, puesto.boca_id);
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
    if (Number(caja.boca_id) !== Number(puesto.boca_id)) throw U.error("Elegí nuevamente la boca y la caja", 409, { codigo: "SIN_PUESTO" });
    const config = await N.leerConfig(t, ctx);
    const lineas = [];
    const faltantes = [];
    const productos = new Map();
    const stocks = new Map();
    // Todas las cajas bloquean los productos en el mismo orden. Se conserva el
    // orden del carrito para el ticket y se evitan bloqueos cruzados entre cajas.
    for (const productoId of [...agrupados.keys()].sort((a, b) => a - b)) {
      const p = await N.exigir(t, ctx, "predio_producto", productoId, "Uno de los productos no existe");
      productos.set(productoId, p);
      if (p.destino !== "USO_INTERNO") stocks.set(productoId, await stockParaVenta(t, ctx, caja.boca_id, productoId));
    }
    for (const [productoId, cantidad] of agrupados) {
      const p = productos.get(productoId);
      if (!Number(p.activo)) throw U.error(`«${p.nombre}» está dado de baja`);
      if (p.destino === "USO_INTERNO") throw U.error(`«${p.nombre}» es de uso interno y no se vende`);
      const precio = U.redondear(Number(p.precio_venta || 0), 2);
      if (precio <= 0) throw U.error(`«${p.nombre}» no tiene precio de venta: pedile al administrador que lo cargue`, 409, { codigo: "SIN_PRECIO" });
      const stock = stocks.get(productoId);
      if (MOVEDORES_STOCK.includes(p.destino) ? stock < cantidad : stock <= 0) {
        faltantes.push({ producto_id: productoId, producto: p.nombre, pedido: cantidad, disponible: stock });
      }
      lineas.push({ producto: p, cantidad, precio, subtotal: U.redondear(precio * cantidad, 2) });
    }
    const avisosPrevios = await avisosAceptados(t, ctx, agrupados, b.avisos_sin_stock);
    const sinAviso = faltantes.filter((f) => !avisosPrevios.has(f.producto_id));
    if (faltantes.length) {
      if (config.vender_sin_stock === "0") {
        throw U.error(`No hay stock suficiente de «${faltantes[0].producto}» en esta boca`, 409, { codigo: "SIN_STOCK", faltantes });
      }
      if (sinAviso.length && b.confirmar_sin_stock !== true && b.confirmar_sin_stock !== 1) {
        throw U.error("Hay productos que figuran sin stock suficiente en esta boca", 409, { codigo: "STOCK_INSUFICIENTE", faltantes: sinAviso });
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
      await N.auditar(t, ctx, "Venta sin stock suficiente", "venta", ventaId, { faltantes, avisos_aceptados: [...avisosPrevios.values()].map((a) => a.id) });
      if (sinAviso.length) await avisarFaltante(t, ctx, { ventaId, faltantes: sinAviso });
    }
    for (const aviso of avisosPrevios.values()) {
      await N.actualizar(t, ctx, "predio_aviso", aviso.id, {
        detalle: JSON.stringify({ ...aviso.detalle, consumido_venta_id: ventaId, consumido_fecha: ahora }),
      });
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
    { m: "POST", p: "/ventas/avisar-sin-stock", h: avisarSinStock, escritura: true, soloLocal: true },
    { m: "POST", p: "/ventas", h: crearVenta, escritura: true, soloLocal: true },
    { m: "GET", p: "/ventas/:id", h: verVenta },
    { m: "POST", p: "/ventas/:id/impresion", h: registrarImpresion, escritura: true },
    { m: "POST", p: "/ventas/:id/anular", h: anularVenta, escritura: true },
    { m: "POST", p: "/ventas/ver-caja", h: habilitarVerCaja, escritura: true, soloLocal: true },
  ],
};
