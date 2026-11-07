"use strict";

// Contable del predio: recibos y notas de crédito de la recepción (ver lib/comprobantes.js).
// - GET  /contable/comprobantes/:id               detalle con renglones, devoluciones, caja e historial
// - POST /contable/comprobantes/:id/nota-credito  devolución total o parcial de un recibo
// - POST /contable/comprobantes/:id/anular        recibo: nota de crédito por lo que quedaba vigente y queda ANULADO;
//                                                 nota de crédito: revierte la devolución y queda ANULADA
// La lista es el listado «comprobantes» (lib/listados.js). Todo queda en la auditoría del predio.
//
// Qué mueve una nota de crédito en la cuenta de la estadía, según el renglón del recibo:
// - alojamiento y artículos: el pago vuelve atrás y la reserva queda debiendo ese importe hasta que se corrija
//   la reserva (si ya se corrigió, la devolución salda la diferencia a favor);
// - saldo para consumos: se descuenta del saldo de la persona (tiene que tenerlo disponible);
// - consumos ya liquidados: se toma como un descuento sobre lo consumido y no vuelve a generar deuda.

const U = require("../util");
const N = require("../negocio");
const C = require("../comprobantes");

// recepcion.js usa este módulo para anular pagos de artículos con recibo: se carga al usarlo.
const R = () => require("./recepcion");

function breve(fila) {
  return { id: Number(fila.id), tipo: fila.tipo, numero: Number(fila.numero), codigo: C.codigo(fila.tipo, fila.numero), fecha: fila.fecha,
    total: U.redondear(fila.total), estado: fila.estado, medio: fila.medio || null, motivo: fila.motivo || null, usuario_nombre: fila.usuario_nombre || null };
}

async function bloquearPersonas(t, ctx, reservaId) {
  return t.all("SELECT * FROM predio_huesped WHERE predio_id=? AND reserva_id=? ORDER BY id" + t.forUpdate, [ctx.pid, reservaId]);
}

/**
 * Nota de crédito sobre renglones del recibo `fila`. pedidos: [{ movimiento_id, importe (null = todo lo que queda) }].
 * Devuelve el comprobante emitido. También la usa recepcion.js al anular el pago de un artículo con recibo.
 */
async function devolverRenglones(t, ctx, fila, pedidos, { medio, motivo, cuerpo = {}, operacion = "NOTA_CREDITO" }) {
  const recibo = C.leer(fila);
  if (recibo.tipo !== "RECIBO") throw U.error("Las notas de crédito se emiten sobre un recibo.", 409);
  if (recibo.estado !== "EMITIDO") throw U.error("El recibo " + recibo.codigo + " está anulado.", 409);
  U.opcion(medio, C.MEDIOS, "El medio de la devolución");
  if (!motivo) throw U.error("Indicá el motivo de la nota de crédito.");
  const { porRenglon } = await C.devoluciones(t, ctx, recibo.id, true);
  const renglones = C.disponibles(recibo, porRenglon);
  const elegidos = [];
  for (const p of pedidos) {
    const l = renglones.find(x => Number(x.movimiento_id) === Number(p && p.movimiento_id));
    if (!l) throw U.error("Ese renglón no está en el recibo " + recibo.codigo + ".", 404);
    const importe = p.importe == null ? l.disponible : U.numero(p.importe, { min: 0, max: 99999999, campo: "El importe a devolver de " + l.texto });
    if (!(importe > 0)) continue;
    if (importe > l.disponible + 0.001) throw U.error("El importe a devolver de " + l.texto + " supera lo que queda del recibo (" + U.pesos(l.disponible) + ").");
    elegidos.push({ l, importe: U.redondear(Math.min(importe, l.disponible)) });
  }
  if (!elegidos.length) throw U.error(renglones.some(l => l.disponible > 0) ? "Indicá cuánto se devuelve." : "Ya se devolvió todo lo de este recibo.");
  const reservaId = Number(recibo.estadia.reserva_id);
  const total = U.redondear(elegidos.reduce((s, x) => s + x.importe, 0));
  const personas = await bloquearPersonas(t, ctx, reservaId);
  const saldo = new Map(personas.map(p => [Number(p.id), Number(p.saldo)]));
  for (const { l, importe } of elegidos) {
    if (l.rubro !== "SALDO") continue;
    const disponible = saldo.get(Number(l.huesped_id));
    if (disponible === undefined || disponible + 0.001 < importe) {
      throw U.error("El saldo para consumos de " + (l.detalle || "esa persona") + " ya no alcanza para devolver " + U.pesos(importe) +
        " (se usó en compras o se liquidó al salir). Disponible: " + U.pesos(Math.max(0, disponible || 0)) + ".", 409);
    }
    saldo.set(Number(l.huesped_id), U.redondear(disponible - importe));
  }
  const cajaMov = medio === "EFECTIVO" ? await R().caja(t, ctx, cuerpo, -total, reservaId, "NOTA_CREDITO") : null;
  const nota = "Nota de crédito sobre " + recibo.codigo;
  const origenes = new Map(), movimientos = [];
  for (const { l, importe } of elegidos) {
    let movId;
    if (l.rubro === "ALOJAMIENTO") {
      movId = await R().movimiento(t, ctx, reservaId, "PAGO_RESERVA", -importe, medio, nota, l.huesped_id);
    } else if (l.rubro === "ARTICULO") {
      // La devolución completa marca el pago como anulado (la ficha deja de ofrecer «Anular pago»).
      movId = await R().movimiento(t, ctx, reservaId, "PAGO_ADICIONAL", -importe, medio, l.texto + " · " + nota, null, null, null,
        { adicional_id: l.adicional_id, anula_mov_id: importe >= l.disponible - 0.001 ? l.movimiento_id : null });
    } else if (l.rubro === "SALDO") {
      await N.actualizar(t, ctx, "predio_huesped", l.huesped_id, { saldo: saldo.get(Number(l.huesped_id)) });
      movId = await R().movimiento(t, ctx, reservaId, "RETIRO", -importe, medio, nota, l.huesped_id);
    } else {
      movId = await R().movimiento(t, ctx, reservaId, "NC_CONSUMOS", -importe, medio, nota, l.huesped_id);
    }
    origenes.set(Number(movId), Number(l.movimiento_id));
    movimientos.push(movId);
  }
  return C.emitir(t, ctx, { instantanea: { cliente: recibo.cliente, estadia: recibo.estadia }, movimientos, medio, operacion, motivo,
    origen: fila, origenes, cajaMovimiento: cajaMov });
}

