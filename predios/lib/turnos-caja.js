"use strict";

const U = require("./util");

async function turnoAbierto(db, pid, cajaId) {
  return db.get("SELECT * FROM predio_turno WHERE predio_id=? AND caja_id=? AND estado='ABIERTO' ORDER BY id DESC LIMIT 1", [pid, cajaId]);
}

async function turnoUsuario(db, pid, usuarioId) {
  return db.get("SELECT * FROM predio_turno WHERE predio_id=? AND usuario_id=? AND estado='ABIERTO' ORDER BY id DESC LIMIT 1", [pid, usuarioId]);
}

function exigirCierre() {
  throw U.error("Primero cerrá tu caja para dejarla disponible.", 409, { codigo: "TURNO_ABIERTO" });
}

// Revalidar dentro de la transacción: el cierre o un nuevo ingreso pueden
// haber liberado el puesto después de autenticar la petición HTTP.
async function verificarOperador(t, ctx, cajaId) {
  const turno = await turnoAbierto(t, ctx.pid, cajaId);
  if (turno && Number(turno.usuario_id) !== Number(ctx.usuario.id)) {
    throw U.error("La caja está ocupada por " + turno.usuario_nombre + ".", 409, { codigo: "CAJA_OCUPADA" });
  }
  if (ctx.sesion?.token_hash) {
    const actual = await t.get("SELECT turno_id FROM predio_sesion WHERE token_hash=? AND usuario_id=? AND caja_id=?", [ctx.sesion.token_hash, ctx.usuario.id, cajaId]);
    if (!turno || Number(turno.id) !== Number(actual?.turno_id) || Number(turno.id) !== Number(ctx.sesion.turno_id)) {
      throw U.error("Este turno ya no está disponible. Volvé a elegir tu caja.", 409, { codigo: "SIN_PUESTO" });
    }
  }
  return turno;
}

module.exports = { turnoAbierto, turnoUsuario, exigirCierre, verificarOperador };
