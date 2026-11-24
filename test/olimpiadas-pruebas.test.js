const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../api/services/olimpiadas-pruebas');

test('el formato sugerido reconoce las disciplinas que no se juegan 1 contra 1', () => {
  assert.equal(P.formatoSugerido('Maratón'), 'TIEMPO');
  assert.equal(P.formatoSugerido('Natación'), 'TIEMPO');
  assert.equal(P.formatoSugerido('Pesca'), 'PESCA');
  assert.equal(P.formatoSugerido('Poker'), 'MESAS');
  assert.equal(P.formatoSugerido('Póker'), 'MESAS');
  for (const nombre of ['Fútbol 5 Masculino', 'Ajedrez', 'Truco', 'Pelota Paleta', 'Voley playa Mixto']) assert.equal(P.formatoSugerido(nombre), 'PARTIDOS');
});

test('un tiempo se lee en varios formatos y se guarda en milésimas', () => {
  assert.equal(P.leerTiempo('1:02:03'), 3723000);
  assert.equal(P.leerTiempo('1:02:03,45'), 3723450);
  assert.equal(P.leerTiempo('32:05'), 1925000);
  assert.equal(P.leerTiempo('32:05.4'), 1925400);
  assert.equal(P.leerTiempo('58,30'), 58300);
  assert.equal(P.leerTiempo('125:00'), 7500000, 'los minutos pueden pasar de 59 si no hay horas');
  assert.equal(P.leerTiempo(1925000), 1925000);
  assert.equal(P.leerTiempo(undefined), undefined);
  assert.equal(P.leerTiempo(null), null);
  assert.equal(P.leerTiempo('  '), null);
  for (const invalido of ['veinte', '1:75:00', '10:61', '-5', 0, '0:00', 12.5, {}, '1:2:3:4']) {
    assert.throws(() => P.leerTiempo(invalido), error => error.statusCode === 400, `debería rechazar ${JSON.stringify(invalido)}`);
  }
});

test('el tiempo se muestra con horas sólo si hacen falta y con decimales sólo si los hay', () => {
  assert.equal(P.formatearTiempo(3723000), '1:02:03');
  assert.equal(P.formatearTiempo(3723450), '1:02:03,45');
  assert.equal(P.formatearTiempo(1925000), '32:05');
  assert.equal(P.formatearTiempo(58300), '0:58,30');
  assert.equal(P.formatearTiempo(58301), '0:58,301');
  assert.equal(P.formatearTiempo(null), null);
});

test('el peso de pesca llega en kilos o en gramos y se guarda en gramos', () => {
  assert.equal(P.leerPeso({ peso_kg: '4,350' }), 4350);
  assert.equal(P.leerPeso({ peso_kg: '3.4' }), 3400);
  assert.equal(P.leerPeso({ peso_kg: 2 }), 2000);
  assert.equal(P.leerPeso({ peso_gramos: 6000 }), 6000);
  assert.equal(P.leerPeso({ peso_kg: '' }), null);
  assert.equal(P.leerPeso({}), undefined);
  assert.equal(P.formatearPeso(4350), '4,350 kg');
  assert.throws(() => P.leerPeso({ peso_kg: 'mucho' }), error => error.statusCode === 400);
  assert.throws(() => P.leerPeso({ peso_kg: '4,3501' }), error => error.statusCode === 400);
  assert.throws(() => P.leerPiezas('3,5'), error => error.statusCode === 400);
  assert.equal(P.leerPiezas('12'), 12);
  assert.equal(P.leerPiezas(0), 0);
});

const persona = (id, extra) => ({ id, nombre: `P${id}`, disciplina_id: 1, prueba_id: 10, orden: id, ...extra });

test('por tiempo: de menor a mayor, medallas a los tres primeros y sin tiempo al final', () => {
  const lista = P.clasificarTiempo([
    persona(1, { tiempo_ms: 300000 }), persona(2, { tiempo_ms: null }), persona(3, { tiempo_ms: 250000 }),
    persona(4, { tiempo_ms: 400000 }), persona(5, { tiempo_ms: 350000 }),
  ]);
  assert.deepEqual(lista.map(p => p.id), [3, 1, 5, 4, 2]);
  assert.deepEqual(lista.map(p => p.puesto), [1, 2, 3, 4, null]);
  assert.deepEqual(lista.map(p => p.medalla), ['ORO', 'PLATA', 'BRONCE', null, null]);
  assert.equal(lista[0].tiempo, '4:10');
});

