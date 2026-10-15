const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET ||= 'test-only-secret';
const { partidoPublico, calcularPosiciones } = require('../api/services/olimpiadas-competicion');
const { leerPartido, validarReferenciasPartido, guardarExtrasPartido, bloquearSinCambios } = require('../api/routes/olimpiadas-contenido').__test;
const { endpoint } = require('../api/routes/olimpiadas-publico').__test;

test('público: por defecto protege los nombres y toda la información privada del partido', () => {
  const privado = { id: 10, participante1: 'Ana Pérez', participante2: 'Juan Gómez', departamental1_nombre: 'La Plata',
    departamental2_nombre: 'Mercedes', inscripcion1_id: 25, inscripcion2_id: 26, mostrar_nombres_publico: 0,
    observacion: 'Celular personal 123', dato_nuevo_privado: 'no publicar', estado: 'FINALIZADO', resultado1: '3', resultado2: '1' };
  const publico = partidoPublico(privado);
  assert.equal(publico.participante1, 'La Plata');
  assert.equal(publico.participante2, 'Mercedes');
  assert.equal(publico.resultado1, '3');
  assert.equal(publico.estado, 'FINALIZADO');
  for (const campo of ['inscripcion1_id', 'inscripcion2_id', 'observacion', 'dato_nuevo_privado']) assert.equal(campo in publico, false);
  assert.equal(JSON.stringify(publico).includes('Ana'), false);
  assert.equal(partidoPublico({ ...privado, mostrar_nombres_publico: 1 }).participante1, 'Ana Pérez');
  assert.equal(partidoPublico({ ...privado, mostrar_nombres_publico: '1' }).participante2, 'Juan Gómez');
});

test('público: un partido legado sin departamental nunca usa el nombre privado como fallback', () => {
  const publico = partidoPublico({ participante1: 'Nombre privado', participante2: 'Otro nombre privado', partido_origen2_id: 15 });
  assert.equal(publico.participante1, 'A confirmar');
  assert.equal(publico.participante2, 'Ganador del partido 15');
});

test('posiciones: resultados corregidos, empates y W.O. se recalculan sin contar encuentros abiertos', () => {
  const base = { departamental1_id: 1, departamental2_id: 2, departamental1_nombre: 'La Plata', departamental2_nombre: 'Mercedes', estado: 'FINALIZADO' };
  const tabla = calcularPosiciones([
    { ...base, ganador: 1, resultado1: '2', resultado2: '0' },
    { ...base, ganador: 0, resultado1: '1', resultado2: '1' },
    { ...base, ganador: 2, resultado1: 'W.O.', resultado2: null },
    { ...base, ganador: null, resultado1: '4', resultado2: '2' },
    { ...base, estado: 'EN_JUEGO', ganador: 1, resultado1: '3', resultado2: '1' },
    { ...base, estado: 'SUSPENDIDO', ganador: 1 },
  ]);
  assert.equal(tabla.length, 2);
  assert.deepEqual(tabla.map(d => [d.jugados, d.ganados, d.empatados, d.perdidos, d.puntos]), [[3, 1, 1, 1, 4], [3, 1, 1, 1, 4]]);
  assert.equal(tabla[0].nombre, 'La Plata');
  assert.equal(tabla[0].a_favor, 3);
  assert.equal(tabla[0].diferencia, 2);
  const corregida = calcularPosiciones([{ ...base, ganador: 2, resultado1: '0', resultado2: '2' }]);
  assert.equal(corregida[0].departamental_id, 2);
  assert.equal(corregida[0].puntos, 3);
});

test('posiciones: encuentros internos o sin departamental no generan puntos artificiales', () => {
  assert.deepEqual(calcularPosiciones([{ estado: 'FINALIZADO', ganador: 1, departamental1_id: 1, departamental2_id: 1 },
    { estado: 'FINALIZADO', ganador: 1, departamental1_id: 1 }]), []);
});

test('partidos: privacidad por defecto y horario coherente', () => {
  assert.equal(leerPartido({ disciplina_id: 2, departamental1_id: 1, departamental2_id: 2 }, {}).mostrar_nombres_publico, 0);
  assert.throws(() => leerPartido({ disciplina_id: 2, hora_inicio: '15:30', hora_fin: '14:00' }, {}), /posterior/);
});

