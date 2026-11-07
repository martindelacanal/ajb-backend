"use strict";
const { verificarOperador, turnoAbierto } = require("../turnos-caja");
const { esCierreDeSaldo, resumirCuenta, repartir } = require("../cuenta-estadia");

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
async function cuenta(t, ctx, id, lock = false) {
  const personas = await t.all("SELECT * FROM predio_huesped WHERE predio_id=? AND reserva_id=? ORDER BY id" + (lock ? t.forUpdate : ""), [ctx.pid, id]);
  const movimientos = await t.all("SELECT * FROM predio_estadia_mov WHERE predio_id=? AND reserva_id=? ORDER BY id DESC" + (lock ? t.forUpdate : ""), [ctx.pid, id]);
  return resumirCuenta(personas, movimientos);
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
  const diferenciales = r.diferenciales || (Number(r.diferencia) ? [{ importe: r.diferencia }] : []);
  if (diferenciales.length || r.plan_salida) {
    const { personas } = await cuenta(t, ctx, r.id, true);
    for (const d of diferenciales) {
      const p = personas.find(p => String(p.dni) === String(d.dni));
      await movimiento(t, ctx, r.id, "DIFERENCIAL", d.importe, null, "Variación del importe de la reserva", p?.id);
    }
    if (r.plan_salida) await aplicarSalida(t, ctx, r.id, r.plan_salida, personas);
  }
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
  if (Object.hasOwn(b, "_salida_plan")) throw U.error("La liquidación se calcula al confirmar la salida.");
  return ctx.db.tx(async t => {
    const key = String(b.operacion || "");
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(key)) throw U.error("Identificador de operación inválido.");
    const recibo = await t.get("SELECT * FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, key]);
    const huella = U.sha256(JSON.stringify([ctx.usuario.id, b]));
    if (recibo) {
      if (recibo.huella !== huella) throw U.error("El comprobante corresponde a otra operación.", 409);
      return JSON.parse(recibo.respuesta);
    }
    const salidaSolicitada = b.cuenta_esperada?.revision_salida || b.salida;
    const recuperada = salidaSolicitada ? await turismo(t, ctx, "confirmacion", b) : null;
    if (recuperada) return aplicarConfirmacion(t, ctx, recuperada, key, huella, b.motivo);
    if (b.id && b.cuenta_esperada) {
      const a = await cuenta(t, ctx, U.id(b.id), true);
      if (a.pendiente !== b.cuenta_esperada.pendiente || a.neto_consumos !== b.cuenta_esperada.neto_consumos)
        throw U.error("Cambió la cuenta de la estadía. Revisá el total antes de confirmar.", 409);
    }
    let datos = b;
    if (salidaSolicitada) {
      const { salida, cuenta: esperada } = await revisarSalida(t, ctx, b, true);
      if (!salida || esperada.revision_salida !== b.cuenta_esperada?.revision_salida) {
        throw U.error("Cambió la liquidación de salida. Volvé a revisar la cuenta antes de confirmar.", 409);
      }
      const plan = await prepararSalida(t, ctx, b, salida);
      datos = { ...b, _salida_plan: plan };
    }
    const r = await turismo(t, ctx, "guardar", datos);
    return aplicarConfirmacion(t, ctx, r, key, huella, b.motivo);
  });
}
async function prepararCaja(t, ctx, b) {
  const cajaId = U.id(b.caja_id || ctx.sesion?.caja_id, "La caja que recibe o devuelve el efectivo");
  const ca = await N.exigir(t, ctx, "predio_caja", cajaId, "No encontramos la caja", { bloquear: true });
  if (ctx.usuario.rol !== "ADMIN" || Number(ctx.sesion?.caja_id) === cajaId) {
    if (Number(ctx.sesion?.caja_id) !== cajaId) throw U.error("Ingresá a tu caja para registrar el efectivo de recepción.", 403);
    await verificarOperador(t, ctx, cajaId);
  } else if (await turnoAbierto(t, ctx.pid, cajaId)) {
    throw U.error("Esta caja está ocupada. Usá tu propia caja para registrar el efectivo de recepción.", 409);
  }
  exigirBoca(ctx, ca.boca_id);
  if (!Number(ca.activo)) throw U.error("La caja está inactiva.");
  return { caja_id: cajaId, boca_id: ca.boca_id, turno_id: turnoDeCaja(ctx, cajaId), fecha: U.fechaHora() };
}
async function registrarCaja(t, ctx, datos, n, id, concepto) {
  if (!n) return;
  await N.insertar(t, ctx, "predio_caja_movimiento", {
    ...datos,
    concepto,
    tipo: n < 0 ? "EGRESO" : "INGRESO",
    importe: Math.abs(n),
    observaciones: "Reserva T-" + id,
    usuario_id: ctx.usuario.id,
    usuario_nombre: N.nombreActor(ctx)
  });
}
async function caja(t, ctx, b, n, id, concepto) {
  if (n) await registrarCaja(t, ctx, await prepararCaja(t, ctx, b), n, id, concepto);
}

