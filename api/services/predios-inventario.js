"use strict";

const { crearNotificacion } = require("./notificaciones");
const { crearMysql } = require("../../predios/lib/db-mysql");
const { revisarVencimientos } = require("../../predios/lib/vencimientos");
const U = require("../../predios/lib/util");

function mesAnterior(hoy) {
  const hasta = hoy.slice(0, 7) + "-01";
  const periodo = U.sumarDias(hasta, -1).slice(0, 7);
  return { periodo, desde: periodo + "-01", hasta };
}

async function entregar(c, admins, clave, aviso) {
  for (const { id } of admins) {
    const [marca] = await c.query(
      "INSERT IGNORE INTO predio_inventario_envio (clave, usuario_id) VALUES (?, ?)", [clave, id]);
    if (marca.affectedRows) await crearNotificacion(c, { usuarioId: id, ...aviso, obligatoria: true });
  }
}

async function pendientesDeEntrega(c, admins, clave) {
  const [previos] = await c.query("SELECT usuario_id FROM predio_inventario_envio WHERE clave = ?", [clave]);
  const enviados = new Set(previos.map(f => Number(f.usuario_id)));
  return admins.filter(a => !enviados.has(Number(a.id)));
}

async function avisarCobrosExcepcionales(c, admins, { periodo, desde, hasta }) {
  const clave = "cobros/" + periodo;
  const pendientes = await pendientesDeEntrega(c, admins, clave);
  if (!pendientes.length) return;
  const precios = `tipo VARCHAR(20) PATH '$.tipo', manual DECIMAL(15,2) PATH '$.manual',
    precio_total DECIMAL(15,2) PATH '$.precio_total', automatico DECIMAL(15,2) PATH '$.automatico'`;
  // Las modalidades con precio acordado no tienen tarifa de alojamiento automática.
  // La revisión anterior permite omitir ingresos, salidas y otras ediciones sin cambios de precio.
  const [operaciones] = await c.query(`SELECT e.id, e.reserva_id, p.nombre AS predio, e.actor, e.motivo,
      DATE_FORMAT(e.fecha, '%d/%m/%Y %H:%i') AS fecha,
      actual.precio_total AS importe,
      CASE WHEN COALESCE(actual.tipo, 'GENERAL') = 'GENERAL' THEN actual.automatico END AS tarifa_sistema
    FROM recepcion_reserva_evento e JOIN predio p ON p.id = e.predio_id
    JOIN JSON_TABLE(e.actual, '$' COLUMNS (${precios})) AS actual
    JOIN JSON_TABLE(COALESCE(e.anterior, '{}'), '$' COLUMNS (${precios})) AS anterior
    WHERE e.fecha >= ? AND e.fecha < ? AND e.empleado_id IS NOT NULL
      AND actual.manual IS NOT NULL AND actual.precio_total IS NOT NULL
      AND (actual.tipo IN ('PASA_EL_DIA', 'CONTINGENTE', 'FEDERACION') OR actual.precio_total <> actual.automatico)
      AND NOT (COALESCE(actual.tipo, 'GENERAL') = COALESCE(anterior.tipo, 'GENERAL') AND actual.manual <=> anterior.manual
        AND actual.precio_total <=> anterior.precio_total AND actual.automatico <=> anterior.automatico)
    ORDER BY p.nombre, p.id, e.fecha, e.id`, [desde, hasta]);
  if (!operaciones.length) return;
  const cantidad = operaciones.length;
  await entregar(c, pendientes, clave, {
    tipo: "PREDIO_RESUMEN_COBROS",
    titulo: "Cobros excepcionales de los predios · " + periodo,
    mensaje: cantidad === 1 ? "Una operación con un importe excepcional o acordado en el mes."
      : `${cantidad} operaciones con importes excepcionales o acordados en el mes.`,
    payload: { operaciones: operaciones.map(operacion => ({
      ...operacion,
      importe: Number(operacion.importe),
      tarifa_sistema: operacion.tarifa_sistema === null ? null : Number(operacion.tarifa_sistema),
    })) },
  });
}

