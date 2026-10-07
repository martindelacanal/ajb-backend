"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "reservas-familiares-notificaciones-test";
const enviados = [];
const correoPath = require.resolve("../api/services/correo");
require.cache[correoPath] = {
  id: correoPath, filename: correoPath, loaded: true,
  exports: {
    estadoCorreo: () => ({ modoPruebas: false, redirigirA: null }),
    urlAplicacion: ruta => `https://example.test${ruta}`,
    enviarCorreoPlantilla: async mensaje => { enviados.push(mensaje); return { enviado: true }; },
  },
};
const familiares = require("../api/services/reservas-familiares");
const { ESTADO_PENDIENTE_TITULAR, registrarSolicitudTitular } = familiares;

const titular = { id: 10, rol: "afiliado", rol_id: 2, habilitado: "Y", modulo_turismo: 1,
  departamental_id: 7, cbu: "2850590940090418135201", usuario_familiar_id: null };
const solicitante = { id: 20, rol: "invitado", habilitado: "Y", usuario_familiar_id: 10,
  es_familiar: "S", parentesco_id: 3 };
let estado;
let respaldo;
let fallaNotificacion;
const consultas = [];
const transacciones = [];
const connection = {
  async beginTransaction() { respaldo = structuredClone(estado); transacciones.push("begin"); },
  async commit() { transacciones.push("commit"); },
  async rollback() { estado = respaldo; transacciones.push("rollback"); },
  release() {},
  async query(sql, params = []) {
    consultas.push({ sql, params });
    if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u/.test(sql)) return [[titular]];
    if (/SELECT solicitante_usuario_id/.test(sql)) return [[{ solicitante_usuario_id: 20 }]];
    if (/WHERE u.id = \? FOR UPDATE/.test(sql)) return [[solicitante]];
    if (/SELECT u.id FROM usuario u INNER JOIN rol/.test(sql)) return [[{ id: 99 }]];
    if (/FROM usuario u INNER JOIN rol/.test(sql)) return [[titular]];
    if (/SELECT r.\*, er.nombre AS estado_nombre/.test(sql)) return [[{ ...estado.reserva }]];
    if (/SELECT id FROM usuario/.test(sql)) return [[{ id: 20 }]];
    if (/SELECT id, nombre FROM estado_reserva/.test(sql)) return [[{ id: 1, nombre: "Iniciada" }, { id: 4, nombre: "Rechazada" }]];
    if (/FROM reserva r/.test(sql)) return [[]];
    if (/SELECT id FROM estado_reserva/.test(sql)) return [[{ id: { Iniciada: 1, Rechazada: 4, [ESTADO_PENDIENTE_TITULAR]: 14 }[params[0]] }]];
    if (/FROM bloque_fecha_recurso/.test(sql)) return [[]];
    if (/UPDATE reserva SET/.test(sql)) {
      if (params.length === 3 && estado.reserva.estado_reserva_id !== params[2]) return [{ affectedRows: 0 }];
      estado.reserva.estado_reserva_id = params[0];
      estado.reserva.estado_nombre = params[0] === 1 ? "Iniciada" : params[0] === 4 ? "Rechazada" : ESTADO_PENDIENTE_TITULAR;
    }
    if (/INSERT INTO reserva_aprobacion_titular/.test(sql)) estado.solicitud = [...params];
    if (/UPDATE reserva_aprobacion_titular SET decision/.test(sql)) estado.reserva.decision = params[0];
    if (/INSERT INTO notificacion/.test(sql)) {
      if (fallaNotificacion) throw new Error("No se pudo guardar la notificación interna");
      estado.notificaciones.push({ sql, params });
    }
    if (/INSERT INTO historial_reserva/.test(sql)) estado.historial.push(params);
    return [{ affectedRows: 1 }];
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true,
  exports: { promise: () => ({ query: connection.query.bind(connection), getConnection: async () => connection }) },
};
const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/user"));

test.beforeEach(() => {
  enviados.length = 0;
  consultas.length = 0;
  transacciones.length = 0;
  fallaNotificacion = false;
  estado = {
    reserva: { id: 7, usuario_id: 20, estado_reserva_id: 14, estado_nombre: ESTADO_PENDIENTE_TITULAR,
      decision: "PENDIENTE", estado_destino: "Iniciada", modalidad: "FECHA_LIBRE", fecha_inicio: "2099-10-10" },
    notificaciones: [], historial: [], solicitud: null,
  };
});

