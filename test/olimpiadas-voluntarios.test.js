"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const express = require("express");

process.env.JWT_SECRET = "voluntarios-tests-no-production-secret";
const secret = process.env.JWT_SECRET;
const {
  AUDIENCIA, ROL, crearTokenVoluntario, autenticarVoluntario,
  crearVerificadorCompeticion, exigirEdicionVoluntario,
  exigirDisciplinaVoluntario, puedeEditarEdicion,
} = require("../api/security/olimpiadas-voluntarios");
const { verificarTokenConAutorizacionActual } = require("../api/security/autorizacion-sesion");
const { crearRouterVoluntarios, __test } = require("../api/routes/olimpiadas-voluntarios");

const v = { id: 12, nombre: "Ana Colaboradora", usuario: "ana.voley", email: "ana@example.org", habilitado: 1, sesion_version: 3 };
const cabecera = { id: null, rol: ROL, voluntario_id: 12 };
const edicion = { id: 7, nombre: "Olimpiadas 2026", fecha_inicio: "2026-10-14", fecha_fin: "2026-10-16", eliminado: 0, habilitado: "Y" };

function respuesta() {
  return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
}

test("token de voluntario no sirve para autenticar una cuenta general aunque coincida el ID", async () => {
  const token = crearTokenVoluntario(v, secret);
  assert.throws(() => jwt.verify(token, secret), /invalid signature/);
  const res = respuesta();
  await verificarTokenConAutorizacionActual({
    req: { headers: { authorization: `Bearer ${token}` } }, res, jwt, jwtSecret: secret,
    next: () => assert.fail("el voluntario no debe acceder a usuarios u otros módulos"),
    db: { query: () => assert.fail("no debe buscar al usuario con el mismo ID") },
  });
  assert.equal(res.statusCode, 401);
});

test("no acepta tokens normales disfrazados de colaboración ni firmas manipuladas", async () => {
  const token = jwt.sign({ tipo: ROL, version: 3 }, secret, { audience: AUDIENCIA, issuer: "mi-ajb", subject: "12" });
  await assert.rejects(autenticarVoluntario({ token, jwtSecret: secret, db: { query: () => assert.fail("firma inválida") } }), { statusCode: 401 });
});

test("cada petición consulta habilitación y versión; revocar o cambiar la clave invalida inmediatamente", async () => {
  const token = crearTokenVoluntario(v, secret);
  let cuenta = { ...v };
  const db = { query: async () => [[cuenta]] };
  const actual = await autenticarVoluntario({ token, jwtSecret: secret, db });
  assert.equal(actual.id, null);
  assert.equal(actual.voluntario_id, 12);
  assert.equal(actual.rol, ROL);
  cuenta = { ...v, sesion_version: 4 };
  await assert.rejects(autenticarVoluntario({ token, jwtSecret: secret, db }), { statusCode: 401 });
  cuenta = { ...v, habilitado: 0 };
  await assert.rejects(autenticarVoluntario({ token, jwtSecret: secret, db }), { statusCode: 401 });
});

test("verificador de competición conserva la autorización normal y sólo acepta voluntarios firmados", async () => {
  let pasoNormal = false;
  const middleware = crearVerificadorCompeticion({
    db: { query: async () => [[v]] }, jwtSecret: secret,
    verificarNormal: () => { pasoNormal = true; },
  });
  await middleware({ headers: {} }, respuesta(), () => assert.fail());
  assert.equal(pasoNormal, true);
  const req = { headers: { authorization: `Bearer ${crearTokenVoluntario(v, secret)}` } };
  let pasoVoluntario = false;
  await middleware(req, respuesta(), () => { pasoVoluntario = true; });
  assert.equal(pasoVoluntario, true);
  assert.equal(JSON.parse(req.data.data).voluntario_id, 12);
});

