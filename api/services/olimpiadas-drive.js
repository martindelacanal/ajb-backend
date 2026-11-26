"use strict";

const { crearErrorHttp } = require("./olimpiadas-comun");

const ID_DRIVE = /^[\w-]{10,160}$/;
const CLAVE_DRIVE = /^[\w-]{1,200}$/;
const FORMATOS = new Map(Object.entries({
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
}));
const MIMES = new Set(FORMATOS.values());
const LIMITE_LISTADO = 6 * 1024 * 1024;
const SIN_ACCESO = "Drive no permitió el acceso. Compartí la carpeta como «Cualquier persona con el enlace», con permiso de lectura y descarga.";

function carpetaDeEnlace(enlace) {
  let url;
  try { if (typeof enlace === "string" && enlace.length <= 2048) url = new URL(enlace.trim()); } catch {}
  const id = url?.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)\/?$/)?.[1]
    || (url?.pathname === "/open" && url.searchParams.get("id"));
  const clave = url?.searchParams.get("resourcekey") || "";
  if (url?.origin !== "https://drive.google.com" || url.username || url.password || !id || !ID_DRIVE.test(id)
    || (clave && !CLAVE_DRIVE.test(clave))) throw crearErrorHttp("Pegá el enlace de una carpeta compartida de Google Drive.");
  return { id, clave };
}

function enlaceDrive(ruta, id, clave) {
  const url = new URL(ruta);
  if (id) url.searchParams.set("id", id);
  if (clave) url.searchParams.set("resourcekey", clave);
  return url;
}

function textoHtml(texto) {
  return texto.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (original, codigo) => {
    if (!codigo.startsWith("#")) return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }[codigo.toLowerCase()];
    const punto = codigo[1].toLowerCase() === "x" ? parseInt(codigo.slice(2), 16) : Number(codigo.slice(1));
    return punto > 0 && punto <= 0x10ffff ? String.fromCodePoint(punto) : original;
  });
}

