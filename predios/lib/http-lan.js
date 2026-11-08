"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { performance } = require("node:perf_hooks");
const { firmarPeticion, verificarEstadoFirmado } = require("./protocolo-lan");

function respuesta(res, status, datos, cabeceras = {}) {
  const buffer = Buffer.isBuffer(datos) ? datos : Buffer.from(JSON.stringify(datos));
  res.writeHead(status, { "Content-Type": Buffer.isBuffer(datos) ? "application/octet-stream" : "application/json; charset=utf-8", "Content-Length": buffer.length, "Cache-Control": "no-store", ...cabeceras });
  res.end(buffer);
}
function leer(req, maximo = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const partes = []; let bytes = 0;
    req.on("data", (p) => { bytes += p.length; if (bytes > maximo) { reject(Object.assign(new Error("El paquete supera el límite permitido"), { status: 413 })); req.destroy(); } else partes.push(p); });
    req.on("end", () => resolve(Buffer.concat(partes))); req.on("error", reject);
  });
}
function cifrarJson(datos, clave) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", Buffer.from(clave, "hex"), iv);
  return Buffer.concat([iv, c.update(JSON.stringify(datos)), c.final(), c.getAuthTag()]);
}
function descifrarJson(buffer, clave) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 28) throw new Error("El contenido cifrado no es válido");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(clave, "hex"), buffer.subarray(0, 12));
  d.setAuthTag(buffer.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(buffer.subarray(12, -16)), d.final()]).toString("utf8"));
}
async function pedir(urlBase, ruta, { grupoId, nodoId, clave, metodo = "POST", cuerpo, buffer, timeout = 4000, binario = false, ca, servername } = {}) {
  const url = new URL(ruta, urlBase);
  if (url.origin !== new URL(urlBase).origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("La dirección LAN no es válida");
  const datos = buffer || (cuerpo === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(cuerpo)));
  const headers = clave ? firmarPeticion({ grupoId, nodoId, clave, metodo, ruta: url.pathname + url.search, cuerpo: datos }) : {};
  if (metodo !== "GET") headers["Content-Type"] = buffer ? "application/octet-stream" : "application/json";
  if (metodo !== "GET") headers["Content-Length"] = datos.length;
  const r = await new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { method: metodo, headers, ca, servername, rejectUnauthorized: true }, (res) => {
      const partes = []; let total = 0;
      const limite = binario && res.statusCode === 200 ? 300 * 1024 * 1024 + 16384 : 2 * 1024 * 1024;
      res.on("data", (p) => { total += p.length; if (total > limite) req.destroy(new Error("La respuesta LAN supera el tamaño permitido")); else partes.push(p); });
      res.on("error", reject);
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, buffer: Buffer.concat(partes), headers: res.headers }); });
    });
    const timer = setTimeout(() => req.destroy(new Error("Se agotó el tiempo de espera del equipo LAN")), timeout);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.end(metodo === "GET" ? undefined : datos);
  });
  if (r.status !== 200) { let m = "No respondió el equipo de la red local"; try { m = JSON.parse(r.buffer.toString("utf8")).mensaje || m; } catch (_e) {} throw Object.assign(new Error(m), { status: r.status }); }
  return binario ? r : JSON.parse(r.buffer.toString("utf8"));
}
async function estadoTestigo(c, { compacto = false } = {}) {
  const desafio = crypto.randomBytes(20).toString("hex"), inicio = performance.now();
  const sobre = await pedir(c.testigo.url, "/lan/testigo/estado?desafio=" + desafio + (compacto ? "&compacto=1" : ""), { metodo: "GET", timeout: 3000 });
  const estado = verificarEstadoFirmado(sobre, { clavePublica: c.clavePublicaTestigo, grupoId: c.grupoId, desafio });
  const transcurrido = performance.now() - inicio;
  if (transcurrido >= 5000) throw new Error("La respuesta del testigo llegó tarde");
  return { ...estado, escritor: estado.escritor?.id || null, escritorDatos: estado.escritor, vence_en_ms: Math.max(0, estado.vence_ms - estado.emitido_ms - transcurrido), sobre };
}

module.exports = { respuesta, leer, cifrarJson, descifrarJson, pedir, estadoTestigo };
