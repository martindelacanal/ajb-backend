"use strict";

// Avisos ya guardados con el código viejo «#N» (2026-10-23): pasan al código que se ve en las
// pantallas, igual que los avisos nuevos.
//
//   reservas de turismo (RESERVA_*)  «Reserva #41», «turismo #41», «salud #41» → «T-41»
//   coseguro (COSEGURO_*)            «Solicitud #22», «reintegro #22»         → «C-22»
//   traslados (TRASLADO_*)           «traslado #7»                            → «TR-7»
//   olimpíadas (OLIMPIADA_*)         «Inscripción #12»                        → «Inscripción Nº 012»
//
// Sólo toca el título y el mensaje, y sólo donde el número sigue a esas palabras (un cupón
// «#2026» queda igual). Idempotente: lo ya convertido no vuelve a coincidir.
//
//   node scripts/unificar-codigos-avisos.js --check             → cuenta y muestra ejemplos
//   node scripts/unificar-codigos-avisos.js                     → aplica (base local)
//   node scripts/unificar-codigos-avisos.js --allow-production  → obligatorio si DB_HOST no es local

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const REGLAS = [
  { prefijo: "RESERVA_", patron: /\b(reserva|turismo|convenio|salud) #(\d+)\b/gi, codigo: (n) => `T-${n}` },
  { prefijo: "COSEGURO_", patron: /\b(solicitud|reintegro) #(\d+)\b/gi, codigo: (n) => `C-${n}` },
  { prefijo: "TRASLADO_", patron: /\b(traslado) #(\d+)\b/gi, codigo: (n) => `TR-${n}` },
  { prefijo: "OLIMPIADA_", patron: /\b(inscripción) #(\d+)\b/gi, codigo: (n) => `Nº ${String(n).padStart(3, "0")}` },
];
const LARGO_TITULO = 180;

function reglaPara(tipo) {
  return REGLAS.find((regla) => String(tipo || "").startsWith(regla.prefijo)) || null;
}

function convertir(texto, regla) {
  if (typeof texto !== "string" || !regla) return texto;
  return texto.replace(regla.patron, (_, palabra, numero) => `${palabra} ${regla.codigo(numero)}`);
}

/** Título y mensaje con el código nuevo; null si no cambia nada. */
function convertirAviso(aviso) {
  const regla = reglaPara(aviso.tipo);
  if (!regla) return null;
  let titulo = convertir(aviso.titulo, regla);
  if (typeof titulo === "string" && titulo.length > LARGO_TITULO) titulo = `${titulo.slice(0, LARGO_TITULO - 1)}…`;
  const mensaje = convertir(aviso.mensaje, regla);
  if (titulo === aviso.titulo && mensaje === aviso.mensaje) return null;
  return { titulo, mensaje };
}

async function unificar(connection, { checkOnly = false } = {}) {
  const [avisos] = await connection.query(
    `SELECT id, tipo, titulo, mensaje FROM notificacion
      WHERE (titulo REGEXP '#[0-9]' OR mensaje REGEXP '#[0-9]')
        AND (tipo LIKE 'RESERVA\\_%' OR tipo LIKE 'COSEGURO\\_%' OR tipo LIKE 'TRASLADO\\_%' OR tipo LIKE 'OLIMPIADA\\_%')
      ORDER BY id`);
  const porTipo = {};
  const ejemplos = [];
  let actualizados = 0;
  for (const aviso of avisos) {
    const nuevo = convertirAviso(aviso);
    if (!nuevo) continue;
    porTipo[aviso.tipo] = (porTipo[aviso.tipo] || 0) + 1;
    if (ejemplos.length < 8) ejemplos.push({ antes: aviso.titulo, despues: nuevo.titulo });
    if (checkOnly) continue;
    const [cambio] = await connection.query(
      "UPDATE notificacion SET titulo = ?, mensaje = ? WHERE id = ? AND titulo <=> ? AND mensaje <=> ?",
      [nuevo.titulo, nuevo.mensaje, aviso.id, aviso.titulo, aviso.mensaje]);
    actualizados += Number(cambio.affectedRows || 0);
  }
  const total = Object.values(porTipo).reduce((suma, n) => suma + n, 0);
  return checkOnly ? { a_convertir: total, por_tipo: porTipo, ejemplos } : { convertidos: actualizados, por_tipo: porTipo, ejemplos };
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
    console.log(`${checkOnly ? "Chequeando" : "Unificando"} ${process.env.DB_HOST}/${process.env.DB_DATABASE}`);
    console.log(JSON.stringify(await unificar(connection, { checkOnly }), null, 2));
  } finally {
    await connection.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { REGLAS, convertir, convertirAviso, unificar };
