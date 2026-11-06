"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");

function proteger(carpeta) {
  fs.chmodSync(carpeta, 0o700);
  const usuario = /S-1-\d+(?:-\d+)+/.exec(execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10000 }))?.[0];
  if (!usuario) throw new Error("No se pudo proteger el paquete de incorporación");
  execFileSync("icacls.exe", [carpeta, "/inheritance:r", "/grant:r", ...new Set([`*${usuario}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]), "/Q"], { windowsHide: true, timeout: 15000, stdio: "pipe" });
}
function copiar(origen, destino) {
  const s = fs.lstatSync(origen);
  if (s.isSymbolicLink()) throw new Error("El código del instalador contiene un enlace no permitido");
  if (s.isDirectory()) {
    fs.mkdirSync(destino, { recursive: true, mode: 0o700 });
    for (const n of fs.readdirSync(origen)) {
      if (n.startsWith(".") || ["node_modules", "test", "datos", "logs"].includes(n)) continue;
      copiar(path.join(origen, n), path.join(destino, n));
    }
  } else if (s.isFile()) { fs.mkdirSync(path.dirname(destino), { recursive: true, mode: 0o700 }); fs.copyFileSync(origen, destino, fs.constants.COPYFILE_EXCL); }
  else throw new Error("El código del instalador contiene un archivo no regular");
}
async function armarInstaladorApoyo({ base, dirApp, version, configInicial, configPredio } = {}) {
  if (process.platform !== "win32" || path.extname(process.execPath).toLowerCase() !== ".exe") throw new Error("El instalador portable se arma con el runtime de Windows");
  const fd = fs.openSync(process.execPath, "r"); const firma = Buffer.alloc(2);
  try { fs.readSync(fd, firma, 0, 2, 0); } finally { fs.closeSync(fd); }
  if (firma.toString() !== "MZ") throw new Error("El runtime actual no es un ejecutable de Windows");
  if (!base || !dirApp || typeof version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,100}$/.test(version) || version.includes("..")) throw new Error("Falta una versión actual válida para el instalador");
  if (!configInicial || !["Testigo", "Respaldo", "Acceso"].includes(configInicial.rolInstalacion) || !configInicial.grupoId || !/^[a-f0-9]{64}$/.test(configInicial.incorporacion?.clave || "") || !configInicial.incorporacion?.id) throw new Error("El instalador necesita una incorporación de un solo uso");
  const padre = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-instalar-apoyo-"));
  try {
    proteger(padre);
    const contenido = path.join(padre, "paquete"), app = path.join(contenido, "app", "versiones", version);
    fs.mkdirSync(app, { recursive: true, mode: 0o700 });
    for (const n of ["package.json", "lanzador.js", "servidor.js", "lib", "public", "windows"]) copiar(path.join(dirApp, n), path.join(app, n));
    fs.writeFileSync(path.join(app, ".version"), version, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(contenido, "app", "ACTUAL"), version, { flag: "wx", mode: 0o600 });
    fs.mkdirSync(path.join(contenido, "node"));
    fs.copyFileSync(process.execPath, path.join(contenido, "node", "node.exe"), fs.constants.COPYFILE_EXCL);
    copiar(path.join(dirApp, "lanzador.js"), path.join(contenido, "arranque.js"));
    const instalador = path.join(contenido, "instalador"); fs.mkdirSync(instalador);
    for (const n of ["configurar-apoyo.ps1", "arranque-apoyo.js", "configurar-acceso-caja.ps1", "crear-acceso-pc-caja.bat"]) copiar(path.join(dirApp, "windows", n), path.join(instalador, n));
    copiar(path.join(dirApp, "windows", "INSTALAR-APOYO.bat"), path.join(contenido, "INSTALAR-APOYO.bat"));
    fs.writeFileSync(path.join(contenido, "predio-ha.json"), JSON.stringify(configInicial, null, 2), { flag: "wx", mode: 0o600 });
    if (configInicial.rolInstalacion === "Respaldo") {
      if (!configPredio || !Number.isSafeInteger(Number(configPredio.predio_id)) || Number(configPredio.predio_id) <= 0) throw new Error("Falta la configuración pública del predio para el respaldo");
      const publico = Object.fromEntries(["predio_id", "predio_codigo", "predio_nombre", "puerto", "clave_publica"].filter((k) => configPredio[k] !== undefined).map((k) => [k, configPredio[k]]));
      fs.writeFileSync(path.join(contenido, "config.json"), JSON.stringify(publico, null, 2), { flag: "wx", mode: 0o600 });
    }
    const zip = path.join(padre, "apoyo.zip");
    await new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $archivos=@(Get-ChildItem -LiteralPath $env:AJB_APOYO_STAGE -Force | ForEach-Object { $_.FullName }); Compress-Archive -LiteralPath $archivos -DestinationPath $env:AJB_APOYO_ZIP -CompressionLevel Optimal"], { windowsHide: true, timeout: 240000, env: { ...process.env, AJB_APOYO_STAGE: contenido, AJB_APOYO_ZIP: zip } }, (e) => e ? reject(new Error("No se pudo comprimir el instalador portable de Windows")) : resolve()));
    if (fs.statSync(zip).size > 400 * 1024 * 1024) throw new Error("El instalador excede el tamaño permitido");
    return { buffer: fs.readFileSync(zip), nombreArchivo: `AJB-Predio-${configInicial.rolInstalacion}-${String(configInicial.grupoId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}.zip` };
  } finally { fs.rmSync(padre, { recursive: true, force: true }); }
}
module.exports = { armarInstaladorApoyo };
