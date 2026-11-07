"use strict";

// Predios (sistemas locales de los campings) en el sistema general. Tres routers:
//  - crearRouterAdmin(): /api/predios… para el panel del administrador (Angular, con CORS).
//  - crearRouterSync():  /api/predios-sync… para la notebook del camping (token de instalación).
//  - crearRouterApp():   /api/predios-app/:codigo/… la misma pantalla del camping en modo remoto
//    (se abre dentro del sistema general) y su API sobre la réplica MySQL.
// Los dos últimos se montan antes del CORS: no los usa el front de CloudFront sino la
// notebook (sin Origin) y la propia página remota (mismo origen que la API).

const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { obtenerOrigenesPermitidos } = require("../security/http-config");
const { crearNotificacion } = require("../services/notificaciones");
const C = require("../services/predios-central");
const propietario = require("../services/predios-propietario");
const { validarAutorizacionHa } = require("../services/predios-ha");
const { entregarAvisos } = require("../services/predios-avisos");
const U = require("../../predios/lib/util");
const clavesUsuario = require("../../predios/lib/claves-usuario");
const apiPredio = require("../../predios/lib/api");
const { validarClaveCierre } = require("../../predios/lib/api/caja");
const sesionPredio = require("../../predios/lib/api/sesion");
const { crearMysql } = require("../../predios/lib/db-mysql");
const { TIPOS_PERMISO, textoDe } = require("../../predios/lib/listados");
const { autenticarCuentaPredio, cerrarSesionPredio, esTokenPredio } = require("../security/predios-acceso");

const pool = () => mysqlConnection.promise();
const DIR_PUBLICO = path.join(C.DIR_PREDIOS, "public");
const accesoRemoto = new Map(); // codigo -> último uso de la pantalla remota (ms)

function responderError(res, e) {
  if (e instanceof U.ErrorPredio || (e && e.status && e.status < 600)) {
    const { status, message, name, stack, ...extra } = e;
    return res.status(e.status || 400).json({ mensaje: e.message, ...extra });
  }
  console.error("Predios:", e?.code || e?.message, e?.stack);
  return res.status(500).json({ mensaje: "No pudimos completar la operación. Volvé a intentar." });
}

function nombreUsuario(u) {
  return [u.nombre, u.apellido].filter(Boolean).join(" ").trim() || `Usuario ${u.documento}`;
}

// Ejecuta una operación de la API del predio como administrador general: lectura sobre la
// réplica; escritura directa si todavía no hay notebook, o como orden para la notebook.
async function ejecutarComoAdminGeneral(res, predio, usuario, { metodo, ruta, cuerpo, query, ip = null }) {
  if (ruta === "/sesion/clave") throw U.error("Cambiá tu contraseña desde el sistema general", 403);
  const nombre = `${nombreUsuario(usuario)} (sistema general)`;
  const db = crearMysql(pool(), { predioId: predio.id });
  const bocas = (await db.all("SELECT id FROM predio_boca WHERE predio_id = ?", [predio.id])).map((b) => Number(b.id));
  const base = {
    db, pid: predio.id, modo: "central", origen: "REMOTO", ip, servicios: {},
    revisarPreciosCentral: predio.escritor === "CENTRAL",
    alAvisosPrecios: (t, filas) => entregarAvisos({ query: async (sql, params) => {
      if (/^\s*SELECT/i.test(sql)) return [await t.all(sql, params)];
      const r = await t.run(sql, params); return [{ insertId: r.insertId }];
    } }, predio, filas),
    usuario: { id: null, usuario: `dni${usuario.documento}`, nombre, rol: "ADMIN", bocas, es_admin_general: true,
      general_usuario_id: Number(usuario.id), documento: String(usuario.documento || "") },
    sesion: {}, query: { ...(query || {}) }, body: cuerpo && typeof cuerpo === "object" ? cuerpo : {},
  };
  base.servicios.recepcion = (accion, datos, actor, t) => require("../services/recepcion").operar(t.conexionTurismo, predio, actor, accion, datos);
  base.alAvisosStock = base.alAvisosPrecios;
  const encontrada = apiPredio.buscarRuta(metodo, ruta);
  if (!encontrada) throw U.error("No encontramos esa operación", 404);
  if (encontrada.ruta.soloLocal) throw U.error("Esta operación se hace desde las PCs del camping", 409);
  base.claveDiaCierreValidada = validarCierreRemoto(ruta, base);
  if (encontrada.ruta.escritura) {
    if (predio.escritor === "CENTRAL") {
      // Todavía no hay notebook instalada: el sistema general es el dueño de los datos.
      const fila = await sesionPredio.asegurarUsuarioGeneral(base, { id: usuario.id, nombre, documento: usuario.documento });
      base.usuario.id = Number(fila.id);
      const r = await apiPredio.ejecutar(base, metodo, ruta);
      await pool().query("UPDATE predio SET ultima_escritura_central = NOW() WHERE id = ?", [predio.id]);
      return enviarResultado(res, r);
    }
    return encolarYEsperar(res, predio, usuario, { metodo, ruta, cuerpo: base.body, query: base.query, claveDiaCierreValidada: base.claveDiaCierreValidada });
  }
  if (ruta === "/afiliados/buscar" || ruta.startsWith("/listados/afiliados") || ruta === "/inicio") {
    if (predio.escritor === "CENTRAL") await C.refrescarMaestrosCentral(pool(), predio).catch(() => {});
  }
  // Las lecturas usan la identidad local replicada, sin crear usuarios ni escribir
  // sobre datos de una notebook que sigue siendo la dueña del predio.
  const usuarioPredio = await db.get(
    "SELECT id FROM predio_usuario WHERE predio_id = ? AND es_admin_general = 1 AND general_usuario_id = ? LIMIT 1",
    [predio.id, Number(usuario.id)]);
  base.usuario.id = usuarioPredio ? Number(usuarioPredio.id) : null;
  const r = await apiPredio.ejecutar(base, metodo, ruta);
  return enviarResultado(res, r);
}

function enviarResultado(res, r) {
  if (r && r.csv !== undefined) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${r.nombreArchivo}"`);
    return res.send(r.csv);
  }
  return res.json(r === undefined ? { ok: true } : r);
}

function validarCierreRemoto(ruta, ctx) {
  if (ruta !== "/caja/cierre") return false;
  const cajaId = U.id(ctx.body.caja_id, "La caja");
  // El evento es central. La auditoría de negocio puede pertenecer al escritor local.
  const auditarFalloClave = (detalle) => C.evento(pool(), ctx.pid, "CLAVE_DIA_CIERRE_INCORRECTA", {
    ...detalle, usuario_predio_id: ctx.usuario.id || null, usuario_nombre: ctx.usuario.nombre, ip: ctx.ip,
  }, ctx.usuario.general_usuario_id || null);
  validarClaveCierre({ ...ctx, auditarFalloClave }, cajaId);
  return true;
}

