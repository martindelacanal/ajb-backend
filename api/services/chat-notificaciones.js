"use strict";

const { puedeAccederSegunEntidad } = require("../socket/chat-tiempo-real");
const { crearNotificacion } = require("./notificaciones");

async function notificarParticipantesChat(connection, {
  modulo, entidadId, entidad, autorId, tipo, titulo, mensaje, payload,
}) {
  const [usuarios] = await connection.query(
    `SELECT u.id, u.departamental_id, u.area_turismo, u.area_coseguro,
            u.modulo_turismo, u.modulo_coseguro, u.modulo_olimpiadas, r.nombre AS rol
       FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.habilitado = 'Y' AND (
        r.nombre IN ('admin', 'admin-central', 'auditor')
        OR (r.nombre = 'departamental' AND u.departamental_id = ?)
        OR u.id = ?
      )`,
    [entidad.departamental_id || 0, entidad.usuario_id || 0]
  );
  for (const usuario of usuarios) {
    if (Number(usuario.id) === Number(autorId)) continue;
    const auth = { ...usuario, departamentalId: usuario.departamental_id };
    if (!puedeAccederSegunEntidad(auth, { modulo, entidadId }, entidad)) continue;
    await crearNotificacion(connection, { usuarioId: usuario.id, tipo, titulo, mensaje, payload });
  }
}

module.exports = { notificarParticipantesChat };
