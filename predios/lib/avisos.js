"use strict";

const N = require("./negocio");
const U = require("./util");

// Sin destinatario es un aviso para todos los administradores del predio.
// Las lecturas son individuales y, como los avisos, se sincronizan con el sistema general.
async function emitirAviso(t, ctx, { tipo, usuarioId = null, generalUsuarioId = null, generalDocumento = null, titulo, mensaje, detalle = null }) {
  return N.insertar(t, ctx, "predio_aviso", {
    tipo, usuario_id: usuarioId, general_usuario_id: generalUsuarioId, general_documento: generalDocumento,
    titulo, mensaje, fecha: U.fechaHora(), detalle: detalle === null ? null : JSON.stringify(detalle),
  });
}

async function destinatarioSql(ctx, alias = "a") {
  const broadcast = `${alias}.usuario_id IS NULL AND ${alias}.general_usuario_id IS NULL AND ${alias}.general_documento IS NULL`;
  const condiciones = [`${alias}.usuario_id = ?`];
  const params = [ctx.usuario.id];
  if (ctx.usuario?.rol === "ADMIN") {
    condiciones.push(`(${broadcast})`);
    // Los avisos de un DNI que aún no había ingresado se vinculan sólo con la
    // identidad general ya validada por el servidor, nunca con datos del navegador.
    const u = await ctx.db.get("SELECT es_admin_general, general_usuario_id, documento FROM predio_usuario WHERE predio_id = ? AND id = ?", [ctx.pid, ctx.usuario.id]);
    const general = Number(u?.es_admin_general) === 1 ? u
      : (ctx.modo === "central" && ctx.origen === "REMOTO" && ctx.usuario.es_admin_general ? ctx.usuario : null);
    if (general) {
      if (general.general_usuario_id) { condiciones.push(`${alias}.general_usuario_id = ?`); params.push(general.general_usuario_id); }
      if (general.documento) { condiciones.push(`${alias}.general_documento = ?`); params.push(String(general.documento)); }
    }
  }
  return { sql: `(${condiciones.join(" OR ")})`, params };
}

async function listarAvisos(ctx) {
  const d = await destinatarioSql(ctx);
  const filas = await ctx.db.all(
    `SELECT a.* FROM predio_aviso a
     WHERE a.predio_id = ? AND ${d.sql} AND a.resuelto_fecha IS NULL
       AND NOT EXISTS (SELECT 1 FROM predio_aviso_lectura l WHERE l.predio_id = a.predio_id AND l.aviso_id = a.id AND l.usuario_id = ?)
     ORDER BY a.id DESC LIMIT 50`, [ctx.pid, ...d.params, ctx.usuario.id]);
  return filas.map((a) => {
    let detalle = null;
    try { detalle = a.detalle ? JSON.parse(a.detalle) : null; } catch (_e) { /* aviso anterior */ }
    return { id: a.id, tipo: a.tipo, titulo: a.titulo, mensaje: a.mensaje, fecha: a.fecha, detalle };
  });
}

async function leerAviso(ctx) {
  const id = U.id(ctx.params.id, "El aviso");
  const d = await destinatarioSql(ctx);
  return ctx.db.tx(async (t) => {
    const aviso = await t.get(`SELECT a.id FROM predio_aviso a WHERE a.predio_id = ? AND a.id = ? AND ${d.sql}`, [ctx.pid, id, ...d.params]);
    if (!aviso) throw U.error("No encontramos ese aviso", 404);
    const lectura = await t.get("SELECT id FROM predio_aviso_lectura WHERE predio_id = ? AND aviso_id = ? AND usuario_id = ?", [ctx.pid, id, ctx.usuario.id]);
    if (!lectura) await N.insertar(t, ctx, "predio_aviso_lectura", { aviso_id: id, usuario_id: ctx.usuario.id, fecha: U.fechaHora() });
    return { ok: true };
  });
}

module.exports = { emitirAviso, listarAvisos, leerAviso };
