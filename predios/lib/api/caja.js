"use strict";

// Caja: saldo de apertura (lo carga el administrador y lo confirma el cajero),
// ajustes manuales, cierres de caja y estado del día. El saldo de cada caja es la suma
// de sus movimientos: ingresos menos egresos.
//
// Dos clases de cierre:
//  - Definitivo: lo hace siempre un administrador, desde su cuenta o escribiendo su
//    usuario y su contraseña en la PC del cajero. Cuenta el efectivo y decide cuánto
//    queda en la caja para el próximo turno.
//  - Temporal: lo hace el cajero cuando se va y no hay un administrador. Todo el efectivo
//    va a dos bolsas (recaudación y cambio), cada una con su ticket; la caja queda en
//    cero y libre para el próximo cajero, que empieza de cero sin heredar nada del
//    anterior. Cuando llega, el administrador recibe las bolsas y cierra cada cierre
//    temporal en forma definitiva, sin tocar la caja que siguió trabajando.

const U = require("../util");
const N = require("../negocio");
const { exigirAdmin, esAdmin, bocasDe, turnoDeCaja } = require("./comun");
const { verificarAdministrador } = require("./sesion");
const { emitirAviso } = require("../avisos");

const { turnoAbierto, verificarOperador } = require("../turnos-caja");

const CONCEPTOS_AJUSTE = ["CIERRE_CAJA", "INGRESO_DINERO", "RETIRO_DINERO", "OTROS"];
const ACCIONES_CIERRE = ["Cierre de caja", "Cierre temporal de caja"];

// Un saldo de apertura deja de describir la caja cuando hay un cierre posterior: el
// cajero que sigue no hereda lo que cargó o confirmó el anterior. Las fechas tienen
// precisión de segundos; si el movimiento de la apertura ya entró en un cierre, ese
// cierre la consumió aunque haya ocurrido en el mismo segundo.
const APERTURA_VIGENTE = `NOT EXISTS (SELECT 1 FROM predio_cierre ci WHERE ci.predio_id = a.predio_id AND ci.caja_id = a.caja_id
  AND ci.fecha > COALESCE(a.fecha_modificacion, a.fecha_creacion))
  AND NOT EXISTS (SELECT 1 FROM predio_caja_movimiento am JOIN predio_cierre ac ON ac.predio_id = am.predio_id AND ac.id = am.cierre_id
  WHERE am.predio_id = a.predio_id AND am.id = a.movimiento_id AND ac.fecha >= COALESCE(a.fecha_modificacion, a.fecha_creacion))`;

function aperturaVigente(db, pid, cajaId, jornada, columnas = "a.*") {
  return db.get(`SELECT ${columnas} FROM predio_apertura a WHERE a.predio_id = ? AND a.caja_id = ? AND a.fecha = ? AND ${APERTURA_VIGENTE}`,
    [pid, cajaId, jornada]);
}

async function saldoCaja(t, ctx, cajaId) {
  const f = await t.get(
    `SELECT COALESCE(SUM(CASE WHEN tipo = 'INGRESO' THEN importe ELSE -importe END), 0) AS saldo
     FROM predio_caja_movimiento WHERE predio_id = ? AND caja_id = ?`, [ctx.pid, cajaId]);
  return U.redondear(Number(f?.saldo || 0), 2);
}

function cajaDelPedido(ctx, valor) {
  if (valor) return U.id(valor, "La caja");
  if (ctx.sesion?.caja_id) return Number(ctx.sesion.caja_id);
  throw U.error("Elegí una caja");
}

async function exigirAccesoCaja(t, ctx, cajaId, bloquear = false) {
  const caja = await N.exigir(t, ctx, "predio_caja", cajaId, "No encontramos la caja", { bloquear });
  if (!esAdmin(ctx) && Number(ctx.sesion?.caja_id) !== Number(cajaId) && !bocasDe(ctx).includes(Number(caja.boca_id))) {
    throw U.error("No tenés acceso a esa caja", 403);
  }
  return caja;
}

async function ultimoCierre(t, pid, cajaId) {
  const cierre = await t.get(
    `SELECT id, fecha FROM predio_cierre WHERE predio_id=? AND caja_id=? ORDER BY id DESC LIMIT 1`, [pid, cajaId]);
  if (!cierre) return null;
  const auditoria = await t.get(
    `SELECT detalle FROM predio_auditoria WHERE predio_id=? AND entidad='caja' AND entidad_id=?
     AND accion IN (?, ?) ORDER BY id DESC LIMIT 1`, [pid, cajaId, ...ACCIONES_CIERRE]);
  let detalle;
  try { detalle = JSON.parse(auditoria?.detalle || "null"); } catch (_e) { /* formato histórico */ }
  if (detalle && Number(detalle.cierre_id) === Number(cierre.id) && Number.isSafeInteger(detalle.ultima_venta_id)) {
    cierre.ultima_venta_id = detalle.ultima_venta_id;
  }
  return cierre;
}

