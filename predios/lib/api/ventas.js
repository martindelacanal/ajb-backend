"use strict";

// Ventas en las cajas de cada boca. El precio sale siempre del producto (el servidor manda),
// el efectivo genera movimiento de caja y el saldo se descuenta de la cuenta de la estadía.

const U = require("../util");
const { verificarOperador } = require("../turnos-caja");
const N = require("../negocio");
const Porciones = require("../porciones");
const { productoEnBoca, bloquearPrecios } = require("../precio-boca");
const { emitirAviso } = require("../avisos");
const { autorizacionDescuento } = require("../autorizacion-descuento");
const { FORMAS_PAGO } = require("../listados");
const { esAdmin, esSupervisor, puedeGestionarCajas, bocasDe, exigirPuesto, exigirBoca, autorizar, disponibleAfiliado, turnoDeCaja } = require("./comun");

const FORMAS = FORMAS_PAGO.map((f) => f.valor).filter(f => f !== "DESCUENTO");
async function avisarFaltante(t, ctx, { producto, busqueda, cantidad, stock }) {
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
    cantidad: cantidad || null, stock: stock ?? null,
  };
  const mensaje = `${N.nombreActor(ctx)} intentó vender «${producto?.nombre || busqueda}» sin stock suficiente en ${boca.nombre} · ${caja.nombre}. Revisá los movimientos de stock.`;
  const id = await emitirAviso(t, ctx, { tipo: "VENTA_SIN_STOCK", titulo: "Intento de venta sin stock", mensaje, detalle });
  await N.auditar(t, ctx, "Intento de venta de producto sin stock", "producto", producto?.id || null, detalle);
  return id;
}

async function avisarSinStock(ctx) {
  const puesto = exigirPuesto(ctx);
  exigirBoca(ctx, puesto.boca_id);
  if (ctx.body.confirmar !== true) throw U.error("Aceptá el aviso para informar al administrador");
  const productoId = ctx.body.producto_id ? U.id(ctx.body.producto_id, "El producto") : null;
  const busqueda = U.texto(ctx.body.busqueda, { max: 160, requerido: !productoId, campo: "El producto o código buscado" });
  const cantidad = U.numero(ctx.body.cantidad ?? 1, { min: 0.001, max: 200 * 99999, decimales: 3, campo: "La cantidad" });
  return ctx.db.tx(async (t) => {
    let producto = null;
    let stock = null;
    if (productoId) {
      producto = await productoEnBoca(t, ctx, productoId, puesto.boca_id);
      if (!producto) throw U.error("No encontramos el producto", 404);
      const avisoInsumo = ctx.body.insumo === true && await Porciones.esInsumo(t, ctx, productoId);
      if ((!Number(producto.activo) || producto.destino === "USO_INTERNO") && !avisoInsumo) throw U.error("Este producto no se puede vender", 409, { codigo: "PRODUCTO_NO_VENDIBLE" });
      const receta = producto.destino === "VENTA_COMPUESTA" ? await Porciones.leer(t, ctx, productoId) : null;
      stock = await N.stockActual(t, ctx, puesto.boca_id, receta?.insumo_id || productoId);
      if (receta) stock = Number(receta.activo) && stock > 0 ? Porciones.disponibles(stock, receta.rendimiento) : 0;
      if (!Number(producto.activo)) stock = 0;
      if (stock >= cantidad) throw U.error("El producto ya tiene stock suficiente. Volvé a buscarlo en la lista de ventas.", 409, { codigo: "STOCK_DISPONIBLE" });
    }
    const id = await avisarFaltante(t, ctx, { producto, busqueda, cantidad, stock });
    return { id, puede_vender: false, mensaje: "El aviso quedó registrado para el administrador. Si no hay internet, se enviará al sistema general al sincronizar." };
  });
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
  // Las ventas anteriores a la captura de la autorización conservan el total original.
  const esDescuento = Number(v.importe_haberes)>0 || ["DESCUENTO", "DESCUENTO_HABERES"].includes(v.forma_pago);
  const autorizacion = esDescuento ? (v.autorizacion_descuento ?? autorizacionDescuento(config, v.total)) : config.texto_autorizacion;
  return {
    venta: v,
    pagos: await db.all("SELECT forma,importe FROM predio_venta_pago WHERE predio_id=? AND venta_id=? ORDER BY id", [ctx.pid,ventaId]),
    items,
    afiliado: v.afiliado_id ? {
      id: v.afiliado_id, nombre: v.afiliado_nombre, dni: v.afiliado_dni, legajo: v.afiliado_legajo,
      departamental: v.afiliado_departamental, disponible: v.saldo_disponible == null ? null : Number(v.saldo_disponible),
    } : null,
    imprimir_comanda: !!Number(v.imprimir_comanda),
    ancho: Number(v.ancho_ticket) === 58 ? 58 : 80,
    empresa: {
      nombre_predio: config.nombre_predio,
      razon_social: config.razon_social,
      cuit: config.cuit,
      direccion: config.direccion,
      leyenda: config.leyenda_ticket,
      texto_autorizacion: autorizacion,
    },
  };
}

