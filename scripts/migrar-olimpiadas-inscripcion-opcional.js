"use strict";

const fs = require("node:fs");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

// Las ediciones que sólo publican su programa no tienen una ventana de inscripción.
// Se conserva el CHECK de cronología original y se exige que las fechas se informen juntas.
async function migrar(db, aplicar) {
  const [columnas] = await db.query(
    "SELECT COLUMN_NAME AS nombre, IS_NULLABLE AS admiteNulos FROM information_schema.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada'"
  );
  const cambios = [];
  for (const campo of ["fecha_inicio_inscripcion", "fecha_fin_inscripcion"]) {
    const columna = columnas.find(c => c.nombre === campo);
    if (!columna) throw new Error("Falta la columna " + campo);
    if (columna.admiteNulos === "NO") cambios.push("MODIFY " + campo + " DATE NULL");
  }
  const [checks] = await db.query(
    "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() " +
    "AND TABLE_NAME = 'olimpiada' AND CONSTRAINT_NAME = 'ajb_chk_olimpiada_inscripcion_par'"
  );
  if (!checks.length) cambios.push("ADD CONSTRAINT ajb_chk_olimpiada_inscripcion_par " +
    "CHECK ((fecha_inicio_inscripcion IS NULL) = (fecha_fin_inscripcion IS NULL))");
  if (aplicar && cambios.length) await db.query("ALTER TABLE olimpiada " + cambios.join(", "));
  return cambios;
}

async function main() {
  const opciones = parsearArgumentos();
  for (const e of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    if (e.nombre === "production" && !opciones.allowProduction) throw new Error("Indicá --allow-production");
    if (opciones.apply && opciones.confirmacion !== "OLIMPIADAS_INSCRIPCION_OPCIONAL") {
      throw new Error("Indicá --confirm=OLIMPIADAS_INSCRIPCION_OPCIONAL");
    }
    const conexion = crearOpcionesConexion(e.config);
    if (conexion.ssl && e.config.DB_SSL_MODE === "verify-full") conexion.ssl.verifyIdentity = true;
    const db = await mysql.createConnection(conexion);
    try {
      const [[lock]] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-inscripcion-opcional', 15) AS adquirido");
      if (!lock.adquirido) throw new Error("Hay otra migración en curso");
      const cambios = await migrar(db, opciones.apply);
      console.log(e.nombre, opciones.apply ? "aplicados" : "pendientes", cambios.length);
    } finally {
      await db.end();
    }
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.sqlMessage || error.code || error.message);
  process.exitCode = 1;
});
