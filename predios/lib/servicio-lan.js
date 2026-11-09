"use strict";

// Adaptación HTTP del grupo local. La autoridad y los archivos durables viven
// en respaldo-lan; esta capa no elige un escritor por falta de respuesta.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { Transform } = require("node:stream");
const { identidadEquipo } = require("./control-equipo");
const { crearRespaldoLan } = require("./respaldo-lan");
const { crearVerificador } = require("./protocolo-lan");
const H = require("./http-lan");
const { cabecerasSinSalto, origenPermitido } = require("./acceso-lan");
const { emitirAviso } = require("./avisos");
const { iniciarConsenso, crearAutoridadQuorum, clienteQuorum, RUTA_ALTA, acreditarOrigen, origenAcreditado } = require("./quorum-lan");
const { conectarMiembro } = require("./ubicacion-lan");
const { abrirAutoridadManual, crearRelevoManual, RUTA: RUTA_RELEVO } = require("./relevo-manual");

function leerConfiguracionLan(base, equipoId = identidadEquipo()) {
  const archivo = path.join(base, "predio-ha.json");
  if (!fs.existsSync(archivo)) return null;
  const c = JSON.parse(fs.readFileSync(archivo, "utf8").replace(/^\uFEFF/, ""));
  if (!c.habilitado) return null;
  if (c.incorporacion || c.equipoId !== equipoId || c.nodoId !== equipoId || !["Respaldo", "Principal"].includes(c.rolInstalacion)) {
    throw new Error("La configuración del servidor de respaldo debe incorporarse desde el instalador en esta PC");
  }
  return c;
}
function extraerPaquete(buffer) {
  if (buffer.length < 12 || buffer.subarray(0, 8).toString() !== "AJBLAN01") throw new Error("La copia LAN no es válida");
  const bytes = buffer.readUInt32BE(8);
  if (bytes > 8192 || bytes + 40 > buffer.length) throw new Error("La cabecera de la copia no es válida");
  return { manifest: JSON.parse(buffer.subarray(12, 12 + bytes).toString("utf8")), buffer };
}
function crearServicioLan({ base, dirApp, config, db, ha, alReiniciar, prepararQuorum, ubicarGrupo, puertoHttps, log = () => {}, alEstado = () => {} }) {
  const c = ha;
  const arranque = crypto.randomBytes(16).toString("hex");
  let core, ultimoEstado = null, detenido = false, avisando = false;
  let consenso, autoridad, cliente, ubicacion, relevo;
  const colaAvisos = [];
  function miembros() { return ultimoEstado?.miembros || core?.estado().miembros || c.miembros; }
  const verificar = crearVerificador({ grupoId: c.grupoId, miembros: () => miembros().map(m => ({ id: m.id, clave: c.claveDatos })) });
  async function estadoTestigo(opciones) {
    if (c.quorumPendiente || (c.quorum && !cliente) || (c.relevoManual && !relevo)) throw new Error("La PC espera la activación del grupo");
    const w = await (cliente ? cliente.estado(opciones) : relevo ? relevo.estado(opciones) : H.estadoTestigo(c, opciones));
    if (!opciones?.compacto) ultimoEstado = w;
    return w;
  }
  function pedirMiembro(miembro, ruta, opciones) {
    const destino = conectarMiembro(miembro, ubicacion);
    origenPermitido(destino.url);
    return H.pedir(destino.url, ruta, { ...destino, grupoId: c.grupoId, nodoId: c.nodoId, clave: c.claveDatos, ...opciones });
  }
  const transporte = {
    testigo(accion, payload) {
      if (accion === "estado") return estadoTestigo();
      if (cliente) return cliente.pedir(accion, payload);
      if (relevo) return relevo.pedir(accion, payload);
      return H.pedir(c.testigo.url, "/lan/testigo/" + accion, { grupoId: c.grupoId, nodoId: c.nodoId, clave: c.clave, cuerpo: payload });
    },
    replicar: (m, packet) => pedirMiembro(m, "/lan/replica", { buffer: packet.buffer, timeout: 4000 }),
    async obtenerSnapshot(m, revision) {
      const r = await pedirMiembro(m, `/lan/replica?indice=${revision.indice}&sha256=${revision.sha256}`, { metodo: "GET", binario: true, timeout: 15000 });
      return extraerPaquete(r.buffer);
    },
    drenar: (m, cuerpo) => pedirMiembro(m, "/lan/drenar", { cuerpo, timeout: 15000 }),
    solicitarRetorno: (m, cuerpo) => pedirMiembro(m, "/lan/retorno", { cuerpo, timeout: 8000 }),
    transferirAlPrincipal: (...datos) => autoridad.transferirAlPrincipal(...datos),
  };
  async function publicarAvisos() {
    if (avisando || detenido || !core.estado().escritor) return;
    avisando = true;
    try {
      while (colaAvisos.length && core.estado().escritor) {
        const e = colaAvisos[0], s = core.estado(), actual = miembros().find(m => m.id === c.nodoId), nombre = actual?.nombre || c.nodoId;
        const campo = e.tipo === "ESCRITOR_ACTIVO" ? "ha_aviso_control" : "ha_aviso_redundancia";
        const marca = e.tipo === "ESCRITOR_ACTIVO" ? String(s.termino) : `${s.termino}:${e.tipo}`;
        await db.tx(async t => {
          if ((await t.get("SELECT valor FROM predio_meta WHERE clave=?", [campo]))?.valor === marca) return;
          const preferido = actual?.preferido === true;
          const titulo = e.tipo === "ESCRITOR_ACTIVO" ? (preferido ? "Servidor principal activo" : "Se activó un servidor de respaldo")
            : e.tipo === "REDUNDANCIA_REDUCIDA" ? "El servidor está trabajando sin otra copia disponible" : "Se recuperó el respaldo del servidor";
          const mensaje = e.tipo === "ESCRITOR_ACTIVO" ? (preferido ? `La PC ${nombre} retomó el control con los datos actualizados.` : `La PC principal dejó de estar disponible. El camping continúa trabajando desde ${nombre}.`)
            : e.tipo === "REDUNDANCIA_REDUCIDA" ? `La PC actual es ${nombre}. Revisá las otras PCs de respaldo para volver a tener otra copia actualizada.` : `La PC actual es ${nombre} y volvió a contar con otra copia actualizada en la red local.`;
          const ctx = { pid: config.predio_id, modo: "local", origen: "SISTEMA", usuario: { id: null, nombre: "Respaldo automático" } };
          await emitirAviso(t, ctx, { tipo: e.tipo === "ESCRITOR_ACTIVO" ? "SERVIDOR_CAMBIO" : "SERVIDOR_RESPALDO", titulo, mensaje,
            detalle: { grupo_id: c.grupoId, equipo_id: c.nodoId, equipo: nombre, termino: s.termino, degradado: s.degradado } });
          await t.run("INSERT INTO predio_meta(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor", [campo, marca]);
        });
        colaAvisos.shift();
      }
    } catch (e) { log("Aviso de servidor: " + e.message); }
    finally { avisando = false; }
  }
  core = crearRespaldoLan({ base, config: { ...config, respaldo_lan: c }, db, transporte, log,
    alActivar: datos => alReiniciar?.(datos),
    alCambio(e) {
      if (["ESCRITOR_ACTIVO", "REDUNDANCIA_REDUCIDA", "REDUNDANCIA_RESTABLECIDA"].includes(e.tipo)) {
        colaAvisos.push(e); setImmediate(publicarAvisos);
      }
      alEstado(e);
    },
  });
  function revisarRetiro(id) {
    if (!autoridad || !core.estado().escritor) throw Object.assign(new Error("Esperando al servidor en servicio para quitar el respaldo"), { status: 503 });
    return autoridad.revisarRetiro(id);
  }
  function retirarQuorum(id) {
    return db.exclusivo(async () => {
      const retiro = await revisarRetiro(id);
      if (!retiro) return;
      let acuses = [];
      if (retiro.requiereCopias) {
        const packet = core.copiaDelEscritor(retiro.ultimo);
        const resultados = await Promise.allSettled(retiro.miembros.filter(m => m.id !== c.nodoId).map(m => transporte.replicar(m, packet)));
        acuses = resultados.filter(r => r.status === "fulfilled").map(r => r.value);
      }
      await autoridad.quitarMiembro(id, retiro.ultimo, acuses);
    });
  }
  function volvioDeUnArranque(m, listo, plan) {
    return listo?.equipo === m.id && listo.consenso && /^[a-f0-9]{32}$/.test(listo.arranque || "") &&
      Boolean(plan.arranques?.[m.id]) && listo.arranque !== plan.arranques[m.id];
  }
  async function confirmarReactivacion(plan, automatico) {
    const copia = core.copiaDelEscritor(plan.ultimo);
    const acuses = await Promise.all(plan.miembros.map(async m => {
      try {
        const acuse = await transporte.replicar(m, copia);
        const listo = await pedirMiembro(m, "/lan/quorum/listo", { cuerpo: {} });
        if (listo.equipo !== m.id || !listo.consenso || listo.version !== plan.version ||
            (automatico && !volvioDeUnArranque(m, listo, plan))) throw new Error("El respaldo todavía no está listo");
        return acuse;
      } catch (_e) {
        throw Object.assign(new Error(`Encendé ${m.nombre} y esperá a que reciba la última copia antes de reactivar el relevo`), { status: 409 });
      }
    }));
    return autoridad.reactivarRespaldos(plan.ultimo, plan.version, acuses);
  }
  async function comprobarRegresoRespaldos() {
    const plan = await autoridad.prepararReactivacion();
    if (!plan?.arranques) return;
    // Buscar los respaldos fuera del candado de la base: una PC apagada
    // no debe frenar las ventas mientras se agota el plazo de la consulta.
    const respuestas = await Promise.all(plan.miembros.map(async m => [
      m.id, await pedirMiembro(m, "/lan/quorum/listo", { cuerpo: {}, timeout: 1800 }).catch(() => null),
    ]));
    const porId = new Map(respuestas);
    if (!plan.miembros.every(m => volvioDeUnArranque(m, porId.get(m.id), plan))) return;
    await db.exclusivo(async () => {
      if (!core.estado().escritor) return;
      const vigente = await autoridad.prepararReactivacion();
      if (!vigente?.arranques || !vigente.miembros.every(m => volvioDeUnArranque(m, porId.get(m.id), vigente))) return;
      await confirmarReactivacion(vigente, true);
      log("Relevo automático reactivado: los respaldos confirmaron la última copia");
    });
  }
  const adaptador = {
    ...core, configuracion: c, transporte,
    origenIncorporacion(cabecera, ip) { return cliente ? origenAcreditado(cabecera, c, miembros(), ip, ubicacion) : null; },
    consultarQuorum: estadoTestigo,
    configurarSoloPrincipal(activo) {
      return db.exclusivo(async () => {
        if (!autoridad || !core.estado().escritor) throw Object.assign(new Error("La notebook principal debe estar en servicio"), { status: 409 });
        if (activo) {
          const plan = await autoridad.prepararModoPrincipal();
          if (!plan) return { soloPrincipal: true };
          const arranques = await Promise.all(plan.miembros.map(async m => {
            const listo = await pedirMiembro(m, "/lan/quorum/listo", { cuerpo: {} }).catch(() => null);
            if (listo?.equipo !== m.id || !listo.consenso || listo.version !== plan.version) {
              throw Object.assign(new Error(`Dejá ${m.nombre} encendida y esperá a que se conecte antes de preparar el apagado`), { status: 409 });
            }
            if (!/^[a-f0-9]{32}$/.test(listo.arranque || "")) throw Object.assign(new Error(`Esperá a que ${m.nombre} se actualice antes de preparar el apagado`), { status: 409 });
            return [m.id, listo.arranque];
          }));
          return autoridad.dejarSoloPrincipal(plan.version, Object.fromEntries(arranques));
        }
        const plan = await autoridad.prepararReactivacion();
        return plan ? confirmarReactivacion(plan, false) : { soloPrincipal: false };
      });
    },
    revisarRetiro,
    retirarQuorum,
    async iniciar() {
      if (c.quorum || c.quorumPendiente || c.relevoManual) ubicacion ??= ubicarGrupo?.(c);
      if (c.quorumPendiente) return Promise.resolve();
      if (c.relevoManual) relevo ??= crearRelevoManual({ base, config, c, core, ubicacion });
      if (c.quorum && !autoridad) {
        consenso = iniciarConsenso({ base, dirApp, config: c, log, ubicacion });
        cliente = clienteQuorum(c, { ubicacion, puertoHttps, miembrosLocales: async () => (await consenso.pedir("/local")).data?.miembros || [] });
        autoridad = crearAutoridadQuorum({ config: c, consenso });
      }
      return core.iniciar();
    },
    relevoLocal: () => relevo?.estadoLocal(),
    async habilitarRelevo(datos) {
      const revision = await relevo.habilitar(datos);
      core.sondear().catch(e => log("Relevo manual: " + e.message));
      return revision;
    },
    async promoverQuorum(r, disponibles, haQuorum, pedirEquipo) {
      if (!autoridad || !core.estado().escritor) return;
      const miembrosRaft = await autoridad.miembrosParaIncorporar();
      if (!miembrosRaft) {
        if (c.rolInstalacion === "Principal") await comprobarRegresoRespaldos().catch(e => log("Regreso de respaldos: " + e.message));
        return;
      }
      for (const id of r.quorum.retiros || []) {
        if (!ultimoEstado?.retirados?.includes(id)) await retirarQuorum(id);
      }
      const votantes = new Set(miembrosRaft.filter(m => m.Suffrage === 0).map(m => m.ID));
      for (const m of await disponibles({ ...r, miembros: r.miembros.filter(n => !votantes.has(n.id)) })) {
        await db.exclusivo(async () => {
          if (!core.estado().escritor) return;
          const { ultimo } = await autoridad.prepararMiembro(m);
          const listo = await pedirEquipo(r, m, "/lan/quorum/listo", {});
          const packet = core.obtenerSnapshot(ultimo);
          if (!listo.consenso) {
            await pedirEquipo(r, m, "/lan/quorum/copia", packet.buffer);
            await pedirEquipo(r, m, "/lan/quorum/preparar", haQuorum(r, m, { revisionArranque: ultimo }));
            return;
          }
          if (listo.confirmada?.sha256 !== ultimo.sha256 || listo.confirmada?.indice !== ultimo.indice) {
            await transporte.replicar(m, packet);
          }
          await autoridad.unirMiembro(m, ultimo, listo.version);
        });
      }
    },
    async pruebaCentral() {
      const datos = c.certificado?.datos;
      if (!core.estado().escritor || !datos) throw Object.assign(new Error("Esta PC no tiene el control del grupo local"), { status: 503 });
      if (!config.token) throw Object.assign(new Error("La instalación no tiene una credencial de Mi AJB"), { status: 503 });
      const w = await estadoTestigo({ compacto: true });
      if (w.escritor !== c.nodoId || w.termino !== core.estado().termino || w.vence_en_ms <= 0 || !core.estado().escritor) throw Object.assign(new Error("El testigo no acredita a esta PC para sincronizar"), { status: 503 });
      // El instalador puede renovar el token sin cambiar el grupo ni su clave.
      const firma = crypto.createHmac("sha256", config.token).update(JSON.stringify(datos)).digest("hex");
      return Buffer.from(JSON.stringify({ certificado: { datos, firma }, estadoFirmado: w.sobre })).toString("base64");
    },
    async manejar(req, res) {
      const u = new URL(req.url, "http://local");
      if (c.relevoManual && u.pathname.startsWith(RUTA_RELEVO)) {
        try {
          if (!relevo) throw new Error("La PC de caja todavía está preparando el relevo");
          await relevo.manejar(req, res, u);
        } catch (e) { if (!res.headersSent && !res.destroyed) H.respuestaError(res, e, 503); }
        return true;
      }
      if (u.pathname === "/lan/quorum/listo" && c.relevoManual) {
        try {
          if (!req.socket.encrypted || req.method !== "POST") throw new Error("La consulta requiere la conexión interna autenticada");
          const buffer = await H.leer(req, 4096);
          verificar({ metodo: req.method, ruta: req.url, cuerpo: buffer, cabeceras: req.headers });
          H.respuesta(res, 200, { equipo: c.nodoId, manual: true, semilla: relevo ? c.relevoManual.inicial.sha256 : null });
        } catch (e) { H.respuestaError(res, e); }
        return true;
      }
      if (u.pathname === "/lan/quorum/listo" && c.quorum) {
        try {
          if (!req.socket.encrypted || req.method !== "POST") throw new Error("La consulta requiere la conexión interna autenticada");
          const buffer = await H.leer(req, 4096);
          verificar({ metodo: req.method, ruta: req.url, cuerpo: buffer, cabeceras: req.headers });
          const local = consenso ? await consenso.pedir("/local") : null;
          H.respuesta(res, 200, { equipo: c.nodoId, arranque, semilla: c.quorum.inicial?.ultimo.sha256 || null, confirmada: core.estado().confirmada, consenso: !!local, version: local?.version });
        } catch (e) { H.respuestaError(res, e); }
        return true;
      }
      if (u.pathname.startsWith("/lan/quorum/") && u.pathname !== "/lan/quorum/preparar" && c.quorum) {
        try {
          const estadoPublico = req.method === "GET" && u.pathname === "/lan/quorum/estado";
          if ((!req.socket.encrypted && !estadoPublico) || !autoridad) throw new Error("La coordinación LAN todavía no está disponible");
          await autoridad.manejar(req, res);
        } catch (e) { if (!res.headersSent && !res.destroyed) H.respuestaError(res, e, 503); }
        return true;
      }
      if (c.quorumPendiente && ["/lan/quorum/preparar", "/lan/quorum/listo", "/lan/quorum/copia", "/lan/replica/inicial"].includes(u.pathname)) {
        try {
          if (!req.socket.encrypted || req.method !== "POST") throw new Error("La preparación requiere la conexión interna autenticada");
          const buffer = await H.leer(req, 301 * 1024 * 1024);
          const actor = verificar({ metodo: req.method, ruta: req.url, cuerpo: buffer, cabeceras: req.headers });
          if (u.pathname === "/lan/quorum/listo") H.respuesta(res, 200, { equipo: c.nodoId, manual: true });
          else if (u.pathname === "/lan/replica/inicial") {
            H.respuesta(res, 200, await core.recibirInicial(extraerPaquete(buffer), { remitenteId: actor.nodoId }));
          } else if (u.pathname === "/lan/quorum/copia") {
            const w = await clienteQuorum(c, { ubicacion }).estado();
            if (w.escritor !== actor.nodoId || !w.vence_en_ms) throw new Error("La copia debe provenir del escritor acreditado por la mayoría");
            core.recibirCopiaQuorum(extraerPaquete(buffer), w.ultimo);
            H.respuesta(res, 200, { equipo: c.nodoId, confirmada: w.ultimo });
          } else {
            const nueva = JSON.parse(buffer.toString("utf8"));
            if ((!nueva.quorum && !nueva.relevoManual) || nueva.quorumPendiente || nueva.grupoId !== c.grupoId || nueva.nodoId !== c.nodoId || nueva.equipoId !== c.equipoId ||
                nueva.claveDatos !== c.claveDatos || nueva.clave !== c.clave || nueva.clavePublicaTestigo !== c.clavePublicaTestigo) throw new Error("La configuración de activación no corresponde a esta PC");
            const ultimo = nueva.relevoManual?.inicial || nueva.quorum?.inicial?.ultimo || nueva.quorum?.revisionArranque;
            if (nueva.relevoManual || nueva.quorum.inicial) {
              if (actor.nodoId !== c.miembros.find(m => m.preferido)?.id) throw new Error("La primera activación corresponde a la PC principal");
            } else {
              const w = await clienteQuorum(c, { ubicacion }).estado();
              if (w.escritor !== actor.nodoId || !w.vence_en_ms || w.ultimo.sha256 !== ultimo?.sha256 || w.ultimo.indice !== ultimo?.indice) {
                throw new Error("La incorporación debe provenir del escritor acreditado por la mayoría");
              }
            }
            core.obtenerSnapshot(ultimo);
            if (nueva.relevoManual) {
              if (ultimo.indice !== 0 || typeof nueva.relevoManual.firmaInicial !== "string" || !nueva.relevoManual.firmaInicial) {
                throw new Error("Faltan la copia inicial o la firma del relevo manual");
              }
              abrirAutoridadManual(base, nueva, nueva.relevoManual.firmaInicial);
              delete nueva.relevoManual.firmaInicial;
            }
            await prepararQuorum(nueva);
            H.respuesta(res, 200, { equipo: c.nodoId });
            alReiniciar?.();
          }
        } catch (e) { if (!res.headersSent && !res.destroyed) H.respuestaError(res, e); }
        return true;
      }
      if (!["/lan/replica", "/lan/replica/inicial", "/lan/drenar", "/lan/retorno", "/lan/estado"].includes(u.pathname)) return false;
      try {
        const buffer = await H.leer(req, 301 * 1024 * 1024);
        // Refresca los miembros firmados para admitir una PC recién incorporada.
        // No toma el candado de la base receptora: el preferido puede estar
        // esperando esta réplica mientras solicita el traspaso al escritor.
        await estadoTestigo();
        const actor = verificar({ metodo: req.method, ruta: req.url, cuerpo: buffer, cabeceras: req.headers });
        if (req.method === "GET" && u.pathname === "/lan/replica") {
          const packet = core.obtenerSnapshot({ indice: Number(u.searchParams.get("indice")), sha256: u.searchParams.get("sha256") });
          H.respuesta(res, 200, packet.buffer);
        } else if (req.method === "POST" && u.pathname === "/lan/replica") H.respuesta(res, 200, await core.recibirSnapshot(extraerPaquete(buffer), { remitenteId: actor.nodoId }));
        else if (req.method === "POST" && u.pathname === "/lan/replica/inicial") H.respuesta(res, 200, await core.recibirInicial(extraerPaquete(buffer), { remitenteId: actor.nodoId }));
        else if (req.method === "POST" && u.pathname === (c.quorum ? "/lan/retorno" : "/lan/drenar")) {
          const datos = JSON.parse(buffer.toString("utf8"));
          if (datos.haciaId !== actor.nodoId) throw new Error("La entrega debe pedirla el equipo preferido");
          H.respuesta(res, 200, await core.drenar(datos));
        } else if (req.method === "GET" && u.pathname === "/lan/estado") H.respuesta(res, 200, core.estado());
        else H.respuesta(res, 405, { mensaje: "Método no permitido" });
      } catch (e) { if (!res.headersSent && !res.destroyed) H.respuestaError(res, e); }
      return true;
    },
    async reenviar(req, res, alNoDisponible) {
      try {
        const w = await estadoTestigo(), m = w.miembros?.find(n => n.id === w.escritor);
        if (!m || m.id === c.nodoId || w.vence_en_ms <= 0 || m.url !== w.escritorDatos?.url) throw new Error("Esperando un servidor actualizado y autorizado por el testigo.");
        const destino = conectarMiembro(m, ubicacion);
        const origen = origenPermitido(destino.url), url = new URL(req.url, origen), headers = cabecerasSinSalto(req.headers);
        if (url.origin !== origen || url.username || url.password) throw new Error("La solicitud no corresponde al servidor autorizado");
        for (const k of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]) delete headers[k];
        delete headers["x-ajb-origen"];
        if (cliente && req.method === "POST" && url.pathname === RUTA_ALTA) {
          const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
          headers["x-ajb-origen"] = acreditarOrigen(ip, c);
        }
        await new Promise((resolve, reject) => {
          const upstream = (url.protocol === "https:" ? https : http).request(url, { method: req.method, headers, ca: destino.ca, servername: destino.servername, rejectUnauthorized: true }, r => {
            const h = cabecerasSinSalto(r.headers); res.writeHead(r.statusCode, h); r.pipe(res); r.on("end", resolve); r.on("error", reject);
          });
          const timer = setTimeout(() => upstream.destroy(new Error("El servidor actual no respondió")), 120000);
          upstream.once("close", () => clearTimeout(timer)); upstream.on("error", reject);
          req.once("aborted", () => upstream.destroy()); res.once("close", () => { if (!res.writableEnded) upstream.destroy(); });
          let bytes = 0;
          const limite = new Transform({ transform(b, _e, cb) { bytes += b.length; cb(bytes > 301 * 1024 * 1024 ? new Error("Solicitud demasiado grande") : null, b); } });
          limite.on("error", e => upstream.destroy(e)); req.pipe(limite).pipe(upstream);
        });
      } catch (e) {
        if (res.headersSent) res.destroy();
        else if (alNoDisponible) alNoDisponible();
        else H.respuesta(res, 503, { mensaje: e.message, codigo: "SERVIDOR_CAMBIANDO" });
      }
    },
    detener() { detenido = true; core.detener(); consenso?.detener(); relevo?.detener(); },
    estadoTestigo: () => ultimoEstado,
    publicarAvisos,
  };
  return adaptador;
}
module.exports = { leerConfiguracionLan, crearServicioLan, extraerPaquete };
