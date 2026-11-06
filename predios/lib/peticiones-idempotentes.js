"use strict";

const crypto = require("node:crypto");
const U = require("./util");

function canonico(valor) {
  if (Array.isArray(valor)) return valor.map(canonico);
  if (valor && typeof valor === "object") return Object.fromEntries(Object.keys(valor).sort().map((k) => [k, canonico(valor[k])]));
  return valor;
}

// La respuesta viaja en la misma instantánea que los cambios comerciales. Repetir
// un cobro cuyo resultado se perdió devuelve el resultado sin volver a cobrar.
async function ejecutarPeticion(ctx, { id, metodo, ruta }, ejecutar) {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(String(id || ""))) throw U.error("La operación no tiene un identificador válido", 400);
  if (!ctx.usuario?.id) throw U.error("Iniciá sesión para continuar", 401);
  const hash = crypto.createHash("sha256").update(JSON.stringify(canonico({ metodo, ruta, query: ctx.query || {}, body: ctx.body || {} }))).digest("hex");
  return ctx.db.tx(async (t) => {
    const previo = await t.get("SELECT peticion_sha256, status, respuesta FROM predio_peticion WHERE usuario_id = ? AND operacion_id = ?", [ctx.usuario.id, id]);
    if (previo) {
      if (previo.peticion_sha256 !== hash) throw U.error("Ese identificador ya se usó para una operación diferente", 409, { codigo: "OPERACION_DIFERENTE" });
      return { status: Number(previo.status), respuesta: JSON.parse(previo.respuesta), repetida: true };
    }
    await t.run("SAVEPOINT peticion_usuario");
    let status = 200, respuesta;
    try {
      respuesta = await ejecutar({ ...ctx, db: t });
      await t.run("RELEASE SAVEPOINT peticion_usuario");
    } catch (e) {
      await t.run("ROLLBACK TO SAVEPOINT peticion_usuario");
      await t.run("RELEASE SAVEPOINT peticion_usuario");
      if (!e.status || e.status >= 500) throw e;
      status = e.status;
      const { status: _status, message, stack, name, ...detalle } = e;
      respuesta = { mensaje: message, ...detalle };
    }
    const texto = JSON.stringify(respuesta ?? null);
    if (Buffer.byteLength(texto) > 3 * 1024 * 1024) throw U.error("La respuesta de la operación es demasiado grande", 500);
    await t.run("INSERT INTO predio_peticion (operacion_id, usuario_id, peticion_sha256, fecha, status, respuesta) VALUES (?, ?, ?, ?, ?, ?)", [id, ctx.usuario.id, hash, U.fechaHora(), status, texto]);
    return { status, respuesta, repetida: false };
  });
}

module.exports = { ejecutarPeticion };
