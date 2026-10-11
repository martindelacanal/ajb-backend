'use strict';
// Base aislada: solo se copian estructuras; nunca datos de personas.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const base = root;
const helpers = require(path.join(base, 'scripts/migrar-catalogo-turismo-v1'));
const mysql = require(path.join(base, 'node_modules/mysql2/promise'));
const bcrypt = require(path.join(base, 'node_modules/bcryptjs'));
const config = helpers.parsearBloquesEnv(fs.readFileSync(path.join(base, '.env'), 'utf8')).develop;
assert.ok(['localhost', '127.0.0.1'].includes(config.DB_HOST));
const schema = 'ajb_test_bloqueos_' + Date.now();
const options = helpers.crearOpcionesConexion(config, 'develop');
const password = 'Prueba local AJB 2026';
const checks = [];
const messages = [];
let admin, db, server, origin, runtimePool;
async function call(route, body, token, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + route, {method, headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
  const raw = await response.text(); let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return {status: response.status, data};
}
async function login(id, clave = password) {
  const response = await call('/signin', {documento: 99000000 + id, password: clave, recordar: true});
  assert.equal(response.status, 200, JSON.stringify(response));
  return response.data;
}
async function cleanup() {
  if (server) await new Promise(resolve => server.close(resolve));
  if (runtimePool) await runtimePool.end();
  if (db) await db.end();
  if (admin) {
    assert.match(schema, /^ajb_test_bloqueos_\d+$/);
    await admin.query('DROP DATABASE ' + admin.escapeId(schema));
    await admin.end();
  }
}
async function setup() {
  admin = await mysql.createConnection(options);
  await admin.query('CREATE DATABASE ' + admin.escapeId(schema));
  db = mysql.createPool({...options, database: schema, connectionLimit: 8});
  db.on('connection', c => c.query("SET SESSION time_zone='-03:00'"));
  const [tables] = await admin.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE=\'BASE TABLE\'', [config.DB_DATABASE]);
  for (const {TABLE_NAME: table} of tables) await db.query('CREATE TABLE ' + db.escapeId(table) + ' LIKE ' + db.escapeId(config.DB_DATABASE) + '.' + db.escapeId(table));
  await db.query("INSERT INTO rol(id,nombre) VALUES (1,'admin'),(2,'afiliado'),(3,'departamental'),(4,'invitado'),(5,'admin-central'),(6,'auditor'),(7,'prensa')");
  await db.query("INSERT INTO departamental(id,nombre) VALUES (1,'Departamental de prueba'),(2,'Otra departamental')");
  const hash = await bcrypt.hash(password, 10);
  const fixtures = [[1,1,1,'Administración'],[2,2,1,'Afiliada'],[3,3,1,'Departamental'],[4,2,2,'Afiliado externo'],[5,5,1,'Central'],[6,4,1,'Invitado'],[7,6,1,'Auditor'],[8,2,1,'Afiliada sin correo'],[9,4,1,'Familiar']];
  for (const [id,rol,dep,nombre] of fixtures) await db.query(`INSERT INTO usuario(id,rol_id,departamental_id,nombre,apellido,documento,email,password,habilitado,modulo_turismo,modulo_coseguro,modulo_olimpiadas,area_turismo,area_coseguro,es_familiar,usuario_familiar_id)
    VALUES(?,?,?,?,'Prueba local',?,?,?,'Y',1,1,1,1,1,?,?)`, [id,rol,dep,nombre,99000000+id,id===8?null:`qa-accesos-${id}@example.invalid`,hash,id===9?'S':'N',id===9?2:null]);
  Object.assign(process.env, config, {DB_DATABASE:schema,JWT_SECRET:crypto.randomBytes(64).toString('hex'),NODE_ENV:'test',MAIL_ENABLED:'false',AWS_REGION:'sa-east-1',BUCKET_NAME:'qa-no-usado',CORS_ORIGINS:'http://localhost:4200,http://127.0.0.1:4200'});
  const correo = require(path.join(base, 'api/services/correo'));
  correo.enviarCorreoPlantilla = async value => {messages.push(value); return {enviado: true};};
  const connection = await db.getConnection();
  try {
    await require(path.join(base, 'scripts/migrar-auth-v1')).aplicarMigracion(connection);
    const migration = require(path.join(base, 'scripts/migrar-acceso-usuarios-v1'));
    await migration.aplicarMigracion(connection);
    await migration.aplicarMigracion(connection);
  } finally { connection.release(); }
  checks.push('Migración idempotente en MySQL real');
  const app = require(path.join(base, 'app'));
  runtimePool = require(path.join(base, 'api/connection/connection')).promise();
  server = await new Promise(resolve => {const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  origin = 'http://127.0.0.1:' + server.address().port + '/api';
}
async function verify() {
  const central = await login(5), administrador = await login(1), departamental = await login(3), afiliado = await login(2), familiar = await login(9);
  const partial = {tipo:'modulos',modulos:['turismo','coseguro'],mensaje:''};
  for (const target of [1,3,4,5,6,7]) assert.equal((await call(`/usuarios/${target}/bloqueo`,partial,departamental.token,'PATCH')).status,403,'Departamental no debe bloquear cuenta '+target);
  assert.equal((await call('/usuarios/1/bloqueo',{tipo:'total'},administrador.token,'PATCH')).status,403);
  assert.equal((await call('/usuarios/2/bloqueo',partial,afiliado.token,'PATCH')).status,403);
  checks.push('Permisos: departamental solo afiliados propios, sin auto bloqueo ni escalada');
  let result=await call('/usuarios/2/bloqueo',partial,departamental.token,'PATCH'); assert.equal(result.status,200,JSON.stringify(result));
  let permisos=await call('/sesion/permisos',undefined,afiliado.token); assert.equal(permisos.status,200); assert.equal(permisos.data.bloqueo.tipo,'modulos'); assert.ok(permisos.data.bloqueo.mensaje.length>10);
  for(const route of ['/reserva','/coseguro/solicitudes']) {
    result=await call(route,{},afiliado.token); assert.equal(result.status,403,JSON.stringify({route,...result})); assert.equal(result.data.code,'MODULE_BLOCKED');
  }
  result=await call('/reserva',{},familiar.token);assert.equal(result.status,403);assert.equal(result.data.code,'MODULE_BLOCKED');
  checks.push('Restricción inmediata de acciones y herencia familiar; lectura y mensaje por defecto disponibles');
  const relogin=await login(2);assert.equal(relogin.data.bloqueo.tipo,'modulos');
  result=await call('/usuarios/2/bloqueo',{tipo:'total',mensaje:'Comunicate con tu departamental.'},administrador.token,'PATCH');assert.equal(result.status,200);
  result=await call('/sesion/permisos',undefined,afiliado.token);assert.equal(result.status,403);assert.equal(result.data.code,'ACCOUNT_BLOCKED');
  result=await call('/signin',{documento:99000002,password});assert.equal(result.status,403);assert.equal(result.data.code,'ACCOUNT_BLOCKED');assert.equal(result.data.mensaje,'Comunicate con tu departamental.');
  result=await call('/sesion/renovar',{refreshToken:relogin.refreshToken});assert.equal(result.status,403);assert.equal(result.data.code,'ACCOUNT_BLOCKED');
  result=await call('/usuarios/2/bloqueo',undefined,administrador.token,'DELETE');assert.equal(result.status,200);await login(2);
  checks.push('Bloqueo total en login, sesión y renovación; desbloqueo manual');
  result=await call('/usuarios/7/bloqueo',partial,central.token,'PATCH');assert.equal(result.status,200,JSON.stringify(result));
  result=await call('/tabla/usuarios',{},central.token);assert.equal(result.status,200);assert.ok(result.data.results.some(u=>u.id===7));
  await call('/usuarios/7/bloqueo',undefined,central.token,'DELETE');
  checks.push('Administración central gestiona personal desde el listado');
  for (const target of [1,3,4,5,6,7]) assert.equal((await call(`/usuarios/${target}/reset-password`,{},departamental.token)).status,403);
  result=await call('/usuarios/2/reset-password',{},departamental.token);assert.equal(result.status,200,JSON.stringify(result));
  assert.ok(result.data.passwordTemporal);const temporal=result.data.passwordTemporal;assert.ok(messages.length);
  assert.equal((await call('/sesion/permisos',undefined,relogin.token)).status,401);
  const resetLogin=await login(2,temporal);assert.equal(resetLogin.data.requiere_cambio_clave,true);
  result=await call('/tabla/usuarios',{},resetLogin.token);assert.equal(result.status,403);assert.equal(result.data.code,'PASSWORD_CHANGE_REQUIRED');
  result=await call('/auth/password/cambiar-obligatoria',{passwordActual:temporal,password:'Nueva clave segura AJB 2026'},resetLogin.token);assert.equal(result.status,200,JSON.stringify(result));
  const newLogin=await login(2,'Nueva clave segura AJB 2026');assert.equal(newLogin.data.requiere_cambio_clave,false);
  assert.equal((await call('/signin',{documento:99000002,password:temporal})).status,401);
  checks.push('Reset departamental, correo, clave temporal, revocación y cambio obligatorio');
  console.log(JSON.stringify({ok:true,checks},null,2));
}
(async()=>{
  try {
    await setup();await verify();

  }catch(error){console.error(error);process.exitCode=1;}
  await cleanup();
})();
