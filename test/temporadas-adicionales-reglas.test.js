"use strict";

// Precios de adicionales por reglas en los editores de temporadas (baja y bloques de alta):
// POST/PUT /temporada aceptan adicionales_reglas (los adicionales por tramo se ignoran) y las
// materializan con el motor (services/adicionales-precios.js) después de insertar las tarifas,
// en la misma transacción; GET /temporada/:id las devuelve; los errores del motor (400/409)
// llegan al editor con su mensaje. Los adicionales de VENTA no se ofrecen por día.
// Sin base: la conexión es un doble que responde por patrón de SQL.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "temporadas-adicionales-reglas-test";

let escenario;
const consultas = [];
let commits = 0;
let rollbacks = 0;
let insertados = 0;

function escenarioBase() {
  return {
    usada: false,
    modalidad: "ALQUILER",
    // Tarifas vigentes de la temporada 1 antes del guardado (se dan de baja).
    vigentes: [{ id: 101, recurso_id: 5, regimen_id: 2, servicio_id: 10 }],
    // Días con tarifa de cada recurso y régimen (lo que lee el motor después de insertar).
    destinos: [
      { servicio_id: 10, recurso_id: 5, regimen_id: 2, desde: "2040-01-01", hasta: "2040-01-31" },
      { servicio_id: 10, recurso_id: 6, regimen_id: 2, desde: "2040-01-01", hasta: "2040-01-31" },
    ],
    origen: "GENERAL",
    // tarifa_adicional de otras temporadas generales o de catálogos de predio.
    otras: [],
    // tarifa_adicional de la temporada antes del upsert (con o sin baja).
    anteriores: [],
    // tarifa_adicional vigente después del guardado.
    vigentesDespues: [],
    // GET: reglas guardadas y filas sueltas (cargadas por tramo).
    reglasGuardadas: [],
    sueltas: [],
    // GET /adicionales sin la columna modalidad (antes de la migración).
    sinModalidad: false,
  };
}

