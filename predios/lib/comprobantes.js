"use strict";

// Comprobantes de la recepción del predio. No son fiscales: el predio no factura ante ARCA.
// - RECIBO: cada cobro en efectivo o transferencia de una reserva (diferencia de la reserva, artículos,
//   saldo para consumos y consumos al liquidar o al salir).
// - NOTA_CREDITO: cada devolución de dinero. Corrige un recibo (devolución total o parcial, o su anulación)
//   o documenta una devolución de la cuenta (diferencia a favor, saldo o anticipo no consumido).
// Numeración correlativa propia por predio y tipo. Cada comprobante guarda una instantánea (titular, estadía,
// renglones, emisor y saldo) para reimprimirse igual aunque la reserva cambie después. Los movimientos de la
// cuenta (`predio_estadia_mov.comprobante`) y de la caja (`predio_caja_movimiento.recibo`) quedan enlazados.
// Lo descuenta de haberes no lleva comprobante: su documento es la planilla de la liquidación.

const U = require("./util");
const N = require("./negocio");
const { resumirCuenta } = require("./cuenta-estadia");

const PREFIJO = { RECIBO: "R", NOTA_CREDITO: "NC" };
const NOMBRE = { RECIBO: "Recibo", NOTA_CREDITO: "Nota de crédito" };
const MEDIOS = ["EFECTIVO", "TRANSFERENCIA"];
const CLAVES_EMISOR = ["razon_social", "cuit", "iibb", "inicio_actividades", "condicion_iva", "domicilio_legal",
  "telefono", "correo", "nombre_predio", "direccion", "leyenda_comprobante"];

const nulo = v => v === undefined || v === "" ? null : v;
const numeroONulo = v => v === undefined || v === null || v === "" ? null : Number(v);
const codigo = (tipo, numero) => (PREFIJO[tipo] || "C") + "-" + String(numero).padStart(8, "0");

/** Qué parte de la estadía se cobra o devuelve con el movimiento. */
function rubro(concepto) {
  if (concepto === "PAGO_RESERVA") return "ALOJAMIENTO";
  if (concepto === "PAGO_ADICIONAL") return "ARTICULO";
  if (concepto === "CARGA" || concepto === "RETIRO") return "SALDO";
  return "CONSUMOS";
}

/** Texto y detalle del renglón según el movimiento y el sentido del dinero. */
function textoRenglon(m, personas, articulos) {
  const entra = Number(m.importe) > 0;
  const quien = personas.get(Number(m.huesped_id))?.nombre || null;
  const articulo = () => articulos.get(Number(m.adicional_id))?.nombre || String(m.detalle || "Artículo").split(" · ")[0];
  switch (m.concepto) {
    case "PAGO_RESERVA":
      return entra ? ["Alojamiento", quien ? "Salida de " + quien : "Diferencia de la reserva"] : ["Devolución de alojamiento", quien];
    case "PAGO_ADICIONAL":
      return entra ? [articulo(), null] : ["Devolución · " + articulo(), null];
    case "CARGA":
      return ["Saldo para consumos en el predio", quien];
    case "RETIRO":
      return ["Devolución de saldo para consumos", quien];
    case "SALDAR_CONSUMOS":
      return entra ? ["Consumos en el predio", null] : ["Devolución de anticipos no consumidos", null];
    case "PAGO_SALIDA_CONSUMOS":
      return entra ? ["Consumos en el predio", quien ? "Salida de " + quien : null] : ["Anticipo no consumido", quien];
    case "NC_CONSUMOS":
      return entra ? ["Reintegro de una devolución sobre consumos", quien] : ["Devolución sobre consumos", quien];
    default:
      return [m.concepto, quien];
  }
}

function nombresRecursos(r) {
  return (r.recursos || []).map(x => x.nombre).filter(Boolean).join(", ") || r.recurso || null;
}

/** Titular y estadía tal como estaban al emitir. */
function instantaneaReserva(r) {
  return {
    cliente: {
      nombre: nulo(r.titular_nombre), dni: nulo(r.titular_dni == null ? null : String(r.titular_dni)), legajo: nulo(r.titular_legajo),
      departamental: nulo(r.titular_departamental), domicilio: nulo(r.titular_direccion),
      afiliado: !!Number(r.afiliado), condicion_iva: "Consumidor final"
    },
    estadia: {
      reserva_id: Number(r.id), servicio: nulo(r.servicio), recurso: nombresRecursos(r), numero_parcela: nulo(r.numero_parcela),
      ubicacion: nulo(r.ubicacion), fecha_inicio: nulo(r.fecha_inicio), fecha_fin: nulo(r.fecha_fin),
      personas: (r.personas || []).length || null, total: r.precio_total == null ? null : U.redondear(r.precio_total),
      vehiculos: (r.vehiculos || []).map(v => ({ patente: v.patente, sector: nulo(v.sector) }))
    }
  };
}