// Separa el efectivo esperado en las dos bolsas del cierre: el cambio (saldo inicial y
// el dinero que se agregó durante la jornada) y la recaudación (ventas y demás cobros
// en efectivo). Los retiros del día salen primero de la recaudación.
function separarEfectivo(arrastre, esperado, conceptos) {
  const r = (n) => U.redondear(n, 2);
  const suma = (concepto, tipo) => conceptos
    .filter((c) => c.concepto === concepto && c.tipo === tipo).reduce((s, c) => s + Number(c.total || 0), 0);
  const neto = (concepto) => suma(concepto, "INGRESO") - suma(concepto, "EGRESO");
  const saldoInicial = r(arrastre + neto("SALDO_APERTURA"));
  const agregados = r(neto("INGRESO_DINERO") + suma("OTROS", "INGRESO"));
  const ventas = r(neto("VENTA"));
  const anulaciones = r(-neto("ANULACION_VENTA"));
  const retiros = r(-neto("RETIRO_DINERO") - neto("CIERRE_CAJA") - neto("CIERRE_TEMPORAL") + suma("OTROS", "EGRESO"));
  const cambio = r(saldoInicial + agregados);
  // Lo demás (recepción, liquidaciones de afiliados, notas de crédito…) también es
  // efectivo cobrado o devuelto en el turno.
  const otrosCobros = r(esperado - cambio - (ventas - anulaciones) + retiros);
  const cobros = r(ventas - anulaciones + otrosCobros);
  let enVentas = Math.max(0, r(cobros - retiros));
  if (enVentas > esperado) enVentas = Math.max(0, esperado);
  return {
    saldo_inicial: saldoInicial, agregados, cambio, ventas, anulaciones, otros_cobros: otrosCobros, cobros, retiros,
    esperado_ventas: r(enVentas), esperado_cambio: r(esperado - enVentas),
  };
}

async function resumenAbierto(t, ctx, caja) {
  const ultimo = await ultimoCierre(t, ctx.pid, caja.id);
  const mov = await t.get(
    `SELECT COALESCE(SUM(CASE WHEN tipo = 'INGRESO' THEN importe ELSE 0 END), 0) AS ingresos,
            COALESCE(SUM(CASE WHEN tipo = 'EGRESO' THEN importe ELSE 0 END), 0) AS egresos,
            COUNT(*) AS cantidad
     FROM predio_caja_movimiento WHERE predio_id = ? AND caja_id = ? AND cierre_id IS NULL`, [ctx.pid, caja.id]);
  const conceptos = await t.all(
    `SELECT concepto, tipo, COALESCE(SUM(importe), 0) AS total FROM predio_caja_movimiento
     WHERE predio_id = ? AND caja_id = ? AND cierre_id IS NULL GROUP BY concepto, tipo`, [ctx.pid, caja.id]);
  const saldo = await saldoCaja(t, ctx, caja.id);
  const ingresos = U.redondear(Number(mov.ingresos), 2);
  const egresos = U.redondear(Number(mov.egresos), 2);
  const saldoInicial = U.redondear(saldo - ingresos + egresos, 2);
  // Las fechas del predio tienen precisión de segundos. Las ventas posteriores
  // a un cierre pueden compartir su fecha; el ID guardado sí distingue el corte.
  const corte = ultimo && ultimo.ultima_venta_id === undefined ? "v.fecha>?" : "v.id>?";
  const desde = ultimo ? ultimo.ultima_venta_id ?? ultimo.fecha : 0;
  const parametros = [ctx.pid, caja.id, desde];
  const ventas = await t.all(
    `SELECT COALESCE(p.forma,v.forma_pago) AS forma_pago, COUNT(*) AS cantidad, SUM(COALESCE(p.importe,v.total)) AS total
     FROM predio_venta v LEFT JOIN predio_venta_pago p ON p.predio_id=v.predio_id AND p.venta_id=v.id
     WHERE v.predio_id=? AND v.caja_id=? AND ${corte} AND v.estado='CONFIRMADA' GROUP BY COALESCE(p.forma,v.forma_pago)`, parametros);
  const cantidades = await t.get(
    `SELECT COUNT(CASE WHEN v.estado='CONFIRMADA' THEN 1 END) AS confirmadas, COUNT(CASE WHEN v.estado='ANULADA' THEN 1 END) AS anuladas
     FROM predio_venta v WHERE v.predio_id=? AND v.caja_id=? AND ${corte}`, parametros);
  const porForma = ventas.map((v) => ({ forma_pago: v.forma_pago, cantidad: Number(v.cantidad), total: U.redondear(Number(v.total), 2) }));
  return {
    ultimo_cierre: ultimo || null,
    saldo_inicial: saldoInicial,
    ingresos,
    egresos,
    saldo_esperado: saldo,
    efectivo: separarEfectivo(saldoInicial, saldo, conceptos),
    ventas_cantidad: Number(cantidades.confirmadas),
    ventas_total: U.redondear(porForma.reduce((s, v) => s + v.total, 0), 2),
    ventas_efectivo: U.redondear(porForma.filter((v) => v.forma_pago === "EFECTIVO").reduce((s, v) => s + v.total, 0), 2),
    ventas_anuladas: Number(cantidades.anuladas),
    ventas_por_forma: porForma,
  };
}

