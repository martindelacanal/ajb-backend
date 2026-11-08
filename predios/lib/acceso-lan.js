"use strict";

// Acceso de caja con origen estable. El testigo decide el escritor; este proceso
// no tiene credenciales de réplica y nunca vuelve a enviar una escritura.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const dns = require("node:dns").promises;
const { Transform } = require("node:stream");
const { buscarAccesoLan, conectarMiembro } = require("./ubicacion-lan");

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"]);
const METODOS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function privada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (!net.isIPv6(ip)) return false;
  const v = ip.toLowerCase();
  return v === "::1" || /^f[cd][0-9a-f]{2}:/.test(v) || (v.startsWith("::ffff:") && privada(v.slice(7)));
}

function origenPermitido(valor) {
  let url;
  try { url = new URL(valor); } catch (_e) { throw new Error("Dirección LAN inválida"); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.port === "0" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (net.isIP(host) ? !privada(host) : !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host))) throw new Error("La dirección debe ser un origen privado de la LAN");
  return url.origin;
}

async function destinoPrivado(origen, resolver) {
  const url = new URL(origen);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolver(host, { all: true, verbatim: true });
  if (!ips.length || ips.some(i => !privada(i.address))) throw new Error("La dirección del equipo no resuelve exclusivamente a la LAN privada");
  // Una resolución por petición; el socket usa esta misma respuesta validada.
  const ip = ips[0];
  return { url, lookup: (_host, opciones, callback) => {
    if (typeof opciones === "function") { callback = opciones; opciones = {}; }
    if (opciones?.all) callback(null, [{ address: ip.address, family: ip.family }]);
    else callback(null, ip.address, ip.family);
  } };
}

function cabecerasSinSalto(headers) {
  const excluir = new Set(HOP);
  for (const nombre of String(headers.connection || "").split(",")) excluir.add(nombre.trim().toLowerCase());
  const salida = {};
  for (const [k, v] of Object.entries(headers)) if (!excluir.has(k.toLowerCase()) && k.toLowerCase() !== "host") salida[k] = v;
  return salida;
}

