"use strict";

// Cierre temporal: el cajero se va sin un administrador, deja el efectivo en dos bolsas
// (recaudación y cambio) y la caja queda libre; el que sigue arranca de cero. Después
// un administrador recibe las bolsas y hace el cierre definitivo sin tocar la caja.

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const U = require("../lib/util");
const api = require("../lib/api");
const { separarEfectivo } = require("../lib/api/caja");

const CLAVE_ADMIN = "Admin-del-camping1";

async function escenario(t) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  t.after(() => db.cerrar());
  asegurarEsquema(db);
  const admin = { db, pid: 1, modo: "local", origen: "LOCAL", ip: "10.0.0.1", usuario: { id: 1, rol: "ADMIN", nombre: "Admin" }, sesion: {} };
  await db.tx(async (tx) => {
    await sembrarPredio(tx, admin, "MIRAMAR");
    await N.insertar(tx, admin, "predio_usuario", { usuario: "admin", nombre: "Admin", rol: "ADMIN", activo: 1, password_hash: U.hashPassword(CLAVE_ADMIN) });
    await N.insertar(tx, admin, "predio_usuario", { usuario: "ana", nombre: "Ana", rol: "CAJERO", activo: 1, password_hash: U.hashPassword("Ana-cajera1") });
    await N.insertar(tx, admin, "predio_usuario", { usuario: "beto", nombre: "Beto", rol: "CAJERO", activo: 1, password_hash: U.hashPassword("Beto-cajero1") });
  });
  const [caja] = await db.all("SELECT * FROM predio_caja ORDER BY id LIMIT 1");
  const post = (actor, ruta, body = {}) => api.ejecutar({ ...actor, body, query: {} }, "POST", ruta);
  const get = (actor, ruta, query = {}) => api.ejecutar({ ...actor, body: {}, query }, "GET", ruta);
  async function turnoDe(id, nombre) {
    const turno = await N.insertar(db, admin, "predio_turno", { caja_id: caja.id, boca_id: caja.boca_id, usuario_id: id, usuario_nombre: nombre, inicio: U.fechaHora(), estado: "ABIERTO" });
    return { ...admin, ip: "10.0.0.2", usuario: { id, rol: "CAJERO", nombre, bocas: [caja.boca_id] }, sesion: { boca_id: caja.boca_id, caja_id: caja.id, turno_id: turno } };
  }
  const producto = await post(admin, "/productos", { nombre: "Gaseosa", destino: "VENTA_DIRECTA", precio_venta_manual: 100 });
  await db.tx((tx) => N.moverStock(tx, admin, { productoId: producto.id, bocaId: caja.boca_id, cantidad: 50, tipo: "AJUSTE" }));
  const vender = (actor, cantidad, forma) => post(actor, "/ventas", { items: [{ producto_id: producto.id, cantidad }], forma_pago: forma });
  return { db, admin, caja, post, get, turnoDe, vender };
}