function prepararOrden(actor, ruta, cuerpo, cuenta, claveDiaCierreValidada) {
  // Solo esta frontera autenticada puede atestiguar una clave. Los secretos
  // introducidos en el formulario nunca se guardan en la cola ni el pendrive.
  const datos = { ...cuerpo };
  if (/^\/(?:usuarios|altas|productos|permisos|caja)(?:\/|$)/.test(ruta) || ruta === "/sesion/clave" ||
    /^\/(?:ventas\/\d+\/anular|afiliados\/\d+\/liquidaciones|recepcion\/\d+\/cuenta)$/.test(ruta)) {
    actor.capacidad = "operacion-predio-v2";
  } else if (/^\/(?:compras|ventas|traspasos|solicitudes|bajas)(?:\/|$)/.test(ruta)) actor.capacidad = "stock-predio-v2";
  else if (/^\/bocas(?:\/|$)/.test(ruta)) actor.capacidad = "precios-boca-v1";
  else if (ruta === "/recepcion/adicionales" || ruta === "/recepcion/guardar" && datos.cuenta_esperada) actor.capacidad = "recepcion-alquileres-v1";
  if (/^\/usuarios(?:\/\d+)?$/.test(ruta) && datos.password) {
    clavesUsuario.validarNueva(datos.password, String(datos.usuario || "").trim().toLowerCase());
    actor.hash_clave_validada = U.hashPassword(datos.password);
    delete datos.password;
  }
  if (ruta === "/caja/cierre") {
    // El escritor comprueba el corte y la identidad al aplicar la orden.
    actor.capacidad = "cierre-clave-dia-v1";
    actor.clave_dia_cierre_validada = claveDiaCierreValidada === true;
    delete datos.clave;
  }
  if (ruta === "/sesion/clave") {
    actor.hash_clave_validada = clavesUsuario.hashDeCambio(cuenta, String(datos.actual || ""), datos.nueva);
    return {};
  }
  return datos;
}

async function encolarYEsperar(res, predio, usuario, { metodo, ruta, cuerpo, query, claveDiaCierreValidada }) {
  const actor = { general_id: usuario.id, nombre: nombreUsuario(usuario), documento: usuario.documento };
  const datos = prepararOrden(actor, ruta, cuerpo, null, claveDiaCierreValidada);
  const [r] = await pool().query(
    "INSERT INTO predio_comando (predio_id, tipo, metodo, ruta, cuerpo, query, actor, descripcion, creado_por) VALUES (?, 'API', ?, ?, ?, ?, ?, ?, ?)",
    [predio.id, metodo, ruta, JSON.stringify(datos), JSON.stringify(query || {}), JSON.stringify(actor), `${metodo} ${ruta}`.slice(0, 255), usuario.id]);
  return esperarComando(res, predio, r.insertId);
}

async function esperarComando(res, predio, id) {
  accesoRemoto.set(predio.codigo, Date.now());
  if (C.enLinea(predio)) {
    const limite = Date.now() + 15000;
    while (Date.now() < limite) {
      await new Promise((ok) => setTimeout(ok, 350));
      const [[c]] = await pool().query("SELECT estado, status, resultado FROM predio_comando WHERE id = ?", [id]);
      if (c && (c.estado === "OK" || c.estado === "ERROR")) {
        let respuesta = null;
        try { respuesta = JSON.parse(c.resultado || "null"); } catch (_e) { respuesta = null; }
        if (c.estado === "OK") return res.json(respuesta === null ? { ok: true } : respuesta);
        return res.status(c.status && c.status >= 400 ? c.status : 500).json(respuesta || { mensaje: "El camping no pudo aplicar el cambio" });
      }
    }
  }
  return res.status(202).json({
    encolado: true, comando_id: id,
    mensaje: C.enLinea(predio)
      ? "El predio está tardando en responder: el cambio quedó en cola y se aplica en unos segundos."
      : "El predio está sin conexión: el cambio quedó en cola y se aplica apenas vuelva internet.",
  });
}

function tokenBearer(req) {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
  if (!token) throw U.error("Iniciá sesión para continuar", 401, { codigo: "SIN_SESION" });
  return token;
}

async function contextoCuentaPredio(db, predio, cuenta, ip = null) {
  const bocas = (await db.all("SELECT id FROM predio_boca WHERE predio_id = ? AND activo = 1", [predio.id])).map(b => Number(b.id));
  const base = { db, pid: predio.id, modo: "central", origen: "REMOTO", ip, servicios: {},
    revisarPreciosCentral: predio.escritor === "CENTRAL",
    usuario: { id: Number(cuenta.id), usuario: cuenta.usuario, nombre: cuenta.nombre, rol: "ADMIN", bocas, es_admin_general: false, debe_cambiar_clave: !!Number(cuenta.debe_cambiar_clave) }, sesion: {} };
  base.alAvisosPrecios = (t, filas) => entregarAvisos({ query: async (sql, params) => {
    if (/^\s*SELECT/i.test(sql)) return [await t.all(sql, params)];
    const r = await t.run(sql, params); return [{ insertId: r.insertId }];
  } }, predio, filas);
  base.servicios.recepcion = (accion, datos, actor, t) => require("../services/recepcion").operar(t.conexionTurismo, predio, actor, accion, datos);
  base.alAvisosStock = base.alAvisosPrecios;
  return base;
}