async function estado(ctx) {
  const db = ctx.db;
  const cajaId = cajaDelPedido(ctx, ctx.query.caja_id);
  const caja = await exigirAccesoCaja(db, ctx, cajaId);
  const boca = await N.obtener(db, ctx, "predio_boca", caja.boca_id);
  const responsable = await turnoAbierto(db, ctx.pid, cajaId);
  const jornada = responsable ? responsable.inicio.slice(0, 10) : U.hoy();
  const apertura = await aperturaVigente(db, ctx.pid, cajaId, jornada);
  const resumen = await resumenAbierto(db, ctx, caja);
  let turno = null;
  const turnoId = turnoDeCaja(ctx, cajaId);
  if (turnoId) {
    turno = await db.get(
      `SELECT COUNT(*) AS cantidad, COALESCE(SUM(total), 0) AS total FROM predio_venta
       WHERE predio_id = ? AND turno_id = ? AND estado = 'CONFIRMADA'`, [ctx.pid, turnoId]);
    turno = { cantidad: Number(turno.cantidad), total: U.redondear(Number(turno.total), 2) };
  }
  return { caja, jornada, responsable, boca: boca ? { id: boca.id, nombre: boca.nombre } : null, apertura: apertura || null, resumen, turno };
}

async function cargarApertura(ctx) {
  exigirAdmin(ctx);
  const cajaId = U.id(ctx.body.caja_id, "La caja");
  const fecha = U.fecha(ctx.body.fecha || U.hoy(), { campo: "La fecha" });
  const importe = U.numero(ctx.body.importe, { min: 0, max: 99999999, campo: "El saldo de apertura" });
  const observacion = U.texto(ctx.body.observacion, { max: 255 });
  return ctx.db.tx(async (t) => {
    const caja = await N.exigir(t, ctx, "predio_caja", cajaId, "No encontramos la caja", { bloquear: true });
    const turno = await turnoAbierto(t, ctx.pid, cajaId);
    if (turno && turno.inicio.slice(0, 10) !== fecha) {
      throw U.error("Esta caja tiene un turno abierto del " + turno.inicio.slice(0, 10) + ". Cerralo antes de cargar la apertura de otra jornada.", 409);
    }
    const existente = await t.get("SELECT * FROM predio_apertura WHERE predio_id = ? AND caja_id = ? AND fecha = ?", [ctx.pid, cajaId, fecha]);
    const saldo = await saldoCaja(t, ctx, cajaId);
    // El movimiento lleva la caja exactamente al saldo declarado.
    const diferencia = U.redondear(importe - saldo, 2);
    let movimientoId = null;
    if (diferencia !== 0) {
      movimientoId = await N.insertar(t, ctx, "predio_caja_movimiento", {
        caja_id: cajaId, boca_id: caja.boca_id, fecha: U.fechaHora(), concepto: "SALDO_APERTURA",
        tipo: diferencia > 0 ? "INGRESO" : "EGRESO", importe: Math.abs(diferencia),
        observaciones: `Saldo de apertura declarado: ${U.pesos(importe)}${observacion ? ` · ${observacion}` : ""}`,
        usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      });
    }
    let id;
    if (existente) {
      id = existente.id;
      await N.actualizar(t, ctx, "predio_apertura", id, {
        importe, verificacion: "PENDIENTE", verificado_por: null, verificado_fecha: null, observacion, movimiento_id: movimientoId || existente.movimiento_id,
      });
    } else {
      id = await N.insertar(t, ctx, "predio_apertura", { caja_id: cajaId, fecha, importe, verificacion: "PENDIENTE", observacion, movimiento_id: movimientoId });
    }
    await N.auditar(t, ctx, existente ? "Corrección del saldo de apertura" : "Saldo de apertura", "caja", cajaId, {
      fecha, importe, anterior: existente ? Number(existente.importe) : undefined,
    });
    return { id, mensaje: `Saldo de apertura de ${caja.nombre}: ${U.pesos(importe)}` };
  });
}

