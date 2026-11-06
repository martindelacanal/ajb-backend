"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

function leerRuntime(base) {
  try {
    const datos = JSON.parse(fs.readFileSync(path.join(base, "runtime.json"), "utf8").replace(/^\uFEFF/, ""));
    return { autoarranque: datos.autoarranque !== false, detenido: datos.detenido === true };
  } catch (_e) { return { autoarranque: true, detenido: false }; }
}

function escribirRuntime(base, cambios) {
  const estado = { ...leerRuntime(base), ...cambios };
  const destino = path.join(base, "runtime.json");
  const temporal = `${destino}.${process.pid}.tmp`;
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(temporal, JSON.stringify(estado, null, 2));
  fs.renameSync(temporal, destino);
  return estado;
}

function invocarControl(base, accion, { automatico, esperar = true } = {}) {
  if (process.platform !== "win32") return Promise.reject(new Error("El control del arranque está disponible en Windows"));
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(base, "herramientas", "control-servidor.ps1"), "-Base", base, "-Accion", accion];
  if (automatico !== undefined) args.push("-Automatico", automatico ? "Activar" : "Desactivar");
  if (["Detener", "Reiniciar"].includes(accion)) args.push("-Despachar");
  return new Promise((resolve, reject) => {
    const hijo = execFile("powershell.exe", args, { windowsHide: true, timeout: 90000 }, (e, salida, error) => {
      if (e && esperar) reject(new Error(String(error || e.message).trim().slice(0, 300)));
      else resolve(String(salida || "").trim());
    });
    if (!esperar) { hijo.unref(); resolve(""); }
  });
}

async function migrarRuntime(base, dirApp, log = () => {}) {
  // El desarrollo no crea tareas ni certificados. Sólo se migra una instalación
  // portable que ya tiene su lanzador fuera de la carpeta versionada.
  if (process.platform !== "win32" || !fs.existsSync(path.join(base, "arranque.js"))) return false;
  const herramientas = path.join(base, "herramientas");
  fs.mkdirSync(herramientas, { recursive: true });
  for (const nombre of fs.readdirSync(path.join(dirApp, "windows"))) {
    const origen = path.join(dirApp, "windows", nombre);
    if (fs.statSync(origen).isFile()) fs.copyFileSync(origen, path.join(herramientas, nombre));
  }
  const propio = path.join(base, "arranque.js");
  const nuevo = path.join(dirApp, "lanzador.js");
  if (fs.readFileSync(propio, "utf8") !== fs.readFileSync(nuevo, "utf8")) fs.copyFileSync(nuevo, propio);
  const marca = path.join(base, "app", "runtime-v2");
  if (!fs.existsSync(marca)) {
    try {
      await invocarControl(base, "Registrar");
      fs.writeFileSync(marca, new Date().toISOString());
      log("Control de Windows actualizado: detener conserva el apagado y reiniciar vuelve a habilitar el arranque automático.");
    } catch (e) { log(`No se pudo actualizar la tarea de Windows: ${e.message}. Ejecutá herramientas\\configurar-arranque.bat como administrador.`); }
  }
  return true;
}

module.exports = { leerRuntime, escribirRuntime, invocarControl, migrarRuntime };
