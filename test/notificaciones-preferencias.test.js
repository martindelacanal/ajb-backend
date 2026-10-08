"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PREFERENCIAS_POR_DEFECTO, categoriaNotificacion, normalizarPreferencias,
  validarPreferencias, obtenerPreferenciasNotificaciones,
  guardarPreferenciasNotificaciones, crearNotificacion,
} = require("../api/services/notificaciones");

test("clasifica mensajes, avances, gestiones y comunicados de todos los módulos", () => {
  const casos = {
    COSEGURO_OBSERVACION: "mensajes", RESERVA_OBSERVACION: "mensajes", OLIMPIADA_MENSAJE: "mensajes",
    BENEFICIO_OBSERVACION: "mensajes", TURISMO_SERVICIO_OBSERVACION: "mensajes", TURISMO_SERVICIO_CHAT: "mensajes",
    TURISMO_SERVICIO_EN_REVISION: "estados", COSEGURO_ESTADO: "estados", TRASLADO_ACTUALIZADA: "estados",
    FAMILIAR_CAMBIO_APROBADO: "estados", SORTEO_ADJUDICADO: "estados", RESERVA_RESPUESTA_TITULAR: "estados",
    COSEGURO_NUEVA: "gestiones", RESERVA_PARA_APROBAR: "gestiones", RESERVA_APROBACION_TITULAR: "gestiones",
    FAMILIAR_CAMBIO_SOLICITADO: "gestiones", TURISMO_SERVICIO_PENDIENTE: "gestiones",
    OLIMPIADA_NOVEDAD: "novedades", BENEFICIO_PUBLICO: "novedades", AVISO_GENERAL: "novedades",
  };
  for (const [tipo, categoria] of Object.entries(casos)) assert.equal(categoriaNotificacion(tipo), categoria, tipo);
});

test("un usuario sin preferencias conserva todos los avisos y normaliza valores de MySQL", async () => {
  assert.deepEqual(normalizarPreferencias(), PREFERENCIAS_POR_DEFECTO);
  assert.deepEqual(normalizarPreferencias({ mensajes: 0, estados: 1, gestiones: false, novedades: true }),
    { mensajes: false, estados: true, gestiones: false, novedades: true });
  assert.deepEqual(await obtenerPreferenciasNotificaciones({ query: async () => [[]] }, 9), PREFERENCIAS_POR_DEFECTO);
});

test("rechaza valores no booleanos, preferencias incompletas y suplantación de usuario", () => {
  for (const valor of [null, [], {}, { ...PREFERENCIAS_POR_DEFECTO, mensajes: "false" },
    { ...PREFERENCIAS_POR_DEFECTO, usuario_id: 88 }, { ...PREFERENCIAS_POR_DEFECTO, estados: 0 }]) {
    assert.throws(() => validarPreferencias(valor), (error) => error.statusCode === 400);
  }
  assert.deepEqual(validarPreferencias({ mensajes: false, estados: false, gestiones: false, novedades: false }),
    { mensajes: false, estados: false, gestiones: false, novedades: false });
});

test("guardar preferencias usa sólo el usuario autorizado y nunca modifica avisos anteriores", async () => {
  const llamadas = [];
  const connection = { query: async (sql, params) => { llamadas.push({ sql, params }); return [{ affectedRows: 1 }]; } };
  const preferencias = { ...PREFERENCIAS_POR_DEFECTO, mensajes: false };
  assert.deepEqual(await guardarPreferenciasNotificaciones(connection, 9, preferencias), preferencias);
  assert.equal(llamadas.length, 1);
  assert.match(llamadas[0].sql, /^INSERT INTO usuario_notificacion_preferencia/);
  assert.deepEqual(llamadas[0].params, [9, 0, 1, 1, 1]);
  assert.doesNotMatch(llamadas[0].sql, /\bnotificacion\b/);
});

test("la entrega consulta la preferencia de su destinatario atómicamente y admite silencio sin crear un id", async () => {
  const llamadas = [];
  const connection = { query: async (sql, params) => { llamadas.push({ sql, params }); return [{ affectedRows: 0, insertId: 0 }]; } };
  const resultado = await crearNotificacion(connection, {
    usuarioId: 9, tipo: "COSEGURO_OBSERVACION", titulo: "Nuevo mensaje", mensaje: "Consultá el trámite", payload: { solicitud_id: 7 },
  });
  assert.equal(resultado.insertId, null);
  assert.equal(resultado.affectedRows, 0);
  assert.equal(llamadas.length, 1);
  assert.match(llamadas[0].sql, /SELECT mensajes FROM usuario_notificacion_preferencia WHERE usuario_id = \?/);
  assert.match(llamadas[0].sql, /COALESCE/);
  assert.deepEqual(llamadas[0].params, [9, "COSEGURO_OBSERVACION", "Nuevo mensaje", "Consultá el trámite", '{"solicitud_id":7}', 9]);
});