async function cuentaDe(t, ctx, reservaId) {
  const personas = await t.all("SELECT * FROM predio_huesped WHERE predio_id=? AND reserva_id=? ORDER BY id", [ctx.pid, reservaId]);
  const movimientos = await t.all("SELECT * FROM predio_estadia_mov WHERE predio_id=? AND reserva_id=? ORDER BY id DESC", [ctx.pid, reservaId]);
  return resumirCuenta(personas, movimientos);
}

// La fila de secuencia funciona como cerrojo: dos cobros simultáneos no toman el mismo número,
// y el máximo se lee de los comprobantes reales (sirve igual si el escritor pasa de central a local).
async function siguienteNumero(t, ctx, tipo) {
  await t.run(`${t.insertIgnore} INTO predio_secuencia (predio_id, tabla, ultimo) VALUES (?, 'comprobantes', 0)`, [ctx.pid]);
  await t.get(`SELECT ultimo FROM predio_secuencia WHERE predio_id = ? AND tabla = 'comprobantes'${t.forUpdate}`, [ctx.pid]);
  const f = await t.get("SELECT MAX(numero) AS n FROM predio_comprobante WHERE predio_id = ? AND tipo = ?", [ctx.pid, tipo]);
  return Number(f?.n || 0) + 1;
}

/**
 * Emite el comprobante de los movimientos `movimientos` (ids) de la reserva. Cobro neto → recibo;
 * devolución neta → nota de crédito; sin dinero → null.
 * opciones: { reserva | instantanea, medio, operacion, observacion, motivo, origen (fila del recibo que corrige),
 *             origenes (Map id de movimiento nuevo → id del movimiento del recibo), cajaMovimiento (id) }
 */
async function emitir(t, ctx, opciones) {
  const { reserva: r = null, movimientos: ids = [], medio = null, operacion, observacion = null, motivo = null,
    origen = null, origenes = null, cajaMovimiento = null } = opciones;
  if (!ids.length) return null;
  const movs = await t.all(`SELECT * FROM predio_estadia_mov WHERE predio_id=? AND id IN (${t.lista(ids.length)}) ORDER BY id`, [ctx.pid, ...ids]);
  const total = U.redondear(movs.reduce((s, m) => s + Number(m.importe), 0));
  if (Math.abs(total) < 0.005) return null;
  const tipo = total > 0 ? "RECIBO" : "NOTA_CREDITO", signo = total > 0 ? 1 : -1;
  const base = opciones.instantanea || instantaneaReserva(r);
  const reservaId = Number(base.estadia.reserva_id);
  const personas = new Map((await t.all("SELECT id, nombre FROM predio_huesped WHERE predio_id=? AND reserva_id=?", [ctx.pid, reservaId])).map(p => [Number(p.id), p]));
  const articulos = new Map(((r && r.adicionales) || []).map(a => [Number(a.adicional_id), a]));
  const renglones = movs.map(m => {
    const [texto, detalle] = textoRenglon(m, personas, articulos);
    const a = m.concepto === "PAGO_ADICIONAL" ? articulos.get(Number(m.adicional_id)) : null;
    return {
      movimiento_id: Number(m.id), concepto: m.concepto, rubro: rubro(m.concepto), texto, detalle: nulo(detalle),
      importe: U.redondear(Number(m.importe) * signo), huesped_id: numeroONulo(m.huesped_id), adicional_id: numeroONulo(m.adicional_id),
      articulo: a ? { modalidad: nulo(a.modalidad), cantidad: numeroONulo(a.cantidad), dias: numeroONulo(a.dias), fecha_desde: nulo(a.fecha_desde), fecha_hasta: nulo(a.fecha_hasta) } : null,
      origen_mov_id: origenes && origenes.has(Number(m.id)) ? Number(origenes.get(Number(m.id))) : null
    };
  });
  const numero = await siguienteNumero(t, ctx, tipo);
  const config = await N.leerConfig(t, ctx);
  const a = await cuentaDe(t, ctx, reservaId);
  const datos = {
    cliente: base.cliente,
    estadia: base.estadia,
    emisor: Object.fromEntries(CLAVES_EMISOR.map(k => [k, nulo(config[k])])),
    renglones,
    observacion: nulo(observacion),
    origen: origen ? { id: Number(origen.id), tipo: origen.tipo, numero: Number(origen.numero), codigo: codigo(origen.tipo, origen.numero), fecha: origen.fecha, total: U.redondear(origen.total) } : null,
    saldo: { reserva: U.redondear(a.pendiente), consumos: U.redondear(a.neto_consumos), total: U.redondear(a.pendiente + a.neto_consumos) }
  };
  const id = await N.insertar(t, ctx, "predio_comprobante", {
    tipo, numero, fecha: U.fechaHora(), reserva_id: reservaId, origen_id: origen ? Number(origen.id) : null, operacion: operacion || null,
    medio: medio || null, total: Math.abs(total), titular: base.cliente.nombre ? String(base.cliente.nombre).slice(0, 160) : null,
    dni: base.cliente.dni ? String(base.cliente.dni).slice(0, 12) : null, estado: "EMITIDO", motivo: motivo ? String(motivo).slice(0, 255) : null,
    datos: JSON.stringify(datos), usuario_id: ctx.usuario?.id || null, usuario_nombre: N.nombreActor(ctx)
  });
  for (const m of movs) await N.actualizar(t, ctx, "predio_estadia_mov", m.id, { comprobante: id });
  const cod = codigo(tipo, numero);
  if (cajaMovimiento) await N.actualizar(t, ctx, "predio_caja_movimiento", cajaMovimiento, { recibo: cod });
  await N.auditar(t, ctx, tipo === "RECIBO" ? "Recibo emitido" : "Nota de crédito emitida", "comprobante", id, {
    codigo: cod, reserva: reservaId, total: Math.abs(total), medio: medio || null, operacion: operacion || null,
    corrige: origen ? codigo(origen.tipo, origen.numero) : null, motivo: motivo || null
  });
  // El historial del recibo también muestra cada devolución que se le hizo.
  if (origen) await N.auditar(t, ctx, "Devolución con nota de crédito", "comprobante", Number(origen.id), { nota_credito: cod, total: Math.abs(total), medio: medio || null, motivo: motivo || null });
  return { id, tipo, numero, codigo: cod, total: Math.abs(total) };
}