function liquidacionDeSalida(a, cotizacion) {
  const { personas, presentes, elegibles, vehiculo_pendiente } = cotizacion.salida;
  const candidatos = presentes.length ? elegibles : personas;
  const porDni = new Map(candidatos.map(p => [p.dni, {
    ...p, alojamiento: 0, consumos: 0, trasladado: 0, ...a.saldos_individuales[p.dni]
  }]));
  const diferencias = cotizacion.diferenciales || [];
  for (const { dni, importe } of diferencias) {
    const p = porDni.get(dni);
    if (p) p.alojamiento += importe;
  }
  const pendientes = {
    alojamiento: U.redondear(a.pendiente + cotizacion.diferencia),
    consumos: a.neto_consumos
  };
  const fila = [...porDni.values()];
  for (const rubro of Object.keys(pendientes)) {
    const remanente = U.redondear(pendientes[rubro] - fila.reduce((s, p) => s + p[rubro], 0));
    const cuotas = repartir(remanente, fila.map(() => 1));
    fila.forEach((p, i) => { p[rubro] = U.redondear(p[rubro] + cuotas[i]); });
  }
  const salidas = personas.map(({ dni }) => {
    const { nombre, alojamiento, consumos, trasladado } = porDni.get(dni);
    return { dni, nombre, alojamiento, consumos, trasladado: U.redondear(trasladado), total: U.redondear(alojamiento + consumos) };
  });
  const alojamiento = U.redondear(salidas.reduce((s, p) => s + p.alojamiento, 0));
  const consumos = U.redondear(salidas.reduce((s, p) => s + p.consumos, 0));
  return { personas: salidas, presentes, alojamiento, consumos, total: U.redondear(alojamiento + consumos), vehiculo_pendiente };
}

async function revisarSalida(t, ctx, b, bloquear = false) {
  const cotizacion = await turismo(t, ctx, "cotizar", b);
  const a = b.id ? await cuenta(t, ctx, U.id(b.id), bloquear) : resumirCuenta([], []);
  const esperada = { pendiente: a.pendiente, neto_consumos: a.neto_consumos };
  if (!cotizacion.salida) return { ...cotizacion, cuenta: esperada };
  const salida = liquidacionDeSalida(a, cotizacion);
  esperada.revision_salida = U.sha256(JSON.stringify([cotizacion.cotizacion_esperada, salida,
    Number(a.movimientos[0]?.id || 0), a.personas.map(p => [Number(p.id), Number(p.saldo), p.entrada, p.salida])]));
  return { ...cotizacion, salida, cuenta: esperada };
}

