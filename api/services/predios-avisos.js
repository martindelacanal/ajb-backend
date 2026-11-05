"use strict";

// Los avisos siguen guardados en el predio sin internet. Al replicarlos se entregan
// también en Mi AJB, dentro de la misma transacción, para no perderlos ni repetirlos.
const { crearNotificacion } = require("./notificaciones");

async function nuevosAvisos(conexion, predioId, filas) {
  const porId = new Map();
  for (const fila of filas || []) {
    const id = Number(fila.id);
    if (Number.isSafeInteger(id) && id > 0) porId.set(id, fila);
  }
  if (!porId.size) return [];
  const conocidos = new Set();
  const ids = [...porId.keys()];
  for (let i = 0; i < ids.length; i += 300) {
    const lote = ids.slice(i, i + 300);
    const [previos] = await conexion.query(
      `SELECT id FROM predio_aviso WHERE predio_id = ? AND id IN (${lote.map(() => "?").join(", ")})`,
      [predioId, ...lote]);
    for (const previo of previos) conocidos.add(Number(previo.id));
  }
  return [...porId.values()].filter((fila) => !conocidos.has(Number(fila.id)));
}

async function entregarAvisos(conexion, predio, filas) {
  for (const aviso of filas) {
    if (!["ACCESO_FALLIDO", "VENTA_SIN_STOCK"].includes(aviso.tipo)) continue;
    let condicion = "";
    const params = [];
    if (aviso.general_usuario_id) {
      condicion = " AND u.id = ?";
      params.push(Number(aviso.general_usuario_id));
    } else if (aviso.general_documento) {
      condicion = " AND u.documento = ?";
      params.push(String(aviso.general_documento));
    } else if (aviso.usuario_id) {
      const [[local]] = await conexion.query(
        "SELECT general_usuario_id FROM predio_usuario WHERE predio_id = ? AND id = ?",
        [predio.id, Number(aviso.usuario_id)]);
      // Las cuentas propias del predio reciben su aviso en la campana local.
      if (!local?.general_usuario_id) continue;
      condicion = " AND u.id = ?";
      params.push(Number(local.general_usuario_id));
    } else if (aviso.tipo !== "VENTA_SIN_STOCK") {
      // Un identificador desconocido jamás convierte un aviso privado en masivo.
      continue;
    }
    const [destinatarios] = await conexion.query(
      `SELECT u.id FROM usuario u JOIN rol r ON r.id = u.rol_id
       WHERE ${condicion ? "1 = 1" : "r.nombre = 'admin'"}${condicion}`,
      params);
    for (const usuario of destinatarios) {
      await crearNotificacion(conexion, {
        usuarioId: usuario.id,
        tipo: `PREDIO_${aviso.tipo}`,
        titulo: `${predio.nombre}: ${aviso.titulo}`,
        mensaje: aviso.mensaje,
        payload: { predio: predio.codigo, aviso_id: Number(aviso.id), fecha: aviso.fecha },
        obligatoria: true,
      });
    }
  }
}

module.exports = { nuevosAvisos, entregarAvisos };
