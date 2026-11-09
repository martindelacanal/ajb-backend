"use strict";

// Servidor local del predio (corre en la notebook del camping).
// Uso: node servidor.js --base C:\AJB-Predio
//   <base>/config.json        configuración (predio, servidor central, token, puerto)
//   <base>/datos/predio.db    base de datos SQLite
//   <base>/datos/respaldos/   copias diarias

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const os = require("node:os");
const { execFile } = require("node:child_process");
const U = require("./lib/util");
const { crearSqlite, asegurarEsquema, leerMeta, escribirMeta } = require("./lib/db-sqlite");
const api = require("./lib/api");
const sesion = require("./lib/api/sesion");
const { crearAgente } = require("./lib/agente");
const N = require("./lib/negocio");
const { crearControlEquipo } = require("./lib/control-equipo");
const { crearDescubrimiento } = require("./lib/descubrimiento");
const { crearUbicacionLan } = require("./lib/ubicacion-lan");
const { leerRuntime, invocarControl, migrarRuntime, prepararAccesoCaja } = require("./lib/runtime");
const { leerTls, prepararTls } = require("./lib/tls-local");
const { revisarPreciosVencidos } = require("./lib/precios");
const { listarRespaldos, rotarRespaldos } = require("./lib/rotacion-respaldos");
const { crearRespaldo } = require("./lib/respaldo-local");
const { ejecutarPeticion } = require("./lib/peticiones-idempotentes");
const { resolverActorRemoto } = require("./lib/actor-remoto");
const { bloquearInstalacion } = require("./lib/bloqueo-local");
const { aplicarPendiente } = require("./lib/respaldo-lan");
const { leerConfiguracionLan, crearServicioLan } = require("./lib/servicio-lan");
const { crearGrupoLocal, escribirHa } = require("./lib/grupo-local");
const { prepararRedQuorum } = require("./lib/quorum-lan");
const LAN = require("./lib/http-lan");

const DIR_APP = __dirname;
const DIR_PUBLICO = path.join(DIR_APP, "public");