test("el cajero cierra en forma temporal, el siguiente arranca de cero y el administrador recibe las bolsas después", async (t) => {
  const { db, admin, caja, post, get, turnoDe, vender } = await escenario(t);
  assert.equal((await get(admin, "/config")).clave_del_dia, undefined, "ya no existe la clave del día");

  // Jornada de Ana: apertura de $1.000, $200 de cambio agregado, ventas y un retiro.
  await post(admin, "/caja/apertura", { caja_id: caja.id, importe: 1000 });
  const ana = await turnoDe(2, "Ana");
  const apertura = (await get(ana, "/caja/estado")).apertura;
  await post(ana, `/caja/apertura/${apertura.id}/verificar`, { correcto: true });
  await post(admin, "/caja/ajuste", { caja_id: caja.id, concepto: "INGRESO_DINERO", tipo: "INGRESO", importe: 200 });
  const ventaAna = await vender(ana, 3, "EFECTIVO");
  await vender(ana, 1, "QR");
  await post(admin, "/caja/ajuste", { caja_id: caja.id, concepto: "RETIRO_DINERO", tipo: "EGRESO", importe: 50 });

  const previa = await get(ana, "/caja/cierre/previa");
  assert.equal(previa.puede_temporal, true);
  assert.equal(previa.resumen.saldo_esperado, 1450);
  assert.deepEqual(previa.resumen.efectivo, {
    saldo_inicial: 1000, agregados: 200, cambio: 1200, ventas: 300, anulaciones: 0, otros_cobros: 0, cobros: 300, retiros: 50,
    esperado_ventas: 250, esperado_cambio: 1200,
  });

  // Sin un administrador no hay cierre definitivo; tampoco sirve otro cajero.
  await assert.rejects(post(ana, "/caja/cierre", { efectivo_contado: 1450 }), { codigo: "CIERRE_SOLO_ADMIN" });
  await assert.rejects(post(ana, "/caja/cierre", { efectivo_contado: 1450, admin_usuario: "beto", admin_password: "Beto-cajero1" }), { codigo: "ADMIN_INCORRECTO" });

  const cierre = await post(ana, "/caja/cierre/temporal", {
    efectivo_ventas: 240, efectivo_cambio: 1200, observaciones: "Faltan $10", revision: previa.revision,
    turno_id: previa.turno.id, ultimo_cierre_id: null,
  });
  assert.equal(cierre.tipo, "TEMPORAL");
  assert.equal(cierre.diferencia, -10);
  const fila = await db.get("SELECT * FROM predio_cierre WHERE id = ?", [cierre.id]);
  assert.equal(fila.tipo, "TEMPORAL");
  assert.equal(fila.estado, "PENDIENTE");
  assert.equal(fila.usuario_nombre, "Ana");
  assert.equal(fila.turno_inicio !== null, true);
  assert.equal(Number(fila.esperado_ventas), 250);
  assert.equal(Number(fila.esperado_cambio), 1200);
  assert.equal(Number(fila.efectivo_ventas), 240);
  assert.equal(Number(fila.efectivo_cambio), 1200);
  assert.equal(Number(fila.efectivo_contado), 1440);
  assert.equal(Number(fila.queda_en_caja), 0);
  assert.equal(Number(fila.retiro), 1440);
  assert.equal((await db.get("SELECT estado FROM predio_turno WHERE id = ?", [ana.sesion.turno_id])).estado, "CERRADO");
  const custodia = await db.get("SELECT tipo, importe FROM predio_caja_movimiento WHERE concepto = 'CIERRE_TEMPORAL'");
  assert.deepEqual({ ...custodia }, { tipo: "EGRESO", importe: 1440 });
  assert.equal((await get(admin, "/caja/estado", { caja_id: caja.id })).resumen.saldo_esperado, 0, "la caja queda en cero");

  // El administrador se entera y lo encuentra fácil.
  const avisosAdmin = await get(admin, "/avisos");
  assert.equal(avisosAdmin.cierres_temporales, 1);
  assert.ok(avisosAdmin.notificaciones.some((n) => n.tipo === "CIERRE_TEMPORAL"));
  const panel = await get(admin, "/caja/panel");
  assert.deepEqual(panel.temporales.map((c) => c.id), [cierre.id]);
  assert.equal(panel.cajas.find((c) => c.id === caja.id).temporales_pendientes, 1);
  const detalle = await get(ana, `/caja/cierres/${cierre.id}`);
  assert.equal(detalle.cierre.tipo, "TEMPORAL");
  assert.equal(detalle.efectivo.esperado_ventas, 250);

  // Lo vendido antes del cierre temporal ya no se anula.
  await assert.rejects(post(admin, `/ventas/${ventaAna.id}/anular`, { motivo: "Error" }), /caja se cerró/);

  // Beto toma la misma caja: no hereda la apertura ni los números de Ana.
  const beto = await turnoDe(3, "Beto");
  const estadoBeto = await get(beto, "/caja/estado");
  assert.equal(estadoBeto.apertura, null);
  assert.equal(estadoBeto.resumen.saldo_esperado, 0);
  assert.equal(estadoBeto.resumen.ventas_cantidad, 0);
  assert.equal(estadoBeto.resumen.efectivo.saldo_inicial, 0);
  assert.equal((await get(beto, "/avisos")).apertura, null);
  await vender(beto, 1, "EFECTIVO");

  // Un usuario de boca no hace el cierre definitivo del temporal.
  await assert.rejects(post(beto, `/caja/cierres/${cierre.id}/definitivo`, { recibido_ventas: 240, recibido_cambio: 1200 }), { status: 403 });

  // El administrador llega, cuenta las bolsas y cierra; la caja de Beto sigue igual.
  const definitivo = await post(admin, `/caja/cierres/${cierre.id}/definitivo`, { recibido_ventas: 240, recibido_cambio: 1190, observaciones: "Faltaban $10 de cambio" });
  assert.equal(definitivo.diferencia_recepcion, -10);
  const cerrado = await db.get("SELECT * FROM predio_cierre WHERE id = ?", [cierre.id]);
  assert.equal(cerrado.estado, "CERRADO");
  assert.equal(cerrado.definitivo_usuario_nombre, "Admin");
  assert.equal(Number(cerrado.recibido_cambio), 1190);
  await assert.rejects(post(admin, `/caja/cierres/${cierre.id}/definitivo`, { recibido_ventas: 240, recibido_cambio: 1190 }), { codigo: "CIERRE_YA_DEFINITIVO" });
  const estadoDespues = await get(beto, "/caja/estado");
  assert.equal(estadoDespues.resumen.saldo_esperado, 100);
  assert.equal(estadoDespues.resumen.ventas_cantidad, 1);
  assert.equal((await db.get("SELECT estado FROM predio_turno WHERE id = ?", [beto.sesion.turno_id])).estado, "ABIERTO");
  assert.equal((await get(admin, "/avisos")).cierres_temporales, 0);

  const pendientes = await get(admin, "/listados/cierres", { f_tipo: "PENDIENTE" });
  assert.equal(pendientes.total, 0);
  const todos = await get(admin, "/listados/cierres");
  assert.equal(todos.filas.find((f) => f.id === cierre.id).tipo, "TEMPORAL_CERRADO");
});

