"use strict";

// Alta explícita de mantenimiento: sólo una autorización del firmante del código,
// dirigida a la notebook original, puede instalar el acceso SSH. No recibe scripts.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const U = require("./util");
const { leerMeta } = require("./db-sqlite");

const ACCION = "PREPARAR_ACCESO_SSH";
const DIAGNOSTICO = "DIAGNOSTICAR_ACCESO_SSH";
const CAMPOS = ["version", "accion", "equipoId", "instanciaId", "predioCodigo", "operadorPublicKey", "relayHost", "relayPort", "relayUser", "relayHostKey", "reversePort", "sshPort", "usuarioWindows", "expiresAt", "nonce"];
const FIJOS = { version: 1, relayHost: "52.67.192.228", relayPort: 22222,
  relayUser: "ajb-miramar-tunnel", reversePort: 22099, sshPort: 2222, usuarioWindows: "ajbmantenimiento" };
const MAX_VIGENCIA = 24 * 60 * 60 * 1000;
const FASES_INSTALADOR = new Set(["VALIDACION", "CAPACIDAD_OPENSSH", "CUENTA_WINDOWS", "CLAVES", "CONFIGURACION_SSH", "SERVICIO_SSH", "TUNEL", "VERIFICACION"]);
const rechazar = mensaje => { throw U.error(mensaje, 403); };

function base64Estricto(valor, maxBytes) {
  if (typeof valor !== "string" || !valor.length || valor.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(valor)) rechazar("La autorización SSH no tiene un formato válido");
  const buffer = Buffer.from(valor, "base64");
  if (buffer.length > maxBytes || buffer.toString("base64") !== valor) rechazar("La autorización SSH no tiene un formato válido");
  return buffer;
}

function esClaveSshPublica(valor) {
  if (typeof valor !== "string" || valor.length > 512 || /[\r\n\0]/.test(valor)) return false;
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [\x20-\x7e]{1,200})?$/.exec(valor);
  if (!m) return false;
  const b = Buffer.from(m[1], "base64");
  // Formato SSH: string "ssh-ed25519" y string de exactamente 32 bytes.
  return b.toString("base64") === m[1] && b.length === 51 && b.readUInt32BE(0) === 11 &&
    b.subarray(4, 15).toString("ascii") === "ssh-ed25519" && b.readUInt32BE(15) === 32;
}

function validarSolicitud(cuerpo, { config, equipoId, instanciaId, propietarioId, restauracionPendiente,
  plataforma = process.platform, ahora = Date.now() }) {
  if (plataforma !== "win32") rechazar("El mantenimiento SSH sólo se prepara en la notebook Windows");
  if (restauracionPendiente || !/^[a-f0-9]{64}$/.test(equipoId || "") || (propietarioId && propietarioId !== equipoId)) {
    rechazar("El mantenimiento SSH requiere la notebook original del predio");
  }
  if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo) || Object.keys(cuerpo).sort().join(",") !== "firma,solicitud") rechazar("La autorización SSH debe estar firmada");
  const raw = base64Estricto(cuerpo.solicitud, 8192), firma = base64Estricto(cuerpo.firma, 64);
  let clave, valida = false;
  try {
    clave = crypto.createPublicKey(config.clave_publica);
    valida = clave.asymmetricKeyType === "ed25519" && firma.length === 64 && crypto.verify(null, raw, clave, firma);
  } catch (_e) { /* una instalación sin clave fijada nunca autoriza acceso remoto */ }
  if (!valida) rechazar("La autorización SSH no tiene una firma válida del sistema general");
  let solicitud;
  try { solicitud = JSON.parse(raw.toString("utf8")); } catch (_e) { rechazar("La autorización SSH no contiene JSON válido"); }
  if (!solicitud || typeof solicitud !== "object" || Array.isArray(solicitud) ||
      Object.keys(solicitud).sort().join(",") !== [...CAMPOS].sort().join(",")) rechazar("La autorización SSH contiene campos no permitidos");
  for (const [campo, valor] of Object.entries(FIJOS)) if (solicitud[campo] !== valor) rechazar("El destino SSH no corresponde al acceso de mantenimiento autorizado");
  if (![ACCION, DIAGNOSTICO].includes(solicitud.accion)) rechazar("La acción SSH no corresponde al mantenimiento autorizado");
  if (solicitud.equipoId !== equipoId || solicitud.instanciaId !== instanciaId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanciaId || "") ||
      solicitud.predioCodigo !== config.predio_codigo || solicitud.predioCodigo !== "MIRAMAR") rechazar("La autorización SSH pertenece a otro equipo o predio");
  if (!esClaveSshPublica(solicitud.operadorPublicKey) || !esClaveSshPublica(solicitud.relayHostKey)) rechazar("Las identidades SSH deben ser claves públicas Ed25519 válidas");
  const vencimiento = typeof solicitud.expiresAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(solicitud.expiresAt) ? Date.parse(solicitud.expiresAt) : NaN;
  if (!Number.isSafeInteger(ahora) || !Number.isFinite(vencimiento) || vencimiento <= ahora || vencimiento - ahora > MAX_VIGENCIA) rechazar("La autorización SSH venció o supera las 24 horas de vigencia");
  if (typeof solicitud.nonce !== "string" || !/^[a-f0-9]{32,128}$/.test(solicitud.nonce)) rechazar("Falta el identificador único de la autorización SSH");
  return solicitud;
}

