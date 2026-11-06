"use strict";

// Sesiones centrales de cuentas propias de predios. No modifica el esquema
// replicado, las bases locales, usuarios anteriores ni semillas.
const fs = require("node:fs");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
const TABLA = "predio_acceso_sesion";
const DDL = `CREATE TABLE IF NOT EXISTS predio_acceso_sesion (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  predio_id INT NOT NULL,
  usuario_id INT NOT NULL,
  refresh_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  refresh_anterior_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  password_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creada_en DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ultimo_uso DATETIME(6) NULL,
  gracia_hasta DATETIME(6) NULL,
  vence_en DATETIME(6) NULL,
  revocado_en DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_predio_acceso_refresh (refresh_hash),
  KEY ix_predio_acceso_anterior (refresh_anterior_hash),
  KEY ix_predio_acceso_usuario (predio_id,usuario_id,revocado_en),
  CONSTRAINT fk_predio_acceso_usuario FOREIGN KEY (predio_id,usuario_id)
    REFERENCES predio_usuario (predio_id,id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
const COLUMNAS = ["id", "predio_id", "usuario_id", "refresh_hash", "refresh_anterior_hash", "password_version", "creada_en", "ultimo_uso", "gracia_hasta", "vence_en", "revocado_en"];
async function verificarEsquema(c) {
  const [filas] = await c.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [TABLA]);
  const nombres = new Set(filas.map((f) => f.COLUMN_NAME));
  for (const col of COLUMNAS) if (!nombres.has(col)) throw new Error(`Falta ${TABLA}.${col}`);
}
async function aplicarMigracion(c) {
  const [locks] = await c.query("SELECT GET_LOCK('ajb:migration:predios-acceso-v1',15) AS tomado");
  if (Number(locks[0]?.tomado) !== 1) throw new Error("No se pudo bloquear la migración de acceso a predios");
  try {
    await c.query(DDL); await verificarEsquema(c);
    const [[base]] = await c.query("SELECT DATABASE() AS nombre");
    const [hosts] = await c.query("SELECT host FROM mysql.user WHERE user=?", ["miajb_runtime"]);
    const nombre = String(base.nombre).replace(/`/g, "``");
    for (const fila of hosts) await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON \`${nombre}\`.\`predio_acceso_sesion\` TO ?@?`, ["miajb_runtime", fila.host]);
    return { tabla: TABLA, hosts: hosts.length };
  } finally { await c.query("SELECT RELEASE_LOCK('ajb:migration:predios-acceso-v1')"); }
}
async function main(argv = process.argv.slice(2)) {
  // Igual que migrar-predios.js: sin --check aplica; también admite --apply y los
  // targets/bloques de entorno de las migraciones centrales recientes.
  const opciones = parsearArgumentos(argv.some((a) => a === "--check" || a === "--apply") ? argv : [...argv, "--apply"]);
  if (["production", "all"].includes(opciones.target) && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    if (!["localhost", "127.0.0.1", "::1"].includes(String(entorno.config.DB_HOST).toLowerCase()) && !opciones.allowProduction) throw new Error("Un host remoto requiere --allow-production");
    const c = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try { if (opciones.apply) await aplicarMigracion(c); else await verificarEsquema(c); console.log(`[predios-acceso] ${entorno.nombre}: ${opciones.apply ? "aplicada y " : ""}verificada`); }
    finally { await c.end(); }
  }
}
if (require.main === module) main().catch((e) => { console.error(`[predios-acceso] migración fallida: ${e.code || e.message}`); process.exitCode = 1; });
module.exports = { TABLA, DDL, COLUMNAS, verificarEsquema, aplicarMigracion, main };