test("el administrador presente aprueba en la PC del cajero y los intentos fallidos se bloquean", async (t) => {
  const { admin, post, get, turnoDe } = await escenario(t);
  const beto = { ...(await turnoDe(3, "Beto")), ip: "10.0.0.77" };
  await assert.rejects(post(beto, "/ventas/ver-caja", {}), { codigo: "SIN_AUTORIZACION" });
  const aprobado = await post(beto, "/permisos/presencial", { tipo: "VER_VENTAS_CAJA", admin_usuario: "admin", admin_password: CLAVE_ADMIN });
  const permiso = await get(beto, `/permisos/${aprobado.permiso_id}`);
  assert.equal(permiso.permiso.estado, "APROBADO");
  assert.equal(permiso.permiso.metodo, "PRESENCIAL");
  assert.equal(permiso.permiso.resuelto_por, "Admin");
  assert.equal((await post(beto, "/ventas/ver-caja", { permiso_id: aprobado.permiso_id })).ok, true);
  await assert.rejects(post(admin, "/permisos/presencial", { tipo: "VER_VENTAS_CAJA", admin_usuario: "admin", admin_password: CLAVE_ADMIN }), { status: 400 });

  for (let i = 0; i < 5; i++) {
    await assert.rejects(post(beto, "/permisos/presencial", { tipo: "SOLICITUD_PRODUCTO", admin_usuario: "admin", admin_password: "probando" + i }), { codigo: "ADMIN_INCORRECTO" });
  }
  // Bloqueado aunque ahora la contraseña sea la correcta.
  await assert.rejects(post(beto, "/permisos/presencial", { tipo: "SOLICITUD_PRODUCTO", admin_usuario: "admin", admin_password: CLAVE_ADMIN }), { codigo: "ADMIN_BLOQUEADO" });
});

test("los retiros salen primero de la recaudación y el resto del cambio", () => {
  const conceptos = [
    { concepto: "SALDO_APERTURA", tipo: "INGRESO", total: 500 },
    { concepto: "VENTA", tipo: "INGRESO", total: 100 },
    { concepto: "ANULACION_VENTA", tipo: "EGRESO", total: 20 },
    { concepto: "SALDO_ESTADIA", tipo: "INGRESO", total: 30 },
    { concepto: "RETIRO_DINERO", tipo: "EGRESO", total: 160 },
  ];
  const ef = separarEfectivo(0, 450, conceptos);
  assert.equal(ef.cambio, 500);
  assert.equal(ef.cobros, 110);
  assert.equal(ef.otros_cobros, 30);
  assert.equal(ef.esperado_ventas, 0);
  assert.equal(ef.esperado_cambio, 450);
});
