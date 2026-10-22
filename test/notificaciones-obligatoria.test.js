"use strict";

// crearNotificacion({ obligatoria: true }): se guarda y se entrega aunque la persona haya
// silenciado esa categoría (el aviso de «firmá tu reserva» y el de la reserva que
// cargó el staff con las condiciones).

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearNotificacion } = require("../api/services/notificaciones");

test("un aviso obligatorio se inserta sin mirar las preferencias", async () => {
  const llamadas = [];
  const connection = { query: async (sql, params) => { llamadas.push({ sql, params }); return [{ insertId: 31, affectedRows: 1 }]; } };
  const resultado = await crearNotificacion(connection, {
    usuarioId: 9, tipo: "RESERVA_FIRMA_PENDIENTE", titulo: "Firmá tu reserva T-41", mensaje: "Leé las condiciones",
    payload: { reserva_id: 41 }, categoria: "gestiones", obligatoria: true,
  });
  assert.equal(resultado.insertId, 31);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].sql, "INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)");
  assert.doesNotMatch(llamadas[0].sql, /usuario_notificacion_preferencia/);
  assert.deepEqual(llamadas[0].params, [9, "RESERVA_FIRMA_PENDIENTE", "Firmá tu reserva T-41", "Leé las condiciones", '{"reserva_id":41}']);
});

test("sin obligatoria (o con un valor que no es true) sigue respetando la preferencia", async () => {
  for (const obligatoria of [undefined, false, 1, "true"]) {
    const llamadas = [];
    const connection = { query: async (sql, params) => { llamadas.push({ sql, params }); return [{ insertId: 0, affectedRows: 0 }]; } };
    const resultado = await crearNotificacion(connection, {
      usuarioId: 9, tipo: "RESERVA_FIRMA_RECIBIDA", titulo: "t", mensaje: "m", categoria: "estados", obligatoria,
    });
    assert.equal(resultado.insertId, null, String(obligatoria));
    assert.match(llamadas[0].sql, /SELECT estados FROM usuario_notificacion_preferencia WHERE usuario_id = \?/);
  }
});

test("un aviso obligatorio igual valida destinatario y categoría", async () => {
  let llamadas = 0;
  const connection = { query: async () => { llamadas += 1; return [{ insertId: 1 }]; } };
  assert.equal((await crearNotificacion(connection, { usuarioId: "x", tipo: "RESERVA_FIRMA_PENDIENTE", obligatoria: true })).insertId, null);
  await assert.rejects(crearNotificacion(connection, { usuarioId: 9, categoria: "otra", obligatoria: true }), /Categoría de notificación inválida/);
  assert.equal(llamadas, 0);
});
