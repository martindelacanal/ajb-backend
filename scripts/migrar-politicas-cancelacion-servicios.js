"use strict";

const fs = require("fs");
const path = require("path");
const base = require("./migrar-politicas-cancelacion");

const MIGRATION_ID = "20261007_politicas_cancelacion_servicios_v2";
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;
const CORRECCION_ID = "CORRECCION_AUTORIA_INICIAL_NAHUEL";
const DETALLE_CORRECCION = "Corrección administrativa solicitada: se asigna a Nahuel la responsabilidad de la versión inicial, generada automáticamente sin autor. Esta corrección no representa una publicación realizada por él en la fecha original; se conserva la fecha y el contenido originales.";
const TABLAS = {
  politica_cancelacion_servicio: `CREATE TABLE IF NOT EXISTS politica_cancelacion_servicio (
    politica_id BIGINT UNSIGNED NOT NULL,
    servicio_id BIGINT UNSIGNED NOT NULL,
    asignada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (politica_id, servicio_id),
    CONSTRAINT fk_politica_servicio_version FOREIGN KEY (politica_id) REFERENCES politica_cancelacion (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  politica_cancelacion_servicio_vigente: `CREATE TABLE IF NOT EXISTS politica_cancelacion_servicio_vigente (
    servicio_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    politica_id BIGINT UNSIGNED NOT NULL,
    CONSTRAINT fk_politica_servicio_vigente_version FOREIGN KEY (politica_id) REFERENCES politica_cancelacion (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  politica_cancelacion_autoria_auditoria: `CREATE TABLE IF NOT EXISTS politica_cancelacion_autoria_auditoria (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    correccion_id VARCHAR(100) NOT NULL,
    politica_id BIGINT UNSIGNED NOT NULL,
    accion VARCHAR(80) NOT NULL,
    usuario_anterior_id BIGINT UNSIGNED NULL,
    usuario_nuevo_id BIGINT UNSIGNED NOT NULL,
    ejecutor VARCHAR(40) NOT NULL DEFAULT 'MIGRACION',
    detalle TEXT NOT NULL,
    creada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_politica_autoria_correccion (correccion_id, politica_id),
    CONSTRAINT fk_politica_autoria_version FOREIGN KEY (politica_id) REFERENCES politica_cancelacion (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  politica_cancelacion_migracion: `CREATE TABLE IF NOT EXISTS politica_cancelacion_migracion (
    id VARCHAR(100) NOT NULL PRIMARY KEY,
    detalle_json JSON NOT NULL,
    aplicada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};
const COLUMNAS = {
  monto_base: "DECIMAL(12,2) NULL",
  monto_reintegro: "DECIMAL(12,2) NULL",
  tipo_base: "VARCHAR(40) NULL",
};

async function resolverNahuel(connection) {
  const [administradores] = await connection.query(
    `SELECT u.id, u.nombre, u.apellido FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
       WHERE LOWER(TRIM(r.nombre)) = 'admin' ORDER BY u.id`
  );
  if (administradores.length !== 1 || String(administradores[0].nombre).trim().toLowerCase() !== "nahuel") {
    throw new Error("La corrección requiere un único usuario con rol admin y nombre Nahuel. Revisá la identidad antes de aplicar.");
  }
  return Number(administradores[0].id);
}

async function inspeccionar(connection) {
  const [tablas] = await connection.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)", [Object.keys(TABLAS)]
  );
  const [columnas] = await connection.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reserva_cancelacion_politica' AND COLUMN_NAME IN (?)", [Object.keys(COLUMNAS)]
  );
  return {
    tablasFaltantes: Object.keys(TABLAS).filter(nombre => !tablas.some(t => t.TABLE_NAME === nombre)),
    columnasFaltantes: Object.keys(COLUMNAS).filter(nombre => !columnas.some(c => c.COLUMN_NAME === nombre)),
  };
}

