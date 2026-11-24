'use strict';

const fs = require('node:fs');
const net = require('node:net');
const mysql = require('mysql2/promise');
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require('./migrar-webauthn-v1');
const { leerEtiquetas } = require('../api/services/olimpiadas-fotos');

async function migrar(db, aplicar) {
  const [columnas] = await db.query("SHOW COLUMNS FROM olimpiada_foto WHERE Field IN ('etiquetas','partido_id','carga_id')");
  const tipos = new Map(columnas.map(c => [c.Field, c.Type]));
  const cambios = [];
  for (const [campo, tipo] of [['etiquetas', 'json'], ['partido_id', 'int'], ['carga_id', 'char(36)']]) {
    if (!tipos.has(campo)) cambios.push(`ADD COLUMN ${campo} ${tipo} NULL`);
    else if (tipos.get(campo) !== tipo) throw new Error(`Tipo inesperado en olimpiada_foto.${campo}`);
  }
  const [indiceCarga] = await db.query("SHOW INDEX FROM olimpiada_foto WHERE Key_name = 'uq_oli_foto_carga'");
  if (!indiceCarga.length) cambios.push('ADD UNIQUE INDEX uq_oli_foto_carga (olimpiada_id, usuario_id, carga_id)');
  else if (indiceCarga.some(i => Number(i.Non_unique) !== 0) ||
      indiceCarga.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(i => i.Column_name).join(',') !== 'olimpiada_id,usuario_id,carga_id') {
    throw new Error('El índice de cargas de fotos existente es incompatible');
  }
  const [claves] = await db.query(`SELECT k.REFERENCED_TABLE_NAME AS tabla, k.REFERENCED_COLUMN_NAME AS columna, r.DELETE_RULE AS alBorrar
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'olimpiada_foto' AND k.COLUMN_NAME = 'partido_id'`);
  if (claves.length && !claves.some(fk => fk.tabla === 'olimpiada_partido' && fk.columna === 'id' && fk.alBorrar === 'SET NULL')) {
    throw new Error('La referencia existente de olimpiada_foto.partido_id es incompatible');
  }
  if (!claves.length) cambios.push('ADD CONSTRAINT fk_oli_foto_partido FOREIGN KEY (partido_id) REFERENCES olimpiada_partido(id) ON DELETE SET NULL');
  if (aplicar && cambios.length) await db.query(`ALTER TABLE olimpiada_foto ${cambios.join(', ')}`);

  // Incluir fotos eliminadas para mantener su clasificación si se recuperan.
  const [anteriores] = await db.query(`SELECT etiqueta, COUNT(*) AS cantidad FROM olimpiada_foto WHERE etiqueta IS NOT NULL
    ${tipos.has('etiquetas') || aplicar ? 'AND etiquetas IS NULL' : ''} GROUP BY BINARY etiqueta, etiqueta`);
  if (aplicar && anteriores.length) {
    await db.beginTransaction();
    try {
      for (const fila of anteriores) {
        const etiquetas = leerEtiquetas(fila.etiqueta, { historicas: true });
        await db.query('UPDATE olimpiada_foto SET etiquetas = ? WHERE BINARY etiqueta = BINARY ? AND etiquetas IS NULL',
          [JSON.stringify(etiquetas), fila.etiqueta]);
      }
      await db.commit();
    } catch (error) { await db.rollback(); throw error; }
  }
  return { cambios, fotosConEtiquetaAnterior: anteriores.reduce((total, f) => total + Number(f.cantidad), 0) };
}

async function main() {
  const opciones = parsearArgumentos();
  if (opciones.target !== 'develop' && !opciones.allowProduction) throw new Error('Producción requiere --allow-production');
  if (opciones.apply && opciones.confirmacion !== 'OLIMPIADAS_FOTOS') throw new Error('Aplicar requiere --confirm=OLIMPIADAS_FOTOS');
  const puerto = process.argv.find(a => a.startsWith('--puerto-tunel='))?.split('=')[1];
  if (puerto !== undefined && (!/^\d{1,5}$/.test(puerto) || Number(puerto) < 1 || Number(puerto) > 65535)) throw new Error('Puerto de túnel inválido');
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, 'utf8'))) {
    const config = crearOpcionesConexion(entorno.config);
    if (puerto) config.stream = () => net.connect({ host: '127.0.0.1', port: Number(puerto) });
    if (config.ssl && entorno.config.DB_SSL_MODE === 'verify-full') config.ssl.verifyIdentity = true;
    const db = await mysql.createConnection(config);
    try {
      const [[lock]] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-fotos', 15) AS adquirido");
      if (Number(lock.adquirido) !== 1) throw new Error('Hay otra migración de fotos en curso');
      const resultado = await migrar(db, opciones.apply);
      console.log(JSON.stringify({ entorno: entorno.nombre, modo: opciones.apply ? 'apply' : 'check', ...resultado }));
    } finally { await db.end(); }
  }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { migrar };
