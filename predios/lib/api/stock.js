"use strict";

// Solicitudes internas entre bocas, traspasos directos y bajas de stock.
// Sentido de una solicitud: el producto SALE de la boca de origen (la que lo tiene,
// por ejemplo el almacén) y LLEGA a la boca de destino (la que lo pide o lo consume).
// Flujo: PENDIENTE → (origen despacha) DESPACHADA → (destino confirma) RECIBIDA.

const U = require("../util");
const N = require("../negocio");
const Porciones = require("../porciones");
const { bloquearPrecios } = require("../precio-boca");
const { MOTIVOS_BAJA } = require("../listados");
const { exigirAdmin, esAdmin, bocasDe, autorizar } = require("./comun");

const MOTIVOS = MOTIVOS_BAJA.map((m) => m.valor);

async function validarBocas(t, ctx, origenId, destinoId) {
  if (origenId === destinoId) throw U.error("La boca de origen no puede ser la misma que la de destino");
  const origen = await N.exigir(t, ctx, "predio_boca", origenId, "No encontramos la boca de origen");
  const destino = await N.exigir(t, ctx, "predio_boca", destinoId, "No encontramos la boca de destino");
  if (!Number(origen.activo) || !Number(destino.activo)) throw U.error("Alguna de las bocas está inactiva");
  if (!Number(origen.es_origen)) throw U.error(`«${origen.nombre}» no está habilitada como boca de origen`);
  if (!Number(destino.es_destino)) throw U.error(`«${destino.nombre}» no está habilitada como boca de destino`);
  return { origen, destino };
}

function leerLineas(body) {
  const crudas = Array.isArray(body.lineas) && body.lineas.length
    ? body.lineas
    : [{ producto_id: body.producto_id, cantidad: body.cantidad }];
  const agrupadas = new Map();
  for (const l of crudas) {
    const productoId = U.id(l.producto_id, "El producto");
    const cantidad = U.numero(l.cantidad, { min: 0.001, max: 9999999, decimales: 3, campo: "La cantidad" });
    agrupadas.set(productoId, U.redondear((agrupadas.get(productoId) || 0) + cantidad, 3));
  }
  if (!agrupadas.size) throw U.error("Agregá al menos un producto");
  if (agrupadas.size > 100) throw U.error("Podés pedir hasta 100 productos por vez");
  return [...agrupadas.entries()].map(([producto_id, cantidad]) => ({ producto_id, cantidad }));
}

async function verificarDisponibles(t, ctx, bocaId, lineas, { mover = false } = {}) {
  const faltantes = [];
  for (const l of [...lineas].sort((a, b) => a.producto_id - b.producto_id)) {
    const p = await N.exigir(t, ctx, "predio_producto", l.producto_id, "Uno de los productos no existe");
    const disponible = mover ? await N.bloquearSaldoStock(t, ctx, bocaId, l.producto_id) : await N.stockActual(t, ctx, bocaId, l.producto_id);
    l.nombre = p.nombre;
    if (l.cantidad > disponible) faltantes.push({ producto_id: l.producto_id, producto: p.nombre, destino: p.destino, pedido: l.cantidad, disponible });
  }
  return faltantes;
}

// Sólo el traspaso de un compuesto físico o de su insumo base admite una
// diferencia de inventario. El pedido, por sí solo, todavía no mueve stock.
async function controlarSalida(t, ctx, bocaId, lineas, confirmarCompuesto) {
  const faltantes = await verificarDisponibles(t, ctx, bocaId, lineas, { mover: true });
  for (const f of faltantes) {
    const compuestoFisico = f.destino === "VENTA_COMPUESTA" && !await Porciones.leer(t, ctx, f.producto_id);
    if (!compuestoFisico && !await Porciones.esInsumo(t, ctx, f.producto_id)) {
      throw U.error(`Stock insuficiente de «${f.producto}» en el origen: hay ${f.disponible} y se necesitan ${f.pedido}.`, 409, { codigo: "SIN_STOCK", faltantes });
    }
  }
  if (faltantes.length && confirmarCompuesto !== true) throw U.error("El traspaso de estos fraccionables dejará saldo negativo en el origen.", 409,
    { codigo: "STOCK_INSUFICIENTE", faltantes });
  return faltantes;
}

