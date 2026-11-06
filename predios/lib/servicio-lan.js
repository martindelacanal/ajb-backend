"use strict";

// Adaptación HTTP del grupo local. La autoridad y los archivos durables viven
// en respaldo-lan; esta capa no elige un escritor por falta de respuesta.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { Transform } = require("node:stream");
const { identidadEquipo } = require("./control-equipo");
const { crearRespaldoLan } = require("./respaldo-lan");
const { crearVerificador } = require("./protocolo-lan");
const H = require("./http-lan");
const { cabecerasSinSalto, origenPermitido } = require("./acceso-lan");
const { emitirAviso } = require("./avisos");

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
function crearServicioLan({ base, config, db, ha, alReiniciar, log = () => {}, alEstado = () => {} }) {
  const c = ha;
  let core, ultimoEstado = null, detenido = false, avisando = false;
  const colaAvisos = [];
  function miembros() { return ultimoEstado?.miembros || core?.estado().miembros || c.miembros; }
  const verificar = crearVerificador({ grupoId: c.grupoId, miembros: () => miembros().map(m => ({ id: m.id, clave: c.claveDatos })) });
  async function estadoTestigo(opciones) { const w = await H.estadoTestigo(c, opciones); if (!opciones?.compacto) ultimoEstado = w; return w; }
  function opciones(miembro) { origenPermitido(miembro.url); return { grupoId: c.grupoId, nodoId: c.nodoId, clave: c.claveDatos, ca: miembro.caPublica }; }
  const transporte = {
    testigo(accion, payload) {
      if (accion === "estado") return estadoTestigo();
      return H.pedir(c.testigo.url, "/lan/testigo/" + accion, { grupoId: c.grupoId, nodoId: c.nodoId, clave: c.clave, cuerpo: payload });
    },
    replicar: (m, packet) => H.pedir(m.url, "/lan/replica", { ...opciones(m), buffer: packet.buffer, timeout: 4000 }),
    async obtenerSnapshot(m, revision) {
      const r = await H.pedir(m.url, `/lan/replica?indice=${revision.indice}&sha256=${revision.sha256}`, { ...opciones(m), metodo: "GET", binario: true, timeout: 15000 });
      return extraerPaquete(r.buffer);
    },
    drenar: (m, cuerpo) => H.pedir(m.url, "/lan/drenar", { ...opciones(m), cuerpo, timeout: 15000 }),
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
  const adaptador = {
    ...core, configuracion: c, transporte,
    async pruebaCentral() {
      if (!core.estado().escritor || !c.certificado) throw Object.assign(new Error("Esta PC no tiene el control del grupo local"), { status: 503 });
      const w = await estadoTestigo({ compacto: true });
      if (w.escritor !== c.nodoId || w.termino !== core.estado().termino || w.vence_en_ms <= 0 || !core.estado().escritor) throw Object.assign(new Error("El testigo no acredita a esta PC para sincronizar"), { status: 503 });
      return Buffer.from(JSON.stringify({ certificado: c.certificado, estadoFirmado: w.sobre })).toString("base64");
    },
    async manejar(req, res) {
      const u = new URL(req.url, "http://local");
      if (!["/lan/replica", "/lan/replica/inicial", "/lan/drenar", "/lan/estado"].includes(u.pathname)) return false;
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
        else if (req.method === "POST" && u.pathname === "/lan/drenar") {
          const datos = JSON.parse(buffer.toString("utf8"));
          if (datos.haciaId !== actor.nodoId) throw new Error("La entrega debe pedirla el equipo preferido");
          H.respuesta(res, 200, await core.drenar(datos));
        } else if (req.method === "GET" && u.pathname === "/lan/estado") H.respuesta(res, 200, core.estado());
        else H.respuesta(res, 405, { mensaje: "Método no permitido" });
      } catch (e) { if (!res.headersSent && !res.destroyed) H.respuesta(res, e.status || 403, { mensaje: e.message }); }
      return true;
    },
    async reenviar(req, res) {
      try {
        const w = await estadoTestigo(), m = w.miembros?.find(n => n.id === w.escritor);
        if (!m || m.id === c.nodoId || w.vence_en_ms <= 0 || m.url !== w.escritorDatos?.url) throw new Error("Esperando un servidor actualizado y autorizado por el testigo.");
        const origen = origenPermitido(m.url), url = new URL(req.url, origen), headers = cabecerasSinSalto(req.headers);
        if (url.origin !== origen || url.username || url.password) throw new Error("La solicitud no corresponde al servidor autorizado");
        for (const k of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]) delete headers[k];
        await new Promise((resolve, reject) => {
          const upstream = (url.protocol === "https:" ? https : http).request(url, { method: req.method, headers, ca: m.caPublica, rejectUnauthorized: true }, r => {
            const h = cabecerasSinSalto(r.headers); res.writeHead(r.statusCode, h); r.pipe(res); r.on("end", resolve); r.on("error", reject);
          });
          const timer = setTimeout(() => upstream.destroy(new Error("El servidor actual no respondió")), 120000);
          upstream.once("close", () => clearTimeout(timer)); upstream.on("error", reject);
          req.once("aborted", () => upstream.destroy()); res.once("close", () => { if (!res.writableEnded) upstream.destroy(); });
          let bytes = 0;
          const limite = new Transform({ transform(b, _e, cb) { bytes += b.length; cb(bytes > 301 * 1024 * 1024 ? new Error("Solicitud demasiado grande") : null, b); } });
          limite.on("error", e => upstream.destroy(e)); req.pipe(limite).pipe(upstream);
        });
      } catch (e) { if (!res.headersSent) H.respuesta(res, 503, { mensaje: e.message, codigo: "SERVIDOR_CAMBIANDO" }); else res.destroy(); }
    },
    detener() { detenido = true; core.detener(); },
    estadoTestigo: () => ultimoEstado,
    publicarAvisos,
  };
  return adaptador;
}
module.exports = { leerConfiguracionLan, crearServicioLan, extraerPaquete };