async function verificarApertura(ctx) {
  const id = U.id(ctx.params.id);
  const correcto = ctx.body.correcto === true || ctx.body.correcto === 1 || ctx.body.correcto === "1";
  const observacion = U.texto(ctx.body.observacion, { max: 255 });
  const encontrado = ctx.body.efectivo_encontrado === undefined || ctx.body.efectivo_encontrado === null || ctx.body.efectivo_encontrado === ""
    ? null : U.numero(ctx.body.efectivo_encontrado, { min: 0, campo: "El efectivo encontrado" });
  return ctx.db.tx(async (t) => {
    const a = await N.exigir(t, ctx, "predio_apertura", id, "No encontramos el saldo de apertura", { bloquear: true });
    await exigirAccesoCaja(t, ctx, a.caja_id);
    const nota = [observacion, encontrado !== null ? `Encontró ${U.pesos(encontrado)}` : null].filter(Boolean).join(" · ") || null;
    await N.actualizar(t, ctx, "predio_apertura", id, {
      verificacion: correcto ? "CORRECTO" : "NO_COINCIDE", verificado_por: N.nombreActor(ctx), verificado_fecha: U.fechaHora(),
      observacion: nota || a.observacion,
    });
    await N.auditar(t, ctx, correcto ? "Saldo de apertura confirmado" : "Saldo de apertura NO coincide", "caja", a.caja_id, {
      apertura_id: id, importe_declarado: Number(a.importe), efectivo_encontrado: encontrado, observacion,
    });
    return {
      id,
      mensaje: correcto ? "Gracias. Quedó registrado que el saldo es correcto." : "Quedó registrado que el saldo no coincide. Comunicate con el administrador antes de empezar a cobrar.",
    };
  });
}

async function ajuste(ctx) {
  exigirAdmin(ctx);
  const b = ctx.body;
  const cajaId = U.id(b.caja_id, "La caja");
  const concepto = U.opcion(b.concepto, CONCEPTOS_AJUSTE, "El concepto");
  const tipo = U.opcion(b.tipo, ["INGRESO", "EGRESO"], "El tipo");
  const importe = U.numero(b.importe, { min: 0.01, max: 99999999, campo: "El importe" });
  const recibo = U.texto(b.recibo, { max: 40 });
  const observaciones = U.texto(b.observaciones, { max: 255 });
  return ctx.db.tx(async (t) => {
    const caja = await N.exigir(t, ctx, "predio_caja", cajaId, "No encontramos la caja", { bloquear: true });
    const saldo = await saldoCaja(t, ctx, cajaId);
    if (tipo === "EGRESO" && importe > saldo + 0.001 && !b.confirmar_saldo_negativo) {
      throw U.error(`La caja tiene ${U.pesos(saldo)}: si sacás ${U.pesos(importe)} queda en negativo`, 409, { codigo: "SALDO_NEGATIVO", saldo });
    }
    const id = await N.insertar(t, ctx, "predio_caja_movimiento", {
      caja_id: cajaId, boca_id: caja.boca_id, fecha: U.fechaHora(), concepto, tipo, importe, recibo, observaciones,
      turno_id: null, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
    });
    await N.auditar(t, ctx, "Ajuste de caja", "caja", cajaId, { concepto, tipo, importe, recibo, observaciones, saldo_anterior: saldo });
    return { id, saldo: U.redondear(saldo + (tipo === "INGRESO" ? importe : -importe), 2), mensaje: "Ajuste registrado" };
  });
}

function revisionResumen(r) {
  // La vista previa remota sale de MySQL; el escritor puede verificarla en SQLite.
  const formas = r.ventas_por_forma.map(v => [v.forma_pago, v.cantidad, v.total]).sort((a, b) => a[0].localeCompare(b[0]));
  return U.sha256(JSON.stringify([r.saldo_esperado, r.ingresos, r.egresos, r.ventas_cantidad, r.ventas_anuladas, formas]));
}

function esOperador(ctx, cajaId, turno) {
  return !!turno && Number(ctx.sesion?.caja_id) === Number(cajaId) && Number(turno.id) === Number(ctx.sesion?.turno_id);
}

async function previaCierre(ctx) {
  const cajaId = cajaDelPedido(ctx, ctx.query.caja_id);
  const caja = await exigirAccesoCaja(ctx.db, ctx, cajaId);
  const turno = await turnoAbierto(ctx.db, ctx.pid, cajaId);
  const resumen = await resumenAbierto(ctx.db, ctx, caja);
  return {
    caja, turno, resumen, revision: revisionResumen(resumen),
    // El cierre temporal lo hace quien atiende la caja; el definitivo, un administrador.
    puede_temporal: esOperador(ctx, cajaId, turno),
    definitivo_pide_admin: !esAdmin(ctx),
  };
}

function comprobarCorte(ctx, turno, ultimo) {
  const b = ctx.body;
  if ((ctx.origen === "REMOTO" && (b.turno_id === undefined || b.ultimo_cierre_id === undefined))
    || (b.turno_id !== undefined && Number(b.turno_id || 0) !== Number(turno?.id || 0))
    || (b.ultimo_cierre_id !== undefined && Number(b.ultimo_cierre_id || 0) !== Number(ultimo?.id || 0))) {
    throw U.error("El turno o el cierre cambió. Volvé a abrir el detalle de caja.", 409);
  }
}

function comprobarRevision(ctx, r) {
  if (ctx.body.revision && ctx.body.revision !== revisionResumen(r)) {
    throw U.error("Los movimientos de caja cambiaron. Revisá nuevamente el detalle antes de cerrar.", 409);
  }
}

