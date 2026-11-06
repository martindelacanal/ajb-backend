"use strict";

const U = require("./util");
const N = require("./negocio");
const { emitirAviso } = require("./avisos");
const revisados = new WeakMap();
const INTERVALO_MS = 6 * 3600000;

// Umbral exclusivo en hora argentina. Si el mes de origen era más corto,
// todos sus días ya cumplieron cuatro meses: el umbral pasa al primero siguiente.
function limiteRevision(ahora = new Date()) {
  const fecha = U.fechaHora(ahora);
  const [y, m, d] = fecha.slice(0, 10).split("-").map(Number);
  const destino = new Date(Date.UTC(y, m - 1 - 4, 1));
  const ultimo = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0)).getUTCDate();
  if (d > ultimo) {
    destino.setUTCMonth(destino.getUTCMonth() + 1);
    return `${destino.getUTCFullYear()}-${String(destino.getUTCMonth() + 1).padStart(2, "0")}-01 00:00:00`;
  }
  return `${destino.getUTCFullYear()}-${String(destino.getUTCMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}${fecha.slice(10)}`;
}

function fechaRevisionSql(alias = "p", historial = "ph") {
  return `COALESCE(${alias}.fecha_revision_precio, ${historial}.fecha, ${alias}.fecha_creacion)`;
}

function historialRevisionSql(alias = "ph") {
  return `LEFT JOIN (SELECT h.predio_id, h.producto_id, MAX(h.fecha) AS fecha
    FROM predio_precio_historial h LEFT JOIN predio_compra c ON h.origen = 'COMPRA' AND c.predio_id = h.predio_id AND c.id = h.referencia_id
    WHERE h.origen IN ('ALTA', 'IMPORTACION', 'EDICION', 'COMPRA') AND (h.origen <> 'COMPRA' OR c.estado = 'CARGADA')
    GROUP BY h.predio_id, h.producto_id) ${alias} ON ${alias}.predio_id = p.predio_id AND ${alias}.producto_id = p.id`;
}

async function fuentePrecioVigente(t, ctx, productoId, excluirCompraId = null) {
  return t.get(
    `SELECT h.* FROM predio_precio_historial h
     LEFT JOIN predio_compra c ON h.origen = 'COMPRA' AND c.predio_id = h.predio_id AND c.id = h.referencia_id
     WHERE h.predio_id = ? AND h.producto_id = ? AND h.origen IN ('ALTA', 'IMPORTACION', 'EDICION', 'COMPRA')
       AND (h.origen <> 'COMPRA' OR (c.estado = 'CARGADA' AND h.referencia_id <> ?))
     ORDER BY h.id DESC LIMIT 1`, [ctx.pid, productoId, excluirCompraId || -1]);
}

async function resolverControl(t, ctx, control, fecha) {
  if (control.aviso_id) await N.actualizar(t, ctx, "predio_aviso", control.aviso_id, { resuelto_fecha: fecha });
  await N.actualizar(t, ctx, "predio_precio_control", control.id, { resuelto_fecha: fecha });
}

async function resolverRevisionProducto(t, ctx, productoId) {
  const control = await t.get(`SELECT * FROM predio_precio_control WHERE predio_id = ? AND producto_id = ?${t.forUpdate}`, [ctx.pid, productoId]);
  if (control && !control.resuelto_fecha) await resolverControl(t, ctx, control, U.fechaHora());
}

