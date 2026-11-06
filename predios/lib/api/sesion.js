"use strict";

// Ingreso al sistema del predio (sólo en el servidor local del camping).
// Usuarios propios del predio (administradores y usuarios de boca) y, además, los
// administradores del sistema general con su DNI y contraseña de siempre.

const U = require("../util");
const N = require("../negocio");
const acceso = require("../acceso");

async function bocasUsuario(db, ctx, usuario) {
  if (usuario.rol === "ADMIN") {
    const filas = await db.all("SELECT id FROM predio_boca WHERE predio_id = ? AND activo = 1", [ctx.pid]);
    return filas.map((f) => Number(f.id));
  }
  const filas = await db.all(
    `SELECT ub.boca_id FROM predio_usuario_boca ub JOIN predio_boca b ON b.predio_id = ub.predio_id AND b.id = ub.boca_id
     WHERE ub.predio_id = ? AND ub.usuario_id = ? AND b.activo = 1`, [ctx.pid, usuario.id]);
  return filas.map((f) => Number(f.boca_id));
}

async function puestosDisponibles(db, ctx, usuario, bocas) {
  if (!bocas.length) return [];
  const l = bocas.map(() => "?").join(", ");
  const filas = await db.all(
    `SELECT b.id AS boca_id, b.nombre AS boca, b.es_almacen, b.es_origen, b.es_destino, c.id AS caja_id, c.nombre AS caja
     FROM predio_boca b LEFT JOIN predio_caja c ON c.predio_id = b.predio_id AND c.boca_id = b.id AND c.activo = 1
     WHERE b.predio_id = ? AND b.activo = 1 AND b.id IN (${l}) ORDER BY b.nombre, c.nombre`, [ctx.pid, ...bocas]);
  const mapa = new Map();
  for (const f of filas) {
    if (!mapa.has(f.boca_id)) {
      mapa.set(f.boca_id, { boca_id: f.boca_id, boca: f.boca, es_almacen: !!Number(f.es_almacen), es_origen: !!Number(f.es_origen), es_destino: !!Number(f.es_destino), cajas: [] });
    }
    if (f.caja_id) mapa.get(f.boca_id).cajas.push({ caja_id: f.caja_id, caja: f.caja });
  }
  return [...mapa.values()];
}