async function disponible(ctx) {
  const bocaId = U.id(ctx.query.boca_id, "La boca");
  const productoId = U.id(ctx.query.producto_id, "El producto");
  const cantidad = await N.stockActual(ctx.db, ctx, bocaId, productoId);
  return { boca_id: bocaId, producto_id: productoId, cantidad };
}

async function crearSolicitud(ctx) {
  const b = ctx.body;
  const origenId = U.id(b.boca_origen_id, "La boca de origen");
  const destinoId = U.id(b.boca_destino_id, "La boca de destino");
  const lineas = leerLineas(b);
  const bajaAutomatica = esAdmin(ctx) ? U.bool(b.baja_automatica) : 0;
  const observaciones = U.texto(b.observaciones, { max: 255 });
  if (!esAdmin(ctx)) {
    const mias = bocasDe(ctx);
    if (!mias.includes(origenId) && !mias.includes(destinoId)) throw U.error("Sólo podés pedir para tus bocas", 403);
  }
  return ctx.db.tx(async (t) => {
    await validarBocas(t, ctx, origenId, destinoId);
    const faltantes = await verificarDisponibles(t, ctx, origenId, lineas);
    if (faltantes.length && !b.confirmar_sin_stock) {
      throw U.error("Hay productos con menos stock que lo pedido", 409, { codigo: "STOCK_INSUFICIENTE", faltantes });
    }
    const autorizacion = await autorizar(t, ctx, "SOLICITUD_PRODUCTO", {
      clave: b.clave, permisoId: b.permiso_id, detalle: `${lineas.length} producto(s)`,
    });
    const ahora = U.fechaHora();
    const ids = [];
    let lote = null;
    for (const l of lineas) {
      const id = await N.insertar(t, ctx, "predio_solicitud", {
        lote, producto_id: l.producto_id, cantidad: l.cantidad, boca_origen_id: origenId, boca_destino_id: destinoId,
        estado: "PENDIENTE", baja_automatica: bajaAutomatica, observaciones, fecha_solicitud: ahora,
        usuario_solicitud_id: ctx.usuario.id, usuario_solicitud: N.nombreActor(ctx), autorizacion: autorizacion.metodo,
      });
      if (lote === null) {
        lote = id;
        await t.run("UPDATE predio_solicitud SET lote = ? WHERE predio_id = ? AND id = ?", [lote, ctx.pid, id]);
      }
      ids.push(id);
    }
    await N.auditar(t, ctx, "Solicitud de productos", "solicitud", lote, {
      origen: origenId, destino: destinoId, lineas, baja_automatica: bajaAutomatica, autorizacion: autorizacion.metodo,
      sin_stock: faltantes.length ? faltantes : undefined,
    });
    return { ids, lote, mensaje: ids.length === 1 ? "Solicitud enviada" : `${ids.length} solicitudes enviadas` };
  });
}

async function despachar(ctx) {
  const id = U.id(ctx.params.id);
  return ctx.db.tx(async (t) => {
    if (t.forUpdate) await bloquearPrecios(t, ctx);
    const s = await N.exigir(t, ctx, "predio_solicitud", id, "No encontramos la solicitud", { bloquear: true });
    if (s.estado !== "PENDIENTE") throw U.error("La solicitud ya no está pendiente", 409);
    if (!esAdmin(ctx) && !bocasDe(ctx).includes(Number(s.boca_origen_id))) {
      throw U.error("La despacha la boca de origen o un administrador", 403);
    }
    let cantidad = Number(s.cantidad);
    if (ctx.body.cantidad !== undefined && ctx.body.cantidad !== null && ctx.body.cantidad !== "") {
      cantidad = U.numero(ctx.body.cantidad, { min: 0.001, max: 9999999, decimales: 3, campo: "La cantidad a despachar" });
    }
    const p = await N.exigir(t, ctx, "predio_producto", s.producto_id);
    const faltantes = await controlarSalida(t, ctx, s.boca_origen_id, [{ producto_id: s.producto_id, cantidad }], ctx.body.confirmar_fraccionado);
    await N.moverStock(t, ctx, {
      bocaId: s.boca_origen_id, productoId: s.producto_id, cantidad: -cantidad, tipo: "TRASPASO_SALIDA",
      referenciaTipo: "solicitud", referenciaId: id, detalle: `Solicitud N° ${id}`,
    });
    await N.actualizar(t, ctx, "predio_solicitud", id, {
      estado: "DESPACHADA", cantidad, fecha_despacho: U.fechaHora(), usuario_despacho_id: ctx.usuario.id, usuario_despacho: N.nombreActor(ctx),
    });
    await N.auditar(t, ctx, "Despacho de solicitud", "solicitud", id, { producto: p.nombre, cantidad, pedida: Number(s.cantidad), sin_stock: faltantes.length ? faltantes : undefined });
    return { id, mensaje: `Despachaste ${cantidad} × ${p.nombre}` };
  });
}

