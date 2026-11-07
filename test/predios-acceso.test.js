"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { DatabaseSync } = require("node:sqlite");
const { hashPassword } = require("../predios/lib/util");
const servicio = require("../api/security/predios-acceso");
const migracion = require("../scripts/migrar-predios-acceso");
const secreto = "predios-acceso-pruebas-dominio-separado";
const clave = "Clave propia del camping 2026";
const hash = hashPassword(clave);
const firma = crypto.createHmac("sha256", secreto).update("ajb:predios:cuentas:v1").digest();

// El servicio usa el contrato mysql2. La base real de estas pruebas ejecuta los
// filtros, scopes y persistencia; sólo se adapta el dialecto de fecha y locks.
function crearCaso(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE predio (id INTEGER PRIMARY KEY,codigo TEXT UNIQUE,nombre TEXT,activo INTEGER);
    CREATE TABLE predio_usuario (predio_id INTEGER,id INTEGER,usuario TEXT,nombre TEXT,rol TEXT,activo INTEGER,
      es_admin_general INTEGER,password_hash TEXT,documento TEXT,debe_cambiar_clave INTEGER DEFAULT 0,PRIMARY KEY(predio_id,id));
    CREATE TABLE predio_auditoria (predio_id INTEGER,id INTEGER,entidad TEXT,entidad_id INTEGER,PRIMARY KEY(predio_id,id));
    CREATE TABLE predio_acceso_sesion (id TEXT PRIMARY KEY,predio_id INTEGER,usuario_id INTEGER,refresh_hash TEXT UNIQUE,
      refresh_anterior_hash TEXT,password_version TEXT,creada_en TEXT DEFAULT CURRENT_TIMESTAMP,ultimo_uso TEXT,
      gracia_hasta TEXT,vence_en TEXT,revocado_en TEXT);
    INSERT INTO predio VALUES(1,'MIRAMAR','Camping Miramar',1),(2,'PARADOR','Parador de la Montaña',1),(3,'INACTIVO','Predio inactivo',0);`);
  let ahora = new Date(), cola = Promise.resolve();
  const consultas = [];
  function fecha() { return ahora.toISOString().replace("T", " ").slice(0, 19); }
  async function query(sql, parametros = []) {
    consultas.push(sql);
    const adaptado = sql.replace(/\s+FOR UPDATE\b/gi, "")
      .replace(/DATE_ADD\(NOW\(6\), INTERVAL (\d+) (HOUR|SECOND)\)/gi, (_, n, unidad) => `datetime('${fecha()}','+${n} ${unidad.toLowerCase()}')`)
      .replace(/NOW\(6\)/gi, `'${fecha()}'`);
    const preparado = sqlite.prepare(adaptado);
    if (/^\s*SELECT/i.test(adaptado)) return [preparado.all(...parametros).map((fila) => ({ ...fila }))];
    return [{ affectedRows: preparado.run(...parametros).changes }];
  }
  const db = { query, getConnection: async () => {
    let liberar;
    return { query, beginTransaction: async () => {
      const previa = cola; cola = new Promise((resolve) => { liberar = resolve; }); await previa; sqlite.exec("BEGIN IMMEDIATE");
    }, commit: async () => { sqlite.exec("COMMIT"); liberar(); }, rollback: async () => { if (sqlite.isTransaction) sqlite.exec("ROLLBACK"); liberar?.(); }, release() {} };
  } };
  function usuario(predioId = 1, id = 1, cambios = {}) {
    const u = { usuario: "administrador", nombre: "Ana", rol: "ADMIN", activo: 1, es_admin_general: 0, password_hash: hash, documento: "32.123.456", ...cambios };
    sqlite.prepare("INSERT INTO predio_usuario VALUES(?,?,?,?,?,?,?,?,?,?)").run(predioId, id, u.usuario, u.nombre, u.rol, u.activo, u.es_admin_general, u.password_hash, u.documento, u.debe_cambiar_clave || 0);
  }
  usuario();
  return { db, sqlite, consultas, usuario, avanzar: (ms) => { ahora = new Date(ahora.getTime() + ms); },
    login: (extra = {}) => servicio.ingresarPredio({ db, identificador: "administrador", password: clave, jwtSecret: secreto, ...extra }),
    auth: (token, extra = {}) => servicio.autenticarCuentaPredio({ db, token, jwtSecret: secreto, ...extra }),
    refresh: (refreshToken) => servicio.renovarSesionPredio({ db, refreshToken, jwtSecret: secreto }) };
}

test("login de cuenta local firma un alcance privado y reconstruye los datos desde la base", async (t) => {
  const c = crearCaso(t), r = await c.login({ identificador: "  ADMINISTRADOR  ", recordar: true });
  assert.match(r.refreshToken, /^predio\.[A-Za-z0-9_-]{43}$/);
  const p = jwt.verify(r.token, firma, { audience: "ajb:predios:cuentas", issuer: "mi-ajb", algorithms: ["HS256"] });
  assert.equal(p.tipo, "predio-cuenta"); assert.equal(p.sub, "1:1"); assert.equal(p.exp - p.iat, 15 * 60);
  assert.equal(JSON.parse(p.data).predio_id, 1);
  assert.equal(r.data.rol, "predio_admin"); assert.equal(r.data.acceso_predio, true);
  for (const f of ["area_turismo", "area_coseguro", "modulo_turismo", "modulo_coseguro", "modulo_olimpiadas"]) assert.equal(r.data[f], 0);
  assert.throws(() => jwt.verify(r.token, secreto), /signature/);
  const sesion = c.sqlite.prepare("SELECT * FROM predio_acceso_sesion").get();
  assert.notEqual(sesion.refresh_hash, r.refreshToken); assert.equal(sesion.refresh_hash.length, 64);
  assert.ok(!JSON.stringify(r).includes(hash)); assert.ok(!JSON.stringify(r.data).includes("password"));
  c.sqlite.prepare("UPDATE predio_usuario SET nombre='Nombre vigente' WHERE predio_id=1 AND id=1").run();
  const actual = await c.auth(r.token, { db: { query: c.db.query } });
  assert.equal(actual.nombre, "Nombre vigente"); assert.equal(actual.sid, p.sid); assert.ok(!("pv" in actual));
  const otro = await c.login(); assert.equal(jwt.decode(otro.token).exp - jwt.decode(otro.token).iat, 8 * 3600); assert.equal(otro.refreshToken, undefined);
  assert.equal((await c.auth(r.token)).id, 1); // Otro login no modifica la época de la cuenta.
});

test("identificador documento se normaliza y una cuenta no se duplica al coincidir también por usuario", async (t) => {
  const c = crearCaso(t);
  c.sqlite.prepare("UPDATE predio_usuario SET usuario='32123456'").run();
  assert.equal((await c.login({ identificador: "32.123.456" })).data.predio_codigo, "MIRAMAR");
  assert.equal((await c.login({ identificador: "32123456" })).data.id, 1);
});

test("mismo usuario en varios predios exige selección sólo después de validar la contraseña", async (t) => {
  const c = crearCaso(t); c.usuario(2); c.usuario(3);
  await assert.rejects(c.login(), (e) => {
    assert.equal(e.statusCode, 409); assert.equal(e.code, "PREDIO_REQUERIDO");
    assert.deepEqual(e.predios, [{ codigo: "MIRAMAR", nombre: "Camping Miramar" }, { codigo: "PARADOR", nombre: "Parador de la Montaña" }]); return true;
  });
  await assert.rejects(c.login({ password: "incorrecta" }), (e) => e.statusCode === 401 && !e.predios);
  const elegido = await c.login({ predioCodigo: "parador", recordar: true });
  assert.equal(elegido.data.predio_id, 2); assert.equal(jwt.decode(elegido.token).sub, "2:1");
  assert.equal((await c.auth(elegido.token)).predio_id, 2);
  await assert.rejects(c.login({ predioCodigo: "no_existe" }), { statusCode: 401 });
});

test("la lista de selección contiene sólo predios cuya cuenta validó la contraseña", async (t) => {
  const c = crearCaso(t); c.usuario(2, 1, { password_hash: hashPassword("Otra contraseña") });
  assert.equal((await c.login()).data.predio_id, 1);
  for (const cambios of [{ rol: "CAJERO" }, { activo: 0 }, { es_admin_general: 1 }, { password_hash: "scrypt$2$invalido$" }]) {
    c.sqlite.prepare("DELETE FROM predio_usuario WHERE predio_id=2").run(); c.usuario(2, 1, cambios);
    await assert.rejects(c.login({ predioCodigo: "PARADOR" }), { statusCode: 401 });
  }
});

test("candidatos e identificadores están limitados sin revelar datos", async (t) => {
  const c = crearCaso(t);
  for (let id = 2; id <= 21; id++) c.usuario(1, id);
  await assert.rejects(c.login(), (e) => e.statusCode === 401 && !e.predios);
  for (const identificador of ["", " ", "a".repeat(61), 123, null]) await assert.rejects(c.login({ identificador }), { statusCode: 401 });
  for (const password of ["", "p".repeat(1025), null]) await assert.rejects(c.login({ password }), { statusCode: 401 });
});

test("firma, audiencia, emisor, tipo, sid y sub se verifican antes de consultar la cuenta", async (t) => {
  const c = crearCaso(t), r = await c.login(), p = jwt.decode(r.token);
  assert.equal(servicio.esTokenPredio(r.token), true); assert.equal(servicio.esTokenPredio("inválido"), false);
  const emitir = (cambio, secret = firma, algoritmo = "HS256") => jwt.sign({ ...p, ...cambio }, secret, { algorithm: algoritmo });
  for (const token of [emitir({}, secreto), emitir({ aud: "sistema-general" }), emitir({ iss: "otro" }), emitir({ tipo: "general" }),
    emitir({ sub: "1" }), emitir({ sub: "2147483648:1" }), emitir({ sid: "no-uuid" }), emitir({ pv: "" }), emitir({}, firma, "HS384"), emitir({ exp: 1 })]) {
    const antes = c.consultas.length; await assert.rejects(c.auth(token), { statusCode: 401 }); assert.equal(c.consultas.length, antes);
  }
  // El contenido público del JWT no autoriza otro predio ni otros roles.
  const manipulado = emitir({ data: JSON.stringify({ id: 999, predio_id: 2, rol: "admin" }) });
  assert.equal((await c.auth(manipulado)).predio_id, 1); assert.equal((await c.auth(manipulado)).rol, "predio_admin");
  assert.equal((await c.auth(emitir({ exp: 1 }), { ignorarVencimiento: true })).id, 1);
});

test("sid persistido y su scope compuesto impiden reutilizar un id local de otro predio", async (t) => {
  const c = crearCaso(t); c.usuario(2);
  const r = await c.login({ predioCodigo: "MIRAMAR" }), p = jwt.decode(r.token);
  c.sqlite.prepare("UPDATE predio_acceso_sesion SET predio_id=2 WHERE id=?").run(p.sid);
  await assert.rejects(c.auth(r.token), { statusCode: 401 });
  c.sqlite.prepare("DELETE FROM predio_acceso_sesion").run(); await assert.rejects(c.auth(r.token), { statusCode: 401 });
});

test("cambio de contraseña, baja, rol o predio inactivo invalidan acceso y refresh", async (t) => {
  for (const sql of ["UPDATE predio_usuario SET password_hash='otro-hash'", "UPDATE predio_usuario SET activo=0", "UPDATE predio_usuario SET rol='CAJERO'",
    "UPDATE predio_usuario SET es_admin_general=1", "UPDATE predio SET activo=0 WHERE id=1"]) {
    const c = crearCaso(t), r = await c.login({ recordar: true }); c.sqlite.exec(sql);
    await assert.rejects(c.auth(r.token), { statusCode: 401 }); await assert.rejects(c.refresh(r.refreshToken), { statusCode: 401 });
  }
});

test("época de auditoría evita revivir sesiones tras reactivar con la misma contraseña y fecha", async (t) => {
  const c = crearCaso(t), r = await c.login({ recordar: true });
  c.sqlite.exec("UPDATE predio_usuario SET activo=0; INSERT INTO predio_auditoria VALUES(1,7,'usuario',1); UPDATE predio_usuario SET activo=1; INSERT INTO predio_auditoria VALUES(1,8,'usuario',1)");
  await assert.rejects(c.auth(r.token), { statusCode: 401 }); await assert.rejects(c.refresh(r.refreshToken), { statusCode: 401 });
  const nueva = await c.login({ recordar: true }); assert.equal((await c.auth(nueva.token)).id, 1);
  // Auditorías de otra entidad, usuario o predio no revocan esta cuenta.
  c.sqlite.exec("INSERT INTO predio_auditoria VALUES(1,9,'sesion',1),(1,10,'usuario',2),(2,99,'usuario',1)");
  assert.equal((await c.auth(nueva.token)).id, 1);
});

test("refresh concurrente converge, recupera respuesta perdida y descarta generaciones anteriores", async (t) => {
  const c = crearCaso(t), r = await c.login({ recordar: true });
  const [a, b] = await Promise.all([c.refresh(r.refreshToken), c.refresh(r.refreshToken)]);
  assert.equal(a.refreshToken, b.refreshToken); assert.notEqual(a.refreshToken, r.refreshToken);
  assert.equal((await c.refresh(a.refreshToken)).refreshToken, a.refreshToken);
  c.avanzar(61_000); assert.equal((await c.refresh(r.refreshToken)).refreshToken, a.refreshToken);
  const siguiente = await c.refresh(a.refreshToken); assert.notEqual(siguiente.refreshToken, a.refreshToken);
  await assert.rejects(c.refresh(r.refreshToken), { statusCode: 401 });
  assert.equal((await c.refresh(a.refreshToken)).refreshToken, siguiente.refreshToken);
  assert.equal((await c.auth(siguiente.token)).id, 1);
});

test("logout es durable por acceso o refresh y una firma general no puede revocar el sid privado", async (t) => {
  const c = crearCaso(t), r = await c.login({ recordar: true }), sid = jwt.decode(r.token).sid;
  const general = jwt.sign({ sid, sub: "1:1", aud: "ajb:predios:cuentas", iss: "mi-ajb", tipo: "predio-cuenta", pv: jwt.decode(r.token).pv }, secreto);
  assert.equal(servicio.esTokenPredio(general), true); // Sólo clasifica, jamás autentica.
  await servicio.cerrarSesionPredio({ db: c.db, token: general, jwtSecret: secreto });
  assert.equal((await c.auth(r.token)).id, 1);
  const rotado = await c.refresh(r.refreshToken);
  await servicio.cerrarSesionPredio({ db: c.db, refreshToken: r.refreshToken, jwtSecret: secreto });
  await assert.rejects(c.auth(rotado.token), { statusCode: 401 }); await assert.rejects(c.refresh(rotado.refreshToken), { statusCode: 401 });
  const nuevo = await c.login(); await servicio.cerrarSesionPredio({ db: c.db, token: nuevo.token, jwtSecret: secreto });
  await assert.rejects(c.auth(nuevo.token), { statusCode: 401 });
});

test("vencimiento persistido no puede omitirse ignorando sólo la fecha del JWT", async (t) => {
  const c = crearCaso(t), r = await c.login(); c.avanzar(8 * 3600_000 + 1000);
  await assert.rejects(c.auth(r.token, { ignorarVencimiento: true }), { statusCode: 401 });
});

function migracionFake({ falta = null, errorDdl = false, lock = 1 } = {}) {
  const consultas = [];
  const c = { query: async (sql, parametros) => {
    consultas.push({ sql, parametros });
    if (sql.includes("GET_LOCK")) return [[{ tomado: lock }]];
    if (sql.includes("information_schema.COLUMNS")) return [migracion.COLUMNAS.filter((nombre) => nombre !== falta).map((COLUMN_NAME) => ({ COLUMN_NAME }))];
    if (sql.includes("SELECT DATABASE")) return [[{ nombre: "base_pruebas" }]];
    if (sql.includes("FROM mysql.user")) return [[{ host: "localhost" }, { host: "192.0.2.%" }]];
    if (errorDdl && sql.startsWith("CREATE TABLE")) throw new Error("DDL falló");
    return [{ affectedRows: 1 }];
  } }; return { c, consultas };
}

test("migración crea y concede DML exclusivamente a la tabla central de sesiones", async () => {
  const f = migracionFake(); assert.deepEqual(await migracion.aplicarMigracion(f.c), { tabla: "predio_acceso_sesion", hosts: 2 });
  const ddl = f.consultas.filter(({ sql }) => /^CREATE TABLE/.test(sql)); assert.equal(ddl.length, 1);
  assert.match(ddl[0].sql, /FOREIGN KEY \(predio_id,usuario_id\)/);
  assert.match(ddl[0].sql, /UNIQUE KEY uq_predio_acceso_refresh/);
  assert.equal(f.consultas.filter(({ sql }) => /^(ALTER|INSERT|UPDATE|DELETE)\b/.test(sql)).length, 0);
  const grants = f.consultas.filter(({ sql }) => /^GRANT/.test(sql)); assert.equal(grants.length, 2);
  for (const g of grants) { assert.match(g.sql, /GRANT SELECT,INSERT,UPDATE,DELETE ON `base_pruebas`\.`predio_acceso_sesion` TO \?@\?/); assert.equal(g.parametros[0], "miajb_runtime"); }
  assert.match(f.consultas.at(-1).sql, /RELEASE_LOCK/);
});

test("check no escribe y la migración libera el lock si falla o falta una columna", async () => {
  const f = migracionFake(); await migracion.verificarEsquema(f.c); assert.equal(f.consultas.length, 1); assert.match(f.consultas[0].sql, /^SELECT/);
  for (const opciones of [{ falta: "revocado_en" }, { errorDdl: true }]) {
    const error = migracionFake(opciones); await assert.rejects(migracion.aplicarMigracion(error.c)); assert.match(error.consultas.at(-1).sql, /RELEASE_LOCK/);
  }
  const bloqueo = migracionFake({ lock: 0 }); await assert.rejects(migracion.aplicarMigracion(bloqueo.c)); assert.equal(bloqueo.consultas.length, 1);
});