async function exigirSinAnulacionesPendientes(t, ctx, cajaId, anterior) {
  const corte = anterior && anterior.ultima_venta_id === undefined ? "v.fecha>?" : "v.id>?";
  const pendiente = await t.get(`SELECT p.id FROM predio_permiso p JOIN predio_venta v ON v.predio_id=p.predio_id AND v.id=p.referencia_id
    WHERE p.predio_id=? AND v.caja_id=? AND p.tipo='ANULAR_VENTA' AND p.estado='PENDIENTE' AND v.estado='CONFIRMADA' AND ${corte} LIMIT 1`,
  [ctx.pid, cajaId, anterior?.ultima_venta_id ?? anterior?.fecha ?? 0]);
  if (pendiente) {
    throw U.error("Hay ventas pendientes de anulación. Un administrador debe confirmarlas o rechazarlas antes de cerrar la caja (puede hacerlo a distancia desde su cuenta).", 409, { codigo: "ANULACIONES_PENDIENTES" });
  }
}

// Asienta un cierre: lo registra, ajusta la diferencia, saca de la caja lo que se lleva,
// cierra los movimientos y el turno y libera el puesto.
async function asentarCierre(t, ctx, { caja, turno, r, contado, queda, observaciones, temporal, autorizacion, datos }) {
  const cajaId = Number(caja.id);
  const diferencia = U.redondear(contado - r.saldo_esperado, 2);
  const turnoId = turno?.id || null;
  const retiro = U.redondear(contado - queda, 2);
  const ahora = U.fechaHora();
  const cierreId = await N.insertar(t, ctx, "predio_cierre", {
    caja_id: cajaId, boca_id: caja.boca_id, fecha: ahora, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
    saldo_inicial: r.saldo_inicial, ingresos: r.ingresos, egresos: r.egresos, ventas_cantidad: r.ventas_cantidad,
    ventas_total: r.ventas_total, ventas_efectivo: r.ventas_efectivo, ventas_detalle: JSON.stringify(r.ventas_por_forma),
    saldo_esperado: r.saldo_esperado, efectivo_contado: contado, diferencia, retiro, queda_en_caja: queda, observaciones,
    tipo: temporal ? "TEMPORAL" : "DEFINITIVO", estado: temporal ? "PENDIENTE" : "CERRADO",
    turno_id: turnoId, turno_inicio: turno?.inicio || null, turno_usuario_nombre: turno?.usuario_nombre || null,
    esperado_ventas: r.efectivo.esperado_ventas, esperado_cambio: r.efectivo.esperado_cambio, efectivo_detalle: JSON.stringify(r.efectivo),
    autorizacion: autorizacion.metodo,
    ...datos(ahora),
  });
  if (diferencia !== 0) {
    await N.insertar(t, ctx, "predio_caja_movimiento", {
      caja_id: cajaId, boca_id: caja.boca_id, fecha: ahora, concepto: "OTROS", tipo: diferencia > 0 ? "INGRESO" : "EGRESO",
      importe: Math.abs(diferencia), observaciones: `${diferencia > 0 ? "Sobrante" : "Faltante"} en el cierre${temporal ? " temporal" : ""} N° ${cierreId}`,
      cierre_id: cierreId, turno_id: turnoId, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
    });
  }
  if (retiro > 0) {
    await N.insertar(t, ctx, "predio_caja_movimiento", {
      caja_id: cajaId, boca_id: caja.boca_id, fecha: ahora, concepto: temporal ? "CIERRE_TEMPORAL" : "CIERRE_CAJA", tipo: "EGRESO", importe: retiro,
      observaciones: temporal ? `Bolsas de recaudación y de cambio en custodia · cierre temporal N° ${cierreId}` : `Retiro de la recaudación · cierre N° ${cierreId}`,
      cierre_id: cierreId, turno_id: turnoId, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
    });
  }
  await t.run("UPDATE predio_caja_movimiento SET cierre_id = ? WHERE predio_id = ? AND caja_id = ? AND cierre_id IS NULL", [cierreId, ctx.pid, cajaId]);
  const ultimaVenta = await t.get("SELECT COALESCE(MAX(id),0) AS id FROM predio_venta WHERE predio_id=? AND caja_id=?", [ctx.pid, cajaId]);
  // Las instalaciones anteriores podían tener turnos superpuestos en una caja.
  // Un único cierre contable libera todos sus turnos y tokens asociados.
  await t.run("UPDATE predio_turno SET fin=?, estado='CERRADO' WHERE predio_id=? AND caja_id=? AND estado='ABIERTO'", [ahora, ctx.pid, cajaId]);
  if (t.dialecto === "sqlite") await t.run("UPDATE predio_sesion SET boca_id=NULL, caja_id=NULL, turno_id=NULL WHERE caja_id=?", [cajaId]);
  await N.auditar(t, ctx, temporal ? "Cierre temporal de caja" : "Cierre de caja", "caja", cajaId, {
    cierre_id: cierreId, turno_id: turnoId, inicio_turno: turno?.inicio || null, autorizacion, ultima_venta_id: Number(ultimaVenta.id),
    esperado: r.saldo_esperado, contado, diferencia, retiro, queda,
    ...(temporal ? { esperado_ventas: r.efectivo.esperado_ventas, esperado_cambio: r.efectivo.esperado_cambio } : {}),
  });
  return { cierreId, diferencia, retiro, ahora };
}

