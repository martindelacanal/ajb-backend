"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { notificarParticipantesChat } = require("../api/services/chat-notificaciones");

test("coseguro notifica al resto de los participantes que pueden leer el trámite", async () => {
  const entregas = [];
  const perfiles = [
    { id: 1, rol: "admin" },
    { id: 2, rol: "admin-central", area_coseguro: 1 },
    { id: 3, rol: "departamental", departamental_id: 7, area_coseguro: 1 },
    { id: 4, rol: "departamental", departamental_id: 8, area_coseguro: 1 },
    { id: 5, rol: "admin-central", area_coseguro: 0 },
    { id: 6, rol: "auditor" },
    { id: 10, rol: "afiliado", modulo_coseguro: 1 },
    { id: 11, rol: "afiliado", modulo_coseguro: 1 },
  ];
  const db = { async query(sql, params) {
    if (sql.includes("FROM usuario u")) return [perfiles];
    assert.match(sql, /INSERT INTO notificacion/);
    entregas.push(params[0]);
    return [{ affectedRows: 1, insertId: entregas.length }];
  } };
  const base = { modulo: "coseguro", entidadId: 31, autorId: 3,
    tipo: "COSEGURO_OBSERVACION", titulo: "Nuevo mensaje", mensaje: "Hola", payload: { solicitud_id: 31 } };
  await notificarParticipantesChat(db, { ...base, entidad: { usuario_id: 10, departamental_id: 7, estado_id: 7 } });
  assert.deepEqual(entregas, [1, 2, 6, 10]);
  entregas.length = 0;
  await notificarParticipantesChat(db, { ...base, entidad: { usuario_id: 10, departamental_id: 7, estado_id: 3 } });
  assert.deepEqual(entregas, [1, 2, 10]);
});