async function ejecutarComoAdminPredio(res, predio, cuenta, token, { metodo, ruta, cuerpo, query, ip }) {
  const encontrada = apiPredio.buscarRuta(metodo, ruta);
  if (!encontrada) throw U.error("No encontramos esa operación", 404);
  if (encontrada.ruta.soloLocal) throw U.error("Esta operación se hace desde las PCs del camping", 409);
  if (!encontrada.ruta.escritura) {
    const db = crearMysql(pool(), { predioId: predio.id });
    const base = await contextoCuentaPredio(db, predio, cuenta, ip);
    if (predio.escritor === "CENTRAL" && (ruta === "/afiliados/buscar" || ruta.startsWith("/listados/afiliados") || ruta === "/inicio")) {
      await C.refrescarMaestrosCentral(pool(), predio).catch(() => {});
    }
    return enviarResultado(res, await apiPredio.ejecutar({ ...base, body: cuerpo, query }, metodo, ruta));
  }
  let claveDiaCierreValidada = false;
  if (ruta === "/caja/cierre") {
    clavesUsuario.exigirCambio(cuenta, metodo, ruta);
    claveDiaCierreValidada = validarCierreRemoto(ruta, { pid: predio.id, usuario: cuenta, ip, body: cuerpo });
  }
  const conexion = await pool().getConnection();
  let salida;
  try {
    await conexion.beginTransaction();
    const [[actual]] = await conexion.query("SELECT * FROM predio WHERE id = ? FOR UPDATE", [predio.id]);
    // En REPEATABLE READ, tomar la caja antes de la primera lectura sin lock
    // permite que el arqueo incluya cualquier movimiento que acaba de confirmar.
    if (actual?.escritor === "CENTRAL" && ["/caja/cierre", "/caja/apertura", "/caja/ajuste"].includes(ruta)) {
      await conexion.query("SELECT id FROM predio_caja WHERE predio_id=? AND id=? FOR UPDATE", [predio.id, U.id(cuerpo.caja_id, "La caja")]);
    }
    const [[usuario]] = await conexion.query("SELECT * FROM predio_usuario WHERE predio_id = ? AND id = ? FOR UPDATE", [predio.id, cuenta.id]);
    // La validación posterior al lock une token, contraseña vigente y actor. Un
    // token viejo no puede tomar el hash nuevo después de un cambio de clave.
    const vigente = await autenticarCuentaPredio({ db: conexion, token, jwtSecret: process.env.JWT_SECRET });
    if (!actual || !Number(actual.activo) || Number(vigente.predio_id) !== Number(actual.id) || Number(vigente.id) !== Number(cuenta.id)
      || !usuario || usuario.rol !== "ADMIN" || Number(usuario.activo) !== 1 || Number(usuario.es_admin_general) === 1) throw U.error("Tu cuenta ya no tiene acceso a este predio", 401, { codigo: "SIN_SESION" });
    const p = C.normalizar(actual);
    clavesUsuario.exigirCambio(vigente, metodo, ruta);
    if (p.escritor === "CENTRAL") {
      // Todo el negocio comparte la transacción que bloqueó la identidad; no
      // crea un usuario del sistema general ni abre transacciones anidadas.
      const db = crearMysql({ query: (...args) => conexion.query(...args), getConnection: async () => ({
        query: (...args) => conexion.query(...args), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
      }) }, { predioId: p.id });
      const base = await contextoCuentaPredio(db, p, vigente, ip);
      const resultado = await apiPredio.ejecutar({ ...base, body: cuerpo, query, claveDiaCierreValidada }, metodo, ruta);
      await conexion.query("UPDATE predio SET ultima_escritura_central = NOW() WHERE id = ?", [p.id]);
      salida = { resultado, predio: p };
    } else {
      const [revisiones] = await conexion.query("SELECT id FROM predio_auditoria WHERE predio_id = ? AND entidad = 'usuario' AND entidad_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE", [p.id, usuario.id]);
      const actor = { tipo: "PREDIO", predio_id: Number(p.id), predio_usuario_id: Number(usuario.id), credencial_sha256: U.sha256(usuario.password_hash), cuenta_revision: Number(revisiones[0]?.id || 0) };
      const datos = prepararOrden(actor, ruta, cuerpo, usuario, claveDiaCierreValidada);
      const [r] = await conexion.query(
        "INSERT INTO predio_comando (predio_id, tipo, metodo, ruta, cuerpo, query, actor, descripcion, creado_por) VALUES (?, 'API', ?, ?, ?, ?, ?, ?, ?)",
        [p.id, metodo, ruta, JSON.stringify(datos), JSON.stringify(query || {}), JSON.stringify(actor), `${metodo} ${ruta}`.slice(0, 255), null]);
      salida = { comandoId: r.insertId, predio: p };
    }
    await conexion.commit();
  } catch (e) { await conexion.rollback(); throw e; }
  finally { conexion.release(); }
  return salida.comandoId ? esperarComando(res, salida.predio, salida.comandoId) : enviarResultado(res, salida.resultado);
}

function crearRouterCuenta() {
  const router = express.Router();
  async function cuenta(req) { return autenticarCuentaPredio({ db: pool(), token: tokenBearer(req), jwtSecret: process.env.JWT_SECRET }); }
  router.get("/predios-cuenta/permisos", async (req, res) => {
    try { res.json(await cuenta(req)); } catch (e) { responderError(res, e); }
  });
  router.post("/predios-cuenta/acceso", async (req, res) => {
    try {
      const actual = await cuenta(req), b = req.body || {};
      if ((b.predio_id !== undefined && Number(b.predio_id) !== Number(actual.predio_id))
        || [b.codigo, b.predio_codigo].some(c => c !== undefined && String(c).toUpperCase() !== actual.predio_codigo)) throw U.error("Tu cuenta sólo puede abrir su propio predio", 403);
      res.json({ token: tokenBearer(req), ruta: `/predios-app/${actual.predio_codigo}/` });
    } catch (e) { responderError(res, e); }
  });
  return router;
}

// ================================================================== ADMINISTRACIÓN