async function anularRecibo(t, ctx, fila, { medio, motivo, cuerpo }) {
  const recibo = C.leer(fila);
  if (recibo.estado !== "EMITIDO") throw U.error("El recibo " + recibo.codigo + " ya está anulado.", 409);
  const { notas, porRenglon } = await C.devoluciones(t, ctx, recibo.id, true);
  const quedan = C.disponibles(recibo, porRenglon).filter(l => l.disponible > 0);
  if (!quedan.length) {
    const vigentes = notas.filter(n => n.estado === "EMITIDO").map(n => C.codigo(n.tipo, n.numero));
    throw U.error("Este recibo ya se devolvió completo" + (vigentes.length ? " con " + vigentes.join(", ") : "") + ": no hace falta anularlo.", 409);
  }
  const nc = await devolverRenglones(t, ctx, fila, quedan.map(l => ({ movimiento_id: l.movimiento_id, importe: null })),
    { medio, motivo, cuerpo, operacion: "ANULACION" });
  await N.actualizar(t, ctx, "predio_comprobante", recibo.id, {
    estado: "ANULADO", anulado_fecha: U.fechaHora(), anulado_por: N.nombreActor(ctx), anulado_motivo: motivo, anulado_nc_id: nc.id
  });
  await N.auditar(t, ctx, "Recibo anulado", "comprobante", recibo.id, { codigo: recibo.codigo, motivo, nota_credito: nc.codigo, devuelto: nc.total, medio });
  return nc;
}

// Devoluciones hechas al liquidar o al salir: cerraron la cuenta y no se revierten desde acá.
const NO_REVERSIBLES = ["SALDAR_CONSUMOS", "PAGO_SALIDA_CONSUMOS", "CIERRE_SALIDA", "TRASPASO_ALOJAMIENTO", "TRASPASO_CONSUMOS"];

