"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const perfiles = {
  admin: { id: 11, rol: "admin", nombre: "Ana", apellido: "Pérez" },
  "admin-central": { id: 12, rol: "admin-central", nombre: "Luis", apellido: "Gómez", area_turismo: 1 },
  departamental: { id: 21, rol: "departamental", nombre: "Marta", apellido: "Ruiz", departamental_id: 7, area_turismo: 1 },
};
let servicio;
let mensajes;
let notificaciones;
let transacciones;
const db = {
  async getConnection() { return this; },
  async beginTransaction() { transacciones.push("begin"); },
  async commit() { transacciones.push("commit"); },
  async rollback() { transacciones.push("rollback"); },
  release() {},
  async query(sql, params = []) {
    if (sql.includes("FROM servicio s")) return [[{ ...servicio }]];
    if (sql.includes("FROM tipo_servicio")) return [[{ id: 1, codigo: "ALOJAMIENTO_RECURSO", activo: 1 }]];
    if (sql.startsWith("SELECT ch.*") || sql.startsWith("SELECT * FROM turismo_tarifa_regla")) return [[]];
    if (sql.includes("SELECT id FROM departamental")) return [params.map((id) => ({ id }))];
    if (sql.includes("DELETE FROM servicio_departamental_visible") || sql.includes("INSERT INTO servicio_departamental_visible")) return [{ affectedRows: 1 }];
    if (sql.startsWith("UPDATE servicio SET\n") || sql.startsWith("UPDATE servicio SET\r\n")) {
      servicio.propietario_departamental_id = params[8];
      servicio.estado_aprobacion = params[9];
      servicio.alcance_departamental = params[11];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE servicio SET estado_aprobacion = 'PENDIENTE'")) {
      servicio.estado_aprobacion = "PENDIENTE";
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE servicio SET estado_aprobacion")) {
      servicio.estado_aprobacion = params[0];
      servicio.motivo_revision = params[1];
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("INSERT INTO servicio_observacion")) {
      const autor = Object.values(perfiles).find((p) => p.id === params[5]);
      const mensaje = {
        id: mensajes.length + 1, recurso_id: params[1], usuario_id: autor.id,
        usuario_rol: params[2], usuario_nombre: autor.nombre, usuario_apellido: autor.apellido,
        mensaje: params[3], estado_nombre: params[4], fecha_creacion: "2026-10-08 15:00:00",
      };
      mensajes.push(mensaje);
      return [{ insertId: mensaje.id, affectedRows: 1 }];
    }
    if (sql.includes("FROM servicio_observacion")) return [[...mensajes]];
    if (sql.includes("INSERT INTO turismo_historial")) return [{ affectedRows: 1 }];
    if (sql.includes("SELECT id FROM recurso")) return [params[0] === 77 ? [{ id: 77 }] : []];
    if (sql.includes("FROM usuario u")) {
      return [sql.includes("r.nombre = 'departamental'") && !sql.includes("r.nombre = 'admin'")
        ? [{ id: 21 }] : [{ id: 11 }, { id: 12 }]];
    }
    if (sql.includes("INSERT INTO notificacion")) {
      notificaciones.push({ usuarioId: params[0], tipo: params[1] });
      return [{ affectedRows: 1, insertId: notificaciones.length }];
    }
    if (sql.includes("AS imagenes_servicio")) return [[{
      imagenes_servicio: 1, recursos_activos: 1, reglas_vigentes: 1, departamentales_visibles: 1,
    }]];
    throw new Error(`SQL inesperado: ${sql}`);
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => db } };
const authPath = require.resolve("../api/security/autorizacion-sesion");
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { verificarTokenConAutorizacionActual({ req, next }) {
    const rol = req.get("x-role") || "departamental";
    req.data = { data: JSON.stringify({
      ...perfiles[rol], rol,
      ...(req.get("x-departamental") ? { departamental_id: Number(req.get("x-departamental")) } : {}),
      ...(req.get("x-area") ? { area_turismo: Number(req.get("x-area")) } : {}),
    }) };
    next();
  } },
};
const router = require("../api/routes/turismo-gestion");
const app = express();
app.use(express.json());
app.use(router);