async function recibirInterno(t, ctx, s, { permitirCualquiera = false } = {}) {
  if (s.estado !== "DESPACHADA") throw U.error("La solicitud todavía no fue despachada", 409);
  if (!permitirCualquiera && !esAdmin(ctx) && !bocasDe(ctx).includes(Number(s.boca_destino_id))) {
    throw U.error("La recibe la boca de destino o un administrador", 403);
  }
  const cantidad = Number(s.cantidad);
  const recibido = await N.moverStock(t, ctx, {
    bocaId: s.boca_destino_id, productoId: s.producto_id, cantidad, tipo: "TRASPASO_ENTRADA",
    referenciaTipo: "solicitud", referenciaId: s.id, detalle: `Solicitud N° ${s.id}`,
  });
  if (Number(s.baja_automatica)) {
    if (recibido < cantidad) throw U.error("El consumo automático dejaría stock negativo en la boca de destino. Revisá sus existencias.", 409, { codigo: "SIN_STOCK" });
    await N.insertar(t, ctx, "predio_baja", {
      fecha: U.fechaHora(), boca_id: s.boca_destino_id, producto_id: s.producto_id, cantidad, motivo: "CONSUMO_DESTINO",
      observaciones: `Baja automática al recibir la solicitud N° ${s.id}`, usuario_id: ctx.usuario?.id || null,
      usuario_nombre: N.nombreActor(ctx), solicitud_id: s.id,
    });
    await N.moverStock(t, ctx, {
      bocaId: s.boca_destino_id, productoId: s.producto_id, cantidad: -cantidad, tipo: "BAJA", motivo: "CONSUMO_DESTINO",
      referenciaTipo: "solicitud", referenciaId: s.id, detalle: `Consumo en destino (solicitud N° ${s.id})`,
    });
  }
  await N.actualizar(t, ctx, "predio_solicitud", s.id, {
    estado: "RECIBIDA", fecha_recepcion: U.fechaHora(), usuario_recepcion_id: ctx.usuario?.id || null, usuario_recepcion: N.nombreActor(ctx),
  });
}

async function recibir(ctx) {
  const id = U.id(ctx.params.id);
  return ctx.db.tx(async (t) => {
    const s = await N.exigir(t, ctx, "predio_solicitud", id, "No encontramos la solicitud", { bloquear: true });
    await recibirInterno(t, ctx, s);
    const p = await N.obtener(t, ctx, "predio_producto", s.producto_id);
    await N.auditar(t, ctx, "Recepción de solicitud", "solicitud", id, { producto: p?.nombre, cantidad: Number(s.cantidad), baja_automatica: Number(s.baja_automatica) });
    return { id, mensaje: `Recibiste ${Number(s.cantidad)} × ${p?.nombre || "producto"}` };
  });
}

async function rechazarOAnular(ctx, accion) {
  const id = U.id(ctx.params.id);
  const motivo = U.texto(ctx.body.motivo, { max: 255, campo: "El motivo" });
  return ctx.db.tx(async (t) => {
    const s = await N.exigir(t, ctx, "predio_solicitud", id, "No encontramos la solicitud", { bloquear: true });
    if (s.estado !== "PENDIENTE") throw U.error("Sólo se puede cambiar una solicitud pendiente", 409);
    if (accion === "RECHAZADA" && !esAdmin(ctx) && !bocasDe(ctx).includes(Number(s.boca_origen_id))) {
      throw U.error("La rechaza la boca de origen o un administrador", 403);
    }
    if (accion === "ANULADA" && !esAdmin(ctx) && Number(s.usuario_solicitud_id) !== Number(ctx.usuario.id)) {
      throw U.error("Sólo quien la pidió o un administrador puede anularla", 403);
    }
    await N.actualizar(t, ctx, "predio_solicitud", id, {
      estado: accion, fecha_anulacion: U.fechaHora(), usuario_anulacion: N.nombreActor(ctx), motivo_anulacion: motivo,
    });
    await N.auditar(t, ctx, accion === "RECHAZADA" ? "Solicitud rechazada" : "Solicitud anulada", "solicitud", id, { motivo });
    return { id, mensaje: accion === "RECHAZADA" ? "Solicitud rechazada" : "Solicitud anulada" };
  });
}