async function verificarAnulaciones(t, ctx, id, a, seleccion = null) {
  const ultimo = Number(a.movimientos.find(esCierreDeSaldo)?.id || 0);
  const ids = seleccion ? a.personas.filter(p => seleccion.has(String(p.dni))).map(p => p.id) : [];
  if (seleccion && !ids.length) return;
  const alcance = seleccion ? ` AND m.huesped_id IN (${t.lista(ids.length)})` : "";
  // Una compra ya liquidada por huésped no debe bloquear la salida de los demás.
  const pendiente = await t.get(`SELECT m.venta_id FROM predio_estadia_mov m
    JOIN predio_permiso p ON p.predio_id=m.predio_id AND p.referencia_id=m.venta_id
    WHERE m.predio_id=? AND m.reserva_id=? AND m.id>? AND m.concepto='COMPRA'
    AND p.tipo='ANULAR_VENTA' AND p.estado='PENDIENTE'${alcance}
    AND NOT EXISTS (SELECT 1 FROM predio_estadia_mov cierre WHERE cierre.predio_id=m.predio_id
      AND cierre.reserva_id=m.reserva_id AND cierre.huesped_id=m.huesped_id
      AND cierre.id>m.id AND cierre.concepto='CIERRE_SALIDA')
    LIMIT 1${t.forUpdate}`, [ctx.pid, id, ultimo, ...ids]);
  if (pendiente) throw U.error(`Resolvé la anulación pendiente del ticket N° ${pendiente.venta_id} antes de liquidar la estadía.`, 409);
}

async function prepararSalida(t, ctx, b, salida) {
  const eleccion = b.salida || {};
  const { alojamiento, consumos, total, personas, presentes, vehiculo_pendiente } = salida;
  const accion = eleccion.accion || alojamiento || consumos
    ? U.opcion(eleccion.accion, presentes.length ? ["COBRAR", "TRASLADAR"] : ["COBRAR"], "La liquidación")
    : null;
  const medio = accion === "COBRAR" && total ? U.opcion(eleccion.medio, ["EFECTIVO", "TRANSFERENCIA"], "El medio de pago") : null;
  const vehiculo = vehiculo_pendiente
    ? U.opcion(eleccion.vehiculo, presentes.length ? ["SALE", "PERMANECE"] : ["SALE"], "La salida del vehículo")
    : null;
  const id = U.id(b.id, "La reserva", false);
  if (id) await verificarAnulaciones(t, ctx, id, await cuenta(t, ctx, id, true), presentes.length ? new Set(personas.map(p => p.dni)) : null);
  const caja = medio === "EFECTIVO" ? await prepararCaja(t, ctx, eleccion) : null;
  return { personas, presentes, alojamiento, consumos, total, accion, medio, caja, vehiculo };
}