function argumento(nombre, porDefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

const BASE = path.resolve(argumento("base", process.env.PREDIO_BASE || path.join(DIR_APP, ".local")));
fs.mkdirSync(path.join(BASE, "datos", "respaldos"), { recursive: true });

function log(mensaje) {
  console.log(`[${U.fechaHora()}] ${mensaje}`);
}

function leerConfig() {
  const archivo = path.join(BASE, "config.json");
  let config = {};
  if (fs.existsSync(archivo)) {
    try { config = JSON.parse(fs.readFileSync(archivo, "utf8").replace(/^\uFEFF/, "")); } catch (e) { log(`config.json ilegible: ${e.message}`); }
  }
  return {
    predio_id: Number(config.predio_id || process.env.PREDIO_ID || 1),
    predio_codigo: config.predio_codigo || process.env.PREDIO_CODIGO || "MIRAMAR",
    predio_nombre: config.predio_nombre || "Camping Miramar",
    servidor: config.servidor || process.env.PREDIO_SERVIDOR || "",
    token: config.token || process.env.PREDIO_TOKEN || "",
    puerto: Number(argumento("puerto", config.puerto || process.env.PREDIO_PUERTO || 8080)),
    actualizaciones_automaticas: config.actualizaciones_automaticas !== false,
    clave_publica: config.clave_publica || null,
    clave_lan: config.clave_lan || null,
  };
}

function leerVersion() {
  try { return fs.readFileSync(path.join(DIR_APP, ".version"), "utf8").trim(); } catch (_e) { /* desarrollo */ }
  try { return `${JSON.parse(fs.readFileSync(path.join(DIR_APP, "package.json"), "utf8")).version}+desarrollo`; } catch (_e) { return "desarrollo"; }
}

const config = leerConfig();
if (fs.existsSync(path.join(BASE, "arranque.js")) && leerRuntime(BASE).detenido) process.exit(0);
const VERSION = leerVersion();
const liberarInstalacion = bloquearInstalacion(BASE);
process.once("exit", liberarInstalacion);
let configHa = leerConfiguracionLan(BASE);
const recuperacionHa = configHa ? aplicarPendiente({ base: BASE, config: { ...config, respaldo_lan: configHa } }) : null;
const db = crearSqlite(path.join(BASE, "datos", "predio.db"), { predioId: config.predio_id });
if (!recuperacionHa?.incompatible) asegurarEsquema(db);
const controlEquipo = crearControlEquipo({ db, config, log });
let ha = null;
let congelado = fs.existsSync(path.join(BASE, "ha-activacion-pendiente.json"));
function autoridadLocal() {
  const e = ha?.estado();
  return { autorizado: !congelado && e?.escritor === true,
    motivo: !congelado && e?.escritor === true ? null : congelado ? "Preparando el respaldo automático. Las operaciones están pausadas hasta completar la activación."
      : e?.error || "Esta PC está de respaldo. El acceso de caja utiliza automáticamente el servidor actual.",
    otro_servidor: e?.testigo?.escritorDatos || null };
}
function instalarAutoridad(haNueva, packet) {
  configHa = haNueva;
  ha = crearServicioLan({ base: BASE, dirApp: DIR_APP, config, db, ha: haNueva, log,
    ubicarGrupo, puertoHttps: () => tlsCargado?.puerto,
    prepararQuorum: nueva => escribirHa(BASE, nueva),
    alReiniciar: () => { setTimeout(() => apagar(75), 100).unref(); } });
  if (packet) ha.registrarInicial(packet);
  controlEquipo.configurarAutoridadLocal(autoridadLocal);
  db.configurarTransacciones(ha);
  return ha;
}
if (configHa) instalarAutoridad(configHa);
else if (congelado) controlEquipo.configurarAutoridadLocal(autoridadLocal);
let descubrimiento = null;
let ubicacionGrupo = null;
let servidorHttps = null;
let tlsCargado = null;
let errorHttps = null;
let preparandoHttps = null;

function ubicarGrupo({ grupoId, claveDatos }) {
  ubicacionGrupo ??= crearUbicacionLan({ grupoId, claveDatos, nodoId: controlEquipo.equipoId, log,
    firmaAcceso: () => configHa?.quorum?.clavePrivada,
    puertos: () => ({ http: config.puerto, https: tlsCargado?.puerto, raft: configHa?.quorum?.puerto }) });
  return ubicacionGrupo;
}

function estadoHttps() {
  return { ...(tlsCargado?.publico || { preparado: false, puerto: 8443 }), activo: Boolean(servidorHttps?.listening),
    url: `https://${os.hostname().toLowerCase()}:${tlsCargado?.puerto || 8443}`,
    carpeta_certificados: path.join(BASE, "certificados-PCs"), error: errorHttps };
}

function runtimePublico() {
  return { ...leerRuntime(BASE), disponible: process.platform === "win32" && fs.existsSync(path.join(BASE, "arranque.js")) };
}

async function actualizarHttps() {
  if (preparandoHttps) return preparandoHttps;
  preparandoHttps = (async () => {
    try {
      await prepararTls(BASE);
      const datos = leerTls(BASE);
      if (datos.puerto === config.puerto) throw new Error("HTTPS necesita un puerto distinto al de HTTP");
      if (servidorHttps && tlsCargado?.puerto !== datos.puerto) {
        await new Promise((resolve) => servidorHttps.close(resolve));
        servidorHttps = null;
      }
      if (!servidorHttps) {
        const nuevo = https.createServer(datos.opciones, manejarSeguro);
        nuevo.keepAliveTimeout = 30000;
        nuevo.requestTimeout = 300000;
        await new Promise((resolve, reject) => {
          nuevo.once("error", reject);
          nuevo.listen(datos.puerto, "0.0.0.0", () => { nuevo.removeListener("error", reject); resolve(); });
        });
        nuevo.on("error", (e) => { errorHttps = e.message; log(`HTTPS local: ${e.message}`); });
        servidorHttps = nuevo;
        log(`HTTPS local disponible en https://${os.hostname().toLowerCase()}:${datos.puerto}; cada PC debe confiar una vez en el certificado del predio.`);
      } else if (tlsCargado?.hash !== datos.hash) {
        servidorHttps.setSecureContext(datos.opciones);
        log("Certificado HTTPS local renovado sin detener las ventas.");
      }
      tlsCargado = datos;
      errorHttps = null;
    } catch (e) {
      errorHttps = /ENOENT/.test(String(e.code)) ? "HTTPS todavía no está preparado en esta instalación." : e.message;
      if (runtimePublico().disponible) log(`HTTPS local: ${errorHttps}. HTTP sigue disponible.`);
    }
    return estadoHttps();
  })().finally(() => { preparandoHttps = null; });
  return preparandoHttps;
}

// ------------------------------------------------------------------ ejecución de órdenes remotas

async function ejecutarRemoto({ metodo, ruta, cuerpo, query, actor, db: dbOperacion = db }) {
  controlEquipo.comprobar();
  const encontrada = api.buscarRuta(metodo, ruta);
  if (!encontrada || encontrada.ruta.soloLocal || encontrada.ruta.publica) throw U.error("Operación no permitida a distancia", 403);
  const base = { db: dbOperacion, pid: config.predio_id, modo: "local", origen: "REMOTO", ip: "sistema-general", servicios };
  const usuarioRemoto = await resolverActorRemoto({ db: dbOperacion, pid: config.predio_id, actor });
  const ctx = {
    ...base,
    usuario: usuarioRemoto,
    hashClaveValidada: actor?.hash_clave_validada,
    sesion: {},
    query: query || {},
    body: cuerpo || {},
  };
  return api.ejecutar(ctx, metodo, ruta);
}

let salirConCodigo = null;
const servicios = { version: VERSION };
const agente = crearAgente({
  db, config, base: BASE, version: VERSION, log,
  controlEquipo,
  grupoLocal: () => ha ? { ...ha.estado(), relevoManual: !!configHa?.relevoManual } : { habilitado: congelado, escritor: false },
  pruebaHa: () => ha.pruebaCentral(),
  api: { ejecutarRemoto },
  alActualizar: () => apagar(75),
  alReiniciar: () => {
    if (runtimePublico().disponible) invocarControl(BASE, "Reiniciar").catch((e) => log(`No se pudo reiniciar el servidor: ${e.message}`));
    else apagar(75);
  },
});
servicios.agente = agente;
const grupoLocal = crearGrupoLocal({ base: BASE, dirApp: DIR_APP, version: VERSION, config, db,
  equipoId: controlEquipo.equipoId, haActual: () => ha?.estado(), configuracionHa: () => configHa, log,
  ubicarGrupo, consultarQuorum: () => ha?.consultarQuorum(),
  revisarRetiro: id => ha?.revisarRetiro(id),
  retirarQuorum: id => ha?.retirarQuorum(id),
  promoverQuorum: (r, disponibles, haQuorum, pedirEquipo) => ha.promoverQuorum(r, disponibles, haQuorum, pedirEquipo),
  bloquearEscritura() {
    const archivo = path.join(BASE, "ha-activacion-pendiente.json");
    if (!fs.existsSync(archivo)) {
      const fd = fs.openSync(archivo, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ iniciada: new Date().toISOString() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    congelado = true;
    controlEquipo.configurarAutoridadLocal(autoridadLocal);
    agente.detener();
    descubrimiento?.detener();
  },
  activarLocal({ ha: nueva, packet, autoridadIniciada = false }) {
    // grupo-local ya guardó la configuración con ACL privadas y fsync.
    if (runtimePublico().disponible) {
      const lanzador = path.join(BASE, "arranque.js"), temporal = lanzador + ".ha.tmp";
      const fd = fs.openSync(temporal, "w", 0o600);
      try { fs.writeFileSync(fd, fs.readFileSync(path.join(DIR_APP, "lanzador.js"))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporal, lanzador);
    }
    ha?.detener();
    instalarAutoridad(nueva, autoridadIniciada ? null : packet);
    return ha;
  },
  reiniciar() {
    // La semilla y el testigo ya están confirmados; el próximo arranque sigue
    // exclusivamente la autoridad del grupo, incluso tras un corte de luz.
    fs.rmSync(path.join(BASE, "ha-activacion-pendiente.json"), { force: true });
    congelado = false;
    setTimeout(() => {
      // Reinicia también el supervisor para que cargue la protección que impide
      // volver a una versión anterior que desconocía el grupo de respaldo.
      if (runtimePublico().disponible) invocarControl(BASE, "Reiniciar").catch(e => log("No se pudo reiniciar el supervisor; usá Reiniciar servidor: " + e.message));
      else apagar(75);
    }, 1200).unref();
  },
});

// ------------------------------------------------------------------ respaldos

function respaldar(motivo = "diario") {
  const carpeta = path.join(BASE, "datos", "respaldos");
  const prefijo = motivo === "diario" ? `predio-${U.hoy()}` : `predio-${U.fechaHora().replace(/[: ]/g, "-")}-${motivo}`;
  let nombre = prefijo + ".db";
  if (motivo === "diario" && fs.existsSync(path.join(carpeta, nombre))) { rotarRespaldos(carpeta); return null; }
  for (let n = 1; fs.existsSync(path.join(carpeta, nombre)); n++) nombre = prefijo + "-" + n + ".db";
  const destino = path.join(carpeta, nombre);
  // No publica ni cuenta una copia parcial si se interrumpe VACUUM.
  const temporal = destino + ".tmp";
  fs.rmSync(temporal, { force: true });
  db.conexion.exec(`VACUUM INTO '${temporal.replace(/'/g, "''")}'`);
  fs.renameSync(temporal, destino);
  rotarRespaldos(carpeta);
  log(`Respaldo creado: ${nombre}`);
  return nombre;
}

function respaldoDiario() {
  db.exclusivo(() => respaldar("diario")).catch((e) => log(`No se pudo respaldar: ${e.message}`));
}

// ------------------------------------------------------------------ rutas de sistema (sólo administradores)

function direccionesLan(interfaces = os.networkInterfaces()) {
  const salida = [];
  for (const [nombre, lista] of Object.entries(interfaces)) {
    for (const d of lista || []) {
      if (d.family === "IPv4" && !d.internal) salida.push({ interfaz: nombre, ip: d.address, url: `http://${d.address}${config.puerto === 80 ? "" : `:${config.puerto}`}` });
    }
  }
  return salida;
}

function relevoLan(req, estado = ha?.estado()) {
  if (congelado || !estado?.escritor) return null;
  const principal = estado.testigo?.preferido_id || estado.miembros.find(m => m.preferido)?.id;
  if (!principal || estado.nodoId === principal) return null;

  const interfaces = os.networkInterfaces();
  const direcciones = direccionesLan(interfaces).filter(d => !d.ip.startsWith("169.254."));
  const entrada = String(req.socket.localAddress || "").replace(/^::ffff:/, "");
  let elegida = direcciones.find(d => d.ip === entrada);
  if (!elegida) {
    // En localhost, priorizar la interfaz que comparte red con los equipos del grupo.
    const deSubred = ips => direcciones.find(d => interfaces[d.interfaz].some(i =>
      i.address === d.ip && ips.some(ip => mismaSubred(ip, i))));
    const ipsDetectadas = estado.miembros.filter(m => m.id !== estado.nodoId)
      .map(m => ubicacionGrupo?.equipo(m.id)?.ip).filter(Boolean);
    elegida = deSubred(ipsDetectadas) || deSubred(estado.miembros.map(m => new URL(m.url).hostname)) || direcciones[0];
  }
  return elegida ? { url: elegida.url } : null;
}

// ------------------------------------------------------------------ nombre de la notebook en la red
// Las PCs de la LAN pueden entrar con el nombre del equipo (http://camping:8080) en lugar de la IP:
// Windows lo anuncia solo (NetBIOS/LLMNR). Cambiarlo es renombrar el equipo: se aplica al reiniciar.

function estadoRed() {
  const sufijo = config.puerto === 80 ? "" : `:${config.puerto}`;
  const nombre = os.hostname();
  const pendiente = leerMeta(db, "nombre_red_pendiente");
  return {
    nombre,
    pendiente: pendiente && pendiente.toUpperCase() !== nombre.toUpperCase() ? pendiente : null,
    por_nombre: `http://${nombre.toLowerCase()}${sufijo}`,
    direcciones: direccionesLan(),
    puede_cambiar: process.platform === "win32",
  };
}

function ejecutarPowershell(script) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 90000, windowsHide: true }, (e, salida, errores) => {
        if (e) reject(new Error(String(errores || e.message).trim().split(/\r?\n/).slice(0, 3).join(" ")));
        else resolve(String(salida || ""));
      });
  });
}

