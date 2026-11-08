"use strict";

const crypto = require("node:crypto");
const dgram = require("node:dgram");
const { isIPv4 } = require("node:net");
const os = require("node:os");
const { destinosBroadcast, firmarMensaje, mensajeAutentico } = require("./descubrimiento");

const PUERTO = 39879;
const VIGENCIA = 12000;
const CONSULTA = "AJB_QUORUM_BUSCAR";
const RESPUESTA = "AJB_QUORUM_UBICACION";
const CONSULTA_ACCESO = "AJB_ACCESO_BUSCAR";
const RESPUESTA_ACCESO = "AJB_ACCESO_UBICACION";
const nodoValido = id => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
const nombreValido = nombre => typeof nombre === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(nombre);
const puertoValido = n => Number.isInteger(n) && n > 0 && n <= 65535;
const nonceValido = nonce => typeof nonce === "string" && /^[a-f0-9]{32}$/.test(nonce);

function crearUbicacionLan({ grupoId, nodoId, claveDatos, puertos, firmaAcceso, log = () => {}, red = os.networkInterfaces,
  nombre = os.hostname, ahora = () => performance.now(), intervaloMs = 2000 }) {
  const clave = crypto.createHmac("sha256", Buffer.from(claveDatos, "hex")).update("ajb-quorum-ubicacion-v1").digest("hex");
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const preguntas = new Map(), equipos = new Map();
  let timer, detenido = false;

  function enviar(datos, ip, puerto = PUERTO) {
    if (detenido) return;
    const mensaje = Buffer.from(JSON.stringify(firmarMensaje({ grupoId, nodoId, ...datos }, clave)));
    socket.send(mensaje, puerto, ip, () => {});
  }
  function limpiar(mapa) {
    const t = ahora();
    for (const [id, dato] of mapa) if (dato.vence <= t) mapa.delete(id);
  }
  function buscar() {
    limpiar(preguntas);
    limpiar(equipos);
    const nonce = crypto.randomBytes(16).toString("hex");
    preguntas.set(nonce, { vence: ahora() + VIGENCIA });
    for (const ip of destinosBroadcast(red())) enviar({ tipo: CONSULTA, nonce }, ip);
  }
  socket.on("message", (buffer, remoto) => {
    if (detenido || buffer.length > 2048 || !isIPv4(remoto.address)) return;
    let dato;
    try { dato = JSON.parse(buffer); } catch (_e) { return; }
    if (dato?.grupoId !== grupoId || !nonceValido(dato.nonce)) return;
    if (dato.tipo === CONSULTA_ACCESO) {
      const llave = firmaAcceso?.();
      const { http, https } = puertos();
      const nombreTls = nombre().toLowerCase();
      if (!llave || !puertoValido(http) || !puertoValido(https) || !nombreValido(nombreTls)) return;
      const ips = Object.values(red()).flat().filter(i => i?.family === "IPv4" && !i.internal).map(i => i.address);
      const ubicacion = { tipo: RESPUESTA_ACCESO, grupoId, nodoId, nonce: dato.nonce, nombreTls, ips, http, https };
      const firma = crypto.sign(null, Buffer.from(JSON.stringify(ubicacion)), llave).toString("base64");
      socket.send(Buffer.from(JSON.stringify({ ubicacion, firma })), remoto.port, remoto.address, () => {});
      return;
    }
    if (!nodoValido(dato.nodoId) || dato.nodoId === nodoId || !mensajeAutentico(dato, clave)) return;
    if (dato.tipo === CONSULTA) {
      const { https, raft } = puertos();
      const nombreTls = nombre().toLowerCase();
      const ips = Object.values(red()).flat().filter(i => i?.family === "IPv4" && !i.internal).map(i => i.address);
      if (nombreValido(nombreTls) && ips.length && (puertoValido(https) || puertoValido(raft))) {
        enviar({ tipo: RESPUESTA, nonce: dato.nonce, nombreTls, ips, https, raft }, remoto.address, remoto.port);
      }
      return;
    }
    const pregunta = preguntas.get(dato.nonce);
    if (dato.tipo !== RESPUESTA || !pregunta || pregunta.vence <= ahora() || !Array.isArray(dato.ips) ||
        !dato.ips.includes(remoto.address) || !nombreValido(dato.nombreTls) ||
        !(puertoValido(dato.https) || puertoValido(dato.raft))) return;
    const anterior = equipos.get(dato.nodoId);
    if ((!anterior && equipos.size >= 64) || anterior?.pregunta >= pregunta.vence) return;
    equipos.set(dato.nodoId, { ip: remoto.address, nombreTls: dato.nombreTls,
      https: puertoValido(dato.https) ? dato.https : null, raft: puertoValido(dato.raft) ? dato.raft : null,
      pregunta: pregunta.vence, vence: ahora() + VIGENCIA });
  });
  socket.on("error", e => log(`Ubicación de equipos LAN: ${e.message}`));
  socket.bind(PUERTO, "0.0.0.0", () => {
    if (detenido) return;
    socket.setBroadcast(true);
    buscar();
    timer = setInterval(buscar, intervaloMs);
    timer.unref();
  });
  socket.unref();

  return {
    equipo(id) {
      const e = equipos.get(id);
      return e?.vence > ahora() ? e : null;
    },
    direccionesRaft() {
      limpiar(equipos);
      return Object.fromEntries([...equipos].filter(([, e]) => e.raft).map(([id, e]) => [id, `${e.ip}:${e.raft}`]));
    },
    detener() {
      if (detenido) return;
      detenido = true;
      clearInterval(timer);
      try { socket.close(); } catch (_e) { /* socket sin abrir */ }
    },
  };
}

