"use strict";
const fs = require("node:fs");
const path = require("node:path");
function bloquearInstalacion(base) {
  const archivo = path.join(base, "datos", "servidor-candado.db");
  fs.mkdirSync(path.dirname(archivo), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require("node:sqlite");
  const candado = new DatabaseSync(archivo);
  try { candado.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch (_e) { candado.close(); throw new Error("Ya hay un servidor usando esta instalación"); }
  let cerrado = false;
  // El bloqueo del sistema operativo se libera también si el proceso se cae.
  return () => { if (!cerrado) { cerrado = true; try { candado.exec("ROLLBACK"); } finally { candado.close(); } } };
}
module.exports = { bloquearInstalacion };
