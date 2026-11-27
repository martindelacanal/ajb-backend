"use strict";

const fs = require("node:fs");
const net = require("node:net");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

const CONFIRMACION = "OLIMPIADAS_MOTIVO_RESULTADO";

async function migrar(db, aplicar = false) {
  const [[columna]] = await db.query(`SELECT DATA_TYPE AS tipo, CHARACTER_MAXIMUM_LENGTH AS maximo, IS_NULLABLE AS anulable, COLUMN_DEFAULT AS defecto
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada_partido' AND COLUMN_NAME = 'motivo_resultado'`);
  if (columna && (columna.tipo !== "varchar" || Number(columna.maximo) !== 300 || columna.anulable !== "YES" || columna.defecto != null)) {
    throw new Error("La columna motivo_resultado existente difiere de la esperada");
  }
  if (aplicar && !columna) {
    await db.query("ALTER TABLE olimpiada_partido ADD COLUMN motivo_resultado VARCHAR(300) NULL COMMENT 'Motivo público del resultado sin marcador'");
  }
  return { agregarColumna: !columna };
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  if (opciones.target !== "develop" && !opciones.allowProduction) throw new Error("Producción requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== CONFIRMACION) throw new Error(`Aplicar requiere --confirm=${CONFIRMACION}`);
  const puerto = argv.find(arg => arg.startsWith("--puerto-tunel="))?.slice("--puerto-tunel=".length);
  if (puerto !== undefined && (!/^\d{1,5}$/.test(puerto) || Number(puerto) < 1 || Number(puerto) > 65535)) {
    throw new Error("El puerto del túnel es inválido");
  }
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const conexion = crearOpcionesConexion(entorno.config);
    if (puerto) conexion.stream = () => net.connect({ host: "127.0.0.1", port: Number(puerto) });
    if (conexion.ssl && entorno.config.DB_SSL_MODE === "verify-full") conexion.ssl.verifyIdentity = true;
    const db = await mysql.createConnection(conexion);
    try {
      const [[lock]] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-motivo-resultado', 15) AS tomado");
      if (Number(lock.tomado) !== 1) throw new Error("Hay otra migración del motivo del resultado en curso");
      const resultado = await migrar(db, opciones.apply);
      console.log(JSON.stringify({ entorno: entorno.nombre, modo: opciones.apply ? "apply" : "check", ...resultado }));
    } finally { await db.end(); }
  }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { migrar };
