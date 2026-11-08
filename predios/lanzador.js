"use strict";

// Lanzador (supervisor) del sistema del predio. Lo ejecuta la tarea programada de Windows
// al encender la notebook. Mantiene vivo el servidor: si se cae lo vuelve a levantar,
// aplica las actualizaciones y, si una versión nueva no arranca, vuelve a la anterior.
//
// Estructura de la instalación (<base> = carpeta donde está este archivo como arranque.js):
//   <base>/app/versiones/<versión>/servidor.js
//   <base>/app/ACTUAL      versión en uso
//   <base>/app/ANTERIOR    versión previa (para volver atrás)
//   <base>/app/PENDIENTE   versión recién descargada (la deja el servidor antes de reiniciar)
//   <base>/logs/           registros diarios (se guardan 14 días)

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");
const crypto = require("node:crypto");

function argumento(nombre, porDefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

const BASE = path.resolve(argumento("base", __dirname));
const APP = path.join(BASE, "app");
const VERSIONES = path.join(APP, "versiones");
const LOGS = path.join(BASE, "logs");
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(VERSIONES, { recursive: true });

function hoy() {
  const a = new Date(Date.now() - 3 * 3600 * 1000);
  return a.toISOString().slice(0, 10);
}

let diaLog = null;
let streamLog = null;
function escribirLog(texto) {
  const d = hoy();
  if (d !== diaLog) {
    if (streamLog) streamLog.end();
    diaLog = d;
    streamLog = fs.createWriteStream(path.join(LOGS, `servidor-${d}.log`), { flags: "a" });
    limpiarLogs();
  }
  streamLog.write(texto);
}

function log(mensaje) {
  const marca = new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  escribirLog(`[${marca}] [lanzador] ${mensaje}\n`);
}

function limpiarLogs() {
  try {
    const archivos = fs.readdirSync(LOGS).filter((f) => /^servidor-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    for (const viejo of archivos.slice(0, Math.max(0, archivos.length - 14))) fs.rmSync(path.join(LOGS, viejo), { force: true });
  } catch (_e) { /* sin permisos */ }
}

function leer(nombre) {
  try { return fs.readFileSync(path.join(APP, nombre), "utf8").trim() || null; } catch (_e) { return null; }
}
function escribir(nombre, valor) {
  fs.writeFileSync(path.join(APP, nombre), String(valor));
}
function borrar(nombre) {
  fs.rmSync(path.join(APP, nombre), { force: true });
}

function estadoArranque() {
  try { return JSON.parse(fs.readFileSync(path.join(BASE, "runtime.json"), "utf8").replace(/^\uFEFF/, "")); }
  catch (_e) { return { autoarranque: true, detenido: false }; }
}
function debePermanecerDetenido() {
  const estado = estadoArranque();
  return estado.detenido === true || (process.argv.includes("--automatico") && estado.autoarranque === false);
}
if (debePermanecerDetenido()) process.exit(0);

// Una sola instancia del lanzador por instalación.
const archivoPid = path.join(APP, "lanzador.pid");
if (process.platform !== "win32") try {
  const previo = Number(fs.readFileSync(archivoPid, "utf8"));
  if (previo && previo !== process.pid) {
    process.kill(previo, 0);
    console.log(`Ya hay un lanzador corriendo (proceso ${previo}).`);
    process.exit(0);
  }
} catch (_e) { /* no hay otro */ }

function carpetaDe(version) {
  return version ? path.join(VERSIONES, version) : null;
}

function requiereControlLan() {
  // La presencia alcanza: una configuración incompleta, ilegible o una
  // activación interrumpida tampoco pueden volver al escritor de una PC vieja.
  return ["predio-ha.json", "ha-activacion-pendiente.json"].some((nombre) => {
    try { fs.lstatSync(path.join(BASE, nombre)); return true; }
    catch (e) { return e.code !== "ENOENT"; }
  });
}

function carpetaCompatible(carpeta) {
  try {
    const archivo = path.join(BASE, "predio-ha.json");
    const config = fs.existsSync(archivo) ? JSON.parse(fs.readFileSync(archivo, "utf8").replace(/^\uFEFF/, "")) : null;
    const quorum = config?.quorum || config?.quorumPendiente || fs.existsSync(path.join(BASE, "ha", "activacion-quorum.json"));
    return fs.statSync(path.join(carpeta, "servidor.js")).isFile()
      && (!requiereControlLan() || fs.statSync(path.join(carpeta, "lib", "servicio-lan.js")).isFile())
      && (!quorum || fs.statSync(path.join(carpeta, "windows", "ajb-quorum.exe")).isFile());
  } catch (_e) { return false; }
}

function versionValida(version) {
  if (typeof version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/.test(version) || version.includes("..")) return false;
  const c = carpetaDe(version);
  return Boolean(c && carpetaCompatible(c));
}

function elegirVersion() {
  const pendiente = leer("PENDIENTE");
  if (pendiente && versionValida(pendiente)) {
    const actual = leer("ACTUAL");
    if (actual && actual !== pendiente) escribir("ANTERIOR", actual);
    escribir("ACTUAL", pendiente);
    escribir("EN_PRUEBA", pendiente);
    borrar("PENDIENTE");
    log(`Se aplica la versión ${pendiente}`);
  } else if (pendiente) {
    borrar("PENDIENTE");
  }
  let actual = leer("ACTUAL");
  if (!versionValida(actual)) {
    const disponibles = fs.readdirSync(VERSIONES).filter((v) => versionValida(v)).sort();
    actual = disponibles.pop() || null;
    if (actual) escribir("ACTUAL", actual);
  }
  return actual;
}

let hijo = null;
let fallosSeguidos = 0;
let terminando = false;

function iniciar() {
  if (terminando || debePermanecerDetenido()) { terminar(); return; }
  const version = elegirVersion();
  let script;
  if (version && versionValida(version)) script = path.join(carpetaDe(version), "servidor.js");
  else if (carpetaCompatible(__dirname)) script = path.join(__dirname, "servidor.js");
  else {
    log(requiereControlLan()
      ? "El grupo LAN requiere una versión compatible con su control de escritura. El servidor queda detenido; instalá una versión actualizada."
      : "No hay ninguna versión instalada. Volvé a correr el instalador.");
    setTimeout(iniciar, 30000);
    return;
  }
  borrar("SANO");
  const inicio = Date.now();
  log(`Iniciando ${script}`);
  hijo = spawn(process.execPath, [script, "--base", BASE], { cwd: BASE, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  hijo.stdout.on("data", (d) => escribirLog(d.toString()));
  hijo.stderr.on("data", (d) => escribirLog(d.toString()));

  const vigilancia = setInterval(() => {
    const sano = leer("SANO");
    if (sano && version && sano.startsWith(version)) {
      clearInterval(vigilancia);
      fallosSeguidos = 0;
      if (leer("EN_PRUEBA") === version) {
        borrar("EN_PRUEBA");
        log(`La versión ${version} arrancó bien`);
        // Si la versión trae un lanzador distinto, queda listo para el próximo encendido.
        try {
          const nuevo = path.join(carpetaDe(version), "lanzador.js");
          const propio = path.join(BASE, "arranque.js");
          if (fs.existsSync(nuevo) && fs.existsSync(propio) && fs.readFileSync(nuevo, "utf8") !== fs.readFileSync(propio, "utf8")) {
            fs.copyFileSync(nuevo, propio);
            log("Lanzador actualizado (se usa desde el próximo encendido)");
          }
        } catch (e) { log(`No se pudo actualizar el lanzador: ${e.message}`); }
      }
    }
  }, 2000);

  hijo.on("exit", (codigo) => {
    clearInterval(vigilancia);
    hijo = null;
    if (terminando || debePermanecerDetenido()) { process.exit(0); return; }
    const duracion = Date.now() - inicio;
    if (codigo === 75) {
      log("El servidor pidió reiniciarse");
      setTimeout(iniciar, 500);
      return;
    }
    fallosSeguidos++;
    log(`El servidor se detuvo (código ${codigo}) después de ${Math.round(duracion / 1000)} s`);
    const enPrueba = leer("EN_PRUEBA");
    if (enPrueba && enPrueba === version && duracion < 120000 && fallosSeguidos >= 2) {
      const anterior = leer("ANTERIOR");
      if (anterior && versionValida(anterior)) {
        log(`La versión ${version} no arranca: se vuelve a ${anterior}`);
        escribir("ACTUAL", anterior);
        borrar("EN_PRUEBA");
        escribir("DESCARTADA", version);
        fallosSeguidos = 0;
      }
    }
    const espera = Math.min(30000, 2000 * fallosSeguidos);
    setTimeout(iniciar, espera);
  });
}

function terminar() {
  terminando = true;
  log("Deteniendo el sistema del predio");
  if (hijo) {
    hijo.kill("SIGTERM");
    setTimeout(() => { if (hijo) hijo.kill("SIGKILL"); process.exit(0); }, 5000);
    hijo.on("exit", () => process.exit(0));
  } else process.exit(0);
}

process.on("SIGINT", terminar);
process.on("SIGTERM", terminar);
process.on("exit", () => { try { if (Number(fs.readFileSync(archivoPid, "utf8")) === process.pid) fs.rmSync(archivoPid, { force: true }); } catch (_e) { /* nada */ } });

function arrancar() {
  fs.writeFileSync(archivoPid, String(process.pid));
  log(`Lanzador iniciado en ${BASE} (Node ${process.version})`);
  iniciar();
  setInterval(() => {
    if (!debePermanecerDetenido() || terminando) return;
    // El servidor ve CONTROL y cierra sus datos primero; un proceso trabado
    // se termina después, sin que la tarea de Windows vuelva a iniciarlo.
    terminando = true;
    if (!hijo) process.exit(0);
    hijo.once("exit", () => process.exit(0));
    setTimeout(() => { if (hijo) hijo.kill("SIGTERM"); process.exit(0); }, 6000).unref();
  }, 500).unref();
}

if (process.platform === "win32") {
  // Una named pipe es un mutex del equipo: incluso dos carpetas con el mismo
  // predio no pueden mantener dos supervisores. Windows la libera si hay un fallo.
  let codigo = BASE;
  try { const c = JSON.parse(fs.readFileSync(path.join(BASE, "config.json"), "utf8").replace(/^\uFEFF/, "")); codigo = `${c.predio_id}:${c.predio_codigo}`; } catch (_e) { /* desarrollo */ }
  const cerrojo = net.createServer((socket) => socket.end());
  const nombre = `\\\\.\\pipe\\ajb-predio-${crypto.createHash("sha256").update(codigo.toLowerCase()).digest("hex").slice(0, 24)}`;
  cerrojo.on("error", (e) => {
    console.log(e.code === "EADDRINUSE" ? "Ya hay un servidor de este predio iniciado en esta PC." : `No se pudo reservar el servidor: ${e.message}`);
    process.exit(e.code === "EADDRINUSE" ? 0 : 1);
  });
  cerrojo.listen(nombre, arrancar);
} else arrancar();
