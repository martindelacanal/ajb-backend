"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { normalizarBloqueo, autorizarGestionAcceso, crearServicioAccesoUsuarios } = require("../api/services/usuarios-acceso");
const { MENSAJE_DEUDA, datosPublicosAcceso, exigirOperacionCuenta, exigirAccesoCuenta, exigirAltaParaUsuario } = require("../api/security/restricciones-cuenta");
const { actualizarAutorizacionSesion, resolverAccesoFamiliar, rutaPermitidaFamiliar } = require("../api/security/autorizacion-sesion");
const { aplicarMigracion, COLUMNAS } = require("../scripts/migrar-acceso-usuarios-v1");

test("los módulos económicos son explícitos, el mensaje es opcional y los datos inválidos no se guardan", () => {
  assert.deepEqual(normalizarBloqueo({ tipo: "modulos", economicos: true }), {
    tipo: "modulos", modulos: ["turismo", "coseguro"], mensaje: MENSAJE_DEUDA,
  });
  assert.deepEqual(normalizarBloqueo({ tipo: "modulos", modulos: ["beneficios", "beneficios"], mensaje: "  Consultá a tu sede  " }), {
    tipo: "modulos", modulos: ["beneficios"], mensaje: "Consultá a tu sede",
  });
  for (const body of [{}, { tipo: "modulos" }, { tipo: "total", modulos: ["admin"] }, { tipo: "total", mensaje: {} },
    { tipo: "total", mensaje: "x".repeat(1001) }, { tipo: "modulos", economicos: "false" }]) assert.throws(() => normalizarBloqueo(body), { statusCode: 400 });
});

test("centrales gestionan todos los roles; departamental solo afiliados propios; nadie puede bloquearse a sí mismo", () => {
  for (const rol of ["admin", "admin-central", "departamental", "afiliado", "invitado", "auditor", "prensa"]) {
    for (const central of ["admin", "admin-central"]) assert.doesNotThrow(() => autorizarGestionAcceso({ id: 1, rol: central }, { id: 2, rol }));
  }
  const actor = { id: 1, rol: "departamental", departamental_id: 4 };
  assert.doesNotThrow(() => autorizarGestionAcceso(actor, { id: 2, rol: "afiliado", departamental_id: 4 }));
  for (const objetivo of [{ id: 2, rol: "afiliado", departamental_id: 5 }, { id: 2, rol: "invitado", departamental_id: 4 },
    { id: 2, rol: "admin", departamental_id: 4 }, { id: 1, rol: "afiliado", departamental_id: 4 }]) {
    assert.throws(() => autorizarGestionAcceso(actor, objetivo), { statusCode: 403 });
  }
  assert.throws(() => autorizarGestionAcceso({ id: 1, rol: "admin" }, { id: 1, rol: "admin" }), { statusCode: 403 });
  assert.throws(() => autorizarGestionAcceso({ id: 1, rol: "afiliado" }, { id: 2, rol: "afiliado" }), { statusCode: 403 });
});

test("el bloqueo de módulo conserva lectura y detiene todas sus rutas operativas, aun con mayúsculas/barra final", () => {
  const usuario = { bloqueo: { tipo: "modulos", modulos: ["turismo", "coseguro"], mensaje: "Saldo pendiente" } };
  for (const path of ["/reserva", "/RESERVA/12/", "/turismo/reserva-holds", "/convenios-hoteleros/3/reservas", "/sorteos/4/inscripciones", "/coseguro/solicitudes", "/gestion/turismo/servicios", "/descuentos/admin/reglas"]) {
    assert.doesNotThrow(() => exigirOperacionCuenta(usuario, { method: "GET", path }));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.throws(() => exigirOperacionCuenta(usuario, { method, path }), { code: "MODULE_BLOCKED", message: "Saldo pendiente" });
    }
  }
  assert.doesNotThrow(() => exigirOperacionCuenta(usuario, { method: "POST", path: "/traslados/solicitudes" }));
  assert.doesNotThrow(() => exigirOperacionCuenta(usuario, { method: "PUT", path: "/configuracion/usuario/7" }));
  assert.doesNotThrow(() => exigirOperacionCuenta(usuario, { method: "POST", path: "/reserva/tarifa/fechas" }));
  assert.throws(() => exigirAccesoCuenta({ bloqueo_tipo: "total", bloqueo_mensaje: "Contactá a la sede" }), { code: "ACCOUNT_BLOCKED", message: "Contactá a la sede" });
});

