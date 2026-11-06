"use strict";

// Descubrimiento LAN sin internet. Sólo anuncia identidad/dirección públicas;
// la autorización para escribir depende del equipo registrado y de Mi AJB.
const dgram = require("node:dgram");
const os = require("node:os");
const crypto = require("node:crypto");

const PUERTO_DESCUBRIMIENTO = 39876;

function firmarMensaje(datos, clave) {
  if (!/^[a-f0-9]{64}$/.test(String(clave || ""))) return datos;
  return { ...datos, firma: crypto.createHmac("sha256", Buffer.from(clave, "hex")).update(JSON.stringify(datos)).digest("hex") };
}
function mensajeAutentico(datos, clave) {
  if (!/^[a-f0-9]{64}$/.test(String(clave || "")) || !/^[a-f0-9]{64}$/.test(String(datos?.firma || ""))) return false;
  const contenido = { ...datos }; delete contenido.firma;
  const esperada = firmarMensaje(contenido, clave).firma;
  return crypto.timingSafeEqual(Buffer.from(datos.firma, "hex"), Buffer.from(esperada, "hex"));
}

function destinosBroadcast(interfaces = os.networkInterfaces()) {
  const destinos = new Set(["255.255.255.255"]);
  for (const lista of Object.values(interfaces)) for (const i of lista || []) {
    if (i.family !== "IPv4" || i.internal || !i.address || !i.netmask) continue;
    const ip = i.address.split(".").map(Number), mascara = i.netmask.split(".").map(Number);
    if (ip.length === 4 && mascara.length === 4) destinos.add(ip.map((n, k) => n | (~mascara[k] & 255)).join("."));
  }
  return [...destinos];
}

function prioridad(a, b) {
  const orden = { ACTIVO: 0, COMPROBANDO: 1, CONSULTA: 2 };
  if (a.fase !== b.fase) return orden[a.fase] - orden[b.fase];
  if (a.iniciado !== b.iniciado) return a.iniciado - b.iniciado;
  return String(a.proceso_id).localeCompare(String(b.proceso_id));
}

function validarAnuncio(datos, codigo) {
  return datos && datos.tipo === "AJB_PREDIO_SERVIDOR" && datos.codigo === codigo
    && /^[a-f0-9]{32}$/.test(String(datos.proceso_id || ""))
    && Number.isFinite(datos.iniciado) && datos.iniciado > 0
    && ["ACTIVO", "COMPROBANDO", "CONSULTA"].includes(datos.fase)
    && Number.isSafeInteger(datos.puerto) && datos.puerto > 0 && datos.puerto <= 65535;
}

function crearDescubrimiento({ codigo, puertoHttp, equipoId, instanciaId, alOtro, alListo, clave = () => null, puedeSerEscritor = () => true, log = () => {}, puerto = PUERTO_DESCUBRIMIENTO, esperaMs = 1400, intervaloMs = 4000 }) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const propio = { tipo: "AJB_PREDIO_SERVIDOR", codigo, equipo_id: equipoId, instancia_id: instanciaId, proceso_id: crypto.randomBytes(16).toString("hex"), puerto: puertoHttp, iniciado: Date.now(), fase: puedeSerEscritor() ? "COMPROBANDO" : "CONSULTA" };
  const vistos = new Map();
  const desafios = new Map();
  let timer, latido, terminado = false, bloqueado = false;

  function enviar(datos, direccion) {
    if (terminado) return;
    const buffer = Buffer.from(JSON.stringify(firmarMensaje(datos, clave())));
    try { socket.send(buffer, puerto, direccion, () => {}); } catch (_e) { /* interfaz aún no disponible */ }
  }
  function anunciar() {
    if (propio.fase !== "COMPROBANDO") propio.fase = !bloqueado && puedeSerEscritor() ? "ACTIVO" : "CONSULTA";
    for (const d of destinosBroadcast()) enviar(propio, d);
  }
  function preguntar() {
    const ahora = Date.now();
    for (const [id, fecha] of desafios) if (ahora - fecha > 10000) desafios.delete(id);
    const id = crypto.randomBytes(16).toString("hex");
    desafios.set(id, ahora);
    for (const d of destinosBroadcast()) enviar({ tipo: "AJB_PREDIO_DESCUBRIR", codigo, proceso_id: propio.proceso_id, pregunta_id: id }, d);
  }
  function detenerEscritura(otro) {
    if (bloqueado) return;
    bloqueado = true;
    propio.fase = "CONSULTA";
    alOtro({ equipo_id: otro.equipo_id, instancia_id: otro.instancia_id, ip: otro.ip, url: `http://${otro.ip}:${otro.puerto}` });
  }
  socket.on("message", (mensaje, remoto) => {
    if (mensaje.length > 2048) return;
    let datos;
    try { datos = JSON.parse(mensaje); } catch (_e) { return; }
    if (!mensajeAutentico(datos, clave())) return;
    if (datos.codigo !== codigo || datos.proceso_id === propio.proceso_id) return;
    if (datos.tipo === "AJB_PREDIO_DESCUBRIR") {
      if (/^[a-f0-9]{32}$/.test(String(datos.pregunta_id || ""))) enviar({ ...propio, respuesta_a: datos.pregunta_id }, remoto.address);
      return;
    }
    if (!validarAnuncio(datos, codigo)) return;
    // Una grabación antigua de un anuncio válido no puede detener un servidor:
    // se exige respuesta firmada a un desafío reciente de este proceso.
    if (!desafios.has(datos.respuesta_a) || Date.now() - desafios.get(datos.respuesta_a) > 10000) return;
    const otro = { ...datos, ip: remoto.address, visto: Date.now() };
    vistos.set(datos.proceso_id, otro);
    if (propio.fase === "ACTIVO" && !bloqueado && datos.fase === "ACTIVO" && prioridad(otro, propio) < 0) detenerEscritura(otro);
  });
  socket.on("error", (e) => {
    log(`Detección LAN: ${e.message}. La protección por equipo sigue activa.`);
    // El firewall o UDP deshabilitado no debe apagar un predio que ya está autorizado.
    if (!timer) { timer = setTimeout(alListo, esperaMs); timer.unref?.(); }
  });
  socket.bind(puerto, "0.0.0.0", () => {
    socket.setBroadcast(true);
    preguntar();
    anunciar();
    timer = setTimeout(() => {
      const otros = [...vistos.values()].sort(prioridad);
      if (otros.length && otros[0].fase !== "CONSULTA" && prioridad(otros[0], propio) < 0) detenerEscritura(otros[0]);
      propio.fase = bloqueado || !puedeSerEscritor() ? "CONSULTA" : "ACTIVO";
      alListo(); anunciar();
      latido = setInterval(() => { anunciar(); preguntar(); }, intervaloMs); latido.unref?.();
    }, esperaMs);
    timer.unref?.();
  });
  socket.unref();
  return { detener() { terminado = true; clearTimeout(timer); clearInterval(latido); try { socket.close(); } catch (_e) { /* ya cerrado */ } }, descriptor: () => ({ ...propio }) };
}

module.exports = { PUERTO_DESCUBRIMIENTO, destinosBroadcast, prioridad, validarAnuncio, crearDescubrimiento, firmarMensaje, mensajeAutentico };