function buscarAccesoLan({ grupoId, clavePublica, red = os.networkInterfaces, esperaMs = 350 }) {
  return new Promise(resolve => {
    const nonce = crypto.randomBytes(16).toString("hex");
    const socket = dgram.createSocket("udp4"), equipos = new Map();
    let finalizado = false;
    const terminar = () => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_e) { /* todavía sin abrir */ }
      resolve(equipos);
    };
    const timer = setTimeout(terminar, esperaMs);
    socket.on("error", terminar);
    socket.on("message", (buffer, remoto) => {
      if (buffer.length > 2048 || remoto.port !== PUERTO || !isIPv4(remoto.address)) return;
      try {
        const { ubicacion: u, firma } = JSON.parse(buffer);
        if (u?.tipo !== RESPUESTA_ACCESO || u.grupoId !== grupoId || u.nonce !== nonce || !nodoValido(u.nodoId) ||
            !nombreValido(u.nombreTls) || !puertoValido(u.http) || !puertoValido(u.https) || !Array.isArray(u.ips) ||
            !u.ips.includes(remoto.address) || equipos.size >= 20 || !crypto.verify(null, Buffer.from(JSON.stringify(u)), clavePublica, Buffer.from(firma, "base64"))) return;
        equipos.set(u.nodoId, { ip: remoto.address, http: u.http, https: u.https, nombreTls: u.nombreTls });
      } catch (_e) { /* anuncio ajeno o inválido */ }
    });
    socket.bind(0, "0.0.0.0", () => {
      if (finalizado) return;
      socket.setBroadcast(true);
      const consulta = Buffer.from(JSON.stringify({ tipo: CONSULTA_ACCESO, grupoId, nonce }));
      for (const ip of destinosBroadcast(red())) socket.send(consulta, PUERTO, ip, () => {});
    });
  });
}

function conectarMiembro(miembro, ubicacion) {
  const e = ubicacion?.equipo(miembro.id);
  const original = { url: miembro.url, ca: miembro.caPublica };
  if (!e?.https) return original;
  const url = new URL(miembro.url);
  if (url.protocol === "https:" && !original.ca) return original;
  url.hostname = e.ip;
  url.port = e.https;
  return { url: url.origin, ca: miembro.caPublica, servername: e.nombreTls };
}

module.exports = { crearUbicacionLan, buscarAccesoLan, conectarMiembro };
