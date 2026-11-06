"use strict";

// Rutas HTTP y SQL reales; sólo se traduce la interfaz mysql2 a SQLite para que
// las pruebas nunca dependan de una base ni una instalación productivas.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { once } = require("node:events");
const { crearSqlite, asegurarEsquema } = require("../predios/lib/db-sqlite");
const U = require("../predios/lib/util");
const { emitirAviso } = require("../predios/lib/avisos");
const SECRET = "predios-scope-remoto-fixture-sin-credenciales-reales";
process.env.JWT_SECRET = SECRET;
let poolActual;
const conexion = require.resolve("../api/connection/connection");
require.cache[conexion] = { id: conexion, filename: conexion, loaded: true, exports: { promise: () => poolActual } };
const A = require("../api/security/predios-acceso");
const { crearRouterCuenta, crearRouterApp, crearRouterAdmin } = require("../api/routes/predios");

async function escenario(t, { escritor = "LOCAL" } = {}) {
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db);
  db.exec(`CREATE TABLE predio(id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT, activo INTEGER DEFAULT 1, escritor TEXT,
    ultima_conexion TEXT, ultimo_push TEXT, equipo TEXT, version_local TEXT, pendientes_local INTEGER, servicio_codigos TEXT, ultima_escritura_central TEXT);
    CREATE TABLE usuario(id INTEGER PRIMARY KEY, nombre TEXT, rol_id INTEGER);
    CREATE TABLE predio_comando(id INTEGER PRIMARY KEY AUTOINCREMENT, predio_id INTEGER, tipo TEXT, metodo TEXT, ruta TEXT,
      cuerpo TEXT, query TEXT, actor TEXT, descripcion TEXT, creado_por INTEGER, estado TEXT DEFAULT 'PENDIENTE', status INTEGER, resultado TEXT);
    CREATE TABLE predio_acceso_sesion(id TEXT PRIMARY KEY, predio_id INTEGER, usuario_id INTEGER, refresh_hash TEXT, refresh_anterior_hash TEXT,
      password_version TEXT, creada_en TEXT DEFAULT (datetime('now')), ultimo_uso TEXT, gracia_hasta TEXT, vence_en TEXT, revocado_en TEXT);
    INSERT INTO predio(id,codigo,nombre,escritor) VALUES(1,'MIRAMAR','Camping Miramar','${escritor}'),(2,'PARADOR','Parador','LOCAL');
    INSERT INTO usuario VALUES(7,'Administrador general con mismo ID',1);
    INSERT INTO predio_boca(predio_id,id,nombre,activo) VALUES(1,1,'Boca propia',1),(2,1,'Boca ajena',1);`);
  const hash = U.hashPassword("clave-fixture");
  db.conexion.prepare("INSERT INTO predio_usuario(predio_id,id,usuario,nombre,rol,activo,es_admin_general,password_hash) VALUES(1,7,'adminlocal','Admin propio', 'ADMIN',1,0,?),(1,8,'otroadmin','Otro local','ADMIN',1,0,?),(2,7,'adminlocal','Admin ajeno','ADMIN',1,0,?)").run(hash, hash, hash);
  await emitirAviso(db, { pid: 1 }, { tipo: "ACCESO_FALLIDO", usuarioId: 7, titulo: "Propio", mensaje: "Privado del administrador local" });
  await emitirAviso(db, { pid: 1 }, { tipo: "ACCESO_FALLIDO", usuarioId: 8, titulo: "De otro", mensaje: "No pertenece al que ingresó" });
  await emitirAviso(db, { pid: 2 }, { tipo: "ACCESO_FALLIDO", usuarioId: 7, titulo: "Otro predio", mensaje: "Mismo ID, diferente predio" });
  let antesTransaccion = null;
  const consultas = [];
  function query(sql, params = []) {
    consultas.push(sql);
    if (/CREATE TABLE IF NOT EXISTS predio_acceso_sesion/i.test(sql)) return [{ affectedRows: 0 }];
    const portable = sql.replace(/ FOR UPDATE\b/g, "").replace(/DATE_ADD\(NOW\(6\), INTERVAL (\d+) (HOUR|SECOND|DAY)\)/g, (_m, n, u) => `datetime('now','+${n} ${u.toLowerCase()}s')`)
      .replace(/NOW\(6\)|NOW\(\)/g, "datetime('now')").replace(/INSERT IGNORE/g, "INSERT OR IGNORE");
    const statement = db.conexion.prepare(portable), argumentos = params.map(p => p === undefined ? null : p);
    if (/^\s*SELECT/i.test(sql)) return [statement.all(...argumentos).map(r => ({ ...r }))];
    const r = statement.run(...argumentos); return [{ insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) }];
  }
  let cola = Promise.resolve();
  poolActual = { async query(sql, params) { return query(sql, params); }, async getConnection() {
    let liberar; const anterior = cola; cola = new Promise(resolve => { liberar = resolve; });
    return { query: async (sql, params) => query(sql, params),
      async beginTransaction() { await anterior; if (antesTransaccion) { const fn = antesTransaccion; antesTransaccion = null; await fn(); } db.exec("BEGIN IMMEDIATE"); },
      async commit() { db.exec("COMMIT"); }, async rollback() { db.exec("ROLLBACK"); }, release() { liberar(); } };
  } };
  const app = express(); app.use(express.json()); app.use("/api", crearRouterCuenta()); app.use("/app", crearRouterApp()); app.use("/api", crearRouterAdmin());
  const servidor = app.listen(0, "127.0.0.1"); await once(servidor, "listening");
  t.after(async () => { servidor.closeAllConnections?.(); await new Promise(resolve => servidor.close(resolve)); db.cerrar(); });
  const url = `http://127.0.0.1:${servidor.address().port}`;
  return { db, hash, url, consultas, pool: poolActual, antesTx: fn => { antesTransaccion = fn; } };
}

