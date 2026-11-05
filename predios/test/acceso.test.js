"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const api = require("../lib/api");
const N = require("../lib/negocio");
const U = require("../lib/util");
const acceso = require("../lib/acceso");
const { listarAvisos, emitirAviso, leerAviso } = require("../lib/avisos");

async function preparar(t, archivo = ":memory:") {
  const db = crearSqlite(archivo, { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", ip: "192.168.1.20", agenteHttp: "Navegador de prueba", query: {}, body: {} };
  const datos = await db.tx(async (tr) => {
    const admin = await N.insertar(tr, ctx, "predio_usuario", { usuario: "admin", nombre: "Administración", rol: "ADMIN", password_hash: U.hashPassword("clave-admin"), activo: 1, es_admin_general: 0 });
    const usuario = await N.insertar(tr, ctx, "predio_usuario", { usuario: "cajera", nombre: "Cajera", rol: "CAJERO", password_hash: U.hashPassword("clave-caja"), activo: 1, es_admin_general: 0 });
    const boca = await N.insertar(tr, ctx, "predio_boca", { nombre: "Proveeduría", activo: 1 });
    const caja = await N.insertar(tr, ctx, "predio_caja", { boca_id: boca, nombre: "Caja 2", activo: 1 });
    await N.insertar(tr, ctx, "predio_usuario_boca", { usuario_id: usuario, boca_id: boca });
    return { admin, usuario, boca, caja };
  });
  return { db, ctx, ...datos };
}

async function ingresar(ctx, usuario = "cajera", password = "incorrecta", extra = {}) {
  try {
    return { status: 200, resultado: await api.ejecutar({ ...ctx, body: { usuario, password, ...extra } }, "POST", "/login") };
  } catch (e) {
    if (!e.status) throw e;
    return { status: e.status, error: e };
  }
}

test("avisa desde el quinto fallo al dueño de cualquier rol, con último puesto e información sin contraseñas", async (t) => {
  const { ctx, db, usuario, admin, boca, caja } = await preparar(t);
  const dispositivo = "equipo-prueba-12345678";
  await acceso.registrarPuesto({ ...ctx, body: { dispositivo_id: dispositivo } }, boca, caja);
  const extra = { dispositivo_id: dispositivo, ultimo_puesto: { boca_id: 9999, caja_id: 9999 } };
  for (let i = 1; i <= 4; i++) assert.equal((await ingresar(ctx, "cajera", "incorrecta", extra)).status, 401);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_aviso")).n, 0);
  assert.equal((await ingresar(ctx, "cajera", "incorrecta", extra)).status, 401);
  const propio = { ...ctx, usuario: { id: usuario, rol: "CAJERO" } };
  const notificaciones = await listarAvisos(propio);
  assert.equal(notificaciones.length, 1);
  assert.equal(notificaciones[0].detalle.intentos, 5);
  assert.equal(notificaciones[0].detalle.boca, "Proveeduría");
  assert.equal(notificaciones[0].detalle.caja, "Caja 2");
  assert.equal(notificaciones[0].detalle.ip, ctx.ip);
  assert.equal(notificaciones[0].detalle.agente, ctx.agenteHttp);
  assert.equal(notificaciones[0].detalle.intentos_recientes.length, 5);
  assert.ok(notificaciones[0].detalle.intentos_recientes.every((i) => i.boca_id === boca && i.caja_id === caja));
  assert.match(notificaciones[0].detalle.fecha, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(!JSON.stringify(notificaciones).includes("incorrecta"));
  assert.equal((await listarAvisos({ ...ctx, usuario: { id: admin, rol: "ADMIN" } })).length, 0);
  await assert.rejects(leerAviso({ ...ctx, usuario: { id: admin, rol: "ADMIN" }, params: { id: notificaciones[0].id } }), (e) => e.status === 404);
  await leerAviso({ ...propio, params: { id: notificaciones[0].id } });
  assert.equal((await listarAvisos(propio)).length, 0);
  // Otro rol recibe el mismo aviso, incluso cuando intenta acceder desde otra IP.
  for (let i = 0; i < 5; i++) await ingresar({ ...ctx, ip: "192.168.1.30" }, "admin");
  const admins = await listarAvisos({ ...ctx, usuario: { id: admin, rol: "ADMIN" } });
  assert.equal(admins.length, 1);
  assert.equal(admins[0].detalle.intentos, 5);
});

test("bloquea 15 minutos completos desde el décimo fallo y el bloqueo persiste al reabrir la base", async (t) => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "predio-acceso-"));
  const archivo = path.join(carpeta, "acceso.db");
  const { ctx, db } = await preparar(t, archivo);
  const inicio = Date.now();
  let reloj = inicio;
  t.mock.method(Date, "now", () => reloj);
  for (let i = 0; i < 9; i++) assert.equal((await ingresar(ctx)).status, 401);
  reloj = inicio + 14 * 60000;
  const decimo = await ingresar(ctx);
  assert.equal(decimo.status, 429);
  assert.equal(decimo.error.reintentar_en, 900);
  db.cerrar();
  const reabierta = crearSqlite(archivo, { predioId: 1 });
  asegurarEsquema(reabierta);
  t.after(() => reabierta.cerrar());
  const nuevoCtx = { ...ctx, db: reabierta };
  reloj = inicio + 15 * 60000;
  assert.equal((await ingresar(nuevoCtx, "cajera", "clave-caja")).status, 429);
  // Cambiar de PC/IP tampoco permite saltarse el bloqueo de la cuenta.
  const otraIp = { ...nuevoCtx, ip: "192.168.1.99" };
  assert.equal((await ingresar(otraIp, "cajera", "clave-caja")).status, 429);
  reloj = inicio + 29 * 60000 - 1;
  assert.equal((await ingresar(otraIp, "cajera", "clave-caja")).status, 429);
  reloj++;
  assert.equal((await ingresar(otraIp, "cajera", "clave-caja")).status, 200);
  t.after(() => { reabierta.cerrar(); fs.rmSync(carpeta, { recursive: true, force: true }); });
});