async function request(path, { method = "GET", rol = "departamental", body, headers = {} } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/gestion/turismo/servicios/31${path}`, {
      method, headers: { "x-role": rol, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test.beforeEach(() => {
  servicio = { id: 31, nombre: "Cabañas", estado_aprobacion: "PENDIENTE", propietario_departamental_id: 7,
    tipo_codigo: "ALOJAMIENTO_RECURSO", alcance_departamental: "SELECCIONADAS", activo: 1, version: 1 };
  mensajes = [];
  notificaciones = [];
  transacciones = [];
});

test("la revisión, respuesta, aprobación y rechazo conservan un solo hilo con autor y rol", async () => {
  const revision = await request("/aprobacion", { method: "POST", rol: "admin-central",
    body: { accion: "SOLICITAR_CAMBIOS", motivo: "Corregir la capacidad" } });
  assert.equal(revision.status, 200);
  assert.equal(revision.body.estado_aprobacion, "EN_REVISION");
  assert.equal(mensajes[0].usuario_nombre, "Luis");
  assert.equal(mensajes[0].usuario_apellido, "Gómez");
  assert.equal(mensajes[0].usuario_rol, "admin-central");
  assert.deepEqual(notificaciones, [{ usuarioId: 21, tipo: "TURISMO_SERVICIO_EN_REVISION" }]);

  const respuesta = await request("/observaciones", { method: "POST", body: { mensaje: "Capacidad actualizada", recurso_id: 77 } });
  assert.equal(respuesta.status, 201);
  assert.equal(mensajes[1].recurso_id, 77);
  assert.equal(mensajes[1].usuario_rol, "departamental");
  assert.deepEqual(notificaciones.slice(1).map((n) => n.usuarioId), [11, 12]);
  assert.equal((await request("/aprobacion", { method: "POST", body: { estado: "PENDIENTE" } })).status, 200);

  const aprobado = await request("/aprobar", { method: "POST", rol: "admin" });
  assert.equal(aprobado.status, 200);
  assert.equal(aprobado.body.estado_aprobacion, "APROBADO");
  assert.equal((await request("/observaciones")).body.observaciones_hilo.length, 3);
  await router.__test.marcarPendientePorCambioDepartamental(db, perfiles.departamental, { ...servicio });
  assert.equal(servicio.estado_aprobacion, "PENDIENTE");
  const rechazado = await request("/rechazar", { method: "POST", rol: "admin", body: { motivo: "No cumple las condiciones" } });
  assert.equal(rechazado.status, 200);
  assert.equal(rechazado.body.estado_aprobacion, "RECHAZADO");
  const hilo = (await request("/observaciones")).body.observaciones_hilo;
  assert.equal(hilo.length, 4);
  assert.equal(hilo[0].mensaje, "Corregir la capacidad");
  assert.equal(hilo[3].estado_nombre, "RECHAZADO");
  assert.equal(transacciones.filter((t) => t === "rollback").length, 0);
});

test("chat de aprobación excluye afiliados, otras sedes, áreas deshabilitadas y recursos ajenos", async () => {
  for (const options of [
    { rol: "afiliado" }, { headers: { "x-departamental": "8" } },
    { rol: "admin-central", headers: { "x-area": "0" } },
  ]) {
    assert.equal((await request("/observaciones", options)).status, 403);
    assert.equal((await request("/observaciones", { ...options, method: "POST", body: { mensaje: "Ajeno" } })).status, 403);
  }
  const ajeno = await request("/observaciones", { method: "POST", body: { mensaje: "Ajeno", recurso_id: 88 } });
  assert.equal(ajeno.status, 400);
  assert.equal(mensajes.length, 0);
  assert.equal(notificaciones.length, 0);
});

test("reenviar a aprobación conserva la observación departamental en el mismo hilo", async () => {
  servicio.estado_aprobacion = "EN_REVISION";
  const response = await request("/aprobacion", { method: "POST", body: {
    accion: "ENVIAR", observacion: "Actualicé la capacidad solicitada",
  } });
  assert.equal(response.status, 200);
  assert.equal(mensajes.length, 1);
  assert.equal(mensajes[0].mensaje, "Actualicé la capacidad solicitada");
  assert.equal(mensajes[0].estado_nombre, "PENDIENTE");
  assert.equal(mensajes[0].usuario_id, perfiles.departamental.id);
  assert.deepEqual(notificaciones.map((n) => n.usuarioId), [11, 12]);
});

test("una observación inválida al reenviar no cambia el estado ni el hilo", async () => {
  servicio.estado_aprobacion = "EN_REVISION";
  const response = await request("/aprobacion", { method: "POST", body: {
    accion: "ENVIAR", observacion: "x".repeat(1001),
  } });
  assert.equal(response.status, 400);
  assert.equal(servicio.estado_aprobacion, "EN_REVISION");
  assert.equal(mensajes.length, 0);
});

test("editar desde administración conserva la propietaria y su acceso al chat", async () => {
  for (const rol of ["admin", "admin-central"]) {
    const response = await request("", { method: "PUT", rol, body: {
      nombre: "Cabañas", lugar: "Azul", tipo_servicio_id: 1,
      alcance_departamental: "PROPIA", version: 1,
    } });
    assert.equal(response.status, 200);
    assert.equal(response.body.propietario_departamental_id, 7);
    assert.equal((await request("/observaciones")).status, 200);
  }
});

test("alcance seleccionado siempre agrega la propietaria y sólo exige selección a servicios centrales", async () => {
  const inserts = [];
  const connection = { async query(sql, params) {
    if (sql.includes("SELECT id FROM departamental")) return [params.map((id) => ({ id }))];
    if (sql.startsWith("INSERT INTO servicio_departamental_visible")) inserts.push(params);
    return [{ affectedRows: 1 }];
  } };
  await router.__test.reemplazarVisibilidad(connection, 31, "SELECCIONADAS", [8, 8], 7);
  assert.deepEqual(inserts, [[31, 8], [31, 7]]);
  inserts.length = 0;
  await router.__test.reemplazarVisibilidad(connection, 31, "SELECCIONADAS", [], 7);
  assert.deepEqual(inserts, [[31, 7]]);
  await assert.rejects(router.__test.reemplazarVisibilidad(connection, 31, "SELECCIONADAS", []), /al menos una departamental/);
});
