"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { construirCatalogoServicioSql, servicioVisibleParaActor, normalizarIdPositivo } = require("../api/services/turismo-catalogo");
const valores = require("../api/services/valores-dominio");

test("Turismo excluye servicios departamentales y el portal conserva el alcance del afiliado", () => {
  const actor = { rol: "afiliado", departamental_id: 7 };
  const turismo = construirCatalogoServicioSql(actor);
  assert.match(turismo.sql, /s\.propietario_departamental_id IS NULL/);
  const propia = construirCatalogoServicioSql(actor, { departamental: true, origen: "propia" });
  assert.match(propia.sql, /s\.propietario_departamental_id IS NOT NULL/);
  assert.match(propia.sql, /s\.propietario_departamental_id = \?$/);
  assert.deepEqual(propia.params, [7, 7, 7]);
  const otras = construirCatalogoServicioSql(actor, { departamental: true, origen: "otras" });
  assert.match(otras.sql, /alcance_departamental = 'TODAS'/);
  assert.match(otras.sql, /alcance_departamental = 'SELECCIONADAS' AND EXISTS/);
  assert.match(otras.sql, /s\.propietario_departamental_id <> \?$/);
  assert.deepEqual(otras.params, [7, 7, 7]);
  const sinSede = construirCatalogoServicioSql({ rol: "afiliado" }, { departamental: true, origen: "propia" });
  assert.match(sinSede.sql, /1 = 0$/);
});

test("una URL de reserva directa no evita el control departamental del servidor", async () => {
  const db = { query: async (sql, params) => {
    assert.match(sql, /s\.estado_aprobacion = 'APROBADO'/);
    assert.match(sql, /servicio_departamental_visible/);
    assert.deepEqual(params, [22, 8, 7, 7]);
    return [[]];
  } };
  assert.equal(await servicioVisibleParaActor(db, { rol: "afiliado", departamental_id: 7 }, 8, { recursoId: 22 }), null);
});

// Ejecuta la función de cotización que usa el alta real, con sus operaciones
// monetarias reales; sólo se reemplaza el adaptador de base de datos.
const source = fs.readFileSync(path.join(__dirname, "../api/routes/user.js"), "utf8");
const inicio = source.indexOf("async function calcularTarifaPrecioUnico(");
const fin = source.indexOf("async function calcularTarifaTemporadasGestionadas(", inicio);
assert.ok(inicio >= 0 && fin > inicio);
const cotizar = vm.runInNewContext(`(${source.slice(inicio, fin).trim()})`, {
  ...valores, normalizarIdPositivo,
  formatearFechaSQL: valor => String(valor).slice(0, 10),
  crearErrorNegocio: (mensaje, statusCode, codigo) => Object.assign(new Error(mensaje), { statusCode, codigo }),
});

function dbConReglas(departamentalId, reglas) {
  return { query: async (sql, params) => {
    if (sql.includes("FROM usuario")) return [[{ departamental_id: departamentalId }]];
    assert.match(sql, /audiencia_departamental IN \('TODAS', \?\)/);
    const audiencia = params[3];
    return [reglas.filter(regla => ["TODAS", audiencia].includes(regla.audiencia_departamental))];
  } };
}
const base = { recurso: { id: 22, servicio_id: 8, propietario_departamental_id: 7, unidad_cobro: "POR_RECURSO_DIA" }, personas: [{ usuario_id: 15 }], noches: ["2027-01-03"], fechaInicio: "2027-01-03", fechaFin: "2027-01-04" };
const regla = (id, audiencia_departamental, precio) => ({ id, tarifa_id: id + 100, audiencia_departamental, precio, porcentaje_descuento: 0, fecha_inicio: "2027-01-01", fecha_fin: "2027-12-31" });

test("la dueña puede cobrar lo mismo a otras sedes con la tarifa TODAS", async () => {
  const reglas = [regla(1, "TODAS", "5000.00")];
  assert.equal((await cotizar(dbConReglas(7, reglas), base)).total, 5000);
  assert.equal((await cotizar(dbConReglas(12, reglas), base)).total, 5000);
});

test("el servidor aplica la tarifa externa y prioriza OTRAS sobre TODAS", async () => {
  const reglas = [regla(1, "TODAS", "5000.00"), regla(2, "OTRAS", "7000.00")];
  assert.equal((await cotizar(dbConReglas(7, reglas), base)).total, 5000);
  const externa = await cotizar(dbConReglas(12, reglas), base);
  assert.equal(externa.total, 7000);
  assert.equal(externa.personas[0].tarifas_por_fecha[0].tarifa_regla_id, 2);
});

test("no cotiza un servicio para otras sedes si sólo tiene tarifa PROPIA", async () => {
  assert.equal(await cotizar(dbConReglas(12, [regla(1, "PROPIA", "5000.00")]), base), null);
});
