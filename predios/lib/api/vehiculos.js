"use strict";

const U = require("../util");
const { resumirCuenta } = require("../cuenta-estadia");
const { randomBytes } = require("node:crypto");

const lectores = ["ADMIN", "SEGURIDAD"];

function turismo(t, ctx, accion, datos) {
  if (ctx.servicios?.recepcion) return ctx.servicios.recepcion(accion, datos, ctx.usuario, t);
  if (ctx.servicios?.agente?.recepcion) return ctx.servicios.agente.recepcion(accion, datos, ctx.usuario);
  throw U.error("No hay conexión con el servicio de Turismo.", 503);
}

const concepto = {
  DIFERENCIAL: "Diferencia de alojamiento",
  PAGO_RESERVA: "Pago de alojamiento",
  CARGA: "Anticipo de consumos",
  RETIRO: "Retiro de anticipo",
  COMPRA: "Consumo",
  ANULACION: "Consumo anulado",
  SALDAR_CONSUMOS: "Liquidación de consumos",
  PAGO_SALIDA_CONSUMOS: "Pago de consumos en salida"
};
const traspaso = {
  TRASPASO_ALOJAMIENTO: "Saldo de alojamiento trasladado",
  TRASPASO_CONSUMOS: "Saldo de consumos trasladado"
};

function detalleDeuda(m, nombres) {
  const { concepto: clave, medio, fecha } = m;
  if (!Object.hasOwn(concepto, clave) || ["CARGA", "RETIRO"].includes(clave) && medio === "AL_SALIR") return null;
  const importe = Number(m.importe) * (clave === "DIFERENCIAL" ? 1 : -1);
  if (!importe) return null;
  const detalle = [nombres.get(Number(m.huesped_id)), m.venta_id ? "Venta N° " + m.venta_id : null].filter(Boolean).join(" · ");
  return { concepto: concepto[clave], importe, detalle, fecha };
}

function trasladosDeuda(movimientos, nombres) {
  return movimientos.filter(m => m.medio === "RECIBIDO" && Object.hasOwn(traspaso, m.concepto))
    .slice(0, 20).map(m => ({
      concepto: traspaso[m.concepto], importe: Number(m.importe), detalle: nombres.get(Number(m.huesped_id)), fecha: m.fecha
    }));
}

function porReserva(filas) {
  const grupos = new Map();
  for (const fila of filas) {
    const id = Number(fila.reserva_id);
    if (!grupos.has(id)) grupos.set(id, []);
    grupos.get(id).push(fila);
  }
  return grupos;
}

async function conDeuda(t, ctx, filas) {
  if (!filas.length) return filas;
  const fuente = ctx.modo === "central" ? await t.get(`SELECT escritor,
    DATE_FORMAT(ultimo_push,'%Y-%m-%d %H:%i:%s') AS ultima_sincronizacion,
    TIMESTAMPDIFF(SECOND,ultima_conexion,NOW()) AS segundos,pendientes_local
    FROM predio WHERE id=?`, [ctx.pid]) : null;
  const replicada = fuente?.escritor === "LOCAL";
  const replicaAtrasada = replicada && (!fuente.ultima_sincronizacion || fuente.segundos == null ||
    Number(fuente.segundos) > 30 || Number(fuente.pendientes_local) > 0);
  const resultado = [];
  for (let desde = 0; desde < filas.length; desde += 200) {
    const lote = filas.slice(desde, desde + 200);
    const ids = lote.map(f => Number(f.id));
    const filtro = " WHERE predio_id=? AND reserva_id IN (" + t.lista(ids.length) + ")";
    const params = [ctx.pid, ...ids];
    const huespedes = porReserva(await t.all("SELECT id,reserva_id,dni,nombre,saldo,ultima_revision FROM predio_huesped" + filtro, params));
    const movimientos = porReserva(await t.all(`SELECT id,reserva_id,huesped_id,venta_id,fecha,concepto,medio,importe
      FROM predio_estadia_mov` + filtro + " ORDER BY id DESC", params));
    for (const fila of lote) {
      const { revision, ...datos } = fila;
      const personas = huespedes.get(Number(fila.id)) || [];
      const movs = movimientos.get(Number(fila.id)) || [];
      const a = resumirCuenta(personas, movs);
      const total = Math.max(0, U.redondear(a.pendiente + a.neto_consumos));
      const nombres = new Map(personas.map(p => [Number(p.id), p.nombre]));
      const desactualizada = replicaAtrasada || !personas.some(p => Number(p.ultima_revision) >= Number(revision));
      resultado.push({
        ...datos,
        deuda: {
          total, reserva: a.pendiente, consumos: a.neto_consumos,
          detalle: total ? movs.map(m => detalleDeuda(m, nombres)).filter(Boolean).slice(0, 20) : [],
          traspasos: total ? trasladosDeuda(movs, nombres) : [],
          desactualizada, replicada, ultima_sincronizacion: fuente?.ultima_sincronizacion || null
        }
      });
    }
  }
  return resultado;
}

