'use strict';

const fs = require('node:fs');
const net = require('node:net');
const mysql = require('mysql2/promise');
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require('./migrar-webauthn-v1');
const columnas = {
  olimpiada: { drive_publico_url: 'varchar(2048)' },
  olimpiada_video: { epigrafe: 'varchar(200)', disciplina_id: 'int', partido_id: 'int', etiquetas: 'json', departamentales: 'json' },
};

async function migrar(db, aplicar) {
  const plan = [];
  for (const [tabla, esperadas] of Object.entries(columnas)) {
    const [existentes] = await db.query(`SHOW COLUMNS FROM ${tabla}`);
    const cambios = [];
    for (const [nombre, tipo] of Object.entries(esperadas)) {
      const columna = existentes.find(c => c.Field === nombre);
      if (!columna) cambios.push(`ADD COLUMN ${nombre} ${tipo} NULL`);
      else if (columna.Type !== tipo || columna.Null !== 'YES' || columna.Default !== null) {
        throw new Error(`Definición incompatible de ${tabla}.${nombre}`);
      }
    }
    if (tabla === 'olimpiada_video') {
      const [claves] = await db.query(`SELECT k.COLUMN_NAME AS campo, k.REFERENCED_TABLE_NAME AS tabla,
        k.REFERENCED_COLUMN_NAME AS columna, r.DELETE_RULE AS alBorrar
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'olimpiada_video' AND k.COLUMN_NAME IN ('disciplina_id', 'partido_id')`);
      for (const entidad of ['disciplina', 'partido']) {
        const campo = entidad + '_id', destino = 'olimpiada_' + entidad;
        const delCampo = claves.filter(c => c.campo === campo);
        if (!delCampo.length) cambios.push(`ADD CONSTRAINT fk_oli_video_${entidad} FOREIGN KEY (${campo}) REFERENCES ${destino}(id) ON DELETE SET NULL`);
        else if (delCampo.some(c => c.tabla !== destino || c.columna !== 'id' || c.alBorrar !== 'SET NULL')) {
          throw new Error(`Referencia incompatible de olimpiada_video.${campo}`);
        }
      }
    }
    if (cambios.length) plan.push(`ALTER TABLE ${tabla} ${cambios.join(', ')}`);
  }
  if (aplicar) for (const sentencia of plan) await db.query(sentencia);
  return { cambios: plan };
}

async function main() {
  const opciones = parsearArgumentos();
  if (opciones.target !== 'develop' && !opciones.allowProduction) throw new Error('Producción requiere --allow-production');
  if (opciones.apply && opciones.confirmacion !== 'OLIMPIADAS_GALERIA') throw new Error('Aplicar requiere --confirm=OLIMPIADAS_GALERIA');
  const puerto = process.argv.find(a => a.startsWith('--puerto-tunel='))?.split('=')[1];
  if (puerto !== undefined && (!/^\d{1,5}$/.test(puerto) || Number(puerto) < 1 || Number(puerto) > 65535)) throw new Error('Puerto de túnel inválido');
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, 'utf8'))) {
    const config = crearOpcionesConexion(entorno.config);
    if (puerto) config.stream = () => net.connect({ host: '127.0.0.1', port: Number(puerto) });
    if (config.ssl && entorno.config.DB_SSL_MODE === 'verify-full') config.ssl.verifyIdentity = true;
    const db = await mysql.createConnection(config);
    try {
      const [[lock]] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-galeria', 15) AS adquirido");
      if (Number(lock.adquirido) !== 1) throw new Error('Hay otra migración de la galería en curso');
      const resultado = await migrar(db, opciones.apply);
      console.log(JSON.stringify({ entorno: entorno.nombre, modo: opciones.apply ? 'apply' : 'check', ...resultado }));
    } finally { await db.end(); }
  }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { migrar };
