"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { politicaPassword, validarPassword } = require("../api/security/password-policy");
const { crearServicioRecuperacion } = require("../api/security/recuperacion-password");
const { huella, huellaPassword } = require("../api/security/auth-crypto");

test("personal exige 12 caracteres y las cuatro categorías; afiliados y familiares tienen requisitos sencillos", () => {
  for (const rol of ["admin", "departamental", "admin-central", "auditor", "prensa", "educacion", "desconocido", undefined]) {
    assert.equal(politicaPassword(rol), "personal");
    assert.throws(() => validarPassword("montaña7", rol), { code: "PASSWORD_POLICY" });
    for (const password of ["palabraslargas7!", "PALABRASLARGAS7!", "PalabrasLargas!!", "PalabrasLargas77", "Aa123!"]) {
      assert.throws(() => validarPassword(password, rol), { code: "PASSWORD_POLICY" });
    }
    assert.doesNotThrow(() => validarPassword("Una Montaña 7!", rol));
  }
  for (const rol of ["afiliado", "invitado", { rol_id: 2 }, { rol_id: 4 }]) {
    assert.equal(politicaPassword(rol), "afiliado");
    assert.doesNotThrow(() => validarPassword("montaña7", rol));
    assert.throws(() => validarPassword("12345678", rol));
    assert.throws(() => validarPassword("montañas", rol));
    assert.throws(() => validarPassword("rio1234", rol));
  }
});

test("bloquea contraseñas comunes, DNI, espacios y truncado bcrypt, sin modificar la clave elegida", () => {
  for (const clave of ["Password123!", "qwerty123", "MiDni30111222!", "x".repeat(73), " ".repeat(20), { valor: "montaña7" }]) {
    assert.throws(() => validarPassword(clave, { rol_id: 2, documento: 30111222 }), { code: "PASSWORD_POLICY" });
  }
  assert.doesNotThrow(() => validarPassword("Árbol7!" + "😀".repeat(16), "admin"));
  assert.throws(() => validarPassword("Árbol7!" + "😀".repeat(17), "admin"), /larga/);
});

function fixtureRecuperacion(rolId) {
  const secret = "password-policy-test-secret";
  const token = "a".repeat(43);
  const usuario = { id: 7, rol_id: rolId, documento: 30111222, email: "persona@example.test", password: "hash-anterior", habilitado: "Y" };
  const row = { vigente: 1, intentos: 0, consumido_en: null, reset_hash: null,
    password_version: huellaPassword(usuario.password, secret), correo_hash: huella(usuario.email, "reset-email", secret),
    codigo_hash: huella("7:123456", "reset-code", secret) };
  const consultas = [];
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    query: async (sql, params) => {
      consultas.push({ sql, params });
      if (/SELECT.*FROM usuario/s.test(sql)) return [[{ ...usuario }]];
      if (/SELECT \*.*FROM auth_recuperacion/s.test(sql)) return [[{ ...row }]];
      return [{ affectedRows: 1 }];
    } };
  const db = { getConnection: async () => connection, query: async (sql) => {
    if (/SELECT cantidad/.test(sql)) return [[{ cantidad: 1, espera: 1 }]];
    if (/SELECT usuario_id FROM auth_recuperacion/.test(sql)) return [[{ usuario_id: usuario.id }]];
    return [{ affectedRows: 1 }];
  } };
  return { usuario, consultas, token, servicio: crearServicioRecuperacion({ db, jwtSecret: secret, enviarCodigo: async () => ({ enviado: true }) }) };
}

test("recuperación comunica la política tras verificar y valida el rol vigente, aunque el cliente declare otro", async () => {
  for (const rolId of [1, 2, 4, 6]) {
    const f = fixtureRecuperacion(rolId);
    // El familiar debe cumplir también la habilitación normal del flujo.
    if (rolId === 4) Object.assign(f.usuario, { es_familiar: "S", usuario_familiar_id: 3 });
    const respuesta = await f.servicio.verificar({ identificador: "30111222", codigo: "123456", ip: "127.0.0.1" });
    assert.equal(respuesta.politicaPassword, [2, 4].includes(rolId) ? "afiliado" : "personal");
    if (rolId === 2) {
      await f.servicio.restablecer({ resetToken: f.token, password: "montaña7", ip: "127.0.0.1" });
      assert.ok(f.consultas.some(q => /UPDATE usuario SET password/.test(q.sql)));
    }
  }
  const f = fixtureRecuperacion(2);
  await f.servicio.verificar({ identificador: "30111222", codigo: "123456", ip: "127.0.0.1" });
  f.usuario.rol_id = 1; // Cambió el rol después del código: manda la cuenta actual.
  await assert.rejects(f.servicio.restablecer({ resetToken: f.token, password: "montaña7", politicaPassword: "afiliado", ip: "127.0.0.1" }), { code: "PASSWORD_POLICY", politicaPassword: "personal" });
  assert.ok(!f.consultas.some(q => /UPDATE usuario SET password/.test(q.sql)));
});