test("no puede consultar otra edición ni una disciplina sin asignación, tampoco inventar IDs", async () => {
  const db = { query: async (_sql, args) => args[1] === 7 ? [[{ ...edicion, disciplina_id: 4 }]] : [[]] };
  assert.deepEqual(await exigirEdicionVoluntario({ db, cabecera, olimpiadaId: 7 }), [4]);
  await assert.rejects(exigirEdicionVoluntario({ db, cabecera, olimpiadaId: 8 }), { statusCode: 403 });
  await assert.rejects(exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId: 7, disciplinaId: 5 }), { statusCode: 403 });
  await assert.rejects(exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId: 7, disciplinaId: "4xyz" }), { statusCode: 403 });
  await assert.rejects(exigirEdicionVoluntario({ db, cabecera, olimpiadaId: "7abc" }), { statusCode: 403 });
  assert.equal(await exigirEdicionVoluntario({ db, cabecera: { rol: "admin" }, olimpiadaId: 7, escritura: true }), null);
});

test("voluntarios sólo escriben durante el evento; después conservan lectura y antes no cargan resultados", async () => {
  const db = { query: async () => [[{ ...edicion, disciplina_id: 4 }]] };
  for (const hoy of ["2026-10-14", "2026-10-16"]) {
    assert.deepEqual(await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId: 7, disciplinaId: 4, escritura: true, hoy }), [4]);
  }
  for (const hoy of ["2026-10-13", "2026-10-17"]) {
    await assert.rejects(exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId: 7, disciplinaId: 4, escritura: true, hoy }), { statusCode: 403 });
    assert.deepEqual(await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId: 7, disciplinaId: 4, hoy }), [4]);
  }
  assert.equal(puedeEditarEdicion({ ...edicion, fecha_fin: null }, "2026-10-14"), false);
  assert.equal(puedeEditarEdicion({ ...edicion, habilitado: "N" }, "2026-10-14"), false);
});

test("quitar la asignación o deshabilitar cuenta elimina incluso el acceso de lectura", async () => {
  const db = { query: async () => [[]] };
  await assert.rejects(exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId: 7, disciplinaId: 4 }), { statusCode: 403 });
});

test("validaciones de alta no permiten claves débiles, emails múltiples ni usuario ambiguo", () => {
  const cuenta = { nombre: "Ana", usuario: "ana.voley", email: "ana@example.org", password: "Nueva-clave2026!" };
  assert.equal(__test.normalizarCuenta(cuenta).usuario, "ana.voley");
  for (const body of [
    { ...cuenta, password: "password123" },
    { ...cuenta, email: "ana@example.org,otra@example.org" },
    { ...cuenta, usuario: "ana@example.org" },
    { ...cuenta, habilitado: "quizas" },
  ]) assert.throws(() => __test.normalizarCuenta(body), { statusCode: 400 });
  assert.throws(() => __test.leerIds([4, "5oops"], "disciplinas"), { statusCode: 400 });
});

async function conServidor(t, opciones) {
  const app = express();
  app.use(express.json());
  app.use(crearRouterVoluntarios(opciones));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("gestión de colaboradores rechaza a afiliados, departamentales y voluntarios antes de leer sus datos", async (t) => {
  let rol = "afiliado";
  const base = await conServidor(t, {
    db: { query: () => assert.fail("no debe consultar datos privados") },
    verificarAdmin: (req, _res, next) => { req.data = { data: JSON.stringify({ id: 1, rol }) }; next(); },
  });
  for (rol of ["afiliado", "departamental", ROL]) {
    const response = await fetch(`${base}/olimpiadas/7/voluntarios`);
    assert.equal(response.status, 403);
    const envio = await fetch(`${base}/olimpiadas/7/voluntarios/enviar-bienvenida`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voluntario_ids: [12] }) });
    assert.equal(envio.status, 403);
  }
});