test('por tiempo: los empates comparten puesto y medalla, y el siguiente puesto salta', () => {
  const lista = P.clasificarTiempo([persona(1, { tiempo_ms: 100 }), persona(2, { tiempo_ms: 200 }), persona(3, { tiempo_ms: 200 }), persona(4, { tiempo_ms: 300 })]);
  assert.deepEqual(lista.map(p => p.puesto), [1, 2, 2, 4]);
  assert.deepEqual(lista.map(p => p.medalla), ['ORO', 'PLATA', 'PLATA', null]);
});

test('pesca: una tabla por piezas y otra por peso; el empate en una se define por la otra', () => {
  const lista = P.clasificarPesca([
    persona(1, { piezas: 5, peso_gramos: 2100 }), persona(2, { piezas: 5, peso_gramos: 3400 }),
    persona(3, { piezas: 2, peso_gramos: 6000 }), persona(4, { piezas: 0, peso_gramos: 0 }), persona(5, { piezas: null, peso_gramos: null }),
  ]);
  const de = id => lista.find(p => p.id === id);
  assert.deepEqual([de(2).puesto_piezas, de(1).puesto_piezas, de(3).puesto_piezas, de(4).puesto_piezas, de(5).puesto_piezas], [1, 2, 3, 4, null]);
  assert.deepEqual([de(3).puesto_peso, de(2).puesto_peso, de(1).puesto_peso], [1, 2, 3]);
  assert.equal(de(3).medalla_peso, 'ORO');
  assert.equal(de(2).medalla_piezas, 'ORO');
  assert.equal(de(4).medalla_piezas, null, 'sin piezas no hay medalla aunque quede entre los tres primeros');
  assert.equal(de(2).peso, '3,400 kg');
  assert.deepEqual(lista.map(p => p.id), [2, 1, 3, 4, 5], 'la lista sale ordenada por piezas');
});

test('pesca: un empate completo comparte el puesto', () => {
  const lista = P.clasificarPesca([persona(1, { piezas: 3, peso_gramos: 1000 }), persona(2, { piezas: 3, peso_gramos: 1000 }), persona(3, { piezas: 1, peso_gramos: 500 })]);
  assert.deepEqual(lista.map(p => p.puesto_piezas), [1, 1, 3]);
  assert.deepEqual(lista.map(p => p.medalla_piezas), ['ORO', 'ORO', 'BRONCE']);
});

const disciplina = formato => ({ id: 1, nombre: 'X', formato });

test('póker: las mesas respetan el orden de los asientos y el podio es el elegido a mano', () => {
  const pruebas = [{ id: 10, disciplina_id: 1, nombre: 'Mesa 1', estado: 'EN_JUEGO', orden: 1 }, { id: 11, disciplina_id: 1, nombre: 'Mesa 2', estado: 'PROGRAMADA', orden: 2 }];
  const jugadores = [
    persona(1, { orden: 2, puesto: 3 }), persona(2, { orden: 1 }), persona(3, { prueba_id: 11, puesto: 1 }),
    persona(4, { prueba_id: null }), persona(5, { prueba_id: null, puesto: 2 }),
  ];
  const gestion = P.armarDisciplina(disciplina('MESAS'), pruebas, jugadores, { gestion: true });
  assert.equal(gestion.grupo, 'mesa');
  assert.equal(gestion.en_juego, 1);
  assert.deepEqual(gestion.pruebas[0].participantes.map(p => p.id), [2, 1]);
  assert.deepEqual(gestion.podio.map(p => [p.puesto, p.id, p.medalla]), [[1, 3, 'ORO'], [2, 5, 'PLATA'], [3, 1, 'BRONCE']]);
  assert.deepEqual(gestion.sin_mesa.map(p => p.id), [4, 5]);
  assert.equal(gestion.participantes, 5);

  const publico = P.armarDisciplina(disciplina('MESAS'), pruebas, jugadores);
  assert.equal(publico.sin_mesa, undefined, 'con mesas armadas el portal muestra sólo a los que están sentados');
  assert.equal('inscripcion_id' in publico.pruebas[0].participantes[0], false);
  assert.equal(publico.podio.length, 3, 'un ganador sin mesa sigue en el podio');

  const sinMesas = P.armarDisciplina(disciplina('MESAS'), [], jugadores);
  assert.equal(sinMesas.sin_mesa.length, 5, 'antes de armar las mesas el portal muestra quiénes juegan');
});

