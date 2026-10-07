"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { REGLAS_INICIALES } = require("../api/services/politica-cancelacion");

const secreto = "politica-cancelacion-http-test-secret";
process.env.JWT_SECRET = secreto;
let usuarioActual;
let consultas = [];
let reservaActual;
let lecturaConsistente;
let aislamientoRepetible;
const politica = { id: 1, version: 1, titulo: "Hospedaje", reglas_json: REGLAS_INICIALES, motivo: "Motivo interno", creada_por: 9 };
const db = {
  async query(sql, params) {
    consultas.push({ sql, params });
    if (sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ") { aislamientoRepetible = true; return [{}]; }
    if (sql === "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY") { assert.equal(aislamientoRepetible, true); lecturaConsistente = true; return [{}]; }
    if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u/.test(sql)) return [[usuarioActual]];
    if (/FROM reserva r/.test(sql)) return [[reservaActual]];
    if (/FROM reserva_politica_cancelacion/.test(sql)) return [[]];
    if (/SELECT politica_id/.test(sql)) return [[{ politica_id: 1 }]];
    if (/FROM servicio s/.test(sql)) {
      // Simula una publicación concurrente entre historial y catálogo: fuera
      // del snapshot devolvería v2 mientras el historial anterior contiene v1.
      return [[{ id: 7, nombre: "Hospedaje", activo: 1, politica_id: lecturaConsistente ? 1 : 2, politica_version: lecturaConsistente ? 1 : 2 }]];
    }
    if (/FROM politica_cancelacion_servicio ps/.test(sql)) return [[{ politica_id: 1, servicio_id: 7, nombre: "Hospedaje" }]];
    if (/FROM politica_cancelacion_autoria_auditoria/.test(sql)) return [[]];
    if (/FROM politica_cancelacion/.test(sql)) return [[{ ...politica, vigente: 1 }]];
    throw new Error(`Consulta inesperada: ${sql}`);
  },
  async beginTransaction() {}, async commit() { lecturaConsistente = false; }, async rollback() { lecturaConsistente = false; }, release() {},
  async getConnection() { return this; },
};
const rutaConexion = require.resolve("../api/connection/connection");
require.cache[rutaConexion] = { id: rutaConexion, filename: rutaConexion, loaded: true, exports: { promise: () => db } };

const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/politica-cancelacion"));
let server;
let base;
test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => { await new Promise((resolve) => server.close(resolve)); });
test.beforeEach(() => {
  consultas = [];
  lecturaConsistente = false;
  aislamientoRepetible = false;
  usuarioActual = { id: 20, rol: "afiliado", habilitado: "Y", modulo_turismo: 1, area_turismo: 1, departamental_id: 4 };
  reservaActual = { id: 30, usuario_id: 20, servicio_id: 7, precio_total: "100.50", estado_nombre: "Iniciada", modalidad: "FECHA_LIBRE", fecha_inicio: "2099-10-22", usuario_departamental_id: 4 };
});

async function pedir(path, { claims, method = "GET", body, sinToken = false } = {}) {
  const token = jwt.sign({ data: JSON.stringify(claims || usuarioActual) }, secreto);
  const response = await fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(sinToken ? {} : { Authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test("política requiere autenticación y sólo expone condiciones, sin identidad del admin ni motivo interno", async () => {
  assert.equal((await pedir("/turismo/politica-cancelacion", { sinToken: true })).status, 401);
  assert.equal((await pedir("/turismo/politica-cancelacion")).status, 400);
  const respuesta = await pedir("/turismo/politica-cancelacion?servicio_id=7");
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.politica.version, 1);
  assert.equal(respuesta.body.politica.servicio_id, 7);
  assert.equal(respuesta.body.politica.motivo, undefined);
  assert.equal(respuesta.body.politica.creada_por, undefined);
});

test("afiliado, departamental y admin-central sin área no pueden leer ni escribir auditoría", async () => {
  for (const [rol, area] of [["afiliado", 1], ["departamental", 1], ["admin-central", 0]]) {
    usuarioActual = { ...usuarioActual, rol, area_turismo: area };
    for (const method of ["GET", "POST"]) {
      const respuesta = await pedir("/admin/turismo/politicas-cancelacion", { method, body: method === "POST" ? {} : undefined });
      assert.equal(respuesta.status, 403, `${rol} ${method}`);
    }
  }
  assert.ok(!consultas.some(({ sql }) => /FROM politica_cancelacion/.test(sql)));
});

test("revocar rol admin en BD invalida permisos aun con el JWT anterior", async () => {
  const respuesta = await pedir("/admin/turismo/politicas-cancelacion", { claims: { ...usuarioActual, rol: "admin" } });
  assert.equal(respuesta.status, 403);
});

test("administrador puede leer historial completo y versión actual", async () => {
  usuarioActual.rol = "admin";
  const respuesta = await pedir("/admin/turismo/politicas-cancelacion");
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.vigente.version, 1);
  assert.equal(respuesta.body.historial[0].motivo, "Motivo interno");
  assert.deepEqual(respuesta.body.historial[0].servicios_ids, [7]);
  assert.deepEqual(respuesta.body.historial[0].servicios_vigentes_ids, [7]);
  assert.equal(respuesta.body.vigentes[0].servicio_id, 7);
  assert.equal(respuesta.body.vigentes[0].politica.version, respuesta.body.servicios[0].politica_version);
  assert.equal(lecturaConsistente, false, "La transacción de lectura se confirma antes de responder");
});

test("cotización permite dueño y bloquea ajenos, otras departamentales y reserva terminal", async () => {
  const propia = await pedir("/reserva/30/cancelacion-cotizacion");
  assert.equal(propia.status, 200);
  assert.equal(propia.body.porcentaje_reintegro, 100);
  assert.equal(propia.body.monto_base, 100.50);
  assert.equal(propia.body.monto_reintegro, 100.50);
  assert.match(propia.body.cotizacion, /^[a-f0-9]{64}$/);
  assert.equal(propia.body.politica.motivo, undefined);
  usuarioActual.id = 21;
  assert.equal((await pedir("/reserva/30/cancelacion-cotizacion")).status, 403);
  usuarioActual = { ...usuarioActual, rol: "departamental", departamental_id: 5 };
  assert.equal((await pedir("/reserva/30/cancelacion-cotizacion")).status, 403);
  usuarioActual = { ...usuarioActual, id: 20, rol: "afiliado" };
  reservaActual.estado_nombre = "Cancelada";
  assert.equal((await pedir("/reserva/30/cancelacion-cotizacion")).status, 403);
});

test("no cotiza cancelación cuando ya pasó el check-in", async () => {
  reservaActual.fecha_inicio = "2000-01-01";
  const respuesta = await pedir("/reserva/30/cancelacion-cotizacion");
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "RESERVA_FECHA_VENCIDA");
});
