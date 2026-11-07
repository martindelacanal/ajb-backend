"use strict";

// Cobro y comprobantes de alquileres y compras de una reserva.
// Un cobro paga en el momento uno o varios artículos: deja un PAGO_ADICIONAL por artículo, todos con
// el mismo número de comprobante (el id del primero), y un solo movimiento de caja por el efectivo.
// Un pago anterior a los comprobantes (sin número) se reimprime con su propio id como número.
// El comprobante no es fiscal: el predio no factura ante AFIP.

const U = require("../util");
const N = require("../negocio");
const { permiso, turismo, cuenta, estadoAdicionales, movimiento, caja, empresa } = require("./recepcion");

const MEDIOS = ["EFECTIVO", "TRANSFERENCIA"];
const MAX_ITEMS = 60;

// Sin `undefined`: la respuesta guardada para los reintentos tiene que ser idéntica a la original.
const nulo = v => v === undefined || v === "" ? null : v;
const esPago = m =>m.concepto === "PAGO_ADICIONAL" && Number(m.importe) > 0 && !m.anula_mov_id;
const numeroDe = m => Number(m.comprobante || m.id);

function nombreRecursos(r) {
  return (r.recursos || []).map(x => x.nombre).filter(Boolean).join(", ") || r.recurso || null;
}
// El detalle de una anulación es «Anula el pago de <artículo> · motivo» (ver operarAdicional).
function motivoAnulacion(detalle, nombre) {
  const d = String(detalle || ""), prefijo = "Anula el pago de " + nombre;
  if (d === prefijo) return null;
  return d.indexOf(prefijo + " · ") === 0 ? d.slice(prefijo.length + 3) || null : d || null;
}

/** Datos para imprimir el comprobante `numero` de la reserva, con las anulaciones posteriores. */
function armarComprobante(r, a, numero, datosEmpresa) {
  const pagos = a.movimientos.filter(m => esPago(m) && numeroDe(m) === numero).sort((x, y) => Number(x.id) - Number(y.id));
  if (!pagos.length) throw U.error("No encontramos ese comprobante en la reserva.", 404);
  const anulaciones = new Map(a.movimientos.filter(m => m.anula_mov_id).map(m => [Number(m.anula_mov_id), m]));
  const lineas = new Map(estadoAdicionales(r, a).map(l => [Number(l.adicional_id), l]));
  let observacion = null;
  const items = pagos.map(m => {
    const l = lineas.get(Number(m.adicional_id));
    const detalle = String(m.detalle || "");
    // El detalle del movimiento es «artículo · observación».
    const nombre = l ? l.nombre : detalle.split(" · ")[0] || "Artículo";
    if (!observacion && detalle.indexOf(nombre + " · ") === 0) observacion = detalle.slice(nombre.length + 3) || null;
    const an = anulaciones.get(Number(m.id)) || null;
    return {
      movimiento_id: Number(m.id),
      adicional_id: Number(m.adicional_id),
      nombre,
      modalidad: nulo(l && l.modalidad),
      cantidad: nulo(l && l.cantidad),
      dias: nulo(l && l.dias),
      fecha_desde: nulo(l && l.fecha_desde),
      fecha_hasta: nulo(l && l.fecha_hasta),
      importe: U.redondear(m.importe),
      anulado: !!an,
      anulacion: an ? { fecha: an.fecha, usuario_nombre: nulo(an.usuario_nombre), motivo: motivoAnulacion(an.detalle, nombre) } : null
    };
  });
  const total = U.redondear(items.reduce((s, x) => s + x.importe, 0));
  const anulado = U.redondear(items.reduce((s, x) => s + (x.anulado ? x.importe : 0), 0));
  const primero = pagos[0];
  return {
    numero,
    fecha: primero.fecha,
    medio: primero.medio,
    empleado: nulo(primero.usuario_nombre),
    observacion,
    estado: !anulado ? "VIGENTE" : anulado >= total ? "ANULADO" : "ANULADO_PARCIAL",
    total,
    anulado,
    vigente: U.redondear(total - anulado),
    items,
    reserva: {
      id: r.id,
      titular_nombre: nulo(r.titular_nombre),
      titular_dni: nulo(r.titular_dni),
      servicio: nulo(r.servicio),
      recurso: nombreRecursos(r),
      fecha_inicio: nulo(r.fecha_inicio),
      fecha_fin: nulo(r.fecha_fin)
    },
    empresa: Object.fromEntries(Object.entries(datosEmpresa || {}).map(([k, v]) => [k, nulo(v)]))
  };
}

