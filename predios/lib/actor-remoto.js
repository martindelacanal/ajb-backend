"use strict";

const U = require("./util");
const sesion = require("./api/sesion");

// La identidad de una orden se revalida en la base que aplica el negocio.
async function resolverActorRemoto({ db, pid, actor, origen = "REMOTO" }) {
  if (actor?.tipo !== "PREDIO") {
    if (actor?.tipo || !Number.isSafeInteger(Number(actor?.general_id)) || Number(actor.general_id) <= 0) throw U.error("La orden remota no identifica a su administrador", 403);
    const fila = await sesion.asegurarUsuarioGeneral({ db, pid, modo: "local", origen }, {
      id: Number(actor?.general_id) || 0,
      nombre: `${actor?.nombre || "Administración"} (sistema general)`,
      documento: String(actor?.documento || actor?.general_id || "0"),
    });
    return { id: Number(fila.id), usuario: fila.usuario, nombre: fila.nombre, rol: "ADMIN", bocas: [], es_admin_general: true };
  }
  const id = Number(actor.predio_usuario_id);
  if (Number(actor.predio_id) !== Number(pid) || !Number.isSafeInteger(id) || id <= 0
    || !/^[a-f0-9]{64}$/.test(actor.credencial_sha256 || "") || !Number.isSafeInteger(actor.cuenta_revision) || actor.cuenta_revision < 0) {
    throw U.error("La orden no contiene una cuenta válida de este predio", 403);
  }
  const u = await db.get("SELECT id, usuario, nombre, rol, activo, es_admin_general, password_hash, debe_cambiar_clave FROM predio_usuario WHERE predio_id = ? AND id = ?", [pid, id]);
  const auditoria = await db.get("SELECT COALESCE(MAX(id), 0) AS revision FROM predio_auditoria WHERE predio_id = ? AND entidad = 'usuario' AND entidad_id = ?", [pid, id]);
  if (!u || Number(u.activo) !== 1 || !["ADMIN", "SEGURIDAD"].includes(u.rol) || Number(u.es_admin_general) === 1
    || !U.igualesSeguros(U.sha256(u.password_hash || ""), actor.credencial_sha256) || Number(auditoria.revision) !== actor.cuenta_revision) {
    throw U.error("La cuenta que envió esta orden cambió o ya no tiene acceso. Volvé a ingresar y enviá el cambio otra vez.", 403);
  }
  const bocas = u.rol === "ADMIN" ? await db.all("SELECT id FROM predio_boca WHERE predio_id = ? AND activo = 1", [pid]) : [];
  return { id: Number(u.id), usuario: u.usuario, nombre: u.nombre, rol: u.rol, bocas: bocas.map(b => Number(b.id)), es_admin_general: false, debe_cambiar_clave: !!Number(u.debe_cambiar_clave) };
}
module.exports = { resolverActorRemoto };