test("la categoría explícita se valida y los destinatarios inválidos no se insertan", async () => {
  let llamadas = 0;
  const connection = { query: async () => { llamadas++; return [{ insertId: 15, affectedRows: 1 }]; } };
  assert.equal((await crearNotificacion(connection, { usuarioId: 9, tipo: "PERSONALIZADO", categoria: "estados" })).insertId, 15);
  await assert.rejects(crearNotificacion(connection, { usuarioId: 9, categoria: "estados; DROP TABLE usuario" }));
  assert.equal((await crearNotificacion(connection, { usuarioId: "no-es-id" })).insertId, null);
  assert.equal(llamadas, 1);
});

test("durante migración conserva avisos; los otros errores de base de datos siguen visibles", async () => {
  const sinTabla = Object.assign(new Error("Table 'db.usuario_notificacion_preferencia' doesn't exist"), { code: "ER_NO_SUCH_TABLE" });
  assert.deepEqual(await obtenerPreferenciasNotificaciones({ query: async () => { throw sinTabla; } }, 9), PREFERENCIAS_POR_DEFECTO);
  await assert.rejects(guardarPreferenciasNotificaciones({ query: async () => { throw sinTabla; } }, 9, PREFERENCIAS_POR_DEFECTO),
    (error) => error.statusCode === 503);
  const sentencias = [];
  const connection = { query: async (sql) => {
    sentencias.push(sql);
    if (sentencias.length === 1) throw sinTabla;
    return [{ insertId: 10, affectedRows: 1 }];
  } };
  assert.equal((await crearNotificacion(connection, { usuarioId: 9, tipo: "COSEGURO_NUEVA" })).insertId, 10);
  assert.equal(sentencias.length, 2);
  await assert.rejects(crearNotificacion({ query: async () => {
    throw Object.assign(new Error("Table 'db.notificacion' doesn't exist"), { code: "ER_NO_SUCH_TABLE" });
  } }, { usuarioId: 9, tipo: "COSEGURO_NUEVA" }), /notificacion/);
});

// HTTP: el identificador se toma siempre de la sesión, nunca de la URL/cuerpo.
process.env.JWT_SECRET = "notificaciones-preferencias-test-secret";
const express = require("express");
const jwt = require("jsonwebtoken");
let usuarioActual;
let consultar = async () => [[]];
const consultas = [];
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: {
  promise: () => ({ query: async (sql, params) => {
    if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql)) return [[usuarioActual]];
    consultas.push({ sql, params });
    return consultar(sql, params);
  } }),
} };
const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/user"));

async function solicitar({ rol = "afiliado", id = 9, method = "GET", body, anonimo = false, query = "" } = {}) {
  consultas.length = 0;
  usuarioActual = { id, rol, rol_id: 1, habilitado: "Y", departamental_id: 1, area_turismo: 1, area_coseguro: 1,
    modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1 };
  const token = jwt.sign({ data: JSON.stringify(usuarioActual) }, process.env.JWT_SECRET);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const respuesta = await fetch(`http://127.0.0.1:${server.address().port}/api/notificaciones/preferencias${query}`, {
      method,
      headers: { ...(anonimo ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: respuesta.status, body: await respuesta.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("todas las cuentas del sistema leen y guardan únicamente sus preferencias de sesión", async () => {
  consultar = async (sql) => /^SELECT mensajes/.test(sql) ? [[{ mensajes: 0, estados: 1, gestiones: 1, novedades: 1 }]] : [{ affectedRows: 1 }];
  for (const rol of ["admin", "admin-central", "departamental", "afiliado", "auditor"]) {
    const lectura = await solicitar({ rol, query: "?usuario_id=88" });
    assert.equal(lectura.status, 200, rol);
    assert.equal(lectura.body.preferencias.mensajes, false);
    assert.deepEqual(consultas[0].params, [9]);
    const escritura = await solicitar({ rol, method: "PUT", query: "?usuario_id=88", body: PREFERENCIAS_POR_DEFECTO });
    assert.equal(escritura.status, 200, rol);
    assert.deepEqual(consultas[0].params, [9, 1, 1, 1, 1]);
  }
});

test("las rutas bloquean anónimos y cuerpos que intentan cambiar otro usuario", async () => {
  const anonimo = await solicitar({ anonimo: true });
  assert.ok([401, 403].includes(anonimo.status));
  assert.equal(consultas.length, 0);
  const otroUsuario = await solicitar({ method: "PUT", body: { ...PREFERENCIAS_POR_DEFECTO, usuario_id: 88 } });
  assert.equal(otroUsuario.status, 400);
  assert.equal(consultas.length, 0);
});