function normalizarMiembros(lista, accesoQuorum = false) {
  if (!Array.isArray(lista) || !lista.length) throw new Error("El acceso LAN necesita miembros permitidos");
  const ids = new Set(), urls = new Set();
  return lista.map(m => {
    if (!m || typeof m.id !== "string" || !m.id || m.id.length > 128 || ids.has(m.id)) throw new Error("Miembros LAN inválidos o duplicados");
    const url = origenPermitido(m.url);
    if (urls.has(url) && !accesoQuorum) throw new Error("Dos miembros no pueden compartir la misma dirección");
    if (accesoQuorum && (!url.startsWith("https:") || !m.caPublica)) throw new Error("Falta el certificado de una PC del grupo");
    ids.add(m.id); urls.add(url);
    const salida = { id: m.id, nombre: typeof m.nombre === "string" ? m.nombre : m.id, url, preferido: m.preferido === true };
    if (m.caPublica !== undefined) {
      if (typeof m.caPublica !== "string" || m.caPublica.length > 16384) throw new Error("La autoridad HTTPS del miembro no es válida");
      const ca = new crypto.X509Certificate(m.caPublica);
      if (!ca.ca) throw new Error("El certificado HTTPS del miembro no es una autoridad pública");
      salida.caPublica = ca.toString();
    }
    return salida;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function guardarAtomico(archivo, datos) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true, mode: 0o700 });
  const temporal = `${archivo}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporal, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(datos));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporal, archivo);
    // Windows no permite fsync sobre un descriptor de directorio.
    if (process.platform !== "win32") {
      const dir = fs.openSync(path.dirname(archivo), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporal, { force: true });
  }
}

function cargarEstado(archivo, grupoId, accesoQuorum) {
  let datos;
  try { datos = JSON.parse(fs.readFileSync(archivo, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return { grupoId, termino: -1, escritor: null, indice: -1, sha256: null, revision_miembros: 0, miembros: null }; throw new Error("No se puede leer el estado persistente del acceso LAN"); }
  if (datos.grupoId !== grupoId || !Number.isSafeInteger(datos.termino) || datos.termino < 0 || !Number.isSafeInteger(datos.indice) || datos.indice < 0
    || !(datos.escritor === null || typeof datos.escritor === "string") || typeof datos.sha256 !== "string") throw new Error("El estado persistente del acceso LAN no es válido");
  datos.revision_miembros = datos.revision_miembros ?? 0;
  if (!Number.isSafeInteger(datos.revision_miembros) || datos.revision_miembros < 0) throw new Error("La revisión de miembros persistente no es válida");
  if (datos.miembros) datos.miembros = normalizarMiembros(datos.miembros, accesoQuorum);
  return datos;
}

function crearAccesoLan({ config, base = process.cwd(), archivoEstado = path.join(base, "datos", "acceso-lan.json"), resolver = dns.lookup,
  timeoutMs = 300000, timeoutEstadoMs = 2500, maxSolicitud = 300 * 1024 * 1024, maxRespuesta = 300 * 1024 * 1024, maxEstado = 2 * 1024 * 1024,
  verificarEstado, buscarEnRed = buscarAccesoLan, guardarEstado = guardarAtomico, log = () => {} } = {}) {
  if (!config || config.habilitado !== true || !config.grupoId || !config.clavePublicaTestigo || !Array.isArray(config.miembros)) throw new Error("Falta la configuración del acceso LAN y la clave pública fijada del testigo");
  const clave = crypto.createPublicKey(config.clavePublicaTestigo);
  if (clave.asymmetricKeyType !== "ed25519") throw new Error("La clave del testigo debe ser Ed25519");
  const accesoQuorum = config.accesoQuorum === true;
  const testigo = accesoQuorum ? null : origenPermitido(config.testigo?.url);
  let persistido = cargarEstado(archivoEstado, config.grupoId, accesoQuorum);
  let roster = persistido.miembros || normalizarMiembros(config.miembros, accesoQuorum);
  let miembros = new Map(roster.map(m => [m.id, m]));
  let errorDisco = false, consulta = null, rutaActual = null;
  const verificar = verificarEstado || ((sobre, opciones) => require("./protocolo-lan").verificarEstadoFirmado(sobre, opciones));

  function aceptarEstado(estado) {
    if (!Number.isSafeInteger(estado.termino) || estado.termino < persistido.termino || !Number.isSafeInteger(estado.ultimo?.indice)
      || estado.ultimo.indice < persistido.indice || typeof estado.ultimo.sha256 !== "string") throw new Error("El testigo devolvió un estado anterior al ya confirmado");
    const id = estado.escritor?.id || null;
    if (estado.termino === persistido.termino && persistido.escritor && id && id !== persistido.escritor) throw new Error("El término del testigo cambió de escritor sin avanzar");
    if (estado.ultimo.indice === persistido.indice && persistido.sha256 !== estado.ultimo.sha256) throw new Error("La copia confirmada del testigo no coincide");
    let candidato = roster, revision = persistido.revision_miembros;
    if (estado.miembros !== undefined) {
      if (!Number.isSafeInteger(estado.revision_miembros) || estado.revision_miembros < 1 || estado.revision_miembros < revision) throw new Error("La revisión de miembros del testigo retrocedió");
      candidato = normalizarMiembros(estado.miembros, accesoQuorum);
      if (revision === estado.revision_miembros && JSON.stringify(candidato) !== JSON.stringify(roster)) throw new Error("La lista de miembros cambió sin una nueva revisión");
      revision = estado.revision_miembros;
    }
    const permitidos = new Map(candidato.map(m => [m.id, m]));
    if (id && (!permitidos.has(id) || origenPermitido(estado.escritor.url) !== permitidos.get(id).url)) throw new Error("El escritor no pertenece a los miembros permitidos");
    const siguiente = { grupoId: config.grupoId, termino: estado.termino,
      escritor: id || (estado.termino === persistido.termino ? persistido.escritor : null), indice: estado.ultimo.indice, sha256: estado.ultimo.sha256,
      revision_miembros: revision, miembros: candidato };
    if (JSON.stringify(siguiente) !== JSON.stringify(persistido)) {
      try { guardarEstado(archivoEstado, siguiente); persistido = siguiente; }
      catch (e) { errorDisco = true; log("No se pudo persistir la autoridad del acceso LAN"); throw e; }
    }
    roster = candidato; miembros = permitidos;
    if (!id) throw new Error("No hay un servidor acreditado por el testigo");
    return miembros.get(id);
  }

  async function pedirEstado(url, ruta, ca) {
    const destino = await destinoPrivado(url, resolver);
    return new Promise((resolve, reject) => {
      const pedir = destino.url.protocol === "https:" ? https.request : http.request;
      const req = pedir(new URL(ruta, url), { method: "GET", lookup: destino.lookup, agent: false, ca, headers: { Accept: "application/json" } }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error("El testigo no está disponible")); return; }
        const partes = []; let bytes = 0;
        res.on("data", b => { bytes += b.length; if (bytes > maxEstado) { res.destroy(); reject(new Error("Estado del testigo demasiado grande")); } else partes.push(b); });
        res.on("error", reject);
        res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(partes).toString("utf8"))); } catch (e) { reject(e); } });
      });
      const timer = setTimeout(() => req.destroy(new Error("El testigo no respondió a tiempo")), timeoutEstadoMs);
      req.once("close", () => clearTimeout(timer)); req.on("error", reject); req.end();
    });
  }

  async function descubrir() {
    if (errorDisco) throw new Error("El acceso LAN requiere reparar su estado en disco");
    if (rutaActual?.vence > performance.now()) return rutaActual.miembro;
    if (consulta) return consulta;
    consulta = (async () => {
      const desafio = crypto.randomBytes(24).toString("hex"), inicio = performance.now();
      const opciones = { clavePublica: config.clavePublicaTestigo, grupoId: config.grupoId, desafio };
      const ruta = `/lan/${accesoQuorum ? "quorum" : "testigo"}/estado?desafio=${desafio}`;
      const pedir = async (url, ca) => {
        const estado = verificar(await pedirEstado(url, ruta, ca), opciones);
        if (accesoQuorum && (!estado.escritor || estado.termino < persistido.termino || estado.ultimo?.indice < persistido.indice)) {
          throw new Error("La PC todavía no acredita al servidor actual");
        }
        return estado;
      };
      if (!accesoQuorum) return aceptarEstado(await pedir(testigo));
      const porLan = async () => {
        const mapa = await buscarEnRed({ grupoId: config.grupoId, clavePublica: clave });
        const estado = await Promise.any([...mapa.values()].map(u => pedir(`http://${u.ip}:${u.http}`)));
        return { estado, ubicacion: { equipo: id => mapa.get(id) } };
      };
      const { estado, ubicacion } = await Promise.any([porLan(), ...roster.map(async m => ({ estado: await pedir(m.url, m.caPublica) }))]);
      const restante = estado.vence_ms - estado.emitido_ms - (performance.now() - inicio);
      if (restante <= 0) throw new Error("Venció la autorización del servidor");
      const miembro = aceptarEstado(estado);
      const destino = conectarMiembro(miembro, ubicacion);
      const remoto = { ...miembro, url: destino.url, servername: destino.servername };
      rutaActual = { miembro: remoto, vence: performance.now() + Math.min(900, restante) };
      return remoto;
    })().finally(() => { consulta = null; });
    return consulta;
  }

  function responder(res, status, mensaje, codigo) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify({ mensaje, codigo }));
  }

  function esPortada(req) {
    return accesoQuorum && req.method === "GET" && req.url === "/" && /\btext\/html\b/.test(req.headers.accept || "");
  }

  function esperando(res) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end('<!doctype html><html lang="es"><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Sistema del Camping</title><p role="status">Buscando el servidor del camping en la red local…</p></html>');
  }

  async function reenviar(req, res, intento = 0) {
    let origen, destino, miembro;
    try { miembro = await descubrir(); origen = miembro.url; destino = await destinoPrivado(origen, resolver); }
    catch (_e) {
      if (esPortada(req)) esperando(res);
      else responder(res, 503, "Esperando al servidor del predio. Revisá que las PCs de respaldo estén conectadas.", "ESCRITOR_NO_DISPONIBLE");
      return;
    }
    if (req.destroyed || res.destroyed) return;
    const seguro = req.method === "GET" || req.method === "HEAD";
    const headers = cabecerasSinSalto(req.headers);
    delete headers["forwarded"]; delete headers["x-forwarded-host"]; delete headers["x-forwarded-proto"]; delete headers["x-forwarded-for"];
    const pedir = destino.url.protocol === "https:" ? https.request : http.request;
    let fallo = false, recibidos = 0;
    const upstream = pedir(new URL(req.url, origen), { method: req.method, headers, lookup: destino.lookup, agent: false,
      ...(destino.url.protocol === "https:" ? { ca: miembro.caPublica || undefined, servername: miembro.servername, rejectUnauthorized: true } : {}) }, respuesta => {
      if (respuesta.statusCode === 503 && esPortada(req)) {
        rutaActual = null;
        respuesta.resume();
        return esperando(res);
      }
      const salida = cabecerasSinSalto(respuesta.headers);
      if (salida.location) {
        let redireccion;
        try { redireccion = new URL(salida.location, origen); } catch (_e) { respuesta.destroy(); fallar(); return; }
        if (redireccion.origin !== origen) { respuesta.destroy(); fallar(); return; }
        salida.location = redireccion.pathname + redireccion.search + redireccion.hash;
      }
      const longitud = Number(salida["content-length"] || 0);
      if (longitud > maxRespuesta) { respuesta.destroy(); fallar(); return; }
      res.writeHead(respuesta.statusCode, salida);
      respuesta.on("data", b => { recibidos += b.length; if (recibidos > maxRespuesta) { respuesta.destroy(); res.destroy(); } });
      respuesta.on("error", () => { if (!res.destroyed) res.destroy(); });
      respuesta.pipe(res);
    });
    const timer = setTimeout(() => upstream.destroy(new Error("El servidor no respondió a tiempo")), timeoutMs);
    upstream.once("close", () => clearTimeout(timer));
    function fallar() {
      if (fallo || res.destroyed) return;
      fallo = true;
      rutaActual = null;
      if (seguro && intento === 0 && !res.headersSent) { reenviar(req, res, 1).catch(() => responder(res, 502, "El servidor no respondió.", "SERVIDOR_NO_DISPONIBLE")); return; }
      responder(res, 502, seguro ? "El servidor no respondió. Volvé a intentar." : "No se pudo confirmar el resultado. Revisá la operación antes de volver a enviarla.", seguro ? "SERVIDOR_NO_DISPONIBLE" : "RESULTADO_INCIERTO");
    }
    upstream.on("error", fallar);
    res.once("close", () => { if (!res.writableEnded) upstream.destroy(); });
    req.once("aborted", () => upstream.destroy());
    if (seguro) { upstream.end(); return; }
    let enviados = 0;
    const limitar = new Transform({ transform(b, _encoding, callback) {
      enviados += b.length;
      callback(enviados > maxSolicitud ? new Error("Solicitud demasiado grande") : null, enviados > maxSolicitud ? undefined : b);
    } });
    limitar.on("error", () => { upstream.destroy(); responder(res, 413, "La solicitud supera el tamaño permitido.", "SOLICITUD_DEMASIADO_GRANDE"); });
    req.on("error", () => upstream.destroy());
    req.pipe(limitar).pipe(upstream);
  }

  const servidor = http.createServer((req, res) => {
    const ip = req.socket.remoteAddress;
    const host = req.headers.host;
    const puerto = servidor.address()?.port;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip) || ![`127.0.0.1:${puerto}`, `localhost:${puerto}`].includes(host)) { responder(res, 403, "Este acceso sólo funciona en esta PC.", "SOLO_LOCAL"); return; }
    if ((req.headers.origin && ![`http://127.0.0.1:${puerto}`, `http://localhost:${puerto}`].includes(req.headers.origin)) || req.headers["sec-fetch-site"] === "cross-site") { responder(res, 403, "Origen no permitido.", "ORIGEN_NO_PERMITIDO"); return; }
    if (!METODOS.has(req.method) || typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//") || /[\\\x00-\x20]/.test(req.url)) { responder(res, 400, "Solicitud no permitida.", "SOLICITUD_INVALIDA"); return; }
    const largo = Number(req.headers["content-length"] || 0);
    if (largo > maxSolicitud) { responder(res, 413, "La solicitud supera el tamaño permitido.", "SOLICITUD_DEMASIADO_GRANDE"); return; }
    if (["GET", "HEAD"].includes(req.method) && (largo > 0 || req.headers["transfer-encoding"])) { responder(res, 400, "Las consultas no admiten cuerpo.", "SOLICITUD_INVALIDA"); return; }
    reenviar(req, res).catch(() => responder(res, 502, "El servidor no respondió.", "SERVIDOR_NO_DISPONIBLE"));
  });
  servidor.headersTimeout = 10000; servidor.requestTimeout = timeoutMs + timeoutEstadoMs + 1000; servidor.keepAliveTimeout = 5000;
  servidor.on("upgrade", (_req, socket) => socket.destroy());
  servidor.on("connect", (_req, socket) => socket.destroy());
  return {
    servidor,
    async escuchar(puerto = 8091) {
      await new Promise((resolve, reject) => { servidor.once("error", reject); servidor.listen(puerto, "127.0.0.1", () => { servidor.removeListener("error", reject); resolve(); }); });
      return `http://127.0.0.1:${servidor.address().port}`;
    },
    cerrar: () => new Promise(resolve => { servidor.close(resolve); servidor.closeAllConnections(); }),
    estado: () => ({ ...persistido, error_disco: errorDisco }),
  };
}

