"use strict";

// El paquete de mantenimiento instala este módulo junto a protocolo-lan y http-lan.
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const dns = require("node:dns/promises");
const { randomBytes } = require("node:crypto");
const { execFile } = require("node:child_process");

const RUTA = "/lan/diagnostico-acceso-miramar";
const NOMBRE = "ajbmiramar";
const IP = "192.168.1.99";
const PUERTO = 8080;
const RESPALDOS = new Set(["desktop-mn7m56l", "dm"]);
const INTENTOS = 5;
const ESPERA_MS = 8000;
const LIMITE_MS = 5000;

function configurarAccesoDirecto(dirApp) {
  const script = path.join(dirApp, "windows", "configurar-acceso-directo-miramar.ps1");
  const argumentos = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", argumentos, { windowsHide: true, timeout: 45000, maxBuffer: 16384 }, (error, salida) => {
      if (error) return reject(error);
      try {
        const resultado = JSON.parse(salida.trim());
        const campos = ["comunes_actualizados", "personales_encontrados", "personales_verificados", "personales_actualizados"];
        if (typeof resultado.comun_verificado !== "boolean" || !Array.isArray(resultado.errores) ||
            campos.some(campo => !Number.isSafeInteger(resultado[campo]) || resultado[campo] < 0)) {
          throw new Error("Informe de acceso directo inválido");
        }
        resolve({
          destino: `http://${NOMBRE}:${PUERTO}`,
          comun_verificado: resultado.comun_verificado,
          ...Object.fromEntries(campos.map(campo => [campo, resultado[campo]])),
          errores: resultado.errores.filter(codigo => typeof codigo === "string" && /^[A-Z0-9_]{1,48}$/.test(codigo)).slice(0, 12),
        });
      } catch (e) { reject(e); }
    });
  });
}

function resolver(nombre) {
  let timer;
  const espera = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("DNS no respondió"), { code: "ETIMEDOUT" })), LIMITE_MS);
  });
  return Promise.race([dns.lookup(nombre, { all: true, family: 4 }), espera]).finally(() => clearTimeout(timer));
}

function solicitar(nombre, direccion, ruta, leerJson = true) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: nombre,
      port: PUERTO,
      path: ruta,
      family: 4,
      agent: false,
      // Reusa la resolución de Windows ya comprobada para las dos solicitudes.
      lookup: (_hostname, opciones, callback) => opciones.all
        ? callback(null, [{ address: direccion, family: 4 }])
        : callback(null, direccion, 4),
      signal: AbortSignal.timeout(LIMITE_MS),
    }, (res) => {
      res.on("error", reject);
      if (res.statusCode !== 200 || !leerJson) {
        res.destroy();
        resolve({ status: res.statusCode, tipo: res.headers["content-type"] });
        return;
      }
      const partes = [];
      let bytes = 0;
      res.on("data", (parte) => {
        bytes += parte.length;
        if (bytes > 65536) req.destroy(Object.assign(new Error("Respuesta HTTP demasiado grande"), { code: "AJB_HTTP_RESPUESTA" }));
        else partes.push(parte);
      });
      res.on("end", () => {
        let datos;
        try { datos = JSON.parse(Buffer.concat(partes).toString("utf8")); } catch (_e) { /* respuesta no JSON */ }
        resolve({ status: res.statusCode, datos });
      });
    });
    req.on("error", reject);
  });
}

function clasificarDns(error) {
  if (error.code === "ETIMEDOUT") return "DNS_TIEMPO_AGOTADO";
  if (error.code === "ENOTFOUND" || error.code === "ENODATA") return "DNS_NO_RESUELVE";
  return "DNS_ERROR";
}

function clasificarHttp(error) {
  if (error.code === "ABORT_ERR" || error.code === "ETIMEDOUT") return "HTTP_TIEMPO_AGOTADO";
  if (error.code === "AJB_HTTP_RESPUESTA") return "HTTP_CUERPO_INVALIDO";
  return "HTTP_SIN_CONEXION";
}

