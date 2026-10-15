"use strict";

// Check por defecto. No crea usuarios ni manda correos. Las cuentas externas
// viven fuera de usuario para no heredar acceso a afiliación u otros módulos.
const fs = require("fs");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

const SQLS = [
  `CREATE TABLE IF NOT EXISTS olimpiada_voluntario (
    id INT NOT NULL AUTO_INCREMENT,
    nombre VARCHAR(160) NOT NULL,
    usuario VARCHAR(60) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
    email VARCHAR(254) NOT NULL,
    password_hash CHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    habilitado TINYINT(1) NOT NULL DEFAULT 1,
    sesion_version INT UNSIGNED NOT NULL DEFAULT 1,
    creado_por_usuario_id INT NULL,
    ultimo_correo_en DATETIME NULL,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_oli_voluntario_usuario (usuario),
    UNIQUE KEY uq_oli_voluntario_email (email),
    KEY idx_oli_voluntario_nombre (nombre),
    CONSTRAINT fk_oli_voluntario_creador FOREIGN KEY (creado_por_usuario_id) REFERENCES usuario(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS olimpiada_voluntario_disciplina (
    voluntario_id INT NOT NULL,
    olimpiada_id INT NOT NULL,
    disciplina_id INT NOT NULL,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (voluntario_id, olimpiada_id, disciplina_id),
    KEY idx_oli_voluntario_edicion_disciplina (olimpiada_id, disciplina_id),
    CONSTRAINT fk_oli_vol_asignacion_usuario FOREIGN KEY (voluntario_id) REFERENCES olimpiada_voluntario(id) ON DELETE CASCADE,
    CONSTRAINT fk_oli_vol_asignacion_edicion FOREIGN KEY (olimpiada_id) REFERENCES olimpiada(id) ON DELETE CASCADE,
    CONSTRAINT fk_oli_vol_asignacion_disciplina FOREIGN KEY (disciplina_id) REFERENCES olimpiada_disciplina(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const COLUMNAS = {
  olimpiada_voluntario: ["id", "nombre", "usuario", "email", "password_hash", "habilitado", "sesion_version", "creado_por_usuario_id", "ultimo_correo_en", "fecha_creacion", "fecha_modificacion"],
  olimpiada_voluntario_disciplina: ["voluntario_id", "olimpiada_id", "disciplina_id", "fecha_creacion"],
};

async function verificarEsquema(connection) {
  const tablas = Object.keys(COLUMNAS);
  const [columns] = await connection.query("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)", [tablas]);
  const faltantes = [];
  for (const [tabla, nombres] of Object.entries(COLUMNAS)) {
    for (const nombre of nombres) if (!columns.some((c) => c.TABLE_NAME === tabla && c.COLUMN_NAME === nombre)) faltantes.push(`${tabla}.${nombre}`);
  }
  if (faltantes.length) throw new Error(`Falta migrar: ${faltantes.join(", ")}`);
  const [indices] = await connection.query("SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)", [tablas]);
  for (const [tabla, indice] of [["olimpiada_voluntario", "uq_oli_voluntario_usuario"], ["olimpiada_voluntario", "uq_oli_voluntario_email"], ["olimpiada_voluntario_disciplina", "PRIMARY"]]) {
    if (!indices.some((i) => i.TABLE_NAME === tabla && i.INDEX_NAME === indice && Number(i.NON_UNIQUE) === 0)) throw new Error(`Falta índice único ${tabla}.${indice}`);
  }
  const [engines] = await connection.query("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)", [tablas]);
  if (engines.length !== tablas.length || engines.some((t) => t.ENGINE !== "InnoDB")) throw new Error("Las tablas de colaboradores deben usar InnoDB");
  // El limitador de login reutiliza auth_limite, ya desplegado por auth-v1.
  const [limite] = await connection.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_limite'");
  if (!limite.length) throw new Error("Falta auth_limite: aplicar primero migrar-auth-v1.js");
}

async function aplicarMigracion(connection) {
  const [locks] = await connection.query("SELECT GET_LOCK('ajb:olimpiadas-voluntarios-v1', 15) AS tomado");
  if (Number(locks[0]?.tomado) !== 1) throw new Error("No se pudo bloquear la migración de colaboradores");
  try {
    for (const sql of SQLS) await connection.query(sql);
    await verificarEsquema(connection);
  } finally { await connection.query("SELECT RELEASE_LOCK('ajb:olimpiadas-voluntarios-v1')"); }
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  if (["production", "all"].includes(opciones.target) && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "APLICAR_OLIMPIADAS_VOLUNTARIOS") throw new Error("Aplicar requiere --confirm=APLICAR_OLIMPIADAS_VOLUNTARIOS");
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const connection = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try {
      if (opciones.apply) await aplicarMigracion(connection); else await verificarEsquema(connection);
      console.log(`[olimpiadas-voluntarios] ${entorno.nombre}: ${opciones.apply ? "aplicada y " : ""}verificada`);
    } finally { await connection.end(); }
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`[olimpiadas-voluntarios] migración fallida: ${error?.code || error?.message}`); process.exitCode = 1;
});
module.exports = { SQLS, COLUMNAS, verificarEsquema, aplicarMigracion };
