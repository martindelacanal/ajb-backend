"use strict";

// Baja de la inscripción a un sorteo pedida por la persona afiliada: sólo la
// propia, antes del sorteo y sin adjudicación. Queda «Cancelada» (id 13) y la
// aprobación del titular que esperaba se cierra.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

const { validarBajaInscripcionSorteo } = require("../api/services/sorteos-vigencia");

process.env.JWT_SECRET = "sorteos-baja-inscripcion-test-secret";

const BASE = {
  esPropietario: true,
  recursoId: null,
  tieneAdjudicacion: false,
  estadoReserva: "Solicitud sorteo",
  estadoSorteo: "ACTIVO",
};

test("permite la baja de una inscripción propia que espera el sorteo", () => {
  assert.equal(validarBajaInscripcionSorteo(BASE), null);
  assert.equal(validarBajaInscripcionSorteo({ ...BASE, estadoReserva: "Pendiente_Aprobacion_Titular" }), null);
});

test("rechaza la baja ajena, la ya sorteada, la terminada y la de un sorteo cerrado", () => {
  assert.equal(validarBajaInscripcionSorteo({ ...BASE, esPropietario: false }).codigo, "INSCRIPCION_AJENA");
  assert.equal(validarBajaInscripcionSorteo({ ...BASE, recursoId: 9 }).codigo, "INSCRIPCION_ADJUDICADA");
  assert.equal(validarBajaInscripcionSorteo({ ...BASE, tieneAdjudicacion: true }).codigo, "INSCRIPCION_ADJUDICADA");
  for (const estado of ["Cancelada", "No adjudicada", "Adjudicada", "Rechazada", null]) {
    assert.equal(validarBajaInscripcionSorteo({ ...BASE, estadoReserva: estado }).codigo, "INSCRIPCION_NO_ACTIVA", String(estado));
  }
  for (const estado of ["CERRADO", "CANCELADO", null]) {
    assert.equal(validarBajaInscripcionSorteo({ ...BASE, estadoSorteo: estado }).codigo, "SORTEO_YA_REALIZADO", String(estado));
  }
});

// ---------------------------------------------------------------------------
// Ruta PUT /sorteos/inscripciones/:id/cancelar con una base falsa
// ---------------------------------------------------------------------------
const llamadas = [];
let sesionActual;
let inscripcion;
let adjudicada;
let transaccion;

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

async function consultar(sql, params = []) {
  if (esConsultaAutorizacion(sql)) return [[{ ...sesionActual }]];
  llamadas.push({ sql, params });
  if (/FROM reserva r[\s\S]+WHERE r\.id = \? AND r\.modalidad = 'SORTEO'/.test(sql)) return [inscripcion ? [{ ...inscripcion }] : []];
  if (/FROM sorteo_adjudicacion_respuesta WHERE reserva_id = \?/.test(sql)) return [adjudicada ? [{ id: 1 }] : []];
  if (/^\s*UPDATE reserva SET estado_reserva_id/.test(sql)) return [{ affectedRows: 1 }];
  return [{ affectedRows: 0, insertId: 0 }];
}

const db = {
  query: consultar,
  execute: consultar,
  async getConnection() {
    return {
      query: consultar,
      async beginTransaction() { transaccion = "abierta"; },
      async commit() { transaccion = "confirmada"; },
      async rollback() { transaccion = "revertida"; },
      release() {},
    };
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => db } };

const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/user"));

const consoleLogOriginal = console.log;
test.before(() => {
  console.log = () => {};
});
test.after(() => {
  console.log = consoleLogOriginal;
});

function sesion(overrides = {}) {
  return {
    id: 100, rol_id: 3, rol: "afiliado", departamental_id: 4, habilitado: "Y",
    area_turismo: 1, area_coseguro: 0, modulo_turismo: 1, modulo_coseguro: 0, modulo_olimpiadas: 0,
    ...overrides,
  };
}

function preparar({ claims = {}, fila = {}, conAdjudicacion = false } = {}) {
  llamadas.length = 0;
  transaccion = null;
  sesionActual = sesion(claims);
  adjudicada = conAdjudicacion;
  inscripcion = fila === null ? null : {
    id: 61, usuario_id: 100, recurso_id: null, estado_reserva_id: 11,
    estado_nombre: "Solicitud sorteo", sorteo_estado: "ACTIVO", sorteo_nombre: "Verano 2027",
    ...fila,
  };
}

async function cancelar(id = 61) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify({ id: sesionActual.id, rol: sesionActual.rol }) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sorteos/inscripciones/${id}/cancelar`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const actualizaciones = () => llamadas.filter(({ sql }) => /^\s*UPDATE /.test(sql));

test("la persona afiliada se da de baja: «Cancelada» (13), historial y titular cerrado", async () => {
  preparar({ fila: { estado_reserva_id: 14, estado_nombre: "Pendiente_Aprobacion_Titular" } });

  const { status, body } = await cancelar();

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.estado, "Cancelada");
  assert.match(body.message, /Te diste de baja del sorteo «Verano 2027»/);
  assert.equal(transaccion, "confirmada");
  const [estado] = actualizaciones().filter(({ sql }) => /UPDATE reserva SET estado_reserva_id/.test(sql));
  // Sólo si sigue en el estado leído: una adjudicación en paralelo no se pisa
  assert.match(estado.sql, /WHERE id = \? AND estado_reserva_id = \?/);
  assert.deepEqual(estado.params, [13, 61, 14]);
  const historial = llamadas.find(({ sql }) => /INSERT INTO historial_reserva/.test(sql));
  assert.ok(historial, "falta el historial");
  assert.ok(historial.params.includes("Baja de la inscripción al sorteo pedida por la persona afiliada"));
  assert.ok(actualizaciones().some(({ sql }) => /UPDATE reserva_aprobacion_titular SET decision = 'CANCELADA'/.test(sql)));
  assert.ok(actualizaciones().some(({ sql }) => /UPDATE notificacion SET leida = 1[\s\S]+RESERVA_APROBACION_TITULAR/.test(sql)));
  // Bloquea la inscripción (como adjudicar y cerrar) antes de decidir
  assert.ok(llamadas.some(({ sql }) => /WHERE r\.id = \? AND r\.modalidad = 'SORTEO'[\s\S]+FOR UPDATE/.test(sql)));
});

test("no da de baja la inscripción de otra persona", async () => {
  preparar({ fila: { usuario_id: 999 } });
  const { status, body } = await cancelar();
  assert.equal(status, 403);
  assert.equal(body.codigo, "INSCRIPCION_AJENA");
  assert.equal(transaccion, "revertida");
  assert.equal(actualizaciones().length, 0);
});

test("una inscripción ya sorteada o con el sorteo cerrado no se da de baja", async () => {
  preparar({ conAdjudicacion: true });
  let respuesta = await cancelar();
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "INSCRIPCION_ADJUDICADA");

  preparar({ fila: { sorteo_estado: "CERRADO" } });
  respuesta = await cancelar();
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "SORTEO_YA_REALIZADO");
  assert.equal(actualizaciones().length, 0);
});

test("sólo la persona afiliada usa esta baja y la inscripción tiene que existir", async () => {
  preparar({ claims: { rol: "admin", rol_id: 1 } });
  assert.equal((await cancelar()).status, 401);

  preparar({ fila: null });
  const { status, body } = await cancelar();
  assert.equal(status, 404);
  assert.equal(body.codigo, "INSCRIPCION_NO_ENCONTRADA");

  preparar();
  assert.equal((await cancelar("abc")).status, 400);
});
