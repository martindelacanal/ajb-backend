"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { once } = require("node:events");
const { crearSqlite, asegurarEsquema } = require("../predios/lib/db-sqlite");
const U = require("../predios/lib/util");
const SECRET = "signin-predios-fixture-sin-secretos-reales";
process.env.JWT_SECRET = SECRET;
let actual;
const proxy = { query: (...a) => actual.query(...a), getConnection: (...a) => actual.getConnection(...a) };
const archivoConexion = require.resolve("../api/connection/connection");
require.cache[archivoConexion] = { id: archivoConexion, filename: archivoConexion, loaded: true, exports: {
  promise: () => proxy,
  query(sql, params, callback) { Promise.resolve().then(() => actual.query(sql, params)).then(([filas]) => callback(null, filas, []), e => callback(e)); },
} };
const usuarios = require("../api/routes/user");
const { crearRouterAuth } = require("../api/routes/auth");
const { crearRouterApp } = require("../api/routes/predios");

async function escenario(t) {
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db);
  db.exec(`CREATE TABLE rol(id INTEGER PRIMARY KEY,nombre TEXT); INSERT INTO rol VALUES(1,'admin');
    CREATE TABLE usuario(id INTEGER PRIMARY KEY,nombre TEXT,apellido TEXT,documento TEXT,email TEXT,password TEXT,departamental_id INTEGER,rol_id INTEGER,habilitado TEXT,
      area_turismo INTEGER,area_coseguro INTEGER,modulo_turismo INTEGER,modulo_coseguro INTEGER,modulo_olimpiadas INTEGER,es_familiar TEXT,usuario_familiar_id INTEGER,
      bloqueo_tipo TEXT,bloqueo_modulos TEXT,bloqueo_mensaje TEXT,requiere_cambio_clave INTEGER,auth_revocado_desde TEXT,primer_ingreso TEXT,ultimo_ingreso TEXT);
    CREATE TABLE predio(id INTEGER PRIMARY KEY,codigo TEXT,nombre TEXT,activo INTEGER DEFAULT 1,escritor TEXT DEFAULT 'LOCAL',ultima_conexion TEXT,ultimo_push TEXT,equipo TEXT,version_local TEXT,pendientes_local INTEGER);
    INSERT INTO predio(id,codigo,nombre) VALUES(1,'MIRAMAR','Camping Miramar'),(2,'PARADOR','Parador');
    CREATE TABLE predio_acceso_sesion(id TEXT PRIMARY KEY,predio_id INTEGER,usuario_id INTEGER,refresh_hash TEXT,refresh_anterior_hash TEXT,password_version TEXT,
      creada_en TEXT DEFAULT (datetime('now')),ultimo_uso TEXT,gracia_hasta TEXT,vence_en TEXT,revocado_en TEXT);
    CREATE TABLE auth_sesion(id TEXT PRIMARY KEY,usuario_id INTEGER,refresh_hash TEXT,refresh_anterior_hash TEXT,password_version TEXT,
      creada_en TEXT DEFAULT (datetime('now')),ultimo_uso TEXT,gracia_hasta TEXT,vence_en TEXT,revocado_en TEXT);
    CREATE TABLE predio_comando(id INTEGER PRIMARY KEY,predio_id INTEGER,tipo TEXT,estado TEXT);`);
  const generalHash = bcrypt.hashSync("clave-general", 4), localHash = U.hashPassword("clave-predio");
  db.conexion.prepare("INSERT INTO usuario(id,nombre,apellido,documento,password,rol_id,habilitado) VALUES(7,'Admin','General','45678901',?,1,'S')").run(generalHash);
  const insertar = db.conexion.prepare("INSERT INTO predio_usuario(predio_id,id,usuario,nombre,rol,activo,es_admin_general,password_hash) VALUES(?,?,?,?,'ADMIN',1,0,?)");
  for (const [pid,id,nombre] of [[1,7,"propio"],[1,8,"45678901"],[1,9,"76543210"],[1,10,"compartido"],[2,10,"compartido"]]) insertar.run(pid,id,nombre,"Admin de " + nombre,localHash);
  const consultas = [];
  function query(sql, params = []) {
    consultas.push(sql);
    const portable = sql.replace(/ FOR UPDATE\b/g, "").replace(/DATE_ADD\(NOW\(6\), INTERVAL (\d+) (HOUR|SECOND|DAY)\)/g, (_m,n,u) => `datetime('now','+${n} ${u.toLowerCase()}s')`).replace(/NOW\(6\)|NOW\(\)/g, "datetime('now')");
    const st = db.conexion.prepare(portable), p = params.map(v => v === undefined ? null : v);
    if (/^\s*SELECT/i.test(sql)) return [st.all(...p).map(r => ({ ...r }))];
    const r = st.run(...p); return [{ insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) }];
  }
  let cola = Promise.resolve();
  actual = { async query(sql, params) { return query(sql,params); }, async getConnection() {
    let liberar; const espera = cola; cola = new Promise(resolve => { liberar = resolve; });
    return { query: async (sql,params) => query(sql,params), async beginTransaction() { await espera; db.exec("BEGIN IMMEDIATE"); },
      async commit() { db.exec("COMMIT"); },async rollback() { db.exec("ROLLBACK"); },release() { liberar(); } };
  } };
  const app = express(); app.use(express.json()); app.use("/api", crearRouterAuth({ db: proxy, jwtSecret: SECRET, enviar: async () => {} })); app.use("/api", usuarios); app.use("/app", crearRouterApp());
  const servidor = app.listen(0,"127.0.0.1"); await once(servidor,"listening");
  t.after(async () => { servidor.closeAllConnections?.(); await new Promise(resolve => servidor.close(resolve)); db.cerrar(); });
  const url = `http://127.0.0.1:${servidor.address().port}`;
  async function post(ruta,cuerpo,token) {
    const r = await fetch(url+ruta,{method:"POST",headers:{"Content-Type":"application/json",...(token ? {Authorization:`Bearer ${token}`} : {})},body:JSON.stringify(cuerpo)});
    const text = await r.text(); return {status:r.status,body:text ? JSON.parse(text) : null};
  }
  return {db,consultas,post,url,signin:(documento,password="clave-predio",extra={})=>post("/api/signin",{documento,password,...extra}),
    cuenta: tabla => db.conexion.prepare(`SELECT COUNT(*) n FROM ${tabla}`).get().n};
}

