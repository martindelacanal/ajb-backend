"use strict";

const path = require("node:path");
const { crearTestigo } = require("./testigo-lan");
const { conectarMiembro } = require("./ubicacion-lan");
const H = require("./http-lan");
const U = require("./util");
const { verificarAdministrador } = require("./api/sesion");

const RUTA = "/lan/relevo/";
const ACCIONES = ["solicitar", "renovar", "confirmar", "liberar"];

function abrirAutoridadManual(base, c, preparacion) {
  const { cajaId, inicial, miembros } = c.relevoManual;
  if (c.nodoId !== cajaId || !miembros?.some(m => m.id === cajaId && m.clave === c.clave)) {
    throw new Error("La autoridad de relevo pertenece a la PC de caja");
  }
  const testigo = crearTestigo({ base: path.join(base, "ha", "relevo-manual"), firmaInicial: preparacion,
    exigirExistente: !preparacion, config: { grupoId: c.grupoId, manualCaja: cajaId, miembros, revisionInicial: inicial, clavePublicaTestigo: c.clavePublicaTestigo } });
  if (preparacion) testigo.cerrar();
  return testigo;
}

function crearRelevoManual({ base, config, c, core, ubicacion }) {
  const testigo = c.nodoId === c.relevoManual.cajaId ? abrirAutoridadManual(base, c) : null;
  const caja = c.miembros.find(m => m.id === c.relevoManual.cajaId);
  const destino = () => conectarMiembro(caja, ubicacion);
  function operar(accion, datos) {
    if (!ACCIONES.includes(accion)) throw U.error("La operación de relevo no es válida", 403);
    if (accion === "confirmar") core.obtenerSnapshot({ indice: datos.indice, sha256: datos.sha256 });
    return testigo[accion](datos);
  }
  function estadoLocal() {
    if (!testigo) throw U.error("Abrí el relevo en la PC de caja", 403);
    return testigo.estado().estado;
  }
  return {
    estado(opciones) { return H.estadoTestigo(c, { ...opciones, arbitro: testigo, destino: testigo ? undefined : destino(), ruta: RUTA + "estado" }); },
    pedir(accion, datos) {
      if (testigo) return operar(accion, datos);
      const d = destino();
      return H.pedir(d.url, RUTA + accion, { ...d, grupoId: c.grupoId, nodoId: c.nodoId, clave: c.clave, cuerpo: datos });
    },
    async manejar(req, res, u) {
      if (!testigo || !req.socket.encrypted) throw U.error("La consulta de relevo requiere la conexión interna de la caja", 403);
      const accion = u.pathname.slice(RUTA.length);
      if (req.method === "GET" && accion === "estado") {
        const desafio = u.searchParams.get("desafio");
        if (!/^[a-f0-9]{32,128}$/.test(desafio || "")) throw U.error("Falta el desafío de la consulta", 400);
        return H.respuesta(res, 200, testigo.estado({ desafio, compacto: u.searchParams.get("compacto") === "1" }));
      }
      if (req.method !== "POST" || !ACCIONES.includes(accion)) throw U.error("La operación de relevo no es válida", 404);
      const cuerpo = await H.leer(req, 32 * 1024);
      const actor = testigo.autenticarPeticion({ metodo: req.method, ruta: req.url, cuerpo, cabeceras: req.headers });
      const datos = JSON.parse(cuerpo.toString("utf8"));
      if (datos.nodoId !== actor.nodoId) throw U.error("El permiso no corresponde a esta PC", 403);
      return H.respuesta(res, 200, operar(accion, datos));
    },
    estadoLocal,
    async habilitar({ usuario, password }) {
      const w = estadoLocal();
      if (w.escritor || w.cuarentena_ms || w.bloqueado) throw U.error("La caja todavía no puede tomar el relevo. Si la principal está apagada, esperá unos segundos y volvé a intentar.", 409);
      await core.consultarCopia(w.ultimo, db => verificarAdministrador({ db, pid: config.predio_id, ip: "127.0.0.1" }, usuario, password));
      testigo.habilitarRelevo(w.ultimo);
      return w.ultimo;
    },
    detener() { testigo?.cerrar(); },
  };
}

module.exports = { abrirAutoridadManual, crearRelevoManual, RUTA };