async function aplicarSalida(t, ctx, id, plan, personas) {
  const porDni = new Map(personas.map(p => [String(p.dni), p]));
  const traslada = plan.accion === "TRASLADAR";
  if (plan.caja) await registrarCaja(t, ctx, plan.caja, plan.total, id, "LIQUIDACION_SALIDA");
  for (const p of plan.personas) {
    const h = porDni.get(p.dni);
    if (p.alojamiento) await movimiento(t, ctx, id, traslada ? "TRASPASO_ALOJAMIENTO" : "PAGO_RESERVA",
      traslada ? -p.alojamiento : p.alojamiento, traslada ? "CEDIDO" : plan.medio, "Salida de " + h.nombre, h.id);
    if (p.consumos) await movimiento(t, ctx, id, traslada ? "TRASPASO_CONSUMOS" : "PAGO_SALIDA_CONSUMOS",
      traslada ? -p.consumos : p.consumos, traslada ? "CEDIDO" : plan.medio, "Salida de " + h.nombre, h.id);
    await movimiento(t, ctx, id, "CIERRE_SALIDA", 0, null, "Cuenta al registrar la salida", h.id);
  }
  if (traslada) {
    const pesos = plan.presentes.map(() => 1);
    const alojamiento = repartir(plan.alojamiento, pesos), consumos = repartir(plan.consumos, pesos);
    for (let i = 0; i < plan.presentes.length; i++) {
      const h = porDni.get(plan.presentes[i].dni);
      if (alojamiento[i]) await movimiento(t, ctx, id, "TRASPASO_ALOJAMIENTO", alojamiento[i], "RECIBIDO", "Traslado de alojamiento de quienes salieron", h.id);
      if (consumos[i]) await movimiento(t, ctx, id, "TRASPASO_CONSUMOS", consumos[i], "RECIBIDO", "Traslado de consumos de quienes salieron", h.id);
    }
  }
  for (const h of personas) {
    if (Number(h.saldo) && (!plan.presentes.length || plan.personas.some(p => p.dni === String(h.dni)))) {
      await N.actualizar(t, ctx, "predio_huesped", h.id, { saldo: 0 });
    }
  }
  if (!plan.presentes.length) await movimiento(t, ctx, id, "SALDAR_CONSUMOS", 0, null, "Cierre de la estadía");
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
      if (accion === "LIQUIDAR") await verificarAnulaciones(t, ctx, id, a);
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
  const documento = /^[\d.\s-]+$/.test(q) ? q.replace(/[.\s-]/g, "") : "";
  const legajo = q.toUpperCase();
  const prefijoLegajo = legajo.replace(/[!%_]/g, "!$&") + "%";
  const filas = await ctx.db.all(`SELECT id,reserva_id,dni,legajo,nombre,saldo FROM predio_huesped
    WHERE predio_id=? AND entrada IS NOT NULL AND salida IS NULL
      AND (dni LIKE ? OR UPPER(legajo) LIKE ? ESCAPE '!')
    ORDER BY CASE WHEN dni=? OR UPPER(legajo)=? THEN 0 ELSE 1 END, nombre, reserva_id, id LIMIT 10`,
    [ctx.pid, documento ? documento + "%" : null, prefijoLegajo, documento, legajo]);
  return filas.map(h => ({ ...h, exacto: h.dni === documento || String(h.legajo || "").toUpperCase() === legajo }));
}
async function huespedParaDevolucion(t, ctx, huespedId, venta) {
  const h = await N.exigir(t, ctx, "predio_huesped", U.id(huespedId), "No encontramos al huésped", {
    bloquear: true
  });
  const compra = await t.get(`SELECT id FROM predio_estadia_mov WHERE predio_id=? AND reserva_id=?
    AND venta_id=? AND huesped_id=? AND concepto='COMPRA' ORDER BY id LIMIT 1${t.forUpdate}`, [ctx.pid, h.reserva_id, venta, h.id]);
  if (!compra) throw U.error("No se encontró el débito del ticket en la cuenta del huésped.", 409);
  const cierre = await t.get(`SELECT id FROM predio_estadia_mov WHERE predio_id=? AND reserva_id=? AND id>?
    AND ((concepto='SALDAR_CONSUMOS' AND (COALESCE(medio,'')<>'HABERES' OR importe>=0))
      OR (concepto='CIERRE_SALIDA' AND huesped_id=?)) LIMIT 1${t.forUpdate}`, [ctx.pid, h.reserva_id, compra.id, h.id]);
  if (cierre) throw U.error("La estadía ya liquidó esta compra; no se puede anular desde la caja.", 409);
  return h;
}

async function aplicarVenta(t, ctx, huespedId, n, venta, reversa = false) {
  const h = reversa ? await huespedParaDevolucion(t, ctx, huespedId, venta)
    : await N.exigir(t, ctx, "predio_huesped", U.id(huespedId), "No encontramos al huésped", { bloquear: true });
  if (!reversa && (!h.entrada || h.salida || Number(h.saldo) < n)) throw U.error("El huésped no está presente o el saldo no alcanza.", 409);
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
const rutas = ["opciones", "listar", "familia", "detalle", "vencidas"].map(accion => ({
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
  p: "/recepcion/adicionales",
  roles: ["ADMIN"],
  escritura: true,
  h: ctx => ctx.db.tx(t => turismo(t, ctx, "crearAdicional", ctx.body))
}, {
  m: "POST",
  p: "/recepcion/cotizar",
  h: ctx => ctx.db.tx(t => revisarSalida(t, ctx, ctx.body))
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
  huespedParaDevolucion,
  cuenta,
  permiso,
  aplicarConfirmacion
};
