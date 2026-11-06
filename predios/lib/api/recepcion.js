"use strict";

const U = require("../util"),
  N = require("../negocio");
const {
  exigirPuesto,
  exigirBoca,
  turnoDeCaja
} = require("./comun");
function permiso(ctx) {
  if (ctx.usuario?.rol !== "ADMIN" && !Number(ctx.usuario?.gestionar_reservas)) throw U.error("Tu usuario no tiene permiso para gestionar reservas y estadías.", 403);
}
const importe = x => U.numero(x, {
  min: 0.01,
  max: 99999999,
  campo: "El importe"
});
async function movimiento(t, ctx, reserva, concepto, valor, medio, detalle, persona = null, venta = null, liquidacion = null) {
  return N.insertar(t, ctx, "predio_estadia_mov", {
    reserva_id: reserva,
    huesped_id: persona,
    venta_id: venta,
    liquidacion_id: liquidacion,
    fecha: U.fechaHora(),
    concepto,
    medio,
    importe: U.redondear(valor),
    detalle,
    usuario_id: ctx.usuario.id,
    usuario_nombre: N.nombreActor(ctx)
  });
}
async function turismo(t, ctx, accion, datos) {
  permiso(ctx);
  const s = ctx.servicios || {};
  if (s.recepcion) return s.recepcion(accion, datos, ctx.usuario, t);
  if (s.agente?.recepcion) return s.agente.recepcion(accion, datos, ctx.usuario);
  throw U.error("No hay conexión con el servicio de Turismo.", 503);
}
function esCierreDeSaldo(m) {
  // Anular una planilla reabre la deuda, pero no cancela las cargas posteriores.
  return m.concepto === "SALDAR_CONSUMOS" && !(m.medio === "HABERES" && Number(m.importe) < 0);
}
async function cuenta(t, ctx, id, lock = false) {
  const personas = await t.all("SELECT * FROM predio_huesped WHERE predio_id=? AND reserva_id=? ORDER BY id" + (lock ? t.forUpdate : ""), [ctx.pid, id]);
  const movimientos = await t.all("SELECT * FROM predio_estadia_mov WHERE predio_id=? AND reserva_id=? ORDER BY id DESC" + (lock ? t.forUpdate : ""), [ctx.pid, id]);
  let prepago = 0,
    consumos = 0,
    pendiente = 0;
  // Los movimientos vienen del más reciente al más antiguo. Cada cierre
  // cancela todo el crédito, incluidos los anticipos de ese período.
  const ultimoCierre = movimientos.find(esCierreDeSaldo);
  const desdeCierre = ultimoCierre ? Number(ultimoCierre.id) : 0;
  let huboOperacionDeSaldo = false;
  for (const m of movimientos) {
    const n = Number(m.importe);
    if (Number(m.id) > desdeCierre && ["CARGA", "RETIRO", "COMPRA", "ANULACION"].includes(m.concepto)) huboOperacionDeSaldo = true;
    if (["CARGA", "RETIRO"].includes(m.concepto) && m.medio !== "AL_SALIR") prepago += n;
    if (["COMPRA", "ANULACION"].includes(m.concepto)) consumos -= n;
    if (m.concepto === "SALDAR_CONSUMOS") prepago += n;
    if (m.concepto === "DIFERENCIAL") pendiente += n;
    if (m.concepto === "PAGO_RESERVA") pendiente -= n;
  }
  const neto = U.redondear(consumos - prepago);
  const saldo = U.redondear(personas.reduce((s, p) => s + Number(p.saldo), 0));
  return {
    personas,
    movimientos,
    consumos: U.redondear(consumos),
    neto_consumos: neto,
    pendiente: U.redondear(pendiente),
    saldo,
    cierre_pendiente: huboOperacionDeSaldo || saldo !== 0 || neto !== 0
  };
}
async function sincronizar(t, ctx, r) {
  const prev = await cuenta(t, ctx, r.id, true);
  if (r.evento_id && prev.personas.some(p => Number(p.ultima_revision) > Number(r.evento_id))) return;
  for (const p of r.personas) {
    const datos = {
      ultima_revision: r.evento_id || null,
      nombre: (p.nombre + " " + p.apellido).slice(0, 160),
      legajo: p.legajo || null,
      entrada: p.entrada || null,
      salida: p.salida || null,
      afiliado: Number(r.afiliado) ? 1 : 0,
      titular: String(r.titular_dni) === String(p.dni) ? 1 : 0
    };
    const fila = prev.personas.find(x => String(x.dni) === String(p.dni));
    if (fila) await N.actualizar(t, ctx, "predio_huesped", fila.id, datos);else await N.insertar(t, ctx, "predio_huesped", {
      ...datos,
      reserva_id: r.id,
      dni: String(p.dni),
      saldo: 0
    });
  }
  for (const p of prev.personas) if (!r.personas.some(x => String(x.dni) === String(p.dni))) await N.actualizar(t, ctx, "predio_huesped", p.id, {
    entrada: null,
    salida: null
  });
}
async function aplicarConfirmacion(t, ctx, r, key, huella, motivo) {
  const previo = await t.get("SELECT respuesta FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, key]);
  if (previo) return JSON.parse(previo.respuesta);
  await sincronizar(t, ctx, r);
  if (Number(r.diferencia)) await movimiento(t, ctx, r.id, "DIFERENCIAL", r.diferencia, null, "Variación del importe de la reserva");
  await N.auditar(t, ctx, "Operación atípica", "reserva", r.id, {
    operacion: key,
    total: r.precio_total,
    diferencia: r.diferencia,
    cambios: r.cambios || [],
    estado: r.estado,
    titular: r.titular_nombre,
    servicio: r.servicio,
    observacion: motivo || null
  });
  const respuesta = {
    id: r.id,
    total: r.precio_total,
    diferencia: r.diferencia,
    mensaje: "Reserva T-" + r.id + " guardada"
  };
  await N.insertar(t, ctx, "predio_recepcion_recibo", {
    clave: key,
    huella,
    respuesta: JSON.stringify(respuesta)
  });
  return respuesta;
}
async function guardar(ctx) {
  permiso(ctx);
  const b = ctx.body;
  return ctx.db.tx(async t => {
    const key = String(b.operacion || "");
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(key)) throw U.error("Identificador de operación inválido.");
    const recibo = await t.get("SELECT * FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, key]);
    const huella = U.sha256(JSON.stringify([ctx.usuario.id, b]));
    if (recibo) {
      if (recibo.huella !== huella) throw U.error("El comprobante corresponde a otra operación.", 409);
      return JSON.parse(recibo.respuesta);
    }
    const r = await turismo(t, ctx, "guardar", b);
    return aplicarConfirmacion(t, ctx, r, key, huella, b.motivo);
  });
}
async function caja(t, ctx, b, n, id, concepto) {
  if (!n) return;
  const cajaId = U.id(b.caja_id || ctx.sesion?.caja_id, "La caja que recibe o devuelve el efectivo");
  const ca = await N.exigir(t, ctx, "predio_caja", cajaId);
  exigirBoca(ctx, ca.boca_id);
  if (!Number(ca.activo)) throw U.error("La caja está inactiva.");
  await N.insertar(t, ctx, "predio_caja_movimiento", {
    caja_id: cajaId,
    boca_id: ca.boca_id,
    fecha: U.fechaHora(),
    concepto,
    tipo: n < 0 ? "EGRESO" : "INGRESO",
    importe: Math.abs(n),
    observaciones: "Reserva T-" + id,
    turno_id: turnoDeCaja(ctx, cajaId),
    usuario_id: ctx.usuario.id,
    usuario_nombre: N.nombreActor(ctx)
  });
}
async function planilla(t, ctx, r, n) {
  if (!r.afiliado || n <= 0) throw U.error("El descuento de haberes requiere un titular afiliado y un monto a cobrar.");
  const buscar = () => t.get("SELECT id FROM predio_afiliado WHERE predio_id=? AND usuario_general_id=?", [ctx.pid, r.usuario_id]);
  let a = await buscar();
  if (!a) {
    // La primera estadía puede llegar antes de sincronizar los maestros. Usar
    // la misma unión por documento o legajo conserva la ficha manual y su límite.
    await require("../maestros").aplicarMaestros(t, ctx, { afiliados: [{
      usuario_id: r.usuario_id, documento: r.titular_dni, legajo: r.titular_legajo, nombre: r.titular_nombre
    }] });
    a = await buscar();
  }
  return N.insertar(t, ctx, "predio_liquidacion", {
    afiliado_id: a.id,
    fecha: U.fechaHora(),
    total_consumos: n,
    total: n,
    cuotas: 1,
    valor_cuota: n,
    forma_pago: "DESCUENTO_HABERES",
    estado: "PENDIENTE",
    observaciones: "Recepción · reserva T-" + r.id,
    usuario_nombre: N.nombreActor(ctx)
  });
}
async function administrar(ctx) {
  permiso(ctx);
  const b = ctx.body,
    id = U.id(ctx.params.id);
  return ctx.db.tx(async t => {
    const key = String(b.operacion || "");
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(key)) throw U.error("Identificador de movimiento inválido.");
    const huella = U.sha256(JSON.stringify([ctx.usuario.id, id, b]));
    const previo = await t.get("SELECT huella,respuesta FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, key]);
    if (previo) {
      if (previo.huella !== huella) throw U.error("Identificador ya utilizado para otra operación.", 409);
      return JSON.parse(previo.respuesta);
    }
    // Revalida el servicio asignado y el titular; no se acepta identidad enviada por la pantalla.
    const {
      reserva: r
    } = await turismo(t, ctx, "detalle", {
      id
    });
    const a = await cuenta(t, ctx, id, true),
      accion = b.accion,
      nota = U.texto(b.detalle, {
        max: 180
      }),
      modo = b.medio;
    const p = a.personas.find(x => Number(x.id) === Number(b.huesped_id));
    const activo = x => x && x.entrada && !x.salida;
    let liq = null;
    if (accion === "CARGA" || accion === "RETIRO" || accion === "REPARTIR") {
      if (!p || !activo(p) && accion === "CARGA") throw U.error("Para cargar saldo, la persona tiene que haber hecho el ingreso.");
      const n = importe(b.importe);
      if (accion !== "CARGA" && Number(p.saldo) < n) throw U.error("El saldo disponible no alcanza.");
      const delta = accion === "CARGA" ? n : -n;
      if (accion === "REPARTIR") {
        const dest = a.personas.find(x => Number(x.id) === Number(b.destino_id));
        if (!dest || dest.id === p.id || !activo(dest)) throw U.error("Elegí otro integrante presente de la misma reserva.");
        await N.actualizar(t, ctx, "predio_huesped", dest.id, {
          saldo: U.redondear(Number(dest.saldo) + n)
        });
        await movimiento(t, ctx, id, "REPARTO", n, null, "Desde " + p.nombre, dest.id);
      } else {
        U.opcion(modo, ["EFECTIVO", "TRANSFERENCIA", "AL_SALIR"], "El medio");
        if (modo === "AL_SALIR" && !r.afiliado) throw U.error("Los particulares deben pagar al cargar saldo.");
        if (accion === "RETIRO") {
          let autorizado = 0;
          for (const m of a.movimientos) {
            if (esCierreDeSaldo(m)) break;
            if (["CARGA", "RETIRO"].includes(m.concepto) && m.medio === modo) autorizado += Number(m.importe);
          }
          if (n > U.redondear(autorizado) || modo !== "AL_SALIR" && n > Math.max(0, -a.neto_consumos)) throw U.error("La devolución supera el saldo abonado por ese medio.");
        }
        if (modo === "EFECTIVO") await caja(t, ctx, b, delta, id, "SALDO_ESTADIA");
      }
      await N.actualizar(t, ctx, "predio_huesped", p.id, {
        saldo: U.redondear(Number(p.saldo) + delta)
      });
      await movimiento(t, ctx, id, accion === "REPARTIR" ? "REPARTO" : accion, delta, accion === "REPARTIR" ? null : modo, nota, p.id);
    } else if (accion === "LIQUIDAR" || accion === "PAGO_RESERVA") {
      const n = accion === "LIQUIDAR" ? a.neto_consumos : a.pendiente;
      if (accion === "PAGO_RESERVA" && !n) throw U.error("No hay una diferencia pendiente.");
      if (accion === "LIQUIDAR" && !a.cierre_pendiente) throw U.error("No hay consumos ni saldo para liquidar.");
      if (Number(b.esperado) !== n) throw U.error("El importe cambió. Actualizá la cuenta antes de confirmar.", 409);
      U.opcion(modo, ["EFECTIVO", "TRANSFERENCIA", "HABERES"], "El medio");
      if (modo === "HABERES" && n) liq = await planilla(t, ctx, r, n);
      if (modo === "EFECTIVO") await caja(t, ctx, b, n, id, accion === "LIQUIDAR" ? "LIQUIDACION_ESTADIA" : "DIFERENCIA_RESERVA");
      if (accion === "LIQUIDAR") for (const h of a.personas) if (Number(h.saldo)) await N.actualizar(t, ctx, "predio_huesped", h.id, {
        saldo: 0
      });
      await movimiento(t, ctx, id, accion === "LIQUIDAR" ? "SALDAR_CONSUMOS" : "PAGO_RESERVA", n, modo, [nota, liq ? "Planilla " + liq : null].filter(Boolean).join(" · "), null, null, liq);
    } else throw U.error("Operación de cuenta inválida.");
    const respuesta = {
      mensaje: "Movimiento registrado",
      liquidacion_id: liq
    };
    await N.insertar(t, ctx, "predio_recepcion_recibo", {
      clave: key,
      huella,
      respuesta: JSON.stringify(respuesta)
    });
    return respuesta;
  });
}
async function buscarSaldo(ctx) {
  const puesto = exigirPuesto(ctx);
  exigirBoca(ctx, puesto.boca_id);
  const q = U.texto(ctx.query.q, {
    max: 30,
    requerido: true
  });
  const documento = /^[\d.\s-]+$/.test(q) ? q.replace(/[.\s-]/g, "") : q;
  return ctx.db.all(`SELECT h.id,h.reserva_id,h.dni,h.nombre,h.saldo,
     CASE WHEN a.habilitado_descuento=1 THEN COALESCE(a.limite,0) - (
       SELECT COALESCE(SUM(COALESCE(v.importe_haberes,v.total)),0) FROM predio_venta v
       WHERE v.predio_id=a.predio_id AND v.afiliado_id=a.id AND (v.forma_pago='DESCUENTO' OR v.importe_haberes>0)
       AND v.estado='CONFIRMADA' AND v.liquidacion_id IS NULL) ELSE 0 END AS disponible_haberes
    FROM predio_huesped h LEFT JOIN predio_afiliado a ON a.predio_id=h.predio_id AND a.dni=h.dni AND a.usuario_general_id IS NOT NULL
    WHERE h.predio_id=? AND h.entrada IS NOT NULL AND h.salida IS NULL AND (h.dni=? OR h.legajo=?)
    ORDER BY h.id LIMIT 10`, [ctx.pid, documento, q]);
}
async function aplicarVenta(t, ctx, huespedId, n, venta, reversa = false) {
  const h = await N.exigir(t, ctx, "predio_huesped", U.id(huespedId), "No encontramos al huésped", {
    bloquear: true
  });
  if (!reversa && (!h.entrada || h.salida || Number(h.saldo) < n)) throw U.error("El huésped no está presente o el saldo no alcanza.", 409);
  if (reversa && (await t.get("SELECT id FROM predio_estadia_mov WHERE predio_id=? AND reserva_id=? AND concepto='SALDAR_CONSUMOS' AND id>(SELECT MAX(id) FROM predio_estadia_mov WHERE predio_id=? AND venta_id=? AND concepto='COMPRA')", [ctx.pid, h.reserva_id, ctx.pid, venta]))) throw U.error("La estadía ya liquidó esta compra; no se puede anular desde la caja.", 409);
  const delta = reversa ? n : -n;
  await N.actualizar(t, ctx, "predio_huesped", h.id, {
    saldo: U.redondear(Number(h.saldo) + delta)
  });
  await movimiento(t, ctx, h.reserva_id, reversa ? "ANULACION" : "COMPRA", delta, "SALDO", "Venta N° " + venta, h.id, venta);
}
async function verPlanilla(ctx) {
  permiso(ctx);
  const id = U.id(ctx.params.id),
    l = U.id(ctx.params.planilla);
  await turismo(ctx.db, ctx, "detalle", {
    id
  });
  const mov = await ctx.db.get("SELECT id FROM predio_estadia_mov WHERE predio_id=? AND reserva_id=? AND liquidacion_id=?", [ctx.pid, id, l]);
  if (!mov) throw U.error("No se encontró esa planilla en la estadía.", 404);
  return require("./afiliados").datosLiquidacion({
    ...ctx,
    params: {
      id: l
    }
  });
}
const rutas = ["opciones", "listar", "familia", "detalle"].map(accion => ({
  m: "GET",
  p: "/recepcion/" + accion,
  h: async ctx => {
    const r = await turismo(ctx.db, ctx, accion, ctx.query);
    if (accion === "detalle") r.cuenta = await cuenta(ctx.db, ctx, r.reserva.id);
    return r;
  }
}));
rutas.push({
  m: "GET",
  p: "/recepcion/:id/planilla/:planilla",
  h: verPlanilla
}, {
  m: "POST",
  p: "/recepcion/cotizar",
  h: ctx => ctx.db.tx(t => turismo(t, ctx, "cotizar", ctx.body))
}, {
  m: "POST",
  p: "/recepcion/guardar",
  escritura: true,
  h: guardar
}, {
  m: "POST",
  p: "/recepcion/:id/cuenta",
  escritura: true,
  h: administrar
}, {
  m: "GET",
  p: "/saldos/presentes",
  h: buscarSaldo,
  soloLocal: true
});
module.exports = {
  rutas,
  aplicarVenta,
  cuenta,
  permiso,
  aplicarConfirmacion
};