test("login limita intentos antes de consultar o verificar contraseñas", async (t) => {
  const base = await conServidor(t, {
    db: { query: () => assert.fail("login limitado no debe consultar cuentas") },
    limitador: async () => { throw Object.assign(new Error("Demasiados intentos"), { statusCode: 429, retryAfter: 90 }); },
  });
  const response = await fetch(`${base}/olimpiadas/voluntarios/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identificador: "ana", password: "ejemplo" }) });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "90");
});

test("login y perfil exponen sólo la cuenta y disciplinas asignadas, nunca hash ni versión de sesión", async (t) => {
  const password = "Una-clave2026!";
  const hash = await bcrypt.hash(password, 4);
  const db = { query: async (sql) => /FROM olimpiada_voluntario_disciplina/.test(sql)
    ? [[{ ...edicion, olimpiada_id: 7, olimpiada_titulo: edicion.nombre, disciplina_id: 4, disciplina_nombre: "Vóley" }]]
    : /FROM olimpiada_voluntario_sesion/.test(sql) ? [[{ id: "sesion", password_version: require("../api/security/auth-crypto").huellaPassword(hash, secret) }]]
    : [[{ ...v, password_hash: hash }]] };
  const base = await conServidor(t, { db, jwtSecret: secret, limitador: async () => {} });
  const response = await fetch(`${base}/olimpiadas/voluntarios/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identificador: v.usuario, password }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.voluntario.id, 12);
  assert.equal(body.voluntario.password_hash, undefined);
  assert.equal(body.voluntario.sesion_version, undefined);
  assert.deepEqual(body.asignaciones[0].disciplinas, [{ id: 4, nombre: "Vóley" }]);
  const profile = await fetch(`${base}/olimpiadas/voluntarios/me`, { headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).voluntario.id, 12);
});

function baseCorreo() {
  const consultas = [];
  const estado = { commit: 0, rollback: 0, release: 0 };
  const connection = {
    beginTransaction: async () => {}, commit: async () => { estado.commit++; },
    rollback: async () => { estado.rollback++; }, release: () => { estado.release++; },
    query: async (sql, params) => {
      consultas.push({ sql, params });
      if (/FROM olimpiada_voluntario WHERE/.test(sql)) return [[v]];
      if (/FROM olimpiada_voluntario_disciplina/.test(sql)) return [[{ ...edicion, olimpiada_id: 7, olimpiada_titulo: edicion.nombre, disciplina_id: 4, disciplina_nombre: "Vóley" }]];
      return [{ affectedRows: 1 }];
    },
  };
  return { db: { getConnection: async () => connection }, consultas, estado };
}

test("bienvenida rota clave sólo al enviar, registra auditoría sin secretos y usa el enlace de colaboradores", async () => {
  const { db, consultas, estado } = baseCorreo();
  let correo;
  const result = await __test.enviarBienvenida({ db, voluntarioId: 12, olimpiada: edicion, cabecera: { id: 1, rol: "admin" }, enviar: async (datos) => { correo = datos; return { enviado: true }; } });
  assert.equal(result.enviado, true);
  assert.equal(correo.autenticacion, true);
  assert.match(correo.boton.url, /\/olimpiadas-colaboradores$/);
  const password = correo.datos.find((d) => d.etiqueta === "Nueva contraseña").valor;
  const update = consultas.find((q) => /UPDATE olimpiada_voluntario/.test(q.sql));
  assert.ok(await bcrypt.compare(password, update.params[0]));
  assert.equal(JSON.stringify(consultas).includes(password), false);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.equal(estado.commit, 1);
  assert.equal(estado.rollback, 0);
});

test("fallo de correo no reemplaza la clave vigente ni cierra sesiones", async () => {
  const { db, consultas, estado } = baseCorreo();
  await assert.rejects(__test.enviarBienvenida({ db, voluntarioId: 12, olimpiada: edicion, cabecera: { id: 1, rol: "admin" }, enviar: async () => ({ enviado: false }) }), { statusCode: 503 });
  assert.equal(consultas.some((q) => /UPDATE olimpiada_voluntario/.test(q.sql)), false);
  assert.equal(estado.rollback, 1);
  assert.equal(estado.commit, 0);
  assert.equal(estado.release, 1);
});