function ejecutarArchivo(ejecutable, argumentos, opciones) {
  return new Promise((resolve, reject) => execFile(ejecutable, argumentos, { windowsHide: true, maxBuffer: 64 * 1024, ...opciones },
    (e, stdout) => e ? reject(e) : resolve(String(stdout || ""))));
}

function resultadoPublico(stdout, solicitud) {
  let r;
  try { r = JSON.parse(String(stdout).replace(/^\uFEFF/, "").trim()); } catch (_e) { throw U.error("El instalador SSH no devolvió un resultado verificable", 500); }
  if (r && r.estado === "ERROR") {
    const codigoSeguro = r.codigo === "FALLO_INSTALACION" || (Number.isInteger(r.codigo) && r.codigo >= -2147483648 && r.codigo <= 4294967295);
    if (!FASES_INSTALADOR.has(r.fase) || !codigoSeguro) throw U.error("El instalador SSH no devolvió un diagnóstico verificable", 500);
    // Nunca incluir texto de la excepción, rutas, stderr ni campos adicionales.
    throw U.error(`No se pudo preparar el acceso SSH. Fase: ${r.fase}; código: ${r.codigo}`, 500,
      { fase: r.fase, codigo: r.codigo });
  }
  if (!r || !["PREPARADO", "ACTIVO"].includes(r.estado) || r.usuarioWindows !== solicitud.usuarioWindows ||
      r.sshPort !== solicitud.sshPort || r.reversePort !== solicitud.reversePort ||
      !esClaveSshPublica(r.tunnelPublicKey) || !esClaveSshPublica(r.sshHostPublicKey)) throw U.error("El resultado del instalador SSH no corresponde a la solicitud", 500);
  const publico = { estado: r.estado, usuarioWindows: r.usuarioWindows, sshPort: r.sshPort,
    reversePort: r.reversePort, tunnelPublicKey: r.tunnelPublicKey, sshHostPublicKey: r.sshHostPublicKey };
  for (const k of ["tunnelFingerprint", "sshHostFingerprint", "carpeta", "tarea", "servicio", "hostname", "publicIp"]) {
    if (typeof r[k] === "string" && r[k].length <= 512 && !/[\r\n\0]/.test(r[k])) publico[k] = r[k];
  }
  publico.relayHost = solicitud.relayHost; publico.relayPort = solicitud.relayPort;
  return publico;
}

function resultadoDiagnostico(stdout) {
  const invalido = () => { throw U.error("El diagnóstico SSH no devolvió un resultado verificable", 500); };
  let r;
  try { r = JSON.parse(String(stdout).replace(/^\uFEFF/, "").trim()); } catch (_e) { return invalido(); }
  const entero = n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;
  const fecha = v => typeof v === "string" && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,7})?Z?$/.test(v);
  const enumValor = (v, opciones) => { if (!opciones.includes(v)) invalido(); return v; };
  const filas = (v, max, convertir) => { if (!Array.isArray(v) || v.length > max) invalido(); return v.map(convertir); };
  if (!r || r.estado !== "DIAGNOSTICO" || !fecha(r.fecha) || typeof r.hostname !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(r.hostname) || typeof r.usuarioExiste !== "boolean" || !(r.reinicioPendiente === null || typeof r.reinicioPendiente === "boolean")) invalido();
  const publico = { estado: "DIAGNOSTICO", fecha: r.fecha, hostname: r.hostname, usuarioExiste: r.usuarioExiste, reinicioPendiente: r.reinicioPendiente,
    marca: enumValor(r.marca, ["AUSENTE", "INSTALANDO", "ACTIVO", "DESCONOCIDO"]),
    archivos: filas(r.archivos, 16, f => {
      if (typeof f?.existe !== "boolean" || !entero(f.tamano)) invalido();
      return { nombre: enumValor(f.nombre, ["DIRECTORIO", "MARCA", "INSTALACION_LOG", "SSHD", "SSH", "SSH_KEYGEN", "CONFIG_SSH", "TUNEL_PUBLICA", "HOST_PUBLICA", "DESHABILITADO"]), existe: f.existe, tamano: f.tamano };
    }),
    servicios: filas(r.servicios, 3, s => ({ nombre: enumValor(s?.nombre, ["sshd", "TrustedInstaller", "wuauserv"]),
      estado: enumValor(s.estado, ["AUSENTE", "Stopped", "StartPending", "StopPending", "Running", "ContinuePending", "PausePending", "Paused"]),
      inicio: enumValor(s.inicio, ["AUSENTE", "Automatic", "Manual", "Disabled", "Boot", "System"]) })),
    tareas: filas(r.tareas, 2, t => ({ nombre: enumValor(t?.nombre, ["AJB Predio", "AJB Mantenimiento SSH Tunel"]),
      estado: enumValor(t.estado, ["AUSENTE", "Unknown", "Disabled", "Queued", "Ready", "Running"]) })),
    procesos: filas(r.procesos, 64, p => {
      if (!entero(p?.pid) || !entero(p.padre)) invalido();
      return { nombre: enumValor(p.nombre, ["node.exe", "powershell.exe", "dism.exe", "dismhost.exe", "tiworker.exe", "trustedinstaller.exe", "msmpeng.exe", "ssh.exe", "sshd.exe"]), pid: p.pid, padre: p.padre };
    }),
    capacidades: filas(r.capacidades, 32, c => {
      if (typeof c?.paquete !== "string" || !/^[a-zA-Z0-9_.~+-]{1,256}$/.test(c.paquete) || !/openssh/i.test(c.paquete) || !(c.codigoEstado === null || entero(c.codigoEstado))) invalido();
      return { paquete: c.paquete, codigoEstado: c.codigoEstado };
    }),
    eventos: filas(r.eventos, 40, e => {
      if (!e || !(e.fecha === null || fecha(e.fecha)) || !(e.codigo === null || (typeof e.codigo === "string" && /^0x[0-9a-fA-F]{8}$/.test(e.codigo)))) invalido();
      return { origen: enumValor(e.origen, ["INSTALACION", "DISM"]),
        evento: enumValor(e.evento, ["INICIO", "INSTALANDO_CLIENTE", "INSTALANDO_SERVIDOR", "PREPARADO", "ERROR_REINICIO", "ERROR_CONFIG_SSH", "ERROR_CLAVES", "ERROR_CAPACIDAD", "ERROR_PERMISOS", "ERROR_OTRO", "ERROR_DISM"]), fecha: e.fecha, codigo: e.codigo };
    }),
    erroresLectura: filas(r.erroresLectura, 12, v => enumValor(v, ["ARCHIVOS", "SERVICIOS", "TAREAS", "PROCESOS", "CAPACIDADES", "MARCA", "LOG_INSTALACION", "LOG_DISM", "CLAVES", "USUARIO", "REINICIO"])) };
  for (const k of ["tunnelPublicKey", "sshHostPublicKey"]) {
    if (r[k] !== undefined && r[k] !== null) { if (!esClaveSshPublica(r[k])) invalido(); publico[k] = r[k]; }
  }
  return publico;
}