function textoDiferencia(diferencia) {
  return diferencia === 0 ? "sin diferencias" : `con ${diferencia > 0 ? "sobrante" : "faltante"} de ${U.pesos(Math.abs(diferencia))}`;
}

// Cierre definitivo de una caja abierta. Siempre lo hace un administrador.
async function cerrar(ctx) {
  const b = ctx.body;
  const cajaId = cajaDelPedido(ctx, b.caja_id);
  const contado = U.numero(b.efectivo_contado, { min: 0, max: 99999999, campo: "El efectivo contado" });
  const queda = U.numero(b.queda_en_caja ?? 0, { min: 0, max: 99999999, campo: "Lo que queda en la caja" });
  const observaciones = U.texto(b.observaciones, { max: 255 });
  if (queda > contado) throw U.error("Lo que queda en la caja no puede ser más que lo contado");
  let presente = null;
  if (!esAdmin(ctx)) {
    if (!String(b.admin_usuario ?? "").trim() && !String(b.admin_password ?? "")) {
      throw U.error("El cierre definitivo lo hace un administrador. Si no está, hacé un cierre temporal: guardás el efectivo en dos bolsas y el administrador lo cierra cuando llega.", 403, { codigo: "CIERRE_SOLO_ADMIN" });
    }
    presente = await verificarAdministrador(ctx, b.admin_usuario, b.admin_password);
  }
  return ctx.db.tx(async (t) => {
    const caja = await exigirAccesoCaja(t, ctx, cajaId, true);
    const turno = await turnoAbierto(t, ctx.pid, cajaId);
    if (!esAdmin(ctx)) {
      if (!esOperador(ctx, cajaId, turno)) throw U.error("Cerrá el turno en el que estás trabajando.", 403);
      await verificarOperador(t, ctx, cajaId);
    }
    const r = await resumenAbierto(t, ctx, caja);
    comprobarCorte(ctx, turno, r.ultimo_cierre);
    comprobarRevision(ctx, r);
    await exigirSinAnulacionesPendientes(t, ctx, cajaId, r.ultimo_cierre);
    const admin = presente || { id: ctx.usuario.id, nombre: N.nombreActor(ctx) };
    const autorizacion = presente
      ? { metodo: "ADMIN_PRESENTE", admin_id: presente.id, administrador: presente.nombre, admin_usuario: presente.usuario }
      : { metodo: "ADMIN", admin_id: ctx.usuario.id, administrador: N.nombreActor(ctx) };
    const c = await asentarCierre(t, ctx, {
      caja, turno, r, contado, queda, observaciones, temporal: false, autorizacion,
      datos: (ahora) => ({ definitivo_fecha: ahora, definitivo_usuario_id: admin.id || null, definitivo_usuario_nombre: admin.nombre }),
    });
    return {
      id: c.cierreId, tipo: "DEFINITIVO", diferencia: c.diferencia, retiro: c.retiro,
      mensaje: c.diferencia === 0 ? "Caja cerrada sin diferencias" : `Caja cerrada ${textoDiferencia(c.diferencia)}`,
    };
  });
}

// Cierre temporal: el cajero se va y no hay un administrador. El efectivo queda en dos
// bolsas con su ticket hasta que un administrador las recibe y hace el cierre definitivo.
async function cerrarTemporal(ctx) {
  const b = ctx.body;
  const cajaId = cajaDelPedido(ctx, b.caja_id);
  const enVentas = U.numero(b.efectivo_ventas, { min: 0, max: 99999999, campo: "El efectivo de la bolsa de recaudación" });
  const enCambio = U.numero(b.efectivo_cambio, { min: 0, max: 99999999, campo: "El efectivo de la bolsa de cambio" });
  const observaciones = U.texto(b.observaciones, { max: 255 });
  return ctx.db.tx(async (t) => {
    const caja = await exigirAccesoCaja(t, ctx, cajaId, true);
    const turno = await turnoAbierto(t, ctx.pid, cajaId);
    if (!esOperador(ctx, cajaId, turno)) throw U.error("El cierre temporal lo hace quien está atendiendo la caja, desde su turno.", 403, { codigo: "SIN_TURNO" });
    await verificarOperador(t, ctx, cajaId);
    const r = await resumenAbierto(t, ctx, caja);
    comprobarCorte(ctx, turno, r.ultimo_cierre);
    comprobarRevision(ctx, r);
    await exigirSinAnulacionesPendientes(t, ctx, cajaId, r.ultimo_cierre);
    const contado = U.redondear(enVentas + enCambio, 2);
    const autorizacion = { metodo: "TEMPORAL", cajero_id: ctx.usuario.id, cajero: N.nombreActor(ctx) };
    // Todo el efectivo se va en las bolsas: la caja queda en cero para el próximo cajero.
    const c = await asentarCierre(t, ctx, {
      caja, turno, r, contado, queda: 0, observaciones, temporal: true, autorizacion,
      datos: () => ({ efectivo_ventas: enVentas, efectivo_cambio: enCambio }),
    });
    const boca = await N.obtener(t, ctx, "predio_boca", caja.boca_id);
    await emitirAviso(t, ctx, {
      tipo: "CIERRE_TEMPORAL",
      titulo: `Cierre temporal N° ${c.cierreId} · ${boca?.nombre || "Caja"} · ${caja.nombre}`,
      mensaje: `${N.nombreActor(ctx)} cerró la caja en forma temporal (${textoDiferencia(c.diferencia)}). Dejó la bolsa de recaudación con ${U.pesos(enVentas)} y la de cambio con ${U.pesos(enCambio)}. Falta que un administrador reciba las bolsas y haga el cierre definitivo.`,
      detalle: { cierre_id: c.cierreId, caja_id: cajaId, efectivo_ventas: enVentas, efectivo_cambio: enCambio },
    });
    return {
      id: c.cierreId, tipo: "TEMPORAL", diferencia: c.diferencia, retiro: c.retiro,
      mensaje: `Cierre temporal N° ${c.cierreId} registrado ${textoDiferencia(c.diferencia)}. Guardá cada bolsa con su ticket.`,
    };
  });
}

