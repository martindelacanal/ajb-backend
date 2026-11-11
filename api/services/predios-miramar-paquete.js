"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { leerPaquete } = require("../../predios/lib/paquete");

const SERVIDOR = "servidor.js";
const DIAGNOSTICO = "lib/diagnostico-acceso-miramar.js";
const ACCESO_DIRECTO = "windows/configurar-acceso-directo-miramar.ps1";
const ID_EQUIPO = /^[0-9a-f]{64}$/;

function recibeDiagnosticoMiramar(predioCodigo, equipoId, configurados) {
  if (predioCodigo !== "MIRAMAR" || typeof equipoId !== "string" || !ID_EQUIPO.test(equipoId)) return false;
  const ids = String(configurados || "").split(",").map(id => id.trim());
  return ids.length === 2 && ids[0] !== ids[1] && ids.every(id => ID_EQUIPO.test(id)) && ids.includes(equipoId);
}

function reemplazarAncla(codigo, ancla, reemplazo) {
  const posicion = codigo.indexOf(ancla);
  if (posicion < 0 || codigo.indexOf(ancla, posicion + ancla.length) >= 0) {
    throw new Error(`El paquete Miramar necesita un único punto de integración: ${ancla}`);
  }
  return codigo.slice(0, posicion) + reemplazo + codigo.slice(posicion + ancla.length);
}

function armarPaqueteMiramar(normal, diagnostico, accesoDirecto) {
  const base = leerPaquete(normal.buffer);
  const versionBase = /^(.+)\+[0-9a-f]{10}$/.exec(base.version)?.[1];
  const hashBase = crypto.createHash("sha256").update(normal.buffer).digest("hex");
  if (!versionBase || base.version !== normal.version || hashBase !== normal.sha256) {
    throw new Error("El paquete base del diagnóstico de Miramar no coincide con su manifiesto");
  }
  const servidores = base.archivos.filter(archivo => archivo.ruta === SERVIDOR);
  if (servidores.length !== 1 || base.archivos.some(archivo => [DIAGNOSTICO, ACCESO_DIRECTO].includes(archivo.ruta)) ||
      ![diagnostico, accesoDirecto].every(archivo => Buffer.isBuffer(archivo) && archivo.length > 0)) {
    throw new Error("El paquete base no tiene las rutas esperadas para el diagnóstico de Miramar");
  }

  let servidor = Buffer.from(servidores[0].contenido, "base64").toString("utf8");
  const salto = servidor.includes("\r\n") ? "\r\n" : "\n";
  const agente = `${salto}servicios.agente = agente;${salto}`;
  servidor = reemplazarAncla(servidor, agente,
    `${salto}const diagnosticoAccesoMiramar = require("./lib/diagnostico-acceso-miramar").crearDiagnosticoAccesoMiramar({ config, ha: configHa });${agente}`);
  const lan = `${salto}  if (ruta.startsWith("/lan/")) {${salto}`;
  servidor = reemplazarAncla(servidor, lan,
    `${salto}  if (diagnosticoAccesoMiramar?.manejar(req, res, ruta, ipDe(req))) return;${lan}`);

  const preparar = "await prepararAccesoCaja(BASE, direccion);";
  const registrar = 'log("Acceso de caja preparado en el escritorio compartido de esta notebook: Sistema del Camping - Caja (" + direccion + ").");';
  servidor = reemplazarAncla(servidor, `${salto}      ${preparar}${salto}      ${registrar}${salto}`, [
    "",
    "      if (diagnosticoAccesoMiramar) {",
    "        await diagnosticoAccesoMiramar.aplicarAccesoDirecto({ dirApp: DIR_APP });",
    "      } else {",
    `        ${preparar}`,
    `        ${registrar}`,
    "      }",
    "",
  ].join(salto));

  const archivos = base.archivos.map(archivo => archivo.ruta === SERVIDOR
    ? { ruta: SERVIDOR, contenido: Buffer.from(servidor).toString("base64") }
    : archivo);
  archivos.push({ ruta: DIAGNOSTICO, contenido: diagnostico.toString("base64") },
    { ruta: ACCESO_DIRECTO, contenido: accesoDirecto.toString("base64") });
  const contenido = crypto.createHash("sha256");
  for (const archivo of archivos) {
    contenido.update(archivo.ruta).update("\0").update(Buffer.from(archivo.contenido, "base64")).update("\0");
  }
  const version = `${versionBase}+${contenido.digest("hex").slice(0, 10)}`;
  if (version === base.version) throw new Error("El paquete de diagnóstico de Miramar necesita una versión distinta");
  const buffer = zlib.gzipSync(Buffer.from(JSON.stringify({ ...base, version, archivos })), { level: 9 });
  return {
    version,
    buffer,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    tamano: buffer.length,
    archivos: archivos.length,
  };
}

module.exports = { recibeDiagnosticoMiramar, armarPaqueteMiramar };