async function cobrar(ctx) {
  permiso(ctx);
  const b = ctx.body,
    id = U.id(ctx.params.id);
  return ctx.db.tx(async t => {
    const key = String(b.operacion || "");
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(key)) throw U.error("Identificador de operación inválido.");
    const huella = U.sha256(JSON.stringify([ctx.usuario.id, id, "cobro-articulos", b]));
    const previo = await t.get("SELECT huella,respuesta FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, key]);
    if (previo) {
      if (previo.huella !== huella) throw U.error("Identificador ya utilizado para otra operación.", 409);
      return JSON.parse(previo.respuesta);
    }
    const medio = U.opcion(b.medio, MEDIOS, "El medio");
    if (!Array.isArray(b.items) || !b.items.length) throw U.error("Elegí al menos un artículo para cobrar.");
    if (b.items.length > MAX_ITEMS) throw U.error("Son demasiados artículos para un solo cobro.");
    const nota = U.texto(b.detalle, { max: 180, campo: "La observación" });
    const { reserva: r } = await turismo(t, ctx, "detalle", { id });
    const a = await cuenta(t, ctx, id, true);
    const lineas = estadoAdicionales(r, a);
    const vistos = new Set();
    const items = b.items.map(x => {
      const adicionalId = U.id(x && x.adicional_id, "El artículo");
      if (vistos.has(adicionalId)) throw U.error("Un artículo figura dos veces en el cobro.");
      vistos.add(adicionalId);
      const linea = lineas.find(l => Number(l.adicional_id) === adicionalId);
      if (!linea) throw U.error("Ese artículo no está en la reserva.", 404);
      const n = U.numero(x.importe, { min: 0.01, max: 99999999, campo: "El importe de " + linea.nombre });
      if (n > linea.adeudado) throw U.error("El importe supera lo que falta pagar de " + linea.nombre + " (" + U.pesos(linea.adeudado) + ").");
      return { linea, importe: n };
    });
    const total = U.redondear(items.reduce((s, x) => s + x.importe, 0));
    if (medio === "EFECTIVO") await caja(t, ctx, b, total, id, "ADICIONAL_ESTADIA");
    let numero = null;
    for (const x of items) {
      const movId = await movimiento(t, ctx, id, "PAGO_ADICIONAL", x.importe, medio, [x.linea.nombre, nota].filter(Boolean).join(" · "), null, null, null,
        { adicional_id: Number(x.linea.adicional_id), comprobante: numero });
      if (numero === null) {
        numero = movId;
        await N.actualizar(t, ctx, "predio_estadia_mov", movId, { comprobante: movId });
      }
    }
    const datos = armarComprobante(r, await cuenta(t, ctx, id), numero, await empresa({ ...ctx, db: t }));
    const respuesta = {
      mensaje: (items.length === 1 ? "Pago de " + items[0].linea.nombre + " registrado" : "Cobro de " + items.length + " artículos registrado") + " · Comprobante N° " + numero,
      comprobante: numero,
      total,
      datos
    };
    await N.insertar(t, ctx, "predio_recepcion_recibo", { clave: key, huella, respuesta: JSON.stringify(respuesta) });
    return respuesta;
  });
}

async function verComprobante(ctx) {
  permiso(ctx);
  const id = U.id(ctx.params.id),
    numero = U.id(ctx.params.numero, "El número de comprobante");
  // Turismo confirma que la reserva es de este predio y que el usuario puede verla.
  const { reserva: r } = await turismo(ctx.db, ctx, "detalle", { id });
  const a = await cuenta(ctx.db, ctx, id);
  return armarComprobante(r, a, numero, await empresa(ctx));
}

const rutas = [{
  m: "POST",
  p: "/recepcion/:id/articulos/cobrar",
  escritura: true,
  h: cobrar
}, {
  m: "GET",
  p: "/recepcion/:id/articulos/comprobante/:numero",
  h: verComprobante
}];

module.exports = { rutas, armarComprobante };
