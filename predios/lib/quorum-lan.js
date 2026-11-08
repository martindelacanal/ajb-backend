"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isIPv4 } = require("node:net");
const { spawn } = require("node:child_process");
const H = require("./http-lan");
const { crearVerificador, verificarAckReplica, verificarEstadoFirmado } = require("./protocolo-lan");
const { protegerCarpetaTestigo } = require("./testigo-lan");

const USO_MS = 5000;
const revisionValida = r => Number.isSafeInteger(r?.indice) && r.indice >= 0 && /^[a-f0-9]{64}$/.test(r.sha256);
const misma = (a, b) => a?.indice === b?.indice && a?.sha256 === b?.sha256;
const publico = ({ id, nombre, url, caPublica, preferido }) => ({ id, nombre, url, caPublica, preferido });
const error = (mensaje, status = 503) => Object.assign(new Error(mensaje), { status });
const RUTA_ALTA = "/api/sistema/grupo-local/incorporar-equipo";

function acreditarOrigen(ip, c) {
  const datos = Buffer.from(JSON.stringify({ ip, nodo: c.nodoId, fecha: Date.now() })).toString("base64url");
  return `${datos}.${crypto.createHmac("sha256", c.claveDatos).update(datos).digest("hex")}`;
}

function origenAcreditado(cabecera, c, miembros, ipPar) {
  const [datos, firma] = String(cabecera || "").split(".");
  if (!datos || datos.length > 256 || !/^[a-f0-9]{64}$/.test(firma || "")) return null;
  const esperada = crypto.createHmac("sha256", c.claveDatos).update(datos).digest();
  if (!crypto.timingSafeEqual(esperada, Buffer.from(firma, "hex"))) return null;
  try {
    const { ip, nodo, fecha } = JSON.parse(Buffer.from(datos, "base64url"));
    const miembro = miembros.find(m => m.id === nodo);
    if (miembro && new URL(miembro.url).hostname === ipPar && Number.isSafeInteger(fecha) && Math.abs(Date.now() - fecha) < 15000 && isIPv4(ip)) return ip;
  } catch (_e) { /* origen no verificable */ }
  return null;
}

