"use strict";

const crypto = require("node:crypto");
const TTL_MS = 30000;
function sha256(v) { return crypto.createHash("sha256").update(v).digest("hex"); }
function bytes(cuerpo) { return Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo ?? {})); }
function hmac(v, clave) {
  if (typeof clave !== "string" || clave.length < 16) throw new Error("Falta una credencial LAN válida");
  return crypto.createHmac("sha256", clave).update(v).digest("hex");
}
function igual(a, b) { return typeof a === "string" && typeof b === "string" && /^[a-f0-9]{64}$/.test(a) && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function firmarPeticion({ grupoId, nodoId, metodo, ruta, cuerpo, clave, ahora = Date.now(), nonce = crypto.randomBytes(24).toString("hex") }) {
  const fecha = String(typeof ahora === "function" ? ahora() : ahora);
  const texto = ["AJB_LAN_1", grupoId, nodoId, String(metodo).toUpperCase(), ruta, fecha, nonce, sha256(bytes(cuerpo))].join("\n");
  return { "x-ajb-grupo": String(grupoId), "x-ajb-nodo": String(nodoId), "x-ajb-fecha": fecha, "x-ajb-nonce": nonce, "x-ajb-firma": hmac(texto, clave) };
}
function crearVerificador({ grupoId, miembros, ahora = Date.now, ttlMs = TTL_MS }) {
  const usados = new Map();
  return function verificar({ metodo, ruta, cuerpo, cabeceras }) {
    const claves = new Map((typeof miembros === "function" ? miembros() : miembros).map((m) => [m.id, m.clave]));
    const h = Object.fromEntries(Object.entries(cabeceras || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const nodo = h["x-ajb-nodo"], nonce = h["x-ajb-nonce"], fecha = Number(h["x-ajb-fecha"]), reloj = ahora();
    if (h["x-ajb-grupo"] !== grupoId || !claves.has(nodo) || !/^[a-f0-9]{32,128}$/.test(nonce || "") || !Number.isSafeInteger(fecha)) throw new Error("La petición LAN no está autenticada o venció");
    for (const [k, vence] of usados) if (vence < reloj) usados.delete(k);
    const esperado = firmarPeticion({ grupoId, nodoId: nodo, metodo, ruta, cuerpo, clave: claves.get(nodo), ahora: fecha, nonce });
    if (!igual(esperado["x-ajb-firma"], h["x-ajb-firma"])) throw new Error("La firma LAN no coincide");
    const k = `${nodo}:${nonce}`;
    if (usados.has(k)) throw new Error("La petición LAN ya fue utilizada");
    if (Math.abs(reloj - fecha) > Math.min(ttlMs, TTL_MS)) {
      const datos = { tipo: "AJB_LAN_RELOJ_1", grupoId, nodoId: nodo, nonce, fecha,
        peticionFirma: h["x-ajb-firma"], servidorMs: reloj };
      throw Object.assign(new Error("La petición LAN venció porque los relojes de las PCs difieren"), {
        status: 409, codigo: "RELOJ_LAN_DESAJUSTADO", relojLan: { datos, firma: hmac(JSON.stringify(datos), claves.get(nodo)) },
      });
    }
    if (usados.size >= 50000) throw new Error("Demasiadas peticiones LAN pendientes de vencimiento");
    usados.set(k, fecha + Math.min(ttlMs, TTL_MS));
    return { nodoId: nodo };
  };
}
function leerRelojRemoto(sobre, cabeceras, clave) {
  const d = sobre?.datos;
  if (!d || d.tipo !== "AJB_LAN_RELOJ_1" || d.grupoId !== cabeceras["x-ajb-grupo"] || d.nodoId !== cabeceras["x-ajb-nodo"]
    || d.nonce !== cabeceras["x-ajb-nonce"] || d.fecha !== Number(cabeceras["x-ajb-fecha"])
    || d.peticionFirma !== cabeceras["x-ajb-firma"] || !Number.isSafeInteger(d.servidorMs)
    || !igual(hmac(JSON.stringify(d), clave), sobre.firma)) return null;
  return d.servidorMs;
}
function firmarAckReplica({ grupoId, nodoId, escritorId, termino, indice, sha256: huella }, clave, { nonce = crypto.randomBytes(24).toString("hex") } = {}) {
  const ack = { tipo: "AJB_ACK_REPLICA", formato: 1, grupo_id: grupoId, nodo_id: nodoId, escritor_id: escritorId, termino, indice, sha256: huella, nonce };
  return { ack, firma: hmac(JSON.stringify(ack), clave) };
}
function verificarAckReplica(sobre, { grupoId, escritorId, termino, indice, sha256: huella, miembros }) {
  const a = sobre?.ack;
  const miembro = miembros.find((m) => m.id === a?.nodo_id);
  if (!a || !miembro || a.nodo_id === escritorId || a.tipo !== "AJB_ACK_REPLICA" || a.formato !== 1 || a.grupo_id !== grupoId || a.escritor_id !== escritorId || a.termino !== termino || a.indice !== indice || a.sha256 !== huella || !/^[a-f0-9]{32,128}$/.test(a.nonce || "") || !igual(hmac(JSON.stringify(a), miembro.clave), sobre.firma)) throw new Error("El acuse durable de la réplica no es válido");
  return a.nodo_id;
}
function verificarEstadoFirmado(sobre, { clavePublica, grupoId, desafio, ahora = Date.now } = {}) {
  const e = sobre?.estado;
  let valida = false;
  try { const llave = typeof clavePublica === "string" || Buffer.isBuffer(clavePublica) ? crypto.createPublicKey(clavePublica) : clavePublica; valida = !!e && llave?.asymmetricKeyType === "ed25519" && crypto.verify(null, Buffer.from(JSON.stringify(e)), llave, Buffer.from(sobre.firma, "base64")); } catch (_e) { /* firma no válida */ }
  if (!valida || !desafio || e.desafio !== desafio || e.grupo_id !== grupoId || e.tipo !== "AJB_TESTIGO_ESTADO" || e.formato !== 1 || !Number.isSafeInteger(e.termino) || e.termino < 0 || !Number.isSafeInteger(e.emitido_ms) || !Number.isSafeInteger(e.vence_ms) || e.vence_ms < e.emitido_ms || e.vence_ms - e.emitido_ms > 5000) throw new Error("El estado del testigo no tiene una firma válida para esta consulta");
  const reloj = typeof ahora === "function" ? ahora() : ahora;
  // El nonce acredita la consulta actual aun si los relojes de las PCs difieren.
  // Cuando están razonablemente alineados, también se comprueba el vencimiento.
  if (Math.abs(reloj - e.emitido_ms) <= TTL_MS && reloj > e.vence_ms) throw new Error("El estado firmado del testigo venció");
  return e;
}
module.exports = { firmarPeticion, crearVerificador, leerRelojRemoto, firmarAckReplica, verificarAckReplica, verificarEstadoFirmado, TTL_MS };