async function anularNotaCredito(t, ctx, fila, { motivo, cuerpo }) {
  const nc = C.leer(fila);
  if (nc.estado !== "EMITIDO") throw U.error("La nota de crédito " + nc.codigo + " ya está anulada.", 409);
  const reservaId = Number(nc.estadia.reserva_id);
  const movs = await t.all("SELECT * FROM predio_estadia_mov WHERE predio_id=? AND reserva_id=? AND comprobante=? ORDER BY id" + t.forUpdate, [ctx.pid, reservaId, nc.id]);
  if (nc.operacion === "SALIDA" || movs.some(m => NO_REVERSIBLES.includes(m.concepto))) {
    throw U.error("Esta devolución se hizo al liquidar la estadía o una salida y cerró esa cuenta: no se anula. Si corresponde volver a cobrar, registralo como un cobro nuevo en la reserva.", 409);
  }
  const origen = nc.origen_id ? await t.get("SELECT * FROM predio_comprobante WHERE predio_id=? AND id=?" + t.forUpdate, [ctx.pid, nc.origen_id]) : null;
  if (origen && origen.estado === "ANULADO" && Number(origen.anulado_nc_id) !== nc.id) {
    throw U.error("El recibo " + C.codigo(origen.tipo, origen.numero) + " está anulado. Para volver atrás, anulá primero la nota de crédito de esa anulación (" +
      C.codigo("NOTA_CREDITO", (await N.obtener(t, ctx, "predio_comprobante", origen.anulado_nc_id))?.numero || 0) + ").", 409);
  }
  const personas = await bloquearPersonas(t, ctx, reservaId);
  const cajaMov = nc.medio === "EFECTIVO" ? await R().caja(t, ctx, cuerpo, nc.total, reservaId, "NOTA_CREDITO") : null;
  const nota = "Anula la nota de crédito " + nc.codigo;
  for (const m of movs) {
    const importe = -Number(m.importe);
    let movId;
    if (m.concepto === "RETIRO") {
      const p = personas.find(x => Number(x.id) === Number(m.huesped_id));
      if (p) {
        p.saldo = U.redondear(Number(p.saldo) + importe);
        await N.actualizar(t, ctx, "predio_huesped", p.id, { saldo: p.saldo });
      }
      movId = await R().movimiento(t, ctx, reservaId, "CARGA", importe, m.medio, nota, m.huesped_id);
    } else {
      // El reintegro de un artículo apunta al movimiento que revierte: no se ofrece ni se acepta como un pago nuevo.
      movId = await R().movimiento(t, ctx, reservaId, m.concepto, importe, m.medio, (m.concepto === "PAGO_ADICIONAL" ? String(m.detalle || "").split(" · ")[0] + " · " : "") + nota,
        m.huesped_id, null, null, m.concepto === "PAGO_ADICIONAL" ? { adicional_id: m.adicional_id, anula_mov_id: m.id } : {});
    }
    await N.actualizar(t, ctx, "predio_estadia_mov", movId, { comprobante: nc.id });
  }
  if (cajaMov) await N.actualizar(t, ctx, "predio_caja_movimiento", cajaMov, { recibo: ("Anula " + nc.codigo).slice(0, 40) });
  await N.actualizar(t, ctx, "predio_comprobante", nc.id, { estado: "ANULADO", anulado_fecha: U.fechaHora(), anulado_por: N.nombreActor(ctx), anulado_motivo: motivo });
  await N.auditar(t, ctx, "Nota de crédito anulada", "comprobante", nc.id, { codigo: nc.codigo, motivo, reintegrado: nc.total, medio: nc.medio });
  if (origen && origen.estado === "ANULADO" && Number(origen.anulado_nc_id) === nc.id) {
    await N.actualizar(t, ctx, "predio_comprobante", origen.id, { estado: "EMITIDO", anulado_fecha: null, anulado_por: null, anulado_motivo: null, anulado_nc_id: null });
    await N.auditar(t, ctx, "Recibo vigente otra vez", "comprobante", origen.id, { codigo: C.codigo(origen.tipo, origen.numero), motivo, nota_credito_anulada: nc.codigo });
  }
  return nc;
}

// Escrituras idempotentes: el mismo `operacion` devuelve la misma respuesta (reintentos y órdenes remotas).
async function operar(ctx, tipo, fn) {
  const b = ctx.body, id = U.id(ctx.params.id, "El comprobante");
  return ctx.db.tx(async t => {
    const key = String(b.operacion || "");
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(key)) throw U.error("Identificador de operación inválido.");
    const huella = U.sha256(JSON.stringify([ctx.usuario.id, id, tipo, b]));
    const previo = await t.get("SELECT huella,respuesta FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, key]);
    if (previo) {
      if (previo.huella !== huella) throw U.error("Identificador ya utilizado para otra operación.", 409);
      return JSON.parse(previo.respuesta);
    }
    const fila = await t.get("SELECT * FROM predio_comprobante WHERE predio_id=? AND id=?" + t.forUpdate, [ctx.pid, id]);
    if (!fila) throw U.error("No encontramos ese comprobante.", 404);
    const motivo = U.texto(b.motivo, { max: 200, requerido: true, campo: "El motivo" });
    const respuesta = await fn(t, fila, motivo);
    await N.insertar(t, ctx, "predio_recepcion_recibo", { clave: key, huella, respuesta: JSON.stringify(respuesta) });
    return respuesta;
  });
}

async function respuestaCon(t, ctx, mensaje, emitido) {
  return { mensaje, comprobante: R().resumen(emitido), datos: emitido ? C.leer(await N.obtener(t, ctx, "predio_comprobante", emitido.id)) : null };
}

