"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
let configuracion;
let enviados;
let resultado;
const correoPath = require.resolve("../api/services/correo");
require.cache[correoPath] = {
  id: correoPath, filename: correoPath, loaded: true,
  exports: {
    estadoCorreo: () => configuracion,
    urlAplicacion: ruta => `https://example.test${ruta}`,
    enviarCorreoPlantilla: async mensaje => { enviados.push(mensaje); return resultado; },
  },
};
const { enviarCorreoSolicitudTitular } = require("../api/services/reservas-familiares");

test.beforeEach(() => {
  configuracion = { modoPruebas: false, redirigirA: null };
  enviados = [];
  resultado = { enviado: true };
});

function outbox() {
  const consultas = [];
  const fila = { enviada: false, intentos: 0, error: null };
  return {
    fila, consultas,
    db: { async query(sql, params) {
      consultas.push({ sql, params });
      if (/SELECT a.reserva_id/.test(sql)) return [fila.enviada ? [] : [{ reserva_id: 7, email: "titular@example.test", nombre: "Titular", fecha_inicio: "2099-10-10", fecha_fin: "2099-10-12" }]];
      if (/SET correo_ultimo_intento_en/.test(sql)) { fila.intentos++; return [{ affectedRows: 1 }]; }
      if (/SET correo_enviado_en/.test(sql)) { fila.enviada = params[0] === 1; fila.error = params[1]; return [{ affectedRows: 1 }]; }
      assert.fail("Consulta inesperada");
    } },
  };
}

test("modo pruebas o redirección preservan outbox sin SMTP, sin claim y sin marcar entregado", async () => {
  for (const config of [
    { modoPruebas: true, redirigirA: null },
    { modoPruebas: true, redirigirA: "qa@example.test" },
    { modoPruebas: false, redirigirA: "qa@example.test" },
  ]) {
    configuracion = config;
    const pendiente = outbox();
    await enviarCorreoSolicitudTitular(pendiente.db, 7);
    assert.equal(pendiente.consultas.length, 0);
    assert.equal(pendiente.fila.enviada, false);
    assert.equal(pendiente.fila.intentos, 0);
  }
  assert.equal(enviados.length, 0);
});

test("al habilitar envíos reales se retoma la fila pendiente y se marca sólo después de entregar", async () => {
  const pendiente = outbox();
  configuracion = { modoPruebas: true, redirigirA: "qa@example.test" };
  await enviarCorreoSolicitudTitular(pendiente.db, 7);
  assert.equal(pendiente.fila.enviada, false);
  configuracion = { modoPruebas: false, redirigirA: null };
  await enviarCorreoSolicitudTitular(pendiente.db, 7);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].para, "titular@example.test");
  assert.equal(enviados[0].boton.url, "https://example.test/mis-gestiones?aprobacion_reserva=7");
  assert.equal(pendiente.fila.enviada, true);
  assert.equal(pendiente.fila.intentos, 1);
  await enviarCorreoSolicitudTitular(pendiente.db, 7);
  assert.equal(enviados.length, 1);
});

test("un fallo de SMTP conserva la fila pendiente para reintento", async () => {
  const pendiente = outbox();
  resultado = { enviado: false, motivo: "error_smtp" };
  await enviarCorreoSolicitudTitular(pendiente.db, 7);
  assert.equal(pendiente.fila.enviada, false);
  assert.equal(pendiente.fila.error, "error_smtp");
  assert.equal(pendiente.fila.intentos, 1);
});
