"use strict";

// Servidor local del predio (corre en la notebook del camping).
// Uso: node servidor.js --base C:\AJB-Predio
//   <base>/config.json        configuración (predio, servidor central, token, puerto)
//   <base>/datos/predio.db    base de datos SQLite
//   <base>/datos/respaldos/   copias diarias

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const os = require("node:os");
const U = require("./lib/util");
const { crearSqlite, asegurarEsquema, leerMeta, escribirMeta } = require("./lib/db-sqlite");
const api = require("./lib/api");
const sesion = require("./lib/api/sesion");
const { crearAgente } = require("./lib/agente");
const N = require("./lib/negocio");

const DIR_APP = __dirname;
const DIR_PUBLICO = path.join(DIR_APP, "public");

function argumento(nombre, porDefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

const BASE = path.resolve(argumento("base", process.env.PREDIO_BASE || path.join(DIR_APP, ".local")));
fs.mkdirSync(path.join(BASE, "datos", "respaldos"), { recursive: true });

function log(mensaje) {
  console.log(`[${U.fechaHora()}] ${mensaje}`);
}

function leerConfig() {
  const archivo = path.join(BASE, "config.json");
  let config = {};
  if (fs.existsSync(archivo)) {
    try { config = JSON.parse(fs.readFileSync(archivo, "utf8").replace(/^\uFEFF/, "")); } catch (e) { log(`config.json ilegible: ${e.message}`); }
  }
  return {
    predio_id: Number(config.predio_id || process.env.PREDIO_ID || 1),
    predio_codigo: config.predio_codigo || process.env.PREDIO_CODIGO || "MIRAMAR",
    predio_nombre: config.predio_nombre || "Camping Miramar",
    servidor: config.servidor || process.env.PREDIO_SERVIDOR || "",
    token: config.token || process.env.PREDIO_TOKEN || "",
    puerto: Number(argumento("puerto", config.puerto || process.env.PREDIO_PUERTO || 8080)),
    actualizaciones_automaticas: config.actualizaciones_automaticas !== false,
    clave_publica: config.clave_publica || null,
  };
}

function leerVersion() {
  try { return fs.readFileSync(path.join(DIR_APP, ".version"), "utf8").trim(); } catch (_e) { /* desarrollo */ }
  try { return `${JSON.parse(fs.readFileSync(path.join(DIR_APP, "package.json"), "utf8")).version}+desarrollo`; } catch (_e) { return "desarrollo"; }
}

const config = leerConfig();
const VERSION = leerVersion();
const db = crearSqlite(path.join(BASE, "datos", "predio.db"), { predioId: config.predio_id });
asegurarEsquema(db);

// ------------------------------------------------------------------ ejecución de órdenes remotas

async function ejecutarRemoto({ metodo, ruta, cuerpo, query, actor }) {
  const encontrada = api.buscarRuta(metodo, ruta);
  if (!encontrada || encontrada.ruta.soloLocal || encontrada.ruta.publica) throw U.error("Operación no permitida a distancia", 403);
  const base = { db, pid: config.predio_id, modo: "local", origen: "REMOTO", ip: "sistema-general", servicios };
  const usuarioFila = await sesion.asegurarUsuarioGeneral(base, {
    id: Number(actor?.general_id) || 0,
    nombre: `${actor?.nombre || "Administración"} (sistema general)`,
    documento: String(actor?.documento || actor?.general_id || "0"),
  });
  const ctx = {
    ...base,
    usuario: { id: Number(usuarioFila.id), usuario: usuarioFila.usuario, nombre: usuarioFila.nombre, rol: "ADMIN", bocas: [], es_admin_general: true },
    sesion: {},
    query: query || {},
    body: cuerpo || {},
  };
  return api.ejecutar(ctx, metodo, ruta);
}

let salirConCodigo = null;
const servicios = { version: VERSION };
const agente = crearAgente({
  db, config, base: BASE, version: VERSION, log,
  api: { ejecutarRemoto },
  alActualizar: () => apagar(75),
  alReiniciar: () => apagar(75),
});
servicios.agente = agente;

// ------------------------------------------------------------------ respaldos

function respaldar(motivo = "diario") {
  const carpeta = path.join(BASE, "datos", "respaldos");
  const nombre = motivo === "diario" ? `predio-${U.hoy()}.db` : `predio-${U.fechaHora().replace(/[: ]/g, "-")}-${motivo}.db`;
  const destino = path.join(carpeta, nombre);
  if (motivo === "diario" && fs.existsSync(destino)) return null;
  fs.rmSync(destino, { force: true });
  db.conexion.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  const todos = fs.readdirSync(carpeta).filter((f) => f.endsWith(".db")).sort();
  const diarios = todos.filter((f) => /^predio-\d{4}-\d{2}-\d{2}\.db$/.test(f));
  for (const viejo of diarios.slice(0, Math.max(0, diarios.length - 30))) fs.rmSync(path.join(carpeta, viejo), { force: true });
  const otros = todos.filter((f) => !diarios.includes(f));
  for (const viejo of otros.slice(0, Math.max(0, otros.length - 10))) fs.rmSync(path.join(carpeta, viejo), { force: true });
  log(`Respaldo creado: ${nombre}`);
  return nombre;
}

function respaldoDiario() {
  db.exclusivo(() => respaldar("diario")).catch((e) => log(`No se pudo respaldar: ${e.message}`));
}

// ------------------------------------------------------------------ rutas de sistema (sólo administradores)

function direccionesLan() {
  const salida = [];
  for (const [nombre, lista] of Object.entries(os.networkInterfaces())) {
    for (const d of lista || []) {
      if (d.family === "IPv4" && !d.internal) salida.push({ interfaz: nombre, ip: d.address, url: `http://${d.address}${config.puerto === 80 ? "" : `:${config.puerto}`}` });
    }
  }
  return salida;
}

async function rutaSistema(ctx, metodo, ruta, req, res) {
  if (ctx.usuario?.rol !== "ADMIN") throw U.error("Esta sección es del administrador", 403);
  if (metodo === "GET" && ruta === "/sistema/estado") {
    const respaldos = fs.readdirSync(path.join(BASE, "datos", "respaldos")).filter((f) => f.endsWith(".db")).sort().reverse()
      .map((f) => ({ nombre: f, tamano: fs.statSync(path.join(BASE, "datos", "respaldos", f)).size }));
    const tamano = fs.existsSync(db.archivo) ? fs.statSync(db.archivo).size : 0;
    return {
      sincronizacion: agente.estadoPublico(),
      equipo: { nombre: os.hostname(), sistema: `${os.type()} ${os.release()}`, node: process.version, memoria_libre: os.freemem(), memoria_total: os.totalmem(), encendido_hace: Math.round(os.uptime()) },
      servidor: { puerto: config.puerto, direcciones: direccionesLan(), base: BASE, version: VERSION, iniciado: servidorIniciado },
      base_datos: { archivo: db.archivo, tamano },
      respaldos: respaldos.slice(0, 40),
    };
  }
  if (metodo === "POST" && ruta === "/sistema/sincronizar") {
    const r = await agente.sincronizarAhora();
    await db.tx((t) => N.auditar(t, ctx, "Sincronización manual", "sistema", null, null));
    return { mensaje: "Sincronizado con el sistema general", estado: r };
  }
  if (metodo === "POST" && ruta === "/sistema/actualizar") {
    const r = await agente.buscarActualizacion(true);
    if (r && r.actualizado) return { mensaje: `Se instaló la versión ${r.version}. El sistema se reinicia en unos segundos.`, reiniciando: true };
    return { mensaje: "Ya tenés la última versión", version: VERSION };
  }
  if (metodo === "POST" && ruta === "/sistema/respaldo") {
    const nombre = await db.exclusivo(() => respaldar("manual"));
    await db.tx((t) => N.auditar(t, ctx, "Respaldo manual", "sistema", null, { archivo: nombre }));
    return { mensaje: "Respaldo creado", archivo: nombre };
  }
  const descarga = /^\/sistema\/respaldos\/([A-Za-z0-9._-]+\.db)$/.exec(ruta);
  if (metodo === "GET" && descarga) {
    const archivo = path.join(BASE, "datos", "respaldos", descarga[1]);
    if (!fs.existsSync(archivo)) throw U.error("No encontramos ese respaldo", 404);
    return { archivo: fs.readFileSync(archivo), nombreArchivo: descarga[1], tipo: "application/octet-stream" };
  }
  if (metodo === "GET" && ruta === "/sistema/exportar") {
    const { buffer, nombre } = await agente.exportar();
    await db.tx((t) => N.auditar(t, ctx, "Exportación de datos para el sistema general", "sistema", null, { archivo: nombre, bytes: buffer.length }));
    return { archivo: buffer, nombreArchivo: nombre, tipo: "application/octet-stream" };
  }
  if (metodo === "POST" && ruta === "/sistema/importar") {
    const buffer = await leerCuerpo(req, 300 * 1024 * 1024, true);
    await db.exclusivo(() => respaldar("antes-de-importar"));
    const r = await agente.importarPaquete(buffer);
    await db.tx((t) => N.auditar(t, ctx, "Importación de paquete del sistema general", "sistema", null, r));
    return { mensaje: "Paquete aplicado", resumen: r };
  }
  throw U.error("No encontramos esa operación", 404);
}

// ------------------------------------------------------------------ HTTP

const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};

