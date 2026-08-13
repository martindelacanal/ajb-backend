"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "dashboard-test-secret";
process.env.DASHBOARD_CACHE_MS = "30000";

const databaseCalls = [];

function resultadoPara(sql) {
  if (sql.includes("dashboard:red")) {
    return [[{
      usuarios_total: 120,
      usuarios_habilitados: 111,
      usuarios_nuevos_30_dias: 7,
      departamentales_total: 20,
      departamentales_habilitadas: 19,
    }]];
  }
  if (sql.includes("dashboard:turismo")) {
    return [[
      { estado_id: 1, nombre: "Iniciada", cantidad: 4, actividad_30_dias: 2, proximas_30_dias: 0 },
      { estado_id: 2, nombre: "Verificada", cantidad: 3, actividad_30_dias: 1, proximas_30_dias: 0 },
      { estado_id: 3, nombre: "Aprobada", cantidad: 9, actividad_30_dias: 2, proximas_30_dias: 5 },
    ]];
  }
  if (sql.includes("dashboard:coseguro")) {
    return [[
      { estado_id: 1, nombre: "Solicitud iniciada", cantidad: 2, actividad_30_dias: 2, importe_total: 1000 },
      { estado_id: 3, nombre: "Solicitud revisada", cantidad: 1, actividad_30_dias: 1, importe_total: 800 },
      { estado_id: 4, nombre: "Aprobado por departamental", cantidad: 4, actividad_30_dias: 2, importe_total: 2000 },
      { estado_id: 9, nombre: "Pendiente de acreditación", cantidad: 2, actividad_30_dias: 0, importe_total: 1450.5 },
    ]];
  }
  if (sql.includes("dashboard:traslados")) {
    return [[
      { estado_id: 1, nombre: "Iniciada", cantidad: 6, actividad_30_dias: 3, concretados_30_dias: 0 },
      { estado_id: 2, nombre: "Concretada", cantidad: 5, actividad_30_dias: 1, concretados_30_dias: 2 },
      { estado_id: 3, nombre: "Cancelada", cantidad: 1, actividad_30_dias: 0, concretados_30_dias: 0 },
    ]];
  }
  if (sql.includes("dashboard:noticias")) {
    return [[
      { estado: "BORRADOR", cantidad: 3, actividad_30_dias: 2, publicadas: 0, programadas: 0, destacadas: 0 },
      { estado: "PUBLICADA", cantidad: 8, actividad_30_dias: 3, publicadas: 7, programadas: 1, destacadas: 2 },
      { estado: "ARCHIVADA", cantidad: 4, actividad_30_dias: 0, publicadas: 0, programadas: 0, destacadas: 0 },
    ]];
  }
  if (sql.includes("dashboard:olimpiadas")) {
    return [[{ ediciones_activas: 1, inscripciones_activas: 46, actividad_30_dias: 11 }]];
  }
  if (sql.includes("dashboard:evolucion")) {
    return [[
      { mes: "2026-07", reservas: 5, usuarios: 8, coseguro: 4, traslados: 2, noticias: 3 },
      { mes: "2026-08", reservas: 7, usuarios: 3, coseguro: 6, traslados: 1, noticias: 2 },
    ]];
  }
  throw new Error(`Consulta de prueba inesperada: ${sql}`);
}

const fakeConnection = {
  promise() {
    return {
      query: async (sql, params = []) => {
        databaseCalls.push({ sql, params });
        return resultadoPara(sql);
      },
    };
  },
};

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: fakeConnection,
};

const dashboardRouter = require("../api/routes/dashboard");
const { crearServicioDashboard, __test: dashboardTest } = require("../api/services/dashboard");
const app = express();
app.use("/api", dashboardRouter);

function tokenFor(overrides = {}) {
  return jwt.sign({
    data: JSON.stringify({ id: 10, rol: "admin", ...overrides }),
  }, process.env.JWT_SECRET);
}

async function request(path, token) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("dashboard administrativo rechaza solicitudes sin token antes de consultar", async () => {
  databaseCalls.length = 0;
  const response = await request("/api/admin/dashboard");

  assert.equal(response.status, 401);
  assert.equal(databaseCalls.length, 0);
});

test("dashboard administrativo rechaza roles no admin antes de consultar", async () => {
  databaseCalls.length = 0;
  const response = await request("/api/admin/dashboard", tokenFor({ rol: "departamental" }));

  assert.equal(response.status, 401);
  assert.equal(databaseCalls.length, 0);
});

test("dashboard entrega agregados estables, sin datos personales y en siete consultas", async () => {
  databaseCalls.length = 0;
  const response = await request("/api/admin/dashboard", tokenFor());

  assert.equal(response.status, 200);
  assert.match(response.body.generado_en, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(response.body.resumen_red.usuarios.total, 120);
  assert.equal(response.body.modulos.turismo.por_aprobar, 3);
  assert.equal(response.body.modulos.turismo.proximas_30_dias, 5);
  assert.equal(response.body.modulos.coseguro.por_revisar, 3);
  assert.equal(response.body.modulos.coseguro.pendientes_central, 4);
  assert.equal(response.body.modulos.coseguro.importe_pendiente_acreditacion, 1450.5);
  assert.equal(response.body.modulos.traslados.activos, 6);
  assert.equal(response.body.modulos.noticias.publicadas, 7);
  assert.equal(response.body.modulos.noticias.programadas, 1);
  assert.equal(response.body.modulos.olimpiadas.inscripciones_activas, 46);
  assert.equal(response.body.atencion.total, 19);
  assert.equal(response.body.evolucion.length, 6);
  assert.equal(databaseCalls.length, 7);

  const evolucion = databaseCalls.find((call) => call.sql.includes("dashboard:evolucion"));
  assert.equal(evolucion.params.length, 5);
  assert.ok(evolucion.params.every((value) => /^\d{4}-\d{2}-01$/.test(value)));

  const serializado = JSON.stringify(response.body);
  for (const campoPrivado of ["documento", "email", "telefono", "cuil", "cbu", "nombre_usuario"]) {
    assert.equal(serializado.includes(campoPrivado), false);
  }
});

test("la evolución siempre completa seis meses en orden y rellena meses sin actividad", () => {
  const meses = dashboardTest.obtenerVentanaMeses(new Date("2026-01-15T12:00:00.000Z"));
  assert.deepEqual(meses, ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"]);

  const evolucion = dashboardTest.completarEvolucion([
    { mes: "2025-10", reservas: "2", usuarios: 1, coseguro: null, traslados: 0, noticias: 0 },
  ], meses);
  assert.equal(evolucion.length, 6);
  assert.deepEqual(evolucion[0], {
    mes: "2025-08", reservas: 0, usuarios: 0, coseguro: 0, traslados: 0, noticias: 0,
  });
  assert.equal(evolucion[2].reservas, 2);
});

test("el servicio comparte cargas concurrentes y reutiliza el agregado reciente", async () => {
  databaseCalls.length = 0;
  const servicio = crearServicioDashboard({
    conexion: fakeConnection,
    ahora: () => new Date("2026-08-13T12:00:00.000Z"),
    cacheMs: 30000,
  });

  const [primero, segundo] = await Promise.all([servicio.obtener(), servicio.obtener()]);
  const tercero = await servicio.obtener();

  assert.strictEqual(primero, segundo);
  assert.strictEqual(primero, tercero);
  assert.equal(databaseCalls.length, 7);
});
