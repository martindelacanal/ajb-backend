const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET ||= 'test-only-secret';
const { planificar } = require('../scripts/migrar-olimpiadas-canchas');
const { validarReferenciasPartido } = require('../api/routes/olimpiadas-contenido').__test;

test('canchas compartidas se dividen por sede, sin reasignar partidos de edición ambigua', () => {
  const sedes = [
    { id: 10, nombre: 'Camping', olimpiada_id: 1 }, { id: 20, nombre: 'Camping', olimpiada_id: 2 },
    { id: 30, nombre: 'Polideportivo', olimpiada_id: 2 },
  ];
  const lugares = [{ id: 1, predio: 'Camping' }, { id: 2, predio: 'POLIDEPORTIVO' }, { id: 3, predio: 'Camping' }];
  const partidos = [{ id: 11, lugar_id: 1, olimpiada_id: 1, sede_id: 10 },
    { id: 12, lugar_id: 1, olimpiada_id: 2, sede_disciplina_id: 30 }, { id: 13, lugar_id: 1, olimpiada_id: 9 }];
  assert.deepEqual(planificar(lugares, sedes, partidos), {
    grupos: [
      { lugarId: 1, sedeId: 10, partidosIds: [11], reutilizar: false },
      { lugarId: 1, sedeId: 30, partidosIds: [12], reutilizar: false },
      { lugarId: 2, sedeId: 30, partidosIds: [], reutilizar: true },
    ],
    sinSede: [1, 3],
  });
});

test('la cancha fija la sede del partido y sólo se permite asignar canchas de esa sede y edición', async () => {
  const cancha = { id: 1, sede_id: 4, olimpiada_id: 7 };
  const db = { async query(sql) {
    if (sql.includes('FROM olimpiada_lugar')) return [[cancha]];
    if (sql.includes('FROM olimpiada_disciplina_config') || sql.includes('FROM olimpiada_sede')) return [[{ id: 4 }]];
    throw new Error('Consulta inesperada: ' + sql);
  } };
  const partido = { lugar_id: 1, disciplina_id: 2, participante1: 'A', participante2: 'B' };
  await validarReferenciasPartido(db, 7, partido);
  assert.equal(partido.sede_id, 4);
  await assert.rejects(validarReferenciasPartido(db, 8, partido), /cancha no pertenece/);
  await assert.rejects(validarReferenciasPartido(db, 7, { ...partido, sede_id: 9 }), /cancha no pertenece/);
  cancha.sede_id = null;
  cancha.olimpiada_id = null;
  await assert.rejects(validarReferenciasPartido(db, 7, partido), /cancha no pertenece/);
  await validarReferenciasPartido(db, 7, partido, { ...partido });
});
