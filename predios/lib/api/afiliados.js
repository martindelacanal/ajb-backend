"use strict";

// Afiliados del predio: los que tienen reservas en el sistema general (se sincronizan)
// y los cargados a mano mientras tanto. Límite para consumir con descuento de haberes,
// modificación masiva y liquidación (forma de pago, descuento %, cuotas e impresión).

const U = require("../util");
const N = require("../negocio");
const { FORMAS_LIQUIDACION, construirWhere, LISTADOS, traducir } = require("../listados");
const { exigirAdmin, disponibleAfiliado } = require("./comun");

const FORMAS_LIQ = FORMAS_LIQUIDACION.map((f) => f.valor);

function limpiarDni(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d ? String(Number(d)) : null;
}

async function buscar(ctx) {
  const q = String(ctx.query.q || "").trim().slice(0, 60);
  if (!q) return { resultados: [] };
  const db = ctx.db;
  const numero = q.replace(/[.\s-]/g, "");
  const params = [ctx.pid];
  let where;
  if (/^\d+$/.test(numero)) {
    where = "(a.dni = ? OR a.legajo = ? OR a.legajo = ?)";
    params.push(String(Number(numero)), numero, q);
  } else {
    if (q.length < 3) return { resultados: [] };
    where = `${db.buscar("a.nombre")} LIKE ?`;
    params.push(`%${db.normParam(q)}%`);
  }
  const filas = await db.all(
    `SELECT a.id, a.nombre, a.dni, a.legajo, a.limite, a.habilitado_descuento, a.origen, d.nombre AS departamental
     FROM predio_afiliado a LEFT JOIN predio_departamental d ON d.predio_id = a.predio_id AND d.id = a.departamental_id
     WHERE a.predio_id = ? AND ${where} ORDER BY a.nombre LIMIT 10`, params);
  const hoy = U.hoy();
  const resultados = [];
  for (const f of filas) {
    const disp = await disponibleAfiliado(db, ctx, f.id);
    const estadia = await db.get(
      `SELECT fecha_inicio, fecha_fin, servicio, unidad FROM predio_estadia
       WHERE predio_id = ? AND afiliado_id = ? AND activo = 1 AND fecha_fin >= ? ORDER BY fecha_inicio LIMIT 1`,
      [ctx.pid, f.id, U.sumarDias(hoy, -1)]);
    resultados.push({
      id: f.id, nombre: f.nombre, dni: f.dni, legajo: f.legajo, departamental: f.departamental, origen: f.origen,
      habilitado_descuento: !!Number(f.habilitado_descuento), limite: disp.limite, disponible: disp.disponible,
      estadia: estadia || null, en_predio: !!estadia && estadia.fecha_inicio <= hoy && estadia.fecha_fin >= hoy,
    });
  }
  return { resultados };
}

async function detalle(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id);
  const db = ctx.db;
  const a = await db.get(
    `SELECT a.*, d.nombre AS departamental FROM predio_afiliado a
     LEFT JOIN predio_departamental d ON d.predio_id = a.predio_id AND d.id = a.departamental_id
     WHERE a.predio_id = ? AND a.id = ?`, [ctx.pid, id]);
  if (!a) throw U.error("No encontramos al afiliado", 404);
  const estadias = await db.all("SELECT * FROM predio_estadia WHERE predio_id = ? AND afiliado_id = ? ORDER BY fecha_inicio DESC", [ctx.pid, id]);
  const disp = await disponibleAfiliado(db, ctx, id);
  const consumos = await db.all(
    `SELECT forma_pago, COUNT(*) AS cantidad, COALESCE(SUM(total), 0) AS total FROM predio_venta
     WHERE predio_id = ? AND afiliado_id = ? AND estado = 'CONFIRMADA' GROUP BY forma_pago`, [ctx.pid, id]);
  const pendientes = await db.get(
    `SELECT COUNT(*) AS cantidad, MIN(fecha) AS desde, MAX(fecha) AS hasta, COALESCE(SUM(COALESCE(importe_haberes,total)), 0) AS total FROM predio_venta
     WHERE predio_id = ? AND afiliado_id = ? AND estado = 'CONFIRMADA' AND (forma_pago = 'DESCUENTO' OR importe_haberes>0) AND liquidacion_id IS NULL`, [ctx.pid, id]);
  return {
    afiliado: a,
    estadias,
    disponible: disp,
    consumos: consumos.map((c) => ({ forma_pago: c.forma_pago, cantidad: Number(c.cantidad), total: U.redondear(Number(c.total)) })),
    pendiente_liquidar: {
      cantidad: Number(pendientes.cantidad || 0), total: U.redondear(Number(pendientes.total || 0)),
      desde: pendientes.desde, hasta: pendientes.hasta,
    },
  };
}

