"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const U = require("../lib/util");
const api = require("../lib/api");

async function escenario(t) {
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, rol: "ADMIN", nombre: "Admin", bocas: [] }, sesion: {} };
  await db.tx(async tx => {
    await sembrarPredio(tx, ctx, "MIRAMAR");
    await N.insertar(tx, ctx, "predio_usuario", { usuario: "admin", nombre: "Admin", rol: "ADMIN", activo: 1 });
  });
  const cajas = await db.all("SELECT * FROM predio_caja ORDER BY id LIMIT 2");
  const llamar = (c, m, ruta, body = {}) => api.ejecutar({ ...c, body }, m, ruta);
  return { db, ctx, cajas, llamar };
}

test("la comanda se conserva por caja y sólo su operador o un administrador pueden cambiarla", async t => {
  const { db, ctx, cajas, llamar } = await escenario(t);
  const [a, b] = cajas;
  const cajero = { ...ctx, usuario: { id: 2, rol: "CAJERO", nombre: "Caja", bocas: [a.boca_id] }, sesion: { boca_id: a.boca_id, caja_id: a.id } };
  await llamar(cajero, "POST", `/cajas/${a.id}/comanda`, { imprimir_comanda: true });
  assert.equal((await db.get("SELECT imprimir_comanda FROM predio_caja WHERE id=?", [a.id])).imprimir_comanda, 1);
  assert.equal(Number((await db.get("SELECT imprimir_comanda FROM predio_caja WHERE id=?", [b.id])).imprimir_comanda || 0), 0);
  await assert.rejects(llamar(cajero, "POST", `/cajas/${b.id}/comanda`, { imprimir_comanda: true }), { status: 403 });
  await assert.rejects(llamar(cajero, "POST", `/cajas/${a.id}/comanda`, { imprimir_comanda: "false" }), { status: 400 });
  const respuesta = await llamar(ctx, "POST", `/cajas/${a.id}/comanda`, { imprimir_comanda: false });
  assert.equal(respuesta.imprimir_comanda, false);
});

test("salir o cambiar de puesto exige cerrar la caja, incluso al administrador", async t => {
  const { db, ctx, cajas: [caja, otra], llamar } = await escenario(t);
  await db.run("INSERT INTO predio_sesion(token_hash,usuario_id,creada) VALUES ('sesion',1,'2026-11-05')");
  const admin = { ...ctx, sesion: { token_hash: "sesion" } };
  const ingreso = await llamar(admin, "POST", "/sesion/puesto", { boca_id: caja.boca_id, caja_id: caja.id });
  Object.assign(admin.sesion, ingreso.puesto);
  for (const ruta of ["/sesion/salir-puesto", "/logout", "/sesion/puesto"]) {
    await assert.rejects(llamar(admin, "POST", ruta, { boca_id: otra.boca_id, caja_id: otra.id }), { codigo: "TURNO_ABIERTO" });
  }
  // Ya no hay clave del día: el administrador cierra con su propia cuenta.
  assert.equal((await llamar(admin, "GET", "/config")).clave_del_dia, undefined);
  const cierre = { caja_id: caja.id, efectivo_contado: 0, turno_id: ingreso.puesto.turno_id, ultimo_cierre_id: null };
  await llamar(admin, "POST", "/caja/cierre", cierre);
  assert.equal((await db.get("SELECT estado FROM predio_turno WHERE id=?", [ingreso.puesto.turno_id])).estado, "CERRADO");
  assert.equal((await db.get("SELECT turno_id FROM predio_sesion WHERE token_hash='sesion'")).turno_id, null);
  await assert.rejects(llamar(admin, "POST", "/caja/cierre", cierre), { status: 409 });
  await llamar(admin, "POST", "/logout");
  assert.equal((await db.get("SELECT COUNT(*) n FROM predio_sesion")).n, 0);
});