function crearRouterAdmin() {
  const router = express.Router();

  function verificar(req, res, next) {
    return verificarTokenConAutorizacionActual({ req, res, next, jwt, jwtSecret: process.env.JWT_SECRET, db: pool(), mensajeAuthorization: "Iniciá sesión para continuar" });
  }
  async function soloAdmin(req, res, next) {
    try {
      const actor = JSON.parse(req.data.data);
      if (actor.rol !== "admin") return res.status(403).json({ mensaje: "Sólo la administración general gestiona los predios" });
      const [[u]] = await pool().query("SELECT id, nombre, apellido, documento FROM usuario WHERE id = ?", [Number(actor.id)]);
      if (!u) return res.status(401).json({ mensaje: "Sesión inválida" });
      req.actor = { id: Number(u.id), rol: actor.rol, nombre: nombreUsuario(u), documento: u.documento };
      next();
    } catch (_e) {
      res.status(401).json({ mensaje: "Sesión inválida" });
    }
  }
  const proteger = [verificar, soloAdmin];

  async function predioDe(req) {
    const p = await C.obtenerPredio(pool(), req.params.codigo);
    if (!p) throw U.error("No encontramos el predio", 404);
    return p;
  }

  async function resumenPredio(p) {
    const db = pool();
    const hoy = U.hoy();
    const [[comandos]] = await db.query("SELECT COUNT(*) AS n FROM predio_comando WHERE predio_id = ? AND estado IN ('PENDIENTE', 'ENTREGADO')", [p.id]);
    const [[permisos]] = await db.query("SELECT COUNT(*) AS n FROM predio_permiso WHERE predio_id = ? AND estado = 'PENDIENTE'", [p.id]);
    const [[ventas]] = await db.query("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS t FROM predio_venta WHERE predio_id = ? AND estado = 'CONFIRMADA' AND fecha >= ?", [p.id, hoy]);
    const [[productos]] = await db.query("SELECT COUNT(*) AS n FROM predio_producto WHERE predio_id = ? AND activo = 1", [p.id]);
    const [[bocas]] = await db.query("SELECT COUNT(*) AS n FROM predio_boca WHERE predio_id = ? AND activo = 1", [p.id]);
    const [[enPredio]] = await db.query("SELECT COUNT(DISTINCT afiliado_id) AS n FROM predio_estadia WHERE predio_id = ? AND activo = 1 AND fecha_inicio <= ? AND fecha_fin >= ?", [p.id, hoy, hoy]);
    const [[instalaciones]] = await db.query("SELECT COUNT(*) AS n FROM predio_instalacion WHERE predio_id = ? AND revocado_en IS NULL", [p.id]);
    const disponible = C.paqueteCodigo().version;
    return {
      id: p.id,
      codigo: p.codigo,
      nombre: p.nombre,
      tipo: p.tipo,
      activo: !!Number(p.activo),
      servicios: C.serviciosDe(p),
      escritor: p.escritor,
      en_linea: C.enLinea(p),
      ultima_conexion: p.ultima_conexion,
      ultimo_push: p.ultimo_push,
      equipo: p.equipo,
      version_local: p.version_local,
      version_disponible: disponible,
      actualizado: !p.version_local || p.version_local === disponible,
      pendientes_local: Number(p.pendientes_local || 0),
      comandos_pendientes: Number(comandos.n),
      permisos_pendientes: Number(permisos.n),
      ventas_hoy: Number(ventas.n),
      total_hoy: U.redondear(Number(ventas.t)),
      productos: Number(productos.n),
      bocas: Number(bocas.n),
      afiliados_en_predio: Number(enPredio.n),
      instalaciones: Number(instalaciones.n),
    };
  }

  router.get("/predios", proteger, async (_req, res) => {
    try {
      const [filas] = await pool().query("SELECT * FROM predio ORDER BY activo DESC, nombre");
      const predios = [];
      for (const f of filas) predios.push(await resumenPredio(C.normalizar(f)));
      const [servicios] = await pool().query("SELECT codigo, nombre, lugar FROM servicio WHERE codigo IS NOT NULL ORDER BY nombre");
      res.json({ predios, servicios });
    } catch (e) { responderError(res, e); }
  });

  router.post("/predios", proteger, async (req, res) => {
    try {
      const id = await C.crearPredio(pool(), { ...req.body, usuarioId: req.actor.id });
      const [[p]] = await pool().query("SELECT codigo FROM predio WHERE id = ?", [id]);
      res.status(201).json({ id, codigo: p.codigo, mensaje: "Predio creado" });
    } catch (e) { responderError(res, e); }
  });

  router.get("/predios/:codigo", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      if (p.escritor === "CENTRAL") await C.refrescarMaestrosCentral(pool(), p).catch((e) => console.error("Predios maestros:", e.message));
      const [instalaciones] = await pool().query(
        "SELECT id, nombre, fecha_creacion, ultimo_uso, ultima_ip, instancia_id, revocado_en FROM predio_instalacion WHERE predio_id = ? ORDER BY id DESC LIMIT 20", [p.id]);
      const [comandos] = await pool().query(
        `SELECT id, tipo, metodo, ruta, descripcion, estado, status, creado_en, resuelto_en, actor FROM predio_comando
         WHERE predio_id = ? ORDER BY id DESC LIMIT 30`, [p.id]);
      const [eventos] = await pool().query("SELECT id, fecha, tipo, detalle FROM predio_evento WHERE predio_id = ? ORDER BY id DESC LIMIT 30", [p.id]);
      const [permisos] = await pool().query(
        `SELECT x.id, x.tipo, x.referencia_id, x.usuario_nombre, x.detalle, x.fecha_solicitud, b.nombre AS boca FROM predio_permiso x
         LEFT JOIN predio_boca b ON b.predio_id = x.predio_id AND b.id = x.boca_id
         WHERE x.predio_id = ? AND x.estado = 'PENDIENTE' ORDER BY x.id DESC LIMIT 20`, [p.id]);
      res.json({
        predio: await resumenPredio(p),
        instancia_id: p.instancia_id,
        instalaciones: instalaciones.map(C.normalizar),
        comandos: comandos.map((c) => {
          const n = C.normalizar(c);
          try { n.actor = JSON.parse(n.actor || "null")?.nombre || null; } catch (_e) { n.actor = null; }
          return n;
        }),
        eventos: eventos.map(C.normalizar),
        permisos: permisos.map((x) => ({ ...C.normalizar(x), tipo_texto: x.tipo === "ANULAR_VENTA"
          ? `anular el ticket N° ${x.referencia_id}. Al aprobar se registra la anulación` : textoDe(TIPOS_PERMISO, x.tipo) })),
      });
    } catch (e) { responderError(res, e); }
  });

  router.put("/predios/:codigo", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      const nombre = req.body.nombre !== undefined ? U.texto(req.body.nombre, { max: 120, campo: "El nombre", requerido: true }) : p.nombre;
      const servicios = Array.isArray(req.body.servicios) ? JSON.stringify(req.body.servicios.map((s) => String(s).slice(0, 80))) : p.servicio_codigos;
      const activo = req.body.activo !== undefined ? U.bool(req.body.activo) : Number(p.activo);
      await pool().query("UPDATE predio SET nombre = ?, servicio_codigos = ?, activo = ? WHERE id = ?", [nombre, servicios, activo, p.id]);
      await C.evento(pool(), p.id, "EDICION", { nombre, servicios, activo }, req.actor.id);
      res.json({ mensaje: "Predio actualizado" });
    } catch (e) { responderError(res, e); }
  });

  // Ticket para abrir la pantalla del camping dentro del sistema general.
  router.post("/predios/:codigo/acceso", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      const token = jwt.sign({ tipo: "predio-remoto", uid: req.actor.id, pcod: p.codigo }, process.env.JWT_SECRET, { expiresIn: "10h" });
      res.json({ token, ruta: `/predios-app/${p.codigo}/` });
    } catch (e) { responderError(res, e); }
  });

  router.post("/predios/:codigo/instalador", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      const { token, hash } = C.nuevoToken();
      const nombre = U.texto(req.body?.nombre, { max: 120 }) || `Instalador del ${U.fechaHora().slice(0, 10)}`;
      await pool().query("INSERT INTO predio_instalacion (predio_id, nombre, token_hash, creado_por) VALUES (?, ?, ?, ?)", [p.id, nombre, hash, req.actor.id]);
      const urlServidor = process.env.PREDIOS_URL_PUBLICA || `https://${req.get("host")}/api`;
      const puertoPedido = Number(req.body?.puerto);
      const puerto = Number.isInteger(puertoPedido) && puertoPedido >= 80 && puertoPedido <= 65000 ? puertoPedido : 8080;
      const r = await C.armarInstalador(pool(), p, { urlServidor, token, puerto, incluirRuntime: req.body?.runtime !== false });
      await C.evento(pool(), p.id, "INSTALADOR", { nombre, version: r.version, con_runtime: r.runtime }, req.actor.id);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${r.nombreArchivo}"`);
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      r.zip.on("error", (e) => { console.error("Predios instalador:", e.message); res.destroy(e); });
      r.zip.pipe(res);
    } catch (e) { responderError(res, e); }
  });

  router.post("/predios/:codigo/instalaciones/:id/revocar", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      await pool().query("UPDATE predio_instalacion SET revocado_en = NOW() WHERE predio_id = ? AND id = ? AND revocado_en IS NULL", [p.id, Number(req.params.id)]);
      await C.evento(pool(), p.id, "INSTALACION_REVOCADA", { instalacion: Number(req.params.id) }, req.actor.id);
      res.json({ mensaje: "La clave de esa instalación quedó anulada" });
    } catch (e) { responderError(res, e); }
  });

  // Archivo para llevar al camping en pendrive: afiliados, órdenes pendientes y (opcional) el código nuevo.
  router.get("/predios/:codigo/paquete", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      const [pendientes] = await pool().query(
        "SELECT id, tipo, metodo, ruta, cuerpo, query, actor FROM predio_comando WHERE predio_id = ? AND estado IN ('PENDIENTE', 'ENTREGADO') ORDER BY id", [p.id]);
      // Los importadores anteriores ejecutan las órdenes antes de actualizar su
      // código. Las identidades propias sólo viajan por sync con capacidad v1.
      const comandos = pendientes.filter(c => JSON.parse(c.actor || "null")?.tipo !== "PREDIO");
      const serializadas = comandos.map((c) => ({ id: c.id, tipo: c.tipo, metodo: c.metodo, ruta: c.ruta, cuerpo: JSON.parse(c.cuerpo || "null"), query: JSON.parse(c.query || "null"), actor: JSON.parse(c.actor || "null") }));
      const datos = {
        tipo: "predio-paquete", predio_id: p.id, predio_codigo: p.codigo, generado: U.fechaHora(),
        maestros: await C.armarMaestros(pool(), p),
        comandos: serializadas.filter(c => !c.actor?.capacidad),
        comandos_precios: serializadas.filter(c => c.actor?.capacidad === "precios-boca-v1"),
        comandos_stock: serializadas.filter(c => c.actor?.capacidad === "stock-predio-v2"),
        comandos_operacion: serializadas.filter(c => c.actor?.capacidad === "operacion-predio-v2"),
        comandos_recepcion: serializadas.filter(c => c.actor?.capacidad === "recepcion-alquileres-v1"),
        comandos_cierre: serializadas.filter(c => c.actor?.capacidad === "cierre-clave-dia-v1"),
      };
      if (req.query.codigo === "1") {
        const paquete = C.paqueteCodigo();
        datos.codigo = paquete.buffer.toString("base64");
        datos.version = paquete.version;
      }
      const buffer = C.paqueteFirmado(datos);
      await C.evento(pool(), p.id, "PAQUETE_DESCARGADO", { comandos: comandos.length, con_codigo: req.query.codigo === "1" }, req.actor.id);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="paquete-${p.codigo.toLowerCase()}-${datos.generado.slice(0, 10)}.ajbpaquete"`);
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      res.send(buffer);
    } catch (e) { responderError(res, e); }
  });

  // Archivo exportado en la notebook (cuando no hay internet en el camping).
  router.post("/predios/:codigo/importar", proteger, express.raw({ type: () => true, limit: "300mb" }), async (req, res) => {
    try {
      const p = await predioDe(req);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw U.error("Elegí el archivo exportado en el camping");
      let datos;
      try { datos = JSON.parse(zlib.gunzipSync(req.body).toString("utf8")); } catch (_e) { throw U.error("No pudimos leer el archivo: ¿es el que exporta el sistema del camping (.ajbpredio)?"); }
      const resumen = await C.importarExportacion(pool(), p, datos, { forzar: req.query.forzar === "1", usuarioId: req.actor.id });
      const filas = Object.values(resumen).reduce((s, n) => s + n, 0);
      res.json({ mensaje: `Datos del camping cargados (${filas} registros, exportados el ${datos.generado})`, resumen });
    } catch (e) { responderError(res, e); }
  });

  const ACCIONES = {
    SINCRONIZAR_TODO: "Reenviar todos los datos al sistema general",
    ACTUALIZAR: "Buscar e instalar la última versión",
    REINICIAR: "Reiniciar el servidor del camping",
    SUBIR_LOGS: "Traer los registros del servidor",
    ACTUALIZAR_MAESTROS: "Actualizar afiliados con reserva",
  };

  router.post("/predios/:codigo/comandos", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      const accion = String(req.body?.accion || "");
      if (!ACCIONES[accion]) throw U.error("Acción desconocida");
      const actor = { general_id: req.actor.id, nombre: req.actor.nombre || "Administración", documento: req.actor.documento };
      const [r] = await pool().query(
        "INSERT INTO predio_comando (predio_id, tipo, ruta, descripcion, actor, creado_por) VALUES (?, 'SISTEMA', ?, ?, ?, ?)",
        [p.id, accion, ACCIONES[accion], JSON.stringify(actor), req.actor.id]);
      res.status(201).json({ id: r.insertId, mensaje: C.enLinea(p) ? "Orden enviada al camping" : "El camping está sin conexión: la orden se aplica cuando vuelva a conectarse" });
    } catch (e) { responderError(res, e); }
  });

  router.get("/predios/:codigo/comandos/:id", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      const [[c]] = await pool().query("SELECT * FROM predio_comando WHERE predio_id = ? AND id = ?", [p.id, Number(req.params.id)]);
      if (!c) throw U.error("No encontramos la orden", 404);
      const n = C.normalizar(c);
      try { n.resultado = JSON.parse(n.resultado || "null"); } catch (_e) { /* texto */ }
      if (String(c.ruta).startsWith("/caja/cierre")) {
        delete n.cuerpo;
        delete n.actor;
        delete n.query;
      }
      res.json({ comando: n });
    } catch (e) { responderError(res, e); }
  });

  // Aprobar o rechazar desde Mi AJB un pedido de autorización de una boca.
  router.post("/predios/:codigo/permisos/:id/resolver", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw U.error("Pedido inválido");
      const usuario = { id: req.actor.id, nombre: req.actor.nombre, apellido: "", documento: req.actor.documento };
      await ejecutarComoAdminGeneral(res, p, usuario, { metodo: "POST", ruta: `/permisos/${id}/resolver`, cuerpo: { aprobar: req.body?.aprobar === true || req.body?.aprobar === 1 } });
    } catch (e) { responderError(res, e); }
  });

  router.post("/predios/:codigo/comandos/:id/cancelar", proteger, async (req, res) => {
    try {
      const p = await predioDe(req);
      await pool().query("UPDATE predio_comando SET estado = 'CANCELADO', resuelto_en = NOW() WHERE predio_id = ? AND id = ? AND estado = 'PENDIENTE'", [p.id, Number(req.params.id)]);
      res.json({ mensaje: "Orden cancelada" });
    } catch (e) { responderError(res, e); }
  });

  return router;
}

// ================================================================== SINCRONIZACIÓN (notebook)

function crearRouterSync() {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.use(express.json({ limit: "60mb" }));

  const verificaciones = new Map();

  router.use(async (req, res, next) => {
    try {
      const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
      if (!token) return res.status(401).json({ mensaje: "Falta la clave de la instalación" });
      const [filas] = await pool().query(
        `SELECT i.id AS instalacion_id, i.revocado_en, p.* FROM predio_instalacion i JOIN predio p ON p.id = i.predio_id
         WHERE i.token_hash = ? LIMIT 1`, [U.sha256(token)]);
      const fila = filas[0];
      if (!fila || fila.revocado_en) return res.status(401).json({ mensaje: "La clave de esta instalación no es válida o fue anulada" });
      if (!Number(fila.activo)) return res.status(403).json({ mensaje: "El predio está desactivado en el sistema general" });
      req.predio = C.normalizar(fila);
      req.instalacionId = fila.instalacion_id;
      req.opcionesHa = { token, cabecera: req.headers["x-predio-ha"] || null };
      const instanciaCabecera = String(req.headers["x-predio-instancia"] || "");
      if (!["/version", "/codigo"].includes(req.path)) {
        const actual = await propietario.conPropietarioBloqueado(pool(), req.predio.id, async (conexion, predio) => {
          const datos = { instancia_id: instanciaCabecera, equipo_id: req.headers["x-predio-equipo"] || "" };
          const haAutorizada = await validarAutorizacionHa(conexion, predio, { ...req.opcionesHa, instanciaId: datos.instancia_id, equipoId: datos.equipo_id });
          if (predio.escritor === "LOCAL" && predio.instancia_id) propietario.exigirPropietario(predio, datos, { haAutorizada });
          return predio;
        });
        req.predio = C.normalizar(actual);
      }
      await pool().query("UPDATE predio_instalacion SET ultimo_uso = NOW(), ultima_ip = ?, instancia_id = COALESCE(?, instancia_id) WHERE id = ?",
        [String(req.ip || "").slice(0, 45), instanciaCabecera.slice(0, 64) || null, fila.instalacion_id]);
      next();
    } catch (e) { responderError(res, e); }
  });

  function remotoActivo(p) {
    return Date.now() - (accesoRemoto.get(p.codigo) || 0) < 60000;
  }

  async function comandosPendientes(p) {
    const [[c]] = await pool().query("SELECT COUNT(*) AS n FROM predio_comando WHERE predio_id = ? AND estado IN ('PENDIENTE', 'ENTREGADO')", [p.id]);
    return Number(c.n);
  }

  router.post("/hola", async (req, res) => {
    try {
      const saludo = await propietario.saludarPredio(pool(), req.predio.id, req.body || {}, req.opcionesHa);
      const p = C.normalizar(saludo.predio);
      res.json({
        predio: { id: p.id, codigo: p.codigo, nombre: p.nombre },
        escritor: p.escritor,
        accion: saludo.accion,
        conflicto: null,
        autoriza_escritura: saludo.autoriza_escritura,
        clave_lan: C.claveLan(p.id),
        remoto_activo: remotoActivo(p),
        comandos_pendientes: await comandosPendientes(p),
        version_disponible: C.paqueteCodigo().version,
        hora: U.fechaHora(),
      });
    } catch (e) { responderError(res, e); }
  });

  router.post("/tomar-control", async (req, res) => {
    try {
      res.json(await propietario.tomarControl(pool(), req.predio.id, req.body || {}, req.opcionesHa));
    } catch (e) { responderError(res, e); }
  });

  router.get("/snapshot", async (req, res) => {
    try {
      const filas = await C.instantaneaTabla(pool(), req.predio.id, String(req.query.tabla || ""), req.query.desde_id, req.query.limite);
      res.json({ filas });
    } catch (e) { responderError(res, e); }
  });

  router.post("/push", async (req, res) => {
    const p = req.predio;
    const b = req.body || {};
    try {
      const conexion = await pool().getConnection();
      let resultado;
      try {
        await conexion.beginTransaction();
        const [[actual]] = await conexion.query("SELECT * FROM predio WHERE id = ? FOR UPDATE", [p.id]);
        if (!actual) throw U.error("No encontramos el predio", 404);
        const haAutorizada = await validarAutorizacionHa(conexion, actual, { ...req.opcionesHa, instanciaId: b.instancia_id, equipoId: b.equipo_id });
        propietario.exigirPropietario(actual, b, { exigirLocal: true, haAutorizada });
        resultado = await C.aplicarCambios(conexion, p, Array.isArray(b.cambios) ? b.cambios : []);
        await conexion.query("UPDATE predio SET ultimo_push = NOW(), ultimo_seq = GREATEST(ultimo_seq, ?) WHERE id = ?", [Number(b.hasta_seq) || 0, p.id]);
        await conexion.commit();
      } catch (e) {
        await conexion.rollback();
        throw e;
      } finally {
        conexion.release();
      }
      if (resultado.nuevosPermisos.length) avisarPermisos(p, resultado.nuevosPermisos).catch((e) => console.error("Predios avisos:", e.message));
      res.json({ ok: true, ack: Number(b.hasta_seq) || 0, remoto_activo: remotoActivo(p), comandos_pendientes: await comandosPendientes(p) });
    } catch (e) { responderError(res, e); }
  });

  async function avisarPermisos(p, permisos) {
    const [admins] = await pool().query(
      "SELECT u.id FROM usuario u JOIN rol r ON r.id = u.rol_id WHERE r.nombre = 'admin' AND (u.habilitado IS NULL OR UPPER(u.habilitado) NOT IN ('N', 'NO', '0'))");
    for (const permiso of permisos.slice(0, 5)) {
      for (const a of admins) {
        await crearNotificacion(pool(), {
          usuarioId: a.id,
          tipo: "PREDIO_PERMISO_PENDIENTE",
          titulo: permiso.tipo === "ANULAR_VENTA" ? `${p.nombre}: pedido de anulación del ticket N° ${permiso.referencia_id}`
            : `${p.nombre}: ${permiso.usuario_nombre || "un usuario"} pide autorización`,
          mensaje: `Para ${textoDe(TIPOS_PERMISO, permiso.tipo).toLowerCase()}${permiso.detalle ? ` (${permiso.detalle})` : ""}. Podés aprobarlo desde Predios.`,
          payload: { predio: p.codigo, permiso_id: permiso.id },
        });
      }
    }
  }

  router.get("/comandos", async (req, res) => {
    try {
      const capacidades = String(req.headers["x-predio-capacidades"] || "").split(",").map(c => c.trim());
      const comandos = await conAutoridadSync(req, async (conexion, p) => {
        const [filas] = await conexion.query(
          `SELECT id, tipo, metodo, ruta, cuerpo, query, actor FROM predio_comando
           WHERE predio_id = ? AND (estado = 'PENDIENTE' OR (estado = 'ENTREGADO' AND entregado_en < NOW() - INTERVAL 60 SECOND))
             AND (? = 1 OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(actor, '$.tipo')), '') <> 'PREDIO')
             AND (? = 1 OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(actor, '$.capacidad')), '') <> 'precios-boca-v1')
             AND (? = 1 OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(actor, '$.capacidad')), '') <> 'stock-predio-v2')
             AND (? = 1 OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(actor, '$.capacidad')), '') <> 'operacion-predio-v2')
             AND (? = 1 OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(actor, '$.capacidad')), '') <> 'recepcion-alquileres-v1')
             AND (? = 1 OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(actor, '$.capacidad')), '') <> 'cierre-clave-dia-v1')
           ORDER BY id LIMIT 20`, [p.id, capacidades.includes("cuentas-predio-v1") ? 1 : 0,
             capacidades.includes("precios-boca-v1") ? 1 : 0, capacidades.includes("stock-predio-v2") ? 1 : 0,
             capacidades.includes("operacion-predio-v2") ? 1 : 0, capacidades.includes("recepcion-alquileres-v1") ? 1 : 0,
             capacidades.includes("cierre-clave-dia-v1") ? 1 : 0]);
        if (filas.length) {
          await conexion.query(`UPDATE predio_comando SET estado = 'ENTREGADO', entregado_en = NOW(), intentos = intentos + 1 WHERE id IN (?)`, [filas.map(c => c.id)]);
        }
        return filas;
      });
      res.json({
        comandos: comandos.map((c) => ({
          id: c.id, tipo: c.tipo, metodo: c.metodo, ruta: c.ruta,
          cuerpo: JSON.parse(c.cuerpo || "null"), query: JSON.parse(c.query || "null"), actor: JSON.parse(c.actor || "null"),
        })),
      });
    } catch (e) { responderError(res, e); }
  });

  router.post("/comandos/:id/resultado", async (req, res) => {
    try {
      const b = req.body || {};
      const respuesta = JSON.stringify(b.respuesta ?? null);
      await conAutoridadSync(req, (conexion, p) => conexion.query(
          `UPDATE predio_comando SET estado = ?, status = ?, resultado = ?, resuelto_en = NOW()
           WHERE predio_id = ? AND id = ? AND estado IN ('PENDIENTE', 'ENTREGADO')`,
          [b.ok ? "OK" : "ERROR", Number(b.status) || (b.ok ? 200 : 500), respuesta.slice(0, 4000000), p.id, Number(req.params.id)]));
      res.json({ ok: true });
    } catch (e) { responderError(res, e); }
  });

  // El middleware acredita la petición, pero otro servidor puede registrar un
  // término posterior mientras ésta espera. Las mutaciones de órdenes vuelven
  // a comprobarlo bajo el mismo lock que conserva la escritura del resultado.
  async function conAutoridadSync(req, trabajo) {
    return propietario.conPropietarioBloqueado(pool(), req.predio.id, async (conexion, p) => {
      const datos = { instancia_id: req.headers["x-predio-instancia"] || "", equipo_id: req.headers["x-predio-equipo"] || "" };
      const haAutorizada = await validarAutorizacionHa(conexion, p, { ...req.opcionesHa, instanciaId: datos.instancia_id, equipoId: datos.equipo_id });
      if (p.escritor === "LOCAL" && p.instancia_id) propietario.exigirPropietario(p, datos, { haAutorizada });
      return trabajo(conexion, p);
    });
  }

  router.post("/recepcion", async (req, res) => {
    try {
      const resultado = await conAutoridadSync(req, async (conexion, predio) => {
        if (predio.escritor !== "LOCAL") throw U.error("La instalación no es el escritor del predio", 409);
        const [[actor]] = await conexion.query(
          "SELECT id,nombre,rol,gestionar_reservas,general_usuario_id FROM predio_usuario WHERE predio_id=? AND id=? AND activo=1 FOR SHARE",
          [predio.id, U.id(req.body.empleado_id)]
        );
        if (!actor || (actor.rol !== "ADMIN" && !Number(actor.gestionar_reservas))) throw U.error("La cuenta no tiene permiso de recepción sincronizado.", 403);
        const capacidades = String(req.headers["x-predio-capacidades"] || "").split(",");
        if (!capacidades.includes("recepcion-alquileres-v1") && ["cotizar", "guardar"].includes(req.body.accion) && req.body.datos?.id) {
          const [[ultimo]] = await conexion.query(`SELECT JSON_LENGTH(e.actual, '$.alquileres') AS alquileres
            FROM recepcion_reserva_evento e WHERE e.reserva_id=? AND e.predio_id=? ORDER BY e.id DESC LIMIT 1`,
          [U.id(req.body.datos.id), predio.id]);
          if (Number(ultimo?.alquileres)) throw U.error("Actualizá el sistema local del predio para editar una reserva con alquileres por día.", 409);
        }
        return require("../services/recepcion").operar(conexion, predio, actor, req.body.accion, req.body.datos || {});
      });
      res.json(resultado);
    } catch (e) { responderError(res, e); }
  });
  router.get("/maestros", async (req, res) => {
    try {
      res.json(await C.armarMaestros(pool(), req.predio));
    } catch (e) { responderError(res, e); }
  });

  router.post("/verificar-admin", async (req, res) => {
    try {
      const clave = `${req.instalacionId}`;
      const ahora = Date.now();
      const v = verificaciones.get(clave) || { inicio: ahora, n: 0 };
      if (ahora - v.inicio > 15 * 60000) { v.inicio = ahora; v.n = 0; }
      if (++v.n > 30) return res.status(429).json({ mensaje: "Demasiados intentos" });
      verificaciones.set(clave, v);
      const documento = String(req.body?.documento || "").replace(/\D/g, "");
      const password = String(req.body?.password || "");
      if (!documento || !password) return res.json({ ok: false });
      const [[u]] = await pool().query(
        `SELECT u.id, u.nombre, u.apellido, u.documento, u.password, u.habilitado, u.bloqueo_tipo, r.nombre AS rol
         FROM usuario u JOIN rol r ON r.id = u.rol_id WHERE u.documento = ? LIMIT 1`, [Number(documento)]);
      if (!u || !u.password || !(await bcrypt.compare(password, u.password))) return res.json({ ok: false });
      if (u.rol !== "admin" || ["N", "NO", "0"].includes(String(u.habilitado || "").toUpperCase()) || u.bloqueo_tipo === "total") {
        return res.json({ ok: false, motivo: "NO_ADMIN" });
      }
      await C.evento(pool(), req.predio.id, "INGRESO_ADMIN_GENERAL", { usuario: u.id });
      res.json({ ok: true, id: u.id, nombre: nombreUsuario(u) });
    } catch (e) { responderError(res, e); }
  });

  router.get("/version", (_req, res) => {
    const p = C.paqueteCodigo();
    res.json({ version: p.version, sha256: p.sha256, tamano: p.tamano, firma: p.firma });
  });

  router.get("/codigo", (_req, res) => {
    const p = C.paqueteCodigo();
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Firma", p.firma);
    res.send(p.buffer);
  });

  return router;
}

// ================================================================== PANTALLA REMOTA

const TIPOS_ESTATICOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
};

function crearRouterApp() {
  const router = express.Router();
  const ancestros = (() => {
    try { return [...obtenerOrigenesPermitidos()].join(" "); } catch (_e) { return ""; }
  })();

  function cabeceras(res) {
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy",
      `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self' ${ancestros}; base-uri 'self'; form-action 'self'`);
    res.setHeader("Cache-Control", "no-store");
  }

  router.use(express.json({ limit: "3mb" }));

  async function autenticar(req) {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
    if (!token) throw U.error("Abrí el predio desde el sistema general", 401, { codigo: "SIN_SESION" });
    if (esTokenPredio(token)) {
      const cuenta = await autenticarCuentaPredio({ db: pool(), token, jwtSecret: process.env.JWT_SECRET });
      if (String(cuenta.predio_codigo) !== String(req.params.codigo).toUpperCase()) throw U.error("Tu cuenta sólo puede abrir su propio predio", 403);
      const predio = await C.obtenerPredio(pool(), req.params.codigo);
      if (!predio || Number(predio.id) !== Number(cuenta.predio_id) || Number(predio.activo) !== 1) throw U.error("Tu cuenta ya no tiene acceso a este predio", 401, { codigo: "SIN_SESION" });
      accesoRemoto.set(predio.codigo, Date.now());
      return { usuario: cuenta, predio, cuentaPredio: true, token };
    }
    let datos;
    try { datos = jwt.verify(token, process.env.JWT_SECRET); } catch (_e) { throw U.error("La sesión remota venció. Volvé a abrir el predio desde el sistema general.", 401, { codigo: "SIN_SESION" }); }
    if (datos.tipo !== "predio-remoto" || String(datos.pcod) !== String(req.params.codigo).toUpperCase()) throw U.error("Acceso no válido", 401, { codigo: "SIN_SESION" });
    const [[u]] = await pool().query(
      `SELECT u.id, u.nombre, u.apellido, u.documento, u.habilitado, u.auth_revocado_desde, r.nombre AS rol
       FROM usuario u JOIN rol r ON r.id = u.rol_id WHERE u.id = ?`, [Number(datos.uid)]);
    if (!u || u.rol !== "admin" || ["N", "NO", "0"].includes(String(u.habilitado || "").toUpperCase())) throw U.error("Tu usuario ya no tiene acceso", 401, { codigo: "SIN_SESION" });
    if (u.auth_revocado_desde && new Date(u.auth_revocado_desde).getTime() >= datos.iat * 1000) throw U.error("Tu sesión fue cerrada", 401, { codigo: "SIN_SESION" });
    const predio = await C.obtenerPredio(pool(), req.params.codigo);
    if (!predio) throw U.error("No encontramos el predio", 404);
    accesoRemoto.set(predio.codigo, Date.now());
    return { usuario: u, predio };
  }

  async function estadoRemoto(predio) {
    const [[c]] = await pool().query("SELECT COUNT(*) AS n FROM predio_comando WHERE predio_id = ? AND tipo = 'API' AND estado IN ('PENDIENTE', 'ENTREGADO')", [predio.id]);
    return {
      codigo: predio.codigo, nombre: predio.nombre, escritor: predio.escritor, en_linea: C.enLinea(predio),
      ultima_conexion: predio.ultima_conexion, ultimo_push: predio.ultimo_push, equipo: predio.equipo,
      version_local: predio.version_local, pendientes_local: Number(predio.pendientes_local || 0), cambios_en_cola: Number(c.n),
    };
  }

  router.all("/:codigo/api/*", async (req, res) => {
    cabeceras(res);
    try {
      const { usuario, predio, cuentaPredio, token } = await autenticar(req);
      const ruta = `/${req.params[0]}`.replace(/\/+$/, "") || "/";
      const metodo = req.method === "HEAD" ? "GET" : req.method;
      clavesUsuario.exigirCambio(usuario, metodo, ruta);
      const nombre = `${nombreUsuario(usuario)} (sistema general)`;
      const db = crearMysql(pool(), { predioId: predio.id });
      const bocas = (await db.all("SELECT id FROM predio_boca WHERE predio_id = ?", [predio.id])).map((b) => Number(b.id));
      const base = cuentaPredio ? await contextoCuentaPredio(db, predio, usuario, req.ip) : {
        db, pid: predio.id, modo: "central", origen: "REMOTO", ip: req.ip, servicios: {},
        usuario: { id: null, usuario: `dni${usuario.documento}`, nombre, rol: "ADMIN", bocas, es_admin_general: true },
        sesion: {}, query: { ...req.query }, body: req.body && typeof req.body === "object" ? req.body : {},
      };
      if (metodo === "GET" && ruta === "/sesion") {
        if (base.usuario.debe_cambiar_clave) return res.json({ usuario: { ...base.usuario, bocas: [] }, puestos: [], puesto: null, predio: { nombre: predio.nombre } });
        const config = await db.all("SELECT clave, valor FROM predio_config WHERE predio_id = ?", [predio.id]);
        const nombrePredio = config.find((c) => c.clave === "nombre_predio")?.valor || predio.nombre;
        return res.json({
          usuario: base.usuario, puestos: [], puesto: null, predio: { nombre: nombrePredio }, remoto: await estadoRemoto(predio),
        });
      }
      if (metodo === "GET" && ruta === "/estado-remoto") return res.json(await estadoRemoto(predio));
      if (metodo === "POST" && ruta === "/logout") {
        if (cuentaPredio) await cerrarSesionPredio({ db: pool(), token, jwtSecret: process.env.JWT_SECRET });
        return res.json({ ok: true });
      }
      if (cuentaPredio) return await ejecutarComoAdminPredio(res, predio, usuario, token, { metodo, ruta, cuerpo: req.body && typeof req.body === "object" ? req.body : {}, query: { ...req.query }, ip: req.ip });
      return await ejecutarComoAdminGeneral(res, predio, usuario, { metodo, ruta, cuerpo: base.body, query: base.query, ip: req.ip });
    } catch (e) { responderError(res, e); }
  });

  // Estáticos de la pantalla del predio.
  router.get("/:codigo", (req, res, next) => {
    if (req.originalUrl.split("?")[0].endsWith("/")) return next();
    return res.redirect(302, `${req.baseUrl}/${encodeURIComponent(req.params.codigo)}/`);
  });
  router.get("/:codigo/*", (req, res) => {
    cabeceras(res);
    const codigo = String(req.params.codigo).toUpperCase().replace(/[^A-Z0-9_]/g, "");
    let relativo = req.params[0] || "index.html";
    if (relativo === "" || relativo.endsWith("/")) relativo += "index.html";
    const archivo = path.normalize(path.join(DIR_PUBLICO, relativo));
    if (!archivo.startsWith(DIR_PUBLICO) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
      return res.status(404).type("text/plain").send("No encontrado");
    }
    const ext = path.extname(archivo).toLowerCase();
    res.type(TIPOS_ESTATICOS[ext] || "application/octet-stream");
    if (archivo.endsWith("index.html")) {
      const html = fs.readFileSync(archivo, "utf8")
        .replace("<html", `<html data-modo="remoto" data-api="${req.baseUrl}/${codigo}/api" data-predio="${codigo}"`)
        .replace(/__VERSION__/g, encodeURIComponent(C.paqueteCodigo().version));
      return res.send(html);
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(fs.readFileSync(archivo));
  });

  return router;
}

module.exports = { crearRouterAdmin, crearRouterSync, crearRouterApp, crearRouterCuenta };