test('una disciplina por tiempo arma sus categorías sin mezclar participantes ni campos de otros formatos', () => {
  const pruebas = [{ id: 10, disciplina_id: 1, nombre: 'Damas', estado: 'FINALIZADA', orden: 2 }, { id: 11, disciplina_id: 1, nombre: 'Caballeros', estado: 'PROGRAMADA', orden: 1 }, { id: 12, disciplina_id: 2, nombre: 'Otra', estado: 'PROGRAMADA', orden: 1 }];
  const participantes = [persona(1, { tiempo_ms: 2000, piezas: 9 }), persona(2, { tiempo_ms: 1000 }), persona(3, { prueba_id: 11 }), { ...persona(4, { prueba_id: 12 }), disciplina_id: 2 }];
  const d = P.armarDisciplina(disciplina('TIEMPO'), pruebas, participantes, { gestion: true });
  assert.deepEqual(d.pruebas.map(p => p.nombre), ['Caballeros', 'Damas']);
  assert.deepEqual(d.pruebas[1].participantes.map(p => [p.id, p.puesto, p.medalla]), [[2, 1, 'ORO'], [1, 2, 'PLATA']]);
  assert.equal(d.pruebas[1].con_resultado, 2);
  assert.equal(d.pruebas[0].con_resultado, 0);
  assert.equal('piezas' in d.pruebas[1].participantes[0], false);
  assert.equal(d.participantes, 3);
  assert.equal(d.podio, undefined);
  assert.equal(d.grupo, 'categoría');
});

test('sin la migración aplicada las lecturas responden vacío en lugar de romper el fixture', async () => {
  const rutas = require('../api/routes/olimpiadas-pruebas');
  rutas.__test.reiniciarEsquema();
  const consultas = [];
  const conexion = { query: async sql => { consultas.push(sql); return [[{ columna: 0, tablas: 0 }]]; } };
  assert.deepEqual(await rutas.listarPruebas(conexion, 1), []);
  assert.equal((await rutas.resumenDisciplinas(conexion, 1)).size, 0);
  assert.deepEqual(await rutas.pruebasEnJuego(conexion, 1), []);
  assert.equal(consultas.length, 1, 'se pregunta una sola vez y no se consulta ninguna tabla nueva');
  assert.match(consultas[0], /information_schema/);
  rutas.__test.reiniciarEsquema();
});

test('la migración crea lo nuevo una sola vez y asigna el formato sólo al crear la columna', async () => {
  const { migrar } = require('../scripts/migrar-olimpiadas-pruebas');
  const crear = existe => {
    const sentencias = [];
    return {
      sentencias,
      query: async (sql, params = []) => {
        sentencias.push(sql);
        if (/information_schema/.test(sql)) return [existe ? [{}] : []];
        if (/^SELECT id, nombre FROM olimpiada_disciplina/.test(sql)) return [[{ id: 1, nombre: 'Maratón' }, { id: 2, nombre: 'Poker' }, { id: 3, nombre: 'Truco' }]];
        if (/SELECT DATABASE\(\)/.test(sql)) return [[{ nombre: 'db' }]];
        if (/FROM mysql\.user/.test(sql)) return [[{ User: 'miajb_runtime', Host: '%' }]];
        return [{ affectedRows: 1 }, params];
      },
    };
  };
  const vacia = crear(false);
  const primera = await migrar(vacia, true);
  assert.equal(primera.pendientes.length, 3);
  assert.equal(vacia.sentencias.filter(s => /^UPDATE olimpiada_disciplina SET formato_competencia/.test(s)).length, 2, 'maratón y póker; el truco queda por partidos');
  assert.equal(vacia.sentencias.filter(s => /^GRANT/.test(s)).length, 2);

  const lista = crear(true);
  const segunda = await migrar(lista, true);
  assert.deepEqual(segunda.pendientes, []);
  assert.equal(lista.sentencias.some(s => /ALTER TABLE|CREATE TABLE|UPDATE olimpiada_disciplina/.test(s)), false, 'no vuelve a tocar lo que la administración haya ajustado');

  const consulta = crear(false);
  await migrar(consulta, false);
  assert.equal(consulta.sentencias.some(s => /ALTER TABLE|CREATE TABLE|UPDATE|GRANT/.test(s)), false, 'el modo consulta no cambia nada');
});
