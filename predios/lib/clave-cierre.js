"use strict";

const crypto = require("node:crypto");
const U = require("./util");

// Una clave queda ligada al administrador, caja y corte contable que la originaron.
// Se invalida al cerrar, generar otra, cambiar de servidor o superar cinco intentos.
const claves = new Map();

function huella(pid, cajaId, clave) {
  if (!/^\d{8}$/.test(String(clave || "").trim())) return null;
  return crypto.scryptSync(String(clave).trim(), `AJB-cierre/${pid}/${cajaId}`, 32).toString("hex");
}

function nueva(pid, cajaId) {
  const clave = String(crypto.randomInt(100000000)).padStart(8, "0");
  const venceMs = Date.now() + 5 * 60 * 1000;
  return { privada: { clave, vence: U.fechaHora(new Date(venceMs)) }, registro: { hash: huella(pid, cajaId, clave), vence: venceMs } };
}

function generar(ctx, cajaId, turnoId, ultimoCierreId) {
  const remota = ctx.emisionClaveCierre;
  const { privada, registro } = remota ? { privada: { ok: true }, registro: remota } : nueva(ctx.pid, cajaId);
  if (!/^[a-f0-9]{64}$/.test(registro.hash) || !Number.isSafeInteger(registro.vence) || registro.vence <= Date.now()) {
    throw U.error("La solicitud de clave venció. Generá una nueva.", 409);
  }
  for (const [id, r] of claves) if (r.vence <= Date.now()) claves.delete(id);
  claves.set(ctx.pid + "/" + cajaId, { ...registro, turnoId, ultimoCierreId, intentos: 0, adminId: ctx.usuario.id });
  return privada;
}

async function verificar(t, ctx, cajaId, turnoId, ultimoCierreId) {
  const clave = String(ctx.body.clave || "").trim();
  const registro = claves.get(ctx.pid + "/" + cajaId);
  if ((!clave && !ctx.hashClaveCierre) || !registro || registro.vence <= Date.now() || registro.intentos >= 5 ||
      registro.turnoId !== turnoId || registro.ultimoCierreId !== ultimoCierreId) {
    throw U.error("Pedile al administrador una clave temporal de cierre para esta caja.", 403, { codigo: "CLAVE_CIERRE_REQUERIDA" });
  }
  if (!U.igualesSeguros(ctx.hashClaveCierre || huella(ctx.pid, cajaId, clave), registro.hash)) {
    registro.intentos++;
    throw U.error("La clave temporal de cierre es incorrecta.", 403, { codigo: "CLAVE_CIERRE_INCORRECTA" });
  }
  const admin = await t.get("SELECT id, nombre FROM predio_usuario WHERE predio_id=? AND id=? AND rol='ADMIN' AND activo=1", [ctx.pid, registro.adminId]);
  if (!admin) throw U.error("El administrador que emitió la clave ya no puede autorizar el cierre.", 403);
  return { metodo: "CLAVE_TEMPORAL", admin_id: admin.id, administrador: admin.nombre };
}

module.exports = { generar, verificar, nueva, huella };
