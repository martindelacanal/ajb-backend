"use strict";

// Caja: saldo de apertura (lo carga el administrador y lo confirma el cajero),
// ajustes manuales, cierre de caja y estado del día. El saldo de cada caja es la suma
// de sus movimientos: ingresos menos egresos.

const U = require("../util");
const N = require("../negocio");
const { exigirAdmin, esAdmin, bocasDe, turnoDeCaja } = require("./comun");

const CONCEPTOS_AJUSTE = ["CIERRE_CAJA", "INGRESO_DINERO", "RETIRO_DINERO", "OTROS"];

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

async function exigirAccesoCaja(t, ctx, cajaId) {
  const caja = await N.exigir(t, ctx, "predio_caja", cajaId, "No encontramos la caja");
  if (!esAdmin(ctx) && Number(ctx.sesion?.caja_id) !== Number(cajaId) && !bocasDe(ctx).includes(Number(caja.boca_id))) {
    throw U.error("No tenés acceso a esa caja", 403);
  }
  return caja;
}

async function resumenAbierto(t, ctx, caja) {
  const ultimo = await t.get("SELECT id, fecha FROM predio_cierre WHERE predio_id = ? AND caja_id = ? ORDER BY id DESC LIMIT 1", [ctx.pid, caja.id]);
  const mov = await t.get(
    `SELECT COALESCE(SUM(CASE WHEN tipo = 'INGRESO' THEN importe ELSE 0 END), 0) AS ingresos,
            COALESCE(SUM(CASE WHEN tipo = 'EGRESO' THEN importe ELSE 0 END), 0) AS egresos,
            COUNT(*) AS cantidad
     FROM predio_caja_movimiento WHERE predio_id = ? AND caja_id = ? AND cierre_id IS NULL`, [ctx.pid, caja.id]);
  const saldo = await saldoCaja(t, ctx, caja.id);
  const ingresos = U.redondear(Number(mov.ingresos), 2);
  const egresos = U.redondear(Number(mov.egresos), 2);
  const desde = ultimo ? ultimo.fecha : "0000-00-00 00:00:00";
  const ventas = await t.all(
    `SELECT forma_pago, COUNT(*) AS cantidad, COALESCE(SUM(total), 0) AS total FROM predio_venta
     WHERE predio_id = ? AND caja_id = ? AND estado = 'CONFIRMADA' AND fecha > ? GROUP BY forma_pago`,
    [ctx.pid, caja.id, desde]);
  const anuladas = await t.get(
    "SELECT COUNT(*) AS n FROM predio_venta WHERE predio_id = ? AND caja_id = ? AND estado = 'ANULADA' AND fecha > ?",
    [ctx.pid, caja.id, desde]);
  const porForma = ventas.map((v) => ({ forma_pago: v.forma_pago, cantidad: Number(v.cantidad), total: U.redondear(Number(v.total), 2) }));
  return {
    ultimo_cierre: ultimo || null,
    saldo_inicial: U.redondear(saldo - ingresos + egresos, 2),
    ingresos,
    egresos,
    saldo_esperado: saldo,
    ventas_cantidad: porForma.reduce((s, v) => s + v.cantidad, 0),
    ventas_total: U.redondear(porForma.reduce((s, v) => s + v.total, 0), 2),
    ventas_efectivo: U.redondear(porForma.filter((v) => v.forma_pago === "EFECTIVO").reduce((s, v) => s + v.total, 0), 2),
    ventas_anuladas: Number(anuladas?.n || 0),
    ventas_por_forma: porForma,
  };
}

async function estado(ctx) {
  const db = ctx.db;
  const cajaId = cajaDelPedido(ctx, ctx.query.caja_id);
  const caja = await exigirAccesoCaja(db, ctx, cajaId);
  const boca = await N.obtener(db, ctx, "predio_boca", caja.boca_id);
  const apertura = await db.get("SELECT * FROM predio_apertura WHERE predio_id = ? AND caja_id = ? AND fecha = ?", [ctx.pid, cajaId, U.hoy()]);
  const resumen = await resumenAbierto(db, ctx, caja);
  let turno = null;
  const turnoId = turnoDeCaja(ctx, cajaId);
  if (turnoId) {
    turno = await db.get(
      `SELECT COUNT(*) AS cantidad, COALESCE(SUM(total), 0) AS total FROM predio_venta
       WHERE predio_id = ? AND turno_id = ? AND estado = 'CONFIRMADA'`, [ctx.pid, turnoId]);
    turno = { cantidad: Number(turno.cantidad), total: U.redondear(Number(turno.total), 2) };
  }
  return { caja, boca: boca ? { id: boca.id, nombre: boca.nombre } : null, apertura: apertura || null, resumen, turno };
}