function cabecerasSeguridad(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
}

function enviar(req, res, status, cuerpo, tipo = "application/json; charset=utf-8", extra = {}) {
  let datos = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo));
  const cabeceras = { "Content-Type": tipo, ...extra };
  if (datos.length > 4096 && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /json|text|javascript|css|svg/.test(tipo)) {
    datos = zlib.gzipSync(datos, { level: 5 });
    cabeceras["Content-Encoding"] = "gzip";
    cabeceras.Vary = "Accept-Encoding";
  }
  cabeceras["Content-Length"] = datos.length;
  res.writeHead(status, cabeceras);
  res.end(req.method === "HEAD" ? undefined : datos);
}

function leerCuerpo(req, limite, binario = false) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > limite) { reject(U.error("El contenido enviado es demasiado grande", 413)); req.destroy(); return; }
      partes.push(c);
    });
    req.on("end", () => {
      const buffer = Buffer.concat(partes);
      if (binario) return resolve(buffer);
      if (!buffer.length) return resolve({});
      try { resolve(JSON.parse(buffer.toString("utf8"))); } catch (_e) { reject(U.error("El contenido enviado no es válido", 400)); }
    });
    req.on("error", reject);
  });
}

function servirEstatico(req, res, ruta) {
  let relativo = decodeURIComponent(ruta.split("?")[0]);
  if (relativo === "/" || relativo === "") relativo = "/index.html";
  const archivo = path.normalize(path.join(DIR_PUBLICO, relativo));
  if (!archivo.startsWith(DIR_PUBLICO)) return enviar(req, res, 403, "Prohibido", "text/plain; charset=utf-8");
  let final = archivo;
  if (!fs.existsSync(final) || fs.statSync(final).isDirectory()) {
    if (path.extname(relativo)) return enviar(req, res, 404, "No encontrado", "text/plain; charset=utf-8");
    final = path.join(DIR_PUBLICO, "index.html");
  }
  const ext = path.extname(final).toLowerCase();
  const esIndice = final.endsWith("index.html");
  let contenido = fs.readFileSync(final);
  if (esIndice) contenido = Buffer.from(contenido.toString("utf8").replace(/__VERSION__/g, encodeURIComponent(VERSION)));
  enviar(req, res, 200, contenido, TIPOS[ext] || "application/octet-stream", {
    "Cache-Control": esIndice ? "no-cache" : "public, max-age=604800, immutable",
  });
}