if (require.main === module) {
  try {
    const i = process.argv.indexOf("--base");
    const base = path.resolve(i >= 0 ? process.argv[i + 1] : process.cwd());
    const config = JSON.parse(fs.readFileSync(path.join(base, "predio-ha.json"), "utf8").replace(/^\uFEFF/, ""));
    if (config.equipoId !== require("./control-equipo").identidadEquipo()) throw new Error("Esta configuración de acceso está vinculada a otra PC");
    // El proceso de acceso no necesita conservar secretos del testigo cuando
    // ambos componentes comparten la misma instalación protegida de Windows.
    const publica = { habilitado: config.habilitado, grupoId: config.grupoId, accesoQuorum: config.accesoQuorum, clavePublicaTestigo: config.clavePublicaTestigo,
      testigo: { url: config.testigo?.url }, miembros: (config.miembros || []).map(m => ({ id: m.id, nombre: m.nombre, url: m.url, preferido: m.preferido, ...(m.caPublica ? { caPublica: m.caPublica } : {}) })) };
    const acceso = crearAccesoLan({ config: publica, base, log: console.log });
    acceso.escuchar().then(url => console.log(`Acceso local del predio: ${url}`)).catch(e => { console.error(e.message); process.exitCode = 1; });
    process.on("SIGTERM", () => acceso.cerrar().then(() => process.exit(0)));
    process.on("SIGINT", () => acceso.cerrar().then(() => process.exit(0)));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { crearAccesoLan, origenPermitido, privada, cabecerasSinSalto };