// El administrador recibe las bolsas de un cierre temporal y lo cierra en forma definitiva.
// No toca los movimientos de la caja: el efectivo ya había salido al hacer el temporal.
async function definitivoDeTemporal(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id, "El cierre");
  const recVentas = U.numero(ctx.body.recibido_ventas, { min: 0, max: 99999999, campo: "Lo que hay en la bolsa de recaudación" });
  const recCambio = U.numero(ctx.body.recibido_cambio, { min: 0, max: 99999999, campo: "Lo que hay en la bolsa de cambio" });
  const observaciones = U.texto(ctx.body.observaciones, { max: 255 });
  return ctx.db.tx(async (t) => {
    const c = await N.exigir(t, ctx, "predio_cierre", id, "No encontramos el cierre", { bloquear: true });
    if (c.tipo !== "TEMPORAL") throw U.error("Ese cierre ya es definitivo.", 409);
    if (c.estado !== "PENDIENTE") {
      throw U.error(`Ese cierre temporal ya lo cerró ${c.definitivo_usuario_nombre || "un administrador"}${c.definitivo_fecha ? ` el ${c.definitivo_fecha}` : ""}.`, 409, { codigo: "CIERRE_YA_DEFINITIVO" });
    }
    const declarado = U.redondear(Number(c.efectivo_ventas || 0) + Number(c.efectivo_cambio || 0), 2);
    const recibido = U.redondear(recVentas + recCambio, 2);
    const diferencia = U.redondear(recibido - declarado, 2);
    const ahora = U.fechaHora();
    await N.actualizar(t, ctx, "predio_cierre", id, {
      estado: "CERRADO", definitivo_fecha: ahora, definitivo_usuario_id: ctx.usuario.id || null, definitivo_usuario_nombre: N.nombreActor(ctx),
      recibido_ventas: recVentas, recibido_cambio: recCambio, diferencia_recepcion: diferencia, observaciones_definitivo: observaciones,
    });
    await N.auditar(t, ctx, "Cierre definitivo de cierre temporal", "caja", c.caja_id, {
      cierre_id: id, declarado, recibido, recibido_ventas: recVentas, recibido_cambio: recCambio, diferencia, observaciones,
    });
    return {
      id, diferencia_recepcion: diferencia,
      mensaje: diferencia === 0 ? `Cierre N° ${id} cerrado en forma definitiva: las bolsas coinciden con lo declarado`
        : `Cierre N° ${id} cerrado en forma definitiva con ${diferencia > 0 ? "sobrante" : "faltante"} de ${U.pesos(Math.abs(diferencia))} respecto de lo declarado`,
    };
  });
}

const SQL_CIERRE = `SELECT ci.*, ca.nombre AS caja, ca.ancho_ticket, b.nombre AS boca FROM predio_cierre ci
  JOIN predio_caja ca ON ca.predio_id = ci.predio_id AND ca.id = ci.caja_id
  JOIN predio_boca b ON b.predio_id = ci.predio_id AND b.id = ci.boca_id`;

function leerJson(texto, base) {
  try { return JSON.parse(texto || "null") ?? base; } catch (_e) { return base; }
}

async function detalleCierre(ctx) {
  const id = U.id(ctx.params.id);
  const c = await ctx.db.get(`${SQL_CIERRE} WHERE ci.predio_id = ? AND ci.id = ?`, [ctx.pid, id]);
  if (!c) throw U.error("No encontramos el cierre", 404);
  if (!esAdmin(ctx) && !bocasDe(ctx).includes(Number(c.boca_id))) throw U.error("No tenés acceso a este cierre", 403);
  const config = await N.leerConfig(ctx.db, ctx);
  return {
    cierre: { ...c, tipo: c.tipo || "DEFINITIVO", estado: c.estado || "CERRADO" },
    ancho: Number(c.ancho_ticket) === 58 ? 58 : 80, ventas_por_forma: leerJson(c.ventas_detalle, []), efectivo: leerJson(c.efectivo_detalle, null),
    empresa: { nombre_predio: config.nombre_predio, razon_social: config.razon_social },
  };
}