function validarAfiliado(body) {
  const dni = limpiarDni(body.dni);
  if (dni && (dni.length < 6 || dni.length > 8)) throw U.error("El DNI tiene que tener entre 6 y 8 números");
  const legajo = U.texto(body.legajo, { max: 30, campo: "El legajo" });
  if (!dni && !legajo) throw U.error("Cargá el DNI o el legajo del afiliado");
  return {
    dni,
    legajo,
    nombre: U.texto(body.nombre, { max: 160, campo: "El nombre", requerido: true }),
    departamental_id: body.departamental_id ? U.id(body.departamental_id, "La departamental") : null,
    limite: U.numero(body.limite ?? 0, { min: 0, max: 99999999, campo: "El límite de descuento" }),
    habilitado_descuento: body.habilitado_descuento === undefined ? 1 : U.bool(body.habilitado_descuento),
    observaciones: U.texto(body.observaciones, { max: 255 }),
  };
}

async function crearManual(ctx) {
  exigirAdmin(ctx);
  const datos = validarAfiliado(ctx.body);
  return ctx.db.tx(async (t) => {
    const dup = await t.get(
      `SELECT id, nombre FROM predio_afiliado WHERE predio_id = ? AND ((? IS NOT NULL AND dni = ?) OR (? IS NOT NULL AND legajo = ?)) LIMIT 1`,
      [ctx.pid, datos.dni, datos.dni, datos.legajo, datos.legajo]);
    if (dup) throw U.error(`Ese afiliado ya está cargado: ${dup.nombre}`, 409, { id: dup.id });
    const id = await N.insertar(t, ctx, "predio_afiliado", { ...datos, origen: "MANUAL" });
    await N.insertar(t, ctx, "predio_limite_historial", {
      afiliado_id: id, fecha: U.fechaHora(), limite_anterior: 0, limite_nuevo: datos.limite, motivo: "ALTA", usuario_nombre: N.nombreActor(ctx),
    });
    await N.auditar(t, ctx, "Alta manual de afiliado", "afiliado", id, datos);
    return { id, mensaje: "Afiliado agregado. Cuando se sincronice con el sistema general se une solo con su ficha." };
  });
}

async function editar(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id);
  return ctx.db.tx(async (t) => {
    const antes = await N.exigir(t, ctx, "predio_afiliado", id, "No encontramos al afiliado", { bloquear: true });
    let datos;
    if (antes.origen === "SISTEMA") {
      // Los datos personales vienen del sistema general: acá sólo se cambia el límite.
      datos = {};
      if (ctx.body.limite !== undefined) datos.limite = U.numero(ctx.body.limite, { min: 0, max: 99999999, campo: "El límite de descuento" });
      if (ctx.body.habilitado_descuento !== undefined) datos.habilitado_descuento = U.bool(ctx.body.habilitado_descuento);
      if (ctx.body.observaciones !== undefined) datos.observaciones = U.texto(ctx.body.observaciones, { max: 255 });
    } else {
      datos = validarAfiliado({ ...antes, ...ctx.body });
    }
    await N.actualizar(t, ctx, "predio_afiliado", id, datos);
    if (datos.limite !== undefined && Number(antes.limite || 0) !== datos.limite) {
      await N.insertar(t, ctx, "predio_limite_historial", {
        afiliado_id: id, fecha: U.fechaHora(), limite_anterior: Number(antes.limite || 0), limite_nuevo: datos.limite,
        motivo: "INDIVIDUAL", usuario_nombre: N.nombreActor(ctx),
      });
    }
    const cambios = N.diferencias(antes, await N.obtener(t, ctx, "predio_afiliado", id));
    if (Object.keys(cambios).length) await N.auditar(t, ctx, "Modificación de afiliado", "afiliado", id, cambios);
    return { id, mensaje: "Afiliado actualizado" };
  });
}

