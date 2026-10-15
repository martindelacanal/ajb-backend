"use strict";

const fs = require("fs");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

const SQLS = [
  `CREATE TABLE IF NOT EXISTS olimpiada_voluntario_sesion (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    voluntario_id INT NOT NULL,
    refresh_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    refresh_anterior_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    password_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sesion_version INT UNSIGNED NOT NULL,
    gracia_hasta DATETIME(6) NULL, vence_en DATETIME(6) NULL, revocado_en DATETIME(6) NULL,
    creada_en DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_oli_sesion_refresh (refresh_hash), KEY idx_oli_sesion_anterior (refresh_anterior_hash),
    CONSTRAINT fk_oli_sesion_vol FOREIGN KEY (voluntario_id) REFERENCES olimpiada_voluntario(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS olimpiada_voluntario_recuperacion (
    usuario_id INT PRIMARY KEY,
    codigo_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    password_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    correo_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    solicitado_en DATETIME(6) NOT NULL, vence_en DATETIME(6) NOT NULL,
    intentos TINYINT UNSIGNED NOT NULL DEFAULT 0,
    reset_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reset_vence_en DATETIME(6) NULL, consumido_en DATETIME(6) NULL,
    UNIQUE KEY uq_oli_recuperacion_reset (reset_hash),
    CONSTRAINT fk_oli_recuperacion_vol FOREIGN KEY (usuario_id) REFERENCES olimpiada_voluntario(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS olimpiada_voluntario_passkey (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    voluntario_id INT NOT NULL, rp_id VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    webauthn_usuario_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    credential_id VARCHAR(1400) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    clave_publica BLOB NOT NULL, contador BIGINT UNSIGNED NOT NULL DEFAULT 0,
    password_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tipo_dispositivo VARCHAR(32) NOT NULL, respaldada TINYINT(1) NOT NULL DEFAULT 0,
    transportes JSON NULL, nombre VARCHAR(100) NOT NULL DEFAULT 'Clave de acceso',
    fecha_creacion DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), fecha_ultimo_uso DATETIME(6) NULL,
    UNIQUE KEY uq_oli_passkey_credential (rp_id, credential_id),
    KEY idx_oli_passkey_usuario (voluntario_id),
    CONSTRAINT fk_oli_passkey_vol FOREIGN KEY (voluntario_id) REFERENCES olimpiada_voluntario(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS olimpiada_voluntario_desafio (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    tipo ENUM('REGISTRO','AUTENTICACION') NOT NULL, voluntario_id INT NULL,
    challenge VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    webauthn_usuario_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
    origen VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    rp_id VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recordar TINYINT(1) NOT NULL DEFAULT 0, sesion_version INT UNSIGNED NULL,
    password_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    vence_en DATETIME(6) NOT NULL, consumido_en DATETIME(6) NULL,
    KEY idx_oli_desafio_vence (vence_en),
    CONSTRAINT fk_oli_desafio_vol FOREIGN KEY (voluntario_id) REFERENCES olimpiada_voluntario(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
const TABLAS = ["olimpiada_voluntario_sesion", "olimpiada_voluntario_recuperacion", "olimpiada_voluntario_passkey", "olimpiada_voluntario_desafio"];
const COLUMNAS = {
  olimpiada_voluntario_sesion: ["id","voluntario_id","refresh_hash","refresh_anterior_hash","password_version","sesion_version","gracia_hasta","vence_en","revocado_en","creada_en"],
  olimpiada_voluntario_recuperacion: ["usuario_id","codigo_hash","password_version","correo_hash","solicitado_en","vence_en","intentos","reset_hash","reset_vence_en","consumido_en"],
  olimpiada_voluntario_passkey: ["id","voluntario_id","rp_id","webauthn_usuario_id","credential_id","clave_publica","contador","password_version","tipo_dispositivo","respaldada","transportes","nombre","fecha_creacion","fecha_ultimo_uso"],
  olimpiada_voluntario_desafio: ["id","tipo","voluntario_id","challenge","webauthn_usuario_id","origen","rp_id","recordar","sesion_version","password_version","vence_en","consumido_en"],
};
async function verificarEsquema(db) {
  const [columnas] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='olimpiada_voluntario' AND COLUMN_NAME='usuario_sistema_id'");
  const [tablas] = await db.query("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)", [TABLAS]);
  const [indices] = await db.query("SELECT INDEX_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='olimpiada_voluntario' AND INDEX_NAME='uq_oli_vol_usuario_sistema'");
  if (!columnas.length || tablas.length !== TABLAS.length || tablas.some((t) => t.ENGINE !== 'InnoDB') || !indices.some((i) => Number(i.NON_UNIQUE) === 0)) throw new Error("Falta aplicar olimpiadas-acceso-v2");
  const [campos] = await db.query("SELECT TABLE_NAME,COLUMN_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)",[TABLAS]);
  for(const [tabla,nombres] of Object.entries(COLUMNAS)) for(const nombre of nombres) {
    const campo=campos.find(c=>c.TABLE_NAME===tabla && c.COLUMN_NAME===nombre);
    if(!campo || ((nombre.endsWith("_hash") || nombre==="password_version") && campo.COLLATION_NAME!=="ascii_bin")) throw new Error(`Columna ausente o incompatible: ${tabla}.${nombre}`);
  }
}
async function aplicarMigracion(db) {
  const [lock] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-acceso-v2',15) AS tomado");
  if (Number(lock[0]?.tomado) !== 1) throw new Error("No se pudo bloquear la migración");
  try {
    const [cols] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='olimpiada_voluntario' AND COLUMN_NAME='usuario_sistema_id'");
    if (!cols.length) await db.query(`ALTER TABLE olimpiada_voluntario ADD COLUMN usuario_sistema_id INT NULL,
      ADD UNIQUE KEY uq_oli_vol_usuario_sistema (usuario_sistema_id),
      ADD CONSTRAINT fk_oli_vol_usuario_sistema FOREIGN KEY (usuario_sistema_id) REFERENCES usuario(id) ON DELETE RESTRICT`);
    for (const sql of SQLS) await db.query(sql);
    await verificarEsquema(db);
  } finally { await db.query("SELECT RELEASE_LOCK('ajb:olimpiadas-acceso-v2')"); }
}
async function otorgarPermisosRuntime(db) {
  // Sólo los hosts ya existentes de esta cuenta; no crea usuarios ni habilita DDL.
  const [[actual]]=await db.query("SELECT DATABASE() AS nombre");
  const [cuentas]=await db.query("SELECT Host FROM mysql.user WHERE User='miajb_runtime'");
  for(const cuenta of cuentas) for(const tabla of TABLAS) await db.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ${mysql.escapeId(actual.nombre)}.${mysql.escapeId(tabla)} TO 'miajb_runtime'@${mysql.escape(cuenta.Host)}`);
  return {cuentas:cuentas.length,tablas:TABLAS.length};
}
async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  if (["production", "all"].includes(opciones.target) && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "APLICAR_OLIMPIADAS_ACCESO_V2") throw new Error("Aplicar requiere --confirm=APLICAR_OLIMPIADAS_ACCESO_V2");
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const db = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try { await (opciones.apply ? aplicarMigracion(db) : verificarEsquema(db)); console.log(`[olimpiadas-acceso-v2] ${entorno.nombre}: verificada`); }
    finally { await db.end(); }
  }
}
if (require.main === module) main().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { SQLS, TABLAS, COLUMNAS, aplicarMigracion, verificarEsquema, otorgarPermisosRuntime };