test("administrar otra caja conserva el turno del puesto y separa los movimientos de cada caja", async t => {
  const { db, ctx, cajas: [propia, otra], llamar } = await escenario(t);
  const turno = await N.insertar(db, ctx, "predio_turno", {
    usuario_id: 1, caja_id: propia.id, boca_id: propia.boca_id, inicio: U.hoy() + " 09:00:00", estado: "ABIERTO",
  });
  const admin = { ...ctx, sesion: { caja_id: propia.id, boca_id: propia.boca_id, turno_id: turno } };
  await llamar(admin, "POST", "/caja/apertura", { caja_id: propia.id, importe: 100 });
  await llamar(admin, "POST", "/caja/apertura", { caja_id: otra.id, importe: 200 });
  const detalle = await llamar({ ...admin, query: { caja_id: otra.id } }, "GET", "/caja/estado");
  assert.equal(detalle.caja.id, otra.id);
  assert.equal(detalle.apertura.importe, 200);
  assert.equal(detalle.turno, null);

  const venta = await N.insertar(db, ctx, "predio_venta", {
    boca_id: otra.boca_id, caja_id: otra.id, fecha: "2026-11-05 10:00:00", forma_pago: "EFECTIVO", estado: "CONFIRMADA", total: 10,
  });
  await llamar(admin, "POST", `/ventas/${venta}/anular`, { motivo: "Error de carga" });
  await llamar(admin, "POST", "/caja/cierre", { caja_id: otra.id, efectivo_contado: 185, queda_en_caja: 40 });
  const movimientos = await db.all("SELECT caja_id, turno_id FROM predio_caja_movimiento WHERE caja_id = ?", [otra.id]);
  assert.equal(movimientos.length, 4);
  assert.ok(movimientos.every(m => m.turno_id === null));
  const listado = await llamar({ ...admin, query: { f_caja: otra.id } }, "GET", "/listados/caja");
  assert.equal(listado.total, 4);
  const cierres = await llamar({ ...admin, query: { f_caja: otra.id } }, "GET", "/listados/cierres");
  assert.equal(cierres.filas[0].saldo, 40, "el saldo es el efectivo que quedó, después del retiro");
  assert.equal(cierres.filas[0].efectivo_contado, 185);
  assert.equal(cierres.filas[0].retiro, 145);
  const metaCierres = await llamar(admin, "GET", "/listados/cierres/meta");
  assert.equal(metaCierres.columnas[0].titulo, "ID");
  assert.equal(metaCierres.columnas.find(c => c.clave === "saldo").titulo, "Saldo");
  assert.equal((await llamar(admin, "GET", "/caja/estado")).resumen.saldo_esperado, 100);
  assert.deepEqual(await db.all("SELECT id, estado FROM predio_turno"), [{ id: turno, estado: "ABIERTO" }]);
});