function whereMasivo(ctx, filtros) {
  const query = {};
  for (const [k, v] of Object.entries(filtros || {})) {
    if (v !== undefined && v !== null && v !== "") query[`f_${k}`] = String(v);
  }
  if (filtros?.q) query.q = String(filtros.q);
  return construirWhere(LISTADOS.afiliados, ctx, query, ctx.db);
}

async function previaMasivo(ctx) {
  exigirAdmin(ctx);
  const { sql, valores, nombres } = whereMasivo(ctx, ctx.body.filtros);
  const valoresFrom = [];
  const from = traducir(LISTADOS.afiliados.from, valoresFrom, nombres);
  const conteo = await ctx.db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(a.limite, 0)), 0) AS suma FROM ${from} WHERE ${sql}`, [...valoresFrom, ...valores]);
  const muestra = await ctx.db.all(
    `SELECT a.id, a.nombre, a.dni, a.legajo, COALESCE(a.limite, 0) AS limite, d.nombre AS departamental FROM ${from} WHERE ${sql} ORDER BY a.nombre LIMIT 8`,
    [...valoresFrom, ...valores]);
  return { cantidad: Number(conteo.n || 0), suma_limites: U.redondear(Number(conteo.suma || 0)), muestra };
}

async function aplicarMasivo(ctx) {
  exigirAdmin(ctx);
  const nuevo = U.numero(ctx.body.nuevo_limite, { min: 0, max: 99999999, campo: "El nuevo límite" });
  const { sql, valores, nombres } = whereMasivo(ctx, ctx.body.filtros);
  return ctx.db.tx(async (t) => {
    const valoresFrom = [];
    const from = traducir(LISTADOS.afiliados.from, valoresFrom, nombres);
    const filas = await t.all(`SELECT a.id, COALESCE(a.limite, 0) AS limite FROM ${from} WHERE ${sql}`, [...valoresFrom, ...valores]);
    if (!filas.length) throw U.error("Ningún afiliado coincide con esos filtros", 404);
    if (filas.length > 20000) throw U.error("Son demasiados afiliados para una sola modificación: ajustá los filtros");
    const lote = `M${Date.now().toString(36)}`;
    const ahora = U.fechaHora();
    let modificados = 0;
    for (const f of filas) {
      if (Number(f.limite) === nuevo) continue;
      await N.actualizar(t, ctx, "predio_afiliado", f.id, { limite: nuevo });
      await N.insertar(t, ctx, "predio_limite_historial", {
        afiliado_id: f.id, fecha: ahora, limite_anterior: Number(f.limite), limite_nuevo: nuevo, motivo: "MASIVO", lote, usuario_nombre: N.nombreActor(ctx),
      });
      modificados++;
    }
    await N.auditar(t, ctx, "Modificación masiva de límites", "afiliado", null, { filtros: ctx.body.filtros, nuevo_limite: nuevo, coincidencias: filas.length, modificados, lote });
    return { modificados, coincidencias: filas.length, lote, mensaje: `Se actualizó el límite de ${modificados} afiliado${modificados === 1 ? "" : "s"}` };
  });
}

// ------------------------------------------------------------------ liquidaciones

async function crearLiquidacion(ctx) {
  exigirAdmin(ctx);
  const afiliadoId = U.id(ctx.params.id);
  const b = ctx.body;
  const forma = U.opcion(b.forma_pago, FORMAS_LIQ, "La forma de pago");
  const porcentaje = U.numero(b.porcentaje_descuento ?? 0, { min: 0, max: 100, campo: "El porcentaje de descuento" });
  const cuotas = U.entero(b.cuotas ?? 1, { min: 1, max: 24, campo: "La cantidad de cuotas" });
  const pagada = U.bool(b.pagada);
  const recibo = U.texto(b.recibo, { max: 40 });
  const observaciones = U.texto(b.observaciones, { max: 255 });
  const cajaId = b.caja_id ? U.id(b.caja_id, "La caja") : null;
  if (forma === "DESCUENTO_HABERES" && pagada) throw U.error("El descuento de haberes queda pendiente hasta que la departamental lo cobre");
  return ctx.db.tx(async (t) => {
    const a = await N.exigir(t, ctx, "predio_afiliado", afiliadoId, "No encontramos al afiliado", { bloquear: true });
    const ventas = await t.all(
      `SELECT id, fecha, COALESCE(importe_haberes,total) AS total FROM predio_venta WHERE predio_id = ? AND afiliado_id = ? AND estado = 'CONFIRMADA'
       AND (forma_pago='DESCUENTO' OR importe_haberes>0) AND liquidacion_id IS NULL ORDER BY fecha, id${t.forUpdate}`, [ctx.pid, afiliadoId]);
    if (!ventas.length) throw U.error("El afiliado no tiene consumos por descuento pendientes de liquidar", 409);
    const pendiente = await t.get(`SELECT v.id FROM predio_venta v JOIN predio_permiso p ON p.predio_id=v.predio_id AND p.referencia_id=v.id
      WHERE v.predio_id=? AND v.afiliado_id=? AND v.estado='CONFIRMADA' AND (v.forma_pago='DESCUENTO' OR v.importe_haberes>0)
      AND v.liquidacion_id IS NULL AND p.tipo='ANULAR_VENTA' AND p.estado='PENDIENTE' LIMIT 1${t.forUpdate}`, [ctx.pid, afiliadoId]);
    if (pendiente) throw U.error(`Resolvé la anulación pendiente del ticket N° ${pendiente.id} antes de liquidar los consumos.`, 409);
    const consumos = U.redondear(ventas.reduce((s, v) => s + Number(v.total), 0), 2);
    const total = U.redondear(consumos * (1 - porcentaje / 100), 2);
    const valorCuota = U.redondear(total / cuotas, 2);
    const ahora = U.fechaHora();
    const id = await N.insertar(t, ctx, "predio_liquidacion", {
      afiliado_id: afiliadoId, fecha: ahora, desde: ventas[0].fecha.slice(0, 10), hasta: ventas[ventas.length - 1].fecha.slice(0, 10),
      ventas_cantidad: ventas.length, total_consumos: consumos, porcentaje_descuento: porcentaje, total, forma_pago: forma,
      cuotas, valor_cuota: valorCuota, estado: pagada ? "PAGADA" : "PENDIENTE", fecha_pago: pagada ? ahora : null,
      recibo, caja_id: pagada ? cajaId : null, observaciones, usuario_nombre: N.nombreActor(ctx),
    });
    await t.run(
      `UPDATE predio_venta SET liquidacion_id = ? WHERE predio_id = ? AND afiliado_id = ? AND estado = 'CONFIRMADA'
       AND (forma_pago='DESCUENTO' OR importe_haberes>0) AND liquidacion_id IS NULL`, [id, ctx.pid, afiliadoId]);
    if (pagada && forma === "EFECTIVO" && cajaId) {
      const caja = await N.exigir(t, ctx, "predio_caja", cajaId, "No encontramos la caja");
      await N.insertar(t, ctx, "predio_caja_movimiento", {
        caja_id: cajaId, boca_id: caja.boca_id, fecha: ahora, concepto: "COBRO_LIQUIDACION", tipo: "INGRESO", importe: total,
        recibo, observaciones: `Liquidación N° ${id} · ${a.nombre}`, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
      });
    }
    await N.auditar(t, ctx, "Liquidación de consumos", "afiliado", afiliadoId, { liquidacion_id: id, consumos, porcentaje, total, forma, cuotas, valor_cuota: valorCuota, pagada });
    return { id, total, valor_cuota: valorCuota, mensaje: `Liquidación N° ${id} generada` };
  });
}

async function verLiquidacion(ctx) { exigirAdmin(ctx); return datosLiquidacion(ctx); }
async function detallePlanillaEstadia(db, pid, liquidacionId) {
  const cierre = await db.get(
    "SELECT id, reserva_id, concepto, fecha, importe FROM predio_estadia_mov WHERE predio_id=? AND liquidacion_id=?",
    [pid, liquidacionId]);
  if (!cierre) return null;
  if (cierre.concepto === "PAGO_RESERVA") return { reserva_id: cierre.reserva_id, lineas: [
    { concepto: "Diferencia de alojamiento", fecha: cierre.fecha, importe: Number(cierre.importe) },
  ] };
  // La planilla sólo descuenta las compras abonadas con saldo, menos los
  // anticipos ya cobrados. Un reparto entre pasajeros no altera ese total.
  const movimientos = await db.all(
    `SELECT concepto, fecha, medio, importe, venta_id FROM predio_estadia_mov
     WHERE predio_id=? AND reserva_id=? AND id<? AND id>(
       SELECT COALESCE(MAX(id),0) FROM predio_estadia_mov WHERE predio_id=? AND reserva_id=? AND id<?
       AND concepto='SALDAR_CONSUMOS' AND NOT (medio='HABERES' AND importe<0))
     AND (concepto IN ('COMPRA','ANULACION','SALDAR_CONSUMOS') OR (concepto IN ('CARGA','RETIRO') AND medio<>'AL_SALIR'))
     ORDER BY id`, [pid, cierre.reserva_id, cierre.id, pid, cierre.reserva_id, cierre.id]);
  const conceptos = { COMPRA: "Compra", ANULACION: "Anulación de compra", CARGA: "Anticipo abonado", RETIRO: "Devolución de anticipo", SALDAR_CONSUMOS: "Planilla anterior anulada" };
  return { reserva_id: cierre.reserva_id, lineas: movimientos.map(m => ({
    concepto: conceptos[m.concepto] + (m.venta_id ? " · Ticket N° " + m.venta_id : ""),
    fecha: m.fecha,
    importe: -Number(m.importe),
  })) };
}

async function datosLiquidacion(ctx) {
  const id = U.id(ctx.params.id);
  const db = ctx.db;
  const l = await N.exigir(db, ctx, "predio_liquidacion", id, "No encontramos la liquidación");
  const a = await db.get(
    `SELECT a.*, d.nombre AS departamental FROM predio_afiliado a
     LEFT JOIN predio_departamental d ON d.predio_id = a.predio_id AND d.id = a.departamental_id
     WHERE a.predio_id = ? AND a.id = ?`, [ctx.pid, l.afiliado_id]);
  const ventas = await db.all(
    `SELECT v.id, v.fecha, COALESCE(v.importe_haberes,v.total) AS total, b.nombre AS boca FROM predio_venta v JOIN predio_boca b ON b.predio_id = v.predio_id AND b.id = v.boca_id
     WHERE v.predio_id = ? AND v.liquidacion_id = ? ORDER BY v.fecha`, [ctx.pid, id]);
  const config = await N.leerConfig(db, ctx);
  const estadia = await detallePlanillaEstadia(db, ctx.pid, id);
  return { liquidacion: l, afiliado: a, ventas, estadia, empresa: { nombre_predio: config.nombre_predio, razon_social: config.razon_social, cuit: config.cuit, direccion: config.direccion, texto_autorizacion: config.texto_autorizacion } };
}

async function pagarLiquidacion(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id);
  const recibo = U.texto(ctx.body.recibo, { max: 40 });
  const forma = ctx.body.forma_pago ? U.opcion(ctx.body.forma_pago, FORMAS_LIQ, "La forma de pago") : null;
  return ctx.db.tx(async (t) => {
    const l = await N.exigir(t, ctx, "predio_liquidacion", id, "No encontramos la liquidación", { bloquear: true });
    if (l.estado !== "PENDIENTE") throw U.error("La liquidación no está pendiente", 409);
    await N.actualizar(t, ctx, "predio_liquidacion", id, { estado: "PAGADA", fecha_pago: U.fechaHora(), recibo: recibo || l.recibo, forma_pago: forma || l.forma_pago });
    await N.auditar(t, ctx, "Liquidación pagada", "afiliado", l.afiliado_id, { liquidacion_id: id, recibo, forma: forma || l.forma_pago });
    return { id, mensaje: "Liquidación marcada como pagada" };
  });
}

async function anularLiquidacion(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id);
  const motivo = U.texto(ctx.body.motivo, { max: 255, campo: "El motivo", requerido: true });
  return ctx.db.tx(async (t) => {
    const l = await N.exigir(t, ctx, "predio_liquidacion", id, "No encontramos la liquidación", { bloquear: true });
    if (l.estado === "ANULADA") throw U.error("La liquidación ya está anulada", 409);
    await t.run("UPDATE predio_venta SET liquidacion_id = NULL WHERE predio_id = ? AND liquidacion_id = ?", [ctx.pid, id]);
    await N.actualizar(t, ctx, "predio_liquidacion", id, { estado: "ANULADA", observaciones: `${l.observaciones ? `${l.observaciones} · ` : ""}Anulada: ${motivo}`.slice(0, 255) });
    const mov=await t.get("SELECT * FROM predio_estadia_mov WHERE predio_id=? AND liquidacion_id=?",[ctx.pid,id]);
    if(mov)await N.insertar(t,ctx,"predio_estadia_mov",{reserva_id:mov.reserva_id,concepto:mov.concepto,medio:"HABERES",importe:-Number(mov.importe),fecha:U.fechaHora(),detalle:"Anulación de planilla "+id+": "+motivo,usuario_id:ctx.usuario.id,usuario_nombre:N.nombreActor(ctx)});
    await N.auditar(t, ctx, "Liquidación anulada", "afiliado", l.afiliado_id, { liquidacion_id: id, motivo });
    return { id, mensaje: "Liquidación anulada: los consumos vuelven a quedar pendientes" };
  });
}

module.exports = {
  limpiarDni, datosLiquidacion,
  rutas: [
    { m: "GET", p: "/afiliados/buscar", h: buscar },
    { m: "POST", p: "/afiliados/limites/previa", h: previaMasivo, roles: ["ADMIN"] },
    { m: "POST", p: "/afiliados/limites/masivo", h: aplicarMasivo, escritura: true, roles: ["ADMIN"] },
    { m: "GET", p: "/afiliados/:id", h: detalle, roles: ["ADMIN"] },
    { m: "POST", p: "/afiliados", h: crearManual, escritura: true, roles: ["ADMIN"] },
    { m: "PUT", p: "/afiliados/:id", h: editar, escritura: true, roles: ["ADMIN"] },
    { m: "POST", p: "/afiliados/:id/liquidaciones", h: crearLiquidacion, escritura: true, roles: ["ADMIN"] },
    { m: "GET", p: "/liquidaciones/:id", h: verLiquidacion, roles: ["ADMIN"] },
    { m: "POST", p: "/liquidaciones/:id/pagar", h: pagarLiquidacion, escritura: true, roles: ["ADMIN"] },
    { m: "POST", p: "/liquidaciones/:id/anular", h: anularLiquidacion, escritura: true, roles: ["ADMIN"] },
  ],
};