function notaCredito(ctx) {
  return operar(ctx, "nota-credito", async (t, fila, motivo) => {
    const b = ctx.body;
    if (!Array.isArray(b.renglones) || !b.renglones.length) throw U.error("Indicá qué renglones del recibo se devuelven.");
    const nc = await devolverRenglones(t, ctx, fila, b.renglones, { medio: b.medio, motivo, cuerpo: b });
    return respuestaCon(t, ctx, "Nota de crédito " + nc.codigo + " emitida por " + U.pesos(nc.total), nc);
  });
}

function anular(ctx) {
  return operar(ctx, "anular", async (t, fila, motivo) => {
    if (fila.tipo === "RECIBO") {
      const nc = await anularRecibo(t, ctx, fila, { medio: ctx.body.medio, motivo, cuerpo: ctx.body });
      return respuestaCon(t, ctx, "Recibo " + C.codigo(fila.tipo, fila.numero) + " anulado · Nota de crédito " + nc.codigo + " por " + U.pesos(nc.total), nc);
    }
    const nc = await anularNotaCredito(t, ctx, fila, { motivo, cuerpo: ctx.body });
    return respuestaCon(t, ctx, "Nota de crédito " + nc.codigo + " anulada: se registró el reintegro de " + U.pesos(nc.total), null);
  });
}

async function detalle(ctx) {
  R().permiso(ctx);
  const fila = await N.exigir(ctx.db, ctx, "predio_comprobante", U.id(ctx.params.id, "El comprobante"), "No encontramos ese comprobante");
  const c = C.leer(fila);
  if (c.tipo === "RECIBO") {
    const { notas, porRenglon } = await C.devoluciones(ctx.db, ctx, c.id);
    c.renglones = C.disponibles(c, porRenglon);
    c.notas_credito = notas.map(breve);
    c.disponible = U.redondear(c.renglones.reduce((s, l) => s + l.disponible, 0));
    c.devuelto = U.redondear(c.renglones.reduce((s, l) => s + l.devuelto, 0));
  }
  if (c.origen_id) {
    const o = await N.obtener(ctx.db, ctx, "predio_comprobante", c.origen_id);
    c.origen_actual = o ? breve(o) : null;
  }
  if (c.anulacion?.nota_credito_id) {
    const n = await N.obtener(ctx.db, ctx, "predio_comprobante", c.anulacion.nota_credito_id);
    c.anulacion.nota_credito = n ? breve(n) : null;
  }
  const movs = await ctx.db.all("SELECT concepto FROM predio_estadia_mov WHERE predio_id=? AND comprobante=?", [ctx.pid, c.id]);
  c.puede_anular = c.estado === "EMITIDO" && (c.tipo === "RECIBO" ? c.disponible > 0
    : c.operacion !== "SALIDA" && !movs.some(m => NO_REVERSIBLES.includes(m.concepto)));
  c.puede_nota_credito = c.tipo === "RECIBO" && c.estado === "EMITIDO" && c.disponible > 0;
  c.caja = await ctx.db.all(`SELECT m.fecha, m.tipo, m.importe, m.recibo, cj.nombre AS caja, b.nombre AS boca FROM predio_caja_movimiento m
    JOIN predio_caja cj ON cj.predio_id=m.predio_id AND cj.id=m.caja_id LEFT JOIN predio_boca b ON b.predio_id=m.predio_id AND b.id=m.boca_id WHERE m.predio_id=? AND (m.recibo=? OR m.recibo=?) ORDER BY m.id`,
  [ctx.pid, c.codigo, ("Anula " + c.codigo).slice(0, 40)]);
  c.historial = (await ctx.db.all("SELECT fecha, usuario_nombre, accion, detalle, origen FROM predio_auditoria WHERE predio_id=? AND entidad='comprobante' AND entidad_id=? ORDER BY id",
    [ctx.pid, c.id])).map(h => {
    let d = null;
    try { d = JSON.parse(h.detalle || "null"); } catch (_e) { d = null; }
    return { fecha: h.fecha, usuario_nombre: h.usuario_nombre, accion: h.accion, detalle: d, origen: h.origen };
  });
  return c;
}

const rutas = [
  { m: "GET", p: "/contable/comprobantes/:id", h: detalle },
  { m: "POST", p: "/contable/comprobantes/:id/nota-credito", escritura: true, roles: ["ADMIN"], h: notaCredito },
  { m: "POST", p: "/contable/comprobantes/:id/anular", escritura: true, roles: ["ADMIN"], h: anular },
];

module.exports = { rutas, devolverRenglones, anularRecibo, anularNotaCredito };