// Traspaso directo del administrador: queda despachado y recibido en el mismo momento.
async function traspaso(ctx) {
  exigirAdmin(ctx);
  const b = ctx.body;
  const origenId = U.id(b.boca_origen_id, "La boca de origen");
  const destinoId = U.id(b.boca_destino_id, "La boca de destino");
  const lineas = leerLineas(b);
  const bajaAutomatica = U.bool(b.baja_automatica);
  const observaciones = U.texto(b.observaciones, { max: 255 });
  return ctx.db.tx(async (t) => {
    if (t.forUpdate) await bloquearPrecios(t, ctx);
    await validarBocas(t, ctx, origenId, destinoId);
    const faltantes = await controlarSalida(t, ctx, origenId, lineas, b.confirmar_fraccionado);
    const ahora = U.fechaHora();
    const ids = [];
    let lote = null;
    for (const l of lineas) {
      const id = await N.insertar(t, ctx, "predio_solicitud", {
        lote, producto_id: l.producto_id, cantidad: l.cantidad, boca_origen_id: origenId, boca_destino_id: destinoId,
        estado: "DESPACHADA", baja_automatica: bajaAutomatica, observaciones: observaciones || "Traspaso directo del administrador",
        fecha_solicitud: ahora, usuario_solicitud_id: ctx.usuario.id, usuario_solicitud: N.nombreActor(ctx),
        fecha_despacho: ahora, usuario_despacho_id: ctx.usuario.id, usuario_despacho: N.nombreActor(ctx), autorizacion: "ADMIN",
      });
      if (lote === null) {
        lote = id;
        await t.run("UPDATE predio_solicitud SET lote = ? WHERE predio_id = ? AND id = ?", [lote, ctx.pid, id]);
      }
      await N.moverStock(t, ctx, {
        bocaId: origenId, productoId: l.producto_id, cantidad: -l.cantidad, tipo: "TRASPASO_SALIDA",
        referenciaTipo: "solicitud", referenciaId: id, detalle: `Traspaso directo N° ${id}`,
      });
      const s = await N.obtener(t, ctx, "predio_solicitud", id);
      await recibirInterno(t, ctx, s, { permitirCualquiera: true });
      ids.push(id);
    }
    await N.auditar(t, ctx, "Traspaso directo entre bocas", "solicitud", lote, { origen: origenId, destino: destinoId, lineas, baja_automatica: bajaAutomatica, sin_stock: faltantes.length ? faltantes : undefined });
    return { ids, lote, mensaje: `Traspaso registrado (${ids.length} producto${ids.length === 1 ? "" : "s"})` };
  });
}

async function registrarAlta(ctx) {
  exigirAdmin(ctx);
  const { body } = ctx;
  const bocaId = U.id(body.boca_id, "La boca");
  const lineas = leerLineas(body);
  const motivo = U.opcion(body.motivo, ["DONACION", "RECUENTO", "OTROS"], "El motivo");
  const observaciones = U.texto(body.observaciones, { max: 255, requerido: motivo === "OTROS", campo: "La observación" });
  const descripcion = { DONACION: "Donación", RECUENTO: "Diferencia de recuento", OTROS: "Otro ingreso" }[motivo];
  return ctx.db.tx(async (t) => {
    if (t.forUpdate) await bloquearPrecios(t, ctx);
    const boca = await N.exigir(t, ctx, "predio_boca", bocaId, "No encontramos la boca");
    if (!Number(boca.activo)) throw U.error("Elegí una boca activa");
    for (const linea of lineas) {
      const p = await N.exigir(t, ctx, "predio_producto", linea.producto_id, "No encontramos el producto", { bloquear: true });
      if (!Number(p.activo)) throw U.error("Elegí un producto activo");
      await N.moverStock(t, ctx, {
        bocaId, productoId: p.id, cantidad: linea.cantidad, tipo: "ALTA", motivo, referenciaTipo: "producto", referenciaId: p.id,
        detalle: observaciones ? descripcion + " · " + observaciones : descripcion,
      });
    }
    await N.auditar(t, ctx, "Alta de stock", "producto", lineas[0].producto_id, { boca: bocaId, motivo, lineas, observaciones });
    return { mensaje: "Alta de stock registrada" };
  });
}