function ipDe(req) {
  return String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

async function manejar(req, res) {
  cabecerasSeguridad(res);
  const url = new URL(req.url, "http://local");
  const ruta = url.pathname;
  if (!ruta.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") return enviar(req, res, 405, { mensaje: "Método no permitido" });
    return servirEstatico(req, res, ruta);
  }
  res.setHeader("Cache-Control", "no-store");
  const rutaApi = ruta.slice(4);
  const ip = ipDe(req);
  const ctx = {
    db, pid: config.predio_id, modo: "local", origen: "LOCAL", ip,
    esLocalhost: ip === "127.0.0.1" || ip === "::1",
    agenteHttp: req.headers["user-agent"] || "", servicios,
    query: Object.fromEntries(url.searchParams.entries()),
  };
  try {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
    const auth = await sesion.autenticar(ctx, token);
    if (auth) Object.assign(ctx, auth);
    if (rutaApi.startsWith("/sistema/")) {
      if (!ctx.usuario) throw U.error("Iniciá sesión para continuar", 401, { codigo: "SIN_SESION" });
      const r = await rutaSistema(ctx, req.method, rutaApi, req, res);
      if (r && r.archivo) {
        return enviar(req, res, 200, r.archivo, r.tipo, { "Content-Disposition": `attachment; filename="${r.nombreArchivo}"` });
      }
      return enviar(req, res, 200, r);
    }
    ctx.body = req.method === "GET" || req.method === "HEAD" ? {} : await leerCuerpo(req, 3 * 1024 * 1024);
    const resultado = await api.ejecutar(ctx, req.method === "HEAD" ? "GET" : req.method, rutaApi);
    if (resultado && resultado.csv !== undefined) {
      return enviar(req, res, 200, resultado.csv, "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename="${resultado.nombreArchivo}"` });
    }
    return enviar(req, res, 200, resultado === undefined ? { ok: true } : resultado);
  } catch (e) {
    if (e instanceof U.ErrorPredio || e.status) {
      const { status, message, name, stack, ...extra } = e;
      return enviar(req, res, e.status || 400, { mensaje: e.message, ...extra });
    }
    log(`Error en ${req.method} ${ruta}: ${e.stack || e.message}`);
    return enviar(req, res, 500, { mensaje: "Ocurrió un error inesperado. Volvé a intentar; si sigue pasando avisá al administrador." });
  }
}

const servidor = http.createServer((req, res) => {
  manejar(req, res).catch((e) => {
    log(`Error no controlado: ${e.stack || e.message}`);
    try { enviar(req, res, 500, { mensaje: "Error interno" }); } catch (_e) { /* respuesta enviada */ }
  });
});
servidor.keepAliveTimeout = 30000;
servidor.requestTimeout = 300000;

let servidorIniciado = null;
let apagando = false;

function apagar(codigo = 0) {
  if (apagando) return;
  apagando = true;
  salirConCodigo = codigo;
  log(codigo === 75 ? "Reiniciando para aplicar cambios…" : "Apagando el servidor…");
  agente.detener();
  servidor.close(() => {
    db.cerrar();
    process.exit(salirConCodigo || 0);
  });
  setTimeout(() => { db.cerrar(); process.exit(salirConCodigo || 0); }, 4000).unref();
}

process.on("SIGINT", () => apagar(0));
process.on("SIGTERM", () => apagar(0));
process.on("uncaughtException", (e) => { log(`Excepción no controlada: ${e.stack || e.message}`); });
process.on("unhandledRejection", (e) => { log(`Promesa rechazada: ${e?.stack || e}`); });

servidor.on("error", (e) => {
  log(e.code === "EADDRINUSE" ? `El puerto ${config.puerto} está ocupado por otro programa.` : `Error del servidor: ${e.message}`);
  process.exit(1);
});

servidor.listen(config.puerto, "0.0.0.0", () => {
  servidorIniciado = U.fechaHora();
  escribirMeta(db, "ultimo_inicio", servidorIniciado);
  log(`Sistema del predio ${config.predio_nombre} v${VERSION} escuchando en el puerto ${config.puerto}`);
  for (const d of direccionesLan()) log(`  Abrí en las PCs del camping: ${d.url}`);
  if (!agente.configurado()) log("  Sin vincular al sistema general: funciona sólo en la red local.");
  agente.iniciar();
  respaldoDiario();
  setInterval(respaldoDiario, 3 * 3600 * 1000).unref();
  // Limpieza de sesiones vencidas.
  setInterval(() => {
    db.run("DELETE FROM predio_sesion WHERE vence IS NOT NULL AND vence < ?", [U.fechaHora()]).catch(() => {});
  }, 3600 * 1000).unref();
  // Señal de vida para el lanzador (detecta versiones que no arrancan).
  try { fs.writeFileSync(path.join(BASE, "app", "SANO"), `${VERSION}\n${servidorIniciado}\n`); } catch (_e) { /* modo desarrollo */ }
});

module.exports = { leerMeta };
