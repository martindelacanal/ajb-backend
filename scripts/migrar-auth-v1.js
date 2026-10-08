"use strict";

const fs = require("fs");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

const SQLS = [
  `CREATE TABLE IF NOT EXISTS auth_sesion (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    usuario_id INT NOT NULL,
    refresh_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    refresh_anterior_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    password_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    gracia_hasta DATETIME(6) NULL,
    vence_en DATETIME(6) NULL,
    revocado_en DATETIME(6) NULL,
    creada_en DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    ultimo_uso DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id), UNIQUE KEY uq_auth_refresh (refresh_hash),
    KEY idx_auth_refresh_anterior (refresh_anterior_hash), KEY idx_auth_sesion_usuario (usuario_id),
    CONSTRAINT fk_auth_sesion_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS auth_recuperacion (
    usuario_id INT NOT NULL,
    codigo_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    password_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    correo_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    solicitado_en DATETIME(6) NOT NULL,
    vence_en DATETIME(6) NOT NULL,
    intentos TINYINT UNSIGNED NOT NULL DEFAULT 0,
    reset_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reset_vence_en DATETIME(6) NULL,
    consumido_en DATETIME(6) NULL,
    PRIMARY KEY (usuario_id), UNIQUE KEY uq_auth_reset (reset_hash),
    CONSTRAINT fk_auth_recuperacion_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS auth_limite (
    clave CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    cantidad INT UNSIGNED NOT NULL DEFAULT 0,
    vence_en DATETIME(6) NOT NULL,
    PRIMARY KEY (clave), KEY idx_auth_limite_vence (vence_en)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const COLUMNAS = {
  auth_sesion: ["id", "usuario_id", "refresh_hash", "refresh_anterior_hash", "password_version", "gracia_hasta", "vence_en", "revocado_en", "creada_en", "ultimo_uso"],
  auth_recuperacion: ["usuario_id", "codigo_hash", "password_version", "correo_hash", "solicitado_en", "vence_en", "intentos", "reset_hash", "reset_vence_en", "consumido_en"],
  auth_limite: ["clave", "cantidad", "vence_en"],
};

async function verificarEsquema(connection) {
  const [columnas] = await connection.query(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND (TABLE_NAME IN ('auth_sesion','auth_recuperacion','auth_limite') OR (TABLE_NAME='usuario' AND COLUMN_NAME='auth_revocado_desde'))`);
  const revocacion = columnas.find((r) => r.TABLE_NAME === "usuario");
  if (!revocacion || revocacion.COLUMN_TYPE !== "datetime(6)" || revocacion.IS_NULLABLE !== "YES") throw new Error("Falta usuario.auth_revocado_desde DATETIME(6) NULL");
  for (const [tabla, nombres] of Object.entries(COLUMNAS)) {
    for (const nombre of nombres) {
      const row = columnas.find((r) => r.TABLE_NAME === tabla && r.COLUMN_NAME === nombre);
      if (!row) throw new Error(`Falta ${tabla}.${nombre}`);
      const tipo = nombre === "usuario_id" ? "int"
        : nombre === "id" ? "char(36)"
          : /hash$|version$|clave$/.test(nombre) ? "char(64)"
            : nombre === "intentos" ? "tinyint unsigned"
              : nombre === "cantidad" ? "int unsigned" : "datetime(6)";
      if (row.COLUMN_TYPE !== tipo) throw new Error(`Tipo incompatible: ${tabla}.${nombre}`);
      if (/^char/.test(tipo) && row.COLLATION_NAME !== "ascii_bin") throw new Error(`Collation incompatible: ${tabla}.${nombre}`);
    }
    const [engines] = await connection.query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [tabla]);
    if (engines[0]?.ENGINE !== "InnoDB") throw new Error(`${tabla} debe usar InnoDB`);
  }
  const [indices] = await connection.query(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('auth_sesion','auth_recuperacion','auth_limite')`);
  for (const [tabla, indice] of [["auth_sesion", "uq_auth_refresh"], ["auth_recuperacion", "uq_auth_reset"],
    ["auth_sesion", "PRIMARY"], ["auth_recuperacion", "PRIMARY"], ["auth_limite", "PRIMARY"]]) {
    if (!indices.some((r) => r.TABLE_NAME === tabla && r.INDEX_NAME === indice && Number(r.NON_UNIQUE) === 0)) throw new Error(`Falta índice único ${tabla}.${indice}`);
  }
}

async function aplicarMigracion(connection) {
  const [locks] = await connection.query("SELECT GET_LOCK('ajb:auth-v1', 15) AS tomado");
  if (Number(locks[0]?.tomado) !== 1) throw new Error("No se pudo bloquear la migración");
  try {
    const [columnas] = await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='usuario' AND COLUMN_NAME='auth_revocado_desde'");
    if (!columnas.length) await connection.query("ALTER TABLE usuario ADD COLUMN auth_revocado_desde DATETIME(6) NULL");
    for (const sql of SQLS) await connection.query(sql);
    await verificarEsquema(connection);
  } finally { await connection.query("SELECT RELEASE_LOCK('ajb:auth-v1')"); }
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  if (["production", "all"].includes(opciones.target) && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "APLICAR_AUTH") throw new Error("Aplicar requiere --confirm=APLICAR_AUTH");
  const entornos = obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"));
  for (const entorno of entornos) {
    const connection = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try {
      if (opciones.apply) await aplicarMigracion(connection); else await verificarEsquema(connection);
      console.log(`[auth] ${entorno.nombre}: ${opciones.apply ? "aplicada y " : ""}verificada`);
    } finally { await connection.end(); }
  }
}
if (require.main === module) main().catch((error) => {
  console.error(`[auth] migración fallida: ${error?.code || error?.message}`); process.exitCode = 1;
});
module.exports = { SQLS, COLUMNAS, aplicarMigracion, verificarEsquema };
