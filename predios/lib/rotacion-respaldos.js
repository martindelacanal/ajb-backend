"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Sólo gestiona las copias SQLite generadas por este servidor.
const nombreRespaldo = /^predio-\d{4}-\d{2}-\d{2}(?:-\d{2}-\d{2}-\d{2}-(?:manual|antes-de-importar)(?:-\d+)?)?\.db$/;

function listarRespaldos(carpeta) {
  return fs.readdirSync(carpeta, { withFileTypes: true })
    .filter((f) => f.isFile() && nombreRespaldo.test(f.name))
    .map(({ name }) => {
      const s = fs.statSync(path.join(carpeta, name));
      return { nombre: name, tamano: s.size, modificado: s.mtimeMs };
    }).sort((a, b) => b.modificado - a.modificado || b.nombre.localeCompare(a.nombre));
}

function rotarRespaldos(carpeta) {
  for (const copia of listarRespaldos(carpeta).slice(30)) fs.unlinkSync(path.join(carpeta, copia.nombre));
}

module.exports = { listarRespaldos, rotarRespaldos };
