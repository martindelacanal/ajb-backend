"use strict";

// Supervisor sin base comercial para el testigo y el acceso de caja.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

function argumento(nombre, defecto) { const i = process.argv.indexOf(`--${nombre}`); return i >= 0 ? process.argv[i + 1] : defecto; }
const base = path.resolve(argumento("base", __dirname));
const rol = argumento("rol", "Acceso");
if (!["Acceso", "Testigo"].includes(rol)) throw new Error("El supervisor de apoyo sólo admite Acceso o Testigo");
const config = JSON.parse(fs.readFileSync(path.join(base, "predio-ha.json"), "utf8").replace(/^\uFEFF/, ""));
if (config.habilitado !== true || !config.grupoId) throw new Error("El equipo de apoyo no está configurado para un grupo");
const logs = path.join(base, "logs");
fs.mkdirSync(logs, { recursive: true });
let hijo = null, cerrando = false, fallos = 0;

function iniciar() {
  if (cerrando) return;
  const version = fs.readFileSync(path.join(base, "app", "ACTUAL"), "utf8").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,100}$/.test(version) || version.includes("..")) throw new Error("La versión del equipo de apoyo no es válida");
  const script = path.join(base, "app", "versiones", version, "lib", rol === "Acceso" ? "acceso-lan.js" : "servidor-testigo.js");
  if (!fs.statSync(script).isFile()) throw new Error("Falta la aplicación del equipo de apoyo");
  const salida = fs.openSync(path.join(logs, `${rol.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.log`), "a");
  const inicio = Date.now();
  hijo = spawn(process.execPath, [script, "--base", base], { cwd: base, windowsHide: true, stdio: ["ignore", salida, salida] });
  fs.closeSync(salida);
  hijo.on("error", e => console.error(e.message));
  hijo.on("close", () => {
    hijo = null;
    if (cerrando) { process.exit(0); return; }
    fallos = Date.now() - inicio > 60000 ? 1 : fallos + 1;
    setTimeout(iniciar, Math.min(30000, fallos * 2000));
  });
}
function detener() {
  cerrando = true;
  if (!hijo) process.exit(0);
  hijo.kill("SIGTERM");
  setTimeout(() => { if (hijo) hijo.kill("SIGKILL"); process.exit(0); }, 5000).unref();
}
process.on("SIGTERM", detener);
process.on("SIGINT", detener);
if (process.platform === "win32") {
  const nombre = `\\\\.\\pipe\\ajb-predio-apoyo-${crypto.createHash("sha256").update(`${config.grupoId}:${rol}`).digest("hex").slice(0, 24)}`;
  const mutex = net.createServer(socket => socket.end());
  mutex.on("error", e => { console.error(e.code === "EADDRINUSE" ? "Este equipo de apoyo ya está iniciado en esta PC." : e.message); process.exit(e.code === "EADDRINUSE" ? 0 : 1); });
  mutex.listen(nombre, iniciar);
} else iniciar();
