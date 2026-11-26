'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

Object.assign(process.env, { JWT_SECRET: 'galeria-publica-test', BUCKET_REGION: 'us-east-1',
  BUCKET_NAME: 'galeria-test', ACCESS_KEY: 'test', SECRET_ACCESS_KEY: 'test' });

test('Prensa puede publicar y ocultar el Drive de su edición, con auditoría atómica y lectura anónima sólo en el portal publicado', async t => {
  const prensa = { id: 91, rol: 'prensa', rol_id: 7, habilitado: 'Y', requiere_cambio_clave: 0 };
  const afiliado = { ...prensa, id: 92, rol: 'afiliado', rol_id: 2 };
  const edicion = { id: 2, nombre: 'Prueba', habilitado: 'Y', publicada_publico: 1, drive_publico_url: null };
  const auditoria = [], transacciones = [];
  let asignada = true, fallarHistorial = false;
  const db = {
    async query(sql, p) {
      if (sql.includes('r.nombre AS rol')) return [Number(p[0]) === prensa.id ? [prensa] : [afiliado]];
      if (sql.includes('JOIN olimpiada_prensa')) return [asignada && Number(p[0]) === prensa.id && Number(p[1]) === edicion.id ? [edicion] : []];
      if (sql.includes('FROM olimpiada WHERE id = ?') || sql.includes('o.drive_publico_url FROM olimpiada o')) {
        return [Number(p[0]) === edicion.id ? [edicion] : []];
      }
      if (sql.startsWith('SELECT (SELECT COUNT(*)')) return [[{}]];
      if (sql.includes('information_schema.COLUMNS') || sql.includes('FROM olimpiada_enlace')
        || sql.includes('FROM olimpiada_disciplina_config') || sql.includes('FROM departamental WHERE')) return [[]];
      throw new Error('Consulta inesperada fuera de la transacción');
    },
    async getConnection() {
      let enlace, registro;
      const pasos = [];
      transacciones.push(pasos);
      return {
        async beginTransaction() { pasos.push('inicio'); },
        async query(sql, p) {
          if (sql.startsWith('SELECT * FROM olimpiada WHERE id = ?')) {
            assert.match(sql, /AND eliminado = 0 FOR UPDATE$/);
            assert.deepEqual(p, [edicion.id]);
            pasos.push('bloqueo');
            return [[{ ...edicion }]];
          }
          if (sql.startsWith('UPDATE olimpiada SET drive_publico_url = ? WHERE id = ?')) {
            assert.equal(p[1], edicion.id);
            enlace = p[0];
            pasos.push('enlace');
            return [{ affectedRows: 1 }];
          }
          assert.match(sql, /INSERT INTO olimpiada_historial/);
          pasos.push('historial');
          if (fallarHistorial) throw new Error('Falla de auditoría simulada');
          registro = p;
          return [{ insertId: 1 }];
        },
        async commit() {
          pasos.push('commit');
          if (enlace !== undefined) edicion.drive_publico_url = enlace;
          if (registro) auditoria.push(registro);
        },
        async rollback() { pasos.push('rollback'); },
        release() { pasos.push('liberar'); },
      };
    },
  };
  const modulo = require.resolve('../api/connection/connection');
  require.cache[modulo] = { id: modulo, filename: modulo, loaded: true, exports: { promise: () => db } };
  const gestion = require('../api/routes/olimpiadas-contenido'), publico = require('../api/routes/olimpiadas-publico');
  t.mock.method(require('../api/services/olimpiadas-comun').s3, 'send', async () => ({ ContentLength: 0 }));
  const app = express();
  app.use(express.json(), gestion, publico);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port + '/olimpiadas/';
  const sesion = actor => ({ Authorization: 'Bearer ' + jwt.sign({ data: JSON.stringify(actor) }, process.env.JWT_SECRET) });
  const guardar = (valor, id = 2, actor = prensa) => fetch(base + id + '/fotos/drive-publico', {
    method: 'PUT', headers: { ...sesion(actor), 'Content-Type': 'application/json' }, body: JSON.stringify({ drive_publico_url: valor }),
  });
  const portal = () => fetch(base + 'publico/2/portal');
  assert.equal((await (await portal()).json()).olimpiada.drive_publico_url, null);
  const carpeta = 'https://drive.google.com/drive/folders/carpetaPrueba001?resourcekey=clave-prueba';
  for (const invalido of [undefined, '', {}, 17, 'https://example.com/drive/folders/carpetaPrueba001', carpeta.replace('clave-prueba', 'clave%20mala')]) {
    assert.equal((await guardar(invalido)).status, 400);
  }
  assert.equal((await guardar(carpeta, 3)).status, 403);
  assert.equal((await guardar(carpeta, 2, afiliado)).status, 403);
  assert.equal(transacciones.length, 0);

  for (const [original, esperado] of [
    ['  ' + carpeta.replace('/drive/folders', '/drive/u/1/folders') + '&usp=sharing#contenidos  ', carpeta],
    ['https://drive.google.com/file/u/2/d/videoPrueba0001/preview?usp=sharing', 'https://drive.google.com/file/d/videoPrueba0001/view'],
    ['https://drive.google.com/open?usp=sharing&id=carpetaPrueba001', 'https://drive.google.com/open?id=carpetaPrueba001'],
  ]) {
    const guardado = await guardar(original);
    assert.equal(guardado.status, 200);
    assert.deepEqual(await guardado.json(), { drive_publico_url: esperado });
    assert.deepEqual(transacciones.at(-1), ['inicio', 'bloqueo', 'enlace', 'historial', 'commit', 'liberar']);
    const fila = auditoria.at(-1);
    assert.deepEqual(fila.slice(0, 8), ['OLIMPIADA', 2, 2, null, 91, 'prensa', 'UPDATE', 'drive_publico_url']);
    assert.equal((await (await portal()).json()).olimpiada.drive_publico_url, esperado);
    const contexto = await fetch(base + '2/fotos/contexto', { headers: sesion(prensa) });
    assert.equal((await contexto.json()).drive_publico_url, esperado);
    assert.equal((await guardar(esperado)).status, 200);
    assert.deepEqual(transacciones.at(-1), ['inicio', 'bloqueo', 'commit', 'liberar']);
  }
  assert.equal(auditoria.length, 3);
  edicion.publicada_publico = 0;
  assert.equal((await portal()).status, 404);
  edicion.publicada_publico = 1;
  asignada = false;
  assert.equal((await guardar(null)).status, 403);
  asignada = true;
  fallarHistorial = true;
  assert.equal((await guardar(null)).status, 500);
  assert.deepEqual(transacciones.at(-1), ['inicio', 'bloqueo', 'enlace', 'historial', 'rollback', 'liberar']);
  assert.equal(auditoria.length, 3);
  assert.ok((await (await portal()).json()).olimpiada.drive_publico_url);
  fallarHistorial = false;
  assert.deepEqual(await (await guardar(null)).json(), { drive_publico_url: null });
  assert.equal(auditoria.length, 4);
  assert.equal((await (await portal()).json()).olimpiada.drive_publico_url, null);
});
