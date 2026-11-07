"use strict";
const { verificarOperador, turnoAbierto } = require("../turnos-caja");
const { esCierreDeSaldo, resumirCuenta, repartir } = require("../cuenta-estadia");

const U = require("../util"),
  N = require("../negocio"),
  C = require("../comprobantes");
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
async function movimiento(t, ctx, reserva, concepto, valor, medio, detalle, persona = null, venta = null, liquidacion = null, extra = {}) {
  return N.insertar(t, ctx, "predio_estadia_mov", {
    ...extra,
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
  const a = resumirCuenta(personas, movimientos);
  a.devoluciones = (await t.all("SELECT * FROM predio_adicional_devolucion WHERE predio_id=? AND reserva_id=?" + (lock ? t.forUpdate : ""), [ctx.pid, id]))
    .filter(d => !Number(d.anulada));
  return a;
}

// ------------------------------------------------------------------ adicionales de la estadía

const MEDIOS_ADICIONAL = ["EFECTIVO", "TRANSFERENCIA"];

/** Estado de cada artículo de la reserva: lo que cuesta en el predio, lo pagado, lo adeudado y la devolución. */
function estadoAdicionales(reserva, a, hoy = U.hoy()) {
  const devueltos = new Map((a.devoluciones || []).map(d => [Number(d.adicional_id), d]));
  const saldada = Number(a.pendiente) <= 0;
  // Si ya salieron todos, lo alquilado que no se devolvió queda pendiente aunque su período no haya terminado.
  const ingresaron = (reserva.personas || []).filter(p => p.entrada);
  const salieronTodos = ingresaron.length > 0 && ingresaron.every(p => p.salida);
  return (reserva.adicionales || []).map(x => {
    const id = Number(x.adicional_id);
    const enPredio = U.redondear(Math.max(0, Number(x.subtotal || 0) - Number(x.base_turismo || 0)));
    const pagado = U.redondear(Number(a.pagos_adicionales?.[String(id)] || 0));
    const adeudado = saldada ? 0 : U.redondear(Math.max(0, enPredio - pagado));
    const alquiler = x.modalidad !== "VENTA" && !!x.fecha_hasta;
    const devolucion = devueltos.get(id) || null;
    return {
      ...x,
      en_predio: enPredio,
      pagado,
      adeudado,
      saldado_con_reserva: saldada && enPredio > pagado,
      devuelto: devolucion ? devolucion.fecha : null,
      devolucion_por: devolucion ? devolucion.usuario_nombre : null,
      sin_devolver: alquiler && !devolucion && (x.fecha_hasta < hoy || salieronTodos || !!x.todos_salieron),
      dias_atraso: alquiler && !devolucion && x.fecha_hasta < hoy ? Math.round((Date.parse(hoy) - Date.parse(x.fecha_hasta)) / 86400000) : 0
    };
  });
}

async function saldosPorReserva(db, pid, ids) {
  if (!ids.length) return new Map();
  const movs = await db.all(`SELECT reserva_id, concepto, adicional_id, importe FROM predio_estadia_mov
    WHERE predio_id=? AND reserva_id IN (${ids.map(() => "?").join(",")}) AND concepto IN ('DIFERENCIAL','PAGO_RESERVA','PAGO_ADICIONAL')`, [pid, ...ids]);
  const devs = await db.all(`SELECT reserva_id, adicional_id, fecha, usuario_nombre FROM predio_adicional_devolucion
    WHERE predio_id=? AND COALESCE(anulada,0)=0 AND reserva_id IN (${ids.map(() => "?").join(",")})`, [pid, ...ids]);
  const mapa = new Map(ids.map(id => [Number(id), { pendiente: 0, pagos_adicionales: {}, devoluciones: [] }]));
  for (const m of movs) {
    const x = mapa.get(Number(m.reserva_id));
    const n = Number(m.importe);
    if (m.concepto === "DIFERENCIAL") x.pendiente += n;
    else x.pendiente -= n;
    if (m.concepto === "PAGO_ADICIONAL") x.pagos_adicionales[String(m.adicional_id)] = U.redondear((x.pagos_adicionales[String(m.adicional_id)] || 0) + n);
  }
  for (const d of devs) mapa.get(Number(d.reserva_id)).devoluciones.push(d);
  for (const x of mapa.values()) x.pendiente = U.redondear(x.pendiente);
  return mapa;
}

/**
 * Artículos alquilados cuyo período ya terminó sin devolverse o sin pagarse, y artículos sin pagar
 * de estadías en las que ya salieron todos. Los datos de la reserva vienen de Turismo; la devolución
 * y los pagos, de las tablas del predio (siempre al día en la notebook).
 */
async function adicionalesPendientes(ctx) {
  const r = await turismo(ctx.db, ctx, "alquileres", {});
  const hoy = r.hoy || U.hoy();
  const porReserva = new Map();
  for (const l of r.lineas || []) {
    if (!porReserva.has(l.reserva_id)) porReserva.set(l.reserva_id, []);
    porReserva.get(l.reserva_id).push(l);
  }
  const saldos = await saldosPorReserva(ctx.db, ctx.pid, [...porReserva.keys()]);
  const salida = [];
  for (const [reservaId, lineas] of porReserva) {
    const a = saldos.get(reservaId);
    const estados = estadoAdicionales({ adicionales: lineas }, a, hoy);
    for (const e of estados) {
      const vencido = e.modalidad !== "VENTA" && e.fecha_hasta && e.fecha_hasta < hoy;
      const sinPagar = e.adeudado > 0 && (vencido || e.todos_salieron);
      if (!e.sin_devolver && !sinPagar) continue;
      salida.push({
        id: reservaId + "-" + e.adicional_id, reserva_id: reservaId, titular: e.titular, servicio: e.servicio, recurso: e.recurso,
        adicional_id: e.adicional_id, nombre: e.nombre, modalidad: e.modalidad, cantidad: e.cantidad, fecha_desde: e.fecha_desde, fecha_hasta: e.fecha_hasta,
        dias_atraso: e.fecha_hasta && e.fecha_hasta < hoy ? Math.round((Date.parse(hoy) - Date.parse(e.fecha_hasta)) / 86400000) : 0,
        sin_devolver: e.sin_devolver, sin_pagar: sinPagar, adeudado: e.adeudado, salieron: !!e.todos_salieron
      });
    }
  }
  return { hoy, filas: salida.sort((x, y) => y.dias_atraso - x.dias_atraso || x.reserva_id - y.reserva_id) };
}

async function operarAdicional(ctx) {
  permiso(ctx);
  const b = ctx.body,
    id = U.id(ctx.params.id);
  return ctx.db.tx(async t => {
    const key = String(b.operacion || "");
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(key)) throw U.error("Identificador de operación inválido.");
    const huella = U.sha256(JSON.stringify([ctx.usuario.id, id, "adicional", b]));
    const previo = await t.get("SELECT huella,respuesta FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, key]);
    if (previo) {
      if (previo.huella !== huella) throw U.error("Identificador ya utilizado para otra operación.", 409);
      return JSON.parse(previo.respuesta);
    }
    const { reserva: r } = await turismo(t, ctx, "detalle", { id });
    const a = await cuenta(t, ctx, id, true);
    const adicionalId = U.id(b.adicional_id, "El artículo");
    const linea = estadoAdicionales(r, a).find(x => Number(x.adicional_id) === adicionalId);
    if (!linea) throw U.error("Ese artículo no está en la reserva.", 404);
    const nota = U.texto(b.detalle, { max: 180 });
    let mensaje, comprobante = null;
    if (b.accion === "DEVOLVER" || b.accion === "DESHACER_DEVOLUCION") {
      if (linea.modalidad === "VENTA" || !linea.fecha_desde) throw U.error("Sólo se registra la devolución de un artículo alquilado por días.");
      const fila = await t.get("SELECT * FROM predio_adicional_devolucion WHERE predio_id=? AND reserva_id=? AND adicional_id=?" + t.forUpdate, [ctx.pid, id, adicionalId]);
      if (b.accion === "DEVOLVER") {
        const fecha = U.fecha(b.fecha || U.hoy(), { campo: "La fecha de devolución" });
        if (fecha > U.hoy() || fecha < linea.fecha_desde) throw U.error("La devolución tiene que ser entre el primer día de uso y hoy.");
        const datos = { fecha, detalle: nota, anulada: 0, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx), registrada: U.fechaHora() };
        if (fila) await N.actualizar(t, ctx, "predio_adicional_devolucion", fila.id, datos);
        else await N.insertar(t, ctx, "predio_adicional_devolucion", { ...datos, reserva_id: id, adicional_id: adicionalId });
        mensaje = linea.nombre + " devuelto";
      } else {
        if (!fila || Number(fila.anulada)) throw U.error("Ese artículo no tiene una devolución registrada.");
        await N.actualizar(t, ctx, "predio_adicional_devolucion", fila.id, { anulada: 1, detalle: nota || fila.detalle, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx), registrada: U.fechaHora() });
        mensaje = "Se quitó la devolución de " + linea.nombre;
      }
    } else if (b.accion === "PAGAR") {
      U.opcion(b.medio, MEDIOS_ADICIONAL, "El medio");
      const n = importe(b.importe);
      if (n > linea.adeudado) throw U.error("El importe supera lo que falta pagar de " + linea.nombre + " (" + U.pesos(linea.adeudado) + ").");
      const cajaMov = b.medio === "EFECTIVO" ? await caja(t, ctx, b, n, id, "ADICIONAL_ESTADIA") : null;
      const movId = await movimiento(t, ctx, id, "PAGO_ADICIONAL", n, b.medio, [linea.nombre, nota].filter(Boolean).join(" · "), null, null, null, { adicional_id: adicionalId });
      comprobante = await C.emitir(t, ctx, { reserva: r, movimientos: [movId], medio: b.medio, operacion: "ARTICULOS", observacion: nota, cajaMovimiento: cajaMov });
      mensaje = "Pago de " + linea.nombre + " registrado · " + C.NOMBRE[comprobante.tipo] + " " + comprobante.codigo;
    } else if (b.accion === "ANULAR_PAGO") {
      const pago = a.movimientos.find(m => Number(m.id) === Number(b.movimiento_id));
      // Sólo un pago original: el reintegro de una nota de crédito anulada (lleva anula_mov_id) no es un pago nuevo.
      if (!pago || pago.concepto !== "PAGO_ADICIONAL" || Number(pago.adicional_id) !== adicionalId || Number(pago.importe) <= 0 || pago.anula_mov_id) throw U.error("No encontramos ese pago del artículo.", 404);
      if (a.pagos_anulados.includes(Number(pago.id))) throw U.error("Ese pago ya fue anulado.", 409);
      // Un pago con recibo se devuelve con una nota de crédito sobre ese recibo (queda en Contable).
      const documento = pago.comprobante ? await t.get("SELECT * FROM predio_comprobante WHERE predio_id=? AND id=?" + t.forUpdate, [ctx.pid, pago.comprobante]) : null;
      if (documento && documento.tipo !== "RECIBO") throw U.error("No encontramos ese pago del artículo.", 404);
      const recibo = documento;
      if (recibo) {
        comprobante = await require("./contable").devolverRenglones(t, ctx, recibo, [{ movimiento_id: pago.id, importe: null }],
          { medio: pago.medio, motivo: nota || "Anulación del pago de " + linea.nombre, cuerpo: b });
        mensaje = "Pago de " + linea.nombre + " anulado · " + C.NOMBRE[comprobante.tipo] + " " + comprobante.codigo;
      } else {
      if (pago.medio === "EFECTIVO") await caja(t, ctx, b, -Number(pago.importe), id, "ADICIONAL_ESTADIA");
      await movimiento(t, ctx, id, "PAGO_ADICIONAL", -Number(pago.importe), pago.medio, ["Anula el pago de " + linea.nombre, nota].filter(Boolean).join(" · "), null, null, null,
        { adicional_id: adicionalId, anula_mov_id: Number(pago.id) });
      mensaje = "Pago de " + linea.nombre + " anulado";
      }
    } else throw U.error("Operación de artículo inválida.");
    const respuesta = { mensaje, comprobante: resumen(comprobante) };
    await N.insertar(t, ctx, "predio_recepcion_recibo", { clave: key, huella, respuesta: JSON.stringify(respuesta) });
    return respuesta;
  });
}

