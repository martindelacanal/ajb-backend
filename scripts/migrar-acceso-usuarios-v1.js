"use strict";

const fs = require("fs");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
const COLUMNAS = {
  bloqueo_tipo: "VARCHAR(16) NULL",
  bloqueo_modulos: "TEXT NULL",
  bloqueo_mensaje: "VARCHAR(1000) NULL",
  requiere_cambio_clave: "TINYINT(1) NOT NULL DEFAULT 0",
};

async function verificarEsquema(connection) {
  const [columnas] = await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='usuario'");
  for (const nombre of Object.keys(COLUMNAS)) {
    if (!columnas.some((c) => c.COLUMN_NAME === nombre)) throw new Error(`Falta usuario.${nombre}`);
  }
}

async function aplicarMigracion(connection) {
  const [locks] = await connection.query("SELECT GET_LOCK('ajb:acceso-usuarios-v1', 15) AS tomado");
  if (Number(locks[0]?.tomado) !== 1) throw new Error("No se pudo bloquear la migración");
  try {
    const [columnas] = await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='usuario'");
    for (const [nombre, tipo] of Object.entries(COLUMNAS)) {
      if (!columnas.some((c) => c.COLUMN_NAME === nombre)) await connection.query(`ALTER TABLE usuario ADD COLUMN ${nombre} ${tipo}`);
    }
    await verificarEsquema(connection);
  } finally { await connection.query("SELECT RELEASE_LOCK('ajb:acceso-usuarios-v1')"); }
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  if (["production", "all"].includes(opciones.target) && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "APLICAR_ACCESO_USUARIOS") throw new Error("Aplicar requiere --confirm=APLICAR_ACCESO_USUARIOS");
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const connection = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try {
      if (opciones.apply) await aplicarMigracion(connection); else await verificarEsquema(connection);
      console.log(`[acceso-usuarios] ${entorno.nombre}: ${opciones.apply ? "aplicada y " : ""}verificada`);
    } finally { await connection.end(); }
  }
}
if (require.main === module) main().catch((error) => {
  console.error(`[acceso-usuarios] migración fallida: ${error?.code || error?.message}`); process.exitCode = 1;
});
module.exports = { COLUMNAS, aplicarMigracion, verificarEsquema };