// Se puede ejecutar sin internet. No modifica precios ni bloquea una venta.
// La réplica central no genera escrituras cuando la notebook es dueña de los datos.
async function revisarPreciosVencidos(db, ctx, { ahora = new Date(), forzar = false } = {}) {
  if (ctx.soloLectura) return { pendientes: 0, emitidos: 0, resueltos: 0, emitidos_ids: [] };
  if (ctx.modo === "central" && ctx.revisarPreciosCentral !== true) return { pendientes: 0, emitidos: 0, resueltos: 0, emitidos_ids: [] };
  const previo = revisados.get(db);
  if (!forzar && previo && ahora.getTime() - previo.fecha < INTERVALO_MS) return { ...previo.resultado, emitidos: 0, resueltos: 0, emitidos_ids: [] };
  const resultado = await db.tx(async (t) => {
    // Serializa revisiones periódicas y consultas de varios administradores.
    await t.run(`${t.insertIgnore} INTO predio_secuencia (predio_id, tabla, ultimo) VALUES (?, 'revision_precios', 0)`, [ctx.pid]);
    await t.get(`SELECT ultimo FROM predio_secuencia WHERE predio_id = ? AND tabla = 'revision_precios'${t.forUpdate}`, [ctx.pid]);
    const fechaSql = fechaRevisionSql();
    const pendientes = await t.all(
      `SELECT p.id, p.nombre, p.codigo, ${fechaSql} AS revision
       FROM predio_producto p ${historialRevisionSql()}
       WHERE p.predio_id = ? AND p.activo = 1
         AND EXISTS (SELECT 1 FROM predio_stock s WHERE s.predio_id = p.predio_id AND s.producto_id = p.id AND s.cantidad > 0)
         AND (${fechaSql} IS NULL OR ${fechaSql} < ?)
       ORDER BY p.id`, [ctx.pid, limiteRevision(ahora)]);
    const controles = await t.all("SELECT * FROM predio_precio_control WHERE predio_id = ?", [ctx.pid]);
    const porId = new Map(controles.map((c) => [Number(c.producto_id), c]));
    const idsPendientes = new Set(pendientes.map((p) => Number(p.id)));
    const fecha = U.fechaHora(ahora);
    let resueltos = 0;
    const emitidos = [];
    for (const control of controles) {
      if (!control.resuelto_fecha && !idsPendientes.has(Number(control.producto_id))) {
        await resolverControl(t, ctx, control, fecha);
        resueltos++;
      }
    }
    for (const p of pendientes) {
      const revision = p.revision || "SIN_FECHA";
      const control = porId.get(Number(p.id));
      if (control && !control.resuelto_fecha && control.revision_clave === revision) continue;
      if (control && !control.resuelto_fecha) { await resolverControl(t, ctx, control, fecha); resueltos++; }
      const avisoId = await emitirAviso(t, ctx, {
        tipo: "PRECIO_SIN_REVISAR", titulo: `Revisar el precio de ${p.nombre}`.slice(0, 180),
        mensaje: `«${p.nombre}»${p.codigo ? ` (código ${p.codigo})` : ""} tiene stock y ${p.revision ? `su precio no se revisa desde el ${p.revision}, hace más de cuatro meses calendario` : "no tiene una fecha de revisión de precio registrada"}. Revisá el costo y el precio en Gestión → Productos. Se puede seguir vendiendo.`,
        detalle: { producto_id: p.id, producto: p.nombre, codigo: p.codigo, ultima_revision: p.revision, filtro: "revision_precio", valor: "pendiente" },
      });
      const datos = { producto_id: p.id, revision_clave: revision, aviso_id: avisoId, resuelto_fecha: null };
      if (control) await N.actualizar(t, ctx, "predio_precio_control", control.id, datos);
      else await N.insertar(t, ctx, "predio_precio_control", datos);
      emitidos.push(avisoId);
    }
    if (ctx.alAvisosPrecios && emitidos.length) {
      const filas = await t.all(`SELECT * FROM predio_aviso WHERE predio_id = ? AND id IN (${emitidos.map(() => "?").join(", ")})`, [ctx.pid, ...emitidos]);
      await ctx.alAvisosPrecios(t, filas);
    }
    return { pendientes: pendientes.length, emitidos: emitidos.length, resueltos, emitidos_ids: emitidos };
  });
  revisados.set(db, { fecha: ahora.getTime(), resultado });
  return resultado;
}

module.exports = { limiteRevision, fechaRevisionSql, historialRevisionSql, revisarPreciosVencidos, resolverRevisionProducto, fuentePrecioVigente };