function puedeVerVenta(ctx, v) {
  if (esAdmin(ctx)) return true;
  return bocasDe(ctx).includes(Number(v.boca_id));
}

function reciboVenta(ctx, puesto, body) {
  if (body.operacion === undefined) return null;
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(body.operacion)) throw U.error("El identificador de la venta no es válido.");
  // La huella sigue reconociendo reintentos de clientes anteriores.
  const { confirmar_sin_stock, ...pedido } = body;
  return {
    clave: "venta:" + U.sha256(body.operacion).slice(0, 58),
    huella: U.sha256(JSON.stringify([ctx.usuario.id, puesto.caja_id, pedido])),
  };
}

async function crearVenta(ctx) {
  const puesto = exigirPuesto(ctx);
  exigirBoca(ctx, puesto.boca_id);
  const b = ctx.body;
  const recibo = reciboVenta(ctx, puesto, b);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw U.error("Agregá al menos un producto a la venta");
  if (items.length > 200) throw U.error("Una venta puede tener hasta 200 renglones");

  const agrupados = new Map();
  const preciosEsperados = new Map();
  for (const it of items) {
    if (!it || typeof it !== "object") throw U.error("Revisá los productos de la venta.");
    const productoId = U.id(it.producto_id, "El producto");
    if (it.precio_unitario != null) {
      const esperado = U.numero(it.precio_unitario, { min: 0, campo: "El precio mostrado en caja" });
      if (preciosEsperados.has(productoId) && preciosEsperados.get(productoId) !== esperado)
        throw U.error("Hay dos precios distintos para el mismo producto. Volvé a agregarlo al carrito.", 409);
      preciosEsperados.set(productoId, esperado);
    }
    const cantidad = U.numero(it.cantidad, { min: 0.001, max: 99999, decimales: 3, campo: "La cantidad" });
    agrupados.set(productoId, U.redondear((agrupados.get(productoId) || 0) + cantidad, 3));
  }

  return ctx.db.tx(async (t) => {
    if (recibo) {
      const previa = await t.get("SELECT huella,respuesta FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, recibo.clave]);
      if (previa) {
        if (previa.huella !== recibo.huella) throw U.error("El comprobante corresponde a otra venta.", 409);
        const respuesta = JSON.parse(previa.respuesta);
        return { ...respuesta, ticket: await datosTicket(t, ctx, respuesta.id) };
      }
    }
    if (U.bool(b.devolucion) || b.forma_pago === "DESCUENTO" || (Array.isArray(b.pagos) && b.pagos.some(p => p?.forma === "DESCUENTO"))) {
      throw U.error("Elegí Saldo y seleccioná al huésped. El descuento de haberes se liquida al salir.");
    }
    const forma = U.opcion(b.forma_pago || "EFECTIVO", FORMAS, "La forma de pago");
    if (forma === "MIXTO" && (!Array.isArray(b.pagos) || b.pagos.length !== 2)) throw U.error("Elegí las dos formas de pago.");
    const codigoPago = ["QR", "TARJETA_DEBITO", "TARJETA_CREDITO", "TRANSFERENCIA"].includes(forma)
      ? U.texto(b.codigo_pago, { max: 60, campo: "El código de pago" }) : null;
    const afiliadoId = b.afiliado_id ? U.id(b.afiliado_id, "El afiliado") : null;
    // Compras y cambios de margen bloquean primero la configuración, luego el
    // producto y el stock. La caja obtiene el precio vigente en ese mismo orden.
    if (t.forUpdate) await bloquearPrecios(t, ctx);
    const caja = await N.exigir(t, ctx, "predio_caja", puesto.caja_id, "La caja ya no existe");
    if (!Number(caja.activo)) throw U.error("La caja está deshabilitada", 409);
    await verificarOperador(t, ctx, caja.id);
    if (Number(caja.boca_id) !== Number(puesto.boca_id)) throw U.error("Elegí nuevamente la boca y la caja", 409, { codigo: "SIN_PUESTO" });
    const lineas = [];
    const preciosCambiaron = [];
    const faltantes = [];
    const productos = new Map();
    const requeridos = new Map();
    // Todas las cajas bloquean los productos en el mismo orden. Se conserva el
    // orden del carrito para el ticket y se evitan bloqueos cruzados entre cajas.
    for (const productoId of [...agrupados.keys()].sort((a, b) => a - b)) {
      const p = await productoEnBoca(t, ctx, productoId, caja.boca_id, { bloquear: true });
      if (!p) throw U.error("Uno de los productos no existe", 404);
      productos.set(productoId, p);
    }
    for (const [productoId, cantidad] of agrupados) {
      const p = productos.get(productoId);
      if (!Number(p.activo)) throw U.error(`«${p.nombre}» está dado de baja`);
      if (p.destino === "USO_INTERNO") throw U.error(`«${p.nombre}» es de uso interno y no se vende`);
      const precio = Number(p.precio_caja);
      if (preciosEsperados.has(productoId) && preciosEsperados.get(productoId) !== precio)
        preciosCambiaron.push({ producto_id: productoId, precio_venta: precio });
      if (precio <= 0) throw U.error(`«${p.nombre}» no tiene precio de venta: pedile al administrador que lo cargue`, 409, { codigo: "SIN_PRECIO" });
      const receta = p.destino === "VENTA_COMPUESTA" ? await Porciones.leer(t, ctx, productoId) : null;
      if (receta && !Number.isInteger(cantidad)) throw U.error(`Ingresá una cantidad entera de porciones para «${p.nombre}».`);
      const stockId = Number(receta?.insumo_id || productoId);
      const linea = { producto: p, cantidad, precio, stockId, rendimiento: receta?.rendimiento, subtotal: U.redondear(precio * cantidad, 2) };
      lineas.push(linea);
      const grupo = requeridos.get(stockId) || { producto: receta?.nombre || p.nombre, lineas: [] };
      grupo.lineas.push(linea);
      if (receta) {
        grupo.insumo = true;
        grupo.inactivo = !Number(receta.activo);
      }
      requeridos.set(stockId, grupo);
    }
    if (preciosCambiaron.length) throw U.error("Cambiaron precios del carrito. Revisá el total antes de cobrar.", 409,
      { codigo: "PRECIOS_CAMBIARON", precios: preciosCambiaron });
    for (const stockId of [...requeridos.keys()].sort((a, b) => a - b)) {
      const grupo = requeridos.get(stockId);
      const saldo = await N.bloquearSaldoStock(t, ctx, caja.boca_id, stockId);
      const disponible = grupo.inactivo ? 0 : saldo;
      let pedido = 0;
      for (const linea of grupo.lineas) {
        linea.consumo = linea.rendimiento ? Porciones.consumo(U.redondear(disponible - pedido, 3), linea.rendimiento, linea.cantidad) : linea.cantidad;
        pedido = U.redondear(pedido + linea.consumo, 3);
      }
      if (pedido > disponible) faltantes.push({ producto_id: stockId, producto: grupo.producto, insumo: grupo.insumo, pedido, disponible });
    }
    if (faltantes.length) throw U.error(`No hay stock suficiente de «${faltantes[0].producto}» en esta boca`, 409, { codigo: "SIN_STOCK", faltantes });
    const total = U.redondear(lineas.reduce((s, l) => s + l.subtotal, 0), 2);
    if (total <= 0 && forma !== "EFECTIVO") throw U.error("El total de la venta tiene que ser mayor que cero");

    const partes = b.pagos === undefined ? [{ forma, importe: total, huesped_id: b.huesped_id || null }] : b.pagos;
    if (!Array.isArray(partes) || partes.length !== (forma === "MIXTO" ? 2 : 1)) throw U.error("Revisá los medios de pago.");
    const pagos = partes.map(p => {
      if (!p || !FORMAS.includes(p.forma) || p.forma === "MIXTO" || (partes.length === 1 && p.forma !== forma)) throw U.error("El medio de pago no es válido.");
      return { forma: p.forma, huesped_id: p.huesped_id || null, importe: U.numero(p.importe, { min: 0.01, max: 99999999, campo: "La parte del pago" }) };
    });
    if (new Set(pagos.map(p => p.forma)).size !== pagos.length) throw U.error("Elegí dos medios distintos.");
    const centavos = pagos.reduce((suma, p) => suma + Math.round(p.importe * 100), 0);
    if (centavos !== Math.round(total * 100)) throw U.error("Las partes del pago deben sumar el total de la venta.");
    const efectivo=pagos.find(p=>p.forma==="EFECTIVO")?.importe||0;
    let afiliado = null;
    let departamental = null;
    let saldoDisponible = null;
    if (afiliadoId) {
      afiliado = await N.exigir(t, ctx, "predio_afiliado", afiliadoId, "No encontramos al afiliado",{bloquear:true});
      if (afiliado.departamental_id) departamental = await N.obtener(t, ctx, "predio_departamental", afiliado.departamental_id);
      const disp = await disponibleAfiliado(t, ctx, afiliadoId);
      saldoDisponible = disp.disponible;
    }

    let recibido = null;
    let vuelto = null;
    if (efectivo) {
      recibido = b.recibido === undefined || b.recibido === null || b.recibido === "" ? efectivo : U.numero(b.recibido, { min: 0, max: 99999999, campo: "El efectivo recibido" });
      if (recibido < efectivo) throw U.error(`El efectivo recibido (${U.pesos(recibido)}) no alcanza para la parte en efectivo (${U.pesos(efectivo)})`);
      vuelto = U.redondear(recibido - efectivo, 2);
    }

    const ahora = U.fechaHora();
    const ventaId = await N.insertar(t, ctx, "predio_venta", {
      boca_id: caja.boca_id, caja_id: caja.id, turno_id: puesto.turno_id || null, usuario_id: ctx.usuario.id,
      usuario_nombre: N.nombreActor(ctx), fecha: ahora, afiliado_id: afiliado ? afiliado.id : null,
      afiliado_dni: afiliado?.dni || null, afiliado_legajo: afiliado?.legajo || null, afiliado_nombre: afiliado?.nombre || null,
      afiliado_departamental: departamental?.nombre || null, saldo_disponible: saldoDisponible,
      forma_pago: forma, codigo_pago: codigoPago, total, recibido, vuelto, estado: "CONFIRMADA", impresiones: 0,
      observaciones: U.texto(b.observaciones, { max: 255 }),
    });
    for (const p of pagos) {
      if(p.forma==="SALDO")await require("./recepcion").aplicarVenta(t,ctx,p.huesped_id,p.importe,ventaId);
      await N.insertar(t,ctx,"predio_venta_pago",{venta_id:ventaId,forma:p.forma,importe:p.importe,huesped_id:p.forma==="SALDO"?p.huesped_id:null});
    }
    for (const l of lineas) {
      await N.insertar(t, ctx, "predio_venta_item", {
        venta_id: ventaId, producto_id: l.producto.id, descripcion: l.producto.nombre, codigo: l.producto.codigo,
        cantidad: l.cantidad, precio_unitario: l.precio, subtotal: l.subtotal, destino: l.producto.destino,
      });
      if (l.producto.destino !== "ALQUILER") {
        await N.moverStock(t, ctx, {
          bocaId: caja.boca_id, productoId: l.stockId, cantidad: -l.consumo, tipo: "VENTA",
          referenciaTipo: "venta", referenciaId: ventaId, motivo: l.stockId !== l.producto.id ? "CONSUMO_ESTIMADO" : null,
          detalle: l.stockId !== l.producto.id ? `Venta N° ${ventaId} · ${l.cantidad} × ${l.producto.nombre} (consumo estimado)` : `Venta N° ${ventaId}`,
        });
      }
    }
    if (efectivo > 0) {
      await N.insertar(t, ctx, "predio_caja_movimiento", {
        caja_id: caja.id, boca_id: caja.boca_id, fecha: ahora, concepto: "VENTA", tipo: "INGRESO", importe: efectivo,
        observaciones: `Venta N° ${ventaId}`, venta_id: ventaId, turno_id: puesto.turno_id || null,
        usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      });
    }
    const respuesta = { id: ventaId, total, vuelto, mensaje: `Venta N° ${ventaId} registrada` };
    if (recibo) await N.insertar(t, ctx, "predio_recepcion_recibo", { ...recibo, respuesta: JSON.stringify(respuesta) });
    return { ...respuesta, ticket: await datosTicket(t, ctx, ventaId) };
  });
}

async function verVenta(ctx) {
  const id = U.id(ctx.params.id);
  const datos = await datosTicket(ctx.db, ctx, id);
  if (!puedeVerVenta(ctx, datos.venta)) throw U.error("No tenés acceso a esta venta", 403);
  if (datos.venta.estado === "CONFIRMADA") {
    datos.venta.solicitud_anulacion = await solicitudPendiente(ctx.db, ctx, id) || null;
  }
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

function solicitudPendiente(t, ctx, id, bloquear = false) {
  return t.get(`SELECT id, usuario_nombre, detalle, fecha_solicitud FROM predio_permiso
    WHERE predio_id=? AND tipo='ANULAR_VENTA' AND referencia_id=? AND estado='PENDIENTE'
    ORDER BY id DESC LIMIT 1${bloquear ? t.forUpdate : ""}`, [ctx.pid, id]);
}

async function ventaParaAnulacion(t, ctx, id, directa = false) {
  // El cierre y la anulación deben ver el resultado de la operación que tomó la caja primero.
  if (t.forUpdate) await t.get(`SELECT id FROM predio_caja WHERE predio_id=? AND id=(
    SELECT caja_id FROM predio_venta WHERE predio_id=? AND id=?)${t.forUpdate}`, [ctx.pid, ctx.pid, id]);
  const v = await N.exigir(t, ctx, "predio_venta", id, "No encontramos la venta", { bloquear: true });
  if (!esAdmin(ctx)) {
    exigirBoca(ctx, v.boca_id);
    if (!directa || !esSupervisor(ctx)) {
      if (Number(v.caja_id) !== Number(ctx.sesion?.caja_id)) throw U.error("Sólo podés anular ventas de la caja en la que estás trabajando", 403);
      await verificarOperador(t, ctx, v.caja_id);
    }
  }
  if (v.estado === "ANULADA") throw U.error("La venta ya está anulada", 409);
  if (v.liquidacion_id) throw U.error("La venta ya está incluida en una liquidación del afiliado: anulá primero la liquidación", 409);
  const cierre = await require("./caja").ultimoCierre(t, ctx.pid, v.caja_id);
  if (cierre && (cierre.ultima_venta_id !== undefined ? Number(id) <= cierre.ultima_venta_id : cierre.fecha >= v.fecha)) {
    throw U.error(`La caja se cerró después de esta venta (cierre N° ${cierre.id}): ya no se puede anular`, 409);
  }
  return v;
}

async function solicitarAnulacion(ctx, ventaId, detalle) {
  const motivo = U.texto(detalle, { max: 255, campo: "El motivo de la anulación", requerido: true });
  return ctx.db.tx(async t => {
    const v = await ventaParaAnulacion(t, ctx, ventaId);
    const abierta = await solicitudPendiente(t, ctx, v.id, true);
    if (abierta) return { id: abierta.id, mensaje: "La venta ya está pendiente de anulación." };
    const saldos = await t.all("SELECT huesped_id FROM predio_venta_pago WHERE predio_id=? AND venta_id=? AND forma='SALDO' ORDER BY huesped_id", [ctx.pid, v.id]);
    for (const pago of saldos) await require("./recepcion").huespedParaDevolucion(t, ctx, pago.huesped_id, v.id);
    const id = await N.insertar(t, ctx, "predio_permiso", {
      tipo: "ANULAR_VENTA", estado: "PENDIENTE", referencia_id: v.id, detalle: motivo,
      boca_id: v.boca_id, caja_id: v.caja_id, usuario_id: ctx.usuario.id,
      usuario_nombre: N.nombreActor(ctx), fecha_solicitud: U.fechaHora(),
    });
    await N.auditar(t, ctx, "Solicitud de anulación de venta", "venta", v.id, { permiso_id: id, motivo });
    return { id, mensaje: `El administrador recibió el pedido de anulación de la venta N° ${v.id}.` };
  });
}

async function anularVenta(ctx, permiso = null) {
  if (!esAdmin(ctx) && !Number(ctx.usuario.puede_anular_ticket)) {
    throw U.error("Pedí la anulación del ticket para que la confirme el administrador.", 403);
  }
  const id = permiso ? permiso.referencia_id : U.id(ctx.params.id);
  return ctx.db.tx(async t => {
    const v = await ventaParaAnulacion(t, ctx, id, true);
    const solicitudId = permiso?.id || ctx.body.solicitud_id;
    if (solicitudId) {
      const actual = await N.exigir(t, ctx, "predio_permiso", U.id(solicitudId), "No encontramos el pedido", { bloquear: true });
      if (actual.tipo !== "ANULAR_VENTA" || Number(actual.referencia_id) !== Number(id)) throw U.error("El pedido no corresponde a esta venta", 409);
      if (actual.estado !== "PENDIENTE") throw U.error("Ese pedido ya fue resuelto", 409);
    }
    const motivo = U.texto(permiso ? permiso.detalle || `Solicitud N° ${permiso.id}` : ctx.body.motivo,
      { max: 255, campo: "El motivo de la anulación", requerido: true });
    const metodo = puedeGestionarCajas(ctx) ? ctx.usuario.rol : "DELEGADO";
    // Las porciones pueden cambiar de rendimiento después de cobrarse. El kardex
    // conserva tanto el insumo como la cantidad exacta que salió en esa venta.
    const movimientos = await t.all(`SELECT producto_id, cantidad FROM predio_movimiento
      WHERE predio_id = ? AND boca_id = ? AND referencia_tipo = 'venta' AND referencia_id = ? AND tipo = 'VENTA' ORDER BY producto_id,id`, [ctx.pid, v.boca_id, id]);
    for (const mov of movimientos) {
      await N.moverStock(t, ctx, {
        bocaId: v.boca_id, productoId: mov.producto_id, cantidad: -Number(mov.cantidad), tipo: "ANULACION_VENTA",
        referenciaTipo: "venta", referenciaId: id, detalle: `Anulación de la venta N° ${id}`,
      });
    }
    const pagos = await t.all("SELECT * FROM predio_venta_pago WHERE predio_id=? AND venta_id=?", [ctx.pid, id]);
    const efectivo = pagos.length ? Number(pagos.find(p => p.forma === "EFECTIVO")?.importe || 0) : (v.forma_pago === "EFECTIVO" ? Number(v.total) : 0);
    for (const p of pagos) {
      if (p.forma === "SALDO") await require("./recepcion").aplicarVenta(t, ctx, p.huesped_id, Number(p.importe), id, true);
    }
    const fecha = U.fechaHora();
    if (efectivo > 0) {
      await N.insertar(t, ctx, "predio_caja_movimiento", {
        caja_id: v.caja_id, boca_id: v.boca_id, fecha, concepto: "ANULACION_VENTA", tipo: "EGRESO", importe: efectivo,
        observaciones: `Anulación de la venta N° ${id}`, venta_id: id, turno_id: turnoDeCaja(ctx, v.caja_id),
        usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      });
    }
    await N.actualizar(t, ctx, "predio_venta", id, {
      estado: "ANULADA", anulada_fecha: fecha, anulada_por: N.nombreActor(ctx), anulacion_motivo: motivo, anulacion_autorizacion: metodo,
    });
    await t.run(`UPDATE predio_permiso SET estado='USADO', resuelto_por=?, resuelto_fecha=?, usado_fecha=?, metodo=?
      WHERE predio_id=? AND tipo='ANULAR_VENTA' AND referencia_id=? AND estado='PENDIENTE'`,
    [N.nombreActor(ctx), fecha, fecha, metodo, ctx.pid, id]);
    await N.auditar(t, ctx, "Anulación de venta", "venta", id, { motivo, total: Number(v.total), forma_pago: v.forma_pago, autorizacion: metodo });
    return { id, mensaje: `Venta N° ${id} anulada`, devolver_efectivo: efectivo };
  });
}

// Permite a un cajero ver todas las ventas de su caja (con autorización) durante un rato.
async function habilitarVerCaja(ctx) {
  const puesto = exigirPuesto(ctx);
  if (puedeGestionarCajas(ctx)) {
    exigirBoca(ctx, puesto.boca_id);
    return { ok: true };
  }
  return ctx.db.tx(async (t) => {
    const r = await autorizar(t, ctx, "VER_VENTAS_CAJA", { permisoId: ctx.body.permiso_id, referenciaId: ctx.sesion.caja_id });
    return { ok: true, permiso_id: r.permisoId };
  });
}

module.exports = {
  datosTicket,
  solicitarAnulacion,
  anularVenta,
  rutas: [
    { m: "POST", p: "/ventas/avisar-sin-stock", h: avisarSinStock, escritura: true, soloLocal: true },
    { m: "POST", p: "/ventas", h: crearVenta, escritura: true, soloLocal: true },
    { m: "GET", p: "/ventas/:id", h: verVenta },
    { m: "POST", p: "/ventas/:id/impresion", h: registrarImpresion, escritura: true },
    { m: "POST", p: "/ventas/:id/anular", h: anularVenta, escritura: true },
    { m: "POST", p: "/ventas/ver-caja", h: habilitarVerCaja, escritura: true, soloLocal: true },
  ],
};
