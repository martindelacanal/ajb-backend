"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { resolverActorRemoto } = require("../lib/actor-remoto");
const api = require("../lib/api");
const N = require("../lib/negocio");
const U = require("../lib/util");
async function escenario(t) {
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 99, nombre: "Administración", rol: "ADMIN", bocas: [] }, sesion: {}, query: {} };
  let id;
  await db.tx(async tx => {
    id = await N.insertar(tx, ctx, "predio_usuario", { usuario: "encargado", nombre: "Encargado del camping", rol: "ADMIN", activo: 1, es_admin_general: 0, password_hash: U.hashPassword("clave-local") });
    await N.auditar(tx, ctx, "Alta de usuario", "usuario", id, {});
    await N.insertar(tx, ctx, "predio_boca", { nombre: "Recepción", activo: 1 });
  });
  const fila = await db.get("SELECT * FROM predio_usuario WHERE predio_id=1 AND id=?", [id]);
  const a = await db.get("SELECT MAX(id) AS revision FROM predio_auditoria WHERE predio_id=1 AND entidad='usuario' AND entidad_id=?", [id]);
  const actor = { tipo: "PREDIO", predio_id: 1, predio_usuario_id: id, credencial_sha256: U.sha256(fila.password_hash), cuenta_revision: a.revision };
  return { db, ctx, id, actor };
}
test("la orden usa la identidad local y su auditoría sin crear un administrador general", async t => {
  const s = await escenario(t);
  await s.db.tx(async tx => {
    const usuario = await resolverActorRemoto({ db: tx, pid: 1, actor: s.actor });
    assert.equal(usuario.id, s.id); assert.equal(usuario.es_admin_general, false); assert.deepEqual(usuario.bocas, [1]);
    await api.ejecutar({ ...s.ctx, db: tx, usuario, origen: "REMOTO", body: { nombre: "Producto desde casa", precio_compra: 100, margen: 20 } }, "POST", "/productos");
  });
  assert.equal((await s.db.get("SELECT COUNT(*) AS n FROM predio_usuario")).n, 1);
  const audit = await s.db.get("SELECT * FROM predio_auditoria WHERE entidad='producto' ORDER BY id DESC LIMIT 1");
  assert.equal(audit.usuario_id, s.id); assert.equal(audit.usuario_nombre, "Encargado del camping"); assert.equal(audit.origen, "REMOTO");
});
test("otro predio, un cajero, una cuenta desactivada y una clave o revisión anterior no autorizan la orden", async t => {
  for (const cambio of ["otro-predio", "rol", "activo", "clave", "revision", "general"]) {
    const s = await escenario(t);
    const actor = { ...s.actor };
    if (cambio === "otro-predio") actor.predio_id = 2;
    if (cambio === "rol") await s.db.run("UPDATE predio_usuario SET rol='CAJERO' WHERE predio_id=1 AND id=?", [s.id]);
    if (cambio === "activo") await s.db.run("UPDATE predio_usuario SET activo=0 WHERE predio_id=1 AND id=?", [s.id]);
    if (cambio === "clave") await s.db.run("UPDATE predio_usuario SET password_hash=? WHERE predio_id=1 AND id=?", [U.hashPassword("otra-clave"), s.id]);
    if (cambio === "revision") actor.cuenta_revision = 0;
    if (cambio === "general") await s.db.run("UPDATE predio_usuario SET es_admin_general=1 WHERE predio_id=1 AND id=?", [s.id]);
    await assert.rejects(s.db.tx(tx => resolverActorRemoto({ db: tx, pid: 1, actor })), e => e.status === 403, cambio);
  }
});
test("cambiar ADMIN a CAJERO y volver a ADMIN revoca órdenes anteriores aunque conserve contraseña y fecha", async t => {
  const s = await escenario(t);
  for (const rol of ["CAJERO", "ADMIN"]) {
    await s.db.tx(async tx => {
      await tx.run("UPDATE predio_usuario SET rol=? WHERE predio_id=1 AND id=?", [rol, s.id]);
      await N.auditar(tx, s.ctx, "Modificación de usuario", "usuario", s.id, { rol });
    });
  }
  await assert.rejects(s.db.tx(tx => resolverActorRemoto({ db: tx, pid: 1, actor: s.actor })), e => e.status === 403);
});
test("se conserva el acceso general válido y se rechazan actores sin identidad o con tipo desconocido", async t => {
  const s = await escenario(t);
  const usuario = await s.db.tx(tx => resolverActorRemoto({ db: tx, pid: 1, actor: { general_id: 15, documento: "22222222", nombre: "Admin general" } }));
  assert.equal(usuario.es_admin_general, true); assert.notEqual(usuario.id, s.id);
  for (const actor of [null, {}, { general_id: 0 }, { tipo: "GENERAL", general_id: 15 }, { tipo: "PREDIO", general_id: 15 }]) {
    await assert.rejects(s.db.tx(tx => resolverActorRemoto({ db: tx, pid: 1, actor })), e => e.status === 403);
  }
});
