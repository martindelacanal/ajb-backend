"use strict";

const U = require("./util");
const N = require("./negocio");

async function reiniciarUsuariosPredio(db, pid, cuerpo = {}) {
  if (!cuerpo || typeof cuerpo !== "object") throw U.error("Falta la confirmación del reinicio de usuarios");
  if (db.dialecto !== "sqlite" || Number(db.predioId) !== Number(pid)
    || U.id(cuerpo.predio_id, "El predio") !== Number(pid)) {
    throw U.error("El reinicio de usuarios no corresponde a este predio", 409);
  }
  if (cuerpo.confirmacion !== "ELIMINAR_TODOS_LOS_USUARIOS_DEL_PREDIO"
    || !Array.isArray(cuerpo.usuarios) || !cuerpo.usuarios.length) {
    throw U.error("Falta confirmar la lista de usuarios del predio que se va a eliminar");
  }
  const esperados = cuerpo.usuarios.map(u => ({
    id: U.id(u?.id, "El usuario"),
    usuario: U.texto(u?.usuario, { max: 60, requerido: true, campo: "El usuario esperado" }),
  })).sort((a, b) => a.id - b.id);
  if (new Set(esperados.map(u => u.id)).size !== esperados.length) {
    throw U.error("La lista de usuarios esperados tiene identificadores repetidos");
  }
  return db.tx(async t => {
    const actuales = await t.all("SELECT id, usuario FROM predio_usuario WHERE predio_id = ? ORDER BY id", [pid]);
    if (actuales.length !== esperados.length || actuales.some((u, i) => Number(u.id) !== esperados[i].id || u.usuario !== esperados[i].usuario)) {
      throw U.error("La lista de usuarios cambió. Revisá las cuentas antes de reiniciar el acceso al predio", 409);
    }
    await N.auditar(t, { pid, origen: "SISTEMA", usuario: { id: null, nombre: "Administración Mi AJB" } },
      "Reinicio de usuarios del predio", "usuario", null, { usuarios: esperados });
    // Estos registros locales no tienen predio_id. Se acotan por las cuentas
    // verificadas antes de borrarlas, manteniendo las cuentas generales de Mi AJB.
    await t.run("DELETE FROM predio_sesion WHERE usuario_id IN (SELECT id FROM predio_usuario WHERE predio_id = ?)", [pid]);
    await t.run("DELETE FROM predio_peticion WHERE usuario_id IN (SELECT id FROM predio_usuario WHERE predio_id = ?)", [pid]);
    await t.run(`DELETE FROM predio_admin_cache
      WHERE documento IN (SELECT documento FROM predio_usuario WHERE predio_id = ? AND es_admin_general = 1)
      OR general_id IN (SELECT general_usuario_id FROM predio_usuario WHERE predio_id = ? AND es_admin_general = 1)`, [pid, pid]);
    await t.run("DELETE FROM predio_usuario_boca WHERE predio_id = ?", [pid]);
    await t.run("DELETE FROM predio_aviso_lectura WHERE predio_id = ?", [pid]);
    await t.run("DELETE FROM predio_usuario WHERE predio_id = ?", [pid]);
    return { mensaje: "Usuarios eliminados. Abrí el sistema en la PC servidora para crear el administrador definitivo.", eliminados: actuales.length, configurado: false };
  });
}

module.exports = { reiniciarUsuariosPredio };
