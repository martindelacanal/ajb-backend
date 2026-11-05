"use strict";

// Paquete de código del predio para las actualizaciones a distancia: un JSON comprimido
// con todos los archivos del módulo. Su "versión" lleva la huella del contenido, así
// cualquier cambio publicado en el sistema general llega solo a la notebook.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const INCLUIR = ["package.json", "lanzador.js", "servidor.js", "README.md", "lib", "public", "windows"];
const EXCLUIR = /(^|[\\/])(node_modules|\.git|test|datos|logs)([\\/]|$)/;

function listarArchivos(base, relativo = "") {
  const salida = [];
  const absoluto = path.join(base, relativo);
  if (!fs.existsSync(absoluto)) return salida;
  const stat = fs.statSync(absoluto);
  if (stat.isFile()) return [relativo];
  for (const nombre of fs.readdirSync(absoluto).sort()) {
    const r = relativo ? `${relativo}/${nombre}` : nombre;
    if (EXCLUIR.test(r)) continue;
    const s = fs.statSync(path.join(base, r));
    if (s.isDirectory()) salida.push(...listarArchivos(base, r));
    else salida.push(r);
  }
  return salida;
}

function leerVersionBase(base) {
  try {
    return JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).version || "1.0.0";
  } catch (_e) {
    return "1.0.0";
  }
}

function armarPaquete(base) {
  const rutas = INCLUIR.flatMap((r) => listarArchivos(base, r));
  const hash = crypto.createHash("sha256");
  const archivos = rutas.map((ruta) => {
    const contenido = fs.readFileSync(path.join(base, ruta));
    hash.update(ruta).update("\0").update(contenido).update("\0");
    return { ruta, contenido: contenido.toString("base64") };
  });
  const huella = hash.digest("hex").slice(0, 10);
  const version = `${leerVersionBase(base)}+${huella}`;
  const json = JSON.stringify({ tipo: "predio-codigo", version, generado: new Date().toISOString(), archivos });
  const comprimido = zlib.gzipSync(Buffer.from(json), { level: 9 });
  return {
    version,
    buffer: comprimido,
    sha256: crypto.createHash("sha256").update(comprimido).digest("hex"),
    tamano: comprimido.length,
    archivos: rutas.length,
  };
}

function rutaSegura(ruta) {
  const r = String(ruta || "").replace(/\\/g, "/");
  if (!r || r.startsWith("/") || /^[a-z]:/i.test(r) || r.split("/").some((p) => p === ".." || p === "")) return null;
  return r;
}

function leerPaquete(buffer) {
  const datos = JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));
  if (datos.tipo !== "predio-codigo" || !Array.isArray(datos.archivos) || !datos.version) {
    throw new Error("El archivo no es un paquete de código del predio");
  }
  return datos;
}

// Escribe la versión en <destino>/<versión-segura>/ y devuelve esa carpeta.
function instalarPaquete(buffer, carpetaVersiones) {
  const datos = leerPaquete(buffer);
  const nombre = datos.version.replace(/[^a-zA-Z0-9.+_-]/g, "_");
  const destino = path.join(carpetaVersiones, nombre);
  const temporal = `${destino}.tmp-${process.pid}`;
  fs.rmSync(temporal, { recursive: true, force: true });
  for (const a of datos.archivos) {
    const r = rutaSegura(a.ruta);
    if (!r) throw new Error(`Ruta inválida en el paquete: ${a.ruta}`);
    const archivo = path.join(temporal, ...r.split("/"));
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, Buffer.from(a.contenido, "base64"));
  }
  if (!fs.existsSync(path.join(temporal, "servidor.js"))) throw new Error("El paquete no trae el servidor");
  fs.writeFileSync(path.join(temporal, ".version"), String(datos.version));
  fs.rmSync(destino, { recursive: true, force: true });
  fs.renameSync(temporal, destino);
  return { version: datos.version, carpeta: destino, nombre };
}

module.exports = { armarPaquete, leerPaquete, instalarPaquete, listarArchivos, leerVersionBase };
