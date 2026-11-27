const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

test('Natación: guarda, puntúa y restablece adjudicaciones por categoría sin perder la carga general', async t => {
  process.env.JWT_SECRET = 'medallero-categorias-test-only';
  const admin = { id: 1, rol: 'admin', rol_id: 1, habilitado: 'Y', modulo_olimpiadas: 1, requiere_cambio_clave: 0 };
  const edicion = { id: 7, habilitado: 'Y', publicada_publico: 1, medallero_publicado: 1, puntos_oro: 10, puntos_plata: 6, puntos_bronce: 4 };
  const disciplina = { id: 4, nombre: 'Natación', disciplina_id: 4, formato: 'TIEMPO' };
  const categorias = [
    { id: 10, nombre: '25mts.', suma_medallero: 'TODO', medallero_manual: 0 },
    { id: 20, nombre: '50mts.', suma_medallero: 'NADA', medallero_manual: 0 },
    { id: 30, nombre: 'Postas 100mts.', suma_medallero: 'TODO', medallero_manual: 0 },
  ].map(categoria => ({ ...categoria, disciplina_id: 4, disciplina_nombre: 'Natación' }));
  const departamento = new Map([[5, 'Azul'], [6, 'Dolores']]);
  const medallas = [{ id: 1, disciplina_id: 4, disciplina_nombre: 'Natación', prueba_id: null, puesto: 3, departamental_id: 6,
    nombre: 'Dolores', origen: 'MANUAL', puntos_manual: 3 }];
  let ultimoId = 1;
  const query = async (sql, args = []) => {
    if (/r\.nombre AS rol/.test(sql)) return [[admin]];
    if (/FROM olimpiada WHERE/.test(sql)) return [args[0] === 7 ? [edicion] : []];
    if (/FROM olimpiada_puntos_puesto/.test(sql)) return [[]];
    if (/FROM olimpiada_disciplina_config/.test(sql)) return [[disciplina]];
    if (/FROM olimpiada_disciplina WHERE id =/.test(sql)) return [[disciplina]];
    if (/information_schema/.test(sql)) return [[{ columna: 1, tablas: 2, columnas: sql.includes('medallero_manual') ? 1 : 5 }]];
    if (/FROM olimpiada_prueba pr/.test(sql)) return [sql.includes('FOR UPDATE') ? categorias.filter(p => p.id === args[0] && args[1] === 7 && args[2] === 4) : categorias];
    if (/^SELECT[\s\S]+FROM olimpiada_medalla m/.test(sql)) return [medallas.filter(medalla => !sql.includes('m.prueba_id = ?') || medalla.prueba_id === args[2])];
    if (/FROM olimpiada_equipo e/.test(sql) || /logo_archivo FROM departamental/.test(sql)) return [[]];
    if (/SELECT id, nombre FROM departamental WHERE id IN/.test(sql)) return [args[0].map(id => ({ id, nombre: departamento.get(id) }))];
    if (/DELETE FROM olimpiada_medalla WHERE id IN/.test(sql)) {
      for (const id of args[0]) medallas.splice(medallas.findIndex(medalla => medalla.id === id), 1);
    } else if (/^DELETE .*olimpiada_medalla/.test(sql)) {
      for (let indice = medallas.length - 1; indice >= 0; indice--) {
        if (medallas[indice].prueba_id === args[2] && medallas[indice].origen === 'MANUAL') medallas.splice(indice, 1);
      }
    } else if (/INSERT INTO olimpiada_medalla/.test(sql)) {
      const [, disciplina_id, puesto, departamental_id, equipo_id, puntos_manual, prueba_id] = args;
      medallas.push({ id: ++ultimoId, disciplina_id, disciplina_nombre: 'Natación', puesto, departamental_id, equipo_id, puntos_manual,
        prueba_id, origen: 'MANUAL', nombre: departamento.get(departamental_id), prueba_nombre: categorias.find(c => c.id === prueba_id)?.nombre });
    } else if (/UPDATE olimpiada_prueba SET medallero_manual/.test(sql)) {
      categorias.find(p => p.id === args[0]).medallero_manual = sql.includes('= 1') ? 1 : 0;
    } else if (!/INSERT INTO olimpiada_historial/.test(sql)) assert.fail(`Consulta no prevista: ${sql}`);
    return [{ affectedRows: 1 }];
  };
  const conexion = { query, beginTransaction() {}, commit() {}, rollback() {}, release() {} };
  const connectionPath = require.resolve('../api/connection/connection');
  require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true,
    exports: { promise: () => ({ query, getConnection: async () => conexion }) } };
  const privado = require('../api/routes/olimpiadas-contenido');
  const publico = require('../api/routes/olimpiadas-publico');
  const app = express();
  app.use(express.json());
  app.use(privado, publico);
  const servidor = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { servidor.closeAllConnections(); servidor.close(resolve); }));
  const token = jwt.sign({ data: JSON.stringify(admin) }, process.env.JWT_SECRET);
  const base = `http://127.0.0.1:${servidor.address().port}/olimpiadas`;
  const pedir = async (ruta, opciones = {}) => {
    const respuesta = await fetch(`${base}/${ruta}`, { ...opciones, headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` } });
    return [respuesta.status, await respuesta.json()];
  };
  const categoria = (id, puestos) => pedir(`7/medallero/4/pruebas/${id}`, { method: 'PUT', body: JSON.stringify({ puestos }) });
  const ganador = (puesto, departamental_id) => ({ puesto, departamental_ids: [departamental_id] });
  const [estadoOro, oro] = await categoria(10, [ganador(1, 5)]);
  assert.equal(estadoOro, 200, JSON.stringify(oro));
  const oroId = medallas.at(-1).id;
  const [estadoPlata, plata] = await categoria(20, [ganador(2, 5)]);
  assert.equal(estadoPlata, 200, JSON.stringify(plata));
  const [natacion] = plata.medallero.disciplinas;
  assert.deepEqual(plata.medallero.tabla.map(m => [m.nombre, m.oro, m.plata, m.bronce, m.puntos]), [['Azul', 1, 0, 0, 10], ['Dolores', 0, 0, 1, 3]]);
  assert.deepEqual(natacion.categorias.map(c => [c.id, c.manual, c.mejor_por_departamental]), [[10, true, true], [20, true, true], [30, false, false]]);
  assert.equal(natacion.categorias[1].suma_medallero, 'NADA');
  assert.equal(natacion.categorias[1].puestos[1].ganadores[0].departamentales[0].computa, false);
  assert.equal(natacion.puestos_generales[2].ganadores[0].departamentales[0].puntos_manual, 3);
  const [estadoPublico, resultadoPublico] = await pedir('publico/7/medallero');
  assert.equal(estadoPublico, 200);
  assert.deepEqual(resultadoPublico.tabla.map(m => m.puntos), [10, 3]);
  assert.equal(resultadoPublico.disciplinas[0].categorias, undefined);

  assert.equal((await categoria(10, [ganador(1, 5)]))[0], 200);
  assert.equal(medallas.find(m => m.prueba_id === 10).id, oroId, 'el reintento conserva la adjudicación');
  const [estadoVacio, vacio] = await categoria(10, []);
  assert.equal(estadoVacio, 200, JSON.stringify(vacio));
  assert.equal(vacio.medallero.disciplinas[0].categorias[0].manual, true);
  assert.equal(vacio.medallero.disciplinas[0].categorias[1].puestos[1].ganadores[0].departamentales[0].computa, true);
  assert.equal(vacio.medallero.tabla[0].puntos, 6);

  const [estadoAuto, automatico] = await pedir('7/medallero/4/pruebas/10/automatico', { method: 'POST' });
  assert.equal(estadoAuto, 200, JSON.stringify(automatico));
  assert.equal(automatico.medallero.disciplinas[0].categorias[0].manual, false);
  assert.deepEqual(medallas.map(m => m.prueba_id), [null, 20]);
  assert.equal((await categoria(99, [ganador(1, 5)]))[0], 404);
  assert.equal((await pedir('7/medallero/4/pruebas/20/automatico', { method: 'POST' }))[0], 200);
  assert.deepEqual(medallas.map(m => m.prueba_id), [null]);
});
