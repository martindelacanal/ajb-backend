"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolverAccesoFamiliar, actualizarAutorizacionSesion, rutaPermitidaFamiliar } = require('../api/security/autorizacion-sesion');
const familiar = { id: 9, rol: 'invitado', rol_id: 4, es_familiar: 'S', usuario_familiar_id: 2, habilitado: 'S', modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1 };
const titular = { id: 2, rol_id: 2, habilitado: 'S', modulo_turismo: 1, departamental_id: 5, usuario_familiar_id: null };

test('el invitado vinculado accede solo a turismo con su identidad propia', async () => {
  const resultado = await resolverAccesoFamiliar(familiar, { query: async (_sql, params) => { assert.deepEqual(params, [2]); return [[titular]]; } });
  assert.equal(resultado.id, 9);
  assert.equal(resultado.rol, 'afiliado');
  assert.equal(resultado.acceso_familiar_turismo, true);
  assert.equal(resultado.modulo_coseguro, 0);
  assert.equal(resultado.modulo_olimpiadas, 0);
  assert.equal(resultado.modulo_turismo, 1);
  assert.equal(resultado.departamental_id, 5);
});

test('invitados no familiares, autovínculos y titulares inactivos no ganan acceso', async () => {
  for (const usuario of [{ ...familiar, es_familiar: 'N' }, { ...familiar, usuario_familiar_id: null }, { ...familiar, usuario_familiar_id: 9 }]) {
    await assert.rejects(resolverAccesoFamiliar(usuario, { query: () => assert.fail('No debe consultar un vínculo inválido') }), { statusCode: 403 });
  }
  for (const datos of [null, { ...titular, habilitado: 'N' }, { ...titular, rol_id: 4 }, { ...titular, usuario_familiar_id: 3 }]) {
    await assert.rejects(resolverAccesoFamiliar(familiar, { query: async () => [datos ? [datos] : []] }), { statusCode: 403 });
  }
});

test('el permiso turismo respeta al familiar y al titular', async () => {
  for (const [usuario, principal] of [[{ ...familiar, modulo_turismo: 0 }, titular], [familiar, { ...titular, modulo_turismo: 0 }]]) {
    const actual = await resolverAccesoFamiliar(usuario, { query: async () => [[principal]] });
    assert.equal(actual.modulo_turismo, 0);
  }
});

test('revocar vínculo familiar invalida un JWT anterior en la siguiente petición', async () => {
  await assert.rejects(actualizarAutorizacionSesion({ data: { ...familiar, rol: 'afiliado', acceso_familiar_turismo: true } }, {
    query: async () => [[{ ...familiar, usuario_familiar_id: null }]]
  }), { statusCode: 403 });
});

test('la cuenta familiar invitada no habilita módulos ajenos a turismo', () => {
  assert.equal(rutaPermitidaFamiliar({ method: 'POST', path: '/familiares' }), false);
  assert.equal(rutaPermitidaFamiliar({ method: 'PUT', path: '/familiares/42/vinculo' }), false);
  for (const path of ['/credencial-digital', '/beneficios/1/inscripciones', '/traslados', '/coseguro/solicitudes', '/admin/turismo/politicas-cancelacion']) {
    assert.equal(rutaPermitidaFamiliar({ path }), false, path);
  }
  for (const path of ['/reserva', '/reserva/7/resumen', '/turismo/reserva-elegibilidad', '/convenios-hoteleros/1/reservas', '/mis-gestiones', '/sesion/permisos']) {
    assert.equal(rutaPermitidaFamiliar({ path }), true, path);
  }
});
