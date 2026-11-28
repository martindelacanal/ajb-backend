const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('el fixture público agrupa los podios de las categorías premiadas y mantiene los podios generales', async t => {
  const edicion = { id: 7, habilitado: 'Y', publicada_publico: 1, medallero_publicado: 0 };
  const disciplinas = [
    { id: 4, nombre: 'Natación', formato: 'TIEMPO', partidos: 0 },
    { id: 5, nombre: 'Pesca', formato: 'PESCA', partidos: 0 },
    { id: 6, nombre: 'Poker', formato: 'MESAS', partidos: 0 },
    { id: 7, nombre: 'Tenis', formato: 'PARTIDOS', partidos: 1 },
  ];
  const pruebas = [
    { id: 19, disciplina_id: 4, nombre: 'Femenino 25 mts.', orden: 1, estado: 'FINALIZADA' },
    { id: 26, disciplina_id: 4, nombre: 'Postas 100mts.', orden: 2, estado: 'FINALIZADA' },
    { id: 13, disciplina_id: 4, nombre: 'Masculino 50 mts.', orden: 3, estado: 'FINALIZADA' },
    { id: 10, disciplina_id: 4, nombre: 'En curso', orden: 4, estado: 'EN_JUEGO' },
    { id: 20, disciplina_id: 4, nombre: 'Sin resultados', orden: 5, estado: 'FINALIZADA' },
    { id: 30, disciplina_id: 5, nombre: 'Mayor peso', orden: 1, estado: 'FINALIZADA' },
  ];
  const participante = (id, disciplina_id, prueba_id, tiempo_ms, campos = {}) => ({
    id, disciplina_id, prueba_id, tiempo_ms, inscripcion_id: 123, orden: id, nombre: `Persona ${id}`,
    departamental_id: 9, departamental_nombre: 'Azul', ...campos,
  });
  const personas = [
    participante(1, 4, 19, 32_000), participante(2, 4, 19, 32_000), participante(3, 4, 19, 37_000),
    participante(4, 4, 13, 32_000), participante(5, 4, 10, 32_000), participante(6, 4, 20, null),
    ...[71_650, 79_440, 83_780, 97_000].flatMap((tiempo, equipo) => Array.from({ length: 4 }, (_, i) =>
      participante(100 + equipo * 4 + i, 4, 26, tiempo, i < 2 ? {} : { departamental_id: 10, departamental_nombre: 'Lomas' }))),
    participante(8, 5, null, null), participante(9, 6, null, null, { puesto: 1 }),
  ];
  const generales = [{ disciplina_id: 7, puesto: 1, departamental_id: 9, nombre: 'Azul', origen: 'MANUAL', prueba_id: null }];
  const porCategoria = [{ disciplina_id: 4, puesto: 3, departamental_id: 10, nombre: 'Lomas', origen: 'MANUAL', prueba_id: 19 }];
  const conexion = { async query(sql, params) {
    if (sql.includes('FROM olimpiada WHERE')) return [[edicion]];
    if (sql.includes('FROM information_schema')) {
      return [[sql.includes("TABLE_NAME = 'olimpiada_prueba_ganador'") ? { tablas: 1 } : { columna: 1, tablas: 2, columnas: 5 }]];
    }
    if (sql.includes('FROM olimpiada_disciplina_config c')) return [disciplinas];
    if (sql.includes('FROM olimpiada_medalla m')) {
      assert.match(sql, /m\.origen <> 'MANUAL' OR m\.prueba_id IS NULL/);
      return [[...generales, ...porCategoria.filter(m => m.prueba_id === null)]];
    }
    if (sql.includes('FROM olimpiada_prueba_participante p')) return [personas.filter(p => params[1].includes(p.disciplina_id))];
    if (sql.includes('FROM olimpiada_prueba_ganador')) return [[{ id: 1, disciplina_id: 5, prueba_id: 30, participante_id: 8, puesto: 2 }]];
    if (/FROM olimpiada_prueba\s+WHERE/.test(sql)) {
      assert.match(sql, /eliminado = 0 AND estado = 'FINALIZADA' ORDER BY orden, id/);
      return [pruebas.filter(p => p.estado === 'FINALIZADA' && params[1].includes(p.disciplina_id))];
    }
    if (/FROM olimpiada_(?:torneo|equipo|partido|voluntario|config)|FROM departamental/.test(sql)) return [[]];
    assert.fail(`Consulta no prevista: ${sql}`);
  } };
  const modulo = require.resolve('../api/connection/connection');
  require.cache[modulo] = { id: modulo, filename: modulo, loaded: true, exports: { promise: () => conexion } };
  const app = express();
  app.use(require('../api/routes/olimpiadas-publico'));
  const servidor = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { servidor.closeAllConnections(); servidor.close(resolve); }));
  const fixture = async () => {
    const respuesta = await fetch(`http://127.0.0.1:${servidor.address().port}/olimpiadas/publico/7/fixture`);
    assert.equal(respuesta.status, 200);
    return (await respuesta.json()).disciplinas;
  };

  const [natacion, pesca, poker, tenis] = await fixture();
  assert.deepEqual(natacion.podios_categorias.map(c => [c.id, c.nombre]), [[19, 'Femenino 25 mts.'], [26, 'Postas 100mts.'], [13, 'Masculino 50 mts.']]);
  const [individual, posta] = natacion.podios_categorias;
  assert.deepEqual(individual.puestos.map(p => [p.puesto, p.ganadores.map(g => g.detalle)]), [[1, ['Persona 1', 'Persona 2']], [3, ['Persona 3']]]);
  assert.deepEqual(posta.puestos.map(p => [p.puesto, p.nombre, p.ganadores.map(g => g.detalle)]),
    [[1, 'Oro', ['Persona 100', 'Persona 101', 'Persona 102', 'Persona 103']],
      [2, 'Plata', ['Persona 104', 'Persona 105', 'Persona 106', 'Persona 107']],
      [3, 'Bronce', ['Persona 108', 'Persona 109', 'Persona 110', 'Persona 111']]]);
  assert.deepEqual(posta.puestos[0].ganadores[3].departamentales, [{ id: 10, nombre: 'Lomas' }]);
  assert.doesNotMatch(JSON.stringify(natacion.podios_categorias), /inscripcion|tiempo_ms|medalla_id|MANUAL/);
  assert.equal(natacion.podio[0].ganadores.filter(g => g.detalle?.startsWith('Postas 100mts. · ')).length, 4);
  assert.deepEqual(pesca.podios_categorias[0].puestos.map(p => [p.puesto, p.ganadores[0].detalle]), [[2, 'Persona 8']]);
  assert.deepEqual(poker.podio.map(p => [p.puesto, p.ganadores[0].detalle]), [[1, 'Persona 9']]);
  assert.equal(poker.podios_categorias, undefined);
  assert.equal(tenis.podios_categorias, undefined);
  assert.equal(tenis.podio[0].ganadores[0].nombre, 'Azul');

  generales.push({ disciplina_id: 4, puesto: 2, departamental_id: 10, nombre: 'Lomas', origen: 'MANUAL', prueba_id: null });
  const [manual] = await fixture();
  assert.equal(manual.podios_categorias, undefined);
  assert.deepEqual(manual.podio.map(p => [p.puesto, p.ganadores[0].nombre]), [[2, 'Lomas']]);
});