test("/signin acepta usuario propio con sesión separada sin crear usuario general ni auth_sesion",async t=>{
  const s=await escenario(t),r=await s.signin("propio");
  assert.equal(r.status,200);assert.equal(r.body.data.rol,"predio_admin");assert.equal(r.body.data.predio_id,1);
  assert.throws(()=>jwt.verify(r.body.token,SECRET));
  assert.equal(s.cuenta("predio_acceso_sesion"),1);assert.equal(s.cuenta("auth_sesion"),0);assert.equal(s.cuenta("usuario"),1);
});

test("un DNI general con clave válida conserva identidad y sesión habituales",async t=>{
  const s=await escenario(t),r=await s.signin("45678901","clave-general");
  assert.equal(r.status,200);assert.equal(r.body.data.rol,"admin");assert.equal(r.body.data.id,7);assert.equal(r.body.data.acceso_predio,undefined);
  assert.ok(jwt.verify(r.body.token,SECRET).sid);assert.equal(s.cuenta("auth_sesion"),1);assert.equal(s.cuenta("predio_acceso_sesion"),0);
});

test("un DNI general con clave incorrecta jamás cambia a la cuenta local homónima aunque esa clave local coincida",async t=>{
  const s=await escenario(t),r=await s.signin("45678901","clave-predio");
  assert.equal(r.status,401);assert.equal(s.cuenta("auth_sesion"),0);assert.equal(s.cuenta("predio_acceso_sesion"),0);
  assert.equal(s.consultas.some(sql=>/SELECT DISTINCT u.id, u.predio_id/.test(sql)),false,"no consulta el fallback local");
});

test("un identificador numérico sin cuenta general elegible puede usar su cuenta propia del predio",async t=>{
  const s=await escenario(t),r=await s.signin("76543210");
  assert.equal(r.status,200);assert.equal(r.body.data.usuario,"76543210");assert.equal(r.body.data.predio_id,1);
  assert.equal(s.cuenta("auth_sesion"),0);assert.equal(s.cuenta("usuario"),1);
});

test("el usuario homónimo pide selector y después sólo entra al predio elegido",async t=>{
  const s=await escenario(t),ambiguo=await s.signin("compartido");
  assert.equal(ambiguo.status,409);assert.equal(ambiguo.body.codigo,"PREDIO_REQUERIDO");
  assert.deepEqual(ambiguo.body.predios.map(p=>p.codigo),["MIRAMAR","PARADOR"]);assert.equal(s.cuenta("predio_acceso_sesion"),0);
  const r=await s.signin("compartido","clave-predio",{predio:"PARADOR"});assert.equal(r.status,200);assert.equal(r.body.data.predio_id,2);
  const ajeno=await fetch(s.url+"/app/MIRAMAR/api/sesion",{headers:{Authorization:`Bearer ${r.body.token}`}});assert.equal(ajeno.status,403);
});

test("las credenciales inválidas responden 400/401 sin hashes, tokens ni datos de cuentas",async t=>{
  const s=await escenario(t);
  for(const body of [{documento:"",password:"x"},{documento:"<usuario>",password:"x"},{documento:"propio",password:17},{documento:"a".repeat(61),password:"x"}]){
    const r=await s.post("/api/signin",body);assert.equal(r.status,400);assert.equal(JSON.stringify(r.body).includes("scrypt$"),false);
  }
  const r=await s.signin("propio","incorrecta");assert.equal(r.status,401);assert.equal(r.body.predios,undefined);assert.equal(r.body.token,undefined);
  assert.equal(s.cuenta("predio_acceso_sesion"),0);assert.equal(s.cuenta("usuario"),1);
});

test("renovar y cerrar la sesión con prefijo predio usan su tabla y revocan también el token del iframe",async t=>{
  const s=await escenario(t),ingreso=await s.signin("propio","clave-predio",{recordar:true});
  assert.equal(ingreso.status,200);assert.match(ingreso.body.refreshToken,/^predio\./);
  const renovada=await s.post("/api/sesion/renovar",{refreshToken:ingreso.body.refreshToken});assert.equal(renovada.status,200);assert.match(renovada.body.refreshToken,/^predio\./);
  const consultar=()=>fetch(s.url+"/app/MIRAMAR/api/sesion",{headers:{Authorization:`Bearer ${renovada.body.token}`}});
  assert.equal((await consultar()).status,200);
  assert.equal((await s.post("/api/sesion/cerrar",{refreshToken:renovada.body.refreshToken})).status,204);
  assert.equal((await consultar()).status,401);
  const otra=await s.post("/api/sesion/renovar",{refreshToken:renovada.body.refreshToken});assert.equal(otra.status,401);assert.equal(otra.body.code,"SESSION_REVOKED");
  assert.equal(s.consultas.some(sql=>/\bauth_sesion\b/.test(sql)),false,"no consulta ni modifica sesiones generales");
  assert.equal(s.cuenta("usuario"),1);assert.equal(s.cuenta("auth_sesion"),0);assert.equal(s.cuenta("predio_acceso_sesion"),1);
});