async function probar(nombre, principal, ha, verificarEstadoFirmado) {
  const prueba = { nombre, dns: [], http: null, http_quorum: null, http_inicio: null, codigo: null };
  try {
    prueba.dns = [...new Set((await resolver(nombre)).map(({ address }) => address))].slice(0, 8);
  } catch (error) {
    return { ...prueba, codigo: clasificarDns(error) };
  }
  if (!prueba.dns.length) return { ...prueba, codigo: "DNS_NO_RESUELVE" };
  if (prueba.dns.length !== 1 || prueba.dns[0] !== IP) return { ...prueba, codigo: "DNS_DESTINO_DISTINTO" };

  try {
    const desafio = randomBytes(20).toString("hex");
    const respuesta = await solicitar(nombre, prueba.dns[0], "/lan/quorum/estado?desafio=" + desafio);
    prueba.http_quorum = respuesta.status;
    if (respuesta.status !== 200) return { ...prueba, codigo: "HTTP_QUORUM" };
    let estado;
    try {
      estado = verificarEstadoFirmado(respuesta.datos, { clavePublica: ha.clavePublicaTestigo, grupoId: ha.grupoId, desafio });
    } catch (_e) {
      return { ...prueba, codigo: "FIRMA_NO_VALIDA" };
    }
    if (estado.escritor?.id !== principal.id || estado.preferido_id !== principal.id || estado.escritor.nombre?.toLowerCase() !== NOMBRE ||
        estado.solo_principal !== true || estado.regreso_automatico !== false ||
        estado.votantes?.length !== 1 || estado.votantes[0] !== principal.id) {
      return { ...prueba, codigo: "ESCRITOR_NO_CONFIRMADO" };
    }
    const publico = await solicitar(nombre, prueba.dns[0], "/api/estado-publico");
    prueba.http = publico.status;
    if (publico.status !== 200) return { ...prueba, codigo: "HTTP_ESTADO" };
    if (!publico.datos || typeof publico.datos !== "object") return { ...prueba, codigo: "HTTP_CUERPO_INVALIDO" };
    if (publico.datos?.escritura?.autorizado !== true) return { ...prueba, codigo: "ESCRITURA_NO_AUTORIZADA" };
    const inicio = await solicitar(nombre, prueba.dns[0], "/", false);
    prueba.http_inicio = inicio.status;
    if (inicio.status !== 200) return { ...prueba, codigo: "HTTP_INICIO" };
    if (!/^text\/html(?:\s*;|$)/i.test(inicio.tipo || "")) return { ...prueba, codigo: "HTML_INICIO_INVALIDO" };
    return { ...prueba, codigo: "OK" };
  } catch (error) {
    return { ...prueba, codigo: clasificarHttp(error) };
  }
}

function crearDiagnosticoAccesoMiramar({ config, ha }) {
  const equipo = os.hostname().toLowerCase();
  if (process.platform !== "win32" || config?.predio_codigo !== "MIRAMAR" || !RESPALDOS.has(equipo) ||
      ha?.habilitado !== true || ha.rolInstalacion !== "Respaldo" || ha.equipoId !== ha.nodoId ||
      !ha.quorum || !ha.clavePublicaTestigo || !ha.claveDatos || !ha.grupoId) return null;
  const miembros = Array.isArray(ha.miembros) ? ha.miembros : [];
  const propio = miembros.find(m => m.id === ha.nodoId);
  const principal = miembros.find(m => m.preferido === true);
  if (propio?.nombre?.toLowerCase() !== equipo || principal?.nombre?.toLowerCase() !== NOMBRE || propio.id === principal.id ||
      !["https://192.168.1.99:8443", "http://192.168.1.99:8080"].includes(principal.url)) return null;

  const { crearVerificador, verificarEstadoFirmado } = require("./protocolo-lan");
  const { respuesta, respuestaError } = require("./http-lan");
  const verificar = crearVerificador({ grupoId: ha.grupoId, miembros: [{ id: principal.id, clave: ha.claveDatos }] });
  const inicio = new Date().toISOString();
  let resultado = { equipo, inicio, fecha: null, intento: 0, finalizado: false, corto: null, alternativo: null };
  let accesoDirecto = { estado: "PENDIENTE" };

  async function ejecutar(intento) {
    const corto = await probar(NOMBRE, principal, ha, verificarEstadoFirmado);
    const alternativo = corto.codigo === "OK" ? null : await probar(NOMBRE + ".lan", principal, ha, verificarEstadoFirmado);
    const finalizado = corto.codigo === "OK" || intento >= INTENTOS;
    resultado = { equipo, inicio, fecha: new Date().toISOString(), intento, finalizado, corto, alternativo };
    if (!finalizado) programar(intento + 1);
  }

  function programar(intento) {
    setTimeout(() => {
      ejecutar(intento).catch(() => {
        resultado = { ...resultado, fecha: new Date().toISOString(), intento, finalizado: true, codigo: "DIAGNOSTICO_INTERNO" };
      });
    }, ESPERA_MS).unref();
  }

  programar(1);
  return {
    async aplicarAccesoDirecto({ dirApp }) {
      try {
        const verificacion = await configurarAccesoDirecto(dirApp);
        const hayAcceso = verificacion.comun_verificado || verificacion.personales_verificados > 0;
        accesoDirecto = {
          ...verificacion,
          estado: hayAcceso && verificacion.personales_encontrados === verificacion.personales_verificados && !verificacion.errores.length
            ? "VERIFICADO" : "REVISAR",
          fecha: new Date().toISOString(),
        };
      } catch (_e) {
        accesoDirecto = { estado: "ERROR_EJECUCION", fecha: new Date().toISOString() };
      }
    },
    manejar(req, res, ruta, ip) {
      if (ruta !== RUTA) return false;
      if (ip !== IP || req.method !== "GET" || req.url !== RUTA || req.headers["transfer-encoding"] ||
          Number(req.headers["content-length"] || 0) !== 0) {
        respuesta(res, 403, { codigo: "DIAGNOSTICO_NO_AUTORIZADO" });
        return true;
      }
      try {
        verificar({ metodo: "GET", ruta: RUTA, cuerpo: Buffer.alloc(0), cabeceras: req.headers });
        respuesta(res, 200, { ...resultado, acceso_directo: accesoDirecto });
      } catch (error) {
        if (error.codigo === "RELOJ_LAN_DESAJUSTADO") respuestaError(res, error);
        else respuesta(res, 403, { codigo: "DIAGNOSTICO_NO_AUTORIZADO" });
      }
      return true;
    },
  };
}

module.exports = { crearDiagnosticoAccesoMiramar };
