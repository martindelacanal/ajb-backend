"use strict";

const U = require("./util");

// Los registros anteriores guardaban la emisión administrativa y cada cambio
// propio en auditoría. Una edición de nombre, rol o bocas no cambia la clave.
const SQL_MARCAR_TEMPORALES = `UPDATE predio_usuario SET debe_cambiar_clave = 1
  WHERE es_admin_general = 0 AND password_hash IS NOT NULL AND debe_cambiar_clave = 0
  AND (SELECT a.accion FROM predio_auditoria a
       WHERE a.predio_id = predio_usuario.predio_id AND a.entidad = 'usuario' AND a.entidad_id = predio_usuario.id
         AND (a.accion IN ('Alta de usuario', 'Cambio de contraseña propia') OR
              (a.accion = 'Modificación de usuario' AND CASE WHEN JSON_VALID(a.detalle)
               THEN REPLACE(JSON_EXTRACT(a.detalle, '$.password'), '"', '') = 'cambiada' ELSE 0 END))
       ORDER BY a.id DESC LIMIT 1) IN ('Alta de usuario', 'Modificación de usuario')`;

function validarNueva(clave, usuario) {
  if (typeof clave !== "string" || clave.trim().length < 6 || clave.length > 128) {
    throw U.error("Usá una contraseña de entre 6 y 128 caracteres");
  }
  const normal = U.normalizarBusqueda(clave.trim());
  const secuencias = ["0123456789012345", "9876543210987654", "abcdefghijklmnopqrstuvwxyz", "zyxwvutsrqponmlkjihgfedcba", "qwertyuiop", "asdfghjkl"];
  if (normal === U.normalizarBusqueda(usuario) || /^(.{1,3})\1+$/su.test(normal)
    || /^(?:password|contrasena|admin|qwerty|letmein|abc123)\d*$/.test(normal)
    || secuencias.some(s => s.includes(normal))) {
    throw U.error("Elegí una contraseña menos predecible. Evitá tu usuario, repeticiones y secuencias.");
  }
}

function hashDeCambio(usuario, actual, nueva) {
  if (!U.verificarPassword(actual, usuario.password_hash)) throw U.error("La contraseña actual no es correcta", 403);
  if (actual === nueva) throw U.error("La nueva contraseña tiene que ser distinta de la actual");
  validarNueva(nueva, usuario.usuario);
  return U.hashPassword(nueva);
}

function exigirCambio(usuario, metodo, ruta) {
  if (!Number(usuario?.debe_cambiar_clave)) return;
  const camino = ruta.replace(/\/+$/, "");
  if ((["GET", "HEAD"].includes(metodo) && ["/sesion", "/estado-publico"].includes(camino))
    || (metodo === "POST" && ["/sesion/clave", "/logout"].includes(camino))) return;
  throw U.error("Cambiá tu contraseña para continuar", 403, { codigo: "CAMBIO_CLAVE_OBLIGATORIO" });
}

module.exports = { validarNueva, hashDeCambio, exigirCambio, SQL_MARCAR_TEMPORALES };
