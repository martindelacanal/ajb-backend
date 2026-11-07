"use strict";

// Las tarifas vigentes sirven para cotizar. Para consultar el historial también
// hacen falta servicios, recursos y adicionales que dejaron de ofrecerse.
async function opcionesFiltros(c, codigos) {
  const [servicios] = await c.query("SELECT id,nombre FROM servicio WHERE codigo IN (?) ORDER BY nombre", [codigos]);
  if (!servicios.length) return { servicios, recursos: [], adicionales: [] };
  const ids = servicios.map(s => s.id);
  const [recursos] = await c.query("SELECT id,nombre,servicio_id FROM recurso WHERE servicio_id IN (?) ORDER BY nombre", [ids]);
  const [adicionales] = await c.query(`SELECT a.id,a.nombre FROM adicional a JOIN (
    SELECT ta.adicional_id FROM tarifa_adicional ta JOIN recurso rc ON rc.id=ta.recurso_id WHERE rc.servicio_id IN (?)
    UNION
    SELECT ra.adicional_id FROM reserva_adicional ra JOIN reserva r ON r.id=ra.reserva_id WHERE r.servicio_id IN (?)
  ) usados ON usados.adicional_id=a.id ORDER BY a.nombre`, [ids, ids]);
  return { servicios, recursos, adicionales };
}

module.exports = { opcionesFiltros };
