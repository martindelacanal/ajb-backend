"use strict";

const U = require("./util");
const N = require("./negocio");
const { puedeGestionarCajas } = require("./api/comun");

async function turnoAbierto(db, pid, cajaId) {
  return db.get("SELECT * FROM predio_turno WHERE predio_id=? AND caja_id=? AND estado='ABIERTO' ORDER BY id DESC LIMIT 1", [pid, cajaId]);
}

async function turnoUsuario(db, pid, usuarioId) {
  return db.get("SELECT * FROM predio_turno WHERE predio_id=? AND usuario_id=? AND estado='ABIERTO' ORDER BY id DESC LIMIT 1", [pid, usuarioId]);
}

function exigirCierre(ctx) {
  const cierre = puedeGestionarCajas(ctx) ? "el cierre de caja" : "un cierre temporal";
  throw U.error(`Tu turno tiene ventas o movimientos de caja. Hacé ${cierre} antes de salir.`, 409, { codigo: "TURNO_ABIERTO" });
}

// Un turno sin ventas ni movimientos de caja no tiene nada que contar: al salir o
// cambiar de puesto se libera sin cierre. Pasa, por ejemplo, cuando el cajero vuelve a
// entrar después de su cierre temporal y el sistema lo ubica solo en su única caja.
// Devuelve true si el turno quedó liberado.
async function liberarTurnoVacio(t, ctx, turno) {
  const venta = await t.get("SELECT id FROM predio_venta WHERE predio_id=? AND turno_id=? LIMIT 1", [ctx.pid, turno.id]);
  const movimiento = venta ? null : await t.get("SELECT id FROM predio_caja_movimiento WHERE predio_id=? AND turno_id=? LIMIT 1", [ctx.pid, turno.id]);
  if (venta || movimiento) return false;
  const fin = U.fechaHora();
  await t.run("UPDATE predio_turno SET fin=?, estado='CERRADO' WHERE predio_id=? AND id=? AND estado='ABIERTO'", [fin, ctx.pid, turno.id]);
  if (t.dialecto === "sqlite") await t.run("UPDATE predio_sesion SET boca_id=NULL, caja_id=NULL, turno_id=NULL WHERE turno_id=?", [turno.id]);
  await N.auditar(t, ctx, "Turno sin movimientos liberado", "caja", turno.caja_id, { turno_id: turno.id, inicio: turno.inicio, fin });
  return true;
}

// Para salir: libera el turno propio si está vacío; si tiene movimientos, pide el cierre.
async function exigirCierreOLiberar(t, ctx, turno) {
  if (turno && !(await liberarTurnoVacio(t, ctx, turno))) exigirCierre(ctx);
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

module.exports = { turnoAbierto, turnoUsuario, exigirCierre, exigirCierreOLiberar, liberarTurnoVacio, verificarOperador };
