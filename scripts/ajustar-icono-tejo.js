'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { obtenerEntornos, crearOpcionesConexion } = require('./migrar-webauthn-v1');
const { registrarHistorial } = require('../api/services/olimpiadas-comun');

async function ajustarIconoTejo(db, aplicar = false) {
  const [origen] = await db.query("SELECT id, icono_archivo FROM olimpiada_disciplina WHERE LOWER(TRIM(nombre))='tejo dobles' AND habilitado='Y'");
  if (origen.length !== 1 || !origen[0].icono_archivo) throw new Error('No se encontró un ícono único de Tejo dobles');
  const [destino] = await db.query("SELECT id, icono_archivo FROM olimpiada_disciplina WHERE LOWER(TRIM(nombre))='tejo' AND habilitado='Y'");
  if (destino.length !== 1) throw new Error('No se encontró una disciplina Tejo única');
  const pendiente = destino[0].icono_archivo !== origen[0].icono_archivo;
  if (aplicar && pendiente) {
    await db.beginTransaction();
    try {
      await db.query('UPDATE olimpiada_disciplina SET icono_archivo=? WHERE id=?', [origen[0].icono_archivo, destino[0].id]);
      await registrarHistorial(db, { entidad: 'DISCIPLINA', entidad_id: destino[0].id, tipo_operacion: 'UPDATE',
        campo_modificado: 'icono_archivo', valor_anterior: destino[0].icono_archivo, valor_nuevo: origen[0].icono_archivo,
        observacion: 'Tejo utiliza el mismo ícono que Tejo dobles, según ajuste solicitado.' });
      await db.commit();
    } catch (error) { await db.rollback(); throw error; }
  }
  return { disciplina: 'Tejo', icono: origen[0].icono_archivo, estado: pendiente ? (aplicar ? 'actualizado' : 'pendiente') : 'sin_cambios' };
}

async function main() {
  const args = process.argv.slice(2), aplicar = args.includes('--apply');
  const target = args.find(a => a.startsWith('--target='))?.slice(9) || 'develop';
  if (!['develop', 'production', 'all'].includes(target)) throw new Error('Target inválido');
  if (target !== 'develop' && !args.includes('--allow-production')) throw new Error('Se requiere --allow-production');
  const contenidoEnv = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
  const nombres = target === 'all' ? ['develop', 'production'] : [target];
  const informes = [];
  for (const nombre of nombres) {
    const [entorno] = obtenerEntornos({ target: nombre }, contenidoEnv, nombre === 'production' ? process.env : { DB_SSL_MODE: 'disabled' });
    const db = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try { informes.push({ entorno: nombre, ...await ajustarIconoTejo(db, aplicar) }); }
    finally { await db.end(); }
  }
  console.log(JSON.stringify(informes, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { ajustarIconoTejo };