test("clave temporal permite únicamente consultar permisos y cambiar contraseña, incluso para familiares", () => {
  const usuario = { requiere_cambio_clave: true };
  assert.doesNotThrow(() => exigirOperacionCuenta(usuario, { method: "GET", path: "/sesion/permisos" }));
  assert.doesNotThrow(() => exigirOperacionCuenta(usuario, { method: "POST", path: "/auth/password/cambiar-obligatoria" }));
  assert.equal(rutaPermitidaFamiliar({ method: "POST", path: "/auth/password/cambiar-obligatoria" }), true);
  for (const path of ["/configuracion/usuario/7", "/reserva", "/passkeys/registration/options", "/new/token", "/socket"]) {
    assert.throws(() => exigirOperacionCuenta(usuario, { method: "GET", path }), { code: "PASSWORD_CHANGE_REQUIRED" });
    assert.throws(() => exigirOperacionCuenta(usuario, { method: "PUT", path }), { code: "PASSWORD_CHANGE_REQUIRED" });
  }
});

test("nuevas erogaciones no eluden el bloqueo cargando por personal en nombre del beneficiario", () => {
  const beneficiario = { id: 7, bloqueo_tipo: "modulos", bloqueo_modulos: '["coseguro"]', bloqueo_mensaje: "Saldo del afiliado pendiente" };
  assert.throws(() => exigirAltaParaUsuario(beneficiario, "coseguro"), { code: "BENEFICIARY_BLOCKED", statusCode: 403, message: "Saldo del afiliado pendiente" });
  assert.doesNotThrow(() => exigirAltaParaUsuario(beneficiario, "turismo"));
  beneficiario.bloqueo_tipo = "total";
  assert.throws(() => exigirAltaParaUsuario(beneficiario, "turismo"), { code: "BENEFICIARY_BLOCKED" });
  beneficiario.bloqueo_tipo = null;
  assert.doesNotThrow(() => exigirAltaParaUsuario(beneficiario, "coseguro"));
});

test("un JWT existente usa el bloqueo vigente en base y desbloquearlo no conserva los claims previos", async () => {
  const usuario = { id: 7, rol: "afiliado", habilitado: "Y", bloqueo_tipo: "modulos", bloqueo_modulos: '["turismo"]', bloqueo_mensaje: "Deuda" };
  const db = { query: async () => [[{ ...usuario }]] };
  const auth = { data: JSON.stringify({ id: 7 }) };
  const bloqueado = await actualizarAutorizacionSesion(auth, db);
  assert.equal(bloqueado.bloqueo.mensaje, "Deuda");
  assert.equal(bloqueado.bloqueo_tipo, undefined);
  usuario.bloqueo_tipo = null;
  assert.equal((await actualizarAutorizacionSesion(auth, db)).bloqueo, null);
  usuario.bloqueo_tipo = "total";
  await assert.rejects(actualizarAutorizacionSesion(auth, db), { code: "ACCOUNT_BLOCKED" });
});

test("un familiar hereda restricciones de turismo y bloqueo total del titular", async () => {
  const titular = { id: 3, rol_id: 2, habilitado: "Y", bloqueo_tipo: "modulos", bloqueo_modulos: '["turismo"]', bloqueo_mensaje: "Deuda del titular" };
  const familiar = { id: 4, rol: "invitado", es_familiar: "S", usuario_familiar_id: 3 };
  const db = { query: async () => [[{ ...titular }]] };
  const data = await resolverAccesoFamiliar(datosPublicosAcceso(familiar), db);
  assert.throws(() => exigirOperacionCuenta(data, { method: "POST", path: "/reserva" }), { code: "MODULE_BLOCKED", message: "Deuda del titular" });
  titular.bloqueo_tipo = "total";
  await assert.rejects(resolverAccesoFamiliar(familiar, db), { code: "ACCOUNT_BLOCKED" });
});