async function empresa(ctx) {
  const config = await N.leerConfig(ctx.db, ctx);
  return { nombre_predio: config.nombre_predio, razon_social: config.razon_social, cuit: config.cuit, direccion: config.direccion };
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
  let comprobante = null;
  await sincronizar(t, ctx, r);
  const diferenciales = r.diferenciales || (Number(r.diferencia) ? [{ importe: r.diferencia }] : []);
  if (diferenciales.length || r.plan_salida) {
    const { personas } = await cuenta(t, ctx, r.id, true);
    for (const d of diferenciales) {
      const p = personas.find(p => String(p.dni) === String(d.dni));
      await movimiento(t, ctx, r.id, "DIFERENCIAL", d.importe, null, "Variación del importe de la reserva", p?.id);
    }
    if (r.plan_salida) comprobante = await aplicarSalida(t, ctx, r.id, r.plan_salida, personas, r);
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
    mensaje: "Reserva T-" + r.id + " guardada" + (comprobante ? " · " + C.NOMBRE[comprobante.tipo] + " " + comprobante.codigo : ""),
    comprobante: resumen(comprobante)
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
  if (!n) return null;
  return N.insertar(t, ctx, "predio_caja_movimiento", {
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
  return n ? registrarCaja(t, ctx, await prepararCaja(t, ctx, b), n, id, concepto) : null;
}
/** Lo que vuelve a la pantalla de un comprobante recién emitido. */
function resumen(c) {
  return c ? { id: c.id, tipo: c.tipo, numero: c.numero, codigo: c.codigo, total: c.total } : null;
}

function liquidacionDeSalida(a, cotizacion) {
  const { personas, presentes, elegibles, vehiculos_pendientes = [] } = cotizacion.salida;
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
  return { personas: salidas, presentes, alojamiento, consumos, total: U.redondear(alojamiento + consumos),
    vehiculos_pendientes, vehiculo_pendiente: vehiculos_pendientes.length > 0 };
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
  const { alojamiento, consumos, total, personas, presentes, vehiculos_pendientes = [] } = salida;
  const accion = eleccion.accion || alojamiento || consumos
    ? U.opcion(eleccion.accion, presentes.length ? ["COBRAR", "TRASLADAR"] : ["COBRAR"], "La liquidación")
    : null;
  const medio = accion === "COBRAR" && total ? U.opcion(eleccion.medio, ["EFECTIVO", "TRANSFERENCIA"], "El medio de pago") : null;
  // Qué vehículos salen: si no queda nadie, todos; si no, los que eligió recepción.
  const pendientes = vehiculos_pendientes.map(v => v.patente);
  let vehiculos_salen = [];
  if (pendientes.length && !presentes.length) vehiculos_salen = pendientes;
  else if (pendientes.length) {
    const elegidos = Array.isArray(eleccion.vehiculos_salen) ? eleccion.vehiculos_salen.map(String)
      : eleccion.vehiculo === "SALE" ? pendientes : eleccion.vehiculo === "PERMANECE" ? [] : null;
    if (!elegidos) throw U.error("Indicá qué vehículos salen del predio y cuáles permanecen.");
    if (elegidos.some(p => !pendientes.includes(p))) throw U.error("Revisá los vehículos que salen: cambió la lista de la reserva.", 409);
    vehiculos_salen = pendientes.filter(p => elegidos.includes(p));
  }
  const id = U.id(b.id, "La reserva", false);
  if (id) await verificarAnulaciones(t, ctx, id, await cuenta(t, ctx, id, true), presentes.length ? new Set(personas.map(p => p.dni)) : null);
  const caja = medio === "EFECTIVO" ? await prepararCaja(t, ctx, eleccion) : null;
  return { personas, presentes, alojamiento, consumos, total, accion, medio, caja, vehiculos_salen };
}

async function aplicarSalida(t, ctx, id, plan, personas, reserva = null) {
  const porDni = new Map(personas.map(p => [String(p.dni), p]));
  const traslada = plan.accion === "TRASLADAR";
  const cajaMov = plan.caja ? await registrarCaja(t, ctx, plan.caja, plan.total, id, "LIQUIDACION_SALIDA") : null;
  const cobrados = [];
  for (const p of plan.personas) {
    const h = porDni.get(p.dni);
    if (p.alojamiento) cobrados.push(await movimiento(t, ctx, id, traslada ? "TRASPASO_ALOJAMIENTO" : "PAGO_RESERVA",
      traslada ? -p.alojamiento : p.alojamiento, traslada ? "CEDIDO" : plan.medio, "Salida de " + h.nombre, h.id));
    if (p.consumos) cobrados.push(await movimiento(t, ctx, id, traslada ? "TRASPASO_CONSUMOS" : "PAGO_SALIDA_CONSUMOS",
      traslada ? -p.consumos : p.consumos, traslada ? "CEDIDO" : plan.medio, "Salida de " + h.nombre, h.id));
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
  if (traslada || !reserva || !C.MEDIOS.includes(plan.medio)) return null;
  return C.emitir(t, ctx, { reserva, movimientos: cobrados, medio: plan.medio, operacion: "SALIDA", cajaMovimiento: cajaMov });
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
    let liq = null, comprobante = null, cajaMov = null;
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
        if (modo === "EFECTIVO") cajaMov = await caja(t, ctx, b, delta, id, "SALDO_ESTADIA");
      }
      await N.actualizar(t, ctx, "predio_huesped", p.id, {
        saldo: U.redondear(Number(p.saldo) + delta)
      });
      const movId = await movimiento(t, ctx, id, accion === "REPARTIR" ? "REPARTO" : accion, delta, accion === "REPARTIR" ? null : modo, nota, p.id);
      if (accion !== "REPARTIR" && C.MEDIOS.includes(modo)) comprobante = await C.emitir(t, ctx, { reserva: r, movimientos: [movId], medio: modo, operacion: "SALDO", observacion: nota, cajaMovimiento: cajaMov });
    } else if (accion === "LIQUIDAR" || accion === "PAGO_RESERVA") {
      const n = accion === "LIQUIDAR" ? a.neto_consumos : a.pendiente;
      if (accion === "PAGO_RESERVA" && !n) throw U.error("No hay una diferencia pendiente.");
      if (accion === "LIQUIDAR" && !a.cierre_pendiente) throw U.error("No hay consumos ni saldo para liquidar.");
      if (Number(b.esperado) !== n) throw U.error("El importe cambió. Actualizá la cuenta antes de confirmar.", 409);
      if (accion === "LIQUIDAR") await verificarAnulaciones(t, ctx, id, a);
      U.opcion(modo, ["EFECTIVO", "TRANSFERENCIA", "HABERES"], "El medio");
      if (modo === "HABERES" && n) liq = await planilla(t, ctx, r, n);
      if (modo === "EFECTIVO") cajaMov = await caja(t, ctx, b, n, id, accion === "LIQUIDAR" ? "LIQUIDACION_ESTADIA" : "DIFERENCIA_RESERVA");
      if (accion === "LIQUIDAR") for (const h of a.personas) if (Number(h.saldo)) await N.actualizar(t, ctx, "predio_huesped", h.id, {
        saldo: 0
      });
      const movId = await movimiento(t, ctx, id, accion === "LIQUIDAR" ? "SALDAR_CONSUMOS" : "PAGO_RESERVA", n, modo, [nota, liq ? "Planilla " + liq : null].filter(Boolean).join(" · "), null, null, liq);
      if (n && C.MEDIOS.includes(modo)) comprobante = await C.emitir(t, ctx, { reserva: r, movimientos: [movId], medio: modo,
        operacion: accion === "LIQUIDAR" ? "LIQUIDACION" : "DIFERENCIA_RESERVA", observacion: nota, cajaMovimiento: cajaMov });
    } else throw U.error("Operación de cuenta inválida.");
    const respuesta = {
      mensaje: "Movimiento registrado" + (comprobante ? " · " + C.NOMBRE[comprobante.tipo] + " " + comprobante.codigo : ""),
      liquidacion_id: liq,
      comprobante: resumen(comprobante)
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
const rutas = ["opciones", "listar", "familia", "detalle", "movimientos"].map(accion => ({
  m: "GET",
  p: "/recepcion/" + accion,
  h: async ctx => {
    const r = await turismo(ctx.db, ctx, accion, ctx.query);
    if (accion === "detalle") {
      r.cuenta = await cuenta(ctx.db, ctx, r.reserva.id);
      r.adicionales = estadoAdicionales(r.reserva, r.cuenta);
      r.empresa = await empresa(ctx);
      r.comprobantes = await C.deReserva(ctx.db, ctx, r.reserva.id);
    }
    return r;
  }
}));
rutas.push({
  m: "GET",
  p: "/recepcion/vencidas",
  h: async ctx => {
    const r = await turismo(ctx.db, ctx, "vencidas", ctx.query);
    // Un Turismo anterior no conoce los alquileres: el aviso de estadías sigue funcionando igual.
    try { r.adicionales = (await adicionalesPendientes(ctx)).filas.length; } catch (_e) { r.adicionales = 0; }
    return r;
  }
}, {
  m: "GET",
  p: "/recepcion/adicionales-pendientes",
  h: adicionalesPendientes
}, {
  m: "GET",
  p: "/recepcion/catalogo",
  roles: ["ADMIN"],
  h: ctx => turismo(ctx.db, ctx, "catalogo", {})
}, {
  m: "GET",
  p: "/recepcion/catalogo/adicional",
  roles: ["ADMIN"],
  h: ctx => turismo(ctx.db, ctx, "adicional", { id: ctx.query.id })
}, {
  m: "POST",
  p: "/recepcion/catalogo/guardar",
  roles: ["ADMIN"],
  escritura: true,
  h: ctx => ctx.db.tx(t => turismo(t, ctx, "guardarAdicional", ctx.body))
}, {
  m: "GET",
  p: "/recepcion/estadisticas",
  roles: ["ADMIN"],
  h: ctx => turismo(ctx.db, ctx, "resumenEstadias", ctx.query)
}, {
  m: "POST",
  p: "/recepcion/:id/adicional",
  escritura: true,
  h: operarAdicional
});
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
  estadoAdicionales,
  adicionalesPendientes,
  aplicarVenta,
  huespedParaDevolucion,
  cuenta,
  permiso,
  turismo,
  aplicarConfirmacion,
  sincronizar,
  movimiento,
  caja,
  prepararCaja,
  registrarCaja,
  resumen,
  empresa
};