function iniciarConsenso({ base, dirApp, config, log }) {
  const q = config.quorum;
  const ejecutable = path.join(dirApp, "windows", "ajb-quorum.exe");
  if (!fs.existsSync(ejecutable)) throw error("La versión instalada no incluye el coordinador del grupo de PCs");
  const carpeta = path.join(base, "ha", "quorum");
  protegerCarpetaTestigo(carpeta);
  const localKey = crypto.randomBytes(32).toString("hex");
  const proceso = spawn(ejecutable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let cerrado = false;
  const url = new Promise((resolve, reject) => {
    let salida = "";
    proceso.stdout.on("data", b => {
      salida += b;
      if (salida.includes("\n")) {
        const direccion = salida.trim();
        if (/^127\.0\.0\.1:\d{1,5}$/.test(direccion)) resolve("http://" + direccion);
        else reject(error("El coordinador devolvió una dirección inválida"));
      }
    });
    proceso.once("error", reject);
    proceso.once("exit", () => { cerrado = true; reject(error("El coordinador del grupo se detuvo")); });
  });
  // Startup can fail before the first election poll has attached a waiter.
  url.catch(e => log(e.message));
  proceso.stdin.on("error", e => log("Coordinación LAN: " + e.message));
  proceso.stderr.on("data", b => log("Coordinación LAN: " + String(b).trim()));
  proceso.stdin.write(JSON.stringify({ id: config.nodoId, listen: `0.0.0.0:${q.puerto}`, advertise: q.direccion,
    directory: carpeta, secret: q.secreto, localKey, bootstrap: q.bootstrap }) + "\n");

  return {
    async pedir(ruta, cuerpo) {
      if (cerrado) throw error("El coordinador del grupo se detuvo");
      const destino = await url;
      const r = await fetch(destino + ruta, { method: cuerpo ? "POST" : "GET", signal: AbortSignal.timeout(4500),
        headers: { Authorization: "Bearer " + localKey, "Content-Type": "application/json" }, body: cuerpo && JSON.stringify(cuerpo) });
      if (!r.ok) throw error(r.status === 409 ? "Cambió la configuración del grupo" : "Esta PC espera a la mayoría del grupo", r.status);
      return r.json();
    },
    detener() { if (!cerrado) proceso.stdin.end(); },
  };
}

function crearAutoridadQuorum({ config, consenso, ahora = Date.now }) {
  const llave = crypto.createPrivateKey(config.quorum.clavePrivada);
  if (llave.asymmetricKeyType !== "ed25519" || crypto.createPublicKey(llave).export({ type: "spki", format: "pem" }) !== config.clavePublicaTestigo) {
    throw error("La firma del grupo no coincide con su configuración");
  }
  let cola = Promise.resolve();
  let registro = null;
  let terminoVisto = null, observadoDesde = 0;
  const verificar = crearVerificador({ grupoId: config.grupoId, miembros: () => registro.miembros, ahora });
  function exclusivo(fn) {
    const r = cola.then(fn);
    cola = r.catch(() => {});
    return r;
  }
  async function guardar(lectura, datos) {
    const r = await consenso.pedir("/state", { expected: lectura.register.version, term: lectura.term, configuration: lectura.configuration, data: datos });
    lectura.register = r;
    registro = r.data;
  }
  async function leer() {
    const lectura = await consenso.pedir("/state");
    if (lectura.leader !== config.nodoId) throw error("Esta PC espera al servidor elegido por el grupo");
    if (terminoVisto !== lectura.term) {
      terminoVisto = lectura.term;
      observadoDesde = performance.now();
    }
    registro = lectura.register.data;
    if (!registro && config.quorum.inicial) await guardar(lectura, config.quorum.inicial);
    if (!registro || registro.grupoId !== config.grupoId || !revisionValida(registro.ultimo)) throw error("El grupo espera su copia inicial");
    return lectura;
  }
  function escritor(lectura) {
    return registro.termino === lectura.term ? registro.miembros.find(m => m.id === lectura.leader) : null;
  }
  function respuesta(lectura, autorizado = false) {
    const actual = escritor(lectura);
    return { autorizado, termino: lectura.term, escritor: actual?.id || null, ultimo: registro.ultimo,
      vence_en_ms: actual ? USO_MS : 0, uso_maximo_ms: USO_MS, preferido_id: registro.preferidoId, degradado: false };
  }
  function estadoFirmado(lectura, desafio, compacto) {
    const actual = escritor(lectura), fecha = ahora();
    const estado = { tipo: "AJB_TESTIGO_ESTADO", formato: 1, grupo_id: config.grupoId, termino: lectura.term,
      escritor: actual ? { id: actual.id, nombre: actual.nombre, url: actual.url } : null,
      ultimo: registro.ultimo, ultimo_commit: registro.ultimoCommit || null, preferido_id: registro.preferidoId,
      revision_miembros: Math.max(lectura.configuration, lectura.register.version), degradado: false, emitido_ms: fecha, vence_ms: fecha + USO_MS, desafio,
      ...(compacto ? { compacto: true, miembro_autorizado: !!actual } : { candidato: lectura.leader, miembros: registro.miembros.map(publico) }) };
    return { estado, firma: crypto.sign(null, Buffer.from(JSON.stringify(estado)), llave).toString("base64"), clave_publica: config.clavePublicaTestigo };
  }
  async function operar(lectura, accion, cuerpo, actor) {
    const { nodoId, termino, revision } = cuerpo;
    if (nodoId !== actor.nodoId) throw error("El permiso no corresponde a este equipo", 403);
    if (accion === "solicitar") {
      if (nodoId !== lectura.leader || !misma(registro.ultimo, revision)) return respuesta(lectura);
      if (!escritor(lectura)) {
        // El término anterior pudo entregar un permiso justo antes de perder
        // la mayoría. Esperar su duración antes de aceptar escrituras nuevas.
        if (registro.termino > 0 && performance.now() - observadoDesde < USO_MS) return respuesta(lectura);
        await guardar(lectura, { ...registro, termino: lectura.term });
      }
      return respuesta(lectura, true);
    }
    if (nodoId !== escritor(lectura)?.id || termino !== lectura.term) throw error("La mayoría eligió otro servidor");
    if (accion === "renovar" && misma(registro.ultimo, revision)) return respuesta(lectura, true);
    if (accion === "confirmar") {
      const siguiente = { indice: cuerpo.indice, sha256: cuerpo.sha256 };
      if (misma(registro.ultimo, siguiente)) return { ...respuesta(lectura, true), confirmado: true };
      if (!revisionValida(siguiente) || siguiente.indice !== registro.ultimo.indice + 1 || !Array.isArray(cuerpo.replicas)) throw error("La operación no sigue a la última revisión confirmada");
      const votos = new Set(lectura.members.filter(m => m.Suffrage === 0).map(m => m.ID));
      const copias = new Set(cuerpo.replicas.map(acuse => verificarAckReplica(acuse, { grupoId: config.grupoId, escritorId: nodoId,
        termino, indice: siguiente.indice, sha256: siguiente.sha256, miembros: registro.miembros })));
      if (!votos.has(nodoId) || 1 + [...copias].filter(id => votos.has(id)).length <= votos.size / 2) {
        throw error("Falta guardar esta operación en una mayoría de las PCs del grupo");
      }
      await guardar(lectura, { ...registro, ultimo: siguiente, ultimoCommit: { ...siguiente, replicas: [...copias] } });
      return { ...respuesta(lectura, true), confirmado: true };
    }
    throw error("La operación no corresponde a un permiso vigente", 409);
  }
  function cambiarMembresia(lectura, miembro, voter) {
    return consenso.pedir("/member", { id: miembro.id, address: `${new URL(miembro.url).hostname}:${config.quorum.puerto}`, voter,
      expected: lectura.register.version, term: lectura.term, configuration: lectura.configuration });
  }
  return {
    miembros() { return exclusivo(async () => (await leer()).members); },
    prepararMiembro(miembro) { return exclusivo(async () => {
      const lectura = await leer();
      if (!registro.miembros.some(m => m.id === miembro.id)) await guardar(lectura, { ...registro, miembros: [...registro.miembros, miembro] });
      return { ultimo: registro.ultimo, version: lectura.register.version };
    }); },
    unirMiembro(miembro, revision, versionRemota) { return exclusivo(async () => {
      const lectura = await leer();
      if (!misma(registro.ultimo, revision)) throw error("La copia del equipo cambió mientras se incorporaba");
      const actual = lectura.members.find(m => m.ID === miembro.id);
      if (!actual) await cambiarMembresia(lectura, miembro, false);
      else if (actual.Suffrage !== 0 && versionRemota === lectura.register.version) await cambiarMembresia(lectura, miembro, true);
    }); },
    manejar(req, res) {
      return exclusivo(async () => {
        const u = new URL(req.url, "http://local");
        const accion = u.pathname.slice("/lan/quorum/".length);
        if (req.method === "GET" && accion === "estado") {
          const desafio = u.searchParams.get("desafio");
          if (!/^[a-f0-9]{32,128}$/.test(desafio || "")) throw error("La consulta necesita un desafío nuevo", 400);
          return H.respuesta(res, 200, estadoFirmado(await leer(), desafio, u.searchParams.get("compacto") === "1"));
        }
        if (req.method !== "POST" || !["solicitar", "renovar", "confirmar"].includes(accion)) throw error("No encontramos esa operación", 404);
        const buffer = await H.leer(req, 128 * 1024), lectura = await leer();
        const actor = verificar({ metodo: req.method, ruta: req.url, cuerpo: buffer, cabeceras: req.headers });
        return H.respuesta(res, 200, await operar(lectura, accion, JSON.parse(buffer), actor));
      });
    },
  };
}

function clienteQuorum(c) {
  let miembros = c.miembros;
  async function estado({ compacto = false } = {}) {
    const desafio = crypto.randomBytes(20).toString("hex"), inicio = performance.now();
    const ruta = `/lan/quorum/estado?desafio=${desafio}${compacto ? "&compacto=1" : ""}`;
    const { sobre, e } = await Promise.any(miembros.map(async m => {
      const sobre = await H.pedir(m.url, ruta, { metodo: "GET", ca: m.caPublica, timeout: 4000 });
      return { sobre, e: verificarEstadoFirmado(sobre, { clavePublica: c.clavePublicaTestigo, grupoId: c.grupoId, desafio }) };
    })).catch(() => { throw error("Esperando una mayoría de PCs conectadas en el camping"); });
    const tardanza = performance.now() - inicio;
    if (tardanza >= USO_MS) throw error("La respuesta de la mayoría llegó tarde");
    if (e.miembros) miembros = e.miembros;
    return { ...e, escritor: e.escritor?.id || null, escritorDatos: e.escritor, vence_en_ms: Math.max(0, e.vence_ms - e.emitido_ms - tardanza), sobre };
  }
  return {
    estado,
    pedir(accion, cuerpo) {
      // El escritor siempre coincide con el líder de consenso. Sólo ese equipo
      // puede adquirir el permiso; un seguidor no envía mutaciones a otra PC.
      const yo = miembros.find(m => m.id === c.nodoId);
      return H.pedir(yo.url, `/lan/quorum/${accion}`, { grupoId: c.grupoId, nodoId: c.nodoId, clave: c.clave,
        cuerpo, ca: yo.caPublica, timeout: 4000 });
    },
  };
}

module.exports = { iniciarConsenso, crearAutoridadQuorum, clienteQuorum, RUTA_ALTA, acreditarOrigen, origenAcreditado };
