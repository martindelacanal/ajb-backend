"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { rutaPermitidaEducacion } = require("../api/security/autorizacion-sesion");
const { esRubroEducativo } = require("../api/services/beneficios-educacion");

process.env.JWT_SECRET = "educacion-tests-no-production";
let rubroNombre = "Capacitación";
let rubroDestino = null;
const consultas = [];
const db = {
  async query(sql, params = []) {
    consultas.push({ sql, params });
    if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u/.test(sql)) return [[{ id: 80, rol_id: 8, rol: "educacion", habilitado: "Y" }]];
    if (/FROM beneficio_rubro WHERE id =/.test(sql) && !/FROM beneficio b/.test(sql)) return [[{ id: params[0], nombre: rubroDestino || rubroNombre }]];
    if (/SELECT id, nombre FROM beneficio_rubro WHERE habilitado/.test(sql)) return [[{ id: 1, nombre: "Capacitación" }, { id: 2, nombre: "Convenios educativos" }, { id: 3, nombre: "Seguros" }]];
    if (/SELECT b\.\*/.test(sql)) return [[{ id: 10, rubro_nombre: rubroNombre, rubro_id: 1, habilitado: 1, estado_id: 3, nombre: "Propuesta", alcance_todas: 1 }]];
    if (/SELECT bi\.id, bi\.beneficio_id/.test(sql)) return [[{ id: 1, beneficio_id: 10, rubro_nombre: rubroNombre, aviso_entidad_estado: "ERROR" }]];
    if (/SELECT COUNT\(\*\) AS total/.test(sql)) return [[{ total: 0 }]];
    if (/^INSERT|^UPDATE/.test(sql.trim())) return [{ insertId: 11, affectedRows: 1 }];
    return [[]];
  },
  async getConnection() { return this; },
  async beginTransaction() {}, async rollback() {}, async commit() {}, release() {},
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => db } };
const router = require("../api/routes/beneficios");
const app = express();
app.use(express.json());
app.use("/api", router);
app.get("/api/usuarios", router.__test.verifyToken, (_req, res) => res.json({ acceso: true }));
app.use("/api", require("../api/routes/publico"));

async function request(path, method = "GET", body) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    // Aunque el token intente elevar el rol, prevalece Educación en la BD.
    const token = jwt.sign({ data: JSON.stringify({ id: 80, rol: "admin" }) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
function escrituras() { return consultas.filter(c => /^\s*(?:INSERT|UPDATE|DELETE)/i.test(c.sql)); }

test("el ámbito educativo exige un rubro exacto y no una coincidencia parcial", () => {
  for (const nombre of ["Capacitación", "CAPACITACION", "Convenios educativos"]) assert.ok(esRubroEducativo(nombre));
  for (const nombre of ["Seguros", "Seguros para educación", "Cursos comerciales", "", null]) assert.equal(esRubroEducativo(nombre), false);
  const rol = { rol: "educacion" };
  for (const permiso of ["puedeVerBeneficio", "puedeEditarBeneficio", "puedeEliminarBeneficio", "puedeVerDatosInternos", "puedeObservarBeneficio"]) {
    assert.ok(router.__test[permiso](rol, { rubro_nombre: "Capacitación" }));
    assert.equal(router.__test[permiso](rol, { rubro_nombre: "Seguros", alcance_todas: 1 }), false);
  }
});

test("el rol no entra a módulos ajenos aun con claims admin", async () => {
  consultas.length = 0;
  assert.equal((await request("/usuarios")).status, 403);
  assert.equal(consultas.length, 1, "sólo se consultan los permisos actuales");
  assert.equal(rutaPermitidaEducacion({ path: "/USUARIOS/", method: "GET" }), false);
  assert.equal(rutaPermitidaEducacion({ path: "/beneficios-malicioso", method: "GET" }), false);
  assert.equal(rutaPermitidaEducacion({ path: "/Beneficios/10/", method: "GET" }), true);
});

test("catálogos y ambos listados se limitan a los rubros educativos", async () => {
  assert.deepEqual((await request("/beneficios/catalogos")).body.rubros.map(r => r.nombre), ["Capacitación", "Convenios educativos"]);
  for (const path of ["/beneficios", "/beneficios/inscripciones"]) {
    consultas.length = 0;
    assert.equal((await request(path)).status, 200);
    const listados = consultas.filter(c => /FROM beneficio b|JOIN beneficio b/.test(c.sql));
    assert.ok(listados.length >= 2);
    for (const { sql } of listados) assert.match(sql, /b\.rubro_id IN \(SELECT er\.id FROM beneficio_rubro er/);
  }
});

test("no puede crear rubros ni mover beneficios a rubros no educativos", async () => {
  rubroNombre = "Seguros";
  consultas.length = 0;
  assert.equal((await request("/beneficios/rubros", "POST", { nombre: "Curso comercial" })).status, 403);
  assert.equal((await request("/beneficios", "POST", { nombre: "Prueba", rubro_id: 3, alcance_todas: 1 })).status, 403);
  rubroNombre = "Capacitación";
  rubroDestino = "Seguros";
  assert.equal((await request("/beneficios/10", "PUT", { nombre: "Prueba", rubro_id: 3, alcance_todas: 1 })).status, 403);
  rubroDestino = null;
  assert.equal(escrituras().length, 0);
});

test("identificadores ajenos no permiten leer, editar, aprobar, borrar o reenviar avisos", async () => {
  rubroNombre = "Seguros";
  const solicitudes = [
    ["/beneficios/10", "GET"], ["/beneficios/10", "PUT", { rubro_id: 1 }],
    ["/beneficios/10/estado", "PUT", { estado_id: 2 }], ["/beneficios/10", "DELETE"],
    ["/beneficios/10/habilitado", "PUT", { habilitado: 0 }],
    ["/beneficios/10/observaciones", "POST", { mensaje: "No autorizado" }],
    ["/beneficios/10/convenio/descargar", "GET"],
    ["/beneficios/inscripciones/1/reenviar-aviso", "PUT"],
    ["/beneficios/inscripciones/1/resolver-aviso", "PUT", { observacion: "No autorizado" }],
  ];
  consultas.length = 0;
  for (const args of solicitudes) assert.ok([401, 403, 404].includes((await request(...args)).status), args[0]);
  assert.equal(escrituras().length, 0);
});

test("puede publicar y retirar un beneficio educativo dentro de su ámbito", async () => {
  rubroNombre = "Convenios educativos";
  consultas.length = 0;
  assert.equal((await request("/beneficios/10/habilitado", "PUT", { habilitado: 0 })).status, 200);
  assert.ok(escrituras().some(c => /UPDATE beneficio SET habilitado/.test(c.sql)));
  assert.ok(escrituras().some(c => /INSERT INTO beneficio_historial/.test(c.sql)));
});

test("la página pública filtra educación antes del límite y valida la categoría", async () => {
  consultas.length = 0;
  assert.equal((await request("/publico/beneficios?categoria=educacion")).status, 200);
  const consulta = consultas.find(c => /LIMIT/.test(c.sql));
  assert.match(consulta.sql, /b\.rubro_id IN \(SELECT er\.id FROM beneficio_rubro er[\s\S]+LIMIT/);
  assert.equal((await request("/publico/beneficios?categoria=otro")).status, 400);
});
