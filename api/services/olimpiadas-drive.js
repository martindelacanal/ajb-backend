"use strict";

const { crearErrorHttp } = require("./olimpiadas-comun");
const { obtenerFechaCivilArgentina } = require("./valores-dominio");

const ID_DRIVE = /^[\w-]{10,160}$/;
const CLAVE_DRIVE = /^[\w-]{1,200}$/;
const FORMATOS = new Map(Object.entries({
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
}));
const MIMES = new Set(FORMATOS.values());
const RUTA_CARPETA = /^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)\/?$/;
const RUTA_ARCHIVO = /^\/file\/(?:u\/\d+\/)?d\/([\w-]+)(?:\/(?:view|preview))?\/?$/;
const LIMITE_LISTADO = 6 * 1024 * 1024;
const MAX_CARPETAS = 256;
const MAX_ARCHIVOS = 5000;
const LISTADOS_SIMULTANEOS = 6;
const ARBOL_GRANDE = "Esta carpeta es demasiado grande para una sola importación. Pegá el enlace de una subcarpeta para importar por partes.";
const SIN_ACCESO = "Drive no permitió el acceso. Compartí el archivo o la carpeta como «Cualquier persona con el enlace», con permiso de lectura y descarga.";

function sinAcceso() {
  return Object.assign(crearErrorHttp(SIN_ACCESO, 422), { code: "DRIVE_SIN_ACCESO" });
}

function recursoDeEnlace(enlace) {
  let url;
  try { if (typeof enlace === "string" && enlace.length <= 2048) url = new URL(enlace.trim()); } catch {}
  const idArchivo = url?.pathname.match(RUTA_ARCHIVO)?.[1];
  const id = idArchivo || url?.pathname.match(RUTA_CARPETA)?.[1]
    || (url?.pathname === "/open" && url.searchParams.get("id"));
  const clave = url?.searchParams.get("resourcekey") || "";
  if (url?.origin !== "https://drive.google.com" || url.username || url.password || !id || !ID_DRIVE.test(id)
    || (clave && !CLAVE_DRIVE.test(clave))) throw crearErrorHttp("Pegá un enlace de Google Drive a una carpeta, foto o video compartido.");
  return { id, clave, tipo: idArchivo ? "archivo" : "carpeta" };
}

function enlaceDrive(ruta, id, clave) {
  const url = new URL(ruta);
  if (id) url.searchParams.set("id", id);
  if (clave) url.searchParams.set("resourcekey", clave);
  return url;
}

function enlaceDescarga(id, clave) {
  const url = enlaceDrive("https://drive.usercontent.google.com/download", id, clave);
  url.searchParams.set("export", "download");
  url.searchParams.set("confirm", "t");
  return url;
}

function datosArchivo(id, clave, nombre, mime, miniatura) {
  if (!miniatura) {
    const url = enlaceDrive("https://drive.google.com/thumbnail", id, clave);
    url.searchParams.set("sz", "w320");
    miniatura = url.href;
  }
  return { id, clave, nombre, mime, tipo: mime.startsWith("image/") ? "foto" : "video",
    miniatura_url: miniatura, vista_url: enlaceDrive("https://drive.google.com/file/d/" + id + "/view", "", clave).href };
}

function textoHtml(texto) {
  return texto.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (original, codigo) => {
    if (!codigo.startsWith("#")) return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }[codigo.toLowerCase()];
    const punto = codigo[1].toLowerCase() === "x" ? parseInt(codigo.slice(2), 16) : Number(codigo.slice(1));
    return punto > 0 && punto <= 0x10ffff ? String.fromCodePoint(punto) : original;
  });
}

// Drive permite carpetas hermanas con el mismo nombre. El filtro de la galería usa esta ruta:
// se numeran por ID para que siga distinguiéndolas aunque Drive cambie el orden del listado.
function distinguirHermanas(carpetas) {
  const porId = [...carpetas].sort((a, b) => a.id.localeCompare(b.id));
  const reservados = new Set(carpetas.map(c => c.nombre));
  const ultimoNumero = new Map();
  for (const carpeta of porId) {
    const base = carpeta.nombre;
    let numero = ultimoNumero.get(base) || 0;
    if (numero) {
      do { carpeta.nombre = `${base} (${++numero})`; } while (reservados.has(carpeta.nombre));
    }
    ultimoNumero.set(base, numero || 1);
  }
  return carpetas;
}