/** Comprobante listo para mostrar o imprimir (fila + instantánea). */
function leer(fila) {
  if (!fila) return null;
  let datos = {};
  try { datos = JSON.parse(fila.datos || "{}"); } catch (_e) { datos = {}; }
  return {
    ...datos,
    id: Number(fila.id), tipo: fila.tipo, nombre: NOMBRE[fila.tipo] || fila.tipo, numero: Number(fila.numero), codigo: codigo(fila.tipo, fila.numero),
    fecha: fila.fecha, reserva_id: numeroONulo(fila.reserva_id), origen_id: numeroONulo(fila.origen_id), operacion: nulo(fila.operacion),
    medio: nulo(fila.medio), total: U.redondear(fila.total), estado: fila.estado, motivo: nulo(fila.motivo), usuario_nombre: nulo(fila.usuario_nombre),
    anulacion: fila.estado === "ANULADO" ? { fecha: nulo(fila.anulado_fecha), por: nulo(fila.anulado_por), motivo: nulo(fila.anulado_motivo), nota_credito_id: numeroONulo(fila.anulado_nc_id) } : null
  };
}

/** Notas de crédito vigentes de un recibo y cuánto devolvió cada una por renglón (id de movimiento del recibo). */
async function devoluciones(t, ctx, reciboId, bloquear = false) {
  const notas = await t.all(`SELECT * FROM predio_comprobante WHERE predio_id=? AND origen_id=? AND tipo='NOTA_CREDITO' ORDER BY id${bloquear ? t.forUpdate : ""}`, [ctx.pid, reciboId]);
  const porRenglon = new Map();
  for (const nc of notas) {
    if (nc.estado !== "EMITIDO") continue;
    for (const l of leer(nc).renglones || []) {
      if (!l.origen_mov_id) continue;
      porRenglon.set(Number(l.origen_mov_id), U.redondear((porRenglon.get(Number(l.origen_mov_id)) || 0) + Number(l.importe)));
    }
  }
  return { notas, porRenglon };
}

/** Lo que todavía se puede devolver de cada renglón del recibo. */
function disponibles(recibo, porRenglon) {
  return (recibo.renglones || []).map(l => ({
    ...l,
    devuelto: porRenglon.get(Number(l.movimiento_id)) || 0,
    disponible: Math.max(0, U.redondear(Number(l.importe) - (porRenglon.get(Number(l.movimiento_id)) || 0)))
  }));
}

/** Para la ficha de la reserva: sus comprobantes, del más nuevo al más viejo. */
async function deReserva(db, ctx, reservaId) {
  const filas = await db.all("SELECT id, tipo, numero, fecha, origen_id, operacion, medio, total, estado, usuario_nombre FROM predio_comprobante WHERE predio_id=? AND reserva_id=? ORDER BY id DESC", [ctx.pid, reservaId]);
  const porId = new Map(filas.map(f => [Number(f.id), f]));
  return filas.map(f => ({
    id: Number(f.id), tipo: f.tipo, nombre: NOMBRE[f.tipo], numero: Number(f.numero), codigo: codigo(f.tipo, f.numero), fecha: f.fecha,
    operacion: nulo(f.operacion), medio: nulo(f.medio), total: U.redondear(f.total), estado: f.estado, usuario_nombre: nulo(f.usuario_nombre),
    corrige: f.origen_id && porId.has(Number(f.origen_id)) ? codigo(porId.get(Number(f.origen_id)).tipo, porId.get(Number(f.origen_id)).numero) : null
  }));
}

module.exports = { MEDIOS, NOMBRE, PREFIJO, codigo, rubro, emitir, leer, devoluciones, disponibles, deReserva, instantaneaReserva, cuentaDe };
