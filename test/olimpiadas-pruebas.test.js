const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../api/services/olimpiadas-pruebas');

test('fixture: premia las categorías finalizadas aunque sus resultados no sumen al medallero', async () => {
  const { premiosParaFixture } = require('../api/routes/olimpiadas-pruebas');
  const tiempos = [
    { id: 1, disciplina_id: 4, prueba_id: 10, nombre: 'Ana', departamental_id: 3, departamental_nombre: 'Azul', tiempo_ms: 200 },
    { id: 2, disciplina_id: 4, prueba_id: 10, nombre: 'Sol', departamental_id: 5, departamental_nombre: 'Tandil', tiempo_ms: 250 },
    { id: 3, disciplina_id: 4, prueba_id: 11, nombre: 'Participante en juego', departamental_id: 5, tiempo_ms: 10 },
  ];
  const conexion = { async query(sql, params) {
    assert.deepEqual(params, [7, [4]]);
    if (sql.includes('FROM olimpiada_prueba_participante')) return [tiempos];
    assert.match(sql, /estado = 'FINALIZADA'/);
    return [[{ id: 10, disciplina_id: 4, nombre: '50 metros', orden: 1, suma_medallero: 'NADA' }]];
  } };
  const { medallas, categorias } = await premiosParaFixture(conexion, 7, [{ id: 4, formato: 'TIEMPO' }]);
  assert.deepEqual(medallas.map(m => [m.disciplina_id, m.puesto, m.nombre, m.detalle]),
    [[4, 1, 'Azul', '50 metros · Ana'], [4, 2, 'Tandil', '50 metros · Sol']]);
  assert.deepEqual(categorias.map(c => [c.id, c.nombre, c.medallas.map(m => m.detalle)]), [[10, '50 metros', ['Ana', 'Sol']]]);
});

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

test('pesca: la marca de un ganador es un texto corto y libre', () => {
  assert.equal(P.leerMarca('  12   piezas '), '12 piezas');
  assert.equal(P.leerMarca(15), '15');
  assert.equal(P.leerMarca(''), null);
  assert.equal(P.leerMarca(null), null);
  assert.equal(P.leerMarca(undefined), undefined);
  assert.equal(P.leerMarca('x'.repeat(60)).length, 60);
  assert.throws(() => P.leerMarca('x'.repeat(61)), error => error.statusCode === 400);
  assert.throws(() => P.leerMarca({}), error => error.statusCode === 400);
});

test('pesca: los ganadores de una categoría llegan como tres lugares y alguno puede quedar sin definir', () => {
  const id = valor => (Number.isInteger(Number(valor)) && Number(valor) > 0 ? Number(valor) : null);
  assert.deepEqual(P.leerGanadores([{ participante_id: 7, marca: '4,350 kg' }, null, { participante_id: '9' }], id),
    [{ puesto: 1, participante_id: 7, marca: '4,350 kg' }, { puesto: 3, participante_id: 9, marca: null }]);
  assert.deepEqual(P.leerGanadores([], id), []);
  assert.deepEqual(P.leerGanadores([{ participante_id: null, marca: 'sin dueño' }, 5], id), [{ puesto: 2, participante_id: 5, marca: null }]);
  assert.throws(() => P.leerGanadores([{ participante_id: 7 }, { participante_id: 7 }], id), error => error.statusCode === 400, 'la misma persona en dos puestos');
  assert.throws(() => P.leerGanadores([1, 2, 3, 4], id), error => error.statusCode === 400);
  assert.throws(() => P.leerGanadores('7', id), error => error.statusCode === 400);
  assert.throws(() => P.leerGanadores([{ participante_id: 'abc' }], id), error => error.statusCode === 400);
  assert.equal(P.describirGanadores([{ puesto: 2, nombre: 'Beto' }, { puesto: 1, nombre: 'Ana', marca: '12 piezas' }]), '1.º: Ana (12 piezas) · 2.º: Beto');
});

