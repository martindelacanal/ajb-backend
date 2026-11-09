"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { crearTestigo } = require("./testigo-lan");
const { crearVerificador } = require("./protocolo-lan");
const { identidadEquipo } = require("./control-equipo");
const { respuesta, respuestaError, leer, descifrarJson } = require("./http-lan");

function crearServidorTestigo({ base, config, testigo: arbitro }) {
  if (config.equipoId && config.equipoId !== identidadEquipo()) throw new Error("Esta carpeta del testigo pertenece a otra PC; no se inicia una segunda autoridad");
  if (!/^[a-f0-9]{64}$/.test(config.claveAdministracion || "")) throw new Error("Falta la clave privada de administración del testigo");
  const testigo = arbitro || crearTestigo({ base: path.join(base, "testigo"), config });
  const verificarAdmin = crearVerificador({ grupoId: config.grupoId, miembros: [{ id: "administracion", clave: config.claveAdministracion }] });
  const servidor = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local");
      if (req.method === "GET" && url.pathname === "/lan/testigo/estado") {
        const desafio = url.searchParams.get("desafio");
        if (!/^[a-f0-9]{32,128}$/.test(desafio || "")) throw new Error("La consulta necesita un desafío nuevo");
        return respuesta(res, 200, testigo.estado({ desafio, compacto: url.searchParams.get("compacto") === "1" }));
      }
      if (req.method !== "POST" || !url.pathname.startsWith("/lan/testigo/")) return respuesta(res, 404, { mensaje: "No encontramos esa operación" });
      const buffer = await leer(req);
      const accion = url.pathname.slice("/lan/testigo/".length);
      if (["configurar", "inicializar"].includes(accion)) {
        verificarAdmin({ metodo: req.method, ruta: req.url, cuerpo: buffer, cabeceras: req.headers });
        const datos = descifrarJson(buffer, config.claveAdministracion);
        const r = accion === "configurar" ? testigo.actualizarMiembros(datos.miembros) : testigo.inicializarRevision(datos.revision);
        return respuesta(res, 200, r);
      }
      const actor = testigo.autenticarPeticion({ metodo: req.method, ruta: req.url, cuerpo: buffer, cabeceras: req.headers });
      const datos = JSON.parse(buffer.toString("utf8"));
      if (datos.nodoId !== actor.nodoId || !["solicitar", "renovar", "confirmar", "liberar"].includes(accion)) throw new Error("La operación no corresponde a ese equipo");
      return respuesta(res, 200, testigo[accion](datos));
    } catch (e) { if (!res.headersSent && !res.destroyed) respuestaError(res, e); }
  });
  return { servidor, testigo, cerrar: () => new Promise((resolve) => { servidor.close(() => { testigo.cerrar(); resolve(); }); }) };
}

if (require.main === module) {
  const i = process.argv.indexOf("--base"), base = path.resolve(i >= 0 ? process.argv[i + 1] : process.cwd());
  const config = JSON.parse(fs.readFileSync(path.join(base, "predio-ha.json"), "utf8").replace(/^\uFEFF/, ""));
  if (!config.equipoId || config.equipoId !== identidadEquipo()) throw new Error("El testigo debe incorporarse desde el instalador en esta PC");
  const s = crearServidorTestigo({ base, config });
  s.servidor.listen(config.puertoTestigo || 39877, "0.0.0.0");
  for (const senal of ["SIGINT", "SIGTERM"]) process.once(senal, () => s.cerrar().then(() => process.exit(0)));
}
module.exports = { crearServidorTestigo };