async function lectura(ctx, accion, datos) {
  if (ctx.modo === "central") {
    return ctx.db.tx(async t => {
      const r = await turismo(t, ctx, accion, datos);
      const filas = await conDeuda(t, ctx, r.filas || [r]);
      return r.filas ? { filas } : filas[0];
    });
  }
  const r = await turismo(ctx.db, ctx, accion, datos);
  const filas = await conDeuda(ctx.db, ctx, r.filas || [r]);
  return r.filas ? { filas } : filas[0];
}

function exigirRecepcion(ctx) {
  if (ctx.usuario.rol !== "ADMIN" && !Number(ctx.usuario.gestionar_reservas)) throw U.error("Tu usuario no tiene permiso para gestionar reservas y estadías.", 403);
}

// Cambios de la estadía sin precio (ubicación, vehículos): Turismo guarda una revisión
// nueva y la notebook actualiza los huéspedes con esa revisión (así la deuda queda al día).
async function ajustar(ctx, accion, datos) {
  const operacion = String(datos.operacion || randomBytes(16).toString("hex"));
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(operacion)) throw U.error("Identificador de operación inválido.");
  const cuerpo = { ...datos, operacion };
  const huella = U.sha256(JSON.stringify([ctx.usuario.id, accion, cuerpo]));
  return ctx.db.tx(async t => {
    const previo = await t.get("SELECT huella,respuesta FROM predio_recepcion_recibo WHERE predio_id=? AND clave=?" + t.forUpdate, [ctx.pid, operacion]);
    if (previo) {
      if (previo.huella !== huella) throw U.error("Identificador ya utilizado para otra operación.", 409);
      return JSON.parse(previo.respuesta);
    }
    const r = await turismo(t, ctx, accion, cuerpo);
    if (r.sin_cambios) return { id: Number(r.id), sin_cambios: true, mensaje: "No había cambios para guardar." };
    const { aplicarConfirmacion } = require("./recepcion");
    return aplicarConfirmacion(t, ctx, r, operacion, huella, datos.motivo);
  });
}

module.exports = {
  rutas: [
    { m: "GET", p: "/recepcion/vehiculos", roles: lectores, h: ctx => lectura(ctx, "vehiculos", {}) },
    { m: "GET", p: "/recepcion/vehiculos/qr/:token", roles: lectores, h: ctx => lectura(ctx, "buscarVehiculoQr", { token: ctx.params.token }) },
    { m: "GET", p: "/recepcion/vehiculos/:id", roles: lectores, h: ctx => lectura(ctx, "detalleVehiculo", { id: ctx.params.id }) },
    { m: "POST", p: "/recepcion/vehiculos/:id/salida", roles: ["ADMIN"], escritura: true,
      h: ctx => ajustar(ctx, "retirarVehiculo", { id: ctx.params.id, patente: ctx.body.patente, operacion: ctx.body.operacion }) },
    // QR de la reserva (la ruta vieja «vehiculo/qr» queda por las pantallas anteriores).
    ...["/recepcion/:id/qr", "/recepcion/:id/vehiculo/qr"].map(p => ({ m: "POST", p, escritura: true, h: ctx => {
      exigirRecepcion(ctx);
      return ctx.db.tx(t => turismo(t, ctx, "emitirVehiculoQr", { id: ctx.params.id }));
    } })),
    { m: "POST", p: "/recepcion/:id/estadia", escritura: true, h: ctx => {
      exigirRecepcion(ctx);
      const b = ctx.body || {};
      const datos = { id: ctx.params.id, operacion: b.operacion, version: b.version, motivo: b.motivo };
      if (Object.hasOwn(b, "ubicacion")) datos.ubicacion = b.ubicacion;
      if (Object.hasOwn(b, "vehiculos")) datos.vehiculos = b.vehiculos;
      return ajustar(ctx, "ajustarEstadia", datos);
    } }
  ]
};