test('el día y la hora de una disciplina son los que comparten sus categorías', () => {
  assert.deepEqual(P.horarioComun([]), { fecha: null, hora_inicio: null, mixto: false });
  assert.deepEqual(P.horarioComun([{ fecha: '2026-11-28', hora_inicio: '10:00:00' }, { fecha: '2026-11-28', hora_inicio: '10:00' }]),
    { fecha: '2026-11-28', hora_inicio: '10:00', mixto: false });
  assert.deepEqual(P.horarioComun([{ fecha: null, hora_inicio: null }, { fecha: '2026-11-28', hora_inicio: '10:00' }]),
    { fecha: '2026-11-28', hora_inicio: '10:00', mixto: true }, 'una categoría sin horario se nota');
  assert.deepEqual(P.horarioComun([{ fecha: null, hora_inicio: null }]), { fecha: null, hora_inicio: null, mixto: false });
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

test('pesca: un solo listado de participantes para todas las categorías y ganadores elegidos a mano', () => {
  const pruebas = [
    { id: 10, disciplina_id: 1, nombre: 'Mayor peso total', estado: 'FINALIZADA', orden: 2, suma_medallero: 'PESO' },
    { id: 11, disciplina_id: 1, nombre: 'Mayor cantidad de piezas', estado: 'FINALIZADA', orden: 1 },
  ];
  // El tercero quedó cargado dentro de una categoría (antes de la migración): es igual un participante de la disciplina
  const pescadores = [
    persona(1, { prueba_id: null, departamental_id: 5, departamental_nombre: 'Azul' }), persona(2, { prueba_id: null, piezas: 4 }), persona(3, { orden: 0 }),
  ];
  const ganadores = [
    { id: 1, prueba_id: 10, participante_id: 2, puesto: 1, marca: '15 kg' }, { id: 2, prueba_id: 10, participante_id: 1, puesto: 3, marca: null },
    { id: 3, prueba_id: 11, participante_id: 2, puesto: 1, marca: '12 piezas' }, { id: 4, prueba_id: 11, participante_id: 99, puesto: 2, marca: null },
    { id: 5, prueba_id: 77, participante_id: 1, puesto: 1, marca: null },
  ];
  const d = P.armarDisciplina(disciplina('PESCA'), pruebas, pescadores, { gestion: true, ganadores });
  assert.equal(d.grupo, 'categoría');
  assert.equal(d.participantes, 3);
  assert.deepEqual(d.competidores.map(p => [p.id, p.prueba_id]), [[3, null], [1, null], [2, null]]);
  assert.deepEqual(d.pruebas.map(p => p.nombre), ['Mayor cantidad de piezas', 'Mayor peso total']);
  assert.deepEqual(d.pruebas[1].ganadores.map(g => [g.puesto, g.medalla, g.participante_id, g.marca]), [[1, 'ORO', 2, '15 kg'], [3, 'BRONCE', 1, null]]);
  assert.equal(d.pruebas[1].ganadores[1].departamental_nombre, 'Azul');
  assert.deepEqual(d.pruebas[0].ganadores.map(g => g.participante_id), [2], 'un ganador que ya no figura entre los participantes no se muestra');
  assert.equal(d.pruebas[1].con_resultado, 2);
  assert.deepEqual(d.pruebas[1].participantes, [], 'las personas son de la disciplina, no de la categoría');
  assert.equal(d.pruebas[1].suma_medallero, 'TODO', 'lo que quedó de las dos tablas cuenta como «suma»');
  assert.equal(d.podio, undefined);

  const publico = P.armarDisciplina(disciplina('PESCA'), pruebas, pescadores, { ganadores });
  assert.equal('inscripcion_id' in publico.competidores[0], false);
  assert.equal('piezas' in publico.competidores[2], false, 'ya no se publican piezas ni peso por persona');
  assert.equal('suma_medallero' in publico.pruebas[0], false);
  assert.deepEqual(P.armarDisciplina(disciplina('PESCA'), pruebas, pescadores).pruebas.map(p => p.ganadores), [[], []], 'sin la tabla de ganadores, las categorías salen vacías');
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
  assert.equal(d.competidores, undefined);
  assert.equal(d.pruebas[0].ganadores, undefined);
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
  // `existe`: qué responde information_schema a «¿existe esta tabla, columna o índice?»
  const crear = existe => {
    const sentencias = [];
    return {
      sentencias,
      query: async (sql, params = []) => {
        sentencias.push(sql);
        if (/information_schema/.test(sql)) return [(typeof existe === 'function' ? existe(sql, params) : existe) ? [{}] : []];
        if (/^SELECT id, nombre FROM olimpiada_disciplina/.test(sql)) return [[{ id: 1, nombre: 'Maratón' }, { id: 2, nombre: 'Poker' }, { id: 3, nombre: 'Truco' }]];
        if (/FROM olimpiada_prueba_participante p INNER JOIN olimpiada_disciplina/.test(sql)) return [[]];
        if (/COUNT\(\*\) AS cantidad FROM olimpiada_medalla/.test(sql)) return [[{ cantidad: 0 }]];
        if (/SELECT DATABASE\(\)/.test(sql)) return [[{ nombre: 'db' }]];
        if (/FROM mysql\.user/.test(sql)) return [[{ User: 'miajb_runtime', Host: '%' }]];
        return [{ affectedRows: 1 }, params];
      },
    };
  };
  const vacia = crear(false);
  const primera = await migrar(vacia, true);
  // 3 tablas + el formato de la disciplina + 4 columnas del medallero + su clave única
  // Las dos columnas del medallero de categorías ya vienen en la tabla nueva.
  assert.equal(primera.pendientes.length, 9);
  assert.equal(vacia.sentencias.filter(s => /CREATE TABLE IF NOT EXISTS olimpiada_prueba_ganador/.test(s)).length, 1);
  assert.equal(vacia.sentencias.some(s => /ALTER TABLE `olimpiada_prueba` ADD COLUMN/.test(s)), false);
  assert.equal(vacia.sentencias.filter(s => /ADD UNIQUE KEY `uq_oli_medalla_origen`/.test(s)).length, 1);
  assert.equal(vacia.sentencias.filter(s => /^UPDATE olimpiada_disciplina SET formato_competencia/.test(s)).length, 2, 'maratón y póker; el truco queda por partidos');
  assert.equal(vacia.sentencias.filter(s => /^GRANT/.test(s)).length, 3);

  const lista = crear(true);
  const segunda = await migrar(lista, true);
  assert.deepEqual(segunda.pendientes, []);
  assert.equal(lista.sentencias.some(s => /ALTER TABLE|CREATE TABLE|^\s*(UPDATE|DELETE) /.test(s)), false, 'no vuelve a tocar lo que la administración haya ajustado');

  // Una base que ya tenía la primera tanda (tablas y formato): sólo se agrega lo del medallero
  const primeraTanda = crear((sql, params) => {
    if (/information_schema\.TABLES/.test(sql)) return true;
    if (/information_schema\.COLUMNS/.test(sql)) return params[1] === 'formato_competencia';
    return params[1] === 'uq_oli_medalla'; // sólo existe la clave única anterior
  });
  const tercera = await migrar(primeraTanda, true);
  assert.equal(tercera.pendientes.length, 7, '2 columnas en la categoría + 4 en olimpiada_medalla + la clave única');
  assert.equal(primeraTanda.sentencias.some(s => /CREATE TABLE|UPDATE olimpiada_disciplina SET formato_competencia/.test(s)), false, 'no recrea ni reasigna formatos');
  assert.equal(primeraTanda.sentencias.filter(s => /ADD COLUMN `suma_medallero`/.test(s)).length, 1);
  assert.equal(primeraTanda.sentencias.filter(s => /ADD COLUMN `medallero_manual`/.test(s)).length, 1);
  assert.equal(primeraTanda.sentencias.filter(s => /ADD UNIQUE KEY `uq_oli_medalla_origen`.*DROP INDEX `uq_oli_medalla`/.test(s)).length, 1, 'la clave nueva entra y la anterior sale en el mismo paso');

  const consulta = crear(false);
  await migrar(consulta, false);
  assert.equal(consulta.sentencias.some(s => /ALTER TABLE|CREATE TABLE|UPDATE|GRANT/.test(s)), false, 'el modo consulta no cambia nada');
});

test('la migración pasa a los participantes de pesca al listado de la disciplina y quita los repetidos', async () => {
  const { migrar, planParticipantesPesca } = require('../scripts/migrar-olimpiadas-pruebas');
  const fila = (id, pruebaId, nombre, departamentalId, inscripcionId = null) =>
    ({ id, olimpiada_id: 2, disciplina_id: 29, prueba_id: pruebaId, nombre, departamental_id: departamentalId, inscripcion_id: inscripcionId });
  // Ana quedó cargada en dos categorías (con otro acento) y Beto, con la misma inscripción y otro nombre
  const filas = [fila(1, 2, 'Ana Ruiz', 5), fila(2, 2, 'Beto Paz', 6, 40), fila(3, 3, 'ana ruíz', 5), fila(4, 3, 'Roberto Paz', 6, 40), fila(5, 3, 'Carla Sol', null)];
  assert.deepEqual(planParticipantesPesca(filas), { mover: [{ id: 1, orden: 1 }, { id: 2, orden: 2 }, { id: 5, orden: 3 }], repetidos: [3, 4] });
  assert.deepEqual(planParticipantesPesca([fila(1, null, 'Ana Ruiz', 5), fila(2, null, 'Ana Ruiz', 5)]), { mover: [], repetidos: [] },
    'una disciplina que ya tiene a todos en su listado no se toca');
  assert.deepEqual(planParticipantesPesca([fila(9, null, 'Ana Ruiz', 5), fila(1, 2, 'Ana Ruiz', 5), { ...fila(7, 4, 'Ana Ruiz', 5), disciplina_id: 30 }]),
    { mover: [{ id: 9, orden: 1 }, { id: 7, orden: 1 }], repetidos: [1] }, 'quien ya estaba en el listado manda; cada disciplina por separado');

  const crear = () => {
    const sentencias = [];
    return {
      sentencias,
      beginTransaction: async () => { sentencias.push('BEGIN'); },
      commit: async () => { sentencias.push('COMMIT'); },
      rollback: async () => { sentencias.push('ROLLBACK'); },
      query: async (sql, params = []) => {
        sentencias.push(sql);
        if (/information_schema/.test(sql)) return [[{}]];
        if (/FROM olimpiada_prueba_participante p INNER JOIN olimpiada_disciplina/.test(sql)) return [filas];
        if (/COUNT\(\*\) AS cantidad FROM olimpiada_medalla/.test(sql)) return [[{ cantidad: 2 }]];
        if (/SELECT DATABASE\(\)/.test(sql)) return [[{ nombre: 'db' }]];
        if (/FROM mysql\.user/.test(sql)) return [[]];
        return [{ affectedRows: 1 }, params];
      },
    };
  };
  const consulta = crear();
  const informe = await migrar(consulta, false);
  assert.deepEqual(informe.pendientes, [
    'Pesca: pasar 3 participante(s) al listado de la disciplina y quitar 2 repetido(s)',
    'Pesca: quitar 2 medalla(s) automáticas de las tablas de piezas y peso',
  ]);
  assert.equal(consulta.sentencias.some(s => /^(UPDATE|DELETE|BEGIN)/.test(s)), false, 'el modo consulta no cambia nada');

  const aplicada = crear();
  await migrar(aplicada, true);
  const cambios = aplicada.sentencias.filter(s => /^(UPDATE|DELETE|BEGIN|COMMIT)/.test(s.trim())).map(s => s.trim().split('\n')[0]);
  assert.deepEqual(cambios, [
    'BEGIN',
    'UPDATE olimpiada_prueba_participante SET eliminado = 1 WHERE id IN (?)',
    'UPDATE olimpiada_prueba_participante SET prueba_id = NULL, orden = ? WHERE id = ?',
    'UPDATE olimpiada_prueba_participante SET prueba_id = NULL, orden = ? WHERE id = ?',
    'UPDATE olimpiada_prueba_participante SET prueba_id = NULL, orden = ? WHERE id = ?',
    'COMMIT',
    'DELETE m FROM olimpiada_medalla m INNER JOIN olimpiada_disciplina d ON d.id = m.disciplina_id',
  ]);
});

// ---------------------------------------------------------------------------
// Medallero por departamental
// ---------------------------------------------------------------------------
const de = (id, departamental, extra) => persona(id, { departamental_id: departamental, departamental_nombre: `Dep ${departamental}`, ...extra });
const categoria = (id, nombre, suma = 'TODO') => ({ id, disciplina_id: 1, nombre, orden: id, suma_medallero: suma });

test('medallero por tiempo: cada categoría suma sus tres primeros, una medalla por persona', () => {
  const pruebas = [categoria(10, 'Femenino'), categoria(11, 'Masculino')];
  const participantes = [
    de(1, 5, { tiempo_ms: 100 }), de(2, 6, { tiempo_ms: 200 }), de(3, 7, { tiempo_ms: 300 }), de(4, 8, { tiempo_ms: 400 }), de(5, 9, { tiempo_ms: null }),
    de(6, 5, { prueba_id: 11, tiempo_ms: 150 }), de(7, 5, { prueba_id: 11, tiempo_ms: 250 }),
  ];
  const medallas = P.medallasDeDisciplina('TIEMPO', pruebas, participantes);
  assert.deepEqual(medallas.map(m => [m.puesto, m.departamental_id, m.prueba_id, m.clave_origen]),
    [[1, 5, 10, 'P1'], [1, 5, 11, 'P6'], [2, 5, 11, 'P7'], [2, 6, 10, 'P2'], [3, 7, 10, 'P3']]);
  assert.equal(medallas[0].detalle, 'Femenino · P1');
  assert.equal(new Set(medallas.map(m => `${m.puesto}:${m.departamental_id}:${m.clave_origen}`)).size, medallas.length, 'dos oros de la misma departamental no chocan');
});

test('medallero por tiempo: un empate reparte dos medallas iguales y quien no tiene departamental no suma', () => {
  const medallas = P.medallasDeDisciplina('TIEMPO', [categoria(10, 'Libres')], [
    de(1, 5, { tiempo_ms: 100 }), de(2, 5, { tiempo_ms: 100 }), de(3, null, { tiempo_ms: 150 }), de(4, 7, { tiempo_ms: 200 }),
  ]);
  // 1.º, 1.º, (3.º sin departamental), 4.º: el cuarto queda fuera con tres puestos puntuados
  assert.deepEqual(medallas.map(m => [m.puesto, m.participante_id]), [[1, 1], [1, 2]]);
  const conCinco = P.medallasDeDisciplina('TIEMPO', [categoria(10, 'Libres')], [
    de(1, 5, { tiempo_ms: 100 }), de(2, 5, { tiempo_ms: 100 }), de(3, null, { tiempo_ms: 150 }), de(4, 7, { tiempo_ms: 200 }),
  ], { maxPuesto: 5 });
  assert.deepEqual(conCinco.map(m => [m.puesto, m.participante_id]), [[1, 1], [1, 2], [4, 4]], 'si la edición puntúa más puestos, también suman');
});

test('natación de 25 y 50 metros aporta la mejor medalla por departamental, con las postas y el legado por separado', () => {
  const prueba = (id, nombre, descripcion = null, disciplina_nombre = 'Natación') => ({ id, nombre, descripcion, disciplina_nombre });
  const pruebas = [prueba(1, 'Femenino C (40 a 49 años) 25mts.'), prueba(2, 'Masculino D', '50 metros libres'),
    prueba(3, 'Postas 50 mts'), prueba(4, 'Relevo 4 × 25 m'), prueba(5, '100 m'), prueba(6, '25 m', null, 'Maratón')];
  const individuales = new Set(pruebas.filter(P.esNatacion25o50).map(p => p.id));
  assert.deepEqual([...individuales], [1, 2]);
  const medalla = (id, prueba_id, departamental_id, puesto, origen = 'AUTO') => ({ id, prueba_id, departamental_id, puesto, origen });
  const medallas = [medalla(1, 1, 5, 2, 'MANUAL'), medalla(2, 2, 5, 1), medalla(3, 1, 5, 1, 'MANUAL'),
    medalla(4, 2, 7, 3), medalla(5, 3, 5, 1), medalla(6, null, 5, 1, 'MANUAL'), medalla(7, 6, 5, 2), medalla(8, 2, 5, 4)];
  assert.deepEqual(P.medallasComputables(medallas, individuales).map(m => m.id), [3, 4, 5, 6, 7, 8]);
  assert.equal(medallas.length, 8, 'las adjudicaciones originales se conservan');
});

test('medallero de pesca: cada categoría suma a sus ganadores, y la misma persona puede ganar dos', () => {
  const pruebas = [categoria(10, 'Mayor peso total'), categoria(11, 'Mayor cantidad de piezas'), categoria(12, 'Pieza de mayor peso', 'NADA')];
  const pescadores = [de(1, 5, { prueba_id: null }), de(2, 6, { prueba_id: null }), de(3, null, { prueba_id: null })];
  const ganadores = [
    { id: 1, prueba_id: 10, participante_id: 1, puesto: 1 }, { id: 2, prueba_id: 10, participante_id: 2, puesto: 2 }, { id: 3, prueba_id: 10, participante_id: 3, puesto: 3 },
    { id: 4, prueba_id: 11, participante_id: 1, puesto: 1 }, { id: 5, prueba_id: 12, participante_id: 2, puesto: 1 },
  ];
  const medallas = P.medallasDeDisciplina('PESCA', pruebas, pescadores, { ganadores });
  assert.deepEqual(medallas.map(m => [m.puesto, m.departamental_id, m.prueba_id, m.participante_id, m.criterio, m.clave_origen]),
    [[1, 5, 10, 1, null, 'P1:C10'], [1, 5, 11, 1, null, 'P1:C11'], [2, 6, 10, 2, null, 'P2:C10']],
    'no suman quien no tiene departamental ni la categoría marcada para no sumar');
  assert.equal(medallas[0].detalle, 'Mayor peso total · P1');
  assert.equal(new Set(medallas.map(m => `${m.puesto}:${m.departamental_id}:${m.clave_origen}`)).size, medallas.length, 'dos oros de la misma persona no chocan');
  assert.equal(P.medallasDeDisciplina('PESCA', pruebas, pescadores).length, 0, 'sin ganadores elegidos no hay medallas');
  assert.equal(P.medallasDeDisciplina('TIEMPO', [categoria(10, 'Promocional', 'NADA')], [de(1, 5, { tiempo_ms: 100 })]).length, 0);
});

test('medallero de póker: los tres ganadores elegidos a mano, estén o no sentados en una mesa', () => {
  const medallas = P.medallasDeDisciplina('MESAS', [{ id: 10, disciplina_id: 1, nombre: 'Mesa 1', orden: 1 }], [
    de(1, 5, { puesto: 2 }), de(2, 6, { puesto: null }), de(3, 7, { prueba_id: null, puesto: 1 }), de(4, null, { puesto: 3 }),
  ]);
  assert.deepEqual(medallas.map(m => [m.puesto, m.departamental_id, m.prueba_id, m.clave_origen]), [[1, 7, null, 'P3'], [2, 5, null, 'P1']]);
  assert.equal(medallas[0].detalle, 'P3');
});

test('qué suma al medallero: todo o nada', () => {
  assert.equal(P.leerSumaMedallero('nada'), 'NADA');
  assert.equal(P.leerSumaMedallero('TODO'), 'TODO');
  assert.equal(P.leerSumaMedallero(undefined), undefined);
  assert.equal(P.leerSumaMedallero(''), undefined);
  assert.throws(() => P.leerSumaMedallero('PESO'), error => error.statusCode === 400, 'las dos tablas de pesca ya no existen');
  assert.throws(() => P.leerSumaMedallero('ALGO'), error => error.statusCode === 400);
  assert.equal(P.sumaMedallero({ suma_medallero: 'PIEZAS' }), 'TODO');
  assert.equal(P.sumaMedallero({ suma_medallero: 'NADA' }), 'NADA');
  assert.equal(P.sumaMedallero({}), 'TODO');
});

test('un ajuste de puntos hecho a mano queda en el lugar aunque cambie quién lo ocupa', () => {
  const anteriores = [
    { puesto: 1, prueba_id: 10, criterio: null, puntos_manual: '0.00', participante_id: 1 },
    { puesto: 2, prueba_id: 10, criterio: null, puntos_manual: null, participante_id: 2 },
    { puesto: 1, prueba_id: 11, criterio: 'PESO', puntos_manual: 4, participante_id: 3 },
  ];
  const nuevas = P.heredarAjustes(anteriores, [
    { puesto: 1, prueba_id: 10, criterio: null, participante_id: 9 }, { puesto: 2, prueba_id: 10, criterio: null, participante_id: 1 },
    { puesto: 1, prueba_id: 11, criterio: 'PESO', participante_id: 3 }, { puesto: 1, prueba_id: 11, criterio: 'PIEZAS', participante_id: 3 },
  ]);
  assert.deepEqual(nuevas.map(m => m.puntos_manual), [0, null, 4, null]);
  assert.deepEqual(P.heredarAjustes([], [{ puesto: 1, prueba_id: 10, criterio: null }]).map(m => m.puntos_manual), [null]);
});

test('el detalle del medallero dice de qué categoría es cada medalla y deja separadas dos del mismo puesto', () => {
  const { agruparMedallasPorDisciplina, calcularTablaMedallero } = require('../api/services/olimpiadas-competicion');
  const medallas = [
    { id: 1, disciplina_id: 21, disciplina_nombre: 'Maratón', puesto: 1, departamental_id: 5, nombre: 'Azul', origen: 'AUTO', puntos_manual: null, detalle: 'Femenino · Ana' },
    { id: 2, disciplina_id: 21, disciplina_nombre: 'Maratón', puesto: 1, departamental_id: 5, nombre: 'Azul', origen: 'AUTO', puntos_manual: 0, detalle: 'Masculino · Beto' },
    { id: 3, disciplina_id: 21, disciplina_nombre: 'Maratón', puesto: 2, departamental_id: 6, nombre: 'Dolores', origen: 'AUTO', puntos_manual: null, detalle: 'Femenino · Carla' },
  ];
  const puntos = [{ puesto: 1, puntos: 10 }, { puesto: 2, puntos: 6 }, { puesto: 3, puntos: 3 }];
  const [maraton] = agruparMedallasPorDisciplina([{ id: 21, nombre: 'Maratón' }], medallas, { puntos });
  assert.equal(maraton.automatico, true);
  assert.deepEqual(maraton.puestos[0].ganadores.map(g => [g.nombre, g.detalle, g.departamentales[0].medalla_id, g.departamentales[0].puntos]),
    [['Azul', 'Femenino · Ana', 1, 10], ['Azul', 'Masculino · Beto', 2, 0]]);
  const tabla = calcularTablaMedallero(medallas, puntos);
  assert.deepEqual(tabla.map(f => [f.nombre, f.oro, f.plata, f.puntos]), [['Azul', 2, 0, 10], ['Dolores', 0, 1, 6]], 'los dos oros cuentan; el ajustado a 0 no suma puntos');
});

test('sin lo del medallero en la base, las categorías siguen funcionando y no se toca el medallero', async () => {
  const rutas = require('../api/routes/olimpiadas-pruebas');
  rutas.__test.reiniciarEsquema();
  const consultas = [];
  // La primera tanda de la migración está (columna + 2 tablas); la del medallero, no.
  const conexion = { query: async sql => {
    consultas.push(sql);
    if (/formato_competencia'\) AS columna/.test(sql)) return [[{ columna: 1, tablas: 2 }]];
    if (/AS columnas FROM information_schema/.test(sql)) return [[{ columnas: 0 }]];
    throw new Error('no debería consultar: ' + sql.slice(0, 60));
  } };
  const historial = async () => { throw new Error('no debería dejar historial'); };
  assert.equal(await rutas.sincronizarMedallas(conexion, { cabecera: {}, olimpiadaId: 1, disciplinaId: 21, historial }), false);
  assert.equal(consultas.length, 2);
  rutas.__test.reiniciarEsquema();
});