test("dos usuarios compiten por una caja, el titular retoma su turno y el relevo puede empezar a las 2", async t => {
  const { db, ctx, cajas: [caja], llamar } = await escenario(t);
  const acceso = require("../lib/api/sesion").autenticar;
  const clave = "Turno-nuevo24";
  const puesto = { boca_id: caja.boca_id, caja_id: caja.id };
  const usuarios = ["ana", "juan"];
  await db.tx(async tx => {
    for (const usuario of usuarios) {
      const id = await N.insertar(tx, ctx, "predio_usuario", { usuario, nombre: usuario, rol: "CAJERO", activo: 1, password_hash: U.hashPassword(clave) });
      await N.insertar(tx, ctx, "predio_usuario_boca", { usuario_id: id, boca_id: caja.boca_id });
    }
  });
  const login = usuario => llamar(ctx, "POST", "/login", { usuario, password: clave });
  const autenticar = async token => ({ ...ctx, ...await acceso(ctx, token) });
  const sesiones = await Promise.all(usuarios.map(login));
  const actores = await Promise.all(sesiones.map(s => autenticar(s.token)));
  const resultados = await Promise.allSettled(actores.map(a => llamar(a, "POST", "/sesion/puesto", puesto)));
  assert.equal(resultados.filter(r => r.status === "fulfilled").length, 1);
  const i = resultados.findIndex(r => r.status === "fulfilled"), otro = 1 - i;
  assert.equal(resultados[otro].reason.codigo, "CAJA_OCUPADA");
  const primero = await autenticar(sesiones[i].token);
  const turno = primero.sesion.turno_id;
  // La apertura, la primera venta y la segunda pertenecen al mismo turno aunque
  // los comprobantes tengan fechas civiles distintas.
  const inicio = "2026-11-05 23:00:00", madrugada = "2026-11-06 02:00:00";
  await db.run("UPDATE predio_turno SET inicio=? WHERE id=?", [inicio, turno]);
  await llamar(ctx, "POST", "/caja/apertura", { caja_id: caja.id, importe: 15, fecha: inicio.slice(0, 10) });
  await assert.rejects(llamar(ctx, "POST", "/caja/apertura", { caja_id: caja.id, importe: 0, fecha: madrugada.slice(0, 10) }), { status: 409 });
  await db.tx(async tx => {
    for (const fecha of ["2026-11-05 23:59:59", "2026-11-06 01:59:59"]) {
      await N.insertar(tx, ctx, "predio_venta", { ...puesto, turno_id: turno, usuario_id: primero.usuario.id, total: 25, forma_pago: "QR", estado: "CONFIRMADA", fecha });
    }
  });
  const panel = await llamar(ctx, "GET", "/caja/panel");
  assert.equal(panel.cajas.find(c => c.id === caja.id).turno.usuario_nombre, usuarios[i]);
  // El navegador original pierde su token. El dueño puede retomar la misma caja.
  const reingreso = await login(usuarios[i]);
  assert.equal(reingreso.puesto.turno_id, turno);
  assert.equal((await autenticar(sesiones[i].token)).sesion.turno_id, null);
  await assert.rejects(llamar(primero, "POST", "/caja/cierre/temporal", { efectivo_ventas: 15, efectivo_cambio: 0 }), { codigo: "SIN_PUESTO" });
  const responsable = await autenticar(reingreso.token);
  const estado = await llamar(responsable, "GET", "/caja/estado");
  assert.equal(estado.apertura.fecha, "2026-11-05");
  assert.equal(estado.resumen.ventas_cantidad, 2);
  assert.equal(estado.resumen.ventas_total, 50);
  assert.equal((await llamar(responsable, "GET", "/config")).clave_del_dia, undefined);
  // El cierre definitivo es del administrador, aunque el usuario tenga el permiso anterior.
  await db.run("UPDATE predio_usuario SET puede_cerrar_caja=1 WHERE id=?", [responsable.usuario.id]);
  const delegado = await autenticar(reingreso.token);
  await assert.rejects(llamar(delegado, "POST", "/caja/cierre", { efectivo_contado: 15 }), { codigo: "CIERRE_SOLO_ADMIN" });
  // Con el administrador en la PC: escribe su usuario y su contraseña.
  await db.run("UPDATE predio_usuario SET password_hash=? WHERE usuario='admin'", [U.hashPassword("Admin-presente1")]);
  await assert.rejects(llamar(delegado, "POST", "/caja/cierre", { efectivo_contado: 15, admin_usuario: "admin", admin_password: "otra" }), { codigo: "ADMIN_INCORRECTO" });
  await assert.rejects(llamar(delegado, "POST", "/caja/cierre", { efectivo_contado: 15, admin_usuario: usuarios[otro], admin_password: clave }), { codigo: "ADMIN_INCORRECTO" });
  const original = U.fechaHora;
  t.mock.method(U, "fechaHora", fecha => fecha ? original(fecha) : madrugada);
  const cierre = await llamar(delegado, "POST", "/caja/cierre", { efectivo_contado: 15, queda_en_caja: 15, admin_usuario: " ADMIN ", admin_password: "Admin-presente1" });
  assert.equal(cierre.diferencia, 0);
  const asentado = await db.get("SELECT tipo, estado, usuario_nombre, definitivo_usuario_nombre, autorizacion FROM predio_cierre WHERE id=?", [cierre.id]);
  assert.deepEqual({ ...asentado }, { tipo: "DEFINITIVO", estado: "CERRADO", usuario_nombre: usuarios[i], definitivo_usuario_nombre: "Admin", autorizacion: "ADMIN_PRESENTE" });
  assert.equal((await db.get("SELECT fin FROM predio_turno WHERE id=?", [turno])).fin, madrugada);
  const siguiente = await llamar(actores[otro], "POST", "/sesion/puesto", puesto);
  assert.notEqual(siguiente.puesto.turno_id, turno);
  await llamar(await autenticar(reingreso.token), "POST", "/logout");
});
