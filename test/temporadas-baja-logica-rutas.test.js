"use strict";

// Baja lógica al editar temporadas: PUT /temporada/:id y PUT /admin/bloques/:id ya no
// borran tarifas ni temporadas (las dan de baja con lote y motivo) y GET /temporada/:id
// sólo arma la temporada con lo vigente y avisa si ya se usó en reservas.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2");

process.env.JWT_SECRET = "temporadas-baja-logica-test";

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let escenario;
const consultas = [];
let commits = 0;
let rollbacks = 0;

function escenarioBase() {
  return {
    usada: false,
    // Vigentes de la temporada 1: Hotel (servicio 10) recurso 5 / régimen 2 sigue en la
    // configuración; Camping (servicio 11) recurso 6 / régimen 2 se quitó.
    vigentes: [
      { id: 101, recurso_id: 5, regimen_id: 2, servicio_id: 10 },
      { id: 102, recurso_id: 5, regimen_id: 2, servicio_id: 10 },
      { id: 103, recurso_id: 6, regimen_id: 2, servicio_id: 11 },
    ],
    adicionalesDadosDeBaja: 2,
    // tarifa_adicional de la temporada 1 antes del upsert: el adicional 9 del recurso 5
    // con el mismo precio que vuelve en la configuración (50).
    adicionalesGuardados: [
      { id: 41, recurso_id: 5, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 50 },
    ],
    bloque: { id: 1, temporada_tarifa_id: 7 },
    vigentesBloque: [
      { id: 301, recurso_id: 5, regimen_id: 2, servicio_id: 10 },
      { id: 302, recurso_id: 5, regimen_id: 2, servicio_id: 10 },
    ],
  };
}

