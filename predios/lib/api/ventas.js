"use strict";

// Ventas en las cajas de cada boca. El precio sale siempre del producto (el servidor manda),
// el efectivo genera movimiento de caja y el saldo se descuenta de la cuenta de la estadía.

const U = require("../util");
const { verificarOperador } = require("../turnos-caja");
const N = require("../negocio");
const { productoEnBoca, bloquearPrecios } = require("../precio-boca");
const { emitirAviso } = require("../avisos");
const { autorizacionDescuento } = require("../autorizacion-descuento");
const { FORMAS_PAGO } = require("../listados");
const { esAdmin, bocasDe, exigirPuesto, exigirBoca, autorizar, disponibleAfiliado, turnoDeCaja } = require("./comun");

const FORMAS = FORMAS_PAGO.map((f) => f.valor).filter(f => f !== "DESCUENTO");
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
      producto = await productoEnBoca(t, ctx, productoId, puesto.boca_id);
      if (!producto) throw U.error("No encontramos el producto", 404);
      if (!Number(producto.activo) || producto.destino === "USO_INTERNO") throw U.error("Este producto no se puede vender", 409, { codigo: "PRODUCTO_NO_VENDIBLE" });
      stock = await N.stockActual(t, ctx, puesto.boca_id, productoId);
      if (stock >= cantidad) throw U.error("El producto ya tiene stock suficiente. Volvé a buscarlo en la lista de ventas.", 409, { codigo: "STOCK_DISPONIBLE" });
    }
    const id = await avisarFaltante(t, ctx, { producto, busqueda, cantidad, stock });
    const config = await N.leerConfig(t, ctx);
    return { id, puede_vender: Number(producto?.precio_caja || 0) > 0 && config.vender_sin_stock !== "0", mensaje: "El aviso quedó registrado para el administrador. Si no hay internet, se enviará al sistema general al sincronizar." };
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
  // El aviso de falta de stock puede requerir un segundo envío confirmado.
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
    const config = await N.leerConfig(t, ctx);
    const lineas = [];
    const preciosCambiaron = [];
    const faltantes = [];
    const productos = new Map();
    const stocks = new Map();
    // Todas las cajas bloquean los productos en el mismo orden. Se conserva el
    // orden del carrito para el ticket y se evitan bloqueos cruzados entre cajas.
    for (const productoId of [...agrupados.keys()].sort((a, b) => a - b)) {
      const p = await productoEnBoca(t, ctx, productoId, caja.boca_id, { bloquear: true });
      if (!p) throw U.error("Uno de los productos no existe", 404);
      productos.set(productoId, p);
      if (p.destino !== "USO_INTERNO") stocks.set(productoId, await stockParaVenta(t, ctx, caja.boca_id, productoId));
    }
    for (const [productoId, cantidad] of agrupados) {
      const p = productos.get(productoId);
      if (!Number(p.activo)) throw U.error(`«${p.nombre}» está dado de baja`);
      if (p.destino === "USO_INTERNO") throw U.error(`«${p.nombre}» es de uso interno y no se vende`);
      const precio = Number(p.precio_caja);
      if (preciosEsperados.has(productoId) && preciosEsperados.get(productoId) !== precio)
        preciosCambiaron.push({ producto_id: productoId, precio_venta: precio });
      if (precio <= 0) throw U.error(`«${p.nombre}» no tiene precio de venta: pedile al administrador que lo cargue`, 409, { codigo: "SIN_PRECIO" });
      const stock = stocks.get(productoId);
      if (MOVEDORES_STOCK.includes(p.destino) ? stock < cantidad : stock <= 0) {
        faltantes.push({ producto_id: productoId, producto: p.nombre, pedido: cantidad, disponible: stock });
      }
      lineas.push({ producto: p, cantidad, precio, subtotal: U.redondear(precio * cantidad, 2) });
    }
    if (preciosCambiaron.length) throw U.error("Cambiaron precios del carrito. Revisá el total antes de cobrar.", 409,
      { codigo: "PRECIOS_CAMBIARON", precios: preciosCambiaron });
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
      if (MOVEDORES_STOCK.includes(l.producto.destino)) {
        await N.moverStock(t, ctx, {
          bocaId: caja.boca_id, productoId: l.producto.id, cantidad: -l.cantidad, tipo: "VENTA",
          referenciaTipo: "venta", referenciaId: ventaId, detalle: `Venta N° ${ventaId}`,
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
    if (faltantes.length) {
      await N.auditar(t, ctx, "Venta sin stock suficiente", "venta", ventaId, { faltantes, avisos_aceptados: [...avisosPrevios.values()].map((a) => a.id) });
      if (sinAviso.length) await avisarFaltante(t, ctx, { ventaId, faltantes: sinAviso });
    }
    for (const aviso of avisosPrevios.values()) {
      await N.actualizar(t, ctx, "predio_aviso", aviso.id, {
        detalle: JSON.stringify({ ...aviso.detalle, consumido_venta_id: ventaId, consumido_fecha: ahora }),
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

async function ventaParaAnulacion(t, ctx, id) {
  // El cierre y la anulación deben ver el resultado de la operación que tomó la caja primero.
  if (t.forUpdate) await t.get(`SELECT id FROM predio_caja WHERE predio_id=? AND id=(
    SELECT caja_id FROM predio_venta WHERE predio_id=? AND id=?)${t.forUpdate}`, [ctx.pid, ctx.pid, id]);
  const v = await N.exigir(t, ctx, "predio_venta", id, "No encontramos la venta", { bloquear: true });
  if (!esAdmin(ctx)) {
    exigirBoca(ctx, v.boca_id);
    if (Number(v.caja_id) !== Number(ctx.sesion?.caja_id)) throw U.error("Sólo podés anular ventas de la caja en la que estás trabajando", 403);
    await verificarOperador(t, ctx, v.caja_id);
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
    const v = await ventaParaAnulacion(t, ctx, id);
    const solicitudId = permiso?.id || ctx.body.solicitud_id;
    if (solicitudId) {
      const actual = await N.exigir(t, ctx, "predio_permiso", U.id(solicitudId), "No encontramos el pedido", { bloquear: true });
      if (actual.tipo !== "ANULAR_VENTA" || Number(actual.referencia_id) !== Number(id)) throw U.error("El pedido no corresponde a esta venta", 409);
      if (actual.estado !== "PENDIENTE") throw U.error("Ese pedido ya fue resuelto", 409);
    }
    const motivo = U.texto(permiso ? permiso.detalle || `Solicitud N° ${permiso.id}` : ctx.body.motivo,
      { max: 255, campo: "El motivo de la anulación", requerido: true });
    const metodo = esAdmin(ctx) ? "ADMIN" : "DELEGADO";
    const items = await t.all("SELECT * FROM predio_venta_item WHERE predio_id = ? AND venta_id = ? ORDER BY producto_id", [ctx.pid, id]);
    for (const it of items) {
      if (MOVEDORES_STOCK.includes(it.destino)) {
        await N.moverStock(t, ctx, {
          bocaId: v.boca_id, productoId: it.producto_id, cantidad: Number(it.cantidad), tipo: "ANULACION_VENTA",
          referenciaTipo: "venta", referenciaId: id, detalle: `Anulación de la venta N° ${id}`,
        });
      }
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
  exigirPuesto(ctx);
  if (esAdmin(ctx)) return { ok: true };
  return ctx.db.tx(async (t) => {
    const r = await autorizar(t, ctx, "VER_VENTAS_CAJA", { clave: ctx.body.clave, permisoId: ctx.body.permiso_id, referenciaId: ctx.sesion.caja_id });
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
