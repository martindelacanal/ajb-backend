'use strict';

const fs = require('node:fs');
const net = require('node:net');
const mysql = require('mysql2/promise');
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require('./migrar-webauthn-v1');

const clave = nombre => String(nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function planificar(lugares, sedes, partidos) {
  const porSede = new Map(sedes.map(s => [s.id, s]));
  const porLugar = new Map();
  for (const p of partidos) {
    if (!porLugar.has(p.lugar_id)) porLugar.set(p.lugar_id, []);
    porLugar.get(p.lugar_id).push(p);
  }
  const grupos = [], sinSede = [];
  for (const lugar of lugares) {
    const usos = porLugar.get(lugar.id) || [];
    const porDestino = new Map();
    const coincidentes = sedes.filter(s => clave(s.nombre) === clave(lugar.predio));
    let ambiguo = false;
    for (const p of usos) {
      let sede = porSede.get(p.sede_id || p.sede_disciplina_id);
      if (sede?.olimpiada_id !== p.olimpiada_id) sede = null;
      if (!sede) {
        const candidatas = coincidentes.filter(s => s.olimpiada_id === p.olimpiada_id);
        if (candidatas.length === 1) sede = candidatas[0];
      }
      if (!sede) { ambiguo = true; continue; }
      if (!porDestino.has(sede.id)) porDestino.set(sede.id, []);
      porDestino.get(sede.id).push(p.id);
    }
    if (!usos.length && coincidentes.length === 1) porDestino.set(coincidentes[0].id, []);
    if (ambiguo || !porDestino.size) sinSede.push(lugar.id);
    // Si hay usos ambiguos, conservan el ID legado. Sólo se copian las asignaciones comprobadas.
    let reutilizar = !ambiguo;
    for (const [sedeId, partidosIds] of porDestino) {
      grupos.push({ lugarId: lugar.id, sedeId, partidosIds, reutilizar });
      reutilizar = false;
    }
  }
  return { grupos, sinSede };
}

async function migrar(db, aplicar = false) {
  const [[columna]] = await db.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada_lugar' AND COLUMN_NAME = 'sede_id'`);
  if (!columna && aplicar) await db.query(`ALTER TABLE olimpiada_lugar ADD COLUMN sede_id INT NULL,
    ADD INDEX idx_oli_lugar_sede (sede_id, eliminado),
    ADD CONSTRAINT fk_oli_lugar_sede FOREIGN KEY (sede_id) REFERENCES olimpiada_sede(id) ON DELETE SET NULL`);
  if (aplicar) await db.beginTransaction();
  try {
    const bloqueo = aplicar ? ' FOR UPDATE' : '';
    const pendientes = columna || aplicar ? ' AND sede_id IS NULL' : '';
    const [lugares] = await db.query('SELECT id, predio FROM olimpiada_lugar WHERE eliminado = 0' + pendientes + ' ORDER BY id' + bloqueo);
    const [sedes] = await db.query("SELECT id, olimpiada_id, nombre FROM olimpiada_sede WHERE eliminado = 0 AND tipo <> 'HOTEL' ORDER BY id" + bloqueo);
    const [partidos] = lugares.length ? await db.query(`SELECT p.id, p.olimpiada_id, p.lugar_id, p.sede_id, dc.sede_id AS sede_disciplina_id
      FROM olimpiada_partido p LEFT JOIN olimpiada_disciplina_config dc ON dc.olimpiada_id = p.olimpiada_id AND dc.disciplina_id = p.disciplina_id
      WHERE p.lugar_id IN (?) ORDER BY p.id` + bloqueo, [lugares.map(l => l.id)]) : [[]];
    const { grupos, sinSede } = planificar(lugares, sedes, partidos);
    if (aplicar) {
      for (const grupo of grupos) {
        let canchaId = grupo.lugarId;
        if (grupo.reutilizar) {
          await db.query('UPDATE olimpiada_lugar SET sede_id = ? WHERE id = ?', [grupo.sedeId, canchaId]);
        } else {
          const [insert] = await db.query(`INSERT INTO olimpiada_lugar (sede_id, nombre, predio, descripcion, direccion, url_mapa, lat, lng)
            SELECT ?, nombre, predio, descripcion, direccion, url_mapa, lat, lng FROM olimpiada_lugar WHERE id = ?`, [grupo.sedeId, canchaId]);
          canchaId = insert.insertId;
        }
        if (grupo.partidosIds.length) await db.query('UPDATE olimpiada_partido SET sede_id = ?, lugar_id = ? WHERE id IN (?)',
          [grupo.sedeId, canchaId, grupo.partidosIds]);
      }
      await db.commit();
    }
    return { agregarColumna: !columna, canchasVinculadas: grupos.length, copias: grupos.filter(g => !g.reutilizar).length,
      partidosVinculados: grupos.reduce((suma, g) => suma + g.partidosIds.length, 0), lugaresSinSedeVerificable: sinSede };
  } catch (error) {
    if (aplicar) await db.rollback();
    throw error;
  }
}

async function main() {
  const opciones = parsearArgumentos();
  if (opciones.target !== 'develop' && !opciones.allowProduction) throw new Error('Producción requiere --allow-production');
  const puerto = process.argv.find(arg => arg.startsWith('--puerto-tunel='))?.split('=')[1];
  if (puerto !== undefined && (!/^\d{1,5}$/.test(puerto) || Number(puerto) < 1 || Number(puerto) > 65535)) throw new Error('Puerto de túnel inválido');
  for (const e of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, 'utf8'))) {
    const conexion = crearOpcionesConexion(e.config);
    if (puerto) conexion.stream = () => net.connect({ host: '127.0.0.1', port: Number(puerto) });
    if (conexion.ssl && e.config.DB_SSL_MODE === 'verify-full') conexion.ssl.verifyIdentity = true;
    const db = await mysql.createConnection(conexion);
    try {
      const [[lock]] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-canchas', 15) AS tomado");
      if (Number(lock.tomado) !== 1) throw new Error('Otra migración de canchas está en curso');
      console.log(JSON.stringify({ entorno: e.nombre, modo: opciones.apply ? 'apply' : 'check', ...await migrar(db, opciones.apply) }));
    } finally { await db.end(); }
  }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { migrar, planificar };