async function avisosGenerales(c, hoy) {
  const [admins] = await c.query(`SELECT u.id FROM usuario u JOIN rol r ON r.id = u.rol_id
    WHERE r.nombre = 'admin' AND UPPER(COALESCE(u.habilitado,'S')) NOT IN ('N','NO','0','FALSE') ORDER BY u.id`);
  if (!admins.length) return;
  const mes = mesAnterior(hoy);
  const { periodo, desde, hasta } = mes;
  const clave = "ajustes/" + periodo;
  const pendientes = await pendientesDeEntrega(c, admins, clave);
  if (pendientes.length) {
    const [filas] = await c.query(`SELECT p.codigo, p.nombre,
        COUNT(CASE WHEN m.cantidad > 0 THEN 1 END) AS altas, COUNT(CASE WHEN m.cantidad < 0 THEN 1 END) AS bajas,
        CASE WHEN p.escritor = 'LOCAL' THEN DATE_FORMAT(p.ultimo_push,'%d/%m/%Y %H:%i') END AS ultima_sync, p.escritor
      FROM predio p LEFT JOIN predio_movimiento m ON m.predio_id = p.id AND m.fecha >= ? AND m.fecha < ?
        AND (m.tipo IN ('ALTA','AJUSTE') OR (m.tipo = 'BAJA' AND m.referencia_tipo = 'baja'))
      WHERE p.activo = 1 AND p.fecha_creacion < ? GROUP BY p.id ORDER BY p.id`, [desde, hasta, hasta]);
    if (filas.length) await entregar(c, pendientes, clave, {
      tipo: "PREDIO_RESUMEN_STOCK", titulo: "Ajustes de stock de los predios · " + periodo,
      mensaje: filas.map(p => `${p.nombre}: ${p.altas} ${Number(p.altas) === 1 ? "alta" : "altas"} y ${p.bajas} ${Number(p.bajas) === 1 ? "baja" : "bajas"}` +
        (p.escritor === "LOCAL" ? ` (última sincronización: ${p.ultima_sync || "pendiente"})` : "")).join(". ") + ".",
      payload: { periodo, predios: filas },
    });
  }
  await avisarCobrosExcepcionales(c, admins, mes);
  // Se resta un mes calendario a la fecha del producto, incluso para fin de mes.
  const [productos] = await c.query(`SELECT p.id AS predio_id, p.nombre AS predio, p.codigo, x.id, x.nombre,
      DATE_FORMAT(x.fecha_caducidad, '%Y-%m-%d') AS fecha FROM predio_producto x JOIN predio p ON p.id = x.predio_id
    WHERE p.activo = 1 AND x.activo = 1 AND x.perecedero = 1 AND x.fecha_caducidad >= ?
      AND DATE_SUB(x.fecha_caducidad, INTERVAL 1 MONTH) <= ?
      AND EXISTS (SELECT 1 FROM predio_stock s WHERE s.predio_id = p.id AND s.producto_id = x.id AND s.cantidad > 0)
    ORDER BY p.id, x.id`, [hoy, hoy]);
  for (const p of productos) await entregar(c, admins, `vence/${p.predio_id}/${p.id}/${p.fecha}`, {
    tipo: "PREDIO_VENCIMIENTO", titulo: "Mercadería por vencer en " + p.predio,
    mensaje: `«${p.nombre}» vence el ${p.fecha.split("-").reverse().join("/")} en ${p.predio}.`,
    payload: { predio: p.codigo, producto_id: p.id, fecha_caducidad: p.fecha },
  });
}

async function revisarInventario(pool, hoy = U.hoy()) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    await avisosGenerales(c, hoy);
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally { c.release(); }
  const [centrales] = await pool.query("SELECT id FROM predio WHERE activo = 1 AND escritor = 'CENTRAL'");
  for (const { id } of centrales) {
    const db = crearMysql(pool, { predioId: id });
    await db.tx(async t => {
      const predio = await t.get("SELECT escritor, activo FROM predio WHERE id = ? FOR UPDATE", [id]);
      if (predio?.escritor === "CENTRAL" && Number(predio.activo)) await revisarVencimientos(t, { pid: id }, hoy);
    });
  }
}

function iniciarInventario(pool) {
  let enCurso = false;
  async function ejecutar() {
    if (enCurso) return;
    enCurso = true;
    try { await revisarInventario(pool); }
    catch (e) { console.error("Avisos de inventario de predios:", e.code || e.message); }
    finally { enCurso = false; }
  }
  setTimeout(ejecutar, 10000).unref();
  setInterval(ejecutar, 3600000).unref();
}

module.exports = { mesAnterior, avisosGenerales, revisarInventario, iniciarInventario };
