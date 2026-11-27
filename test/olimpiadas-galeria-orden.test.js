'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

Object.assign(process.env, { JWT_SECRET: 'orden-galeria-test', BUCKET_REGION: 'us-east-1',
  BUCKET_NAME: 'orden-galeria', ACCESS_KEY: 'test', SECRET_ACCESS_KEY: 'test' });

test('el orden de subida público se aplica antes de paginar y conserva el filtro de fecha del evento', async t => {
  const actor = { id: 42, rol: 'admin', rol_id: 1, habilitado: 'Y', requiere_cambio_clave: 0 };
  const edicion = { id: 2, habilitado: 'Y', publicada_publico: 1 };
  const filas = [
    { id: 100, fecha: '2026-11-28', fecha_creacion: '2026-11-27T10:02:00Z' },
    { id: 11, fecha: '2026-11-27', fecha_creacion: '2026-11-27T12:00:00Z' },
    { id: 99, fecha: '2026-11-27', fecha_creacion: '2026-11-27T10:02:00Z' },
    { id: 12, fecha: '2026-11-27', fecha_creacion: '2026-11-27T12:00:00Z' },
  ].map(fila => ({ ...fila, olimpiada_id: 2, orden: 0, poster_archivo: 'portada.webp' }));
  const db = { async query(sql, params) {
    if (sql.includes('r.nombre AS rol')) return [[actor]];
    if (sql.includes('FROM olimpiada WHERE id = ?')) return [[edicion]];
    if (sql.includes('GROUP BY')) return [[]];
    assert.match(sql, /FROM olimpiada_(?:foto|video) f/);
    const fechas = params[1];
    if (Array.isArray(fechas)) assert.match(sql, /f\.fecha IN \(\?\)/);
    const seleccion = filas.filter(fila => !Array.isArray(fechas) || fechas.includes(fila.fecha));
    if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: seleccion.length }]];
    const fotos = sql.includes('FROM olimpiada_foto f');
    const orden = /ORDER BY ([^\n]+?)(?: LIMIT \? OFFSET \?|$)/.exec(sql)?.[1];
    if (orden === 'f.fecha_creacion DESC, f.id DESC') {
      seleccion.sort((a, b) => b.fecha_creacion.localeCompare(a.fecha_creacion) || b.id - a.id);
    } else if (fotos) {
      assert.equal(orden, 'f.fecha DESC, f.orden, f.id DESC');
      seleccion.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id - a.id);
    } else {
      assert.equal(orden, 'f.fecha IS NULL, f.fecha, f.orden, f.id');
      seleccion.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id);
    }
    if (!fotos) return [seleccion.map(fila => ({ ...fila }))];
    const [limite, salto] = params.slice(-2);
    assert.match(sql, / LIMIT \? OFFSET \?$/);
    return [seleccion.slice(salto, salto + limite)];
  } };
  const modulo = require.resolve('../api/connection/connection');
  require.cache[modulo] = { id: modulo, filename: modulo, loaded: true, exports: { promise: () => db } };
  const app = express();
  app.use(require('../api/routes/olimpiadas-contenido'), require('../api/routes/olimpiadas-publico'));
  const servidor = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { servidor.closeAllConnections(); servidor.close(resolve); }));
  const base = `http://127.0.0.1:${servidor.address().port}/olimpiadas/`;
  const token = jwt.sign({ data: JSON.stringify(actor) }, process.env.JWT_SECRET);
  const leer = async (ruta, gestion = false) => {
    const respuesta = await fetch(base + ruta, { headers: gestion ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(respuesta.status, 200, ruta);
    return respuesta.json();
  };
  const ids = elementos => elementos.map(fila => fila.id);

  const primera = await leer('publico/2/fotos?orden=SUBIDA&pageSize=2');
  const segunda = await leer('publico/2/fotos?orden=SUBIDA&pageSize=2&page=2');
  assert.deepEqual([ids(primera.results), ids(segunda.results)], [[12, 11], [100, 99]]);
  assert.equal(primera.results[0].fecha_creacion, '2026-11-27T12:00:00Z');
  assert.equal(segunda.results[0].fecha, '2026-11-28');
  const filtrada = await leer('publico/2/fotos?orden=SUBIDA&fecha=2026-11-27');
  assert.equal(filtrada.totalItems, 3);
  assert.deepEqual(ids(filtrada.results), [12, 11, 99]);
  assert.deepEqual(ids(await leer('publico/2/videos?orden=SUBIDA')), [12, 11, 100, 99]);
  assert.deepEqual(ids(await leer('publico/2/videos?orden=SUBIDA&fecha=2026-11-27')), [12, 11, 99]);

  for (const [prefijo, consulta, gestion] of [['publico/2', '', false], ['2', '?orden=SUBIDA', true]]) {
    assert.deepEqual(ids((await leer(`${prefijo}/fotos${consulta}`, gestion)).results), [100, 99, 12, 11]);
    assert.deepEqual(ids(await leer(`${prefijo}/videos${consulta}`, gestion)), [11, 12, 99, 100]);
  }
});