async function query(sql, params = []) {
  consultas.push({ sql, params });
  if (/FROM usuario u[\s\S]+INNER JOIN rol r/.test(sql)) {
    return [[{ id: 1, rol: "admin", rol_id: 1, habilitado: "S", area_turismo: 1, modulo_turismo: 1 }]];
  }
  if (/FROM adicional a WHERE 1 = 1/.test(sql)) {
    if (escenario.sinModalidad && /modalidad/.test(sql)) {
      throw Object.assign(new Error("Unknown column 'a.modalidad' in 'where clause'"), { code: "ER_BAD_FIELD_ERROR" });
    }
    return [[{ id: 9, nombre: "Mascota" }]];
  }
  if (/SELECT s\.id, ts\.codigo AS tipo_codigo/.test(sql)) return [[{ id: 10, tipo_codigo: "ALOJAMIENTO_RECURSO" }]];
  if (/SELECT id, servicio_id FROM recurso WHERE id IN/.test(sql)) return [[{ id: 5, servicio_id: 10 }, { id: 6, servicio_id: 10 }]];
  if (/FROM servicio_regimen/.test(sql)) return [[{ servicio_id: 10, regimen_id: 2 }]];
  if (/SELECT id, nombre, modalidad FROM adicional WHERE id IN/.test(sql)) {
    return [[{ id: 9, nombre: "Mascota", modalidad: escenario.modalidad }]];
  }
  if (/SELECT id FROM adicional WHERE id IN/.test(sql)) return [[{ id: 9 }]];
  if (/SELECT id, nombre FROM adicional WHERE id IN/.test(sql)) return [[{ id: 9, nombre: "Mascota" }]];
  if (/SELECT id, nombre FROM recurso WHERE id IN/.test(sql)) return [[{ id: 5, nombre: "Habitación 5" }, { id: 6, nombre: "Habitación 6" }]];
  if (/SELECT id, nombre FROM regimen/.test(sql)) return [[{ id: 2, nombre: "Pensión completa" }]];
  if (/SELECT nombre, fecha_inicio, fecha_fin FROM temporada_tarifa WHERE id = \? FOR UPDATE/.test(sql)) {
    return [[{ nombre: "Verano", fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31" }]];
  }
  if (/SELECT id, nombre, fecha_inicio, fecha_fin FROM temporada_tarifa WHERE id = \?/.test(sql)) {
    return [[{ id: 1, nombre: "Verano", fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31" }]];
  }
  if (/SELECT origen FROM temporada_tarifa WHERE id = \?/.test(sql)) return [[{ origen: escenario.origen }]];
  if (/AS usada/.test(sql)) return [[{ usada: escenario.usada ? 1 : 0 }]];
  if (/FOR UPDATE OF t/.test(sql)) return [escenario.vigentes];
  if (/^\s*UPDATE tarifa\s+SET eliminado = 1/.test(sql)) return [{ affectedRows: escenario.vigentes.length }];
  if (/^\s*UPDATE tarifa_adicional\s+SET activo = 0/.test(sql)) return [{ affectedRows: 2 }];
  if (/FROM tarifa t\s+INNER JOIN temporada_tarifa tt/.test(sql)) return [[]]; // sin solapamientos de tarifas
  // Motor: destinos de la temporada (con FOR SHARE al guardar).
  if (/FROM tarifa t JOIN recurso r ON r\.id = t\.recurso_id/.test(sql)) return [escenario.destinos];
  // Motor: precios del mismo adicional en otras temporadas generales o catálogos de predio.
  if (/LEFT JOIN adicional_precio ap2/.test(sql)) return [escenario.otras];
  // GET /temporada/:id: tarifas de la temporada.
  if (/FROM tarifa t\s+JOIN recurso r ON t\.recurso_id = r\.id/.test(sql)) {
    return [[5, 6].map((recursoId) => ({
      tarifa_id: 100 + recursoId, recurso_id: recursoId, tipo_persona_id: null, regimen_id: 2, edad_minima: null, edad_maxima: null,
      precio: "1000.00", fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio_por_persona: "N",
      usa_porcentaje: 0, porcentaje_descuento: null, parcelas_disponibles: null, recurso_nombre: `Habitación ${recursoId}`,
      servicio_id: 10, servicio_nombre: "Hotel Solís", tipo_codigo: "ALOJAMIENTO_RECURSO", regimen_nombre: "Pensión completa",
    }))];
  }
  if (/FROM adicional_precio ap WHERE ap\.temporada_tarifa_id = \?/.test(sql)) return [escenario.reglasGuardadas];
  if (/FROM tarifa_adicional ta WHERE ta\.temporada_tarifa_id = \? AND ta\.activo = 1 AND ta\.adicional_precio_id IS NULL/.test(sql)) {
    return [escenario.sueltas];
  }
  if (/SELECT id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio\s+FROM tarifa_adicional\s+WHERE temporada_tarifa_id = \? AND activo = 1/.test(sql)) {
    return [escenario.vigentesDespues];
  }
  if (/SELECT id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio\s+FROM tarifa_adicional/.test(sql)) {
    return [escenario.anteriores];
  }
  if (/FROM tarifa_adicional\s+WHERE temporada_tarifa_id = \? AND activo = 1/.test(sql)) return [[]];
  if (/FROM temporada_tipo_persona_porcentaje\s+WHERE temporada_tarifa_id = \?/.test(sql)) return [[]];
  if (/SELECT tipo_persona_id, porcentaje FROM temporada_tipo_persona_porcentaje/.test(sql)) return [[]];
  if (/SELECT id, temporada_tarifa_id FROM bloque_fecha WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: 1, temporada_tarifa_id: 7 }]];
  if (/SELECT id FROM reserva\s+WHERE bloque_fecha_id/.test(sql)) return [[]];
  if (/SELECT id FROM recurso WHERE id IN \([^)]*\) AND servicio_id = \? FOR UPDATE/.test(sql)) return [[{ id: 5 }, { id: 6 }]];
  if (/FROM bloque_fecha_recurso bfr/.test(sql)) return [[]];
  if (/FROM reserva r JOIN estado_reserva er/.test(sql)) return [[]];
  if (/INSERT INTO temporada_tarifa/.test(sql)) return [{ insertId: 8 }];
  if (/INSERT INTO adicional_precio/.test(sql)) return [{ insertId: 900 + (++insertados) }];
  if (/INSERT INTO tarifa\s/.test(sql)) return [{ insertId: 500 + consultas.length }];
  if (/^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
  throw new Error(`Consulta inesperada: ${sql}`);
}

const connection = {
  query,
  async beginTransaction() {},
  async commit() { commits += 1; },
  async rollback() { rollbacks += 1; },
  release() {},
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true,
  exports: { promise: () => ({ query, getConnection: async () => connection }) },
};
const rutasUsuario = require("../api/routes/user");
const T = rutasUsuario.__test;
const app = express();
app.use(express.json());
app.use("/api", rutasUsuario);

async function request(ruta, method, body) {
  consultas.length = 0;
  commits = 0;
  rollbacks = 0;
  insertados = 0;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${ruta}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt.sign({ data: JSON.stringify({ id: 1, rol: "admin" }) }, process.env.JWT_SECRET)}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const buscar = (patron) => consultas.filter(({ sql }) => patron.test(sql));
const indiceDe = (patron) => consultas.findIndex(({ sql }) => patron.test(sql));
const historial = () => buscar(/INSERT INTO historial_temporada/).map(({ params }) => ({
  temporada: params[0], operacion: params[2], campo: params[3],
  anterior: params[4] ? JSON.parse(params[4]) : null, nuevo: params[5] ? JSON.parse(params[5]) : null,
}));
/** Filas que el motor escribió en tarifa_adicional: [temporada, recurso, régimen, adicional, desde, hasta, precio, regla]. */
const filasMaterializadas = () => buscar(/INSERT INTO tarifa_adicional[\s\S]+adicional_precio_id/).map(({ params }) => params);

// Hotel Solís (servicio 10) › Pensión completa (2) › Habitaciones 5 y 6, todo enero de 2040.
// Cada rango trae un adicional por tramo: con reglas, no cuenta.
function configuracion() {
  const recurso = (id) => ({
    id, precio_por_persona: false,
    fechas: [{ fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 1000, adicionales: [{ adicionalId: 9, precio: 50 }] }],
  });
  return [{ id: 10, regimenes: [{ id: 2, recursos: [recurso(5), recurso(6)] }] }];
}

// Mascota: $60 por día en todos los servicios; la Habitación 6, del 10 al 20, $80.
const REGLAS = [
  { adicional_id: 9, servicio_id: null, recurso_id: null, regimen_id: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 60 },
  { adicional_id: 9, servicio_id: 10, recurso_id: 6, regimen_id: null, fecha_desde: "2040-01-10", fecha_hasta: "2040-01-20", precio: 80 },
];

function temporada(extra = {}) {
  return {
    nombre_campania: "Verano",
    fecha_inicio: "2040-01-01",
    fecha_fin: "2040-01-31",
    configuracion_servicios: configuracion(),
    ...extra,
  };
}

test.beforeEach(() => {
  escenario = escenarioBase();
});

// --- Helpers puros ------------------------------------------------------------

test("leerReglasAdicionalesPayload distingue «no vino» (cliente viejo) de una lista vacía", () => {
  assert.equal(T.leerReglasAdicionalesPayload({}), null);
  assert.equal(T.leerReglasAdicionalesPayload({ adicionales_reglas: null }), null);
  assert.equal(T.leerReglasAdicionalesPayload(null), null);
  assert.deepEqual(T.leerReglasAdicionalesPayload({ adicionales_reglas: [] }), []);
  assert.deepEqual(T.leerReglasAdicionalesPayload({ adicionales_reglas: REGLAS }), REGLAS);
  assert.throws(() => T.leerReglasAdicionalesPayload({ adicionales_reglas: { adicional_id: 9 } }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.codigo, "ADICIONALES_REGLAS_INVALIDAS");
    return true;
  });
});

test("quitarAdicionalesPorTramo vacía los adicionales de cada rango y deja el resto", () => {
  const config = configuracion();
  T.quitarAdicionalesPorTramo(config);
  for (const recurso of config[0].regimenes[0].recursos) {
    assert.deepEqual(recurso.fechas[0].adicionales, []);
    assert.equal(recurso.fechas[0].precio, 1000);
  }
  assert.doesNotThrow(() => T.quitarAdicionalesPorTramo([{ regimenes: null }, null]));
});

test("errorNegocioPreciosAdicionales: un 409 del motor pasa con su mensaje y sus choques; un error común, no", () => {
  const delMotor = Object.assign(new Error("Hay dos precios distintos para el mismo día"), { name: "ErrorPredio", status: 409, conflictos: [{ recurso_id: 5 }] });
  const negocio = T.errorNegocioPreciosAdicionales(delMotor);
  assert.equal(negocio.statusCode, 409);
  assert.equal(negocio.codigo, "ADICIONALES_PRECIOS_CONFLICTO");
  assert.equal(negocio.message, "Hay dos precios distintos para el mismo día");
  assert.deepEqual(negocio.conflictos, [{ recurso_id: 5 }]);
  assert.deepEqual(T.cuerpoErrorNegocio(negocio), {
    message: "Hay dos precios distintos para el mismo día", codigo: "ADICIONALES_PRECIOS_CONFLICTO", conflictos: [{ recurso_id: 5 }],
  });
  const invalido = T.errorNegocioPreciosAdicionales(Object.assign(new Error("Revisá"), { status: 400 }));
  assert.equal(invalido.statusCode, 400);
  assert.equal(invalido.codigo, "ADICIONALES_PRECIOS_INVALIDOS");
  const comun = new Error("ECONNRESET");
  assert.equal(T.errorNegocioPreciosAdicionales(comun), comun);
});

test("resumenHistorialReglasAdicionales guarda cantidades y hasta 250 reglas, sin campos internos", () => {
  const reglas = Array.from({ length: 260 }, (_, i) => ({ clave: i, ...REGLAS[0], precio: i }));
  const resumen = T.resumenHistorialReglasAdicionales({ reglas, filas: 520 });
  assert.equal(resumen.reglas, 260);
  assert.equal(resumen.filas, 520);
  assert.equal(resumen.detalle.length, 250);
  assert.equal(resumen.reglas_omitidas, 10);
  assert.deepEqual(Object.keys(resumen.detalle[0]), ["adicional_id", "servicio_id", "recurso_id", "regimen_id", "fecha_inicio", "fecha_fin", "precio"]);
  assert.ok(JSON.stringify(resumen).length < 64 * 1024, "entra en el TEXT del historial");
});

test("adicionalesConPrecioPisado sólo informa las claves que volvieron con otro precio", () => {
  const anteriores = new Map([
    ["5|2|9|2040-01-01|2040-01-31", { id: 41, recurso_id: 5, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: "50.00" }],
    ["6|2|9|2040-01-01|2040-01-31", { id: 42, recurso_id: 6, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: "60.00" }],
  ]);
  const filas = [
    { recurso_id: 5, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: "60.00" },
    { recurso_id: 6, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: "60.00" },
    { recurso_id: 6, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-01-10", fecha_fin: "2040-01-20", precio: "80.00" },
  ];
  assert.deepEqual(T.adicionalesConPrecioPisado(anteriores, filas), [{
    id: 41, adicional_id: 9, recurso_id: 5, regimen_id: 2, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio_anterior: 50, precio_nuevo: 60,
  }]);
});

// --- PUT /temporada/:id --------------------------------------------------------

test("PUT /temporada/:id con adicionales_reglas ignora los de cada tramo y materializa las reglas después de las tarifas", async () => {
  escenario.anteriores = [
    { id: 41, recurso_id: 5, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 50 },
  ];
  escenario.vigentesDespues = [
    { id: 41, recurso_id: 5, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 60 },
  ];
  const response = await request("/temporada/1", "PUT", temporada({ adicionales_reglas: REGLAS }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(commits, 1);
  assert.equal(rollbacks, 0);

  // Lo de cada tramo no se escribe (ni se valida contra la tabla adicional).
  assert.equal(buscar(/INSERT INTO tarifa_adicional[\s\S]+VALUES \(\?, \?, \?, \?, \?, \?, \?, 1\)\s+ON DUPLICATE KEY UPDATE precio = VALUES\(precio\), activo = 1,\s+fecha_eliminacion/).length, 0);
  assert.equal(buscar(/SELECT id FROM adicional WHERE id IN/).length, 0);

  // Una sola baja de lo vigente (la del guardado, con lote); el motor no encuentra nada activo.
  assert.equal(buscar(/^\s*UPDATE tarifa_adicional\s+SET activo = 0/).length, 1);
  // El motor lee los destinos después de insertar las tarifas nuevas, y bloqueados.
  const destinos = indiceDe(/FROM tarifa t JOIN recurso r ON r\.id = t\.recurso_id/);
  assert.ok(destinos > indiceDe(/INSERT INTO tarifa\s/), "destinos con las tarifas nuevas");
  assert.match(consultas[destinos].sql, /FOR SHARE/);
  // Temporada general: verifica choques con otras temporadas y catálogos de predio.
  assert.equal(buscar(/LEFT JOIN adicional_precio ap2/).length, 1);

  // Dos reglas, cuatro filas: la Habitación 5 entera a $60; la 6 partida en 60 / 80 / 60.
  assert.equal(buscar(/INSERT INTO adicional_precio/).length, 2);
  const filas = filasMaterializadas().map(([temporadaId, recurso, regimen, adicional, desde, hasta, precio]) =>
    [String(temporadaId), recurso, regimen, adicional, desde, hasta, precio]);
  assert.deepEqual(filas, [
    ["1", 5, 2, 9, "2040-01-01", "2040-01-31", 60],
    ["1", 6, 2, 9, "2040-01-01", "2040-01-09", 60],
    ["1", 6, 2, 9, "2040-01-10", "2040-01-20", 80],
    ["1", 6, 2, 9, "2040-01-21", "2040-01-31", 60],
  ]);
  assert.deepEqual(filasMaterializadas().map((p) => p[7]), [901, 901, 902, 901], "cada fila enlazada a su regla");

  // Historial: el resumen de las reglas y el precio que el upsert pisó (50 → 60).
  const reglas = historial().find((fila) => fila.campo === "adicionales_reglas");
  assert.equal(reglas.operacion, "UPDATE");
  assert.equal(reglas.nuevo.reglas, 2);
  assert.equal(reglas.nuevo.filas, 4);
  assert.deepEqual(reglas.nuevo.detalle[1], {
    adicional_id: 9, servicio_id: 10, recurso_id: 6, regimen_id: null, fecha_inicio: "2040-01-10", fecha_fin: "2040-01-20", precio: 80,
  });
  const pisados = historial().find((fila) => fila.campo === "tarifa_adicional_precio");
  assert.deepEqual(pisados.anterior.adicionales, [{
    id: 41, adicional_id: 9, recurso_id: 5, regimen_id: 2, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio_anterior: 50, precio_nuevo: 60,
  }]);
  assert.equal(historial().filter((fila) => fila.campo === "tarifa_adicional" && fila.operacion === "CREATE").length, 0);
});

test("PUT /temporada/:id sin adicionales_reglas (cliente viejo) guarda por tramo y suelta las reglas anteriores", async () => {
  const response = await request("/temporada/1", "PUT", temporada());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(buscar(/INSERT INTO tarifa_adicional[\s\S]+ON DUPLICATE KEY UPDATE precio = VALUES\(precio\), activo = 1,\s+fecha_eliminacion/).length, 2);
  assert.equal(buscar(/INSERT INTO adicional_precio/).length, 0);
  assert.equal(buscar(/FROM tarifa t JOIN recurso r ON r\.id = t\.recurso_id/).length, 0, "no llama al motor");
  const [bajaReglas] = buscar(/UPDATE adicional_precio SET activo = 0/);
  assert.deepEqual(bajaReglas.params, ["1"]);
  const [sueltas] = buscar(/UPDATE tarifa_adicional SET adicional_precio_id = NULL/);
  assert.match(sueltas.sql, /WHERE temporada_tarifa_id = \? AND activo = 1/);
  assert.ok(indiceDe(/UPDATE tarifa_adicional SET adicional_precio_id = NULL/) > indiceDe(/INSERT INTO tarifa_adicional/));
});

test("PUT /temporada/:id: dos precios igual de particulares que se pisan vuelven 409 con el mensaje del motor", async () => {
  const reglas = [REGLAS[0], { ...REGLAS[0], fecha_inicio: "2040-01-15", precio: 70 }];
  const response = await request("/temporada/1", "PUT", temporada({ adicionales_reglas: reglas }));
  assert.equal(response.status, 409);
  assert.equal(response.body.codigo, "ADICIONALES_PRECIOS_CONFLICTO");
  assert.match(response.body.message, /^Hay dos precios distintos para el mismo día: en «Mascota» se pisan .+ \(del 15\/01\/2040 al 31\/01\/2040/);
  assert.ok(Array.isArray(response.body.conflictos) && response.body.conflictos.length > 0);
  assert.deepEqual(response.body.conflictos[0].reglas, [0, 1], "las reglas en el orden en que llegaron");
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
  assert.equal(buscar(/INSERT INTO adicional_precio/).length, 0);
});

test("PUT /temporada/:id: un precio que choca con el catálogo de un predio vuelve 409 legible", async () => {
  escenario.otras = [{
    adicional_id: 9, recurso_id: 5, regimen_id: 2, fecha_inicio: "2040-01-15", fecha_fin: "2040-02-15",
    temporada_tarifa_id: null, temporada: null, predio: "Camping Miramar",
  }];
  const response = await request("/temporada/1", "PUT", temporada({ adicionales_reglas: [REGLAS[0]] }));
  assert.equal(response.status, 409);
  assert.equal(
    response.body.message,
    "«Mascota» ya tiene precio en el catálogo del predio Camping Miramar entre el 15/01/2040 y el 31/01/2040 (Habitación 5). Elegí otras fechas o cambiá ese precio donde está cargado."
  );
  assert.equal(rollbacks, 1);
});

test("PUT /temporada/:id: un recurso que no está en la temporada o un adicional de VENTA vuelven 400", async () => {
  let response = await request("/temporada/1", "PUT", temporada({
    adicionales_reglas: [{ ...REGLAS[0], servicio_id: 10, recurso_id: 77 }],
  }));
  assert.equal(response.status, 400);
  assert.equal(response.body.message, "El recurso del precio 1 no está habilitado en este ámbito.");
  assert.equal(rollbacks, 1);

  escenario.modalidad = "VENTA";
  response = await request("/temporada/1", "PUT", temporada({ adicionales_reglas: [REGLAS[0]] }));
  assert.equal(response.status, 400);
  assert.match(response.body.message, /«Mascota» se vende por unidad en el predio/);
  assert.equal(buscar(/INSERT INTO adicional_precio/).length, 0);

  response = await request("/temporada/1", "PUT", temporada({ adicionales_reglas: "Mascota" }));
  assert.equal(response.status, 400);
  assert.equal(response.body.codigo, "ADICIONALES_REGLAS_INVALIDAS");
});

test("PUT /temporada/:id con adicionales_reglas vacía deja la temporada sin adicionales", async () => {
  const response = await request("/temporada/1", "PUT", temporada({ adicionales_reglas: [] }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(filasMaterializadas().length, 0);
  // El motor da de baja las reglas anteriores de la temporada.
  const [bajaReglas] = buscar(/UPDATE adicional_precio ap SET ap\.activo = 0/);
  assert.deepEqual(bajaReglas.params, [1]);
  assert.equal(historial().find((fila) => fila.campo === "adicionales_reglas").nuevo.reglas, 0);
});

// --- POST /temporada -----------------------------------------------------------

test("POST /temporada con adicionales_reglas las materializa en la temporada nueva", async () => {
  const response = await request("/temporada", "POST", temporada({ adicionales_reglas: REGLAS }));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(commits, 1);
  assert.equal(buscar(/INSERT INTO tarifa_adicional\s+\(temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio\)\s+VALUES/).length, 0);
  assert.deepEqual(filasMaterializadas().map((p) => [p[0], p[1], p[4], p[5], p[6]]), [
    [8, 5, "2040-01-01", "2040-01-31", 60],
    [8, 6, "2040-01-01", "2040-01-09", 60],
    [8, 6, "2040-01-10", "2040-01-20", 80],
    [8, 6, "2040-01-21", "2040-01-31", 60],
  ]);
  const registro = historial().find((fila) => fila.campo === "adicionales_reglas");
  assert.equal(registro.operacion, "CREATE");
  assert.equal(registro.temporada, 8);
});

// --- GET /temporada/:id ---------------------------------------------------------

test("GET /temporada/:id devuelve adicionales_reglas: las guardadas y las cargadas por tramo, agrupadas", async () => {
  escenario.reglasGuardadas = [{
    id: 31, adicional_id: 12, servicio_id: 10, recurso_id: null, regimen_id: null,
    fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: "900.00",
  }];
  // Mascota cargada por tramo, igual en las dos habitaciones: vuelve como una regla para todos.
  escenario.sueltas = [5, 6].map((recursoId) => ({
    adicional_id: 9, recurso_id: recursoId, regimen_id: 2, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: "50.00",
  }));
  const response = await request("/temporada/1", "GET");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.configuracion_servicios[0].regimenes[0].recursos.length, 2);
  assert.deepEqual(response.body.adicionales_reglas, [
    { id: 31, adicional_id: 12, servicio_id: 10, recurso_id: null, regimen_id: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 900 },
    { adicional_id: 9, servicio_id: null, recurso_id: null, regimen_id: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 50, inferida: true },
  ]);
});

// --- Bloques de temporada alta ----------------------------------------------------

function bloque(tarifas) {
  return {
    nombre: "Bloque enero", servicio_id: 10, modalidad: "BLOQUE", recursos: [5, 6],
    fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31",
    tarifas: { nombre_campania: "Bloque enero", fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", configuracion_servicios: configuracion(), ...tarifas },
  };
}

test("POST /admin/bloques con tarifas.adicionales_reglas las materializa en la temporada del bloque", async () => {
  escenario.origen = "BLOQUE";
  // Todos los recursos del bloque a $70; la Habitación 6 a $90.
  const reglas = [
    { adicional_id: 9, servicio_id: 10, recurso_id: null, regimen_id: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 70 },
    { adicional_id: 9, servicio_id: 10, recurso_id: 6, regimen_id: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 90 },
  ];
  const response = await request("/admin/bloques", "POST", bloque({ adicionales_reglas: reglas }));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.temporada_tarifa_id, 8);
  assert.equal(commits, 1);
  assert.equal(buscar(/INSERT INTO tarifa_adicional\s+\(temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio\)\s+VALUES/).length, 0);
  assert.deepEqual(filasMaterializadas().map((p) => [p[0], p[1], p[6]]), [[8, 5, 70], [8, 6, 90]]);
  // Un bloque no se cruza con temporadas generales (las cotizaciones del bloque leen sólo la suya).
  assert.equal(buscar(/LEFT JOIN adicional_precio ap2/).length, 0);
  assert.ok(indiceDe(/INSERT INTO adicional_precio/) < indiceDe(/INSERT INTO bloque_fecha\s/));
  assert.equal(historial().find((fila) => fila.campo === "adicionales_reglas").temporada, 8);
});

test("PUT /admin/bloques/:id con reglas: van a la temporada nueva y las de la anterior quedan de baja", async () => {
  escenario.origen = "BLOQUE";
  const reglas = [{ adicional_id: 9, servicio_id: 10, recurso_id: null, regimen_id: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 70 }];
  const response = await request("/admin/bloques/1", "PUT", bloque({ adicionales_reglas: reglas }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(filasMaterializadas().map((p) => [p[0], p[1], p[6]]), [[8, 5, 70], [8, 6, 70]]);
  const bajaAnterior = buscar(/UPDATE adicional_precio SET activo = 0, fecha_baja = NOW\(\) WHERE temporada_tarifa_id = \?/);
  assert.equal(bajaAnterior.length, 1);
  assert.equal(bajaAnterior[0].params[0], 7, "las reglas de la temporada anterior del bloque");
});

test("POST /admin/bloques: un error del motor vuelve con su status y mensaje, sin crear el bloque", async () => {
  escenario.origen = "BLOQUE";
  const reglas = [{ adicional_id: 9, servicio_id: 11, recurso_id: null, regimen_id: null, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 70 }];
  const response = await request("/admin/bloques", "POST", bloque({ adicionales_reglas: reglas }));
  assert.equal(response.status, 400);
  assert.equal(response.body.message, "El servicio del precio 1 no está habilitado en este ámbito.");
  assert.equal(buscar(/INSERT INTO bloque_fecha\s/).length, 0);
  assert.equal(rollbacks, 1);
});

// --- Adicionales de VENTA -----------------------------------------------------------

test("GET /adicionales (catálogo de los editores) no ofrece los de VENTA y anda antes de la migración", async () => {
  let response = await request("/adicionales", "GET");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [{ id: 9, nombre: "Mascota" }]);
  const [lectura] = buscar(/FROM adicional a WHERE 1 = 1/);
  assert.match(lectura.sql, /AND COALESCE\(a\.modalidad, 'ALQUILER'\) <> 'VENTA'/);

  escenario.sinModalidad = true;
  response = await request("/adicionales", "GET");
  assert.equal(response.status, 200);
  const lecturas = buscar(/FROM adicional a WHERE 1 = 1/);
  assert.equal(lecturas.length, 2);
  assert.doesNotMatch(lecturas[1].sql, /modalidad/);
});

test("POST /reserva/adicionales lee tarifa_adicional sin los adicionales de VENTA", () => {
  const fuente = fs.readFileSync(path.join(__dirname, "../api/routes/user.js"), "utf8");
  const inicio = fuente.indexOf('router.post("/reserva/adicionales",');
  const fin = fuente.indexOf("router.", inicio + 10);
  const handler = fuente.slice(inicio, fin);
  assert.ok(inicio > 0);
  assert.match(handler, /consultarAdicionalesPorDia\(/);
  assert.match(handler, /INNER JOIN adicional a ON a\.id = ta\.adicional_id[\s\S]+\$\{porDia\}/);
});
