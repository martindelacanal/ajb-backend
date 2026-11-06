"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { nuevosAvisos, entregarAvisos } = require("../api/services/predios-avisos");
const predio = { id: 1, codigo: "MIRAMAR", nombre: "Camping Miramar" };

test("replicar avisos descarta identificadores previos y repetidos antes de entregarlos", async () => {
  const db = { query: async (sql, params) => {
    assert.match(sql, /FROM predio_aviso WHERE predio_id/);
    assert.deepEqual(params, [1, 2, 3]);
    return [[{ id: 2 }]];
  } };
  assert.deepEqual(await nuevosAvisos(db, 1, [{ id: 2 }, { id: 3, mensaje: "primero" }, { id: 3, mensaje: "último" }, { id: -1 }]), [{ id: 3, mensaje: "último" }]);
  assert.deepEqual(await nuevosAvisos(db, 1, []), []);
});

function conexion({ admins = [{ id: 7 }], generalId = null, fallarEntrega = false } = {}) {
  const inserts = [];
  const consultas = [];
  return { inserts, consultas, async query(sql, params) {
    consultas.push({ sql, params });
    if (sql.includes("FROM predio_usuario")) return [[{ general_usuario_id: generalId }]];
    if (sql.includes("FROM usuario u JOIN rol")) {
      if (!params.length) assert.match(sql, /r.nombre = 'admin'/);
      else assert.doesNotMatch(sql, /r.nombre = 'admin'/);
      return [admins];
    }
    assert.match(sql, /^INSERT INTO notificacion/);
    if (fallarEntrega) throw new Error("Entrega interrumpida");
    inserts.push(params);
    return [{ insertId: inserts.length }];
  } };
}
const aviso = { id: 5, tipo: "ACCESO_FALLIDO", titulo: "5 intentos", mensaje: "Boca y caja · horario", fecha: "2026-11-05 18:00:00" };

test("aviso de acceso es privado y obligatorio para cualquier rol, incluso con novedades silenciadas", async () => {
  const db = conexion();
  await entregarAvisos(db, predio, [{ ...aviso, general_documento: "12345678" }]);
  assert.deepEqual(db.consultas[0].params, ["12345678"]);
  assert.match(db.consultas[0].sql, /u.documento = \?/);
  assert.equal(db.inserts.length, 1);
  assert.equal(db.inserts[0][1], "PREDIO_ACCESO_FALLIDO");
  assert.deepEqual(JSON.parse(db.inserts[0][4]), { predio: "MIRAMAR", aviso_id: 5, fecha: aviso.fecha });
  assert.ok(db.consultas.every(c => !c.sql.includes("usuario_notificacion_preferencia")));
});

test("cuentas locales reciben sólo campana del predio y un acceso sin destinatario nunca se difunde", async () => {
  const db = conexion();
  await entregarAvisos(db, predio, [{ ...aviso, usuario_id: 8 }, aviso]);
  assert.equal(db.inserts.length, 0);
  assert.equal(db.consultas.length, 1);
});

test("cuenta general ya conocida se resuelve por su ID y el stock avisa a cada administrador", async () => {
  const db = conexion({ admins: [{ id: 7 }, { id: 9 }], generalId: 7 });
  await entregarAvisos(db, predio, [{ ...aviso, usuario_id: 8 }]);
  assert.match(db.consultas[1].sql, /u.id = \?/);
  assert.deepEqual(db.consultas[1].params, [7]);
  const stock = conexion({ admins: [{ id: 7 }, { id: 9 }] });
  await entregarAvisos(stock, predio, [{ ...aviso, tipo: "VENTA_SIN_STOCK" }]);
  assert.deepEqual(stock.inserts.map(p => p[0]), [7, 9]);
});

test("si falla la entrega se propaga el error para revertir la réplica y reintentar sin perder el aviso", async () => {
  const db = conexion({ fallarEntrega: true });
  await assert.rejects(entregarAvisos(db, predio, [{ ...aviso, general_usuario_id: 7 }]), /Entrega interrumpida/);
});

test("stock mínimo se entrega a los administradores y las cuentas de boca quedan privadas", async () => {
  const db = conexion({ admins: [{ id: 7 }, { id: 9 }] });
  await entregarAvisos(db, predio, [{ ...aviso, tipo: "STOCK_MINIMO" }]);
  assert.deepEqual(db.inserts.map((p) => p[0]), [7, 9]);
  assert.ok(db.inserts.every((p) => p[1] === "PREDIO_STOCK_MINIMO"));
  const local = conexion();
  await entregarAvisos(local, predio, [{ ...aviso, tipo: "STOCK_MINIMO", usuario_id: 8 }]);
  assert.equal(local.inserts.length, 0);
  const resuelto = conexion();
  await entregarAvisos(resuelto, predio, [{ ...aviso, tipo: "STOCK_MINIMO", resuelto_fecha: "2026-11-06 10:00:00" }]);
  assert.equal(resuelto.inserts.length, 0);
});
