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
    await N.insertar(tx, admin, "predio_usuario", { usuario: "supervisor", nombre: "Supervisión", rol: "SUPERVISOR", activo: 1 });
  });
  const [caja] = await db.all("SELECT * FROM predio_caja ORDER BY id LIMIT 1");
  const post = (actor, ruta, body = {}) => api.ejecutar({ ...actor, body, query: {} }, "POST", ruta);
  const get = (actor, ruta, query = {}) => api.ejecutar({ ...actor, body: {}, query }, "GET", ruta);
  async function turnoDe(id, nombre, rol = "CAJERO") {
    const turno = await N.insertar(db, admin, "predio_turno", { caja_id: caja.id, boca_id: caja.boca_id, usuario_id: id, usuario_nombre: nombre, inicio: U.fechaHora(), estado: "ABIERTO" });
    return { ...admin, ip: "10.0.0.2", usuario: { id, rol, nombre, bocas: [caja.boca_id] }, sesion: { boca_id: caja.boca_id, caja_id: caja.id, turno_id: turno } };
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

  // Desde el turno del cajero solo se puede cerrar en forma temporal.
  await assert.rejects(post(ana, "/caja/cierre", { efectivo_contado: 1450 }), { codigo: "CIERRE_SOLO_ADMIN" });
  await assert.rejects(post(ana, "/caja/cierre", { efectivo_contado: 1450, admin_usuario: "admin", admin_password: CLAVE_ADMIN }), { codigo: "CIERRE_SOLO_ADMIN" });

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

test("un supervisor opera y cierra su caja sin reingresar la contraseña, dentro de sus bocas", async (t) => {
  const { db, caja, post, get, turnoDe, vender } = await escenario(t);
  const otra = await db.get("SELECT * FROM predio_caja WHERE boca_id<>? ORDER BY id LIMIT 1", [caja.boca_id]);
  const supervisor = await turnoDe(4, "Supervisión", "SUPERVISOR");
  const panel = await get(supervisor, "/caja/panel");
  assert.ok(panel.cajas.some(c => c.id === caja.id));
  assert.ok(panel.cajas.every(c => c.boca_id === caja.boca_id));
  await assert.rejects(get(supervisor, "/caja/estado", { caja_id: otra.id }), { status: 403 });
  await assert.rejects(post(supervisor, "/caja/apertura", { caja_id: otra.id, importe: 150 }), { status: 403 });
  await assert.rejects(post(supervisor, "/caja/cierre", { caja_id: otra.id, efectivo_contado: 0 }), { status: 403 });

  const { id: apertura } = await post(supervisor, "/caja/apertura", { caja_id: caja.id, importe: 150 });
  await post(supervisor, `/caja/apertura/${apertura}/verificar`, { correcto: true });
  await post(supervisor, "/caja/ajuste", { caja_id: caja.id, concepto: "INGRESO_DINERO", tipo: "INGRESO", importe: 20 });
  await vender(supervisor, 2, "EFECTIVO");
  const previa = await get(supervisor, "/caja/cierre/previa");
  const arqueo = { efectivo_contado: 370, queda_en_caja: 100, revision: previa.revision, turno_id: previa.turno.id, ultimo_cierre_id: null };
  const sinBoca = { ...supervisor, usuario: { ...supervisor.usuario, bocas: [] } };
  assert.deepEqual((await get(sinBoca, "/caja/panel")).cajas, []);
  await assert.rejects(post(sinBoca, "/caja/cierre", arqueo), { status: 403 });

  const cierre = await post(supervisor, "/caja/cierre", arqueo);
  assert.equal(cierre.tipo, "DEFINITIVO");
  assert.equal(cierre.diferencia, 0);
  assert.equal(cierre.retiro, 270);
  const { cierre: detalle } = await get(supervisor, `/caja/cierres/${cierre.id}`);
  assert.equal(detalle.estado, "CERRADO");
  assert.equal(detalle.autorizacion, "SUPERVISOR");
  assert.equal(detalle.definitivo_usuario_id, supervisor.usuario.id);
  assert.equal((await db.get("SELECT estado FROM predio_turno WHERE id = ?", [previa.turno.id])).estado, "CERRADO");
  await assert.rejects(post(supervisor, "/caja/cierre", arqueo), { status: 409 });
});

test("un supervisor puede recibir a distancia el cierre temporal de una boca asignada", async (t) => {
  const { admin, caja, post, get, turnoDe, vender } = await escenario(t);
  const cajero = await turnoDe(2, "Ana");
  const { id: venta } = await vender(cajero, 1, "EFECTIVO");
  const supervisor = { ...admin, origen: "REMOTO", usuario: { id: 4, rol: "SUPERVISOR", nombre: "Supervisión", bocas: [caja.boca_id], puede_anular_ticket: 1 } };
  const sinAnulacion = { ...supervisor, usuario: { ...supervisor.usuario, puede_anular_ticket: 0 } };
  const sinBoca = { ...supervisor, usuario: { ...supervisor.usuario, bocas: [] } };
  const anular = `/ventas/${venta}/anular`;
  const motivo = { motivo: "Ticket duplicado" };
  await assert.rejects(post(sinAnulacion, anular, motivo), { status: 403 });
  await assert.rejects(post(sinBoca, anular, motivo), { status: 403 });
  assert.equal((await post(supervisor, anular, motivo)).devolver_efectivo, 100);

  const cierre = await post(cajero, "/caja/cierre/temporal", { efectivo_ventas: 0, efectivo_cambio: 0 });
  const ruta = `/caja/cierres/${cierre.id}/definitivo`;
  const bolsas = { recibido_ventas: 0, recibido_cambio: 0 };
  assert.deepEqual((await get(sinBoca, "/caja/temporales")).cierres, []);
  await assert.rejects(post(sinBoca, ruta, bolsas), { status: 403 });
  assert.deepEqual((await get(supervisor, "/caja/temporales")).cierres.map(c => c.id), [cierre.id]);
  await post(supervisor, ruta, bolsas);
  const { cierre: detalle } = await get(supervisor, `/caja/cierres/${cierre.id}`);
  assert.equal(detalle.estado, "CERRADO");
  assert.equal(detalle.definitivo_usuario_id, supervisor.usuario.id);
  assert.deepEqual((await get(supervisor, "/caja/temporales")).cierres, []);
});

test("el supervisor resuelve sólo las anulaciones de sus bocas cuando tiene permiso", async (t) => {
  const { db, admin, caja, post, get, turnoDe, vender } = await escenario(t);
  const cajero = await turnoDe(2, "Ana");
  const supervisor = { ...admin, usuario: { id: 4, rol: "SUPERVISOR", nombre: "Supervisión", bocas: [caja.boca_id], puede_anular_ticket: 1 } };
  const sinPermiso = { ...supervisor, usuario: { ...supervisor.usuario, puede_anular_ticket: 0 } };
  const otra = await db.get("SELECT * FROM predio_caja WHERE boca_id<>? ORDER BY id LIMIT 1", [caja.boca_id]);
  const ajena = await N.insertar(db, cajero, "predio_venta", {
    caja_id: otra.id, boca_id: otra.boca_id, estado: "CONFIRMADA", forma_pago: "QR", total: 500, fecha: U.fechaHora(),
  });
  const pedidoAjeno = await N.insertar(db, cajero, "predio_permiso", {
    tipo: "ANULAR_VENTA", estado: "PENDIENTE", referencia_id: ajena, boca_id: otra.boca_id, caja_id: otra.id, usuario_id: cajero.usuario.id,
    fecha_solicitud: U.fechaHora(),
  });
  const { id: venta } = await vender(cajero, 1, "EFECTIVO");
  const { id: segunda } = await vender(cajero, 1, "QR");
  const pedir = id => post(cajero, "/permisos", { tipo: "ANULAR_VENTA", referencia_id: id, detalle: "Ticket duplicado" });
  const { id: anular } = await pedir(venta);
  const { id: conservar } = await pedir(segunda);
  const { id: permisoCaja } = await post(cajero, "/permisos", { tipo: "VER_VENTAS_CAJA" });
  const resolver = (actor, id, aprobar) => post(actor, `/permisos/${id}/resolver`, { aprobar });
  const avisos = await get(supervisor, "/avisos");
  assert.deepEqual(avisos.permisos.map(p => p.id), [conservar, anular]);
  assert.deepEqual((await get(sinPermiso, "/avisos")).permisos, []);
  assert.equal((await get(supervisor, `/permisos/${anular}`)).permiso.referencia_id, venta);
  await assert.rejects(get(supervisor, `/permisos/${pedidoAjeno}`), { status: 403 });
  await assert.rejects(resolver(supervisor, pedidoAjeno, false), { status: 403 });
  await assert.rejects(resolver(supervisor, permisoCaja, true), { status: 403 });
  await assert.rejects(resolver(sinPermiso, anular, true), { status: 403 });
  await assert.rejects(post(supervisor, "/caja/cierre", { caja_id: caja.id, efectivo_contado: 100 }), { codigo: "ANULACIONES_PENDIENTES" });
  assert.equal((await resolver(supervisor, anular, true)).devolver_efectivo, 100);
  assert.equal((await resolver(supervisor, conservar, false)).mensaje, "Pedido rechazado");
  assert.deepEqual((await get(supervisor, "/avisos")).permisos, []);
  const inicio = await get(supervisor, "/inicio");
  assert.deepEqual(inicio.ultimas_ventas.map(v => v.id), [segunda]);
  assert.equal(inicio.hoy.total, 100);
  assert.equal(inicio.efectivo_en_cajas, 0);
  assert.equal(inicio.afiliados_en_predio, null);
  assert.equal((await post(supervisor, "/caja/cierre", { caja_id: caja.id, efectivo_contado: 0 })).tipo, "DEFINITIVO");
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

test("después de un temporal, el administrador carga el cambio a distancia sin absorber lo que ya se cobró", async (t) => {
  const { db, admin, caja, post, get, turnoDe, vender } = await escenario(t);
  await post(admin, "/caja/apertura", { caja_id: caja.id, importe: 1000 });
  const ana = await turnoDe(2, "Ana");
  await vender(ana, 2, "EFECTIVO");
  const previa = await get(ana, "/caja/cierre/previa");
  await post(ana, "/caja/cierre/temporal", { efectivo_ventas: 200, efectivo_cambio: 1000, revision: previa.revision, turno_id: previa.turno.id, ultimo_cierre_id: null });

  // Beto arranca en cero y vende antes de que llegue el cambio.
  const beto = await turnoDe(3, "Beto");
  assert.equal((await get(beto, "/caja/estado")).apertura, null);
  await vender(beto, 1, "EFECTIVO");
  const carga = await post({ ...admin, origen: "REMOTO" }, "/caja/apertura", { caja_id: caja.id, importe: 500 });
  assert.match(carga.mensaje, /Beto lo confirma/);
  const estado = await get(beto, "/caja/estado");
  assert.equal(estado.apertura.importe, 500);
  assert.equal(estado.apertura.verificacion, "PENDIENTE");
  assert.equal(estado.resumen.saldo_esperado, 600, "los $100 de la venta siguen en la caja");
  assert.equal(estado.resumen.efectivo.saldo_inicial, 500);
  assert.equal(estado.resumen.efectivo.ventas, 100);
  assert.equal((await get(beto, "/avisos")).apertura.verificacion, "PENDIENTE");
  const auditoria = await db.all("SELECT accion FROM predio_auditoria WHERE accion LIKE '%saldo de apertura%' OR accion = 'Saldo de apertura' ORDER BY id");
  assert.deepEqual(auditoria.map((a) => a.accion), ["Saldo de apertura", "Saldo de apertura"], "la del relevo es una apertura nueva, no una corrección");
  // Si la corrige mientras sigue el turno, sí es una corrección y ajusta sólo el cambio.
  await post(admin, "/caja/apertura", { caja_id: caja.id, importe: 800 });
  assert.equal((await get(beto, "/caja/estado")).resumen.saldo_esperado, 900);
  assert.equal((await db.get("SELECT accion FROM predio_auditoria WHERE accion LIKE 'Corrección%' ORDER BY id DESC LIMIT 1")).accion, "Corrección del saldo de apertura");
});
