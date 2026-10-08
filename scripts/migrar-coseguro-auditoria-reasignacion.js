"use strict";

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { parsearBloquesEnv, crearOpcionesConexion } = require("./migrar-webauthn-v1");

const COLUMNAS = {
  usuario_original_id: "INT NULL",
  modo_cobertura_aplicado: "ENUM('MANUAL','PORCENTAJE') NULL",
  tope_reintegro_aplicado: "DECIMAL(12,2) NULL",
  cobertura_fecha_aplicada: "DATETIME NULL",
  cobertura_origen_aplicado: "ENUM('CONFIGURACION','LEGADO') NULL",
};

const CREAR_HISTORIAL = `CREATE TABLE IF NOT EXISTS coseguro_cobertura_historial (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tipo_reintegro_id INT NOT NULL,
  usuario_id INT NULL,
  usuario_rol VARCHAR(50) NULL,
  origen ENUM('INICIAL','CAMBIO') NOT NULL,
  modo_anterior ENUM('MANUAL','PORCENTAJE') NULL,
  modo_nuevo ENUM('MANUAL','PORCENTAJE') NOT NULL,
  porcentaje_anterior DECIMAL(5,2) NULL,
  porcentaje_nuevo DECIMAL(5,2) NULL,
  tope_anterior DECIMAL(12,2) NULL,
  tope_nuevo DECIMAL(12,2) NULL,
  es_subsidio_anterior TINYINT(1) NULL,
  es_subsidio_nuevo TINYINT(1) NOT NULL,
  fecha DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id), KEY idx_cos_cob_tipo_fecha (tipo_reintegro_id, fecha, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

async function verificarMigracion(db) {
  const [columnas] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coseguro_solicitud'");
  const faltantes = Object.keys(COLUMNAS).filter((nombre) => !columnas.some((c) => c.COLUMN_NAME === nombre));
  const [tablas] = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coseguro_cobertura_historial'");
  if (!tablas.length) faltantes.push("coseguro_cobertura_historial");
  if (faltantes.length) return { completo: false, faltantes };
  const [[pendientes]] = await db.query(`SELECT
    (SELECT COUNT(*) FROM coseguro_solicitud WHERE usuario_original_id IS NULL OR modo_cobertura_aplicado IS NULL OR cobertura_origen_aplicado IS NULL) AS solicitudes,
    (SELECT COUNT(*) FROM coseguro_tipo_reintegro t WHERE NOT EXISTS (SELECT 1 FROM coseguro_cobertura_historial h WHERE h.tipo_reintegro_id = t.id)) AS tipos`);
  return { completo: Number(pendientes.solicitudes) === 0 && Number(pendientes.tipos) === 0, pendientes };
}

async function ejecutarMigracion(db, { checkOnly = true } = {}) {
  if (checkOnly) return verificarMigracion(db);
  await db.query("SET SESSION time_zone = '-03:00'");
  const [[lock]] = await db.query("SELECT GET_LOCK('ajb:coseguro:auditoria-reasignacion:v1', 30) AS adquirido");
  if (Number(lock.adquirido) !== 1) throw new Error("No se pudo bloquear la migración de coseguro");
  try {
    const [columnas] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coseguro_solicitud'");
    for (const [nombre, definicion] of Object.entries(COLUMNAS)) {
      if (!columnas.some((c) => c.COLUMN_NAME === nombre)) await db.query(`ALTER TABLE coseguro_solicitud ADD COLUMN ${nombre} ${definicion}`);
    }
    await db.query(CREAR_HISTORIAL);
    await db.beginTransaction();
    try {
      // El porcentaje y estimado existentes son evidencia histórica. No tomar la
      // configuración actual como si hubiese sido la aplicada a estas solicitudes.
      // Un tope sólo puede recuperarse cuando el estimado quedó efectivamente limitado.
      await db.query(`UPDATE coseguro_solicitud SET
        fecha_modificacion = fecha_modificacion,
        usuario_original_id = COALESCE(usuario_original_id, usuario_id),
        modo_cobertura_aplicado = COALESCE(modo_cobertura_aplicado, IF(porcentaje_cobertura_aplicado IS NULL, 'MANUAL', 'PORCENTAJE')),
        tope_reintegro_aplicado = CASE WHEN cobertura_origen_aplicado IS NULL AND porcentaje_cobertura_aplicado IS NOT NULL
          AND importe_estimado > 0 AND importe_estimado < ROUND(importe * porcentaje_cobertura_aplicado / 100, 2)
          THEN importe_estimado ELSE tope_reintegro_aplicado END,
        cobertura_origen_aplicado = COALESCE(cobertura_origen_aplicado, 'LEGADO')
        WHERE usuario_original_id IS NULL OR modo_cobertura_aplicado IS NULL OR cobertura_origen_aplicado IS NULL`);
      // INICIAL registra el estado observable ahora, con fecha real de migración.
      await db.query(`INSERT INTO coseguro_cobertura_historial
        (tipo_reintegro_id, origen, modo_nuevo, porcentaje_nuevo, tope_nuevo, es_subsidio_nuevo)
        SELECT t.id, 'INICIAL', t.modo_cobertura, t.porcentaje_cobertura, t.tope_reintegro, t.es_subsidio
        FROM coseguro_tipo_reintegro t WHERE NOT EXISTS
          (SELECT 1 FROM coseguro_cobertura_historial h WHERE h.tipo_reintegro_id = t.id)`);
      const resultado = await verificarMigracion(db);
      if (!resultado.completo) throw new Error("La migración quedó incompleta");
      await db.commit();
      return resultado;
    } catch (error) { await db.rollback(); throw error; }
  } finally { await db.query("SELECT RELEASE_LOCK('ajb:coseguro:auditoria-reasignacion:v1')"); }
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => a.startsWith("--target="))?.slice(9) || "develop";
  if (!["develop", "production", "all"].includes(target)) throw new Error("Target inválido");
  const envPath = args.find((a) => a.startsWith("--env-file="))?.slice(11) || path.resolve(__dirname, "../.env");
  const bloques = parsearBloquesEnv(fs.readFileSync(envPath, "utf8"));
  for (const nombre of target === "all" ? ["develop", "production"] : [target]) {
    const config = { ...bloques[nombre] };
    for (const key of ["DB_SSL_MODE", "DB_SSL_CA_PATH"]) if (process.env[key]) config[key] = process.env[key];
    const db = await mysql.createConnection(crearOpcionesConexion(config));
    try { console.log(JSON.stringify({ target: nombre, ...await ejecutarMigracion(db, { checkOnly: !args.includes("--apply") }) })); }
    finally { await db.end(); }
  }
}

if (require.main === module) main().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { ejecutarMigracion, verificarMigracion, COLUMNAS, CREAR_HISTORIAL };
