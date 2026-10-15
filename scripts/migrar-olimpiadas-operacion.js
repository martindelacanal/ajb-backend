'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { obtenerEntornos, crearOpcionesConexion } = require('./migrar-webauthn-v1');
const { migrar, tablas } = require('./migrar-olimpiadas-competicion');
const voluntarios = require('./migrar-olimpiadas-voluntarios');
const { importar } = require('./importar-olimpiadas-legado');

async function main() {
  const args = process.argv.slice(2), aplicar = args.includes('--apply');
  const target = args.find(a => a.startsWith('--target='))?.slice(9) || 'develop';
  if (!['develop','production','all'].includes(target)) throw new Error('Target inválido');
  if (target !== 'develop' && !args.includes('--allow-production')) throw new Error('Se requiere --allow-production');
  if (aplicar && !args.includes('--confirm=APLICAR_OLIMPIADAS_OPERACION')) throw new Error('Falta confirmación de migración');
  const contenidoEnv = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
  const entornos = (target === 'all' ? ['develop', 'production'] : [target]).flatMap(nombre =>
    obtenerEntornos({ target: nombre }, contenidoEnv, nombre === 'production' ? process.env : { DB_SSL_MODE: 'disabled' }));
  const s3 = new S3Client({ region: process.env.BUCKET_REGION, credentials: { accessKeyId: process.env.ACCESS_KEY, secretAccessKey: process.env.SECRET_ACCESS_KEY } });
  const informes = [];
  for (const entorno of entornos) {
    const db = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try {
      const [[lock]] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-operacion-v1',15) AS tomado");
      if (Number(lock.tomado) !== 1) throw new Error('Otra migración está en curso');
      const cambios = await migrar(db, false);
      let colaboradores;
      try { await voluntarios.verificarEsquema(db); colaboradores = 'listo'; } catch (e) { colaboradores = e.message; }
      if (aplicar) {
        const [departamentales] = await db.query('SELECT * FROM departamental');
        const [disciplinas] = await db.query('SELECT * FROM olimpiada_disciplina');
        const [ediciones] = await db.query('SELECT id,nombre,edicion,requiere_aprobacion FROM olimpiada');
        const dir = path.resolve(__dirname, '../../output/olimpiadas-migracion');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `respaldo-${entorno.nombre}-${Date.now()}.json`), JSON.stringify({ departamentales, disciplinas, ediciones }, null, 2), { flag: 'wx' });
        await migrar(db, true);
        await voluntarios.aplicarMigracion(db);
        await db.query('UPDATE olimpiada SET requiere_aprobacion=1 WHERE requiere_aprobacion<>1');
        const [cuentas] = await db.query("SELECT User,Host FROM mysql.user WHERE User='miajb_runtime'");
        for (const cuenta of cuentas) for (const tabla of [...Object.keys(tablas), ...Object.keys(voluntarios.COLUMNAS)]) {
          await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${db.escapeId(entorno.config.DB_DATABASE)}.${db.escapeId(tabla)} TO ${db.escape(cuenta.User)}@${db.escape(cuenta.Host)}`);
        }
      }
      const importacion = await importar(db, { aplicar, subirLogo: (key, buffer) => s3.send(new PutObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key, Body: buffer, ContentType: 'image/webp' })) });
      informes.push({ entorno: entorno.nombre, modo: aplicar ? 'aplicado' : 'consulta', cambios, colaboradores, importacion });
    } finally { await db.query("SELECT RELEASE_LOCK('ajb:olimpiadas-operacion-v1')").catch(() => {}); await db.end(); }
  }
  console.log(JSON.stringify(informes, null, 2));
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
