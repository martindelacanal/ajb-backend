"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isIPv4 } = require("node:net");
const { spawn, execFile } = require("node:child_process");
const H = require("./http-lan");
const { crearVerificador, verificarAckReplica, verificarEstadoFirmado } = require("./protocolo-lan");
const { protegerCarpetaTestigo } = require("./testigo-lan");
const { conectarMiembro } = require("./ubicacion-lan");

const USO_MS = 5000;
const revisionValida = r => Number.isSafeInteger(r?.indice) && r.indice >= 0 && /^[a-f0-9]{64}$/.test(r.sha256);
const misma = (a, b) => a?.indice === b?.indice && a?.sha256 === b?.sha256;
const publico = ({ id, nombre, url, caPublica, preferido }) => ({ id, nombre, url, caPublica, preferido });
const error = (mensaje, status = 503) => Object.assign(new Error(mensaje), { status });
const RUTA_ALTA = "/api/sistema/grupo-local/incorporar-equipo";
const direccionRaft = (id, puerto) => `${id.slice(0, 32)}.${id.slice(32)}.raft.predio.ajb:${puerto}`;

async function prepararRedQuorum(dirApp, puerto) {
  if (process.platform !== "win32") return;
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) throw error("Puerto de coordinación LAN inválido");
  await new Promise((resolve, reject) => execFile("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(dirApp, "windows", "configurar-coordinacion-lan.ps1"), "-Puerto", String(puerto)],
    { windowsHide: true, timeout: 20000 }, (e, _salida, errores) => {
      if (e) reject(new Error(String(errores || e.message).trim().slice(0, 240)));
      else resolve();
    }));
}

function acreditarOrigen(ip, c) {
  const datos = Buffer.from(JSON.stringify({ ip, nodo: c.nodoId, fecha: Date.now() })).toString("base64url");
  return `${datos}.${crypto.createHmac("sha256", c.claveDatos).update(datos).digest("hex")}`;
}

function origenAcreditado(cabecera, c, miembros, ipPar, ubicacion) {
  const [datos, firma] = String(cabecera || "").split(".");
  if (!datos || datos.length > 256 || !/^[a-f0-9]{64}$/.test(firma || "")) return null;
  const esperada = crypto.createHmac("sha256", c.claveDatos).update(datos).digest();
  if (!crypto.timingSafeEqual(esperada, Buffer.from(firma, "hex"))) return null;
  try {
    const { ip, nodo, fecha } = JSON.parse(Buffer.from(datos, "base64url"));
    const miembro = miembros.find(m => m.id === nodo);
    if (miembro && new URL(conectarMiembro(miembro, ubicacion).url).hostname === ipPar && Number.isSafeInteger(fecha) && Math.abs(Date.now() - fecha) < 15000 && isIPv4(ip)) return ip;
  } catch (_e) { /* origen no verificable */ }
  return null;
}

