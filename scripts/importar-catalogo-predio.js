// Importa un catálogo (proveedores y productos) en un predio, sobre la réplica del sistema
// general. Sólo mientras el sistema general es el dueño de los datos (antes de instalar la
// notebook): lo que se cargue acá la notebook lo baja al instalarse. Si la notebook ya está
// instalada, se importa allá con predios/herramientas/importar-catalogo.js.
//
// El archivo sale de predios/herramientas/sistema-anterior (exportar-access.ps1 + convertir.js).
//
// Uso:
//   node scripts/importar-catalogo-predio.js --predio MIRAMAR --archivo catalogo.json              → simula
//   node scripts/importar-catalogo-predio.js --predio MIRAMAR --archivo catalogo.json --aplicar    → importa
//   --allow-production                                                                             → si DB_HOST no es local

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");
const { crearMysql } = require("../predios/lib/db-mysql");
const { importarCatalogo } = require("../predios/lib/importacion");

function arg(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const codigo = String(arg("predio") || "").toUpperCase();
  const archivo = arg("archivo");
  if (!codigo || !archivo) throw new Error("Uso: --predio MIRAMAR --archivo catalogo.json [--aplicar]");
  const host = String(process.env.DB_HOST || "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !process.argv.includes("--allow-production")) {
    throw new Error(`DB_HOST=${host} no es local. Para correr contra producción agregá --allow-production.`);
  }
  const datos = JSON.parse(fs.readFileSync(path.resolve(archivo), "utf8"));
  // En producción la RDS exige TLS (DB_SSL_MODE=verify-ca|verify-full + DB_SSL_CA_PATH), igual que la app.
  const modoTls = String(process.env.DB_SSL_MODE || "disabled").trim().toLowerCase();
  const pool = mysql.createPool({
    host, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
    port: Number(process.env.DB_PORT || 3306), timezone: "-03:00", dateStrings: true, decimalNumbers: true, connectionLimit: 2,
    ssl: modoTls === "disabled" ? undefined : { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true },
  });
  try {
    const [[predio]] = await pool.query("SELECT id, codigo, nombre, escritor FROM predio WHERE codigo = ?", [codigo]);
    if (!predio) throw new Error(`No existe el predio ${codigo}`);
    console.log(`Base: ${process.env.DB_DATABASE} en ${host} · predio ${predio.nombre} (id ${predio.id}, dueño de los datos: ${predio.escritor})`);
    if (predio.escritor !== "CENTRAL") {
      throw new Error("La notebook del camping ya es la dueña de los datos: importá allá con predios/herramientas/importar-catalogo.js");
    }
    const aplicar = process.argv.includes("--aplicar");
    const db = crearMysql(pool, { predioId: predio.id });
    const inicio = Date.now();
    const r = await importarCatalogo({ db, pid: predio.id }, datos, { simular: !aplicar });
    console.log(r);
    if (aplicar) {
      await pool.query("UPDATE predio SET ultima_escritura_central = NOW() WHERE id = ?", [predio.id]);
      console.log(`Importación terminada en ${Math.round((Date.now() - inicio) / 1000)} s.`);
    } else {
      console.log("Simulación: no se escribió nada. Agregá --aplicar para importar.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
