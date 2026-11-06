"use strict";

const os = require("node:os");
const { execFileSync } = require("node:child_process");
const U = require("./util");
const { leerMeta, escribirMeta } = require("./db-sqlite");

function identidadEquipo({ plataforma = process.platform, ejecutar = execFileSync, nombre = os.hostname(), interfaces = os.networkInterfaces() } = {}) {
  if (plataforma === "win32") {
    try {
      const salida = ejecutar("reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      const guid = /MachineGuid\s+REG_SZ\s+([a-zA-Z0-9-]+)/i.exec(salida)?.[1];
      if (guid) return U.sha256(`ajb-predio-equipo:${guid.toLowerCase()}`);
    } catch (_e) { /* equipos con acceso restringido al registro */ }
  }
  const macs = Object.values(interfaces).flat().filter((i) => !i.internal && i.mac && i.mac !== "00:00:00:00:00:00").map((i) => i.mac.toLowerCase()).sort();
  return U.sha256(`ajb-predio-equipo:${plataforma}:${nombre.toLowerCase()}:${[...new Set(macs)].join(",")}`);
}

function crearControlEquipo({ db, config, equipoId = identidadEquipo(), log = () => {} }) {
  const vinculado = Boolean(config.servidor && config.token);
  let propietario = leerMeta(db, "equipo_propietario_id");
  let confirmado = leerMeta(db, "control_confirmado") === equipoId;
  let conflicto = leerMeta(db, "control_conflicto") || null;
  const restauracionPendiente = Boolean(leerMeta(db, "restauracion_pendiente"));
  let otro = null;
  let redLista = !vinculado;
  let autoridadLocal = null;
  // Las instalaciones que ya operaban migran sin necesitar internet. Un paquete
  // nuevo debe activarse una vez; después conserva esa autorización sin conexión.
  if (!restauracionPendiente && !propietario && (!vinculado || leerMeta(db, "escritor") === "LOCAL")) {
    propietario = equipoId;
    confirmado = true;
    escribirMeta(db, "equipo_propietario_id", equipoId);
    escribirMeta(db, "control_confirmado", equipoId);
  }

  function estado() {
    if (autoridadLocal) {
      const local = autoridadLocal();
      return { equipo_id: equipoId, autorizado: local.autorizado === true, motivo: local.motivo || null,
        otro_servidor: local.otro_servidor || null, confirmado: true, comprobacion_red: true,
        restauracion_pendiente: restauracionPendiente, grupo_local: true };
    }
    const copia = propietario && propietario !== equipoId;
    const motivo = restauracionPendiente ? "Esta PC contiene un respaldo restaurado. Permanece en espera hasta completar la activación del reemplazo; todavía no puede registrar ventas ni sincronizar datos."
      : copia ? "Esta carpeta proviene de otra PC. Para evitar dos bases que se modifiquen a la vez, el servidor queda en modo consulta. Usá el servidor original o reasigná el predio desde Mi AJB."
      : conflicto || (otro ? `Ya hay un servidor de este predio en ${otro.url}. Abrí esa dirección; esta copia queda en modo consulta.`
        : !redLista ? "Comprobando si ya existe un servidor en la red del camping."
          : !confirmado ? "Esta instalación necesita conectarse una primera vez a Mi AJB para confirmar qué PC es la dueña del predio. Después puede trabajar sin internet." : null);
    return { equipo_id: equipoId, autorizado: !motivo, motivo, otro_servidor: otro, confirmado, comprobacion_red: redLista, restauracion_pendiente: restauracionPendiente };
  }

  return {
    equipoId,
    estado,
    configurarAutoridadLocal(comprobar) { if (typeof comprobar !== "function") throw new Error("Falta la autoridad local"); autoridadLocal = comprobar; },
    puedeAnunciarEscritor: () => autoridadLocal ? estado().autorizado : !restauracionPendiente && confirmado && propietario === equipoId && !conflicto && !otro,
    puedeEscribir: () => estado().autorizado,
    comprobar() {
      const e = estado();
      if (!e.autorizado) throw U.error(e.motivo, 409, { codigo: "SERVIDOR_SOLO_LECTURA", servidor: e.otro_servidor?.url || null });
    },
    redComprobada() { redLista = true; },
    otroServidor(datos) { otro = datos; log(`Otro servidor en la red: ${datos.url}. Esta instancia queda sin escritura.`); },
    confirmarCentral() {
      if (autoridadLocal) return estado().autorizado;
      if (restauracionPendiente) return false;
      if (propietario && propietario !== equipoId) return false;
      propietario = equipoId; confirmado = true; conflicto = null;
      escribirMeta(db, "equipo_propietario_id", equipoId);
      escribirMeta(db, "control_confirmado", equipoId);
      escribirMeta(db, "control_conflicto", "");
      return true;
    },
    rechazarCentral(motivo) {
      conflicto = motivo || "Otra instalación tiene el control de este predio.";
      escribirMeta(db, "control_conflicto", conflicto);
      log(conflicto);
    },
  };
}

module.exports = { identidadEquipo, crearControlEquipo };
