"use strict";

// Agente de sincronización de la notebook del predio con el sistema general.
// - La notebook es la dueña de los datos: funciona sin internet y anota cada cambio
//   en la bandeja de salida (predio_outbox). Con conexión, los sube cada pocos segundos.
// - Baja del sistema general los afiliados con reservas y las departamentales.
// - Ejecuta las órdenes que deja el administrador desde el sistema general (cambios de
//   precios, aprobaciones, etc.) y devuelve el resultado.
// - Busca actualizaciones del código y las instala solo.
// - Arma y aplica los archivos para llevar en pendrive cuando no hay internet.

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const U = require("./util");
const { TABLAS, NOMBRES_TABLAS, columnasDe } = require("./esquema");
const { leerMeta, escribirMeta } = require("./db-sqlite");
const { aplicarMaestros } = require("./maestros");
const { instalarPaquete, leerPaquete } = require("./paquete");
const { verificar } = require("./firma");
const { identidadEquipo } = require("./control-equipo");

const LOTE_PUSH = 400;

// Manifiesto explícito, revisado contra el producto real: nunca completa códigos
// por longitud ni crea un usuario ficticio para ejecutar la reparación.
async function corregirCodigosVerificados(db, pid, cuerpo) {
  const productos = cuerpo?.productos;
  if (!Array.isArray(productos) || !productos.length || productos.length > 100) throw U.error("La corrección necesita entre 1 y 100 productos verificados");
  const { gtinValido } = require("./codigo-barras");
  const ids = new Set();
  const manifiesto = productos.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw U.error("El producto del manifiesto no es válido");
    const id = U.id(p.producto_id, "El producto verificado");
    if (ids.has(id)) throw U.error("El manifiesto repite un producto");
    ids.add(id);
    const anterior = U.texto(p.codigo_anterior, { max: 60, requerido: true, campo: "El código anterior verificado" });
    const nuevo = U.texto(p.codigo_nuevo, { max: 14, requerido: true, campo: "El GTIN verificado" });
    if (!gtinValido(nuevo)) throw U.error("El código nuevo del manifiesto no es un GTIN válido");
    if (typeof p.nombre_esperado !== "string" || !p.nombre_esperado.trim() || p.nombre_esperado.length > 160) throw U.error("Indicá el nombre exacto del producto verificado");
    return { id, anterior, nuevo, nombre: p.nombre_esperado };
  });
  const apiLocal = require("./api");
  return db.tx(async (t) => {
    const ctx = {
      db: t, pid: U.id(pid, "El predio"), modo: "local", origen: "SISTEMA", ip: null, sesion: {}, query: {},
      usuario: { id: null, nombre: "Corrección verificada del sistema general", rol: "ADMIN", bocas: [] },
    };
    const resultados = [];
    for (const p of manifiesto) {
      const fila = await t.get(`SELECT nombre, codigo, activo FROM predio_producto WHERE predio_id = ? AND id = ?${t.forUpdate}`, [ctx.pid, p.id]);
      if (!fila || fila.nombre !== p.nombre || Number(fila.activo) !== 1) throw U.error(`El producto ${p.id} no coincide con la ficha verificada. No se aplicaron las correcciones.`, 409);
      if (fila.codigo === p.nuevo) {
        resultados.push({ id: p.id, codigo: p.nuevo, estado: "YA_CORREGIDO" });
        continue;
      }
      const r = await apiLocal.ejecutar({ ...ctx, body: { codigo_anterior: p.anterior, codigo_nuevo: p.nuevo, confirmar: true } }, "POST", `/productos/${p.id}/codigo-barras`);
      resultados.push({ id: r.id, codigo: r.codigo, estado: "CORREGIDO" });
    }
    return { mensaje: "Códigos verificados procesados", productos: resultados };
  });
}

