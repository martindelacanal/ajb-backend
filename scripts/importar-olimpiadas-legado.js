'use strict';
require('dotenv').config();
// Importación aditiva: jamás pisa un logo ya asignado, elimina datos ni habilita
// disciplinas en una edición. --check por defecto, --apply para aplicar.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const datos = require('../api/data/olimpiadas-legado-2025.json');
const { registrarHistorial } = require('../api/services/olimpiadas-comun');
function normalizar(texto) { return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }

async function importar(db, { aplicar = false, directorio = path.resolve(__dirname, '../../output/olimpiadas-legado'), subirLogo } = {}) {
  const informe = { logos: [], sinLogoOrigen: [], lugaresNuevos: [], disciplinasNuevas: [], duplicadasExistentes: [], notas: datos.notas, filasNoDepartamentales: datos.filas_no_departamentales };
  const [cols] = await db.query("SHOW COLUMNS FROM departamental LIKE 'logo_archivo'");
  if (!cols.length && aplicar) await db.query('ALTER TABLE departamental ADD COLUMN logo_archivo VARCHAR(260) NULL');
  const [departamentos] = await db.query('SELECT id,nombre' + ((cols.length || aplicar) ? ',logo_archivo' : '') + ' FROM departamental');
  const [lugaresTabla] = await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='olimpiada_lugar'");
  if (aplicar && !lugaresTabla.length) throw new Error('Primero aplicar migrar-olimpiadas-competicion');
  const [lugares] = lugaresTabla.length ? await db.query('SELECT nombre FROM olimpiada_lugar WHERE eliminado=0') : [[]];
  const [disciplinas] = await db.query('SELECT id,nombre FROM olimpiada_disciplina');
  const [tipos] = await db.query("SELECT id FROM olimpiada_disciplina_tipo WHERE nombre='Atleta' LIMIT 1");
  if (!tipos.length) throw new Error('Falta categoría Atleta');
  for (const d of disciplinas) if (disciplinas.some(otro => otro.id < d.id && normalizar(otro.nombre) === normalizar(d.nombre))) informe.duplicadasExistentes.push(d);
  for (const [nombre, archivo] of datos.logos) {
    const dept = departamentos.find(d => normalizar(d.nombre) === normalizar(nombre));
    if (!dept) { informe.logos.push({ nombre, estado: 'sin_correspondencia' }); continue; }
    if (dept.logo_archivo) { informe.logos.push({ nombre, id: dept.id, estado: 'ya_asignado' }); continue; }
    let key;
    if (aplicar) {
      if (!subirLogo) throw new Error('Falta cargador S3');
      const url = 'https://dasvalley.com/olimpiadas/public/img/departamentales/' + encodeURIComponent(archivo);
      const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
      if (!response.ok || Number(response.headers.get('content-length')) > 5000000) throw new Error(`No se pudo descargar logo ${nombre}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 5000000) throw new Error('Logo demasiado grande');
      await fs.mkdir(directorio, { recursive: true });
      await fs.writeFile(path.join(directorio, archivo), buffer);
      const imagen = await sharp(buffer, { limitInputPixels: 25000000 }).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
      key = `departamentales/logos/${dept.id}-${crypto.createHash('sha256').update(imagen).digest('hex').slice(0,16)}.webp`;
      await subirLogo(key, imagen);
      await db.query('UPDATE departamental SET logo_archivo=? WHERE id=? AND logo_archivo IS NULL', [key, dept.id]);
      await registrarHistorial(db, { entidad: 'DEPARTAMENTAL', entidad_id: dept.id, tipo_operacion: 'UPDATE', campo_modificado: 'logo_archivo', valor_nuevo: key, observacion: 'Importación autorizada de logo desde fixture AJB 2025' });
    }
    informe.logos.push({ nombre, id: dept.id, estado: aplicar ? 'asignado' : 'pendiente', key });
  }
  informe.sinLogoOrigen = departamentos.filter(d => !datos.logos.some(([n]) => normalizar(n) === normalizar(d.nombre))).map(d => d.nombre);
  for (const nombre of datos.lugares) {
    if (lugares.some(l => normalizar(l.nombre) === normalizar(nombre))) continue;
    informe.lugaresNuevos.push(nombre);
    if (aplicar) {
      const [insert] = await db.query('INSERT INTO olimpiada_lugar (nombre,predio,descripcion) VALUES (?,?,?)', [nombre, 'Miramar', 'Catálogo importado de Olimpiadas AJB 2025. Verificar disponibilidad para cada edición.']);
      await registrarHistorial(db, { entidad: 'LUGAR', entidad_id: insert.insertId, tipo_operacion: 'CREATE', valor_nuevo: nombre, observacion: 'Importación autorizada desde fixture AJB 2025' });
    }
  }
  for (const nombre of datos.disciplinas) {
    if (disciplinas.some(d => normalizar(d.nombre) === normalizar(nombre))) continue;
    informe.disciplinasNuevas.push(nombre);
    if (aplicar) {
      const [insert] = await db.query('INSERT INTO olimpiada_disciplina (nombre,tipo_id,habilitado) VALUES (?,?,?)', [nombre, tipos[0].id, 'Y']);
      await registrarHistorial(db, { entidad: 'DISCIPLINA', entidad_id: insert.insertId, tipo_operacion: 'CREATE', valor_nuevo: nombre, observacion: 'Importación autorizada desde fixture AJB 2025' });
    }
  }
  return informe;
}

async function main() {
  require('dotenv').config();
  const aplicar = process.argv.includes('--apply');
  if (aplicar && !['localhost','127.0.0.1'].includes(process.env.DB_HOST) && !process.argv.includes('--allow-production')) throw new Error('Destino remoto requiere --allow-production');
  // Cargar S3 después de dotenv (el módulo común captura sus credenciales al cargar).
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.BUCKET_REGION, credentials: { accessKeyId: process.env.ACCESS_KEY, secretAccessKey: process.env.SECRET_ACCESS_KEY } });
  const db = require('../api/connection/connection').promise();
  try {
    const resultado = await importar(db, { aplicar, subirLogo: (key, buffer) => s3.send(new PutObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key, Body: buffer, ContentType: 'image/webp' })) });
    console.log(JSON.stringify(resultado, null, 2));
  } finally { await db.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { importar, normalizar };
