"use strict";

const { normalizarNombre } = require("./olimpiadas-competicion");

// El nombre manual puede estar escrito como «apellido, nombre» o en orden directo.
function claveNombre(nombre) {
  return normalizarNombre(nombre).split(" ").filter(Boolean).sort().join(" ");
}

async function nombresVeedoresOcultos(db) {
  const [cuentas] = await db.query(`SELECT v.nombre, CONCAT_WS(' ', u.nombre, u.apellido) AS nombre_vinculado
    FROM olimpiada_voluntario v LEFT JOIN usuario u ON u.id = v.usuario_sistema_id
    WHERE v.visible_publico = 0`);
  return new Set(cuentas.flatMap(v => [claveNombre(v.nombre), claveNombre(v.nombre_vinculado)]).filter(Boolean));
}

function contieneNombreOculto(texto, ocultos) {
  const palabras = normalizarNombre(texto).split(" ");
  for (const nombre of ocultos) {
    const largo = nombre.split(" ").length;
    for (let i = 0; i + largo <= palabras.length; i++) {
      if (palabras.slice(i, i + largo).sort().join(" ") === nombre) return true;
    }
  }
  return false;
}

function limpiarVeedoresManuales(valor, ocultos) {
  if (!valor || !ocultos.size) return valor;
  let modificado = false;
  const visibles = [];
  for (const grupo of valor.split(/\s*(?:[\/;|+·\n]|\s[-–—]\s|\sy\s)\s*/i)) {
    const partes = grupo.split(",").map(p => p.trim()).filter(Boolean);
    for (let i = 0; i < partes.length; i++) {
      if (contieneNombreOculto(partes[i], ocultos)) {
        modificado = true;
      } else if (i + 1 < partes.length && !contieneNombreOculto(partes[i + 1], ocultos)
          && contieneNombreOculto(partes[i] + " " + partes[i + 1], ocultos)) {
        modificado = true;
        i++;
      } else {
        visibles.push(partes[i]);
      }
    }
  }
  return modificado ? visibles.join(", ") || null : valor;
}

async function filtrarVeedoresManuales(db, disciplinas) {
  if (!disciplinas.some(d => d.veedor)) return disciplinas;
  const ocultos = await nombresVeedoresOcultos(db);
  return disciplinas.map(d => ({ ...d, veedor: limpiarVeedoresManuales(d.veedor, ocultos) }));
}

async function filtrarContactosVeedores(db, contactos) {
  const esVeedor = c => /\b(?:veedor\w*|veedur\w*)\b/.test(normalizarNombre([c.grupo, c.cargo].join(" ")));
  if (!contactos.some(esVeedor)) return contactos;
  const ocultos = await nombresVeedoresOcultos(db);
  return contactos.filter(c => !esVeedor(c) || !contieneNombreOculto(c.nombre, ocultos));
}

module.exports = { claveNombre, filtrarVeedoresManuales, filtrarContactosVeedores };