function comprobarSinCorreo() {
  assert.equal(enviados.length, 0, "Las reservas familiares no deben enviar correos, tampoco con SMTP real habilitado");
  assert.equal(consultas.some(({ sql }) => /SET correo_|SELECT a.reserva_id, u.email|correo_intentos =/.test(sql)), false,
    "No se deben consumir ni reintentar entradas históricas de correo");
}

test("las tres altas ya no despachan correo y el arranque no instala un worker familiar", () => {
  assert.equal(familiares.enviarCorreoSolicitudTitular, undefined);
  assert.equal(familiares.iniciarReintentosCorreoTitular, undefined);
  const rutas = fs.readFileSync(path.join(__dirname, "../api/routes/user.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.doesNotMatch(rutas, /enviarCorreoSolicitudTitular/);
  assert.doesNotMatch(server, /iniciarReintentosCorreoTitular/);
});

test("cada modalidad guarda la solicitud y notifica internamente al titular sin correo", async () => {
  for (const estadoDestino of ["Iniciada", "Solicitud convenio", "Solicitud sorteo"]) {
    await connection.beginTransaction();
    await registrarSolicitudTitular(connection, { reservaId: 7, solicitanteId: 20, titularId: 10, estadoDestino });
    await connection.commit();
    const notificacion = estado.notificaciones.at(-1);
    assert.match(notificacion.sql, /'RESERVA_APROBACION_TITULAR'/);
    assert.equal(notificacion.params[0], 10);
    assert.deepEqual(JSON.parse(notificacion.params.at(-1)), {
      reserva_id: 7, estado: ESTADO_PENDIENTE_TITULAR, url: "/mis-gestiones?aprobacion_reserva=7",
    });
    assert.deepEqual(estado.solicitud, [7, 20, 10, estadoDestino]);
  }
  assert.equal(estado.historial.length, 3);
  comprobarSinCorreo();
});

test("si no se guarda la notificación de solicitud, el fallo permite revertir toda la transacción", async () => {
  fallaNotificacion = true;
  await connection.beginTransaction();
  await assert.rejects(registrarSolicitudTitular(connection, {
    reservaId: 7, solicitanteId: 20, titularId: 10, estadoDestino: "Iniciada",
  }), /No se pudo guardar/);
  await connection.rollback();
  assert.equal(estado.solicitud, null);
  assert.equal(estado.notificaciones.length, 0);
  assert.equal(estado.historial.length, 0);
  comprobarSinCorreo();
});

async function responderSolicitud(accion) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify(titular) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/reserva/7/aprobacion-titular`, {
      method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ accion }),
    });
    return { status: response.status, body: await response.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

for (const [accion, destino] of [["APROBAR", "Iniciada"], ["RECHAZAR", "Rechazada"]]) {
  test(`PUT aprobación titular ${accion}: conserva decisión, auditoría y notificación interna sin correo`, async () => {
    const response = await responderSolicitud(accion);
    assert.equal(response.status, 200);
    assert.equal(response.body.estado, destino);
    assert.deepEqual(transacciones, ["begin", "commit"]);
    const respuesta = estado.notificaciones.find(({ sql }) => /'RESERVA_RESPUESTA_TITULAR'/.test(sql));
    assert.equal(respuesta.params[0], 20);
    assert.equal(JSON.parse(respuesta.params.at(-1)).estado, destino);
    assert.equal(estado.historial.length, 1);
    comprobarSinCorreo();
  });
}

test("PUT aprobación titular revierte la decisión si falla la notificación interna", async () => {
  fallaNotificacion = true;
  const response = await responderSolicitud("APROBAR");
  assert.equal(response.status, 500);
  assert.deepEqual(transacciones, ["begin", "rollback"]);
  assert.equal(estado.reserva.estado_nombre, ESTADO_PENDIENTE_TITULAR);
  assert.equal(estado.reserva.decision, "PENDIENTE");
  assert.equal(estado.historial.length, 0);
  comprobarSinCorreo();
});
