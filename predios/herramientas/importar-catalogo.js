"use strict";

// Importa un catálogo (proveedores y productos) en la base local de una notebook del camping.
// Sirve cuando la notebook ya es la dueña de los datos; antes de instalarla, el catálogo se
// carga en el sistema general con scripts/importar-catalogo-predio.js (en BACKEND).
//
// Uso (con el servidor detenido o andando, da igual: SQLite espera su turno):
//   node herramientas/importar-catalogo.js --base C:\AJB-Predio --archivo catalogo.json            → sólo muestra qué haría
//   node herramientas/importar-catalogo.js --base C:\AJB-Predio --archivo catalogo.json --aplicar  → importa

const path = require("node:path");
const fs = require("node:fs");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { importarCatalogo } = require("../lib/importacion");

function arg(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

(async () => {
  const base = path.resolve(arg("base") || ".local");
  const archivo = arg("archivo");
  if (!archivo) throw new Error("Falta --archivo catalogo.json");
  const datos = JSON.parse(fs.readFileSync(path.resolve(archivo), "utf8"));
  const rutaDb = path.join(base, "datos", "predio.db");
  if (!fs.existsSync(rutaDb)) throw new Error(`No hay base en ${rutaDb}`);
  const config = fs.existsSync(path.join(base, "config.json")) ? JSON.parse(fs.readFileSync(path.join(base, "config.json"), "utf8")) : {};
  const pid = Number(config.predio_id) || 1;
  const db = crearSqlite(rutaDb, { predioId: pid });
  asegurarEsquema(db);
  const aplicar = process.argv.includes("--aplicar");
  const r = await importarCatalogo({ db, pid }, datos, { simular: !aplicar });
  console.log(r);
  console.log(aplicar ? "Importación terminada." : "Simulación: no se escribió nada. Agregá --aplicar para importar.");
  db.cerrar();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