async function crearSesion(ctx, usuario, recordar) {
  const token = U.tokenAleatorio(32);
  const ahora = U.fechaHora();
  await ctx.db.run(
    `INSERT INTO predio_sesion (token_hash, usuario_id, recordar, creada, vence, ultimo_uso, ip, agente)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [U.sha256(token), usuario.id, recordar ? 1 : 0, ahora,
      recordar ? null : U.fechaHora(new Date(Date.now() + 12 * 3600 * 1000)), ahora,
      String(ctx.ip || "").slice(0, 45), String(ctx.agenteHttp || "").slice(0, 200)]);
  await ctx.db.tx(async (t) => {
    await t.run("UPDATE predio_usuario SET ultimo_ingreso = ? WHERE predio_id = ? AND id = ?", [ahora, ctx.pid, usuario.id]);
    await N.auditar(t, { ...ctx, usuario }, "Ingreso al sistema", "sesion", usuario.id, { recordar: !!recordar });
  });
  return token;
}

async function asegurarUsuarioGeneral(ctx, datos) {
  return ctx.db.tx(async (t) => {
    const usuario = `dni${datos.documento}`;
    let fila = await t.get("SELECT * FROM predio_usuario WHERE predio_id = ? AND (general_usuario_id = ? OR usuario = ?)", [ctx.pid, datos.id, usuario]);
    const actor = { ...ctx, usuario: { id: null, nombre: "Sistema" } };
    if (!fila) {
      const id = await N.insertar(t, actor, "predio_usuario", {
        usuario, nombre: datos.nombre, rol: "ADMIN", activo: 1, es_admin_general: 1, general_usuario_id: datos.id, documento: String(datos.documento),
      });
      fila = await N.obtener(t, ctx, "predio_usuario", id);
    } else if (fila.nombre !== datos.nombre || Number(fila.activo) !== 1 || fila.rol !== "ADMIN") {
      await N.actualizar(t, actor, "predio_usuario", fila.id, { nombre: datos.nombre, activo: 1, rol: "ADMIN", es_admin_general: 1, general_usuario_id: datos.id });
      fila = await N.obtener(t, ctx, "predio_usuario", fila.id);
    }
    return fila;
  });
}

async function login(ctx) {
  return acceso.serializarIngreso(ctx, () => ingresar(ctx));
}

async function ingresar(ctx) {
  const identificador = String(ctx.body.usuario || "").trim().toLowerCase();
  const password = String(ctx.body.password || "");
  const recordar = U.bool(ctx.body.recordar);
  if (!identificador || !password) throw U.error("Escribí tu usuario y tu contraseña");
  let usuario = await ctx.db.get("SELECT * FROM predio_usuario WHERE predio_id = ? AND usuario = ? AND es_admin_general = 0", [ctx.pid, identificador]);
  const dni = identificador.replace(/[.\s]/g, "");
  const documento = /^\d{6,9}$/.test(dni) ? String(Number(dni)) : null;
  const cuenta = usuario || (documento ? await ctx.db.get("SELECT * FROM predio_usuario WHERE predio_id = ? AND es_admin_general = 1 AND documento = ?", [ctx.pid, documento]) : null);
  const claves = acceso.clavesDe(ctx, documento || identificador, cuenta);
  await acceso.controlarIntentos(ctx, claves);
  if (usuario && Number(usuario.activo) === 1 && U.verificarPassword(password, usuario.password_hash)) {
    // usuario del predio
  } else {
    usuario = null;
    if (documento) {
      const general = await verificarAdminGeneral(ctx, documento, password);
      if (general) usuario = await asegurarUsuarioGeneral(ctx, general);
    }
  }
  if (!usuario) {
    const bloqueo = await acceso.registrarFallo(ctx, claves, documento || identificador, cuenta);
    if (bloqueo) throw bloqueo;
    throw U.error("Usuario o contraseña incorrectos", 401);
  }
  await acceso.registrarExito(ctx, claves);
  const token = await crearSesion(ctx, usuario, recordar);
  return { token, recordar: !!recordar, ...(await armarSesion(ctx, usuario, {})) };
}

// Administradores del sistema general: se validan contra el sistema general cuando hay
// internet y se recuerdan (hash local) para poder entrar aunque se corte la conexión.
async function verificarAdminGeneral(ctx, documento, password) {
  const agente = ctx.servicios?.agente;
  let remoto = null;
  let consultado = false;
  if (agente && agente.configurado()) {
    try {
      remoto = await agente.verificarAdminGeneral(documento, password);
      consultado = true;
    } catch (_e) {
      consultado = false;
    }
  }
  if (consultado) {
    if (remoto && remoto.ok) {
      await ctx.db.run(
        `INSERT INTO predio_admin_cache (documento, hash, nombre, general_id, actualizado) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(documento) DO UPDATE SET hash = excluded.hash, nombre = excluded.nombre, general_id = excluded.general_id, actualizado = excluded.actualizado`,
        [documento, U.hashPassword(password), remoto.nombre, remoto.id, U.fechaHora()]);
      return { id: remoto.id, nombre: remoto.nombre, documento };
    }
    if (remoto && remoto.motivo === "NO_ADMIN") await ctx.db.run("DELETE FROM predio_admin_cache WHERE documento = ?", [documento]);
    return null;
  }
  const cache = await ctx.db.get("SELECT * FROM predio_admin_cache WHERE documento = ?", [documento]);
  if (cache && U.verificarPassword(password, cache.hash)) return { id: cache.general_id, nombre: cache.nombre, documento };
  return null;
}

async function armarSesion(ctx, usuario, sesion) {
  const bocas = await bocasUsuario(ctx.db, ctx, usuario);
  const puestos = await puestosDisponibles(ctx.db, ctx, usuario, bocas);
  const config = await N.leerConfig(ctx.db, ctx);
  let puesto = null;
  if (sesion.caja_id) {
    puesto = await ctx.db.get(
      `SELECT c.id AS caja_id, c.nombre AS caja, c.ancho_ticket, c.impresion_automatica, c.imprimir_comanda, b.id AS boca_id, b.nombre AS boca, b.es_almacen
       FROM predio_caja c JOIN predio_boca b ON b.predio_id = c.predio_id AND b.id = c.boca_id
       WHERE c.predio_id = ? AND c.id = ?`, [ctx.pid, sesion.caja_id]);
    if (puesto) { puesto.turno_id = sesion.turno_id; puesto.imprimir_comanda = !!Number(puesto.imprimir_comanda); }
  } else if (sesion.boca_id) {
    const b = await ctx.db.get("SELECT id AS boca_id, nombre AS boca, es_almacen FROM predio_boca WHERE predio_id = ? AND id = ?", [ctx.pid, sesion.boca_id]);
    if (b) puesto = { ...b, caja_id: null };
  }
  return {
    usuario: {
      id: usuario.id, usuario: usuario.usuario, nombre: usuario.nombre, rol: usuario.rol,
      es_admin_general: !!Number(usuario.es_admin_general), bocas,
    },
    puestos,
    puesto,
    predio: { nombre: config.nombre_predio, razon_social: config.razon_social },
  };
}

async function verSesion(ctx) {
  const u = await N.exigir(ctx.db, ctx, "predio_usuario", ctx.usuario.id, "El usuario ya no existe");
  return armarSesion(ctx, u, ctx.sesion || {});
}

async function elegirPuesto(ctx) {
  const bocaId = U.id(ctx.body.boca_id, "La boca");
  const cajaId = ctx.body.caja_id ? U.id(ctx.body.caja_id, "La caja") : null;
  const u = await N.exigir(ctx.db, ctx, "predio_usuario", ctx.usuario.id, "El usuario ya no existe");
  const bocas = await bocasUsuario(ctx.db, ctx, u);
  if (!bocas.includes(bocaId)) throw U.error("No tenés asignada esa boca", 403);
  if (cajaId) {
    const caja = await N.exigir(ctx.db, ctx, "predio_caja", cajaId, "No encontramos la caja");
    if (Number(caja.boca_id) !== bocaId || !Number(caja.activo)) throw U.error("La caja no pertenece a esa boca");
  }
  const sesion = ctx.sesion || {};
  let turnoId = sesion.turno_id || null;
  await ctx.db.tx(async (t) => {
    if (turnoId && Number(sesion.caja_id) !== Number(cajaId)) {
      await t.run("UPDATE predio_turno SET fin = ?, estado = 'CERRADO' WHERE predio_id = ? AND id = ? AND estado = 'ABIERTO'", [U.fechaHora(), ctx.pid, turnoId]);
      turnoId = null;
    }
    if (cajaId && !turnoId) {
      turnoId = await N.insertar(t, ctx, "predio_turno", {
        caja_id: cajaId, boca_id: bocaId, usuario_id: u.id, usuario_nombre: u.nombre, inicio: U.fechaHora(), estado: "ABIERTO",
      });
      await N.auditar(t, ctx, "Inicio de turno", "caja", cajaId, { turno_id: turnoId, boca_id: bocaId });
    }
  });
  await ctx.db.run("UPDATE predio_sesion SET boca_id = ?, caja_id = ?, turno_id = ? WHERE token_hash = ?",
    [bocaId, cajaId, cajaId ? turnoId : null, sesion.token_hash]);
  await acceso.registrarPuesto(ctx, bocaId, cajaId);
  return armarSesion(ctx, u, { boca_id: bocaId, caja_id: cajaId, turno_id: cajaId ? turnoId : null });
}

async function cerrarTurno(ctx) {
  const s = ctx.sesion || {};
  if (s.turno_id) {
    await ctx.db.tx(async (t) => {
      await t.run("UPDATE predio_turno SET fin = ?, estado = 'CERRADO' WHERE predio_id = ? AND id = ? AND estado = 'ABIERTO'", [U.fechaHora(), ctx.pid, s.turno_id]);
      await N.auditar(t, ctx, "Fin de turno", "caja", s.caja_id || null, { turno_id: s.turno_id });
    });
  }
}

async function salirPuesto(ctx) {
  const s = ctx.sesion || {};
  if (!s.token_hash) throw U.error("Iniciá sesión para continuar", 401);
  await ctx.db.tx(async (t) => {
    if (s.turno_id) {
      await t.run("UPDATE predio_turno SET fin = ?, estado = 'CERRADO' WHERE predio_id = ? AND id = ? AND usuario_id = ? AND estado = 'ABIERTO'",
        [U.fechaHora(), ctx.pid, s.turno_id, ctx.usuario.id]);
    }
    await t.run("UPDATE predio_sesion SET boca_id = NULL, caja_id = NULL, turno_id = NULL WHERE token_hash = ? AND usuario_id = ?", [s.token_hash, ctx.usuario.id]);
    await N.auditar(t, ctx, "Salida del puesto de caja", "caja", s.caja_id || null, { boca_id: s.boca_id || null, turno_id: s.turno_id || null });
  });
  const usuario = await N.exigir(ctx.db, ctx, "predio_usuario", ctx.usuario.id, "El usuario ya no existe");
  return { ok: true, ...(await armarSesion(ctx, usuario, {})) };
}

async function logout(ctx) {
  await cerrarTurno(ctx);
  await ctx.db.run("DELETE FROM predio_sesion WHERE token_hash = ?", [ctx.sesion.token_hash]);
  await ctx.db.tx((t) => N.auditar(t, ctx, "Salida del sistema", "sesion", ctx.usuario.id, null));
  return { ok: true };
}

async function cambiarClave(ctx) {
  const actual = String(ctx.body.actual || "");
  const nueva = String(ctx.body.nueva || "");
  const u = await N.exigir(ctx.db, ctx, "predio_usuario", ctx.usuario.id, "El usuario ya no existe");
  if (Number(u.es_admin_general)) throw U.error("Tu contraseña es la del sistema general: cambiala desde ahí");
  if (!U.verificarPassword(actual, u.password_hash)) throw U.error("La contraseña actual no es correcta", 403);
  if (nueva.length < 4) throw U.error("La contraseña nueva tiene que tener al menos 4 caracteres");
  await ctx.db.tx(async (t) => {
    await N.actualizar(t, ctx, "predio_usuario", u.id, { password_hash: U.hashPassword(nueva) });
    await N.auditar(t, ctx, "Cambio de contraseña propia", "usuario", u.id, null);
  });
  await ctx.db.run("DELETE FROM predio_sesion WHERE usuario_id = ? AND token_hash <> ?", [u.id, ctx.sesion.token_hash]);
  return { mensaje: "Contraseña cambiada" };
}

async function estadoPublico(ctx) {
  const usuarios = await ctx.db.get("SELECT COUNT(*) AS n FROM predio_usuario WHERE predio_id = ? AND es_admin_general = 0", [ctx.pid]);
  const config = await N.leerConfig(ctx.db, ctx);
  const agente = ctx.servicios?.agente;
  return {
    nombre: config.nombre_predio,
    razon_social: config.razon_social,
    configurado: Number(usuarios.n) > 0,
    local: ctx.esLocalhost === true,
    version: ctx.servicios?.version || null,
    en_linea: agente ? agente.enLinea() : false,
    vinculado: agente ? agente.configurado() : false,
    hora: U.fechaHora(),
  };
}

async function primerUso(ctx) {
  if (!ctx.esLocalhost) throw U.error("La configuración inicial se hace desde la notebook servidor", 403);
  const existe = await ctx.db.get("SELECT COUNT(*) AS n FROM predio_usuario WHERE predio_id = ? AND es_admin_general = 0", [ctx.pid]);
  if (Number(existe.n) > 0) throw U.error("El sistema ya tiene usuarios", 409);
  const usuario = U.texto(ctx.body.usuario, { max: 60, min: 3, campo: "El usuario", requerido: true }).toLowerCase().replace(/\s+/g, "");
  if (!/^[a-z0-9._-]+$/.test(usuario)) throw U.error("El usuario sólo puede tener letras, números, punto, guion o guion bajo");
  const nombre = U.texto(ctx.body.nombre, { max: 120, campo: "El nombre", requerido: true });
  const password = String(ctx.body.password || "");
  if (password.length < 4) throw U.error("La contraseña tiene que tener al menos 4 caracteres");
  const actor = { ...ctx, usuario: { id: null, nombre: "Configuración inicial" } };
  const id = await ctx.db.tx(async (t) => {
    const nuevo = await N.insertar(t, actor, "predio_usuario", {
      usuario, nombre, rol: "ADMIN", password_hash: U.hashPassword(password), activo: 1, es_admin_general: 0,
    });
    await N.auditar(t, actor, "Alta del primer administrador", "usuario", nuevo, { usuario, nombre });
    return nuevo;
  });
  const u = await N.obtener(ctx.db, ctx, "predio_usuario", id);
  const token = await crearSesion(ctx, u, U.bool(ctx.body.recordar));
  return { token, ...(await armarSesion(ctx, u, {})) };
}

// Valida el token de una petición y arma ctx.usuario / ctx.sesion.
async function autenticar(ctx, token) {
  if (!token) return null;
  const hash = U.sha256(token);
  const s = await ctx.db.get("SELECT * FROM predio_sesion WHERE token_hash = ?", [hash]);
  if (!s) return null;
  const ahora = U.fechaHora();
  if (s.vence && s.vence < ahora) {
    if (!ctx.soloLectura) await ctx.db.run("DELETE FROM predio_sesion WHERE token_hash = ?", [hash]);
    return null;
  }
  const u = await ctx.db.get("SELECT * FROM predio_usuario WHERE predio_id = ? AND id = ?", [ctx.pid, s.usuario_id]);
  if (!u || Number(u.activo) !== 1) return null;
  if (!ctx.soloLectura && (!s.ultimo_uso || s.ultimo_uso < U.fechaHora(new Date(Date.now() - 60000)))) {
    const vence = s.recordar ? null : U.fechaHora(new Date(Date.now() + 12 * 3600 * 1000));
    await ctx.db.run("UPDATE predio_sesion SET ultimo_uso = ?, vence = ? WHERE token_hash = ?", [ahora, vence, hash]);
  }
  const bocas = await bocasUsuario(ctx.db, ctx, u);
  return {
    usuario: { id: Number(u.id), usuario: u.usuario, nombre: u.nombre, rol: u.rol, bocas, es_admin_general: !!Number(u.es_admin_general) },
    sesion: { token_hash: hash, boca_id: s.boca_id, caja_id: s.caja_id, turno_id: s.turno_id },
  };
}

module.exports = {
  autenticar,
  asegurarUsuarioGeneral,
  rutas: [
    { m: "GET", p: "/estado-publico", h: estadoPublico, publica: true, soloLocal: true },
    { m: "POST", p: "/primer-uso", h: primerUso, publica: true, soloLocal: true },
    { m: "POST", p: "/login", h: login, publica: true, soloLocal: true },
    { m: "POST", p: "/logout", h: logout, soloLocal: true },
    { m: "GET", p: "/sesion", h: verSesion, soloLocal: true },
    { m: "POST", p: "/sesion/puesto", h: elegirPuesto, soloLocal: true },
    { m: "POST", p: "/sesion/salir-puesto", h: salirPuesto, soloLocal: true },
    { m: "POST", p: "/sesion/clave", h: cambiarClave, soloLocal: true },
  ],
};