async function cargarApertura(ctx) {
  exigirAdmin(ctx);
  const cajaId = U.id(ctx.body.caja_id, "La caja");
  const fecha = U.fecha(ctx.body.fecha || U.hoy(), { campo: "La fecha" });
  const importe = U.numero(ctx.body.importe, { min: 0, max: 99999999, campo: "El saldo de apertura" });
  const observacion = U.texto(ctx.body.observacion, { max: 255 });
  return ctx.db.tx(async (t) => {
    const caja = await N.exigir(t, ctx, "predio_caja", cajaId, "No encontramos la caja");
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
    const caja = await N.exigir(t, ctx, "predio_caja", cajaId, "No encontramos la caja");
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

async function previaCierre(ctx) {
  const cajaId = cajaDelPedido(ctx, ctx.query.caja_id);
  const caja = await exigirAccesoCaja(ctx.db, ctx, cajaId);
  return { caja, resumen: await resumenAbierto(ctx.db, ctx, caja) };
}

async function cerrar(ctx) {
  const b = ctx.body;
  const cajaId = cajaDelPedido(ctx, b.caja_id);
  const contado = U.numero(b.efectivo_contado, { min: 0, max: 99999999, campo: "El efectivo contado" });
  const queda = U.numero(b.queda_en_caja ?? 0, { min: 0, max: 99999999, campo: "Lo que queda en la caja" });
  const observaciones = U.texto(b.observaciones, { max: 255 });
  if (queda > contado) throw U.error("Lo que queda en la caja no puede ser más que lo contado");
  return ctx.db.tx(async (t) => {
    const caja = await exigirAccesoCaja(t, ctx, cajaId);
    if (!esAdmin(ctx) && Number(ctx.sesion?.caja_id) !== cajaId) throw U.error("Cerrá la caja en la que estás trabajando", 403);
    const r = await resumenAbierto(t, ctx, caja);
    const diferencia = U.redondear(contado - r.saldo_esperado, 2);
    const turnoId = turnoDeCaja(ctx, cajaId);
    const retiro = U.redondear(contado - queda, 2);
    const ahora = U.fechaHora();
    const cierreId = await N.insertar(t, ctx, "predio_cierre", {
      caja_id: cajaId, boca_id: caja.boca_id, fecha: ahora, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      saldo_inicial: r.saldo_inicial, ingresos: r.ingresos, egresos: r.egresos, ventas_cantidad: r.ventas_cantidad,
      ventas_total: r.ventas_total, ventas_efectivo: r.ventas_efectivo, ventas_detalle: JSON.stringify(r.ventas_por_forma),
      saldo_esperado: r.saldo_esperado, efectivo_contado: contado, diferencia, retiro, queda_en_caja: queda, observaciones,
    });
    if (diferencia !== 0) {
      await N.insertar(t, ctx, "predio_caja_movimiento", {
        caja_id: cajaId, boca_id: caja.boca_id, fecha: ahora, concepto: "OTROS", tipo: diferencia > 0 ? "INGRESO" : "EGRESO",
        importe: Math.abs(diferencia), observaciones: `${diferencia > 0 ? "Sobrante" : "Faltante"} en el cierre N° ${cierreId}`,
        cierre_id: cierreId, turno_id: turnoId, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      });
    }
    if (retiro > 0) {
      await N.insertar(t, ctx, "predio_caja_movimiento", {
        caja_id: cajaId, boca_id: caja.boca_id, fecha: ahora, concepto: "CIERRE_CAJA", tipo: "EGRESO", importe: retiro,
        observaciones: `Retiro de la recaudación · cierre N° ${cierreId}`, cierre_id: cierreId,
        turno_id: turnoId, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      });
    }
    await t.run("UPDATE predio_caja_movimiento SET cierre_id = ? WHERE predio_id = ? AND caja_id = ? AND cierre_id IS NULL", [cierreId, ctx.pid, cajaId]);
    await N.auditar(t, ctx, "Cierre de caja", "caja", cajaId, { cierre_id: cierreId, esperado: r.saldo_esperado, contado, diferencia, retiro, queda });
    return { id: cierreId, diferencia, retiro, mensaje: diferencia === 0 ? "Caja cerrada sin diferencias" : `Caja cerrada con ${diferencia > 0 ? "sobrante" : "faltante"} de ${U.pesos(Math.abs(diferencia))}` };
  });
}

async function detalleCierre(ctx) {
  const id = U.id(ctx.params.id);
  const c = await ctx.db.get(
    `SELECT ci.*, ca.nombre AS caja, ca.ancho_ticket, b.nombre AS boca FROM predio_cierre ci
     JOIN predio_caja ca ON ca.predio_id = ci.predio_id AND ca.id = ci.caja_id
     JOIN predio_boca b ON b.predio_id = ci.predio_id AND b.id = ci.boca_id
     WHERE ci.predio_id = ? AND ci.id = ?`, [ctx.pid, id]);
  if (!c) throw U.error("No encontramos el cierre", 404);
  if (!esAdmin(ctx) && !bocasDe(ctx).includes(Number(c.boca_id))) throw U.error("No tenés acceso a este cierre", 403);
  let detalle = [];
  try { detalle = JSON.parse(c.ventas_detalle || "[]"); } catch (_e) { detalle = []; }
  const config = await N.leerConfig(ctx.db, ctx);
  return {
    cierre: c, ancho: Number(c.ancho_ticket) === 58 ? 58 : 80, ventas_por_forma: detalle,
    empresa: { nombre_predio: config.nombre_predio, razon_social: config.razon_social },
  };
}

// Resumen de todas las cajas para el administrador.
async function panelCajas(ctx) {
  exigirAdmin(ctx);
  const cajas = await ctx.db.all(
    `SELECT c.id, c.nombre, c.boca_id, b.nombre AS boca FROM predio_caja c
     JOIN predio_boca b ON b.predio_id = c.predio_id AND b.id = c.boca_id
     WHERE c.predio_id = ? AND c.activo = 1 ORDER BY b.nombre, c.nombre`, [ctx.pid]);
  const salida = [];
  for (const c of cajas) {
    const r = await resumenAbierto(ctx.db, ctx, c);
    const apertura = await ctx.db.get("SELECT id, importe, verificacion, verificado_por FROM predio_apertura WHERE predio_id = ? AND caja_id = ? AND fecha = ?", [ctx.pid, c.id, U.hoy()]);
    const turno = await ctx.db.get("SELECT usuario_nombre, inicio FROM predio_turno WHERE predio_id = ? AND caja_id = ? AND estado = 'ABIERTO' ORDER BY id DESC LIMIT 1", [ctx.pid, c.id]);
    salida.push({ ...c, saldo: r.saldo_esperado, ventas_cantidad: r.ventas_cantidad, ventas_total: r.ventas_total, ultimo_cierre: r.ultimo_cierre, apertura: apertura || null, turno: turno || null });
  }
  return { cajas: salida };
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
  saldoCaja,
  rutas: [
    { m: "GET", p: "/caja/estado", h: estado },
    { m: "GET", p: "/caja/panel", h: panelCajas, roles: ["ADMIN"] },
    { m: "POST", p: "/cajas/:id/comanda", h: configurarComanda, escritura: true },
    { m: "POST", p: "/caja/apertura", h: cargarApertura, escritura: true, roles: ["ADMIN"] },
    { m: "POST", p: "/caja/apertura/:id/verificar", h: verificarApertura, escritura: true },
    { m: "POST", p: "/caja/ajuste", h: ajuste, escritura: true, roles: ["ADMIN"] },
    { m: "GET", p: "/caja/cierre/previa", h: previaCierre },
    { m: "POST", p: "/caja/cierre", h: cerrar, escritura: true },
    { m: "GET", p: "/caja/cierres/:id", h: detalleCierre },
  ],
};