async function cambiarNombreRed(ctx, nombre) {
  nombre = String(nombre || "").trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{1,14}$/.test(nombre) || nombre.endsWith("-")) {
    throw U.error("Usá de 2 a 15 letras, números o guiones, empezando con una letra. Por ejemplo: CAMPING");
  }
  if (process.platform !== "win32") throw U.error("El nombre en la red se cambia en la notebook servidor (Windows)", 409);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `if ($env:COMPUTERNAME -ne '${nombre}') { Rename-Computer -NewName '${nombre}' -Force -WarningAction SilentlyContinue }`,
    // Que la notebook responda cuando las PCs preguntan por su nombre (NetBIOS, mDNS y LLMNR).
    "Get-NetFirewallRule -DisplayName 'AJB Predio (nombre en la red)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
    "New-NetFirewallRule -DisplayName 'AJB Predio (nombre en la red)' -Direction Inbound -Protocol UDP -LocalPort 137,5353,5355 -Action Allow -Profile Any | Out-Null",
  ].join("; ");
  try {
    await ejecutarPowershell(script);
  } catch (e) {
    throw U.error(`Windows no dejó cambiar el nombre: ${e.message.slice(0, 240)}`, 409);
  }
  escribirMeta(db, "nombre_red_pendiente", nombre.toUpperCase());
  await db.tx((t) => N.auditar(t, ctx, "Cambio del nombre de la notebook en la red", "sistema", null, { antes: os.hostname(), despues: nombre.toUpperCase() }));
  return { ...estadoRed(), mensaje: `Listo: la notebook se va a llamar ${nombre.toUpperCase()} después de reiniciarla.` };
}

// ------------------------------------------------------------------ galería del ingreso
// Las fotos del ingreso son las de la galería del sistema general (Mi AJB). Se bajan cuando hay
// internet y quedan guardadas en la notebook, así se ven aunque se corte; sin fotos, va el logo.

const DIR_GALERIA = path.join(BASE, "datos", "galeria");
const TIPOS_GALERIA = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" };
let galeriaEnCurso = null;

function leerGaleria() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR_GALERIA, "indice.json"), "utf8")); } catch (_e) { return { fecha: null, imagenes: [] }; }
}

