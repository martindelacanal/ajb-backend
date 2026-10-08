"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { crearSesion, renovarSesion } = require("../api/security/sesiones-persistentes");
const { actualizarAutorizacionSesion } = require("../api/security/autorizacion-sesion");
const { normalizarIdentificador, validarPassword } = require("../api/security/recuperacion-password");
const { huella, huellaPassword, igualesSeguros } = require("../api/security/auth-crypto");
const secret = "test-secret-auth".repeat(5);

test("recordar guarda solo una huella y emite acceso corto revocable; sin recordar conserva ocho horas", async () => {
  for (const recordar of [false, true]) {
    let insert;
    const result = await crearSesion({
      db: { query: async (sql, params) => { insert = { sql, params }; return [{ affectedRows: 1 }]; } },
      data: { id: 12, rol: "afiliado" }, password: "bcrypt-hash", recordar, jwtSecret: secret,
    });
    const payload = jwt.verify(result.token, secret);
    assert.equal(payload.exp - payload.iat, recordar ? 900 : 28800);
    assert.equal(payload.sid, insert.params[0]);
    assert.equal(payload.passwordVersion, huellaPassword("bcrypt-hash", secret));
    assert.equal(JSON.stringify(payload).includes("bcrypt-hash"), false);
    if (recordar) {
      assert.match(result.refreshToken, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(insert.params[2], huella(result.refreshToken, "refresh", secret));
      assert.ok(!insert.params.includes(result.refreshToken));
      assert.match(insert.sql, /VALUES \(\?, \?, \?, \?, NULL\)/);
    } else {
      assert.equal(result.refreshToken, undefined);
      assert.equal(insert.params[2], null);
      assert.match(insert.sql, /INTERVAL 8 HOUR/);
    }
  }
});

test("refresh mal formado se rechaza antes de tocar MySQL", async () => {
  const db = { getConnection: () => assert.fail("no se debe consultar") };
  for (const refreshToken of [null, "", "x".repeat(42), { token: "x" }, "x".repeat(5000)]) {
    await assert.rejects(renovarSesion({ db, refreshToken, jwtSecret: secret }), { statusCode: 401 });
  }
});

test("recupera una renovación cuya respuesta se perdió tras quedar offline y descarta el predecesor al rotar el sucesor", async () => {
  const original = "A".repeat(43);
  const row = { sesion_id: "session", id: 12, rol: "afiliado", password: "hash", habilitado: "S",
    password_version: huellaPassword("hash", secret), refresh_hash: huella(original, "refresh", secret),
    refresh_anterior_hash: null, en_gracia: 0 };
  let rotaciones = 0;
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    query: async (sql, params) => {
      if (/SELECT usuario_id FROM auth_sesion/.test(sql)) {
        const coincide = [row.refresh_hash, row.refresh_anterior_hash].includes(params[0]);
        return [coincide ? [{ usuario_id: 12 }] : []];
      }
      if (/SELECT id FROM usuario/.test(sql)) return [[{ id: 12 }]];
      if (/SELECT s.id AS sesion_id/.test(sql)) return [[{ ...row }]];
      if (/UPDATE auth_sesion SET refresh_anterior_hash/.test(sql)) {
        row.refresh_anterior_hash = row.refresh_hash;
        row.refresh_hash = params[0];
        row.en_gracia = 1;
        rotaciones += 1;
        return [{ affectedRows: 1 }];
      }
      assert.fail("Consulta inesperada");
    },
  };
  const db = { getConnection: async () => connection };
  const perdida = await renovarSesion({ db, refreshToken: original, jwtSecret: secret });
  assert.notEqual(perdida.refreshToken, original);
  assert.equal(rotaciones, 1);
  row.en_gracia = 0; // La red vuelve después de la ventana de 60 segundos.
  const recuperada = await renovarSesion({ db, refreshToken: original, jwtSecret: secret });
  assert.equal(recuperada.refreshToken, perdida.refreshToken);
  assert.equal(rotaciones, 1, "recuperar el sucesor no hace otra rotación");
  const siguiente = await renovarSesion({ db, refreshToken: recuperada.refreshToken, jwtSecret: secret });
  assert.notEqual(siguiente.refreshToken, recuperada.refreshToken);
  assert.equal(rotaciones, 2);
  await assert.rejects(renovarSesion({ db, refreshToken: original, jwtSecret: secret }), { statusCode: 401 });
});

test("revoca JWT nuevo por contraseña y por cierre, y JWT anterior por fecha de recuperación", async () => {
  const usuario = { id: 12, rol: "afiliado", password: "hash", habilitado: "S" };
  const auth = { sid: "session", passwordVersion: huellaPassword("hash", secret), data: JSON.stringify({ id: 12 }) };
  const db = (mod = {}, sesiones = [{ id: "session" }]) => ({ query: async (sql) =>
    /FROM auth_sesion/.test(sql) ? [sesiones] : [[{ ...usuario, ...mod }]] });
  const permisos = await actualizarAutorizacionSesion({ ...auth }, db(), secret);
  assert.equal(permisos.password, undefined);
  assert.equal(permisos.auth_revocado_desde, undefined);
  await assert.rejects(actualizarAutorizacionSesion({ ...auth }, db({ password: "otro" }), secret), { statusCode: 401 });
  await assert.rejects(actualizarAutorizacionSesion({ ...auth }, db({}, []), secret), { statusCode: 401 });
  await assert.rejects(actualizarAutorizacionSesion({ data: auth.data, iat: 100 }, db({ auth_revocado_desde: new Date(100001) }), secret), { statusCode: 401 });
  await assert.rejects(actualizarAutorizacionSesion({ ...auth }, db({ habilitado: "N" }), secret), { statusCode: 401 });
});

test("identificadores admiten documento o email único, sin objetos ni destinatarios múltiples", () => {
  assert.deepEqual(normalizarIdentificador("00333111"), { tipo: "documento", valor: "333111" });
  assert.deepEqual(normalizarIdentificador(" Ana@Example.Test "), { tipo: "email", valor: "ana@example.test" });
  for (const valor of [[], {}, "", "a@b.test,c@d.test", "a@b.test\r\nBcc: x@y.test", "12345678901", "x".repeat(255)]) {
    assert.equal(normalizarIdentificador(valor), null);
  }
});

test("la política de contraseña respeta caracteres Unicode y el límite efectivo de bcrypt", () => {
  assert.doesNotThrow(() => validarPassword("una frase muy segura"));
  assert.doesNotThrow(() => validarPassword("😀".repeat(18)));
  assert.throws(() => validarPassword("😀".repeat(19)));
  assert.throws(() => validarPassword("😀".repeat(6)), /12 caracteres/);
  assert.throws(() => validarPassword(" ".repeat(12)));
  assert.throws(() => validarPassword("x".repeat(73)));
  assert.throws(() => validarPassword({ password: "texto" }));
});

test("huellas separan ámbitos y comparaciones no aceptan tamaños o tipos diferentes", () => {
  assert.notEqual(huella("123456", "reset-code", secret), huella("123456", "refresh", secret));
  assert.notEqual(huella("123456", "reset-code", secret), huella("123456", "reset-code", "otro"));
  assert.equal(igualesSeguros("abc", "abc"), true);
  assert.equal(igualesSeguros("abc", "abcd"), false);
  assert.equal(igualesSeguros(null, null), false);
});