async function ingresar(s) {
  return A.ingresarPredio({ db: s.pool, identificador: "adminlocal", predioCodigo: "MIRAMAR", password: "clave-fixture", jwtSecret: SECRET });
}
function pedir(s, token, ruta, cuerpo) {
  return fetch(s.url + ruta, { method: cuerpo === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }) });
}

test("la cuenta propia abre exclusivamente su predio y conserva su identidad local aunque colisione con un admin general", async t => {
  const s = await escenario(t), { token } = await ingresar(s);
  const permisos = await pedir(s, token, "/api/predios-cuenta/permisos"); assert.equal(permisos.status, 200);
  const datos = await permisos.json(); assert.equal(datos.id, 7); assert.equal(datos.predio_id, 1); assert.equal(datos.rol, "predio_admin");
  assert.equal(JSON.stringify(datos).includes("password"), false);
  const acceso = await pedir(s, token, "/api/predios-cuenta/acceso", {}); assert.equal(acceso.status, 200);
  assert.deepEqual(await acceso.json(), { token, ruta: "/predios-app/MIRAMAR/" });
  assert.equal((await pedir(s, token, "/api/predios-cuenta/acceso", { codigo: "PARADOR" })).status, 403);
  assert.equal((await pedir(s, token, "/app/PARADOR/api/sesion")).status, 403);
  const sesion = await pedir(s, token, "/app/MIRAMAR/api/sesion"); assert.equal(sesion.status, 200);
  const contexto = (await sesion.json()).usuario;
  assert.equal(contexto.id, 7); assert.equal(contexto.es_admin_general, false); assert.equal(contexto.nombre, "Admin propio");
  assert.deepEqual(contexto.bocas, [1]);
  assert.equal((await pedir(s, token, "/api/predios")).status, 401, "la clave derivada no concede administración general");
  assert.throws(() => jwt.verify(token, SECRET));
});

test("la campana remota usa predio e identidad local y no confunde avisos de otro usuario o predio", async t => {
  const s = await escenario(t), { token } = await ingresar(s);
  const r = await pedir(s, token, "/app/MIRAMAR/api/avisos/historial"); assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).filas.map(a => a.titulo), ["Propio"]);
});

test("cerrar desde el iframe revoca sólo su sesión propia y el token deja de acreditar permisos", async t => {
  const s = await escenario(t), { token } = await ingresar(s), otra = await ingresar(s);
  s.db.exec("CREATE TABLE auth_sesion(id TEXT PRIMARY KEY,usuario_id INTEGER,revocado_en TEXT); INSERT INTO auth_sesion VALUES('general-vigente',7,NULL)");
  const r = await pedir(s, token, "/app/MIRAMAR/api/logout", {});
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  assert.equal((await pedir(s, token, "/api/predios-cuenta/permisos")).status, 401);
  assert.equal((await pedir(s, otra.token, "/api/predios-cuenta/permisos")).status, 200);
  assert.equal(s.db.conexion.prepare("SELECT COUNT(*) n FROM predio_acceso_sesion WHERE revocado_en IS NOT NULL").get().n, 1);
  assert.equal(s.db.conexion.prepare("SELECT revocado_en FROM auth_sesion WHERE id='general-vigente'").get().revocado_en, null);
});

test("una escritura propia crea orden con actor local, credencial y revisión, sin creado_por general ni usuario artificial", async t => {
  const s = await escenario(t), { token } = await ingresar(s);
  const r = await pedir(s, token, "/app/MIRAMAR/api/proveedores", { razon_social: "Proveedor remoto" });
  assert.equal(r.status, 202);
  const fila = s.db.conexion.prepare("SELECT * FROM predio_comando").get(), actor = JSON.parse(fila.actor);
  assert.deepEqual(actor, { tipo: "PREDIO", predio_id: 1, predio_usuario_id: 7, credencial_sha256: U.sha256(s.hash), cuenta_revision: 0 });
  assert.equal(fila.creado_por, null); assert.equal(fila.predio_id, 1);
  assert.equal(s.db.conexion.prepare("SELECT COUNT(*) n FROM predio_usuario WHERE es_admin_general=1").get().n, 0);
  assert.equal(s.db.conexion.prepare("SELECT COUNT(*) n FROM usuario").get().n, 1);
});