async function ejecutarMigracion(connection, { checkOnly = true, log = console.log } = {}) {
  // Se recibe una conexión con esquema explícito. No lee .env al importar y
  // permite al operador ejecutar develop y producción por separado.
  const nahuelId = await resolverNahuel(connection);
  const estado = await inspeccionar(connection);
  if (checkOnly) {
    const estadoBase = await base.ejecutarMigracion(connection, { checkOnly: true, log: () => {} });
    let aplicada = false;
    if (!estado.tablasFaltantes.includes("politica_cancelacion_migracion")) {
      const [marcas] = await connection.query("SELECT id FROM politica_cancelacion_migracion WHERE id = ?", [MIGRATION_ID]);
      aplicada = marcas.length > 0;
    }
    const resultado = { migration: MIGRATION_ID, modo: "check", ...estado, tablasBaseFaltantes: estadoBase.faltantes, nahuelId, aplicada };
    log(JSON.stringify(resultado));
    return resultado;
  }

  // DDL se ejecuta antes de la transacción porque MySQL hace commit implícito.
  // Es seguro reanudar tras una interrupción de DDL.
  await base.ejecutarMigracion(connection, { checkOnly: false, log: () => {} });
  for (const ddl of Object.values(TABLAS)) await connection.query(ddl);
  for (const nombre of estado.columnasFaltantes) {
    await connection.query(`ALTER TABLE reserva_cancelacion_politica ADD COLUMN ${nombre} ${COLUMNAS[nombre]}`);
  }
  await connection.beginTransaction();
  try {
    // El mismo lock que usan las publicaciones impide perder asignaciones
    // si se publica una versión mientras se inicializa la migración.
    const [actual] = await connection.query("SELECT politica_id FROM politica_cancelacion_vigente WHERE id = 1 FOR UPDATE");
    if (!actual[0]) throw new Error("Falta la política inicial de cancelación");
    const [marcas] = await connection.query("SELECT id FROM politica_cancelacion_migracion WHERE id = ? FOR UPDATE", [MIGRATION_ID]);
    if (marcas.length) {
      await connection.commit();
      log(`Migración ${MIGRATION_ID} ya aplicada; se conservan las asignaciones y auditoría.`);
      return { ...estado, aplicada: true, yaAplicada: true };
    }
    const [iniciales] = await connection.query("SELECT id, creada_por FROM politica_cancelacion WHERE version = 1 FOR UPDATE");
    if (!iniciales[0]) throw new Error("Falta la versión inicial de la política");
    const inicial = iniciales[0];
    if (inicial.creada_por != null && Number(inicial.creada_por) !== nahuelId) {
      throw new Error("La versión inicial ya tiene otro autor; no se reemplaza una autoría existente");
    }
    if (inicial.creada_por == null) {
      await connection.query(
        `INSERT INTO politica_cancelacion_autoria_auditoria
          (correccion_id, politica_id, accion, usuario_anterior_id, usuario_nuevo_id, ejecutor, detalle)
          VALUES (?, ?, 'CORRECCION_AUTORIA_INICIAL', NULL, ?, 'MIGRACION', ?)`,
        [CORRECCION_ID, inicial.id, nahuelId, DETALLE_CORRECCION]
      );
      await connection.query("UPDATE politica_cancelacion SET creada_por = ? WHERE id = ? AND creada_por IS NULL", [nahuelId, inicial.id]);
    }
    const [servicios] = await connection.query("SELECT id FROM servicio ORDER BY id FOR UPDATE");
    for (const servicio of servicios) {
      // Sólo agrega los que aún no tenían asignación: reanudar nunca cambia
      // una política por servicio que ya se haya publicado.
      await connection.query(
        "INSERT IGNORE INTO politica_cancelacion_servicio_vigente (servicio_id, politica_id) VALUES (?, ?)", [servicio.id, actual[0].politica_id]
      );
      await connection.query(
        `INSERT IGNORE INTO politica_cancelacion_servicio (politica_id, servicio_id)
          SELECT politica_id, servicio_id FROM politica_cancelacion_servicio_vigente WHERE servicio_id = ?`, [servicio.id]
      );
    }
    await connection.query("INSERT INTO politica_cancelacion_migracion (id, detalle_json) VALUES (?, ?)",
      [MIGRATION_ID, JSON.stringify({ politica_global_id: Number(actual[0].politica_id), servicios_ids: servicios.map(s => Number(s.id)), correccion_autoria_version_inicial: inicial.creada_por == null, nahuel_id: nahuelId })]);
    await connection.commit();
    log(`Migración ${MIGRATION_ID} aplicada: ${servicios.length} servicios; autoría inicial auditada. Reservas y cálculos anteriores conservados.`);
    return { ...estado, aplicada: true, yaAplicada: false, servicios: servicios.length };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
  const opciones = base.parsearArgumentos(argv);
  const { remoto } = base.validarDestino(opciones);
  const modoTls = String(process.env.DB_SSL_MODE || "disabled").toLowerCase();
  if (!["disabled", "verify-ca", "verify-full"].includes(modoTls)) throw new Error("DB_SSL_MODE inválido");
  if (remoto && process.env.NODE_ENV === "production" && modoTls === "disabled") throw new Error("TLS es obligatorio en producción remota");
  const ssl = modoTls === "disabled" ? undefined : { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true };
  const connection = await require("mysql2/promise").createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, port: Number(process.env.DB_PORT || 3306),
    timezone: "-03:00", dateStrings: ["DATE"], multipleStatements: false, ssl,
  });
  let lock = false;
  try {
    await connection.query("SET SESSION time_zone = '-03:00'");
    const [rows] = await connection.query("SELECT GET_LOCK(?, 10) AS adquirido", [MIGRATION_LOCK]);
    lock = Number(rows[0]?.adquirido) === 1;
    if (!lock) throw new Error("Otra migración de políticas por servicio está ejecutándose");
    await ejecutarMigracion(connection, opciones);
  } finally {
    if (lock) await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]).catch(() => {});
    await connection.end();
  }
}

if (require.main === module) main().catch(error => {
  console.error("Error migrando políticas por servicio:", error.message);
  process.exitCode = 1;
});

module.exports = { MIGRATION_ID, MIGRATION_LOCK, TABLAS, COLUMNAS, DETALLE_CORRECCION, ejecutarMigracion, resolverNahuel };