async function query(sql, params = []) {
  consultas.push({ sql, params });
  if (/FROM usuario u[\s\S]+INNER JOIN rol r/.test(sql)) {
    return [[{ id: 1, rol: "admin", rol_id: 1, habilitado: "S", area_turismo: 1, modulo_turismo: 1 }]];
  }
  if (/SELECT s\.id, ts\.codigo AS tipo_codigo/.test(sql)) return [[{ id: 10, tipo_codigo: "ALOJAMIENTO_RECURSO" }]];
  if (/SELECT id, servicio_id FROM recurso WHERE id IN/.test(sql)) return [[{ id: 5, servicio_id: 10 }]];
  if (/FROM servicio_regimen/.test(sql)) return [[{ servicio_id: 10, regimen_id: 2 }]];
  if (/SELECT id FROM adicional WHERE id IN/.test(sql)) return [[{ id: 9 }]];
  if (/SELECT nombre, fecha_inicio, fecha_fin FROM temporada_tarifa WHERE id = \? FOR UPDATE/.test(sql)) {
    return [[{ nombre: "Verano", fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31" }]];
  }
  if (/SELECT id, nombre, fecha_inicio, fecha_fin FROM temporada_tarifa WHERE id = \?/.test(sql)) {
    return [[{ id: 1, nombre: "Verano", fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31" }]];
  }
  if (/AS usada/.test(sql)) return [[{ usada: escenario.usada ? 1 : 0 }]];
  if (/FOR UPDATE OF t/.test(sql)) {
    return [Number(params[0]) === 1 ? escenario.vigentes : escenario.vigentesBloque];
  }
  if (/^\s*UPDATE tarifa\s+SET eliminado = 1/.test(sql)) {
    const filas = Number(params.at(-1)) === 1 ? escenario.vigentes : escenario.vigentesBloque;
    return [{ affectedRows: filas.length }];
  }
  if (/^\s*UPDATE tarifa_adicional\s+SET activo = 0/.test(sql)) return [{ affectedRows: escenario.adicionalesDadosDeBaja }];
  if (/FROM tarifa t\s+INNER JOIN temporada_tarifa tt/.test(sql)) return [[]]; // sin solapamientos
  if (/FROM tarifa t\s+JOIN recurso r ON t\.recurso_id = r\.id/.test(sql)) {
    return [[{
      tarifa_id: 101, recurso_id: 5, tipo_persona_id: null, regimen_id: 2, edad_minima: null, edad_maxima: null,
      precio: "1000.00", fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio_por_persona: "N",
      usa_porcentaje: 0, porcentaje_descuento: null, parcelas_disponibles: null, recurso_nombre: "Habitación 3",
      servicio_id: 10, servicio_nombre: "Hotel Solís", tipo_codigo: "ALOJAMIENTO_RECURSO", regimen_nombre: "Pensión completa",
    }]];
  }
  if (/SELECT id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio\s+FROM tarifa_adicional/.test(sql)) {
    return [escenario.adicionalesGuardados];
  }
  if (/FROM tarifa_adicional\s+WHERE temporada_tarifa_id = \? AND activo = 1/.test(sql)) return [[]];
  if (/FROM temporada_tipo_persona_porcentaje\s+WHERE temporada_tarifa_id = \?/.test(sql)) return [[]];
  if (/SELECT tipo_persona_id, porcentaje FROM temporada_tipo_persona_porcentaje/.test(sql)) return [[]];
  if (/SELECT id, temporada_tarifa_id FROM bloque_fecha WHERE id = \? FOR UPDATE/.test(sql)) return [[escenario.bloque]];
  if (/SELECT id FROM reserva\s+WHERE bloque_fecha_id/.test(sql)) return [[]];
  if (/SELECT id FROM recurso WHERE id IN \([^)]*\) AND servicio_id = \? FOR UPDATE/.test(sql)) return [[{ id: 5 }]];
  if (/FROM bloque_fecha_recurso bfr/.test(sql)) return [[]];
  if (/INSERT INTO temporada_tarifa/.test(sql)) return [{ insertId: 8 }];
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
const { darDeBajaTarifasTemporada } = rutasUsuario.__test;
const app = express();
app.use(express.json());
app.use("/api", rutasUsuario);

async function request(ruta, method, body) {
  consultas.length = 0;
  commits = 0;
  rollbacks = 0;
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

// Temporada con un solo servicio (Hotel 10 › régimen 2 › recurso 5): el Camping (11) se quitó.
function temporada({ nombre = "Verano" } = {}) {
  return {
    nombre_campania: nombre,
    fecha_inicio: "2040-01-01",
    fecha_fin: "2040-01-31",
    configuracion_servicios: [{ id: 10, regimenes: [{ id: 2, recursos: [{
      id: 5, precio_por_persona: false,
      fechas: [{ fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 1000, adicionales: [{ adicionalId: 9, precio: 50 }] }],
    }] }] }],
  };
}

const buscar = (patron) => consultas.filter(({ sql }) => patron.test(sql));
const indiceDe = (patron) => consultas.findIndex(({ sql }) => patron.test(sql));
const historial = () => buscar(/INSERT INTO historial_temporada/).map(({ params }) => ({
  temporada: params[0], usuario: params[1], operacion: params[2], campo: params[3],
  anterior: params[4] ? JSON.parse(params[4]) : null, nuevo: params[5],
}));

test.beforeEach(() => {
  escenario = escenarioBase();
});

test("PUT /temporada/:id da de baja lo vigente con lote y motivo, sin borrar nada", async () => {
  const response = await request("/temporada/1", "PUT", temporada());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(commits, 1);

  assert.equal(buscar(/DELETE\s+FROM\s+tarifa\b/).length, 0, "no borra tarifas");
  assert.equal(buscar(/DELETE\s+FROM\s+tarifa_adicional\b/).length, 0, "no borra adicionales");

  const [seleccion] = buscar(/FOR UPDATE OF t/);
  assert.match(seleccion.sql, /WHERE t\.temporada_tarifa_id = \? AND t\.eliminado = 0/);

  const [bajaTarifas] = buscar(/^\s*UPDATE tarifa\s+SET eliminado = 1/);
  assert.ok(bajaTarifas, "da de baja las tarifas con UPDATE");
  assert.match(bajaTarifas.sql, /fecha_eliminacion = NOW\(\), eliminado_usuario_id = \?/);
  assert.match(bajaTarifas.sql, /eliminado_motivo = IF\(CONCAT\(recurso_id, ':', regimen_id\) IN \(\?\), 'REEMPLAZADO', 'QUITADO'\)/);
  assert.match(bajaTarifas.sql, /WHERE temporada_tarifa_id = \? AND eliminado = 0/);
  const [usuario, lote, pares, temporadaId] = bajaTarifas.params;
  assert.equal(usuario, 1);
  assert.match(lote, PATRON_UUID);
  assert.deepEqual(pares, ["5:2"], "sólo el par que sigue en la configuración queda REEMPLAZADO");
  assert.equal(String(temporadaId), "1");

  const [bajaAdicionales] = buscar(/^\s*UPDATE tarifa_adicional\s+SET activo = 0/);
  assert.ok(bajaAdicionales, "da de baja los adicionales");
  assert.match(bajaAdicionales.sql, /eliminado_lote = \?/);
  assert.deepEqual(bajaAdicionales.params, [1, lote, ["5:2"], "1"], "mismo lote para tarifas y adicionales");

  // Lo nuevo se inserta después de dar de baja lo anterior.
  assert.ok(indiceDe(/^\s*UPDATE tarifa\s+SET eliminado = 1/) < indiceDe(/INSERT INTO tarifa\s/));
  const [upsert] = buscar(/INSERT INTO tarifa_adicional/);
  assert.match(upsert.sql, /ON DUPLICATE KEY UPDATE precio = VALUES\(precio\), activo = 1,\s+fecha_eliminacion = NULL, eliminado_usuario_id = NULL,\s+eliminado_motivo = NULL, eliminado_lote = NULL/);
});

test("PUT /temporada/:id registra en el historial un resumen por par, nunca filas completas", async () => {
  const response = await request("/temporada/1", "PUT", temporada());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const [bajaTarifas] = buscar(/^\s*UPDATE tarifa\s+SET eliminado = 1/);
  const lote = bajaTarifas.params[1];

  const tarifas = historial().find((fila) => fila.operacion === "DELETE" && fila.campo === "tarifas");
  assert.deepEqual(tarifas.anterior, {
    baja_logica: true,
    lote,
    cantidad: 3,
    reemplazadas: 2,
    quitadas: [{ servicio_id: 11, regimen_id: 2, recurso_id: 6, filas: 1 }],
  });
  assert.equal(tarifas.nuevo, null);
  assert.equal(tarifas.usuario, 1);

  const adicionales = historial().find((fila) => fila.campo === "tarifa_adicional" && fila.operacion === "UPDATE");
  assert.deepEqual(adicionales.anterior, { baja_logica: true, lote, cantidad: 2, accion: "desactivar" });
  // El adicional vuelve con el mismo precio: no hay precio pisado que registrar.
  assert.equal(historial().filter((fila) => fila.campo === "tarifa_adicional_precio").length, 0);
});

test("PUT /temporada/:id deja en el historial el precio que el upsert de adicionales pisa", async () => {
  escenario.adicionalesGuardados = [
    // Misma clave que el adicional 9 que vuelve (50): el upsert reactiva esta fila y pisa su precio.
    { id: 41, recurso_id: 5, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", precio: 40 },
    // Otro rango: el upsert no lo toca y conserva su precio en la fila.
    { id: 42, recurso_id: 5, regimen_id: 2, adicional_id: 9, fecha_inicio: "2040-02-01", fecha_fin: "2040-02-28", precio: 10 },
  ];
  const response = await request("/temporada/1", "PUT", temporada());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const lote = buscar(/^\s*UPDATE tarifa\s+SET eliminado = 1/)[0].params[1];

  const lectura = /SELECT id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio\s+FROM tarifa_adicional/;
  assert.deepEqual(buscar(lectura)[0].params, ["1"]);
  assert.ok(indiceDe(lectura) < indiceDe(/INSERT INTO tarifa_adicional/), "lee los precios antes del upsert");

  const precios = historial().filter((fila) => fila.campo === "tarifa_adicional_precio");
  assert.equal(precios.length, 1);
  assert.equal(precios[0].operacion, "UPDATE");
  assert.equal(precios[0].usuario, 1);
  assert.deepEqual(precios[0].anterior, {
    lote,
    adicionales: [{
      id: 41, adicional_id: 9, recurso_id: 5, regimen_id: 2, fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31",
      precio_anterior: 40, precio_nuevo: 50,
    }],
  });
  assert.equal(precios[0].nuevo, null);
});

// --- darDeBajaTarifasTemporada (casos que el PUT no llega a mandar) ---------------
function conexionBaja(vigentes) {
  const sentencias = [];
  return {
    sentencias,
    async query(sql, params = []) {
      sentencias.push({ sql, params });
      if (/FOR UPDATE OF t/.test(sql)) return [vigentes];
      if (/^\s*UPDATE tarifa\s+SET eliminado = 1/.test(sql)) return [{ affectedRows: vigentes.length }];
      if (/^\s*UPDATE tarifa_adicional\s+SET activo = 0/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
}

test("darDeBajaTarifasTemporada sin pares conservados deja todo QUITADO sin armar un IN ()", async () => {
  const conexion = conexionBaja([
    { id: 101, recurso_id: 5, regimen_id: 2, servicio_id: 10 },
    { id: 103, recurso_id: 6, regimen_id: null, servicio_id: 11 },
  ]);
  const baja = await darDeBajaTarifasTemporada(conexion, { temporadaId: 1, usuarioId: 3, paresConservados: [] });

  const actualizaciones = conexion.sentencias.filter(({ sql }) => /^\s*UPDATE\b/.test(sql));
  assert.equal(actualizaciones.length, 2, "tarifas y adicionales");
  for (const { sql, params } of actualizaciones) {
    assert.match(sql, /eliminado_motivo = 'QUITADO'/);
    assert.doesNotMatch(sql, /\bIN\s*\(/);
    assert.deepEqual(params, [3, baja.lote, 1]);
    assert.doesNotMatch(mysql.format(sql, params), /IN \(\)/);
  }
  assert.match(baja.lote, PATRON_UUID);
  assert.equal(baja.tarifas, 2);
  assert.equal(baja.reemplazadas, 0);
  assert.deepEqual(baja.quitadas, [
    { servicio_id: 10, regimen_id: 2, recurso_id: 5, filas: 1 },
    { servicio_id: 11, regimen_id: null, recurso_id: 6, filas: 1 },
  ]);
});

test("darDeBajaTarifasTemporada: una tarifa con régimen NULL queda QUITADO, en el resumen y en el SQL", async () => {
  const conexion = conexionBaja([
    { id: 101, recurso_id: 5, regimen_id: 2, servicio_id: 10 },
    { id: 104, recurso_id: 5, regimen_id: null, servicio_id: 10 },
  ]);
  const baja = await darDeBajaTarifasTemporada(conexion, { temporadaId: 1, usuarioId: 3, paresConservados: ["5:2"] });

  // En MySQL CONCAT(5, ':', NULL) es NULL, NULL IN (...) no es verdadero y el IF da 'QUITADO':
  // lo mismo que el resumen de JS ("5:null" no es un par conservado).
  const [tarifas] = conexion.sentencias.filter(({ sql }) => /^\s*UPDATE tarifa\s+SET/.test(sql));
  assert.match(tarifas.sql, /eliminado_motivo = IF\(CONCAT\(recurso_id, ':', regimen_id\) IN \(\?\), 'REEMPLAZADO', 'QUITADO'\)/);
  assert.match(mysql.format(tarifas.sql, tarifas.params), /IN \('5:2'\)/);
  assert.equal(baja.tarifas, 2);
  assert.equal(baja.reemplazadas, 1);
  assert.deepEqual(baja.quitadas, [{ servicio_id: 10, regimen_id: null, recurso_id: 5, filas: 1 }]);
});

test("PUT /temporada/:id con reservas responde 409 en voseo y no toca las tarifas", async () => {
  escenario.usada = true;
  const response = await request("/temporada/1", "PUT", temporada());
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    message: "La temporada ya se usó en reservas y sus precios no se pueden reemplazar. Para precios nuevos, creá otra temporada.",
    codigo: "TEMPORADA_CON_HISTORIAL",
  });
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
  assert.equal(buscar(/^\s*UPDATE tarifa(_adicional)?\s+SET/).length, 0);
  assert.equal(buscar(/INSERT INTO tarifa/).length, 0);
  // El chequeo cuenta reservas sobre cualquier tarifa de la temporada, vigente o no.
  const [chequeo] = buscar(/AS usada/);
  assert.match(chequeo.sql, /INNER JOIN tarifa t ON t\.id = rft\.tarifa_id\s+WHERE t\.temporada_tarifa_id = \?/);
  assert.doesNotMatch(chequeo.sql, /eliminado/);
});

test("GET /temporada/:id arma la temporada sólo con lo vigente y avisa si tiene reservas", async () => {
  for (const usada of [false, true]) {
    escenario.usada = usada;
    const response = await request("/temporada/1", "GET");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.tiene_reservas, usada);
    assert.equal(response.body.configuracion_servicios.length, 1);
    assert.equal(response.body.configuracion_servicios[0].regimenes[0].recursos[0].id, 5);

    const [tarifas] = buscar(/FROM tarifa t\s+JOIN recurso r ON t\.recurso_id = r\.id/);
    assert.match(tarifas.sql, /WHERE t\.temporada_tarifa_id = \?\s+AND t\.eliminado = 0/);
    const [adicionales] = buscar(/FROM tarifa_adicional/);
    assert.match(adicionales.sql, /AND activo = 1/);
  }
});

test("PUT /admin/bloques/:id deja la temporada anterior dada de baja como REEMPLAZADO, sin borrarla", async () => {
  const configuracion = temporada({ nombre: "Bloque enero" });
  const response = await request("/admin/bloques/1", "PUT", {
    nombre: "Bloque enero", servicio_id: 10, modalidad: "BLOQUE", recursos: [5],
    fecha_inicio: "2040-01-01", fecha_fin: "2040-01-31", tarifas: configuracion,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(commits, 1);

  assert.equal(buscar(/DELETE\s+FROM\s+temporada_tarifa\b/).length, 0, "no borra la temporada anterior");
  assert.equal(buscar(/DELETE\s+FROM\s+tarifa\b/).length, 0, "no borra tarifas");

  const [bajaTarifas] = buscar(/^\s*UPDATE tarifa\s+SET eliminado = 1/);
  assert.match(bajaTarifas.sql, /eliminado_motivo = 'REEMPLAZADO'/);
  const [usuario, lote, temporadaAnterior] = bajaTarifas.params;
  assert.equal(usuario, 1);
  assert.match(lote, PATRON_UUID);
  assert.equal(temporadaAnterior, 7, "da de baja la temporada anterior del bloque, no la nueva");

  const [bajaAdicionales] = buscar(/^\s*UPDATE tarifa_adicional\s+SET activo = 0/);
  assert.match(bajaAdicionales.sql, /eliminado_motivo = 'REEMPLAZADO'/);
  assert.deepEqual(bajaAdicionales.params, [1, lote, 7]);

  const registro = historial().find((fila) => fila.temporada === 7);
  assert.equal(registro.operacion, "DELETE");
  assert.equal(registro.campo, "tarifas");
  assert.deepEqual(registro.anterior, {
    baja_logica: true, lote, cantidad: 2, reemplazadas: 2, quitadas: [], adicionales: 2, reemplazada_por: 8,
  });

  // El bloque pasa a la temporada nueva.
  const [actualizacion] = buscar(/UPDATE bloque_fecha\s+SET sorteo_id/);
  assert.equal(actualizacion.params[2], 8);
});