test("si la clave cambia entre autenticar y encolar, la revalidación transaccional no atribuye la clave nueva al token viejo", async t => {
  const s = await escenario(t), { token } = await ingresar(s);
  s.antesTx(() => s.db.conexion.prepare("UPDATE predio_usuario SET password_hash=? WHERE predio_id=1 AND id=7").run(U.hashPassword("clave-nueva")));
  const r = await pedir(s, token, "/app/MIRAMAR/api/proveedores", { razon_social: "No debe encolarse" });
  assert.equal(r.status, 401);
  assert.equal(s.db.conexion.prepare("SELECT COUNT(*) n FROM predio_comando").get().n, 0);
});

test("cuando CENTRAL es dueño ejecuta con el usuario local real y audita sin convertirlo en administrador general", async t => {
  const s = await escenario(t, { escritor: "CENTRAL" }), { token } = await ingresar(s);
  const r = await pedir(s, token, "/app/MIRAMAR/api/proveedores", { razon_social: "Proveedor central propio" });
  assert.equal(r.status, 200);
  assert.equal(s.db.conexion.prepare("SELECT razon_social FROM predio_proveedor WHERE predio_id=1").get().razon_social, "Proveedor central propio");
  const auditoria = s.db.conexion.prepare("SELECT usuario_id,usuario_nombre,origen FROM predio_auditoria WHERE entidad='proveedor'").get();
  assert.equal(auditoria.usuario_id, 7); assert.equal(auditoria.usuario_nombre, "Admin propio"); assert.equal(auditoria.origen, "REMOTO");
  assert.equal(s.db.conexion.prepare("SELECT COUNT(*) n FROM predio_usuario WHERE es_admin_general=1").get().n, 0);
});

test("el paquete de pendrive nunca lleva actores PREDIO, incluso si incluye una actualización de código", async t => {
  const s = await escenario(t), C = require("../api/services/predios-central");
  s.db.exec("CREATE TABLE rol(id INTEGER PRIMARY KEY,nombre TEXT); INSERT INTO rol VALUES(1,'admin'); CREATE TABLE predio_evento(id INTEGER PRIMARY KEY,predio_id INTEGER,tipo TEXT,detalle TEXT,usuario_id INTEGER)");
  for (const columna of ["apellido TEXT", "documento TEXT", "departamental_id INTEGER", "habilitado TEXT DEFAULT 'S'", "password TEXT", "auth_revocado_desde TEXT",
    "area_turismo INTEGER", "area_coseguro INTEGER", "modulo_turismo INTEGER", "modulo_coseguro INTEGER", "modulo_olimpiadas INTEGER", "bloqueo_tipo TEXT", "bloqueo_modulos TEXT", "bloqueo_mensaje TEXT", "requiere_cambio_clave INTEGER", "es_familiar TEXT", "usuario_familiar_id INTEGER"]) s.db.exec("ALTER TABLE usuario ADD COLUMN " + columna);
  s.db.conexion.prepare("INSERT INTO predio_comando(predio_id,tipo,metodo,ruta,actor) VALUES(1,'API','POST','/proveedores',?),(1,'API','POST','/proveedores',?)")
    .run(JSON.stringify({ tipo: "PREDIO", predio_id: 1, predio_usuario_id: 7 }), JSON.stringify({ general_id: 7, nombre: "General" }));
  t.mock.method(C, "armarMaestros", async () => ({}));
  t.mock.method(C, "paqueteCodigo", () => ({ buffer: Buffer.from("código firmado de fixture"), version: "fixture" }));
  t.mock.method(C, "paqueteFirmado", datos => Buffer.from(JSON.stringify(datos)));
  const token = jwt.sign({ data: JSON.stringify({ id: 7 }) }, SECRET, { expiresIn: "5m" });
  for (const conCodigo of ["0", "1"]) {
    const r = await pedir(s, token, "/api/predios/MIRAMAR/paquete?codigo=" + conCodigo); assert.equal(r.status, 200);
    const paquete = await r.json();
    assert.equal(paquete.comandos.length, 1); assert.equal(paquete.comandos[0].actor.general_id, 7);
    assert.equal(paquete.comandos.some(c => c.actor.tipo === "PREDIO"), false);
    assert.equal(!!paquete.codigo, conCodigo === "1");
  }
  assert.equal(s.db.conexion.prepare("SELECT estado FROM predio_comando WHERE id=1").get().estado, "PENDIENTE", "la orden propia espera un agente actualizado");
});