function dbParticipantes({ aprobado = true, torneoValido = true } = {}) {
  return { async query(sql, params) {
    if (sql.includes('FROM olimpiada_disciplina_config')) return [[{ id: 2, disciplina_id: 2 }]];
    if (sql.includes('FROM olimpiada_torneo WHERE')) return [torneoValido ? [{ id: 7 }] : []];
    if (sql.includes('FROM olimpiada_inscripcion i')) {
      assert.match(sql, /i\.estado = 'VALIDADO'/);
      assert.match(sql, /d\.disciplina_id = \?/);
      assert.deepEqual(params, [2, 25, 3]);
      return [aprobado ? [{ id: 25, departamental_id: 1, nombre: 'Ana', apellido: 'Pérez' }] : []];
    }
    if (sql.includes('FROM departamental')) return [[{ id: 2, nombre: 'Mercedes' }]];
    throw new Error(`Consulta inesperada: ${sql}`);
  } };
}

test('partidos: los afiliados se resuelven desde su inscripción aprobada en la edición y disciplina', async () => {
  const datos = leerPartido({ disciplina_id: 2, inscripcion1_id: 25, departamental1_id: 99, participante1: 'Nombre manipulado', departamental2_id: 2 }, {});
  await validarReferenciasPartido(dbParticipantes(), 3, datos);
  assert.equal(datos.participante1, 'Pérez Ana');
  assert.equal(datos.departamental1_id, 1);
  assert.equal(datos.participante2, 'Mercedes');
  await assert.rejects(validarReferenciasPartido(dbParticipantes({ aprobado: false }), 3, datos), /inscripción aprobada/);
});

test('partidos: no admite torneos de otra edición o disciplina ni ciclos de cuadros', async () => {
  const datos = leerPartido({ disciplina_id: 2, torneo_id: 7, participante1: 'A', participante2: 'B' }, {});
  await assert.rejects(validarReferenciasPartido(dbParticipantes({ torneoValido: false }), 3, datos), /torneo no pertenece/);
  const dbSinEscritura = { query() { assert.fail('No debe guardar una referencia cíclica'); } };
  await assert.rejects(guardarExtrasPartido(dbSinEscritura, 4, { partido_origen1_id: 4 }), /antes/);
  await assert.rejects(guardarExtrasPartido(dbSinEscritura, 4, { partido_origen2_id: 7 }), /antes/);
});

function respuesta() {
  return { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; }, set(k, v) { this.headers[k] = v; return this; }, json(value) { this.body = value; return this; } };
}
test('competición: detecta cambios concurrentes antes de sobrescribir resultados o la disciplina autorizada', async () => {
  const anterior = { id: 8, disciplina_id: 2, resultado1: '1', fecha_modificacion: '2026-10-14 15:10:00' };
  const conexion = actual => ({ async query(sql, params) { assert.match(sql, /FOR UPDATE/); assert.deepEqual(params, [8]); return [[actual]]; } });
  assert.deepEqual(await bloquearSinCambios(conexion({ ...anterior }), 'olimpiada_partido', anterior), anterior);
  await assert.rejects(bloquearSinCambios(conexion({ ...anterior, resultado1: '2' }), 'olimpiada_partido', anterior), e => e.statusCode === 409);
  await assert.rejects(bloquearSinCambios(conexion({ ...anterior, disciplina_id: 4 }), 'olimpiada_partido', anterior), e => e.statusCode === 409);
});
test('portal público: una edición demo/no publicada o deshabilitada no ejecuta la lectura del contenido', async () => {
  for (const edicion of [null, { habilitado: 'Y', publicada_publico: 0 }, { habilitado: 'N', publicada_publico: 1 }]) {
    const res = respuesta();
    await endpoint(() => assert.fail('No debe leer contenido privado'), async () => edicion)({ params: { id: '1' } }, res);
    assert.equal(res.statusCode, 404);
  }
  const res = respuesta();
  await endpoint(async (_, o) => ({ nombre: o.nombre }), async () => ({ habilitado: 'Y', publicada_publico: 1, nombre: 'Edición oficial' }))({ params: { id: '2' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { nombre: 'Edición oficial' });
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