// La vista pública embebida contiene enlaces de sólo lectura. Nunca se visita una URL extraída
// del HTML: se recuperan el ID y la clave del recurso y se construyen los destinos de Google.
function leerListado(html) {
  if (/\bclass=["'][^"']*\bflip-not-found\b/i.test(html)) throw sinAcceso();
  const archivos = new Map();
  const subcarpetas = new Map();
  let reconocida = /\bflip-(?:entries|entry|empty)/i.test(html);
  for (const [, atributos, contenido] of html.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = atributos.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    let link;
    try { link = new URL(textoHtml(href), "https://drive.google.com"); } catch { continue; }
    if (link.origin !== "https://drive.google.com" || link.username || link.password) continue;
    const idCarpeta = link.pathname.match(RUTA_CARPETA)?.[1];
    const id = idCarpeta || link.pathname.match(/^\/file\/d\/([\w-]+)(?:\/|$)/)?.[1];
    if (!id || !ID_DRIVE.test(id)) continue;
    reconocida = true;
    const clave = link.searchParams.get("resourcekey") || "";
    if (clave && !CLAVE_DRIVE.test(clave)) continue;
    const titulo = contenido.match(/<div\b[^>]*\bclass=["'][^"']*\bflip-entry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? contenido;
    const nombre = textoHtml(titulo.replace(/<[^>]+>/g, "")).trim().slice(0, 1024);
    if (idCarpeta) {
      if (!subcarpetas.has(id) || (clave && !subcarpetas.get(id).clave)) {
        subcarpetas.set(id, { id, clave, nombre: nombre || id });
      }
      continue;
    }
    const mimeIcono = contenido.match(/\btype\/(image\/[a-z]+|video\/[a-z0-9]+)\b/i)?.[1]?.toLowerCase();
    const mime = FORMATOS.get(nombre.split(".").pop().toLowerCase()) || (MIMES.has(mimeIcono) && mimeIcono);
    if (!nombre || !mime) continue;
    const srcMiniatura = contenido.match(/<div\b[^>]*\bclass=["']flip-entry-thumb["'][^>]*>\s*<img\b[^>]*\bsrc=["'](https:\/\/lh\d+\.googleusercontent\.com\/[^"']+)["']/i)?.[1];
    archivos.set(id, datosArchivo(id, clave, nombre, mime, srcMiniatura && textoHtml(srcMiniatura)));
  }
  if (!reconocida) throw crearErrorHttp("No pudimos leer el listado de Drive. Verificá el enlace y el acceso público de la carpeta.", 422);
  return { archivos, subcarpetas: distinguirHermanas([...subcarpetas.values()]) };
}

const HOSTS_GOOGLE = new Set(["drive.google.com", "drive.usercontent.google.com"]);
async function pedirGoogle(url, signal, { method = "GET", headers } = {}) {
  for (let salto = 0; salto < 5; salto++) {
    if (url.protocol !== "https:" || url.port || url.username || url.password ||
      !(HOSTS_GOOGLE.has(url.hostname) || url.hostname.endsWith(".googleusercontent.com"))) throw sinAcceso();
    let respuesta;
    try { respuesta = await fetch(url, { method, headers, redirect: "manual", signal }); }
    catch { throw crearErrorHttp("No se pudo conectar con Drive. Volvé a intentar.", 502); }
    if (respuesta.ok) return respuesta;
    await respuesta.body?.cancel();
    const destino = respuesta.headers.get("location");
    if (respuesta.status >= 300 && respuesta.status < 400 && destino) {
      url = new URL(destino, url);
      continue;
    }
    if ([401, 403, 404].includes(respuesta.status)) throw sinAcceso();
    throw crearErrorHttp("Drive no pudo entregar el archivo o la carpeta. Volvé a intentar más tarde.", 502);
  }
  throw sinAcceso();
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

function nombreDeDescarga(cabecera) {
  const unicode = cabecera.match(/;\s*filename\*=UTF-8'[^']*'([^;]+)/i);
  if (unicode) {
    try { return decodeURIComponent(unicode[1].trim()); } catch { /* Drive también puede enviar filename. */ }
  }
  const simple = cabecera.match(/;\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i);
  return simple?.[1]?.replace(/\\(.)/g, "$1") || simple?.[2] || "";
}

async function listarArchivo({ id, clave }) {
  const url = enlaceDescarga(id, clave);
  // La vista previa sólo necesita las cabeceras, también para videos de cientos de MB.
  const respuesta = await pedirGoogle(url, AbortSignal.timeout(20000), { method: "HEAD", headers: { Range: "bytes=0-0" } });
  const tipoDeclarado = (respuesta.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const nombre = nombreDeDescarga(respuesta.headers.get("content-disposition") || "").trim().slice(0, 1024);
  await respuesta.body?.cancel();
  if (tipoDeclarado === "text/html") {
    throw crearErrorHttp("Drive no entregó el archivo. Verificá que cualquier persona con el enlace pueda verlo y descargarlo.", 422);
  }
  const mime = MIMES.has(tipoDeclarado) ? tipoDeclarado :
    (tipoDeclarado === "application/octet-stream" && FORMATOS.get(nombre.split(".").pop().toLowerCase()));
  if (!mime) throw crearErrorHttp("Este archivo de Drive no tiene un formato de foto o video compatible.", 422);

  const archivo = datosArchivo(id, clave, nombre || (mime.startsWith("image/") ? "Foto de Drive" : "Video de Drive"), mime);
  archivo.ruta_carpetas = [];
  return { archivos: new Map([[id, archivo]]), carpetas_sin_acceso: [] };
}

async function recorrerCarpetas(raiz) {
  const pendientes = [{ ...raiz, ruta: [] }];
  const visitadas = new Set([raiz.id]);
  const archivos = new Map();
  const sinPermiso = [];
  const cancelar = new AbortController();
  const plazo = AbortSignal.timeout(45000);
  const signal = AbortSignal.any([cancelar.signal, plazo]);
  let bytesTotales = 0;

  async function leerCarpeta({ id, clave, ruta }) {
    try {
      const respuesta = await pedirGoogle(enlaceDrive("https://drive.google.com/embeddedfolderview", id, clave), signal);
      const html = await juntar(cuerpoLimitado(respuesta, LIMITE_LISTADO, ARBOL_GRANDE));
      bytesTotales += html.length;
      if (bytesTotales > 24 * 1024 * 1024) throw crearErrorHttp(ARBOL_GRANDE, 413);
      return leerListado(html.toString("utf8"));
    } catch (error) {
      if (!ruta.length || error.code !== "DRIVE_SIN_ACCESO") throw error;
      sinPermiso.push(ruta);
      return null;
    }
  }

  try {
    while (pendientes.length) {
      const lote = pendientes.splice(0, LISTADOS_SIMULTANEOS);
      const listados = await Promise.all(lote.map(leerCarpeta));
      for (const [i, listado] of listados.entries()) {
        if (!listado) continue;
        const ruta = lote[i].ruta;
        for (const archivo of listado.archivos.values()) {
          if (!archivos.has(archivo.id)) archivos.set(archivo.id, { ...archivo, ruta_carpetas: ruta,
            carpeta_origen: { id: lote[i].id, clave: lote[i].clave } });
        }
        if (archivos.size > MAX_ARCHIVOS) throw crearErrorHttp(ARBOL_GRANDE, 413);
        for (const subcarpeta of listado.subcarpetas) {
          if (visitadas.has(subcarpeta.id)) continue;
          if (visitadas.size >= MAX_CARPETAS || ruta.length >= 32) throw crearErrorHttp(ARBOL_GRANDE, 413);
          visitadas.add(subcarpeta.id);
          pendientes.push({ ...subcarpeta, ruta: [...ruta, subcarpeta.nombre] });
        }
      }
    }
  } catch (error) {
    cancelar.abort();
    if (plazo.aborted) throw crearErrorHttp("Drive tardó demasiado en mostrar las carpetas. Volvé a intentar o pegá el enlace de una subcarpeta.", 504);
    throw error;
  }
  return { archivos, carpetas_sin_acceso: sinPermiso };
}

const carpetas = new Map();
const enCurso = new Map();
async function listarCarpeta(enlace, { revisarPermisos = false } = {}) {
  const raiz = recursoDeEnlace(enlace);
  const llave = [raiz.tipo, raiz.id, raiz.clave].join("/");
  const anterior = carpetas.get(llave);
  if (anterior && anterior.vence > Date.now() && !(revisarPermisos && anterior.listado.carpetas_sin_acceso.length)) {
    return anterior.listado;
  }
  if (enCurso.has(llave)) return enCurso.get(llave);
  const lectura = raiz.tipo === "archivo" ? listarArchivo(raiz) : recorrerCarpetas(raiz);
  enCurso.set(llave, lectura);
  try {
    const listado = await lectura;
    carpetas.delete(llave);
    if (carpetas.size >= 10) carpetas.delete(carpetas.keys().next().value);
    carpetas.set(llave, { vence: Date.now() + 120000, listado });
    return listado;
  } finally {
    enCurso.delete(llave);
  }
}

async function archivoSeleccionado(body, tipo) {
  const { archivos } = await listarCarpeta(body?.url);
  const archivo = archivos.get(body?.archivoId);
  if (!archivo || archivo.tipo !== tipo) throw crearErrorHttp("El archivo elegido no está entre los archivos compatibles de esa carpeta.");
  return archivo;
}

// La vista embebida sólo muestra la última modificación. La vista completa incluye los
// metadatos de los hijos: el índice 9 es createdTime y el 10 es modifiedTime.
function leerFechasCreacion(html, carpeta, archivos) {
  const contenido = html.match(/window\['_DRIVE_ivd'\]\s*=\s*'([\s\S]*?)';/)?.[1];
  if (!contenido) return new Map();
  const json = contenido.replace(/\\(?:x([\da-f]{2})|u([\da-f]{4})|(['"\\/]))/gi, (_, hex, unicode, literal) =>
    literal ?? String.fromCharCode(parseInt(hex || unicode, 16)));
  const filas = JSON.parse(json)?.[0];
  const fechas = new Map();
  for (const fila of Array.isArray(filas) ? filas : []) {
    const archivo = archivos.get(fila?.[0]);
    if (!archivo || typeof fila[2] !== "string" || archivo.nombre !== fila[2].trim() || archivo.mime !== fila[3] ||
      !Array.isArray(fila[1]) || !fila[1].includes(carpeta.id) || !Number.isSafeInteger(fila[9]) || fila[9] <= 0) continue;
    const fecha = new Date(fila[9]);
    if (Number.isFinite(fecha.getTime())) fechas.set(archivo.id, obtenerFechaCivilArgentina(fecha));
  }
  return fechas;
}

async function fechasCreacionDrive(archivos) {
  const porCarpeta = new Map();
  for (const archivo of archivos.values()) {
    if (archivo.carpeta_origen) porCarpeta.set(archivo.carpeta_origen.id, archivo.carpeta_origen);
  }
  const pendientes = [...porCarpeta.values()];
  const fechas = new Map();
  const plazo = AbortSignal.timeout(15000);
  let bytes = 0;
  async function leer(carpeta) {
    try {
      const url = enlaceDrive("https://drive.google.com/drive/folders/" + carpeta.id, "", carpeta.clave);
      const respuesta = await pedirGoogle(url, plazo);
      const html = await juntar(cuerpoLimitado(respuesta, 3 * 1024 * 1024, "Listado demasiado grande."));
      bytes += html.length;
      for (const [id, fecha] of leerFechasCreacion(html.toString("utf8"), carpeta, archivos)) fechas.set(id, fecha);
    } catch { /* Las fechas son opcionales, incluso si Google sólo entrega la vista embebida. */ }
  }
  while (pendientes.length && !plazo.aborted && bytes < 32 * 1024 * 1024) {
    await Promise.all(pendientes.splice(0, LISTADOS_SIMULTANEOS).map(leer));
  }
  return fechas;
}

async function descargar(archivo, limite) {
  const url = enlaceDescarga(archivo.id, archivo.clave);
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

module.exports = { listarCarpeta, fechasCreacionDrive, archivoSeleccionado, descargar, juntar, recursoDeEnlace, leerListado, cuerpoLimitado };