function crearAgente({ db, config, base, version, log, api, alActualizar, alReiniciar, controlEquipo }) {
  const pid = Number(config.predio_id);
  const equipoId = controlEquipo?.equipoId || identidadEquipo();
  const estado = {
    en_linea: false,
    ultimo_contacto: leerMeta(db, "ultimo_contacto"),
    ultima_subida: leerMeta(db, "ultima_subida"),
    ultimo_error: null,
    remoto_activo: false,
    escritor: leerMeta(db, "escritor") || null,
    conflicto: null,
    version_disponible: null,
    actualizando: false,
    maestros: leerMeta(db, "maestros_resumen") ? JSON.parse(leerMeta(db, "maestros_resumen")) : null,
  };
  let temporizador = null;
  let corriendo = false;
  let detenido = false;
  let fallos = 0;
  let ultimoMaestros = 0;
  let ultimaVersion = 0;
  let instancia = leerMeta(db, "instancia_id");
  if (!instancia) {
    instancia = U.uuid();
    escribirMeta(db, "instancia_id", instancia);
  }

  function configurado() {
    return Boolean(config.servidor && config.token && pid);
  }

  async function pedir(metodo, ruta, { cuerpo, binario = false, timeout = 20000, crudo = false } = {}) {
    const url = `${String(config.servidor).replace(/\/+$/, "")}/predios-sync${ruta}`;
    const cabeceras = { Authorization: `Bearer ${config.token}`, "X-Predio": String(config.predio_codigo || ""), "X-Predio-Instancia": instancia, "X-Predio-Equipo": equipoId };
    let body;
    if (cuerpo !== undefined) {
      if (Buffer.isBuffer(cuerpo)) { body = cuerpo; cabeceras["Content-Type"] = "application/octet-stream"; }
      else {
        const json = Buffer.from(JSON.stringify(cuerpo));
        if (json.length > 64 * 1024) { body = zlib.gzipSync(json); cabeceras["Content-Encoding"] = "gzip"; }
        else body = json;
        cabeceras["Content-Type"] = "application/json";
      }
    }
    const r = await fetch(url, { method: metodo, headers: cabeceras, body, signal: AbortSignal.timeout(timeout) });
    if (crudo) return r;
    if (!r.ok) {
      let mensaje = `HTTP ${r.status}`;
      let codigo = null;
      try { const j = await r.json(); mensaje = j.mensaje || j.message || (typeof j === "string" ? j : mensaje); codigo = j.codigo || null; } catch (_e) { /* sin cuerpo */ }
      const e = new Error(mensaje);
      e.status = r.status;
      e.codigo = codigo;
      throw e;
    }
    if (binario) return Buffer.from(await r.arrayBuffer());
    return r.json();
  }

  // ---------------------------------------------------------------- bandeja de salida

  function cursorEnviado() {
    return Number(leerMeta(db, "outbox_cursor") || 0);
  }

  function pendientes() {
    const f = db.conexion.prepare("SELECT COUNT(*) AS n FROM predio_outbox WHERE seq > ?").get(cursorEnviado());
    return Number(f.n || 0);
  }

  function lote(desde, limite = LOTE_PUSH) {
    const filas = db.conexion.prepare(
      "SELECT seq, tabla, fila_id, op FROM predio_outbox WHERE seq > ? ORDER BY seq LIMIT ?").all(desde, limite * 4);
    if (!filas.length) return { cambios: [], hasta: desde };
    const ultimos = new Map();
    let hasta = desde;
    for (const f of filas) {
      const clave = `${f.tabla}:${f.fila_id}`;
      if (!ultimos.has(clave) && ultimos.size >= limite) break;
      ultimos.set(clave, f);
      hasta = f.seq;
    }
    const cambios = [];
    for (const f of ultimos.values()) {
      if (!TABLAS[f.tabla]) continue;
      if (f.op === "D") { cambios.push({ tabla: f.tabla, id: Number(f.fila_id), op: "D" }); continue; }
      const fila = db.conexion.prepare(`SELECT * FROM ${f.tabla} WHERE predio_id = ? AND id = ?`).get(pid, f.fila_id);
      if (!fila) cambios.push({ tabla: f.tabla, id: Number(f.fila_id), op: "D" });
      else cambios.push({ tabla: f.tabla, id: Number(f.fila_id), op: "U", datos: { ...fila } });
    }
    return { cambios, hasta };
  }

  async function subir() {
    let enviados = 0;
    for (let vuelta = 0; vuelta < 50; vuelta++) {
      const desde = cursorEnviado();
      const { cambios, hasta } = await db.exclusivo(() => lote(desde));
      if (hasta === desde) break;
      const r = await pedir("POST", "/push", { cuerpo: { instancia_id: instancia, equipo_id: equipoId, desde_seq: desde, hasta_seq: hasta, cambios }, timeout: 60000 });
      await db.exclusivo(() => {
        escribirMeta(db, "outbox_cursor", hasta);
        db.conexion.prepare("DELETE FROM predio_outbox WHERE seq <= ?").run(hasta);
      });
      enviados += cambios.length;
      atenderRespuesta(r);
    }
    if (enviados) {
      estado.ultima_subida = U.fechaHora();
      escribirMeta(db, "ultima_subida", estado.ultima_subida);
    }
    return enviados;
  }

  function atenderRespuesta(r) {
    if (!r || typeof r !== "object") return;
    if (r.remoto_activo !== undefined) estado.remoto_activo = !!r.remoto_activo;
    if (r.comandos_pendientes !== undefined) estado.comandos_pendientes = Number(r.comandos_pendientes) || 0;
  }

  // ---------------------------------------------------------------- arranque desde el sistema general

  function baseVacia() {
    for (const t of ["predio_boca", "predio_producto", "predio_usuario", "predio_venta"]) {
      const f = db.conexion.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
      if (Number(f.n) > 0) return false;
    }
    return true;
  }

  function insertarFilas(tabla, filas) {
    const cols = Object.keys(columnasDe(tabla));
    const st = db.conexion.prepare(`INSERT OR REPLACE INTO ${tabla} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const fila of filas) {
      st.run(...cols.map((c) => {
        const v = c === "predio_id" ? pid : fila[c];
        return v === undefined ? null : v;
      }));
    }
  }

  // Carga todas las tablas (instalación nueva o reemplazo de la notebook) sin reenviarlas.
  function cargarInstantanea(tablas, origen) {
    db.conexion.exec("BEGIN IMMEDIATE");
    try {
      for (const tabla of NOMBRES_TABLAS) {
        if (!tablas[tabla]) continue;
        db.conexion.prepare(`DELETE FROM ${tabla} WHERE predio_id = ?`).run(pid);
        insertarFilas(tabla, tablas[tabla]);
      }
      db.conexion.prepare("DELETE FROM predio_secuencia").run();
      const max = db.conexion.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM predio_outbox").get();
      db.conexion.prepare("DELETE FROM predio_outbox").run();
      db.conexion.prepare("INSERT OR REPLACE INTO predio_meta (clave, valor) VALUES ('outbox_cursor', ?)").run(String(max.m));
      db.conexion.prepare("INSERT OR REPLACE INTO predio_meta (clave, valor) VALUES ('bootstrap', ?)").run(`${origen} ${U.fechaHora()}`);
      db.conexion.exec("COMMIT");
    } catch (e) {
      try { db.conexion.exec("ROLLBACK"); } catch (_e) { /* revertida */ }
      throw e;
    }
  }

  async function descargarInstantanea() {
    const tablas = {};
    for (const tabla of NOMBRES_TABLAS) {
      tablas[tabla] = [];
      let desde = 0;
      for (;;) {
        const r = await pedir("GET", `/snapshot?tabla=${encodeURIComponent(tabla)}&desde_id=${desde}&limite=2000`, { timeout: 60000 });
        tablas[tabla].push(...r.filas);
        if (!r.filas.length || r.filas.length < 2000) break;
        desde = r.filas[r.filas.length - 1].id;
      }
    }
    await db.exclusivo(() => cargarInstantanea(tablas, "sistema general"));
    log("Datos iniciales descargados del sistema general");
  }

  // Datos iniciales que vienen dentro del instalador (sirven aunque no haya internet).
  function cargarDatosIniciales() {
    const archivo = path.join(base, "datos-iniciales.json.gz");
    if (!fs.existsSync(archivo) || !baseVacia() || leerMeta(db, "bootstrap")) return false;
    const datos = JSON.parse(zlib.gunzipSync(fs.readFileSync(archivo)).toString("utf8"));
    if (Number(datos.predio_id) !== pid) return false;
    cargarInstantanea(datos.tablas || {}, "instalador");
    escribirMeta(db, "bootstrap_generado", datos.generado || "");
    log("Datos iniciales cargados desde el instalador");
    return true;
  }

  // ---------------------------------------------------------------- órdenes remotas

  async function ejecutarComando(c) {
    const previo = db.conexion.prepare("SELECT * FROM predio_comando_ejecutado WHERE comando_id = ?").get(c.id);
    if (previo) return { ok: !!previo.ok, status: previo.status, respuesta: JSON.parse(previo.respuesta || "null") };
    let resultado;
    try {
      if (c.tipo === "SISTEMA") resultado = { ok: true, status: 200, respuesta: await comandoSistema(c) };
      else {
        const respuesta = await api.ejecutarRemoto({ metodo: c.metodo, ruta: c.ruta, cuerpo: c.cuerpo, query: c.query, actor: c.actor });
        resultado = { ok: true, status: 200, respuesta };
      }
    } catch (e) {
      resultado = { ok: false, status: e.status || 500, respuesta: { mensaje: e.status ? e.message : "No se pudo aplicar en el camping", codigo: e.codigo, faltantes: e.faltantes, problemas: e.problemas } };
      if (!e.status) log(`Error al ejecutar la orden ${c.id}: ${e.stack || e.message}`);
    }
    await db.exclusivo(() => db.conexion.prepare("INSERT OR REPLACE INTO predio_comando_ejecutado (comando_id, fecha, ok, status, respuesta) VALUES (?, ?, ?, ?, ?)")
      .run(c.id, U.fechaHora(), resultado.ok ? 1 : 0, resultado.status, JSON.stringify(resultado.respuesta ?? null).slice(0, 200000)));
    return resultado;
  }

  async function comandoSistema(c) {
    const accion = c.ruta;
    if (accion === "CORREGIR_CODIGOS_VERIFICADOS") return corregirCodigosVerificados(db, pid, c.cuerpo);
    if (accion === "SINCRONIZAR_TODO") {
      await reenviarTodo();
      return { mensaje: "Se reenviarán todos los datos" };
    }
    if (accion === "ACTUALIZAR") {
      setTimeout(() => { buscarActualizacion(true).catch((e) => log(`Actualización: ${e.message}`)); }, 500);
      return { mensaje: "Buscando actualización" };
    }
    if (accion === "REINICIAR") {
      setTimeout(() => alReiniciar && alReiniciar(), 1500);
      return { mensaje: "Reiniciando el servidor del camping" };
    }
    if (accion === "SUBIR_LOGS") {
      const carpeta = path.join(base, "logs");
      const archivos = fs.existsSync(carpeta) ? fs.readdirSync(carpeta).filter((f) => f.endsWith(".log")).sort().slice(-2) : [];
      const texto = archivos.map((f) => {
        const contenido = fs.readFileSync(path.join(carpeta, f), "utf8");
        return `===== ${f} =====\n${contenido.slice(-150000)}`;
      }).join("\n");
      return { logs: texto || "Sin registros", equipo: os.hostname(), version };
    }
    if (accion === "ACTUALIZAR_MAESTROS") {
      await bajarMaestros(true);
      return { mensaje: "Afiliados actualizados", resumen: estado.maestros };
    }
    throw Object.assign(new Error("Orden desconocida"), { status: 400 });
  }

  async function atenderComandos() {
    for (let vuelta = 0; vuelta < 10; vuelta++) {
      const r = await pedir("GET", "/comandos");
      const comandos = r.comandos || [];
      if (!comandos.length) break;
      for (const c of comandos) {
        const resultado = await ejecutarComando(c);
        // Subimos los cambios antes de responder: así el sistema general ya los ve.
        await subir();
        await pedir("POST", `/comandos/${c.id}/resultado`, { cuerpo: resultado });
      }
    }
  }

  // ---------------------------------------------------------------- maestros

  async function bajarMaestros(forzar = false) {
    if (!forzar && Date.now() - ultimoMaestros < 10 * 60 * 1000) return;
    const maestros = await pedir("GET", "/maestros", { timeout: 60000 });
    const ctx = { db, pid, usuario: { id: null, nombre: "Sincronización" }, origen: "SISTEMA" };
    const resumen = await db.tx((t) => aplicarMaestros(t, { ...ctx, db: t }, maestros));
    ultimoMaestros = Date.now();
    estado.maestros = { ...resumen, fecha: U.fechaHora(), afiliados: (maestros.afiliados || []).length };
    escribirMeta(db, "maestros_resumen", JSON.stringify(estado.maestros));
  }

  // ---------------------------------------------------------------- actualizaciones

  async function buscarActualizacion(forzar = false) {
    if (!forzar && Date.now() - ultimaVersion < 30 * 60 * 1000) return null;
    ultimaVersion = Date.now();
    const info = await pedir("GET", "/version");
    estado.version_disponible = info.version || null;
    if (!info.version || info.version === version) return { actualizado: false, version };
    if (!forzar && config.actualizaciones_automaticas === false) return { actualizado: false, disponible: info.version };
    const buffer = await pedir("GET", "/codigo", { binario: true, timeout: 120000 });
    const sha = crypto.createHash("sha256").update(buffer).digest("hex");
    if (info.sha256 && sha !== info.sha256) throw new Error("El paquete descargado está dañado (no coincide la huella)");
    if (config.clave_publica && !verificar(buffer, info.firma, config.clave_publica)) {
      throw new Error("La actualización no tiene una firma válida del sistema general: no se instala");
    }
    return instalarActualizacion(buffer);
  }

  function instalarActualizacion(buffer) {
    estado.actualizando = true;
    const datos = leerPaquete(buffer);
    if (datos.version === version) { estado.actualizando = false; return { actualizado: false, version }; }
    const carpetaVersiones = path.join(base, "app", "versiones");
    fs.mkdirSync(carpetaVersiones, { recursive: true });
    const r = instalarPaquete(buffer, carpetaVersiones);
    fs.writeFileSync(path.join(base, "app", "PENDIENTE"), r.nombre);
    log(`Actualización ${r.version} instalada. Reiniciando…`);
    if (alActualizar) setTimeout(() => alActualizar(r), 800);
    return { actualizado: true, version: r.version };
  }

  // ---------------------------------------------------------------- ciclo

  async function ciclo() {
    if (corriendo || detenido || !configurado()) return;
    corriendo = true;
    try {
      const hola = await pedir("POST", "/hola", {
        cuerpo: {
          instancia_id: instancia, equipo_id: equipoId, version, equipo: os.hostname(), pendientes: pendientes(),
          vacia: baseVacia(), bootstrap: leerMeta(db, "bootstrap"), bootstrap_generado: leerMeta(db, "bootstrap_generado"),
        },
      });
      estado.en_linea = true;
      estado.ultimo_contacto = U.fechaHora();
      estado.ultimo_error = null;
      estado.escritor = hola.escritor;
      if (/^[a-f0-9]{64}$/.test(String(hola.clave_lan || "")) && config.clave_lan !== hola.clave_lan) {
        config.clave_lan = hola.clave_lan;
        const archivo = path.join(base, "config.json");
        let guardada = {};
        try { guardada = JSON.parse(fs.readFileSync(archivo, "utf8").replace(/^\uFEFF/, "")); } catch (_e) { /* instalación configurada por entorno */ }
        const temporal = `${archivo}.${process.pid}.tmp`;
        fs.writeFileSync(temporal, JSON.stringify({ ...guardada, clave_lan: hola.clave_lan }, null, 2), { mode: 0o600 });
        fs.renameSync(temporal, archivo);
      }
      escribirMeta(db, "ultimo_contacto", estado.ultimo_contacto);
      escribirMeta(db, "escritor", hola.escritor || "");
      atenderRespuesta(hola);
      fallos = 0;

      if (hola.accion === "DESCARGAR_DATOS") {
        await descargarInstantanea();
        const control = await pedir("POST", "/tomar-control", { cuerpo: { instancia_id: instancia, equipo_id: equipoId } });
        if (control.autoriza_escritura === true) { controlEquipo?.confirmarCentral(); escribirMeta(db, "escritor", "LOCAL"); }
      } else if (hola.accion === "TOMAR_CONTROL") {
        const control = await pedir("POST", "/tomar-control", { cuerpo: { instancia_id: instancia, equipo_id: equipoId } });
        if (control.autoriza_escritura === true) { controlEquipo?.confirmarCentral(); escribirMeta(db, "escritor", "LOCAL"); }
      }
      if (hola.autoriza_escritura === true) controlEquipo?.confirmarCentral();
      if (controlEquipo && !controlEquipo.puedeEscribir()) {
        estado.conflicto = controlEquipo.estado().motivo;
        await buscarActualizacion(false).catch((e) => log(`Actualización: ${e.message}`));
        return;
      }
      if (hola.conflicto) {
        estado.conflicto = hola.conflicto;
      } else {
        estado.conflicto = null;
        await subir();
        await atenderComandos();
        await bajarMaestros(false).catch((e) => log(`Afiliados: ${e.message}`));
        await buscarActualizacion(false).catch((e) => log(`Actualización: ${e.message}`));
      }
    } catch (e) {
      if (e.status === 409 && ["OTRO_EQUIPO", "OTRA_INSTALACION", "SIN_CONTROL"].includes(e.codigo)) {
        controlEquipo?.rechazarCentral(e.message);
        estado.conflicto = e.message;
        await buscarActualizacion(false).catch((fallo) => log(`Actualización: ${fallo.message}`));
      }
      fallos++;
      estado.en_linea = false;
      estado.ultimo_error = e.name === "TimeoutError" || e.name === "AbortError" ? "Sin respuesta del sistema general" : (e.cause?.code ? "Sin conexión a internet" : e.message);
      if (fallos === 1 || fallos % 20 === 0) log(`Sincronización: ${estado.ultimo_error}`);
    } finally {
      corriendo = false;
      programar();
    }
  }

  function programar() {
    if (detenido) return;
    clearTimeout(temporizador);
    let espera = estado.remoto_activo || estado.comandos_pendientes ? 2000 : 6000;
    if (fallos) espera = Math.min(60000, 5000 * 2 ** Math.min(fallos - 1, 4));
    temporizador = setTimeout(ciclo, espera);
    temporizador.unref?.();
  }

  // ---------------------------------------------------------------- archivos para pendrive

  async function exportar() {
    return db.exclusivo(() => exportarSincronico());
  }

  function exportarSincronico() {
    const tablas = {};
    for (const tabla of NOMBRES_TABLAS) tablas[tabla] = db.conexion.prepare(`SELECT * FROM ${tabla} WHERE predio_id = ?`).all(pid).map((f) => ({ ...f }));
    const max = db.conexion.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM predio_outbox").get();
    const datos = {
      tipo: "predio-exportacion", formato: 1, predio_id: pid, predio_codigo: config.predio_codigo, instancia_id: instancia, equipo_id: equipoId,
      version, generado: U.fechaHora(), hasta_seq: Math.max(Number(max.m), cursorEnviado()), tablas,
    };
    const buffer = zlib.gzipSync(Buffer.from(JSON.stringify(datos)), { level: 6 });
    const nombre = `predio-${String(config.predio_codigo || pid).toLowerCase()}-${datos.generado.replace(/[: ]/g, "-").slice(0, 16)}.ajbpredio`;
    return { buffer, nombre };
  }

  async function importarPaquete(buffer) {
    let envoltorio;
    try { envoltorio = JSON.parse(zlib.gunzipSync(buffer).toString("utf8")); } catch (_e) { throw U.error("El archivo no se pudo leer: ¿es un paquete del sistema general?"); }
    if (envoltorio.tipo !== "predio-paquete-firmado") throw U.error("Ese archivo no es un paquete del sistema general para el predio");
    if (!config.clave_publica) throw U.error("Esta instalación no tiene la clave para verificar paquetes: reinstalala con un instalador nuevo de Mi AJB");
    if (!verificar(Buffer.from(String(envoltorio.contenido || "")), envoltorio.firma, config.clave_publica)) {
      throw U.error("El paquete no tiene una firma válida del sistema general: no se carga", 403);
    }
    const datos = JSON.parse(envoltorio.contenido);
    if (datos.tipo !== "predio-paquete") throw U.error("Ese archivo no es un paquete del sistema general para el predio");
    if (Number(datos.predio_id) !== pid) throw U.error("El paquete es de otro predio");
    const resumen = { maestros: null, comandos: 0, errores: 0, actualizacion: null };
    if (datos.maestros) {
      const ctx = { db, pid, usuario: { id: null, nombre: "Paquete del sistema general" }, origen: "SISTEMA" };
      resumen.maestros = await db.tx((t) => aplicarMaestros(t, { ...ctx, db: t }, datos.maestros));
      estado.maestros = { ...resumen.maestros, fecha: U.fechaHora(), afiliados: (datos.maestros.afiliados || []).length };
      escribirMeta(db, "maestros_resumen", JSON.stringify(estado.maestros));
    }
    for (const c of datos.comandos || []) {
      const r = await ejecutarComando(c);
      resumen.comandos++;
      if (!r.ok) resumen.errores++;
    }
    if (datos.codigo) {
      resumen.actualizacion = instalarActualizacion(Buffer.from(datos.codigo, "base64"));
    }
    return resumen;
  }

  // Vuelve a encolar todas las filas para subirlas (reparación de la réplica central).
  async function reenviarTodo() {
    await db.exclusivo(() => {
      db.conexion.exec("BEGIN IMMEDIATE");
      try {
        for (const tabla of NOMBRES_TABLAS) {
          db.conexion.prepare(`INSERT INTO predio_outbox (tabla, fila_id, op) SELECT '${tabla}', id, 'U' FROM ${tabla} WHERE predio_id = ?`).run(pid);
        }
        db.conexion.exec("COMMIT");
      } catch (e) { db.conexion.exec("ROLLBACK"); throw e; }
    });
  }

  return {
    configurado,
    enLinea: () => estado.en_linea,
    instancia: () => instancia,
    iniciar() {
      detenido = false;
      try { cargarDatosIniciales(); } catch (e) { log(`No se pudieron cargar los datos iniciales: ${e.message}`); }
      if (configurado()) { temporizador = setTimeout(ciclo, 1500); temporizador.unref?.(); }
    },
    detener() { detenido = true; clearTimeout(temporizador); },
    async sincronizarAhora() {
      if (!configurado()) throw U.error("La notebook no está vinculada al sistema general");
      clearTimeout(temporizador);
      ultimoMaestros = 0;
      await ciclo();
      if (!estado.en_linea) throw U.error(estado.ultimo_error || "No hay conexión con el sistema general", 503);
      return estadoPublico();
    },
    async verificarAdminGeneral(documento, password) {
      if (!configurado()) throw new Error("sin configurar");
      return pedir("POST", "/verificar-admin", { cuerpo: { documento, password }, timeout: 10000 });
    },
    buscarActualizacion,
    instalarActualizacion,
    exportar,
    importarPaquete,
    reenviarTodo,
    estadoPublico,
  };

  function estadoPublico() {
    return {
      vinculado: configurado(),
      servidor: config.servidor || null,
      predio: { id: pid, codigo: config.predio_codigo, nombre: config.predio_nombre },
      instancia,
      equipo_id: equipoId,
      en_linea: estado.en_linea,
      ultimo_contacto: estado.ultimo_contacto,
      ultima_subida: estado.ultima_subida,
      ultimo_error: estado.ultimo_error,
      pendientes: pendientes(),
      remoto_activo: estado.remoto_activo,
      conflicto: estado.conflicto,
      version,
      version_disponible: estado.version_disponible,
      actualizaciones_automaticas: config.actualizaciones_automaticas !== false,
      maestros: estado.maestros,
      bootstrap: leerMeta(db, "bootstrap"),
    };
  }
}

module.exports = { crearAgente, corregirCodigosVerificados };
