"use strict";

// Idempotente. Ejecutar ANTES del deploy. Por defecto sólo revisa el esquema.
// node scripts/migrar-kits-departamentales.js --apply [--allow-production] [--skip-grants]
const mysql = require("mysql2/promise");
const fs = require("node:fs");
const TABLAS = ["kit_campania", "kit_opcion", "kit_inscripcion", "kit_inscripcion_historial"];
const DDL = [
  `CREATE TABLE IF NOT EXISTS kit_campania (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, departamental_id INT NOT NULL,
    titulo VARCHAR(180) NOT NULL, descripcion TEXT NULL, imagen_archivo VARCHAR(500) NULL,
    inscripcion_desde DATE NOT NULL, inscripcion_hasta DATE NOT NULL,
    entrega_desde DATE NULL, entrega_hasta DATE NULL, lugar_entrega VARCHAR(500) NULL,
    publicado TINYINT(1) NOT NULL DEFAULT 0, creado_por INT NOT NULL,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_kit_campania_dept (departamental_id, publicado, inscripcion_hasta),
    CONSTRAINT fk_kit_campania_dept FOREIGN KEY (departamental_id) REFERENCES departamental(id),
    CONSTRAINT fk_kit_campania_creador FOREIGN KEY (creado_por) REFERENCES usuario(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS kit_opcion (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, campania_id INT NOT NULL,
    nombre VARCHAR(180) NOT NULL, descripcion TEXT NULL,
    destinatario ENUM('HIJO','TITULAR') NOT NULL, activo TINYINT(1) NOT NULL DEFAULT 1,
    orden INT NOT NULL DEFAULT 0, KEY idx_kit_opcion_campania (campania_id, activo),
    CONSTRAINT fk_kit_opcion_campania FOREIGN KEY (campania_id) REFERENCES kit_campania(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS kit_inscripcion (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, campania_id INT NOT NULL, opcion_id INT NOT NULL, usuario_id INT NOT NULL,
    nombre_beneficiario VARCHAR(180) NOT NULL, dni_beneficiario VARCHAR(9) NOT NULL,
    vinculo ENUM('HIJO','TITULAR') NOT NULL, anio_cursada VARCHAR(80) NOT NULL, observaciones TEXT NULL,
    documento_archivo VARCHAR(500) NULL, documento_nombre VARCHAR(255) NULL, documento_mime VARCHAR(80) NULL,
    estado ENUM('PENDIENTE','APROBADA','LISTA_RETIRO','ENTREGADA','RECHAZADA','CANCELADA') NOT NULL DEFAULT 'PENDIENTE',
    observacion_estado TEXT NULL, resuelto_por INT NULL,
    dni_activo VARCHAR(9) GENERATED ALWAYS AS (CASE WHEN estado NOT IN ('RECHAZADA','CANCELADA') THEN dni_beneficiario ELSE NULL END) STORED,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_kit_dni_campania (campania_id, dni_activo),
    KEY idx_kit_inscripcion_usuario (usuario_id, fecha_creacion), KEY idx_kit_inscripcion_estado (campania_id, estado),
    CONSTRAINT fk_kit_inscripcion_campania FOREIGN KEY (campania_id) REFERENCES kit_campania(id),
    CONSTRAINT fk_kit_inscripcion_opcion FOREIGN KEY (opcion_id) REFERENCES kit_opcion(id),
    CONSTRAINT fk_kit_inscripcion_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id),
    CONSTRAINT fk_kit_inscripcion_resuelto FOREIGN KEY (resuelto_por) REFERENCES usuario(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS kit_inscripcion_historial (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, inscripcion_id INT NOT NULL,
    estado VARCHAR(30) NOT NULL, observacion TEXT NULL, usuario_id INT NOT NULL,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_kit_historial (inscripcion_id, id),
    CONSTRAINT fk_kit_historial_inscripcion FOREIGN KEY (inscripcion_id) REFERENCES kit_inscripcion(id),
    CONSTRAINT fk_kit_historial_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
];
async function migrar(db, { aplicar = false, grants = true, database, log = console.log } = {}) {
  if (aplicar) {
    for (const sql of DDL) await db.query(sql);
    if (grants) {
      const [cuentas] = await db.query("SELECT user, host FROM mysql.user WHERE user = 'miajb_runtime'");
      if (!cuentas.length) throw new Error("No se encontró el usuario runtime para otorgar permisos");
      for (const cuenta of cuentas) for (const tabla of TABLAS) {
        const permisos = tabla === 'kit_inscripcion_historial' ? 'SELECT, INSERT' : 'SELECT, INSERT, UPDATE';
        await db.query(`GRANT ${permisos} ON ${mysql.escapeId(database)}.${mysql.escapeId(tabla)} TO ${mysql.escape(cuenta.user)}@${mysql.escape(cuenta.host)}`);
      }
    }
  }
  const [rows] = await db.query("SELECT TABLE_NAME AS nombre FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)", [TABLAS]);
  const faltantes = TABLAS.filter((tabla) => !rows.some((row) => row.nombre === tabla));
  log(JSON.stringify({ aplicacion: aplicar, tablas: rows.map((row) => row.nombre), faltantes }));
  if (aplicar && faltantes.length) throw new Error("La migración quedó incompleta");
  return { faltantes };
}
async function main() {
  require("dotenv").config();
  const args = process.argv.slice(2);
  const remoto = !["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST);
  if (remoto && !args.includes("--allow-production")) throw new Error("Para una base remota agregá --allow-production");
  const sslMode = process.env.DB_SSL_MODE || "disabled";
  const ssl = sslMode !== "disabled" ? { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true } : undefined;
  if (remoto && process.env.NODE_ENV === "production" && !ssl) throw new Error("La conexión de producción requiere TLS");
  const db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, port: process.env.DB_PORT || 3306, timezone: "-03:00", ssl });
  try { await migrar(db, { aplicar: args.includes("--apply"), grants: !args.includes("--skip-grants"), database: process.env.DB_DATABASE }); }
  finally { await db.end(); }
}
if (require.main === module) main().catch((error) => { console.error("No se completó la migración de kits:", error.code || error.message); process.exitCode = 1; });
module.exports = { TABLAS, DDL, migrar };
