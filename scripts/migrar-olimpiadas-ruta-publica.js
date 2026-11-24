"use strict";

const fs = require("node:fs");
const net = require("node:net");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
const { INDICE_RUTA } = require("../api/services/olimpiadas-ruta-publica");

const RUTA_MIRAMAR = "olimpiadas2026";

async function planEsquema(db) {
  const [[columna]] = await db.query(`SELECT COLUMN_TYPE AS tipo, IS_NULLABLE AS anulable, COLLATION_NAME AS colacion
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada' AND COLUMN_NAME = 'ruta_publica'`);
  const [indice] = await db.query(`SELECT COLUMN_NAME AS columna, NON_UNIQUE AS noUnico, SUB_PART AS prefijo
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada' AND INDEX_NAME = ?`, [INDICE_RUTA]);
  if (columna && (columna.tipo !== "varchar(80)" || columna.anulable !== "YES" || columna.colacion !== "ascii_bin")) {
    throw new Error("La definición existente de ruta_publica difiere de la esperada");
  }
  if (indice.length && (indice.length !== 1 || indice[0].columna !== "ruta_publica" || Number(indice[0].noUnico) !== 0 || indice[0].prefijo !== null)) {
    throw new Error("El índice existente de ruta_publica difiere del esperado");
  }
  const cambios = [];
  if (!columna) cambios.push("ADD COLUMN ruta_publica VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL");
  if (!indice.length) cambios.push(`ADD UNIQUE KEY ${INDICE_RUTA} (ruta_publica)`);
  return { cambios, existeColumna: !!columna };
}

async function revisarMiramar(db, existeColumna, bloquear = false) {
  const [[edicion]] = await db.query(`SELECT id, nombre, fecha_inicio, fecha_fin, ${existeColumna ? "ruta_publica" : "NULL AS ruta_publica"}
    FROM olimpiada WHERE id = 2 AND fecha_inicio = '2026-11-26' AND fecha_fin = '2026-11-29'
      AND eliminado = 0 AND habilitado = 'Y' AND publicada_publico = 1${bloquear ? " FOR UPDATE" : ""}`);
  if (!edicion) throw new Error("La edición pública 2 del 26 al 29/11/2026 no coincide");
  if (edicion.ruta_publica !== null && edicion.ruta_publica !== RUTA_MIRAMAR) {
    throw new Error("La edición ya tiene otra ruta pública");
  }
  if (existeColumna) {
    const [otras] = await db.query("SELECT id FROM olimpiada WHERE ruta_publica = ? AND id <> 2", [RUTA_MIRAMAR]);
    if (otras.length) throw new Error("Otra edición ya utiliza la ruta solicitada");
  }
  return edicion;
}

async function migrar(db, { apply, asignarMiramar }) {
  const { cambios, existeColumna } = await planEsquema(db);
  let edicion = asignarMiramar ? await revisarMiramar(db, existeColumna) : null;
  if (!apply) return { cambios, edicion };
  if (cambios.length) await db.query("ALTER TABLE olimpiada " + cambios.join(", "));
  if (asignarMiramar) {
    await db.beginTransaction();
    try {
      edicion = await revisarMiramar(db, true, true);
      if (edicion.ruta_publica === null) {
        await db.query("UPDATE olimpiada SET ruta_publica = ? WHERE id = ?", [RUTA_MIRAMAR, edicion.id]);
        await db.query(`INSERT INTO olimpiada_historial (entidad, entidad_id, olimpiada_id, tipo_operacion, campo_modificado, valor_nuevo, observacion)
          VALUES ('OLIMPIADA', ?, ?, 'UPDATE', 'ruta_publica', ?, 'Configuración inicial del enlace de Miramar 2026')`,
        [edicion.id, edicion.id, RUTA_MIRAMAR]);
        edicion.ruta_publica = RUTA_MIRAMAR;
      }
      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    }
  }
  return { cambios, edicion };
}

async function main() {
  const opciones = parsearArgumentos();
  if (opciones.target !== "develop" && !opciones.allowProduction) throw new Error("Producción requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "OLIMPIADAS_RUTA_PUBLICA") throw new Error("Aplicar requiere --confirm=OLIMPIADAS_RUTA_PUBLICA");
  const asignarMiramar = process.argv.includes("--asignar-miramar-2026");
  if (asignarMiramar && opciones.target !== "production") throw new Error("La asignación de Miramar corresponde a producción");
  const puertoTunel = process.argv.find(arg => arg.startsWith("--puerto-tunel="))?.slice("--puerto-tunel=".length);
  if (puertoTunel !== undefined && (!/^\d{1,5}$/.test(puertoTunel) || Number(puertoTunel) < 1 || Number(puertoTunel) > 65535)) {
    throw new Error("El puerto del túnel debe ser un entero entre 1 y 65535");
  }
  for (const e of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const conexion = crearOpcionesConexion(e.config);
    // Sólo cambia el transporte. mysql2 sigue verificando el certificado TLS contra el host original de RDS.
    if (puertoTunel) conexion.stream = () => net.connect({ host: "127.0.0.1", port: Number(puertoTunel) });
    if (conexion.ssl && e.config.DB_SSL_MODE === "verify-full") conexion.ssl.verifyIdentity = true;
    const db = await mysql.createConnection(conexion);
    try {
      const [[lock]] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-ruta-publica', 15) AS adquirido");
      if (!lock.adquirido) throw new Error("Hay otra migración de rutas en curso");
      const resultado = await migrar(db, { apply: opciones.apply, asignarMiramar });
      console.log(JSON.stringify({ entorno: e.nombre, modo: opciones.apply ? "apply" : "check", ...resultado }));
    } finally {
      await db.end();
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { migrar };