function iniciarConsenso({ base, dirApp, config, log, ubicacion, crearProceso = spawn,
  intervaloVigilancia = 5000, esperaVigilancia = 4500 }) {
  const q = config.quorum;
  const ejecutable = path.join(dirApp, "windows", "ajb-quorum.exe");
  if (!fs.existsSync(ejecutable)) throw error("La versión instalada no incluye el coordinador del grupo de PCs");
  const carpeta = path.join(base, "ha", "quorum");
  protegerCarpetaTestigo(carpeta);
  let sesion, reinicio, detenido = false, fallos = 0;
  const disponible = actual => !detenido && sesion === actual && !actual.cerrado && !actual.recuperando;
  function cancelarVigilancia(actual) {
    clearTimeout(actual.vigilancia);
    actual.comprobacion?.abort();
  }
  function programarVigilancia(actual) {
    if (!disponible(actual)) return;
    actual.vigilancia = setTimeout(() => vigilar(actual), intervaloVigilancia);
    actual.vigilancia.unref?.();
  }
  async function vigilar(actual) {
    if (!disponible(actual)) return;
    const comprobacion = actual.comprobacion = new AbortController();
    const limite = setTimeout(() => comprobacion.abort(), esperaVigilancia);
    limite.unref?.();
    try {
      // /local no espera una mayoría ni toma el candado de las operaciones Raft.
      // Cualquier respuesta HTTP completa acredita que el proceso sigue vivo;
      // los 409/503 de las operaciones normales nunca provocan un reinicio.
      const respuesta = await fetch(actual.direccion + "/local", {
        signal: comprobacion.signal, headers: { Authorization: "Bearer " + actual.localKey },
      });
      await respuesta.arrayBuffer();
      actual.fallosVigilancia = 0;
    } catch (_e) {
      if (!disponible(actual)) return;
      if (++actual.fallosVigilancia >= 3) {
        actual.recuperando = true;
        log("El coordinador LAN dejó de responder; se reiniciará conservando su registro");
        // close es el único que habilita otro proceso: nunca abrir dos diarios.
        try {
          if (!actual.proceso.kill()) actual.recuperando = false;
        } catch (e) {
          actual.recuperando = false;
          log("No se pudo detener el coordinador LAN: " + e.message);
        }
      }
    } finally {
      clearTimeout(limite);
      if (actual.comprobacion === comprobacion) actual.comprobacion = null;
      programarVigilancia(actual);
    }
  }
  function arrancar() {
    if (detenido) return;
    const proceso = crearProceso(ejecutable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const actual = sesion = { proceso, localKey: crypto.randomBytes(32).toString("hex"), cerrado: false,
      inicio: performance.now(), publicadas: "{}", fallosVigilancia: 0, recuperando: false };
    actual.url = new Promise((resolve, reject) => {
      let salida = "";
      actual.limite = setTimeout(() => {
        reject(error("El coordinador no terminó de arrancar; se volverá a iniciar"));
        proceso.kill();
      }, 10000);
      actual.limite.unref?.();
      proceso.stdout.on("data", b => {
        if (actual.direccion) return;
        salida += b;
        if (salida.includes("\n")) {
          clearTimeout(actual.limite);
          const direccion = salida.trim();
          if (/^127\.0\.0\.1:\d{1,5}$/.test(direccion)) {
            actual.direccion = "http://" + direccion;
            resolve(actual.direccion);
            programarVigilancia(actual);
          }
          else { reject(error("El coordinador devolvió una dirección inválida")); proceso.kill(); }
        }
      });
      proceso.once("error", reject);
      // Esperar close asegura que el proceso anterior liberó su puerto y diario.
      proceso.once("close", () => {
        actual.cerrado = true;
        clearTimeout(actual.limite);
        cancelarVigilancia(actual);
        reject(error("El coordinador del grupo se detuvo"));
        if (detenido || sesion !== actual) return;
        if (performance.now() - actual.inicio >= 30000) fallos = 0;
        const demora = Math.min(10000, 1000 * 2 ** Math.min(fallos++, 4));
        log("El coordinador LAN se detuvo; se recuperará automáticamente");
        reinicio = setTimeout(arrancar, demora);
        reinicio.unref?.();
      });
    });
    // Un fallo de arranque puede ocurrir antes del primer sondeo.
    actual.url.catch(e => { if (!detenido) log(e.message); });
    proceso.stdin.on("error", e => { if (!detenido) log("Coordinación LAN: " + e.message); });
    proceso.stderr.on("data", b => log("Coordinación LAN: " + String(b).trim()));
    proceso.stdin.write(JSON.stringify({ id: config.nodoId, listen: `0.0.0.0:${q.puerto}`, advertise: q.direccion,
      directory: carpeta, secret: q.secreto, localKey: actual.localKey, bootstrap: q.bootstrap }) + "\n");
  }
  arrancar();

  async function pedir(ruta, cuerpo) {
    const actual = sesion;
    if (!disponible(actual)) throw error("El coordinador del grupo se está recuperando");
    const destino = await actual.url;
    if (!disponible(actual)) throw error("El coordinador del grupo se está recuperando");
    const r = await fetch(destino + ruta, { method: cuerpo ? "POST" : "GET", signal: AbortSignal.timeout(4500),
      headers: { Authorization: "Bearer " + actual.localKey, "Content-Type": "application/json" }, body: cuerpo && JSON.stringify(cuerpo) });
    if (!r.ok) throw error(r.status === 409 ? "Cambió la configuración del grupo" : "Esta PC espera a la mayoría del grupo", r.status);
    return r.json();
  }
  let enviando = false;
  async function publicar() {
    const actual = sesion;
    const direcciones = ubicacion.direccionesRaft();
    const serializadas = JSON.stringify(direcciones);
    if (detenido || actual.cerrado || enviando || serializadas === actual.publicadas) return;
    enviando = true;
    try { await pedir("/locations", direcciones); if (sesion === actual) actual.publicadas = serializadas; }
    catch (e) { if (!detenido && !actual.cerrado) log("Ubicación del grupo: " + e.message); }
    finally { enviando = false; }
  }
  const timer = ubicacion ? setInterval(publicar, 1000) : null;
  timer?.unref();
  if (ubicacion) publicar();
  return { pedir, detener() {
    detenido = true;
    clearInterval(timer);
    clearTimeout(reinicio);
    clearTimeout(sesion.limite);
    cancelarVigilancia(sesion);
    if (!sesion.cerrado) sesion.proceso.stdin.end();
  } };
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
      ...(compacto ? { compacto: true, miembro_autorizado: !!actual } : {
        candidato: lectura.leader, miembros: registro.miembros.map(publico), retirados: registro.retirados || [],
        votantes: lectura.members.filter(m => m.Suffrage === 0).map(m => m.ID),
        solo_principal: Boolean(registro.soloPrincipal),
        regreso_automatico: Boolean(registro.soloPrincipal && registro.arranquesSoloPrincipal),
      }) };
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
    return consenso.pedir("/member", { id: miembro.id, address: direccionRaft(miembro.id, config.quorum.puerto), voter,
      expected: lectura.register.version, term: lectura.term, configuration: lectura.configuration });
  }
  function revisarRetiro(lectura, id) {
    if (registro.soloPrincipal) throw error("Reactivá los respaldos antes de cambiar el grupo", 409);
    if (!/^[a-f0-9]{64}$/.test(id) || id === registro.preferidoId || id === lectura.leader) {
      throw error("La PC de origen y la PC en servicio deben permanecer en el grupo", 409);
    }
    const objetivo = lectura.members.find(m => m.ID === id);
    const votantes = lectura.members.filter(m => m.Suffrage === 0 && m.ID !== id);
    if (objetivo?.Suffrage === 0 && votantes.length < 3) {
      throw error("Incorporá otro respaldo y esperá a que esté listo antes de quitar esta PC. El grupo automático necesita al menos tres votantes.", 409);
    }
    return { objetivo, votantes };
  }
  function verificarPrincipal(lectura) {
    if (escritor(lectura)?.id !== registro.preferidoId || config.nodoId !== registro.preferidoId) {
      throw error("Esperá a que la notebook principal esté en servicio y tenga la última copia", 409);
    }
  }
  return {
    miembrosParaIncorporar() { return exclusivo(async () => {
      const lectura = await leer();
      return registro.soloPrincipal ? null : lectura.members;
    }); },
    prepararModoPrincipal() { return exclusivo(async () => {
      const lectura = await leer();
      verificarPrincipal(lectura);
      const respaldos = lectura.members.filter(m => m.Suffrage === 0 && m.ID !== config.nodoId).map(m => m.ID);
      if (registro.soloPrincipal && !respaldos.length && !registro.arranquesSoloPrincipal) return null;
      if (!registro.soloPrincipal && respaldos.length < 2) throw error("La mayoría todavía no está lista para preparar el apagado", 409);
      // Un modo anterior con regreso automático puede fijarse sin volver a
      // encender los respaldos: ya no tienen voto en la configuración vigente.
      return { version: lectura.register.version, miembros: registro.miembros.filter(m => respaldos.includes(m.id)) };
    }); },
    dejarSoloPrincipal(version) { return exclusivo(async () => {
      let lectura = await leer();
      verificarPrincipal(lectura);
      if (lectura.register.version !== version) throw error("Cambió el grupo. Volvé a intentar el cambio", 409);
      const respaldos = lectura.members.filter(m => m.Suffrage === 0 && m.ID !== config.nodoId).map(m => m.ID);
      // Guardar la intención primero. Si se corta la operación, el coordinador
      // no vuelve a promover por su cuenta a un equipo ya apartado.
      if (!registro.soloPrincipal || registro.arranquesSoloPrincipal) {
        const previstos = registro.soloPrincipal || respaldos;
        if (previstos.length < 2) throw error("La mayoría todavía no está lista para preparar el apagado", 409);
        const permanente = { ...registro, soloPrincipal: previstos };
        // La ausencia también impide el regreso automático en versiones previas.
        // Sólo una reactivación manual con las copias al día devuelve los votos.
        delete permanente.arranquesSoloPrincipal;
        await guardar(lectura, permanente);
      }
      for (const id of respaldos) {
        await consenso.pedir("/member", { id, demote: true, expected: lectura.register.version, term: lectura.term, configuration: lectura.configuration });
        lectura = await leer();
        verificarPrincipal(lectura);
      }
      if (lectura.members.some(m => m.Suffrage === 0 && m.ID !== config.nodoId)) throw error("Esperá la confirmación del grupo antes de apagar los respaldos");
      return { soloPrincipal: true };
    }); },
    prepararReactivacion() { return exclusivo(async () => {
      const lectura = await leer();
      verificarPrincipal(lectura);
      if (!registro.soloPrincipal) return null;
      return { ultimo: registro.ultimo, version: lectura.register.version, arranques: registro.arranquesSoloPrincipal,
        miembros: registro.miembros.filter(m => registro.soloPrincipal.includes(m.id)) };
    }); },
    reactivarRespaldos(rev, version, acuses) { return exclusivo(async () => {
      let lectura = await leer();
      verificarPrincipal(lectura);
      if (!registro.soloPrincipal) return { soloPrincipal: false };
      if (!misma(registro.ultimo, rev) || lectura.register.version !== version) throw error("Cambió la copia confirmada. Volvé a intentar la reactivación", 409);
      const listos = new Set(acuses.map(acuse => verificarAckReplica(acuse, { grupoId: config.grupoId, escritorId: config.nodoId,
        termino: lectura.term, ...registro.ultimo, miembros: registro.miembros })));
      if (!registro.soloPrincipal.every(id => listos.has(id))) throw error("Esperá a que los respaldos tengan la última copia", 409);
      for (const id of registro.soloPrincipal) {
        if (lectura.members.some(m => m.ID === id && m.Suffrage === 0)) continue;
        const miembro = registro.miembros.find(m => m.id === id);
        await cambiarMembresia(lectura, miembro, true);
        lectura = await leer();
        verificarPrincipal(lectura);
      }
      const restaurado = { ...registro };
      delete restaurado.soloPrincipal;
      delete restaurado.arranquesSoloPrincipal;
      await guardar(lectura, restaurado);
      return { soloPrincipal: false };
    }); },
    transferirAlPrincipal(id, rev, termino, acuse) { return exclusivo(async () => {
      const lectura = await leer();
      if (id !== registro.preferidoId || escritor(lectura)?.id !== config.nodoId ||
          termino !== lectura.term || !misma(registro.ultimo, rev)) {
        throw error("Cambió el servidor o la copia confirmada antes del retorno", 409);
      }
      const acreditado = verificarAckReplica(acuse, { grupoId: config.grupoId, escritorId: config.nodoId,
        termino, ...registro.ultimo, miembros: registro.miembros });
      if (acreditado !== id) throw error("La copia debe acreditarla la PC principal", 403);
      await consenso.pedir("/transfer", { id, expected: lectura.register.version, term: lectura.term, configuration: lectura.configuration });
    }); },
    revisarRetiro(id) { return exclusivo(async () => {
      const lectura = await leer();
      if (registro.retirados?.includes(id)) return null;
      const { objetivo, votantes } = revisarRetiro(lectura, id);
      return { ultimo: registro.ultimo, requiereCopias: objetivo?.Suffrage === 0, miembros: registro.miembros.filter(m => votantes.some(v => v.ID === m.id)) };
    }); },
    quitarMiembro(id, revision, acuses) { return exclusivo(async () => {
      let lectura = await leer();
      if (registro.retirados?.includes(id)) return;
      const { objetivo, votantes } = revisarRetiro(lectura, id);
      if (objetivo?.Suffrage === 0) {
        if (!misma(registro.ultimo, revision)) throw error("Cambió la copia que debe quedar en los respaldos");
        const restantes = new Set(votantes.map(m => m.ID));
        const copias = new Set(acuses.map(acuse => verificarAckReplica(acuse, { grupoId: config.grupoId, escritorId: lectura.leader,
          termino: lectura.term, ...revision, miembros: registro.miembros })));
        if (1 + [...copias].filter(nodo => restantes.has(nodo)).length <= restantes.size / 2) {
          throw error("Esperando que una mayoría de las PCs que quedan guarde la última copia");
        }
      }
      if (objetivo) {
        await consenso.pedir("/member", { id, remove: true, expected: lectura.register.version, term: lectura.term, configuration: lectura.configuration });
        lectura = await leer();
      }
      await guardar(lectura, { ...registro, miembros: registro.miembros.filter(m => m.id !== id), retirados: [...(registro.retirados || []), id] });
    }); },
    prepararMiembro(miembro) { return exclusivo(async () => {
      const lectura = await leer();
      if (registro.soloPrincipal) throw error("Reactivá los respaldos antes de cambiar el grupo", 409);
      if (registro.retirados?.includes(miembro.id)) throw error("Esta PC fue retirada del grupo", 409);
      if (!registro.miembros.some(m => m.id === miembro.id)) await guardar(lectura, { ...registro, miembros: [...registro.miembros, miembro] });
      return { ultimo: registro.ultimo, version: lectura.register.version };
    }); },
    unirMiembro(miembro, revision, versionRemota) { return exclusivo(async () => {
      const lectura = await leer();
      if (registro.soloPrincipal) throw error("Reactivá los respaldos antes de cambiar el grupo", 409);
      if (registro.retirados?.includes(miembro.id)) throw error("Esta PC fue retirada del grupo", 409);
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

function clienteQuorum(c, { ubicacion, miembrosLocales, puertoHttps } = {}) {
  let miembros = c.miembros;
  function conectar(miembro) {
    const puerto = miembro.id === c.nodoId && puertoHttps?.();
    return puerto ? { url: `https://127.0.0.1:${puerto}`, ca: miembro.caPublica } : conectarMiembro(miembro, ubicacion);
  }
  async function estado({ compacto = false } = {}) {
    if (miembrosLocales && Object.keys(ubicacion?.direccionesRaft() || {}).some(id => !miembros.some(m => m.id === id))) {
      const locales = await miembrosLocales().catch(() => []);
      const conocidos = new Set(miembros.map(m => m.id));
      miembros = [...miembros, ...locales.filter(m => !conocidos.has(m.id))];
    }
    const desafio = crypto.randomBytes(20).toString("hex"), inicio = performance.now();
    const ruta = `/lan/quorum/estado?desafio=${desafio}${compacto ? "&compacto=1" : ""}`;
    const { sobre, e } = await Promise.any(miembros.map(async m => {
      const destino = conectar(m);
      const sobre = await H.pedir(destino.url, ruta, { ...destino, metodo: "GET", timeout: 4000 });
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
      const destino = conectar(yo);
      return H.pedir(destino.url, `/lan/quorum/${accion}`, { ...destino, grupoId: c.grupoId, nodoId: c.nodoId, clave: c.clave,
        cuerpo, timeout: 4000 });
    },
  };
}

module.exports = { prepararRedQuorum, iniciarConsenso, crearAutoridadQuorum, clienteQuorum, direccionRaft, RUTA_ALTA, acreditarOrigen, origenAcreditado };
