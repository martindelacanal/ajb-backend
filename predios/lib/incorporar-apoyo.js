"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { identidadEquipo } = require("./control-equipo");
const { prepararTls, leerTls } = require("./tls-local");
const { crearTestigo } = require("./testigo-lan");
const { firmarPeticion } = require("./protocolo-lan");
const { descifrarJson } = require("./http-lan");

function leerConfig(archivo) { try { const c = JSON.parse(fs.readFileSync(archivo, "utf8").replace(/^\uFEFF/, "")); if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(); return c; } catch (_e) { throw new Error("No se pudo leer la configuración de incorporación"); } }
function caValida(pem) { try { if (typeof pem !== "string" || pem.length > 32768 || pem.includes("PRIVATE KEY") || !new crypto.X509Certificate(pem).ca) throw new Error(); return pem; } catch (_e) { throw new Error("Falta la autoridad HTTPS pública del servidor principal"); } }
function proteger(base) {
  fs.chmodSync(base, 0o700);
  if (process.platform !== "win32") return;
  const sid = /S-1-\d+(?:-\d+)+/.exec(execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10000 }))?.[0];
  if (!sid) throw new Error("No se pudo proteger la configuración del equipo");
  execFileSync("icacls.exe", [base, "/inheritance:r", "/grant:r", ...new Set([`*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]), "/Q"], { windowsHide: true, stdio: "pipe", timeout: 15000 });
}
function guardar(archivo, datos) {
  const temporal = `${archivo}.${crypto.randomBytes(8).toString("hex")}.tmp`; let fd;
  try { fd = fs.openSync(temporal, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify(datos, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporal, archivo); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporal)) fs.unlinkSync(temporal); }
}
function solicitar({ url, caPublica, cabeceras, cuerpo }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", ca: caPublica, rejectUnauthorized: true, headers: { ...cabeceras, "Content-Type": "application/json", "Content-Length": cuerpo.length } }, (res) => {
      const partes = []; let total = 0;
      res.on("data", (p) => { total += p.length; if (total > 2 * 1024 * 1024) req.destroy(new Error("La incorporación excede el tamaño permitido")); else partes.push(p); });
      res.on("error", reject); res.on("end", () => { clearTimeout(timer); if (res.statusCode !== 200) reject(new Error("El principal rechazó la incorporación; revisá si el permiso sigue vigente")); else resolve(Buffer.concat(partes)); });
    });
    const timer = setTimeout(() => req.destroy(new Error("El servidor principal no respondió a la incorporación")), 20000);
    req.on("error", (e) => { clearTimeout(timer); reject(e); }); req.end(cuerpo);
  });
}
async function enrolarApoyo({ base, continuar = false }, dependencias = {}) {
  base = path.resolve(base);
  const d = { identidadEquipo, prepararTls, leerTls, crearTestigo, solicitar, hostname: os.hostname, ahora: Date.now, ...dependencias };
  const archivo = path.join(base, "predio-ha.json"), inicial = leerConfig(archivo), inc = inicial.incorporacion;
  const rol = inicial.rolInstalacion, nodoId = d.identidadEquipo();
  if (!["Testigo", "Respaldo", "Acceso"].includes(rol) || !inicial.grupoId || !inc || !inc.id || !/^[a-f0-9]{64}$/.test(inc.clave || "")) throw new Error("El paquete no contiene una incorporación pendiente válida");
  if (!/^[a-f0-9]{64}$/.test(nodoId || "") || (inicial.equipoId && inicial.equipoId !== nodoId)) throw new Error("Esta incorporación corresponde a otra PC");
  const vence = typeof inc.vence === "number" ? inc.vence : Date.parse(inc.vence);
  if (!Number.isFinite(vence) || (!continuar && d.ahora() >= vence)) throw new Error("La incorporación venció; solicitá un paquete nuevo");
  let principal;
  try { principal = new URL(inc.principalUrl); if (principal.protocol !== "https:" || principal.username || principal.password || principal.search || principal.hash || principal.pathname !== "/") throw new Error(); }
  catch (_e) { throw new Error("La incorporación necesita la dirección HTTPS del principal"); }
  const caPublicaPrincipal = caValida(inc.caPublica);
  const nombre = String(d.hostname()).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(nombre)) throw new Error("El nombre de esta PC no es válido para la red local");
  proteger(base);
  const datos = { rol, nodoId, nombre };
  if (rol === "Respaldo") {
    await d.prepararTls(base); const tls = d.leerTls(base);
    const cert = new crypto.X509Certificate(tls.raiz);
    if (!cert.ca) throw new Error("El equipo no tiene una autoridad HTTPS válida");
    datos.caPublica = cert.toString(); datos.url = `https://${nombre}:${tls.puerto}`;
  } else if (rol === "Testigo") {
    if (!inicial.configTestigo || inicial.configTestigo.grupoId !== inicial.grupoId) throw new Error("El paquete no incluye la configuración inicial del testigo");
    const testigo = d.crearTestigo({ base: path.join(base, "testigo"), config: inicial.configTestigo });
    try { datos.clavePublicaTestigo = testigo.estado().clave_publica; } finally { testigo.cerrar(); }
    datos.url = `http://${nombre}:${inicial.puertoTestigo || 39877}`;
  }
  const url = new URL("/lan/incorporar", principal), cuerpo = Buffer.from(JSON.stringify(datos));
  const cabeceras = { ...firmarPeticion({ grupoId: inicial.grupoId, nodoId, metodo: "POST", ruta: url.pathname, cuerpo, clave: inc.clave, ahora: d.ahora() }), "X-AJB-Incorporacion": String(inc.id) };
  const buffer = await d.solicitar({ url: url.toString(), caPublica: caPublicaPrincipal, cabeceras, cuerpo });
  let respuesta;
  try { respuesta = descifrarJson(buffer, inc.clave); } catch (_e) { throw new Error("La respuesta de incorporación no pudo autenticarse"); }
  const ha = respuesta?.ha;
  if (!ha || typeof ha !== "object" || Array.isArray(ha) || ha.grupoId !== inicial.grupoId || ha.equipoId !== nodoId || ha.incorporacion || ha.habilitado !== true || (ha.rolInstalacion && ha.rolInstalacion !== rol)) throw new Error("La incorporación no devolvió una configuración válida para esta PC");
  if (rol === "Acceso" && (ha.clave || ha.claveDatos || ha.claveAdministracion || ha.clavePrivadaTestigo || ha.miembros?.some((m) => m.clave))) throw new Error("La configuración de acceso debe contener sólo datos públicos");
  if (rol === "Testigo" && ha.clavePublicaTestigo !== datos.clavePublicaTestigo) throw new Error("La incorporación no conserva la identidad del testigo");
  if (respuesta.configPredio) {
    if (rol !== "Respaldo" || !Number.isSafeInteger(Number(respuesta.configPredio.predio_id)) || Number(respuesta.configPredio.predio_id) <= 0) throw new Error("La incorporación devolvió una configuración de predio no válida");
    const anterior = leerConfig(path.join(base, "config.json"));
    if (Number(anterior.predio_id) !== Number(respuesta.configPredio.predio_id)) throw new Error("La incorporación pertenece a otro predio");
    guardar(path.join(base, "config.json"), respuesta.configPredio);
  }
  guardar(archivo, { ...ha, rolInstalacion: rol, equipoId: nodoId });
  return { rol, nodoId, incorporado: true };
}
if (require.main === module) {
  const i = process.argv.indexOf("--base");
  if (i < 0 || !process.argv[i + 1]) { console.error("Indicá --base para incorporar esta instalación"); process.exitCode = 1; }
  else enrolarApoyo({ base: process.argv[i + 1], continuar: process.argv.includes("--continuar") }).then(() => console.log("Incorporación completada"), (e) => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { enrolarApoyo };
