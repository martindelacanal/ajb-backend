"use strict";

// El hilo pertenece al servicio y acompaña sus recursos y todas las revisiones.
// Los nombres y el rol se guardan al escribir para conservar la identidad histórica.
async function registrarMensajeServicio(connection, { servicio, cabecera, mensaje, recursoId = null }) {
  const [resultado] = await connection.query(
    `INSERT INTO servicio_observacion
       (servicio_id, recurso_id, usuario_id, usuario_rol, usuario_nombre, usuario_apellido,
        mensaje, estado_aprobacion)
     SELECT ?, ?, u.id, ?, u.nombre, u.apellido, ?, ? FROM usuario u WHERE u.id = ?`,
    [servicio.id, recursoId, cabecera.rol, mensaje, servicio.estado_aprobacion, cabecera.id]
  );
  if (Number(resultado.affectedRows) !== 1) throw new Error("No se pudo registrar el autor del mensaje");
  return Number(resultado.insertId);
}

async function obtenerMensajesServicio(connection, servicioId) {
  const [mensajes] = await connection.query(
    `SELECT o.id, o.recurso_id, o.usuario_id, o.usuario_rol, o.mensaje,
            o.estado_aprobacion AS estado_nombre, o.fecha_creacion,
            COALESCE(o.usuario_nombre, u.nombre) AS usuario_nombre,
            COALESCE(o.usuario_apellido, u.apellido) AS usuario_apellido,
            r.nombre AS recurso_nombre
       FROM servicio_observacion o
       LEFT JOIN usuario u ON u.id = o.usuario_id
       LEFT JOIN recurso r ON r.id = o.recurso_id
      WHERE o.servicio_id = ? ORDER BY o.id ASC`,
    [servicioId]
  );
  return mensajes;
}

module.exports = { obtenerMensajesServicio, registrarMensajeServicio };