// La vista pública embebida contiene enlaces de sólo lectura. Nunca se visita una URL extraída
// del HTML: se recuperan el ID y la clave del recurso y se construyen los destinos de Google.
function leerListado(html) {
  const archivos = new Map();
  let reconocida = /\bflip-(?:entries|entry|not-found|empty)/i.test(html);
  for (const [, atributos, contenido] of html.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = atributos.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    let link;
    try { link = new URL(textoHtml(href), "https://drive.google.com"); } catch { continue; }
    if (link.origin !== "https://drive.google.com" || link.username || link.password) continue;
    const id = link.pathname.match(/^\/file\/d\/([\w-]+)(?:\/|$)/)?.[1];
    if (link.pathname.startsWith("/drive/folders/")) reconocida = true;
    if (!id || !ID_DRIVE.test(id)) continue;
    reconocida = true;
    const clave = link.searchParams.get("resourcekey") || "";
    if (clave && !CLAVE_DRIVE.test(clave)) continue;
    const titulo = contenido.match(/<div\b[^>]*\bclass=["'][^"']*\bflip-entry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? contenido;
    const nombre = textoHtml(titulo.replace(/<[^>]+>/g, "")).trim().slice(0, 1024);
    const mimeIcono = contenido.match(/\btype\/(image\/[a-z]+|video\/[a-z0-9]+)\b/i)?.[1]?.toLowerCase();
    const mime = FORMATOS.get(nombre.split(".").pop().toLowerCase()) || (MIMES.has(mimeIcono) && mimeIcono);
    if (!nombre || !mime) continue;
    const miniatura = enlaceDrive("https://drive.google.com/thumbnail", id, clave);
    miniatura.searchParams.set("sz", "w320");
    const srcMiniatura = contenido.match(/<div\b[^>]*\bclass=["']flip-entry-thumb["'][^>]*>\s*<img\b[^>]*\bsrc=["'](https:\/\/lh\d+\.googleusercontent\.com\/[^"']+)["']/i)?.[1];
    archivos.set(id, { id, nombre, tipo: mime.startsWith("image/") ? "foto" : "video", mime, clave,
      miniatura_url: srcMiniatura ? textoHtml(srcMiniatura) : miniatura.href,
      vista_url: enlaceDrive("https://drive.google.com/file/d/" + id + "/view", "", clave).href });
  }
  if (!reconocida) throw crearErrorHttp("No pudimos leer el listado de Drive. Verificá el enlace y el acceso público de la carpeta.", 422);
  return archivos;
}

const HOSTS_GOOGLE = new Set(["drive.google.com", "drive.usercontent.google.com"]);
async function pedirGoogle(url, signal) {
  for (let salto = 0; salto < 5; salto++) {
    if (url.protocol !== "https:" || url.port || url.username || url.password ||
      !(HOSTS_GOOGLE.has(url.hostname) || url.hostname.endsWith(".googleusercontent.com"))) throw crearErrorHttp(SIN_ACCESO, 422);
    let respuesta;
    try { respuesta = await fetch(url, { redirect: "manual", signal }); }
    catch { throw crearErrorHttp("No se pudo conectar con Drive. Volvé a intentar.", 502); }
    if (respuesta.ok) return respuesta;
    await respuesta.body?.cancel();
    const destino = respuesta.headers.get("location");
    if (respuesta.status >= 300 && respuesta.status < 400 && destino) {
      url = new URL(destino, url);
      continue;
    }
    if ([401, 403, 404].includes(respuesta.status)) throw crearErrorHttp(SIN_ACCESO, 422);
    throw crearErrorHttp("Drive no pudo entregar el archivo o la carpeta. Volvé a intentar más tarde.", 502);
  }
  throw crearErrorHttp(SIN_ACCESO, 422);
}

async function* cuerpoLimitado(respuesta, limite, mensaje) {
  if (Number(respuesta.headers.get("content-length")) > limite) {
    await respuesta.body?.cancel();
    throw crearErrorHttp(mensaje, 413);
  }
  let bytes = 0;
  for await (const parte of respuesta.body || []) {
    bytes += parte.length;
    if (bytes > limite) throw crearErrorHttp(mensaje, 413);
    yield Buffer.from(parte.buffer, parte.byteOffset, parte.byteLength);
  }
}

async function juntar(partes) {
  const buffers = [];
  for await (const parte of partes) buffers.push(parte);
  return Buffer.concat(buffers);
}

const carpetas = new Map();
async function listarCarpeta(enlace) {
  const { id, clave } = carpetaDeEnlace(enlace);
  const llave = id + "/" + clave;
  const anterior = carpetas.get(llave);
  if (anterior && anterior.vence > Date.now()) return anterior.archivos;
  const url = enlaceDrive("https://drive.google.com/embeddedfolderview", id, clave);
  const respuesta = await pedirGoogle(url, AbortSignal.timeout(30000));
  const html = await juntar(cuerpoLimitado(respuesta, LIMITE_LISTADO, "La carpeta es demasiado grande. Compartí una subcarpeta con los archivos de la jornada."));
  const archivos = leerListado(html.toString("utf8"));
  if (carpetas.size >= 10 || anterior) carpetas.delete(anterior ? llave : carpetas.keys().next().value);
  carpetas.set(llave, { vence: Date.now() + 120000, archivos });
  return archivos;
}

async function archivoSeleccionado(body, tipo) {
  const archivos = await listarCarpeta(body?.url);
  const archivo = archivos.get(body?.archivoId);
  if (!archivo || archivo.tipo !== tipo) throw crearErrorHttp("El archivo elegido no está entre los archivos compatibles de esa carpeta.");
  return archivo;
}

async function descargar(archivo, limite) {
  const url = enlaceDrive("https://drive.usercontent.google.com/download", archivo.id, archivo.clave);
  url.searchParams.set("export", "download");
  url.searchParams.set("confirm", "t");
  const signal = AbortSignal.timeout(5 * 60000);
  let respuesta = await pedirGoogle(url, signal);
  if (respuesta.headers.get("content-type")?.includes("text/html")) {
    // Algunas descargas públicas grandes presentan la confirmación con un UUID además del ID.
    const pagina = (await juntar(cuerpoLimitado(respuesta, 128 * 1024, SIN_ACCESO))).toString("utf8");
    const uuid = pagina.match(/\bname=["']uuid["']\s+value=["']([\w-]{5,100})["']/i)?.[1];
    if (!uuid || !/id=["']download-form["']/.test(pagina)) throw crearErrorHttp(SIN_ACCESO, 422);
    url.searchParams.set("uuid", uuid);
    respuesta = await pedirGoogle(url, signal);
  }
  if (respuesta.headers.get("content-type")?.includes("text/html")) {
    await respuesta.body?.cancel();
    throw crearErrorHttp(SIN_ACCESO, 422);
  }
  return cuerpoLimitado(respuesta, limite, "El archivo supera el máximo de " + limite / 1024 / 1024 + " MB.");
}

module.exports = { listarCarpeta, archivoSeleccionado, descargar, juntar, carpetaDeEnlace, leerListado, cuerpoLimitado };
