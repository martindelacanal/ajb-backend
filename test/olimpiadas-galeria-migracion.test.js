'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrar } = require('../scripts/migrar-olimpiadas-galeria');

const columna = (Field, Type) => ({ Field, Type, Null: 'YES', Default: null });

test('la migración agrega sólo los metadatos ausentes, conserva las filas y admite instalaciones parciales', async () => {
  const edicion = [columna('drive_publico_url', 'varchar(2048)')];
  const video = [columna('epigrafe', 'varchar(200)')];
  const claves = [];
  const ejecutados = [];
  const db = { async query(sql) {
    if (sql === 'SHOW COLUMNS FROM olimpiada') return [edicion];
    if (sql === 'SHOW COLUMNS FROM olimpiada_video') return [video];
    if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [claves];
    ejecutados.push(sql);
    return [{}];
  } };
  const { cambios } = await migrar(db, false);
  assert.equal(ejecutados.length, 0);
  assert.equal(cambios.length, 1);
  assert.match(cambios[0], /^ALTER TABLE olimpiada_video /);
  assert.doesNotMatch(cambios[0], /ADD COLUMN epigrafe/);
  for (const campo of ['disciplina_id', 'partido_id', 'etiquetas', 'departamentales']) {
    assert.match(cambios[0], new RegExp('ADD COLUMN ' + campo + ' (int|json) NULL'));
  }
  await migrar(db, true);
  assert.deepEqual(ejecutados, cambios);
  for (const nombre of ['disciplina', 'partido']) {
    video.push(columna(nombre + '_id', 'int'));
    claves.push({ campo: nombre + '_id', tabla: 'olimpiada_' + nombre, columna: 'id', alBorrar: 'SET NULL' });
  }
  video.push(columna('etiquetas', 'json'), columna('departamentales', 'json'));
  assert.deepEqual(await migrar(db, true), { cambios: [] });
  assert.deepEqual(ejecutados, cambios);
  claves[0].alBorrar = 'CASCADE';
  await assert.rejects(migrar(db, true), /Referencia incompatible/);
  edicion[0].Type = 'int';
  await assert.rejects(migrar(db, true), /Definición incompatible/);
  assert.deepEqual(ejecutados, cambios);
});
