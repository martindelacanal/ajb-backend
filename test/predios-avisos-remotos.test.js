"use strict";

// Ejercita las rutas HTTP y sus filtros SQL reales sobre SQLite. Sólo se adapta
// la interfaz query de mysql2: los destinatarios no salen de respuestas simuladas.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { crearSqlite, asegurarEsquema } = require("../predios/lib/db-sqlite");
const N = require("../predios/lib/negocio");
const { emitirAviso, leerAviso } = require("../predios/lib/avisos");
const { entregarAvisos, nuevosAvisos } = require("../api/services/predios-avisos");

process.env.JWT_SECRET = "predios-avisos-remotos-test-secret";
let db;
let servidor;
let url;
let adminLocal;
let privado;
let masivo;

function adaptadorSQL(ejecutor) {
  return { async query(sql, params = []) {
    sql = sql.replace("DATE_ADD(?, INTERVAL COALESCE(p.dias_aviso_vencimiento,7) DAY)", "date(?, '+' || COALESCE(p.dias_aviso_vencimiento,7) || ' days')");
    if (/^\s*SELECT/i.test(sql)) return [await ejecutor.all(sql, params)];
    const r = await ejecutor.run(sql, params);
    return [{ insertId: r.insertId, affectedRows: r.cambios }];
  } };
}

const pool = { async query(sql, params) { return adaptadorSQL(db).query(sql, params); } };
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => pool } };
const { crearRouterApp } = require("../api/routes/predios");

test.before(async () => {
  db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  db.exec(`CREATE TABLE rol (id INTEGER PRIMARY KEY, nombre TEXT);
    CREATE TABLE usuario (id INTEGER PRIMARY KEY, nombre TEXT, apellido TEXT, documento TEXT, habilitado TEXT, auth_revocado_desde TEXT, rol_id INTEGER);
    CREATE TABLE predio (id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT, escritor TEXT, ultima_conexion TEXT);
    CREATE TABLE notificacion (id INTEGER PRIMARY KEY, usuario_id INTEGER, tipo TEXT, titulo TEXT, mensaje TEXT, payload TEXT);
    INSERT INTO rol VALUES (1, 'admin'), (2, 'afiliado');
    INSERT INTO usuario VALUES (7, 'Admin', 'Primero', '12345678', 'Y', NULL, 1), (8, 'Admin', 'Segundo', '23456789', 'Y', NULL, 1), (9, 'Afiliado', 'Tercero', '34567890', 'Y', NULL, 2);
    INSERT INTO predio VALUES (1, 'MIRAMAR', 'Camping Miramar', 'LOCAL', NULL);`);
  const ctx = { db, pid: 1 };
  await db.tx(async (t) => {
    adminLocal = await N.insertar(t, ctx, "predio_usuario", { usuario: "dni12345678", nombre: "Admin primero", rol: "ADMIN", es_admin_general: 1, general_usuario_id: 7, documento: "12345678", activo: 1 });
    privado = await emitirAviso(t, ctx, { tipo: "ACCESO_FALLIDO", usuarioId: adminLocal, generalUsuarioId: 7, titulo: "Privado primero", mensaje: "Sólo del primero" });
    masivo = await emitirAviso(t, ctx, { tipo: "VENTA_SIN_STOCK", titulo: "Falta stock", mensaje: "Para todos los admins" });
    await emitirAviso(t, ctx, { tipo: "ACCESO_FALLIDO", generalDocumento: "23456789", titulo: "Privado segundo", mensaje: "Sólo del segundo" });
  });
  const app = express();
  app.use("/app", crearRouterApp());
  servidor = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => servidor.once("listening", resolve));
  url = `http://127.0.0.1:${servidor.address().port}/app/MIRAMAR/api/avisos`;
});

test.after(async () => {
  if (servidor) await new Promise((resolve) => servidor.close(resolve));
  if (db) db.cerrar();
});

async function consultar(uid, query = "") {
  const token = jwt.sign({ tipo: "predio-remoto", pcod: "MIRAMAR", uid }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const respuesta = await fetch(url + query, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(respuesta.status, 200);
  return respuesta.json();
}

test("el panel remoto reconoce destinatario y sus lecturas, y no expone avisos ajenos", async () => {
  const antes = (await consultar(7)).notificaciones;
  assert.deepEqual(antes.map((a) => a.titulo).sort(), ["Falta stock", "Privado primero"]);
  await leerAviso({ db, pid: 1, usuario: { id: adminLocal, rol: "ADMIN" }, params: { id: masivo } });
  const despues = (await consultar(7)).notificaciones;
  assert.deepEqual(despues.map((a) => a.id), [privado]);
});

test("un admin general sin fila local ve su aviso por DNI validado y no puede cambiar destinatario desde el navegador", async () => {
  const avisos = (await consultar(8, "?general_usuario_id=7&documento=12345678&usuario_id=1")).notificaciones;
  assert.deepEqual(avisos.map((a) => a.titulo).sort(), ["Falta stock", "Privado segundo"]);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_usuario")).n, 1, "leer no crea una cuenta en la réplica que controla la notebook");
});

test("entrega central con SQL real respeta cualquier rol y revierte notificaciones junto con la transacción", async () => {
  const predio = { id: 1, codigo: "MIRAMAR", nombre: "Camping" };
  const aviso = { id: 90, tipo: "ACCESO_FALLIDO", titulo: "5 intentos", mensaje: "Privado", fecha: "2026-11-05 18:00:00", general_documento: "34567890" };
  await db.tx((t) => entregarAvisos(adaptadorSQL(t), predio, [aviso]));
  assert.deepEqual((await db.all("SELECT usuario_id FROM notificacion")).map((n) => n.usuario_id), [9]);
  await assert.rejects(db.tx(async (t) => {
    await entregarAvisos(adaptadorSQL(t), predio, [{ ...aviso, general_documento: "12345678" }]);
    throw new Error("Fallo después de entregar");
  }), /Fallo después de entregar/);
  assert.deepEqual((await db.all("SELECT usuario_id FROM notificacion")).map((n) => n.usuario_id), [9]);
  const nuevos = await nuevosAvisos(adaptadorSQL(db), 1, [{ id: privado }, { id: 90 }, { id: 90 }]);
  assert.deepEqual(nuevos.map((a) => a.id), [90]);
});