// Cierres temporales que esperan que un administrador reciba las bolsas.
async function temporalesPendientes(ctx) {
  exigirAdmin(ctx);
  const filas = await ctx.db.all(`${SQL_CIERRE} WHERE ci.predio_id = ? AND ci.tipo = 'TEMPORAL' AND ci.estado = 'PENDIENTE' ORDER BY ci.id`, [ctx.pid]);
  return { cierres: filas.map((c) => ({ ...c, efectivo: leerJson(c.efectivo_detalle, null) })) };
}

// Resumen de todas las cajas para el administrador.
async function panelCajas(ctx) {
  exigirAdmin(ctx);
  const cajas = await ctx.db.all(
    `SELECT c.id, c.nombre, c.boca_id, b.nombre AS boca FROM predio_caja c
     JOIN predio_boca b ON b.predio_id = c.predio_id AND b.id = c.boca_id
     WHERE c.predio_id = ? AND c.activo = 1 ORDER BY b.nombre, c.nombre`, [ctx.pid]);
  const temporales = (await temporalesPendientes(ctx)).cierres;
  const salida = [];
  for (const c of cajas) {
    const r = await resumenAbierto(ctx.db, ctx, c);
    const turno = await turnoAbierto(ctx.db, ctx.pid, c.id);
    const jornada = turno ? turno.inicio.slice(0, 10) : U.hoy();
    const apertura = await aperturaVigente(ctx.db, ctx.pid, c.id, jornada, "a.id, a.importe, a.verificacion, a.verificado_por");
    salida.push({
      ...c, saldo: r.saldo_esperado, ventas_cantidad: r.ventas_cantidad, ventas_total: r.ventas_total, ultimo_cierre: r.ultimo_cierre,
      apertura: apertura || null, turno: turno || null,
      temporales_pendientes: temporales.filter((x) => Number(x.caja_id) === Number(c.id)).length,
    });
  }
  return { cajas: salida, temporales };
}

async function configurarComanda(ctx) {
  const id = U.id(ctx.params.id, "La caja");
  if (typeof ctx.body.imprimir_comanda !== "boolean") throw U.error("Indicá si la caja imprime comanda");
  if (!esAdmin(ctx) && Number(ctx.sesion?.caja_id) !== id) throw U.error("Sólo podés cambiar la comanda de la caja en la que estás trabajando", 403);
  return ctx.db.tx(async (t) => {
    const caja = await exigirAccesoCaja(t, ctx, id);
    if (!Number(caja.activo)) throw U.error("La caja está deshabilitada", 409);
    await N.actualizar(t, ctx, "predio_caja", id, { imprimir_comanda: ctx.body.imprimir_comanda ? 1 : 0 });
    if (!!Number(caja.imprimir_comanda) !== ctx.body.imprimir_comanda) {
      await N.auditar(t, ctx, "Configuración de comanda de caja", "caja", id, { imprimir_comanda: { antes: !!Number(caja.imprimir_comanda), despues: ctx.body.imprimir_comanda } });
    }
    return { id, imprimir_comanda: ctx.body.imprimir_comanda, mensaje: ctx.body.imprimir_comanda ? "Esta caja imprimirá una copia para preparación" : "Esta caja imprimirá sólo el ticket del cliente" };
  });
}

module.exports = {
  ultimoCierre,
  saldoCaja,
  separarEfectivo,
  APERTURA_VIGENTE,
  rutas: [
    { m: "GET", p: "/caja/estado", h: estado },
    { m: "GET", p: "/caja/panel", h: panelCajas, roles: ["ADMIN"] },
    { m: "POST", p: "/cajas/:id/comanda", h: configurarComanda, escritura: true },
    { m: "POST", p: "/caja/apertura", h: cargarApertura, escritura: true, roles: ["ADMIN"] },
    { m: "POST", p: "/caja/apertura/:id/verificar", h: verificarApertura, escritura: true },
    { m: "POST", p: "/caja/ajuste", h: ajuste, escritura: true, roles: ["ADMIN"] },
    { m: "GET", p: "/caja/cierre/previa", h: previaCierre },
    { m: "POST", p: "/caja/cierre", h: cerrar, escritura: true },
    { m: "POST", p: "/caja/cierre/temporal", h: cerrarTemporal, escritura: true, soloLocal: true },
    { m: "GET", p: "/caja/temporales", h: temporalesPendientes, roles: ["ADMIN"] },
    { m: "GET", p: "/caja/cierres/:id", h: detalleCierre },
    { m: "POST", p: "/caja/cierres/:id/definitivo", h: definitivoDeTemporal, escritura: true, roles: ["ADMIN"] },
  ],
};