function dbServicio() {
  const objetivo = { id: 2, rol: "afiliado", departamental_id: 3, email: "afiliado@example.test", nombre: "Afiliado", habilitado: "Y" };
  const consultas = [];
  const connection = {
    commits: 0, rollbacks: 0,
    beginTransaction: async () => {}, release() {},
    async commit() { this.commits += 1; }, async rollback() { this.rollbacks += 1; },
    async query(sql, params) {
      consultas.push({ sql, params });
      if (/WHERE u.id IN/.test(sql)) return [[{ id: 1, rol: "departamental", departamental_id: 3, habilitado: "Y" }, { ...objetivo }]];
      if (/SELECT id, password, requiere_cambio_clave/.test(sql)) return [[{ ...objetivo }]];
      if (/UPDATE usuario SET password/.test(sql)) {
        objetivo.password = params[0]; objetivo.requiere_cambio_clave = /requiere_cambio_clave = 1/.test(sql) ? 1 : 0;
      }
      return [{ affectedRows: 1 }];
    },
  };
  return { db: { getConnection: async () => connection }, connection, objetivo, consultas };
}

test("reset entrega una clave copiable, solo guarda hash, revoca accesos y sobrevive un fallo SMTP", async () => {
  const fixture = dbServicio();
  let envio;
  const servicio = crearServicioAccesoUsuarios({ db: fixture.db, enviar: async (datos) => { envio = datos; throw new Error("SMTP caído"); } });
  const result = await servicio.resetear({ actorId: 1, usuarioId: 2 });
  assert.equal(result.emailEnviado, false);
  assert.equal(result.passwordTemporal, envio.passwordTemporal);
  assert.match(result.passwordTemporal, /^AJB-[A-Za-z0-9_-]{16}$/);
  assert.equal(await bcrypt.compare(result.passwordTemporal, fixture.objetivo.password), true);
  assert.equal(fixture.objetivo.requiere_cambio_clave, 1);
  assert.equal(fixture.connection.commits, 1);
  assert.ok(fixture.consultas.some((q) => /DELETE FROM webauthn_credencial/.test(q.sql)));
  assert.ok(fixture.consultas.some((q) => /UPDATE auth_sesion/.test(q.sql)));
  assert.ok(!JSON.stringify(fixture.consultas).includes(result.passwordTemporal), "ninguna consulta ni auditoría incluye la clave en claro");
  await assert.rejects(servicio.cambiarObligatoria({ usuarioId: 2, passwordActual: result.passwordTemporal, password: result.passwordTemporal }), /distinta/);
  await assert.rejects(servicio.cambiarObligatoria({ usuarioId: 2, passwordActual: "incorrecta", password: "una clave nueva segura" }), /no es correcta/);
  await servicio.cambiarObligatoria({ usuarioId: 2, passwordActual: result.passwordTemporal, password: "una clave nueva segura" });
  assert.equal(fixture.objetivo.requiere_cambio_clave, 0);
  assert.equal(await bcrypt.compare("una clave nueva segura", fixture.objetivo.password), true);
  assert.equal(await bcrypt.compare(result.passwordTemporal, fixture.objetivo.password), false);
});

test("migración idempotente agrega columnas sin alterar el acceso existente", async () => {
  const columnas = new Set();
  let alteraciones = 0;
  const connection = { query: async (sql) => {
    if (/GET_LOCK/.test(sql)) return [[{ tomado: 1 }]];
    if (/information_schema.COLUMNS/.test(sql)) return [[...columnas].map((COLUMN_NAME) => ({ COLUMN_NAME }))];
    if (/ALTER TABLE/.test(sql)) { columnas.add(sql.match(/ADD COLUMN (\w+)/)[1]); alteraciones += 1; }
    return [[]];
  } };
  await aplicarMigracion(connection);
  await aplicarMigracion(connection);
  assert.equal(alteraciones, Object.keys(COLUMNAS).length);
});
