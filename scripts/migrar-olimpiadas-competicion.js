/* Idempotent migration. Default is read-only; use --apply, production additionally --allow-production. */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('node:fs');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const columnas = [
  ['torneo_id', 'INT NULL'], ['instancia_id', 'INT NULL'], ['lugar_id', 'INT NULL'],
  ['inscripcion1_id', 'INT NULL'], ['inscripcion2_id', 'INT NULL'],
  ['mostrar_nombres_publico', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['partido_origen1_id', 'INT NULL'], ['partido_origen2_id', 'INT NULL'],
];
const tablas = {
  olimpiada_lugar: `CREATE TABLE IF NOT EXISTS olimpiada_lugar (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(160) NOT NULL, predio VARCHAR(160) NULL,
    direccion VARCHAR(200) NULL, url_mapa VARCHAR(400) NULL, descripcion VARCHAR(400) NULL,
    eliminado TINYINT(1) NOT NULL DEFAULT 0, fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_oli_lugar_nombre (nombre)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  olimpiada_instancia: `CREATE TABLE IF NOT EXISTS olimpiada_instancia (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(60) NOT NULL, orden INT NOT NULL DEFAULT 0,
    eliminado TINYINT(1) NOT NULL DEFAULT 0, UNIQUE KEY uq_oli_instancia_nombre (nombre)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  olimpiada_torneo: `CREATE TABLE IF NOT EXISTS olimpiada_torneo (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, olimpiada_id INT NOT NULL, disciplina_id INT NOT NULL,
    nombre VARCHAR(160) NOT NULL, formato ENUM('ELIMINACION','GRUPOS','LIGA','MIXTO') NOT NULL DEFAULT 'ELIMINACION',
    descripcion VARCHAR(1000) NULL, eliminado TINYINT(1) NOT NULL DEFAULT 0,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_oli_torneo_edicion (olimpiada_id, disciplina_id, eliminado),
    CONSTRAINT fk_oli_torneo_edicion FOREIGN KEY (olimpiada_id) REFERENCES olimpiada(id),
    CONSTRAINT fk_oli_torneo_disciplina FOREIGN KEY (disciplina_id) REFERENCES olimpiada_disciplina(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  olimpiada_torneo_instancia: `CREATE TABLE IF NOT EXISTS olimpiada_torneo_instancia (
    torneo_id INT NOT NULL, instancia_id INT NOT NULL, orden INT NOT NULL DEFAULT 0,
    PRIMARY KEY (torneo_id, instancia_id),
    CONSTRAINT fk_oli_torneo_inst_torneo FOREIGN KEY (torneo_id) REFERENCES olimpiada_torneo(id),
    CONSTRAINT fk_oli_torneo_inst_instancia FOREIGN KEY (instancia_id) REFERENCES olimpiada_instancia(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
};
const instancias = ['Fase de grupos', 'Dieciseisavos de final', 'Octavos de final', 'Cuartos de final', 'Semifinal', 'Tercer puesto', 'Final'];

async function migrar(connection, aplicar = false) {
  const pendientes = [];
  const [publicacion] = await connection.query("SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'olimpiada' AND column_name = 'publicada_publico'");
  if (!publicacion.length) { pendientes.push('Agregar olimpiada.publicada_publico'); if (aplicar) await connection.query('ALTER TABLE olimpiada ADD COLUMN publicada_publico TINYINT(1) NOT NULL DEFAULT 0'); }
  for (const [tabla, ddl] of Object.entries(tablas)) {
    const [rows] = await connection.query('SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [tabla]);
    if (!rows.length) { pendientes.push(`Crear ${tabla}`); if (aplicar) await connection.query(ddl); }
  }
  for (const [nombre, ddl] of columnas) {
    const [rows] = await connection.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', ['olimpiada_partido', nombre]);
    if (!rows.length) { pendientes.push(`Agregar olimpiada_partido.${nombre}`); if (aplicar) await connection.query(`ALTER TABLE olimpiada_partido ADD COLUMN ${nombre} ${ddl}`); }
  }
  const [indice] = await connection.query("SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'olimpiada_partido' AND index_name = 'idx_oli_partido_torneo'");
  if (!indice.length) { pendientes.push('Índice de torneo'); if (aplicar) await connection.query('ALTER TABLE olimpiada_partido ADD INDEX idx_oli_partido_torneo (torneo_id, instancia_id, eliminado)'); }
  if (aplicar) {
    for (let i = 0; i < instancias.length; i++) await connection.query('INSERT IGNORE INTO olimpiada_instancia (nombre, orden) VALUES (?, ?)', [instancias[i], i]);
    if (!args.includes('--skip-grants')) {
      const [[schema]] = await connection.query('SELECT DATABASE() AS nombre');
      const [cuentas] = await connection.query("SELECT User, Host FROM mysql.user WHERE User = 'miajb_runtime'");
      for (const cuenta of cuentas) for (const tabla of Object.keys(tablas)) await connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${schema.nombre.replace(/`/g, '``')}\`.\`${tabla}\` TO ${mysql.escape(cuenta.User)}@${mysql.escape(cuenta.Host)}`);
    }
  }
  return pendientes;
}
async function main() {
  const remoto = !['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST || '').toLowerCase());
  if (apply && (remoto || process.env.NODE_ENV === 'production' || /prod/i.test(process.env.DB_DATABASE || '')) && !args.includes('--allow-production')) throw new Error('La base remota o de producción requiere --allow-production');
  for (const key of ['DB_HOST', 'DB_USER', 'DB_DATABASE']) if (!process.env[key]) throw new Error(`Falta ${key}`);
  const sslMode = String(process.env.DB_SSL_MODE || 'disabled').toLowerCase();
  if (!['disabled', 'verify-ca', 'verify-full'].includes(sslMode)) throw new Error('DB_SSL_MODE inválido');
  if (sslMode === 'disabled' && remoto) throw new Error('TLS es obligatorio para bases remotas');
  if (sslMode !== 'disabled' && !process.env.DB_SSL_CA_PATH) throw new Error('Falta DB_SSL_CA_PATH');
  const ssl = sslMode === 'disabled' ? undefined : { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true };
  const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT || 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE, timezone: '-03:00', ssl });
  try { const pendientes = await migrar(connection, apply); console.log(JSON.stringify({ modo: apply ? 'apply' : 'check', cambios: pendientes }, null, 2)); }
  finally { await connection.end(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { migrar, columnas, tablas, instancias };
