"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "temporadas-edades-test";

const consultas = [];
let rangosGuardados = [];
let reglaGuardada;
let commits = 0;

async function query(sql, params = []) {
  consultas.push(sql);
  if (/FROM usuario u[\s\S]+INNER JOIN rol r/.test(sql)) {
    return [[{ id: 1, rol: "admin", rol_id: 1, habilitado: "S", area_turismo: 1, modulo_turismo: 1 }]];
  }
  if (/SELECT id FROM recurso WHERE id IN/.test(sql)) return [[{ id: 1 }]];
  if (/SELECT id, temporada_tarifa_id FROM bloque_fecha WHERE/.test(sql)) return [[{ id: 1, temporada_tarifa_id: 1 }]];
  if (/SELECT id FROM reserva\s+WHERE bloque_fecha_id/.test(sql)) return [[]];
  if (/FROM bloque_fecha_recurso bfr/.test(sql) || /FROM tarifa t/.test(sql)) return [[]];
  if (/^SELECT id FROM flujo_descuento_escalonado WHERE/.test(sql)) return [[{ id: 1 }]];
  if (/INSERT INTO flujo_descuento_escalonado_regla/.test(sql)) {
    reglaGuardada = {
      id: 10, flujo_id: params[0], servicio_id: params[1], recurso_id: params[2], tipo_persona_id: params[3],
      salto_porcentaje: params[4], modo_salto: params[5], sentido_calculo: params[6],
      rango_base_orden: params[7], usar_tope: params[8], rango_tope_orden: params[9],
    };
    return [{ insertId: 10 }];
  }
  if (/INSERT INTO flujo_descuento_escalonado_rango_edad/.test(sql)) {
    rangosGuardados.push({ id: rangosGuardados.length + 1, regla_id: params[0], orden: params[1], edad_minima: params[2], edad_maxima: params[3] });
    return [{ insertId: rangosGuardados.length }];
  }
  if (/^\s*SELECT id, tipo_temporada, created_at, updated_at/.test(sql)) return [[{ id: 1, tipo_temporada: "ALTA" }]];
  if (/FROM flujo_descuento_escalonado_regla\s+WHERE/.test(sql)) return [[reglaGuardada]];
  if (/FROM flujo_descuento_escalonado_rango_edad\s+WHERE/.test(sql)) return [rangosGuardados];
  if (/FROM flujo_descuento_escalonado_tipo_persona_porcentaje\s+WHERE/.test(sql)) return [[]];
  if (/^\s*(DELETE|UPDATE)\b/.test(sql)) return [{ affectedRows: 1 }];
  throw new Error(`Consulta inesperada: ${sql}`);
}

const connection = {
  query,
  async beginTransaction() {},
  async commit() { commits += 1; },
  async rollback() {},
  release() {},
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true,
  exports: { promise: () => ({ query, getConnection: async () => connection }) },
};
const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/user"));

async function request(path, method, body) {
  consultas.length = 0;
  rangosGuardados = [];
  commits = 0;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt.sign({ data: JSON.stringify({ id: 1, rol: "admin" }) }, process.env.JWT_SECRET)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function configuracion(tipoPersonaId, edades) {
  return [{ id: 1, regimenes: [{ id: 1, recursos: [{
    id: 1, precio_por_persona: true,
    fechas: [{ fecha_inicio: "2040-01-01", fecha_fin: "2040-01-07", tiposPersona: [{
      tipoPersonaId, rangosEdad: edades.map(([edadMinima, edadMaxima]) => ({ edadMinima, edadMaxima, precio: 100 })),
    }] }],
  }] }] }];
}

function predeterminados(tipoPersonaId, edades) {
  return { reglas: [{
    servicio_id: 0, recurso_id: 0, tipo_persona_id: tipoPersonaId,
    salto_porcentaje: 10, modo_salto: "POR_RANGO", sentido_calculo: "DESCENDENTE",
    rango_base_orden: 0, usar_tope: false, rango_tope_orden: null,
    rangos_edad: edades.map(([edad_minima, edad_maxima], orden) => ({ orden, edad_minima, edad_maxima })),
  }] };
}

function assertSinEscrituras() {
  assert.equal(consultas.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)).length, 0);
  assert.equal(commits, 0);
}

for (const [tipo, edades, esperado] of [
  [5, [[0, 2]], /0 a 1/],
  [5, [[0, 1], [2, 17]], /único rango/],
  [4, [[2, 4], [5, null]], /Separá/],
]) {
  test(`alta y baja rechazan edades inválidas antes de guardar: ${JSON.stringify(edades)}`, async () => {
    const servicios = configuracion(tipo, edades);
    const temporada = { nombre_campania: "Prueba", fecha_inicio: "2040-01-01", fecha_fin: "2040-01-07", configuracion_servicios: servicios };
    for (const [ruta, metodo] of [["/temporada", "POST"], ["/temporada/1", "PUT"]]) {
      const response = await request(ruta, metodo, temporada);
      assert.equal(response.status, 400);
      assert.match(response.body, esperado);
      assertSinEscrituras();
    }
    for (const [ruta, metodo] of [["/admin/bloques", "POST"], ["/admin/bloques/1", "PUT"]]) {
      const response = await request(ruta, metodo, {
        nombre: "Bloque prueba", servicio_id: 1, modalidad: "BLOQUE", recursos: [1],
        fecha_inicio: temporada.fecha_inicio, fecha_fin: temporada.fecha_fin,
        tarifas: temporada,
      });
      assert.equal(response.status, 400);
      assert.match(response.body.message, esperado);
      assertSinEscrituras();
    }
  });
}

test("los predeterminados de alta, baja y endpoints anteriores protegen los mismos límites", async () => {
  for (const [ruta, metodo] of [
    ["/valores-predeterminados-temporada/ALTA", "PUT"],
    ["/valores-predeterminados-temporada/BAJA", "PUT"],
    ["/flujo-descuento-escalonado", "POST"],
    ["/flujo-descuento-escalonado/1", "PUT"],
  ]) {
    for (const [tipo, edades, esperado] of [[0, [[2, 4], [5, null]], /Separá/], [5, [[0, 2]], /0 a 1/]]) {
      const response = await request(ruta, metodo, predeterminados(tipo, edades));
      assert.equal(response.status, 400);
      assert.match(response.body, esperado);
      assertSinEscrituras();
    }
  }
});

test("los predeterminados guardan 17 y 18 como edades inclusivas y admiten bebés 0-1", async () => {
  for (const [tipo, edades] of [[0, [[2, 16], [17, 17], [18, null]]], [5, [[0, 1]]]]) {
    const response = await request("/valores-predeterminados-temporada/ALTA", "PUT", predeterminados(tipo, edades));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(rangosGuardados.map((rango) => [rango.edad_minima, rango.edad_maxima]), edades);
    assert.equal(commits, 1);
  }
});
