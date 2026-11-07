"use strict";

// Cobro de alquileres y compras de una reserva.
// Un cobro paga en el momento uno o varios artículos: deja un PAGO_ADICIONAL por artículo, un solo
// movimiento de caja por el efectivo y un recibo (lib/comprobantes.js) con un renglón por artículo.
// El recibo no es fiscal; se reimprime, se anula o se corrige con una nota de crédito desde Contable.

const U = require("../util");
const N = require("../negocio");
const C = require("../comprobantes");
const { permiso, turismo, cuenta, estadoAdicionales, movimiento, caja, resumen } = require("./recepcion");

const MEDIOS = ["EFECTIVO", "TRANSFERENCIA"];
const MAX_ITEMS = 60;

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
    const cajaMov = medio === "EFECTIVO" ? await caja(t, ctx, b, total, id, "ADICIONAL_ESTADIA") : null;
    const movimientos = [];
    for (const x of items) {
      movimientos.push(await movimiento(t, ctx, id, "PAGO_ADICIONAL", x.importe, medio, [x.linea.nombre, nota].filter(Boolean).join(" · "), null, null, null,
        { adicional_id: Number(x.linea.adicional_id) }));
    }
    const comprobante = await C.emitir(t, ctx, { reserva: r, movimientos, medio, operacion: "ARTICULOS", observacion: nota, cajaMovimiento: cajaMov });
    const respuesta = {
      mensaje: (items.length === 1 ? "Pago de " + items[0].linea.nombre + " registrado" : "Cobro de " + items.length + " artículos registrado") + " · Recibo " + comprobante.codigo,
      comprobante: resumen(comprobante),
      total,
      datos: C.leer(await N.obtener(t, ctx, "predio_comprobante", comprobante.id))
    };
    await N.insertar(t, ctx, "predio_recepcion_recibo", { clave: key, huella, respuesta: JSON.stringify(respuesta) });
    return respuesta;
  });
}

const rutas = [{
  m: "POST",
  p: "/recepcion/:id/articulos/cobrar",
  escritura: true,
  h: cobrar
}];

module.exports = { rutas };
