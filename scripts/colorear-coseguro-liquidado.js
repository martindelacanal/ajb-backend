"use strict";

// Coseguro: «Liquidado» (id 10) pasa del gris apagado al verde de los finales felices
// (fondo #D1FAE5, texto #047857: el mismo de «Aprobado por servicios sociales» y de
// «Aprobada» en turismo). El color sale de coseguro_estado.color / color_texto y lo
// usan el detalle del afiliado y Mis gestiones. El staff traduce el estado a su chip
// «ok» (verde) por estado_id: con el gris se veía apagado también ahí.
//
// Sólo toca la fila id 10 si se llama «Liquidado»; si no, frena sin cambiar nada.
// Idempotente: si ya tiene el verde, no hace nada.
//
//   node scripts/colorear-coseguro-liquidado.js --check             → muestra el color actual
//   node scripts/colorear-coseguro-liquidado.js                     → aplica (base local)
//   node scripts/colorear-coseguro-liquidado.js --allow-production  → obligatorio si DB_HOST no es local

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const ESTADO_LIQUIDADO = Object.freeze({ id: 10, nombre: "Liquidado", color: "#D1FAE5", color_texto: "#047857" });

const mismoColor = (a, b) => String(a || "").trim().toUpperCase() === String(b || "").trim().toUpperCase();

async function colorear(connection, { checkOnly = false } = {}) {
  const [filas] = await connection.query(
    "SELECT id, nombre, color, color_texto FROM coseguro_estado WHERE id = ?",
    [ESTADO_LIQUIDADO.id]
  );
  const fila = filas[0];
  if (!fila) throw new Error(`No existe coseguro_estado id ${ESTADO_LIQUIDADO.id}`);
  if (fila.nombre !== ESTADO_LIQUIDADO.nombre) {
    throw new Error(`coseguro_estado id ${ESTADO_LIQUIDADO.id} se llama «${fila.nombre}», no «${ESTADO_LIQUIDADO.nombre}»: no se toca`);
  }
  const antes = { color: fila.color, color_texto: fila.color_texto };
  const despues = { color: ESTADO_LIQUIDADO.color, color_texto: ESTADO_LIQUIDADO.color_texto };
  if (mismoColor(fila.color, despues.color) && mismoColor(fila.color_texto, despues.color_texto)) {
    return { cambio: false, antes, despues };
  }
  if (checkOnly) return { cambio: true, aplicado: false, antes, despues };
  const [resultado] = await connection.query(
    "UPDATE coseguro_estado SET color = ?, color_texto = ? WHERE id = ? AND nombre = ?",
    [despues.color, despues.color_texto, ESTADO_LIQUIDADO.id, ESTADO_LIQUIDADO.nombre]
  );
  return { cambio: true, aplicado: Number(resultado.affectedRows || 0) === 1, antes, despues };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--check", "--allow-production"].includes(arg))) throw new Error("Argumento no reconocido");
  const checkOnly = args.includes("--check");
  if (!checkOnly && !["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST) && !args.includes("--allow-production")) {
    throw new Error("Para tocar una base remota se requiere --allow-production");
  }
  const modoTls = process.env.DB_SSL_MODE || "disabled";
  const connection = await require("mysql2/promise").createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, port: Number(process.env.DB_PORT || 3306), timezone: "-03:00",
    ssl: modoTls === "disabled" ? undefined : { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true },
  });
  try {
    console.log(`${checkOnly ? "Chequeando" : "Coloreando"} ${process.env.DB_HOST}/${process.env.DB_DATABASE}`);
    console.log(JSON.stringify(await colorear(connection, { checkOnly }), null, 2));
  } finally {
    await connection.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { ESTADO_LIQUIDADO, colorear };