function actualizarGaleria() {
  if (!config.servidor) return Promise.resolve(leerGaleria());
  if (galeriaEnCurso) return galeriaEnCurso;
  galeriaEnCurso = (async () => {
    fs.mkdirSync(DIR_GALERIA, { recursive: true });
    const r = await fetch(`${config.servidor.replace(/\/+$/, "")}/login/imagenes`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const lista = await r.json();
    const previa = leerGaleria();
    const imagenes = [];
    for (const img of (Array.isArray(lista) ? lista : []).filter((i) => i && i.imagen_url).slice(0, 10)) {
      const clave = U.sha256(String(img.archivo || img.id || String(img.imagen_url).split("?")[0])).slice(0, 16);
      const guardada = previa.imagenes.find((x) => x.clave === clave && fs.existsSync(path.join(DIR_GALERIA, x.archivo)));
      if (guardada) { imagenes.push(guardada); continue; }
      try {
        const d = await fetch(img.imagen_url, { signal: AbortSignal.timeout(30000) });
        const tipo = String(d.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!d.ok || !TIPOS_GALERIA[tipo]) continue;
        const buffer = Buffer.from(await d.arrayBuffer());
        if (!buffer.length || buffer.length > 8 * 1024 * 1024) continue;
        const archivo = `${clave}${TIPOS_GALERIA[tipo]}`;
        fs.writeFileSync(path.join(DIR_GALERIA, archivo), buffer);
        imagenes.push({ clave, archivo, tipo });
      } catch (e) {
        log(`Galería del ingreso: no se pudo bajar una foto (${e.message})`);
      }
    }
    const indice = { fecha: U.fechaHora(), imagenes };
    fs.writeFileSync(path.join(DIR_GALERIA, "indice.json"), JSON.stringify(indice));
    for (const f of fs.readdirSync(DIR_GALERIA)) {
      if (f !== "indice.json" && !imagenes.some((x) => x.archivo === f)) fs.rmSync(path.join(DIR_GALERIA, f), { force: true });
    }
    return indice;
  })().finally(() => { galeriaEnCurso = null; });
  return galeriaEnCurso;
}

function rutaGaleria(req, res, rutaApi) {
  if (rutaApi === "/login/imagenes") {
    const g = leerGaleria();
    const vieja = !g.fecha || Date.now() - Date.parse(`${g.fecha.replace(" ", "T")}-03:00`) > 6 * 3600 * 1000;
    if (vieja) actualizarGaleria().catch(() => { /* sin internet: quedan las guardadas */ });
    return enviar(req, res, 200, { imagenes: g.imagenes.map((x) => ({ url: `login/imagen/${x.archivo}` })) });
  }
  const m = /^\/login\/imagen\/([a-f0-9]{16}\.(jpg|png|webp|gif|avif))$/.exec(rutaApi);
  const archivo = m && path.join(DIR_GALERIA, m[1]);
  if (!archivo || !fs.existsSync(archivo)) return enviar(req, res, 404, { mensaje: "No encontrada" });
  const tipo = Object.keys(TIPOS_GALERIA).find((t) => TIPOS_GALERIA[t] === `.${m[2]}`);
  return enviar(req, res, 200, fs.readFileSync(archivo), tipo, { "Cache-Control": "public, max-age=86400" });
}

async function rutaSistema(ctx, metodo, ruta, req, res) {
  if (ctx.usuario?.rol !== "ADMIN") throw U.error("Esta sección es del administrador", 403);
  if (metodo === "GET" && ruta === "/sistema/grupo-local") return grupoLocal.estado();
  if (metodo === "POST" && ruta === "/sistema/grupo-local/solo-principal") {
    controlEquipo.comprobar();
    if (!configHa?.quorum || !ha) throw U.error("Esta opción requiere un grupo con relevo automático", 409);
    const { activo } = await leerCuerpo(req, 1000);
    if (typeof activo !== "boolean") throw U.error("Elegí si la notebook queda como único servidor", 400);
    return ha.configurarSoloPrincipal(activo);
  }
  if (metodo === "POST" && ruta === "/sistema/grupo-local/incorporar-equipo") {
    controlEquipo.comprobar();
    // El botón puede usarse desde HTTP en la LAN. La transferencia de datos
    // y credenciales del equipo se realiza por el canal interno con CA fijada.
    const ip = ha?.origenIncorporacion(req.headers["x-ajb-origen"], ctx.ip) || ctx.ip;
    if (!esIpLocal(ip) || ip.startsWith("127.")) throw U.error("Abrí el sistema desde la PC de la red que vas a incorporar", 409);
    await leerCuerpo(req, 1000);
    const seguro = await actualizarHttps();
    if (!seguro.activo) throw U.error("No se pudo preparar la conexión interna entre las PCs", 409);
    const paquete = await grupoLocal.instalador("Respaldo", { equipo: true, ip, direccion: req.socket.localAddress });
    return { archivo: paquete.buffer, nombreArchivo: "AJB-Incorporar-esta-PC.zip", tipo: "application/zip" };
  }
  if (metodo === "POST" && ruta === "/sistema/grupo-local/acceso-caja") {
    controlEquipo.comprobar();
    await leerCuerpo(req, 1000);
    const paquete = await grupoLocal.instaladorAcceso();
    return { archivo: paquete.buffer, nombreArchivo: "AJB-Acceso-de-caja.zip", tipo: "application/zip" };
  }
  if (metodo === "POST" && ruta === "/sistema/grupo-local/quitar-respaldo") {
    controlEquipo.comprobar();
    const { equipoId } = await leerCuerpo(req, 1000);
    return grupoLocal.quitarRespaldo(equipoId);
  }
  if (metodo === "POST" && ruta === "/sistema/grupo-local/instalador") {
    controlEquipo.comprobar();
    if (!req.socket.encrypted && !ctx.esLocalhost) throw U.error("Prepará el instalador desde HTTPS o desde esta PC servidor", 409);
    const cuerpo = await leerCuerpo(req, 1000);
    const paquete = await grupoLocal.instalador(cuerpo.rol);
    return { archivo: paquete.buffer, nombreArchivo: paquete.nombreArchivo, tipo: "application/zip" };
  }
  if (metodo === "POST" && ruta === "/sistema/grupo-local/activar") {
    await leerCuerpo(req, 1000);
    return grupoLocal.activar();
  }
  if (metodo === "POST" && ruta === "/sistema/grupo-local/configurar-relevo-manual") {
    controlEquipo.comprobar();
    await leerCuerpo(req, 1000);
    return grupoLocal.configurarManual();
  }
  if (metodo === "GET" && ruta === "/sistema/estado") {
    const respaldos = listarRespaldos(path.join(BASE, "datos", "respaldos")).map(({ nombre, tamano }) => ({ nombre, tamano }));
    const tamano = fs.existsSync(db.archivo) ? fs.statSync(db.archivo).size : 0;
    const estadoGrupo = ha?.estado() || null;
    return {
      sincronizacion: agente.estadoPublico(),
      equipo: { nombre: os.hostname(), sistema: `${os.type()} ${os.release()}`, node: process.version, memoria_libre: os.freemem(), memoria_total: os.totalmem(), encendido_hace: Math.round(os.uptime()) },
      servidor: { puerto: config.puerto, direcciones: direccionesLan(), base: BASE, version: VERSION, iniciado: servidorIniciado },
      red: estadoRed(),
      runtime: runtimePublico(), escritura: controlEquipo.estado(), https: estadoHttps(), grupo_local: estadoGrupo,
      relevo_lan: relevoLan(req, estadoGrupo),
      base_datos: { archivo: db.archivo, tamano },
      respaldos,
    };
  }
  if (metodo === "POST" && ruta === "/sistema/arranque") {
    if (!runtimePublico().disponible) throw U.error("El arranque se configura en la instalación portable de Windows", 409);
    const cuerpo = await leerCuerpo(req, 1000);
    if (typeof cuerpo.automatico !== "boolean") throw U.error("Indicá si el arranque debe ser automático");
    await invocarControl(BASE, "Configurar", { automatico: cuerpo.automatico });
    await db.tx((t) => N.auditar(t, ctx, "Configuración del arranque del servidor", "sistema", null, { automatico: cuerpo.automatico }));
    return { mensaje: cuerpo.automatico ? "El servidor se iniciará al encender Windows." : "El servidor queda en inicio manual. Seguirá funcionando hasta que lo detengas.", runtime: runtimePublico() };
  }
  if (metodo === "POST" && ["/sistema/servidor/detener", "/sistema/servidor/reiniciar"].includes(ruta)) {
    if (!runtimePublico().disponible) throw U.error("Este control corresponde a la instalación portable de Windows", 409);
    const reiniciar = ruta.endsWith("/reiniciar");
    await db.tx((t) => N.auditar(t, ctx, reiniciar ? "Reinicio del servidor" : "Detención intencional del servidor", "sistema", null, { autoarranque: reiniciar }));
    await invocarControl(BASE, reiniciar ? "Reiniciar" : "Detener");
    return { mensaje: reiniciar ? "El servidor se reinicia y vuelve a quedar con arranque automático." : "El servidor se detiene y desactiva el arranque automático. Para volver a iniciarlo, usá las herramientas de la notebook.", reiniciando: reiniciar };
  }
  if (metodo === "POST" && ruta === "/sistema/https/preparar") {
    if (!runtimePublico().disponible) throw U.error("HTTPS se prepara en la instalación portable de Windows", 409);
    const estado = await actualizarHttps();
    if (!estado.activo) throw U.error(estado.error || "No se pudo iniciar HTTPS", 409);
    return { mensaje: "HTTPS está listo. Configurá la confianza del certificado una vez en cada PC del camping.", https: estado };
  }
  if (metodo === "GET" && ruta === "/sistema/https/certificado") {
    if (!tlsCargado) throw U.error("El certificado HTTPS todavía no está preparado", 404);
    return { archivo: tlsCargado.raiz, nombreArchivo: "autoridad.cer", tipo: "application/pkix-cert" };
  }
  if (metodo === "GET" && ruta === "/sistema/red") return estadoRed();
  if (metodo === "POST" && ruta === "/sistema/red") {
    const cuerpo = await leerCuerpo(req, 10000);
    return cambiarNombreRed(ctx, cuerpo.nombre);
  }
  if (metodo === "POST" && ruta === "/sistema/reiniciar-equipo") {
    if (process.platform !== "win32") throw U.error("Esto se hace en la notebook servidor (Windows)", 409);
    await db.tx((t) => N.auditar(t, ctx, "Reinicio de la notebook servidor", "sistema", null, null));
    execFile("shutdown.exe", ["/r", "/t", "20", "/c", "AJB Predio: reinicio pedido por el administrador"], { windowsHide: true }, (e) => {
      if (e) log(`No se pudo reiniciar la notebook: ${e.message}`);
    });
    return { mensaje: leerRuntime(BASE).autoarranque ? "La notebook se reinicia en 20 segundos. El sistema vuelve solo en uno o dos minutos." : "La notebook se reinicia en 20 segundos. El servidor está configurado en inicio manual: después usá iniciar-servidor.bat." };
  }
  if (metodo === "POST" && ruta === "/sistema/sincronizar") {
    const r = await agente.sincronizarAhora();
    await db.tx((t) => N.auditar(t, ctx, "Sincronización manual", "sistema", null, null));
    return { mensaje: "Sincronizado con el sistema general", estado: r };
  }
  if (metodo === "POST" && ruta === "/sistema/actualizar") {
    const r = await agente.buscarActualizacion(true);
    if (r && r.actualizado) return { mensaje: `Se instaló la versión ${r.version}. El sistema se reinicia en unos segundos.`, reiniciando: true };
    return { mensaje: "Ya tenés la última versión", version: VERSION };
  }
  if (metodo === "POST" && ruta === "/sistema/respaldo") {
    const nombre = await db.exclusivo(() => respaldar("manual"));
    await db.tx((t) => N.auditar(t, ctx, "Respaldo manual", "sistema", null, { archivo: nombre }));
    return { mensaje: "Respaldo creado", archivo: nombre };
  }
  if (metodo === "POST" && ruta === "/sistema/respaldo-completo") {
    controlEquipo.comprobar();
    const cuerpo = await leerCuerpo(req, 16 * 1024);
    if (typeof cuerpo.clave !== "string" || cuerpo.clave.length < 12 || cuerpo.clave.length > 1024) throw U.error("La clave de recuperación debe tener entre 12 y 1024 caracteres");
    const copia = await crearRespaldo({ db, base: BASE, config, clave: cuerpo.clave, version: VERSION });
    await db.tx((t) => N.auditar(t, ctx, "Exportación de respaldo completo", "sistema", null, { archivo: copia.nombre, bytes: copia.buffer.length, sha256: copia.sha256 }));
    return { archivo: copia.buffer, nombreArchivo: copia.nombre, tipo: "application/octet-stream" };
  }
  const descarga = /^\/sistema\/respaldos\/([A-Za-z0-9._-]+\.db)$/.exec(ruta);
  if (metodo === "GET" && descarga) {
    const archivo = path.join(BASE, "datos", "respaldos", descarga[1]);
    if (!fs.existsSync(archivo)) throw U.error("No encontramos ese respaldo", 404);
    return { archivo: fs.readFileSync(archivo), nombreArchivo: descarga[1], tipo: "application/octet-stream" };
  }
  if (metodo === "GET" && ruta === "/sistema/exportar") {
    if (ha) throw U.error("Con respaldo automático, sincronizá desde la PC que está en servicio cuando vuelva internet. Para recuperar otra PC usá el respaldo completo.", 409);
    const { buffer, nombre } = await agente.exportar();
    await db.tx((t) => N.auditar(t, ctx, "Exportación de datos para el sistema general", "sistema", null, { archivo: nombre, bytes: buffer.length }));
    return { archivo: buffer, nombreArchivo: nombre, tipo: "application/octet-stream" };
  }
  if (metodo === "POST" && ruta === "/sistema/importar") {
    const buffer = await leerCuerpo(req, 300 * 1024 * 1024, true);
    await db.exclusivo(() => respaldar("antes-de-importar"));
    const r = await agente.importarPaquete(buffer);
    await db.tx((t) => N.auditar(t, ctx, "Importación de paquete del sistema general", "sistema", null, r));
    return { mensaje: "Paquete aplicado", resumen: r };
  }
  throw U.error("No encontramos esa operación", 404);
}

// ------------------------------------------------------------------ HTTP

const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".webp": "image/webp", ".jpeg": "image/jpeg", ".gif": "image/gif", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};

