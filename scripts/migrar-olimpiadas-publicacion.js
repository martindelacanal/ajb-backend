"use strict";

// Publicación inicial, una sola vez. Volver a ejecutar nunca vuelve a publicar
// ediciones que la administración haya ocultado después de esta migración.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

const MIGRATION_ID = "20261020_olimpiadas_publicacion";
const LOCK = `ajb:migration:${MIGRATION_ID}`;
const SELECT_EDICIONES = `SELECT id, nombre, edicion, fecha_inicio, fecha_fin, habilitado, eliminado, publicada_publico
  FROM olimpiada WHERE eliminado = 0 AND habilitado = 'Y' AND publicada_publico = 0 ORDER BY id`;
const CHECKSUM = crypto.createHash("sha256").update(`${MIGRATION_ID}:${SELECT_EDICIONES}:default=1`).digest("hex");
const CREATE_MIGRATION_TABLE = `CREATE TABLE IF NOT EXISTS ajb_schema_migration (
  migration_id VARCHAR(100) NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL,
  revision INT UNSIGNED NOT NULL, estado ENUM('APLICANDO','APLICADA','FALLIDA') NOT NULL,
  etapa VARCHAR(100) NULL, detalle TEXT NULL, trigger_definer VARCHAR(255) NOT NULL DEFAULT '',
  trigger_sql_mode TEXT NOT NULL, iniciada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  finalizada_en DATETIME NULL
) ENGINE=InnoDB`;

async function consultarPlan(db) {
  const [[columna]] = await db.query(`SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada' AND COLUMN_NAME = 'publicada_publico'`);
  if (!columna) throw new Error("Falta aplicar la migración de competición de Olimpiadas");
  const [tablas] = await db.query(`SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ajb_schema_migration'`);
  const [[registro]] = tablas.length
    ? await db.query("SELECT estado, checksum FROM ajb_schema_migration WHERE migration_id = ?", [MIGRATION_ID])
    : [[]];
  if (registro && registro.checksum !== CHECKSUM) throw new Error("La migración registrada tiene un checksum diferente");
  const aplicada = registro?.estado === "APLICADA";
  const [ediciones] = aplicada ? [[]] : await db.query(SELECT_EDICIONES);
  return { migracion: MIGRATION_ID, aplicada, default_actual: columna.COLUMN_DEFAULT,
    cambiar_default: Number(columna.COLUMN_DEFAULT) !== 1, ediciones_a_publicar: ediciones };
}

async function aplicarMigracion(db, { respaldar } = {}) {
  const [[lock]] = await db.query("SELECT GET_LOCK(?, 15) AS tomado", [LOCK]);
  if (Number(lock.tomado) !== 1) throw new Error("Otra migración de publicación está en curso");
  let transaccion = false;
  try {
    const plan = await consultarPlan(db);
    if (plan.aplicada && !plan.cambiar_default) return { ...plan, publicadas: [] };
    if (!plan.aplicada && typeof respaldar !== "function") throw new Error("Se requiere guardar un respaldo antes de publicar");
    // DDL de MySQL se realiza fuera de la transacción de publicación.
    await db.query(CREATE_MIGRATION_TABLE);
    if (plan.cambiar_default) await db.query("ALTER TABLE olimpiada ALTER COLUMN publicada_publico SET DEFAULT 1");
    if (plan.aplicada) return { ...plan, default_actual: "1", cambiar_default: false, publicadas: [] };
    await db.beginTransaction();
    transaccion = true;
    const [ediciones] = await db.query(`${SELECT_EDICIONES} FOR UPDATE`);
    const respaldo = await respaldar({ migracion: MIGRATION_ID, default_anterior: plan.default_actual, ediciones });
    for (const edicion of ediciones) {
      await db.query("UPDATE olimpiada SET publicada_publico = 1 WHERE id = ? AND eliminado = 0 AND habilitado = 'Y' AND publicada_publico = 0", [edicion.id]);
      await db.query(`INSERT INTO olimpiada_historial
        (entidad, entidad_id, olimpiada_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, observacion)
        VALUES ('OLIMPIADA', ?, ?, 'UPDATE', 'publicada_publico', '0', '1', ?)`,
      [edicion.id, edicion.id, `Publicación inicial autorizada de ediciones existentes (${MIGRATION_ID})`]);
    }
    await db.query(`INSERT INTO ajb_schema_migration
      (migration_id, checksum, revision, estado, etapa, detalle, trigger_sql_mode, finalizada_en)
      VALUES (?, ?, 1, 'APLICADA', 'completa', ?, '', NOW())
      ON DUPLICATE KEY UPDATE estado = 'APLICADA', etapa = 'completa', detalle = VALUES(detalle), finalizada_en = NOW()`,
    [MIGRATION_ID, CHECKSUM, JSON.stringify({ ediciones_publicadas: ediciones.map(e => e.id), respaldo })]);
    await db.commit();
    transaccion = false;
    return { ...plan, aplicada: true, default_actual: "1", cambiar_default: false,
      ediciones_a_publicar: [], publicadas: ediciones.map(e => e.id), respaldo };
  } catch (error) {
    if (transaccion) await db.rollback();
    throw error;
  } finally {
    await db.query("SELECT RELEASE_LOCK(?)", [LOCK]);
  }
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  if (opciones.target !== "develop" && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "APLICAR_OLIMPIADAS_PUBLICACION") throw new Error("Aplicar requiere --confirm=APLICAR_OLIMPIADAS_PUBLICACION");
  const contenido = fs.readFileSync(opciones.envFile, "utf8");
  const informes = [];
  for (const nombre of opciones.target === "all" ? ["develop", "production"] : [opciones.target]) {
    const [entorno] = obtenerEntornos({ target: nombre }, contenido, nombre === "production" ? process.env : { DB_SSL_MODE: "disabled" });
    const db = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try {
      const respaldar = async (datos) => {
        const directorio = path.resolve(__dirname, "../../output/olimpiadas-publicacion");
        fs.mkdirSync(directorio, { recursive: true });
        const archivo = path.join(directorio, `respaldo-${nombre}-${Date.now()}.json`);
        fs.writeFileSync(archivo, JSON.stringify(datos, null, 2), { flag: "wx" });
        return archivo;
      };
      const resultado = opciones.apply ? await aplicarMigracion(db, { respaldar }) : await consultarPlan(db);
      informes.push({ entorno: nombre, modo: opciones.apply ? "apply" : "check", ...resultado });
    } finally { await db.end(); }
  }
  console.log(JSON.stringify(informes, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { MIGRATION_ID, CHECKSUM, consultarPlan, aplicarMigracion };
