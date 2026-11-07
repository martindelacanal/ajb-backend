"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { SQL_MARCAR_TEMPORALES } = require("../lib/claves-usuario");

test("una clave anterior sólo queda pendiente si su última emisión consta como alta o reset administrativo", t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  t.after(() => db.cerrar());
  asegurarEsquema(db);
  const alta = "Alta de usuario", cambio = "Cambio de contraseña propia", edicion = "Modificación de usuario";
  const casos = [
    { hechos: [[alta], [edicion, { rol: "ADMIN" }]], pendiente: 1 },
    { hechos: [[alta], [cambio], [edicion, { nombre: "nuevo" }]], pendiente: 0 },
    { hechos: [[alta], [cambio], [edicion, { password: "cambiada" }]], pendiente: 1 },
    { hechos: [["Alta del primer administrador"]], pendiente: 0 },
    { hechos: [], pendiente: 0 },
    { hechos: [[alta]], general: true, pendiente: 0 },
  ];
  let auditId = 0;
  for (const [i, caso] of casos.entries()) {
    db.conexion.prepare("INSERT INTO predio_usuario(predio_id,id,usuario,nombre,rol,password_hash,es_admin_general) VALUES(1,?,?,?,'ADMIN','fixture',?)")
      .run(i + 1, "usuario-" + i, "Usuario", Number(!!caso.general));
    for (const [accion, detalle] of caso.hechos) {
      db.conexion.prepare("INSERT INTO predio_auditoria(predio_id,id,fecha,accion,entidad,entidad_id,detalle) VALUES(1,?,datetime('now'),?,'usuario',?,?)")
        .run(++auditId, accion, i + 1, JSON.stringify(detalle || null));
    }
  }
  db.exec("DELETE FROM predio_meta WHERE clave='claves_emitidas_v1'");
  asegurarEsquema(db);
  assert.deepEqual(db.conexion.prepare("SELECT debe_cambiar_clave FROM predio_usuario ORDER BY id").all().map(u => u.debe_cambiar_clave), casos.map(c => c.pendiente));
  assert.equal(db.conexion.prepare(SQL_MARCAR_TEMPORALES).run().changes, 0);
});