function cabecerasSeguridad(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
}

function enviar(req, res, status, cuerpo, tipo = "application/json; charset=utf-8", extra = {}) {
  let datos = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo));
  const cabeceras = { "Content-Type": tipo, ...extra };
  if (datos.length > 4096 && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /json|text|javascript|css|svg/.test(tipo)) {
    datos = zlib.gzipSync(datos, { level: 5 });
    cabeceras["Content-Encoding"] = "gzip";
    cabeceras.Vary = "Accept-Encoding";
  }
  cabeceras["Content-Length"] = datos.length;
  res.writeHead(status, cabeceras);
  res.end(req.method === "HEAD" ? undefined : datos);
}

function leerCuerpo(req, limite, binario = false) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > limite) { reject(U.error("El contenido enviado es demasiado grande", 413)); req.destroy(); return; }
      partes.push(c);
    });
    req.on("end", () => {
      const buffer = Buffer.concat(partes);
      if (binario) return resolve(buffer);
      if (!buffer.length) return resolve({});
      try { resolve(JSON.parse(buffer.toString("utf8"))); } catch (_e) { reject(U.error("El contenido enviado no es válido", 400)); }
    });
    req.on("error", reject);
  });
}

function servirEstatico(req, res, ruta) {
  if (ruta === "/crear-acceso-pc-caja.bat") {
    const plantilla = fs.readFileSync(path.join(DIR_APP, "windows", "crear-acceso-pc-caja.bat"), "utf8");
    const host = req.headers.host || "";
    // Sólo un nombre/IP y puerto pueden incorporarse al BAT; el archivo también funciona sin dirección.
    const valido = /^(?:[a-z0-9._-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(host);
    const origen = valido ? (req.socket.encrypted ? "https://" : "http://") + host : "";
    const contenido = plantilla.replace('set "AJB_DIRECCION="', 'set "AJB_DIRECCION=' + origen + '"');
    return enviar(req, res, 200, contenido.replace(/\r?\n/g, "\r\n"), "application/octet-stream", {
      "Content-Disposition": 'attachment; filename="crear-acceso-pc-caja.bat"', "Cache-Control": "no-store",
    });
  }
  let relativo = decodeURIComponent(ruta.split("?")[0]);
  if (relativo === "/" || relativo === "") relativo = "/index.html";
  const archivo = path.normalize(path.join(DIR_PUBLICO, relativo));
  if (!archivo.startsWith(DIR_PUBLICO)) return enviar(req, res, 403, "Prohibido", "text/plain; charset=utf-8");
  let final = archivo;
  if (!fs.existsSync(final) || fs.statSync(final).isDirectory()) {
    if (path.extname(relativo)) return enviar(req, res, 404, "No encontrado", "text/plain; charset=utf-8");
    final = path.join(DIR_PUBLICO, "index.html");
  }
  const ext = path.extname(final).toLowerCase();
  const esIndice = final.endsWith("index.html");
  let contenido = fs.readFileSync(final);
  if (esIndice) contenido = Buffer.from(contenido.toString("utf8").replace(/__VERSION__/g, encodeURIComponent(VERSION)).replace("<html", `<html data-ha="${ha ? "1" : "0"}"`));
  enviar(req, res, 200, contenido, TIPOS[ext] || "application/octet-stream", {
    "Cache-Control": esIndice ? "no-cache" : "public, max-age=604800, immutable",
  });
}

function ipDe(req) {
  return String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}
function mismaSubred(ip, i) {
  if (i.internal || i.family !== "IPv4" || !i.netmask) return false;
  const octetos = ip.split(".").map(Number);
  if (octetos.length !== 4 || octetos.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const propia = i.address.split(".").map(Number), mascara = i.netmask.split(".").map(Number);
  return octetos.every((n, j) => (n & mascara[j]) === (propia[j] & mascara[j]));
}
function esIpLocal(ip) {
  return Object.values(os.networkInterfaces()).flat().some(i => mismaSubred(ip, i));
}

function origenCajaLocal(req) {
  const host = req.headers.host || "";
  if (!["127.0.0.1", "::1"].includes(ipDe(req)) ||
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return null;
  let origen;
  try { origen = new URL((req.socket.encrypted ? "https://" : "http://") + host); } catch (_e) { return null; }
  if (Number(origen.port || (req.socket.encrypted ? 443 : 80)) !== req.socket.localPort) return null;
  return origen.origin;
}

async function pantallaRelevo(req, res) {
  const origen = origenCajaLocal(req);
  if (!origen || !["GET", "POST"].includes(req.method)) return enviar(req, res, 403, { mensaje: "Abrí el relevo en la PC de caja" });
  const seguro = texto => String(texto).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  let estado, mensaje, status = 200, activado = false;
  try {
    estado = ha.relevoLocal();
    if (req.method === "POST") {
      if (req.headers.origin !== origen || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers["content-type"] || "")) {
        return enviar(req, res, 403, { mensaje: "Abrí el formulario desde la PC de caja" });
      }
      const datos = new URLSearchParams((await leerCuerpo(req, 4096, true)).toString("utf8"));
      if (datos.get("principalApagada") !== "si") throw U.error("Confirmá que la principal está apagada", 400);
      const revision = await ha.habilitarRelevo({ usuario: datos.get("usuario"), password: datos.get("password") });
      mensaje = `Relevo autorizado con la revisión ${revision.indice}. Esperá unos segundos y volvé al sistema.`;
      activado = true;
    }
  } catch (e) {
    status = e.status || 503;
    mensaje = e.message;
  }
  const disponible = estado && !estado.escritor && !estado.cuarentena_ms && !estado.bloqueado && !estado.manual_activo && !activado;
  const texto = mensaje || (estado?.manual_activo ? "El relevo está autorizado. Volvé al sistema cuando termine de preparar la copia."
    : estado?.escritor ? "Todavía hay una PC autorizada. Si apagaste la principal, esperá unos segundos y actualizá esta página."
    : estado?.cuarentena_ms ? "La caja está arrancando. Esperá unos segundos y actualizá esta página."
    : estado?.bloqueado || !estado ? "La caja todavía no puede verificar la última copia." : "Usá la cuenta de un administrador del predio.");
  const formulario = disponible ? `<form method="post" action="/relevo-manual">
    <label>Usuario o DNI <input name="usuario" autocomplete="username" required maxlength="100"></label>
    <label>Contraseña <input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
    <label><input type="checkbox" name="principalApagada" value="si" required> Confirmo que la PC principal está apagada.</label>
    <button type="submit">Tomar el relevo con la última copia</button>
  </form>` : "";
  return enviar(req, res, status, `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Relevo manual del camping</title><style>body{font:1rem system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
    label{display:block;margin:1rem 0}input,button{font:inherit}a{margin-right:1rem}</style>
    <main><h1>Relevo manual del camping</h1><p role="status">${seguro(texto)}</p>${formulario}
    <p><a href="/">Volver al sistema</a><a href="/relevo-manual">Actualizar estado</a></p></main></html>`,
  "text/html; charset=utf-8", { "Cache-Control": "no-store" });
}

async function manejar(req, res) {
  cabecerasSeguridad(res);
  const url = new URL(req.url, "http://local");
  const ruta = url.pathname;
  if (ruta === "/lan/incorporar") {
    if (!req.socket.encrypted || req.method !== "POST") return LAN.respuesta(res, 403, { mensaje: "La incorporación necesita HTTPS" });
    try {
      const cuerpo = await LAN.leer(req, 128 * 1024);
      return LAN.respuesta(res, 200, await grupoLocal.incorporar({ metodo: req.method, ruta: req.url, cabeceras: req.headers, cuerpo, ip: ipDe(req) }));
    } catch (e) { return LAN.respuestaError(res, e); }
  }
  if (ruta.startsWith("/lan/")) {
    if (ruta === "/lan/quorum/estado" && !req.socket.encrypted && ipDe(req) !== "127.0.0.1" && !esIpLocal(ipDe(req))) {
      return LAN.respuesta(res, 403, { mensaje: "Esta consulta está disponible en la red local del predio" });
    }
    if (ha && await ha.manejar(req, res)) return;
    return LAN.respuesta(res, 404, { mensaje: "No encontramos esa operación" });
  }
  const cajaRelevo = configHa?.relevoManual?.cajaId === controlEquipo.equipoId;
  if (cajaRelevo && ruta === "/relevo-manual") return pantallaRelevo(req, res);
  if (ha && !congelado && !ha.estado().escritor) {
    const accesoCaja = cajaRelevo && req.method === "GET" && ruta === "/" && origenCajaLocal(req);
    return ha.reenviar(req, res, accesoCaja ? () => enviar(req, res, 303, "", "text/plain", { Location: "/relevo-manual", "Cache-Control": "no-store" }) : undefined);
  }
  if (!ruta.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") return enviar(req, res, 405, { mensaje: "Método no permitido" });
    return servirEstatico(req, res, ruta);
  }
  res.setHeader("Cache-Control", "no-store");
  const rutaApi = ruta.slice(4);
  const ip = ipDe(req);
  const ctx = {
    db, pid: config.predio_id, modo: "local", origen: "LOCAL", ip,
    esLocalhost: ip === "127.0.0.1" || ip === "::1",
    agenteHttp: req.headers["user-agent"] || "", servicios,
    soloLectura: !controlEquipo.puedeEscribir(),
    query: Object.fromEntries(url.searchParams.entries()),
  };
  try {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
    const auth = await sesion.autenticar(ctx, token);
    if (auth) Object.assign(ctx, auth);
    require("./lib/claves-usuario").exigirCambio(ctx.usuario, req.method, rutaApi);
    if ((req.method === "GET" || req.method === "HEAD") && rutaApi.startsWith("/login/imagen")) return rutaGaleria(req, res, rutaApi);
    if (rutaApi.startsWith("/sistema/")) {
      if (!ctx.usuario) throw U.error("Iniciá sesión para continuar", 401, { codigo: "SIN_SESION" });
      if (req.method === "POST" && rutaApi === "/sistema/importar") controlEquipo.comprobar();
      const r = await rutaSistema(ctx, req.method, rutaApi, req, res);
      if (r && r.archivo) {
        return enviar(req, res, 200, r.archivo, r.tipo, { "Content-Disposition": `attachment; filename="${r.nombreArchivo}"` });
      }
      return enviar(req, res, 200, r);
    }
    ctx.body = req.method === "GET" || req.method === "HEAD" ? {} : await leerCuerpo(req, 3 * 1024 * 1024);
    const encontrada = api.buscarRuta(req.method === "HEAD" ? "GET" : req.method, rutaApi);
    if (encontrada?.ruta.escritura || rutaApi === "/sesion/puesto" || (rutaApi === "/primer-uso" && agente.configurado())) controlEquipo.comprobar();
    const operacionId = req.headers["x-ajb-operacion"];
    if (ha && encontrada?.ruta.escritura && ctx.usuario && !operacionId) throw U.error("Actualizá la pantalla antes de registrar la operación", 409, { codigo: "OPERACION_SIN_IDENTIFICADOR" });
    if (operacionId && ctx.usuario && !["GET", "HEAD"].includes(req.method) && ctx.db.dialecto === "sqlite") {
      // Los intentos fallidos con la contraseña del administrador se auditan aunque la petición se revierta.
      if (encontrada?.ruta.p === "/permisos/presencial") ctx.dbAuditoria = db;
      const r = await ejecutarPeticion(ctx, { id: operacionId, metodo: req.method, ruta: rutaApi }, (contexto) => api.ejecutar(contexto, req.method, rutaApi));
      return enviar(req, res, r.status, r.respuesta);
    }
    const resultado = await api.ejecutar(ctx, req.method === "HEAD" ? "GET" : req.method, rutaApi);
    if (rutaApi === "/estado-publico" && resultado) resultado.escritura = controlEquipo.estado();
    if (rutaApi === "/inicio" && resultado && ["ADMIN", "SUPERVISOR"].includes(ctx.usuario?.rol)) resultado.relevo_lan = relevoLan(req);
    if (resultado && resultado.csv !== undefined) {
      return enviar(req, res, 200, resultado.csv, "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename="${resultado.nombreArchivo}"` });
    }
    return enviar(req, res, 200, resultado === undefined ? { ok: true } : resultado);
  } catch (e) {
    if (e instanceof U.ErrorPredio || e.status) {
      const { status, message, name, stack, ...extra } = e;
      return enviar(req, res, e.status || 400, { mensaje: e.message, ...extra });
    }
    log(`Error en ${req.method} ${ruta}: ${e.stack || e.message}`);
    return enviar(req, res, 500, { mensaje: "Ocurrió un error inesperado. Volvé a intentar; si sigue pasando avisá al administrador." });
  }
}

function manejarSeguro(req, res) {
  manejar(req, res).catch((e) => {
    log(`Error no controlado: ${e.stack || e.message}`);
    try { enviar(req, res, 500, { mensaje: "Error interno" }); } catch (_e) { /* respuesta enviada */ }
  });
}
const servidor = http.createServer(manejarSeguro);
servidor.keepAliveTimeout = 30000;
servidor.requestTimeout = 300000;

let servidorIniciado = null;
let apagando = false;

function apagar(codigo = 0) {
  if (apagando) return;
  apagando = true;
  salirConCodigo = codigo;
  log(codigo === 75 ? "Reiniciando para aplicar cambios…" : "Apagando el servidor…");
  agente.detener();
  ha?.detener();
  descubrimiento?.detener();
  ubicacionGrupo?.detener();
  const abiertos = [servidor, servidorHttps].filter((s) => s?.listening);
  let restantes = abiertos.length;
  function cerrar() { if (--restantes <= 0) { db.cerrar(); process.exit(salirConCodigo || 0); } }
  for (const s of abiertos) s.close(cerrar);
  if (!restantes) { db.cerrar(); process.exit(salirConCodigo || 0); }
  setTimeout(() => { db.cerrar(); process.exit(salirConCodigo || 0); }, 4000).unref();
}

process.on("SIGINT", () => apagar(0));
process.on("SIGTERM", () => apagar(0));
process.on("uncaughtException", (e) => { log(`Excepción no controlada: ${e.stack || e.message}`); });
process.on("unhandledRejection", (e) => { log(`Promesa rechazada: ${e?.stack || e}`); });

servidor.on("error", (e) => {
  log(e.code === "EADDRINUSE" ? `El puerto ${config.puerto} está ocupado por otro programa.` : `Error del servidor: ${e.message}`);
  process.exit(1);
});

servidor.listen(config.puerto, "0.0.0.0", () => {
  servidorIniciado = U.fechaHora();
  escribirMeta(db, "ultimo_inicio", servidorIniciado);
  log(`Sistema del predio ${config.predio_nombre} v${VERSION} escuchando en el puerto ${config.puerto}`);
  for (const d of direccionesLan()) log(`  Abrí en las PCs del camping: ${d.url}`);
  if (!agente.configurado()) log("  Sin vincular al sistema general: funciona sólo en la red local.");
  if (agente.configurado() && !ha && !congelado) {
    descubrimiento = crearDescubrimiento({ codigo: config.predio_codigo, puertoHttp: config.puerto,
      equipoId: controlEquipo.equipoId, instanciaId: agente.instancia(), clave: () => config.clave_lan,
      puedeSerEscritor: () => controlEquipo.puedeAnunciarEscritor(),
      alOtro: (otro) => controlEquipo.otroServidor(otro), alListo: () => controlEquipo.redComprobada(), log });
  }
  agente.iniciar();
  if (ha && !congelado) ha.iniciar().catch(e => log("Respaldo local: " + e.message));
  if (congelado) grupoLocal.reanudarActivacion().catch(e => log("La activación del respaldo sigue pausada: " + e.message));
  setInterval(() => grupoLocal.actualizarQuorum().catch(e => log("Incorporación de PCs: " + e.message)), 6000).unref();
  respaldoDiario();
  setInterval(respaldoDiario, 3 * 3600 * 1000).unref();
  migrarRuntime(BASE, DIR_APP, log).then(async (portable) => {
    if (portable && configHa?.quorum) {
      await prepararRedQuorum(DIR_APP, configHa.quorum.puerto).catch(e => log("Firewall de coordinación LAN: " + e.message));
    }
    const seguro = await actualizarHttps();
    if (portable) {
      const direccion = seguro.activo ? "https://localhost:" + seguro.puerto : "http://localhost:" + config.puerto;
      await prepararAccesoCaja(BASE, direccion);
      log("Acceso de caja preparado en el escritorio compartido de esta notebook: Sistema del Camping - Caja (" + direccion + ").");
    }
  }).catch((e) => log(`Configuración de Windows: ${e.message}`));
  setInterval(() => actualizarHttps(), 6 * 3600 * 1000).unref();
  function revisarPrecios() {
    if (!controlEquipo.puedeEscribir()) return;
    revisarPreciosVencidos(db, { pid: config.predio_id, usuario: { id: null, nombre: "Revisión de precios" }, origen: "SISTEMA", modo: "local" })
      .catch((e) => log(`Revisión de precios: ${e.message}`));
  }
  setTimeout(revisarPrecios, 6000).unref();
  setInterval(revisarPrecios, 6 * 3600 * 1000).unref();
  function revisarVencimientos() {
    if (!controlEquipo.puedeEscribir()) return;
    db.tx(t => require("./lib/vencimientos").revisarVencimientos(t, { pid: config.predio_id }))
      .catch(e => log(`Vencimientos de mercadería: ${e.message}`));
  }
  setTimeout(revisarVencimientos, 8000).unref();
  setInterval(revisarVencimientos, 60 * 60 * 1000).unref();
  setInterval(() => {
    const marca = path.join(BASE, "app", "CONTROL");
    if (!fs.existsSync(marca)) return;
    try {
      const orden = JSON.parse(fs.readFileSync(marca, "utf8").replace(/^\uFEFF/, ""));
      fs.rmSync(marca, { force: true });
      if (orden.accion === "DETENER") apagar(0);
      else if (orden.accion === "REINICIAR") apagar(75);
    } catch (e) { log(`Control del servidor: ${e.message}`); }
  }, 500).unref();
  // Fotos del ingreso: al arrancar y cada 6 horas (si no hay internet, quedan las guardadas).
  setTimeout(() => actualizarGaleria().catch(() => {}), 15000).unref();
  setInterval(() => actualizarGaleria().catch(() => {}), 6 * 3600 * 1000).unref();
  // Limpieza de sesiones vencidas.
  setInterval(() => {
    db.run("DELETE FROM predio_sesion WHERE vence IS NOT NULL AND vence < ?", [U.fechaHora()]).catch(() => {});
  }, 3600 * 1000).unref();
  // Señal de vida para el lanzador (detecta versiones que no arrancan).
  try { fs.writeFileSync(path.join(BASE, "app", "SANO"), `${VERSION}\n${servidorIniciado}\n`); } catch (_e) { /* modo desarrollo */ }
});

module.exports = { leerMeta };
