"use strict";

// Delegación del dueño original hacia un escritor LAN acreditado por su testigo.
// El llamador debe mantener SELECT predio FOR UPDATE y esta validación dentro de
// la misma transacción que protege la operación central que vaya a realizar.
const crypto = require("node:crypto");
const U = require("../../predios/lib/util");
const autorizaciones = new WeakSet();
const MAX_HEADER = 16 * 1024;
const TOLERANCIA_RELOJ_MS = 30000;
const TOLERANCIA_VENCIMIENTO_MS = 2000;

function rechazar(mensaje, codigo = "HA_NO_AUTORIZADA") { throw U.error(mensaje, 409, { codigo }); }
function igual(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function clavePublica(pem) {
  try {
    if (typeof pem !== "string" || pem.length > 8192) throw new Error();
    const p = crypto.createPublicKey(pem);
    if (p.asymmetricKeyType !== "ed25519") throw new Error();
    return p.export({ type: "spki", format: "pem" });
  } catch (_e) { rechazar("La identidad pública del testigo no es válida"); }
}
function leerPrueba(cabecera) {
  if (typeof cabecera !== "string" || !cabecera.length || cabecera.length > MAX_HEADER || !/^[A-Za-z0-9+/]+={0,2}$/.test(cabecera)) rechazar("La prueba LAN no tiene un formato válido");
  try {
    const raw = Buffer.from(cabecera, "base64");
    if (raw.toString("base64") !== cabecera) throw new Error();
    const prueba = JSON.parse(raw.toString("utf8"));
    if (!prueba || typeof prueba !== "object" || Array.isArray(prueba) || !prueba.certificado || !prueba.estadoFirmado) throw new Error();
    return prueba;
  } catch (_e) { rechazar("La prueba LAN no se pudo interpretar"); }
}
function leerEvento(fila, tipo) {
  if (!fila) return null;
  try {
    const d = typeof fila.detalle === "string" ? JSON.parse(fila.detalle) : fila.detalle;
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error();
    return d;
  } catch (_e) { rechazar(`El registro ${tipo} del predio necesita revisión`, "HA_REGISTRO_INVALIDO"); }
}
async function ultimoEvento(conexion, predioId, tipo) {
  const [filas] = await conexion.query("SELECT detalle FROM predio_evento WHERE predio_id = ? AND tipo = ? ORDER BY id DESC LIMIT 1", [predioId, tipo]);
  return leerEvento(filas[0], tipo);
}
async function evento(conexion, predioId, tipo, detalle) {
  await conexion.query("INSERT INTO predio_evento (predio_id, tipo, detalle) VALUES (?, ?, ?)", [predioId, tipo, JSON.stringify(detalle)]);
}

async function validarAutorizacionHa(conexion, predio, { token, cabecera, instanciaId, equipoId, ahora = Date.now } = {}) {
  const registro = await ultimoEvento(conexion, predio.id, "HA_REGISTRO");
  if (!cabecera) {
    if (registro) rechazar("Este predio requiere la prueba vigente de su testigo LAN, incluso desde el servidor original", "HA_PRUEBA_REQUERIDA");
    return { haAutorizada: false };
  }
  if (predio.escritor !== "LOCAL" || !predio.instancia_id || !/^[a-f0-9]{64}$/.test(predio.equipo_id || "")) rechazar("Primero debe quedar vinculado el servidor original del predio", "HA_ORIGEN_NO_VINCULADO");
  if (typeof token !== "string" || !token.length) rechazar("Falta la credencial autenticada de la instalación");
  if (instanciaId !== predio.instancia_id || !/^[a-f0-9]{64}$/.test(equipoId || "")) rechazar("La prueba LAN no corresponde a esta instalación física y lógica");
  const prueba = leerPrueba(cabecera), certificado = prueba.certificado, datos = certificado.datos;
  if (!datos || datos.formato !== 1 || !/^[a-zA-Z0-9_-]{8,100}$/.test(datos.grupoId || "")
    || datos.instanciaId !== predio.instancia_id || datos.equipoOrigenId !== predio.equipo_id
    || typeof certificado.firma !== "string" || !/^[a-fA-F0-9]{64}$/.test(certificado.firma)) rechazar("El certificado LAN no corresponde al dueño original de este predio");
  const firmaEsperada = crypto.createHmac("sha256", token).update(JSON.stringify(datos)).digest();
  if (!igual(firmaEsperada, Buffer.from(certificado.firma, "hex"))) rechazar("El certificado LAN no fue autorizado por la instalación autenticada");
  const pin = clavePublica(datos.clavePublicaTestigo);
  if (registro && (registro.formato !== 1 || registro.predioId !== Number(predio.id) || registro.grupoId !== datos.grupoId || registro.instanciaId !== datos.instanciaId
    || registro.equipoOrigenId !== datos.equipoOrigenId || registro.clavePublicaTestigo !== pin)) rechazar("El grupo o la identidad del testigo difiere del registro del predio", "HA_GRUPO_DISTINTO");

  const sobre = prueba.estadoFirmado, e = sobre.estado;
  let firmaValida = false;
  try { firmaValida = !!e && typeof sobre.firma === "string" && sobre.firma.length <= 256 && crypto.verify(null, Buffer.from(JSON.stringify(e)), pin, Buffer.from(sobre.firma, "base64")); }
  catch (_e) { /* nunca se usa sobre.clave_publica para verificar */ }
  if (!firmaValida || e.tipo !== "AJB_TESTIGO_ESTADO" || e.formato !== 1 || e.grupo_id !== datos.grupoId || !Number.isSafeInteger(e.termino) || e.termino < 1
    || !e.escritor || e.escritor.id !== equipoId || e.bloqueado === true || Number(e.cuarentena_ms || 0) > 0) rechazar("El testigo no acredita a esta PC como escritora vigente");
  const compacto = e.compacto === true && e.miembro_autorizado === true;
  if (!compacto && (!Array.isArray(e.miembros) || e.miembros.length < 1 || e.miembros.length > 20 || e.miembros.some(m => !m || !/^[a-f0-9]{64}$/.test(m.id || ""))
    || new Set(e.miembros.map(m => m.id)).size !== e.miembros.length || !e.miembros.some(m => m.id === equipoId))) rechazar("El escritor no pertenece a los miembros acreditados por el testigo");
  const tiempo = typeof ahora === "function" ? ahora() : ahora;
  if (!Number.isSafeInteger(tiempo) || !Number.isSafeInteger(e.emitido_ms) || !Number.isSafeInteger(e.vence_ms) || e.emitido_ms < 0 || e.vence_ms < e.emitido_ms || e.vence_ms - e.emitido_ms > 5000
    || Math.abs(tiempo - e.emitido_ms) > TOLERANCIA_RELOJ_MS || tiempo > e.vence_ms + TOLERANCIA_VENCIMIENTO_MS) rechazar("La prueba del testigo venció o sus horarios no coinciden con el sistema general", "HA_PRUEBA_VENCIDA");
  if (!e.ultimo || !Number.isSafeInteger(e.ultimo.indice) || e.ultimo.indice < 0 || !/^[a-f0-9]{64}$/.test(e.ultimo.sha256 || "")) rechazar("La revisión acreditada por el testigo no es válida");

  const ultimo = await ultimoEvento(conexion, predio.id, "HA_TERMINO");
  if (ultimo && (ultimo.grupoId !== datos.grupoId || !Number.isSafeInteger(ultimo.termino) || ultimo.termino < 1 || !/^[a-f0-9]{64}$/.test(ultimo.escritorId || ""))) rechazar("El término registrado del predio necesita revisión", "HA_REGISTRO_INVALIDO");
  if (ultimo && (e.termino < ultimo.termino || (e.termino === ultimo.termino && equipoId !== ultimo.escritorId))) rechazar("La autoridad de ese servidor fue reemplazada por un término posterior", "HA_TERMINO_ANTERIOR");
  if (!registro) await evento(conexion, predio.id, "HA_REGISTRO", { formato: 1, predioId: Number(predio.id), grupoId: datos.grupoId, instanciaId: datos.instanciaId, equipoOrigenId: datos.equipoOrigenId, clavePublicaTestigo: pin });
  if (!ultimo || e.termino > ultimo.termino) await evento(conexion, predio.id, "HA_TERMINO", { grupoId: datos.grupoId, termino: e.termino, escritorId: equipoId, indice: e.ultimo.indice, sha256: e.ultimo.sha256 });
  const autorizada = { haAutorizada: true, predioId: Number(predio.id), grupoId: datos.grupoId, instanciaId: datos.instanciaId, equipoId, termino: e.termino, indice: e.ultimo.indice, sha256: e.ultimo.sha256 };
  autorizaciones.add(autorizada);
  return autorizada;
}

function esAutorizacionHa(autorizada, predio, quien) {
  return !!autorizada && autorizaciones.has(autorizada) && autorizada.predioId === Number(predio.id) && autorizada.instanciaId === quien.instancia_id && autorizada.equipoId === quien.equipo_id;
}

module.exports = { validarAutorizacionHa, esAutorizacionHa, MAX_HEADER };
