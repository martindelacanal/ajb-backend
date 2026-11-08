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
const nodoValido = id => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
const nombreValido = nombre => typeof nombre === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(nombre);
const puertoValido = n => Number.isInteger(n) && n > 0 && n <= 65535;

function crearUbicacionLan({ grupoId, nodoId, claveDatos, puertos, log = () => {}, red = os.networkInterfaces,
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
    if (dato?.grupoId !== grupoId || !nodoValido(dato.nodoId) || dato.nodoId === nodoId ||
        typeof dato.nonce !== "string" || !/^[a-f0-9]{32}$/.test(dato.nonce) || !mensajeAutentico(dato, clave)) return;
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

module.exports = { crearUbicacionLan, conectarMiembro };