test("suma intentos de distintas IP y serializa intentos simultáneos sin exceder el límite", async (t) => {
  const { ctx, db } = await preparar(t);
  const resultados = await Promise.all(Array.from({ length: 15 }, (_, i) => ingresar({ ...ctx, ip: `10.0.0.${i + 1}` })));
  assert.equal(resultados.filter((r) => r.status === 401).length, 9);
  assert.equal(resultados.filter((r) => r.status === 429).length, 6);
  const cuenta = await db.get("SELECT fallos FROM predio_acceso_control WHERE clave LIKE 'cuenta:%'");
  assert.equal(cuenta.fallos, 10);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_aviso")).n, 6);
  const ultimo = await db.get("SELECT detalle FROM predio_aviso ORDER BY id DESC LIMIT 1");
  assert.equal(new Set(JSON.parse(ultimo.detalle).intentos_recientes.map((i) => i.ip)).size, 10);
});

test("un ingreso correcto a otra cuenta no reinicia el límite de intentos de la PC", async (t) => {
  const { ctx } = await preparar(t);
  for (let i = 0; i < 9; i++) assert.equal((await ingresar(ctx, "no-existe")).status, 401);
  assert.equal((await ingresar(ctx, "admin", "clave-admin")).status, 200);
  assert.equal((await ingresar(ctx, "no-existe")).status, 429);
  assert.equal((await ingresar(ctx, "admin", "clave-admin")).status, 429);
});

test("aviso general por DNI se dirige a Mi AJB y no se expone a administradores locales", async (t) => {
  const { ctx, db, admin } = await preparar(t);
  for (let i = 0; i < 5; i++) await ingresar(ctx, "30.111.222");
  const aviso = await db.get("SELECT * FROM predio_aviso");
  assert.equal(aviso.general_documento, "30111222");
  assert.equal(aviso.usuario_id, null);
  assert.equal((await listarAvisos({ ...ctx, usuario: { id: admin, rol: "ADMIN" } })).length, 0);
  const general = await db.tx((tr) => N.insertar(tr, ctx, "predio_usuario", { usuario: "dni30111222", nombre: "Admin general", rol: "ADMIN", es_admin_general: 1, general_usuario_id: 71, documento: "30111222", activo: 1 }));
  const sesionGeneral = { ...ctx, usuario: { id: general, rol: "ADMIN" } };
  assert.equal((await listarAvisos(sesionGeneral)).length, 1);
  await leerAviso({ ...sesionGeneral, params: { id: aviso.id } });
  assert.equal((await listarAvisos(sesionGeneral)).length, 0);
});

test("broadcast de stock es sólo para administradores y cada uno conserva su propia lectura", async (t) => {
  const { ctx, db, admin, usuario } = await preparar(t);
  const id = await db.tx((tr) => emitirAviso(tr, ctx, { tipo: "VENTA_SIN_STOCK", titulo: "Falta stock", mensaje: "Proveeduría · Caja 2" }));
  const a = { ...ctx, usuario: { id: admin, rol: "ADMIN" } };
  const b = { ...ctx, usuario: { id: 999, rol: "ADMIN" } };
  assert.equal((await listarAvisos(a)).length, 1);
  assert.equal((await listarAvisos({ ...ctx, usuario: { id: usuario, rol: "CAJERO" } })).length, 0);
  await leerAviso({ ...a, params: { id } });
  await leerAviso({ ...a, params: { id } });
  assert.equal((await listarAvisos(a)).length, 0);
  assert.equal((await listarAvisos(b)).length, 1);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_aviso_lectura")).n, 1);
});

test("la PC conserva su identificación y último puesto al cerrar sesión y al reabrir el navegador", () => {
  const datos = new Map();
  function almacenamiento(mapa = new Map()) {
    return { getItem: (k) => mapa.get(k) || null, setItem: (k, v) => mapa.set(k, String(v)), removeItem: (k) => mapa.delete(k) };
  }
  function abrir() {
    const entorno = {
      window: { crypto: webcrypto }, localStorage: almacenamiento(datos), sessionStorage: almacenamiento(),
      document: { documentElement: { getAttribute: () => null }, addEventListener: () => {} },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/nucleo.js"), "utf8"), entorno);
    return entorno.window.P;
  }
  const primera = abrir();
  const id = primera.equipo.datos().dispositivo_id;
  primera.equipo.recordarPuesto({ boca_id: 2, caja_id: 4, boca: "Comedor", caja: "Caja 1" });
  primera.sesion.guardar("token-que-debe-borrarse", true);
  primera.sesion.borrar();
  assert.equal(primera.sesion.token(), null);
  const nueva = abrir();
  assert.equal(nueva.equipo.datos().dispositivo_id, id);
  assert.equal(nueva.equipo.datos().ultimo_puesto.boca_id, 2);
  assert.equal(nueva.equipo.datos().ultimo_puesto.caja_id, 4);
  assert.ok(!JSON.stringify([...datos.values()]).includes("token-que-debe-borrarse"));
});
