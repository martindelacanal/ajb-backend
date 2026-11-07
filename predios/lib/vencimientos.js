"use strict";

const { emitirAviso } = require("./avisos");
const U = require("./util");

function condicionVencimiento(dialecto, hoy) {
  const limite = dialecto === "mysql" ? `DATE_ADD(${hoy}, INTERVAL COALESCE(p.dias_aviso_vencimiento,7) DAY)`
    : `date(${hoy}, '+' || COALESCE(p.dias_aviso_vencimiento,7) || ' days')`;
  return `p.activo = 1 AND p.perecedero = 1 AND p.fecha_caducidad <= ${limite}
    AND EXISTS (SELECT 1 FROM predio_stock s WHERE s.predio_id = p.predio_id AND s.producto_id = p.id AND s.cantidad > 0)`;
}

// Una lectura por persona en la campana y un aviso por producto y fecha.
// La notebook puede revisar aun cuando esté sin Internet.
async function revisarVencimientos(t, ctx, hoy = U.hoy()) {
  await t.run(`${t.insertIgnore} INTO predio_secuencia (predio_id, tabla, ultimo) VALUES (?, 'revision_vencimientos', 0)`, [ctx.pid]);
  await t.get(`SELECT ultimo FROM predio_secuencia WHERE predio_id = ? AND tabla = 'revision_vencimientos'${t.forUpdate}`, [ctx.pid]);
  const productos = await t.all(`SELECT p.id, p.nombre, p.fecha_caducidad FROM predio_producto p
    WHERE p.predio_id = ? AND ${condicionVencimiento(t.dialecto, "?")}`, [ctx.pid, hoy]);
  const abiertos = await t.all("SELECT id, detalle FROM predio_aviso WHERE predio_id = ? AND tipo = 'VENCIMIENTO_PRODUCTO' AND resuelto_fecha IS NULL", [ctx.pid]);
  const vigentes = new Map();
  for (const p of productos) {
    const fecha = String(p.fecha_caducidad).slice(0, 10);
    vigentes.set(p.id + "/" + fecha, { p, fecha });
  }
  for (const aviso of abiertos) {
    const detalle = JSON.parse(aviso.detalle);
    if (!vigentes.delete(detalle.producto_id + "/" + detalle.fecha_caducidad)) {
      await t.run("UPDATE predio_aviso SET resuelto_fecha = ? WHERE predio_id = ? AND id = ?", [U.fechaHora(), ctx.pid, aviso.id]);
    }
  }
  for (const { p, fecha } of vigentes.values()) {
    await emitirAviso(t, ctx, {
      tipo: "VENCIMIENTO_PRODUCTO", titulo: "Vencimiento de " + p.nombre,
      mensaje: `«${p.nombre}» tiene mercadería con fecha de vencimiento ${fecha.split("-").reverse().join("/")}.`,
      detalle: { producto_id: p.id, fecha_caducidad: fecha },
    });
  }
}

module.exports = { revisarVencimientos, condicionVencimiento };