async function bajar(ctx) {
  exigirAdmin(ctx);
  const b = ctx.body;
  const bocaId = U.id(b.boca_id, "La boca");
  const lineas = leerLineas(b);
  const motivo = U.opcion(b.motivo, MOTIVOS, "El motivo");
  const observaciones = U.texto(b.observaciones, { max: 255 });
  if (motivo === "OTROS" && !observaciones) throw U.error("Contá brevemente el motivo en las observaciones");
  return ctx.db.tx(async (t) => {
    if (t.forUpdate) await bloquearPrecios(t, ctx);
    await N.exigir(t, ctx, "predio_boca", bocaId, "No encontramos la boca");
    const faltantes = await verificarDisponibles(t, ctx, bocaId, lineas, { mover: true });
    if (faltantes.length) throw U.error(`La baja supera el stock de «${faltantes[0].producto}» en esta boca (${faltantes[0].disponible}).`, 409,
      { codigo: "SIN_STOCK", faltantes });
    const ids = [];
    for (const l of lineas) {
      const id = await N.insertar(t, ctx, "predio_baja", {
        fecha: U.fechaHora(), boca_id: bocaId, producto_id: l.producto_id, cantidad: l.cantidad, motivo, observaciones,
        usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      });
      await N.moverStock(t, ctx, {
        bocaId, productoId: l.producto_id, cantidad: -l.cantidad, tipo: "BAJA", motivo, referenciaTipo: "baja", referenciaId: id,
        detalle: observaciones || `Baja por ${motivo.toLowerCase().replace("_", " ")}`,
      });
      ids.push(id);
    }
    await N.auditar(t, ctx, "Baja de stock", "producto", lineas[0].producto_id, { boca: bocaId, motivo, lineas, observaciones });
    return { ids, mensaje: "Baja registrada" };
  });
}

async function detalleSolicitud(ctx) {
  const id = U.id(ctx.params.id);
  const s = await ctx.db.get(
    `SELECT s.*, p.nombre AS producto, p.codigo, bo.nombre AS origen, bd.nombre AS destino
     FROM predio_solicitud s
     JOIN predio_producto p ON p.predio_id = s.predio_id AND p.id = s.producto_id
     JOIN predio_boca bo ON bo.predio_id = s.predio_id AND bo.id = s.boca_origen_id
     JOIN predio_boca bd ON bd.predio_id = s.predio_id AND bd.id = s.boca_destino_id
     WHERE s.predio_id = ? AND s.id = ?`, [ctx.pid, id]);
  if (!s) throw U.error("No encontramos la solicitud", 404);
  if (!esAdmin(ctx) && !bocasDe(ctx).includes(Number(s.boca_origen_id)) && !bocasDe(ctx).includes(Number(s.boca_destino_id))) {
    throw U.error("No tenés acceso a esta solicitud", 403);
  }
  const stockOrigen = await N.stockActual(ctx.db, ctx, s.boca_origen_id, s.producto_id);
  return { solicitud: s, stock_origen: stockOrigen };
}

module.exports = {
  rutas: [
    { m: "GET", p: "/stock/disponible", h: disponible },
    { m: "POST", p: "/solicitudes", h: crearSolicitud, escritura: true },
    { m: "GET", p: "/solicitudes/:id", h: detalleSolicitud },
    { m: "POST", p: "/solicitudes/:id/despachar", h: despachar, escritura: true },
    { m: "POST", p: "/solicitudes/:id/recibir", h: recibir, escritura: true },
    { m: "POST", p: "/solicitudes/:id/rechazar", h: (ctx) => rechazarOAnular(ctx, "RECHAZADA"), escritura: true },
    { m: "POST", p: "/solicitudes/:id/anular", h: (ctx) => rechazarOAnular(ctx, "ANULADA"), escritura: true },
    { m: "POST", p: "/traspasos", h: traspaso, escritura: true, roles: ["ADMIN"] },
    { m: "POST", p: "/bajas", h: bajar, escritura: true, roles: ["ADMIN"] },
    { m: "POST", p: "/altas", h: registrarAlta, escritura: true, roles: ["ADMIN"] },
  ],
};