async function prepararAccesoSsh({ cuerpo, config, db, base, equipoId, instanciaId }, deps = {}) {
  const solicitud = validarSolicitud(cuerpo, { config, equipoId, instanciaId,
    propietarioId: leerMeta(db, "equipo_propietario_id"), restauracionPendiente: Boolean(leerMeta(db, "restauracion_pendiente")),
    plataforma: deps.plataforma || process.platform, ahora: deps.ahora === undefined ? Date.now() : deps.ahora });
  const ejecutar = deps.ejecutarArchivo || ejecutarArchivo;
  if (solicitud.accion === DIAGNOSTICO) {
    try {
      const script = path.join(__dirname, "..", "windows", "diagnosticar-mantenimiento-ssh.ps1");
      const stdout = await ejecutar("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { timeout: 90000 });
      return resultadoDiagnostico(stdout);
    } catch (e) {
      if (e.status) throw e;
      throw U.error("No se pudo completar el diagnóstico SSH en la notebook", 500);
    }
  }
  const carpeta = path.join(path.resolve(base), "mantenimiento-ssh");
  if (fs.existsSync(carpeta) && (!fs.lstatSync(carpeta).isDirectory() || fs.lstatSync(carpeta).isSymbolicLink())) throw U.error("La carpeta de mantenimiento SSH no es una carpeta local segura", 500);
  fs.mkdirSync(carpeta, { recursive: true, mode: 0o700 });
  const destino = path.join(carpeta, "policy.json");
  const temporal = path.join(carpeta, `policy.${crypto.randomBytes(12).toString("hex")}.tmp`);
  try {
    // Primero se elimina cualquier ACL explícita previa y luego se cierra la
    // herencia. El archivo nuevo hereda únicamente SYSTEM y Administradores.
    await ejecutar("icacls.exe", [carpeta, "/reset", "/Q"], { timeout: 15000 });
    await ejecutar("icacls.exe", [carpeta, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/Q"], { timeout: 15000 });
    const contenido = JSON.stringify(solicitud, null, 2);
    fs.writeFileSync(temporal, contenido, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporal, destino);
    const script = path.join(__dirname, "..", "windows", "configurar-mantenimiento-ssh.ps1");
    const stdout = await ejecutar("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-PolicyFile", destino], { timeout: 15 * 60 * 1000 });
    return resultadoPublico(stdout, solicitud);
  } catch (e) {
    if (e.status) throw e;
    // La salida libre del instalador nunca llega a los registros ni a la central.
    throw U.error("No se pudo completar la preparación del acceso SSH en la notebook", 500);
  } finally {
    if (fs.existsSync(temporal)) fs.unlinkSync(temporal);
  }
}

module.exports = { validarSolicitud, prepararAccesoSsh, resultadoPublico, resultadoDiagnostico, esClaveSshPublica };
