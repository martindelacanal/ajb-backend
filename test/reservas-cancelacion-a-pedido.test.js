"use strict";

// «Cancelar a pedido de la persona afiliada»: permisos por
// rol y estado (incluidos 14 y 15), la misma cotización que ve la persona
// afiliada, lo que se guarda, el motivo que ya no pisa las observaciones y los
// avisos. HTTP real con express y una base simulada (molde de
// reservas-autorizacion-rutas.test.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "cancelacion-a-pedido-test-secret";

const turismo = require("../api/services/reservas-turismo");
const politicaServicio = require("../api/services/politica-cancelacion");
const avisos = require("../api/services/reservas-cancelacion-avisos");
const { categoriaNotificacion } = require("../api/services/notificaciones");
const { obtenerFechaCivilArgentina, sumarDiasFechaCivil } = require("../api/services/valores-dominio");

const {
  validarTransicionTurismo, puedeCancelarAPedido, esCargaPropiaDepartamental,
} = turismo;
const {
  REGLAS_INICIALES, calcularCotizacion, cotizarCancelacion, confirmarCancelacionPolitica, obtenerCancelacionRegistrada,
} = politicaServicio;

const HOY = obtenerFechaCivilArgentina();
const EN_10 = sumarDiasFechaCivil(HOY, 10);
const EN_17 = sumarDiasFechaCivil(HOY, 17);
const AYER = sumarDiasFechaCivil(HOY, -1);
const POLITICA = { id: 1, version: 1, titulo: "Hospedajes", reglas: REGLAS_INICIALES, motivo: "interno", creada_por: 9 };
const ESTADOS_ID = {
  Iniciada: 1, Verificada: 2, Aprobada: 3, Rechazada: 4, Cancelada: 13,
  Pendiente_Aprobacion_Titular: 14, "Pendiente de firma": 15,
};

function fechaCorta(fecha) {
  const [anio, mes, dia] = fecha.split("-");
  return `${dia}/${mes}/${anio}`;
}

// ---------------------------------------------------------------------------
// Base simulada
// ---------------------------------------------------------------------------

let usuarioSesionActual = null;
let escenario;
const llamadas = [];
const transacciones = [];

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

function preparar(cambios = {}) {
  llamadas.length = 0;
  transacciones.length = 0;
  escenario = {
    reserva: {
      id: 41, usuario_id: 200, estado_reserva_id: 2, estado_nombre: "Verificada", modalidad: "FECHA_LIBRE",
      fecha_inicio: EN_10, fecha_fin: EN_17, precio_total: "480000.00", observaciones: "Llega de noche",
      usuario_departamental_id: 7, servicio_id: 3, creado_por_usuario_id: 200, fecha_creacion: "2026-10-01 10:00:00",
      ...(cambios.reserva || {}),
    },
    politica: cambios.politica || POLITICA,
    solicitudFirma: cambios.solicitudFirma === undefined
      ? { politica_id: 1, politica_version: 1, politica_snapshot_json: JSON.stringify(POLITICA) }
      : cambios.solicitudFirma,
    creador: cambios.creador || null,
    duenio: {
      afiliado_nombre: "Marta", afiliado_apellido: "Gómez", usuario_familiar_id: null, es_familiar: "N",
      parentesco_id: 1, rol: "afiliado", ...(cambios.duenio || {}),
    },
    actor: { actor_nombre: "Graciela", actor_apellido: "López", actor_departamental: "Azul", ...(cambios.actor || {}) },
    staffTurismo: cambios.staffTurismo || [100, 300, 301],
    insercionesCancelacion: [],
    historial: [],
    actualizacionesReserva: [],
    notificaciones: [],
    actualizaciones: [],
  };
}

function responder(sql, params) {
  if (escenario.falla?.patron.test(sql)) throw escenario.falla.error;
  if (/SELECT r\.\*, er\.nombre AS estado_nombre/.test(sql)) return [[{ ...escenario.reserva }]];
  if (/SELECT departamental_id FROM usuario WHERE id = \? LIMIT 1/.test(sql)) {
    return [[{ departamental_id: usuarioSesionActual?.departamental_id ?? null }]];
  }
  if (/SELECT u\.departamental_id, ro\.nombre AS rol/.test(sql)) return [escenario.creador ? [escenario.creador] : []];
  if (/SELECT snapshot_json, 'ACEPTADA' AS origen_politica/.test(sql)) {
    return [[{ snapshot_json: JSON.stringify(escenario.politica), origen_politica: "ACEPTADA" }]];
  }
  if (/FROM reserva_firma_afiliado WHERE reserva_id = \? LIMIT 1/.test(sql)) {
    return [escenario.solicitudFirma ? [escenario.solicitudFirma] : []];
  }
  if (/INSERT INTO reserva_cancelacion_politica/.test(sql)) {
    escenario.insercionesCancelacion.push(params);
    return [{ affectedRows: 1 }];
  }
  if (/INSERT INTO historial_reserva/.test(sql)) {
    escenario.historial.push({ sql, params });
    return [{ insertId: escenario.historial.length }];
  }
  if (/SELECT id FROM estado_reserva WHERE nombre = \? LIMIT 1/.test(sql)) return [[{ id: ESTADOS_ID[params[0]] }]];
  if (/UPDATE reserva\s+SET estado_reserva_id = \?,\s+observaciones/.test(sql)) {
    escenario.actualizacionesReserva.push(params);
    return [{ affectedRows: 1 }];
  }
  if (/FROM bloque_fecha_recurso bfr/.test(sql)) return [[]];
  if (/^\s*UPDATE (reserva_aprobacion_titular|sorteo_adjudicacion_respuesta|notificacion|reserva_firma_afiliado)/.test(sql)) {
    escenario.actualizaciones.push({ sql, params });
    return [{ affectedRows: 1 }];
  }
  if (/AS actor_departamental/.test(sql)) {
    return [[{
      reserva_id: escenario.reserva.id, usuario_id: escenario.reserva.usuario_id,
      fecha_inicio: escenario.reserva.fecha_inicio, fecha_fin: escenario.reserva.fecha_fin, servicio: "Hotel Solís",
      ...escenario.duenio, ...escenario.actor,
    }]];
  }
  if (/INSERT INTO notificacion/.test(sql)) {
    const categoria = /SELECT (\w+) FROM usuario_notificacion_preferencia/.exec(sql)?.[1] || null;
    escenario.notificaciones.push({
      usuario_id: params[0], tipo: params[1], titulo: params[2], mensaje: params[3], payload: JSON.parse(params[4]), categoria,
    });
    return [{ insertId: escenario.notificaciones.length, affectedRows: 1 }];
  }
  if (/SELECT u\.id FROM usuario u INNER JOIN rol r ON r\.id = u\.rol_id\s+WHERE u\.habilitado = 'Y'\s+AND \(r\.nombre = 'admin'/.test(sql)) {
    return [escenario.staffTurismo.map((id) => ({ id }))];
  }
  if (/WHERE u\.habilitado = 'Y' AND r\.nombre = 'admin'/.test(sql)) return [[{ id: 300 }]];
  throw new Error(`Consulta inesperada: ${sql}`);
}

const conexion = {
  async beginTransaction() { transacciones.push("begin"); },
  async commit() { transacciones.push("commit"); },
  async rollback() { transacciones.push("rollback"); },
  release() {},
  async query(sql, params = []) {
    llamadas.push({ sql, params });
    if (esConsultaAutorizacion(sql)) return usuarioSesionActual ? [[usuarioSesionActual]] : [[]];
    return responder(sql, params);
  },
};
const pool = {
  promise() {
    return { getConnection: async () => conexion, query: conexion.query.bind(conexion), execute: conexion.query.bind(conexion) };
  },
};
const rutaConexion = require.resolve("../api/connection/connection");
require.cache[rutaConexion] = { id: rutaConexion, filename: rutaConexion, loaded: true, exports: pool };

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/api", require("../api/routes/politica-cancelacion"));
app.use("/api", require("../api/routes/user"));

const consoleLogOriginal = console.log;
const consoleErrorOriginal = console.error;
let server;
let base;
test.before(async () => {
  console.log = () => {};
  console.error = () => {};
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => {
  console.log = consoleLogOriginal;
  console.error = consoleErrorOriginal;
  await new Promise((resolve) => server.close(resolve));
});

function sesion(claims) {
  const rolIds = { admin: 1, departamental: 2, afiliado: 3 };
  const completos = { area_turismo: 1, departamental_id: null, ...claims };
  usuarioSesionActual = {
    id: completos.id, rol_id: rolIds[completos.rol] || 99, rol: completos.rol, departamental_id: completos.departamental_id,
    habilitado: "Y", area_turismo: completos.area_turismo, area_coseguro: 1,
    modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1,
  };
  return jwt.sign({ data: JSON.stringify(completos) }, process.env.JWT_SECRET);
}

const DEPARTAMENTAL = { id: 100, rol: "departamental", departamental_id: 7 };
const ADMIN = { id: 100, rol: "admin" };
const DUENIO = { id: 200, rol: "afiliado", departamental_id: 7 };

async function pedir(path, { claims, method = "GET", body } = {}) {
  const token = sesion(claims);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const textoRespuesta = await response.text();
  return { status: response.status, body: textoRespuesta ? JSON.parse(textoRespuesta) : null };
}

async function cotizar(claims) {
  return pedir("/reserva/41/cancelacion-cotizacion", { claims });
}

async function cancelar(claims, cuerpo = {}) {
  return pedir("/reserva/41/estado", {
    claims, method: "PUT", body: { estado: "Cancelada", cancelacion_confirmada: true, ...cuerpo },
  });
}

// ---------------------------------------------------------------------------
// Transiciones (función pura)
// ---------------------------------------------------------------------------

function transicion(rol, actual, destino, opciones = {}) {
  return validarTransicionTurismo({
    rol, usuarioId: 10, propietarioId: opciones.propietarioId || 10, estadoActual: actual, estadoSolicitado: destino,
    modalidad: opciones.modalidad || "FECHA_LIBRE", aPedidoAfiliado: opciones.aPedidoAfiliado,
    cargaPropiaDepartamental: opciones.cargaPropiaDepartamental,
  });
}

test("el staff cancela a pedido en Iniciada, Verificada, Aprobada, 14 y 15; en el 15 sin penalidad", () => {
  for (const rol of ["admin", "departamental"]) {
    for (const estado of ["Iniciada", "Verificada", "Aprobada", "Pendiente_Aprobacion_Titular"]) {
      const resultado = transicion(rol, estado, "Cancelada", { propietarioId: 11, aPedidoAfiliado: true });
      assert.equal(resultado.valido, true, `${rol} ${estado}`);
      assert.equal(resultado.estadoDestino, "Cancelada");
      assert.equal(resultado.accion, "CANCELAR_A_PEDIDO");
      assert.equal(resultado.origen, "STAFF_A_PEDIDO");
      assert.equal(resultado.regla, "POLITICA");
    }
    const sinFirma = transicion(rol, "Pendiente de firma", "Cancelada", { propietarioId: 11, aPedidoAfiliado: true });
    assert.equal(sinFirma.valido, true, rol);
    assert.equal(sinFirma.regla, "SIN_FIRMA");
  }
});

test("el staff no cancela por su cuenta ni desde estados cerrados; admin-central tampoco", () => {
  const sinPedido = transicion("admin", "Aprobada", "Cancelada");
  assert.equal(sinPedido.valido, false);
  assert.equal(sinPedido.statusCode, 400);
  assert.equal(sinPedido.codigo, "CANCELACION_SIN_PEDIDO");
  for (const estado of ["Rechazada", "Cancelada", "Utilizada", "Solicitud sorteo"]) {
    const resultado = transicion("departamental", estado, "Cancelada", { aPedidoAfiliado: true });
    assert.equal(resultado.valido, false, estado);
    assert.equal(resultado.statusCode, 409, estado);
  }
  for (const rol of ["admin-central", "auditor"]) {
    assert.equal(transicion(rol, "Verificada", "Cancelada", { aPedidoAfiliado: true }).statusCode, 403, rol);
  }
  assert.equal(transicion("admin", "Aprobada", "Cancelada", { aPedidoAfiliado: true, modalidad: "SORTEO" }).codigo, "FLUJO_RESERVA_ESPECIAL");
});

test("la persona afiliada cancela lo suyo desde la app, pero no un 15 (lo rechaza al firmar)", () => {
  for (const estado of ["Iniciada", "Verificada", "Aprobada", "Pendiente_Aprobacion_Titular"]) {
    const propia = transicion("afiliado", estado, "Cancelada");
    assert.equal(propia.valido, true, estado);
    assert.equal(propia.accion, "CANCELAR");
    assert.equal(propia.origen, "AFILIADO");
  }
  const enFirma = transicion("afiliado", "Pendiente de firma", "Cancelada", { aPedidoAfiliado: true });
  assert.equal(enFirma.valido, false);
  assert.equal(enFirma.statusCode, 403);
  assert.equal(transicion("afiliado", "Verificada", "Rechazada").statusCode, 403);
});

test("la departamental rechaza sus propias cargas verificadas, no las del afiliado ni las aprobadas", () => {
  const propia = transicion("departamental", "Verificada", "Rechazada", { cargaPropiaDepartamental: true });
  assert.equal(propia.valido, true);
  assert.equal(propia.accion, "RECHAZAR");
  assert.equal(propia.estadoDestino, "Rechazada");
  assert.equal(transicion("departamental", "Verificada", "Rechazada").statusCode, 403);
  assert.equal(transicion("departamental", "Aprobada", "Rechazada", { cargaPropiaDepartamental: true }).statusCode, 403);
  assert.equal(transicion("departamental", "Pendiente de firma", "Rechazada", { cargaPropiaDepartamental: true }).valido, false);
  assert.equal(transicion("departamental", "Iniciada", "Rechazada").valido, true);

  assert.equal(esCargaPropiaDepartamental({ creador: { rol: "departamental", departamental_id: 7 }, departamentalActorId: 7 }), true);
  assert.equal(esCargaPropiaDepartamental({ creador: { rol: "departamental", departamental_id: 8 }, departamentalActorId: 7 }), false);
  assert.equal(esCargaPropiaDepartamental({ creador: { rol: "afiliado", departamental_id: 7 }, departamentalActorId: 7 }), false);
  assert.equal(esCargaPropiaDepartamental({ creador: null, departamentalActorId: 7 }), false);
  assert.equal(esCargaPropiaDepartamental({ creador: { rol: "departamental", departamental_id: null }, departamentalActorId: null }), false);
});

test("puedeCancelarAPedido usa la misma regla que el endpoint (fecha vencida sólo en 15)", () => {
  const base = { rol: "departamental", modalidad: "FECHA_LIBRE", hoy: HOY };
  assert.equal(puedeCancelarAPedido({ ...base, estado: "Aprobada", fechaInicio: EN_10 }), true);
  assert.equal(puedeCancelarAPedido({ ...base, estado: "Aprobada", fechaInicio: HOY }), true);
  assert.equal(puedeCancelarAPedido({ ...base, estado: "Aprobada", fechaInicio: AYER }), false);
  assert.equal(puedeCancelarAPedido({ ...base, estado: "Pendiente de firma", fechaInicio: AYER }), true);
  assert.equal(puedeCancelarAPedido({ ...base, estado: "Cancelada", fechaInicio: EN_10 }), false);
  assert.equal(puedeCancelarAPedido({ ...base, estado: "Aprobada", fechaInicio: EN_10, modalidad: "CONVENIO" }), false);
  for (const rol of ["afiliado", "admin-central"]) {
    assert.equal(puedeCancelarAPedido({ ...base, rol, estado: "Aprobada", fechaInicio: EN_10 }), false, rol);
  }
});

test("las constantes de la cancelación coinciden entre servicios (se repiten para no crear un ciclo)", () => {
  for (const nombre of ["ESTADO_PENDIENTE_FIRMA", "ORIGEN_CANCELACION_AFILIADO", "ORIGEN_CANCELACION_STAFF_A_PEDIDO",
    "REGLA_CANCELACION_POLITICA", "REGLA_CANCELACION_SIN_FIRMA"]) {
    assert.equal(politicaServicio[nombre], turismo[nombre], nombre);
  }
  assert.deepEqual([...politicaServicio.CANALES_PEDIDO_CANCELACION], [...turismo.CANALES_PEDIDO_CANCELACION]);
  assert.equal(categoriaNotificacion("RESERVA_CANCELADA_A_PEDIDO"), "estados");
});

// ---------------------------------------------------------------------------
// Servicio de cancelación: columnas, regla SIN_FIRMA, autor sólo al staff
// ---------------------------------------------------------------------------

test("confirmar guarda origen, canal, rol, motivo y regla al final, sin cambiar las posiciones anteriores", async () => {
  const escrituras = [];
  const db = { query: async (sql, params) => {
    if (/SELECT snapshot_json/.test(sql)) return [[{ snapshot_json: POLITICA }]];
    escrituras.push({ sql, params });
    return [{ affectedRows: 1 }];
  } };
  const reserva = { id: 50, precio_total: "480000", fecha_inicio: EN_10, estado_nombre: "Aprobada" };
  const { cotizacion } = await cotizarCancelacion(db, { reserva });
  const resultado = await confirmarCancelacionPolitica(db, {
    reserva, usuarioId: 100, confirmada: true, cotizacion,
    origen: "STAFF_A_PEDIDO", canal: "escrito", rol: "departamental", motivo: "  Se enfermó  ",
  });
  const [insercion, historial] = escrituras;
  assert.match(insercion.sql, /tipo_base, origen, canal, cancelada_por_rol, motivo, regla\)/);
  assert.equal(insercion.params[3], 50);
  assert.equal(JSON.parse(insercion.params[7]).porcentaje_reintegro, 50);
  assert.deepEqual(insercion.params.slice(12), ["STAFF_A_PEDIDO", "ESCRITO", "departamental", "Se enfermó", "POLITICA"]);
  assert.match(historial.params[3], /^Cancelación a pedido de la persona afiliada \(por escrito\): política versión 1; 10 días previos/);
  assert.match(historial.params[3], /Motivo: Se enfermó$/);
  assert.equal(resultado.origen, "STAFF_A_PEDIDO");
  assert.equal(resultado.canal, "ESCRITO");
  assert.equal(resultado.motivo, "Se enfermó");

  // Sin datos del pedido (la llamada de siempre): la persona afiliada desde la app.
  escrituras.length = 0;
  await confirmarCancelacionPolitica(db, { reserva, usuarioId: 20, confirmada: true, cotizacion });
  assert.deepEqual(escrituras[0].params.slice(12), ["AFILIADO", "APP", null, null, "POLITICA"]);
  assert.match(escrituras[1].params[3], /^Cancelación confirmada por la persona afiliada desde la app/);
});

test("confirmar rechaza canal inválido o motivo largo antes de escribir", async () => {
  const escrituras = [];
  const db = { query: async (sql, params) => {
    if (/SELECT snapshot_json/.test(sql)) return [[{ snapshot_json: POLITICA }]];
    escrituras.push({ sql, params });
    return [{ affectedRows: 1 }];
  } };
  const reserva = { id: 50, precio_total: "480000", fecha_inicio: EN_10, estado_nombre: "Aprobada" };
  const { cotizacion } = await cotizarCancelacion(db, { reserva });
  await assert.rejects(confirmarCancelacionPolitica(db, {
    reserva, usuarioId: 100, confirmada: true, cotizacion, origen: "STAFF_A_PEDIDO", canal: "MAIL",
  }), { statusCode: 400, codigo: "CANCELACION_CANAL_INVALIDO" });
  await assert.rejects(confirmarCancelacionPolitica(db, {
    reserva, usuarioId: 100, confirmada: true, cotizacion, origen: "STAFF_A_PEDIDO", canal: "TELEFONO", motivo: "x".repeat(1001),
  }), { statusCode: 400, codigo: "MOTIVO_DEMASIADO_LARGO" });
  await assert.rejects(confirmarCancelacionPolitica(db, {
    reserva, usuarioId: 100, confirmada: true, cotizacion, origen: "OTRO",
  }), { statusCode: 400, codigo: "CANCELACION_ORIGEN_INVALIDO" });
  assert.equal(escrituras.length, 0);
  // 1000 caracteres (con tildes y emojis contados como uno) entran.
  await confirmarCancelacionPolitica(db, {
    reserva, usuarioId: 100, confirmada: true, cotizacion, origen: "STAFF_A_PEDIDO", canal: "TELEFONO", motivo: "á".repeat(999) + "🙂",
  });
  assert.equal([...escrituras[0].params[15]].length, 1000);
});

test("una reserva que espera la firma se cotiza sin penalidad con la política que se le envió", async () => {
  const consultas = [];
  const enviada = { ...POLITICA, id: 4, version: 3, reglas: [{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro: 0 }] };
  const db = { query: async (sql) => {
    consultas.push(sql);
    if (/FROM reserva_firma_afiliado/.test(sql)) return [[{ politica_id: 4, politica_version: 3, politica_snapshot_json: JSON.stringify(enviada) }]];
    throw new Error(`Consulta inesperada: ${sql}`);
  } };
  const reserva = { id: 51, precio_total: "300000", fecha_inicio: AYER, estado_nombre: "Pendiente de firma" };
  const cotizacion = await cotizarCancelacion(db, { reserva });
  assert.equal(cotizacion.regla, "SIN_FIRMA");
  assert.equal(cotizacion.origen_politica, "SIN_FIRMA");
  assert.equal(cotizacion.porcentaje_reintegro, 100);
  assert.equal(cotizacion.monto_reintegro, 300000);
  assert.equal(cotizacion.politica.version, 3);
  assert.equal(cotizacion.dias_previos, -1);
  assert.match(cotizacion.mensaje, /sin penalidad/);
  assert.equal(consultas.length, 1);
  // La huella cambia con el estado: si firma mientras el staff tiene el diálogo abierto, hay que volver a cotizar.
  const firmada = calcularCotizacion({ reserva: { ...reserva, fecha_inicio: EN_10, estado_nombre: "Iniciada" }, politica: enviada });
  assert.notEqual(firmada.cotizacion, cotizacion.cotizacion);
  assert.equal(firmada.regla, "POLITICA");

  // Sin fila de solicitud (dato inconsistente) igual se registra sin penalidad con la aceptada o la histórica.
  const sinSolicitud = { query: async (sql) => {
    if (/FROM reserva_firma_afiliado/.test(sql)) return [[]];
    if (/SELECT snapshot_json, 'ACEPTADA'/.test(sql)) return [[{ snapshot_json: POLITICA, origen_politica: "ACEPTADA" }]];
    throw new Error(`Consulta inesperada: ${sql}`);
  } };
  const respaldo = await cotizarCancelacion(sinSolicitud, { reserva });
  assert.equal(respaldo.porcentaje_reintegro, 100);
  assert.equal(respaldo.regla, "SIN_FIRMA");
});

test("la cancelación registrada da quién la pidió a todos y el nombre de quien la cargó sólo al staff", async () => {
  const fila = {
    cancelada_en: "2027-01-05 10:00:00", fecha_calculo_civil: "2027-01-05", fecha_checkin_civil: "2027-01-10", dias_previos: 5,
    porcentaje_reintegro: "0.00", monto_base: "480000.00", monto_reintegro: "0.00", tipo_base: "TOTAL_RESERVA",
    snapshot_json: { politica: { ...POLITICA }, origen_politica: "ACEPTADA" },
    origen: "STAFF_A_PEDIDO", canal: "TELEFONO", cancelada_por_rol: "departamental", motivo: "Se enfermó", regla: "POLITICA",
    cancelada_por_nombre_pila: "Graciela", cancelada_por_apellido: "López",
  };
  const db = { query: async (sql, params) => {
    assert.match(sql, /FROM reserva_cancelacion_politica rcp LEFT JOIN usuario u ON u\.id = rcp\.cancelada_por/);
    assert.deepEqual(params, [41]);
    return [[fila]];
  } };
  const paraAfiliado = await obtenerCancelacionRegistrada(db, { reservaId: 41 });
  assert.equal(paraAfiliado.origen, "STAFF_A_PEDIDO");
  assert.equal(paraAfiliado.canal, "TELEFONO");
  assert.equal(paraAfiliado.motivo, "Se enfermó");
  assert.equal(paraAfiliado.cancelada_por_rol, "departamental");
  assert.equal(paraAfiliado.cancelada_por_nombre, undefined);
  assert.equal(paraAfiliado.politica.motivo, undefined);
  const paraStaff = await obtenerCancelacionRegistrada(db, { reservaId: 41, incluirAutor: true });
  assert.equal(paraStaff.cancelada_por_nombre, "Graciela López");
  // Cancelaciones anteriores a migrar-firma-condiciones-reserva.js (2026-10-22): sin datos del pedido, regla POLITICA.
  for (const campo of ["origen", "canal", "cancelada_por_rol", "motivo", "regla"]) delete fila[campo];
  const vieja = await obtenerCancelacionRegistrada(db, { reservaId: 41 });
  assert.equal(vieja.origen, null);
  assert.equal(vieja.regla, "POLITICA");
});

// ---------------------------------------------------------------------------
// Textos de los avisos
// ---------------------------------------------------------------------------

const DATOS_AVISO = {
  reserva_id: 41, servicio: "Hotel Solís", fecha_inicio: "2027-01-10", fecha_fin: "2027-01-17",
  afiliado_nombre: "Marta", afiliado_apellido: "Gómez", actor_nombre: "Graciela", actor_apellido: "López", actor_departamental: "Azul",
};
const COBRO = {
  regla: "POLITICA", dias_previos: 10, porcentaje_reintegro: 50, monto_base: 480000, monto_reintegro: 240000,
  politica: { reglas: REGLAS_INICIALES }, motivo: null,
};

test("aviso a la persona afiliada: reintegro, variantes y la línea de control", () => {
  const texto = avisos.textoAvisoCancelacionAPedido({ datos: DATOS_AVISO, cancelacion: COBRO, rolActor: "departamental", canal: "TELEFONO" });
  assert.equal(texto, "Tu departamental canceló a tu pedido (por teléfono) la reserva T-41 de Hotel Solís, del 10/01/2027 al 17/01/2027. "
    + "Faltaban 10 días para el ingreso: según la política de cancelación de tu reserva, te corresponde un reintegro estimado "
    + "del 50%: $ 240.000 sobre un total de $ 480.000. El importe final se confirma al gestionar el reintegro. "
    + "Si no pediste esta cancelación, comunicate con tu departamental.");
  const variantes = (cambios, canal = "PRESENCIAL", rolActor = "admin") => avisos.textoAvisoCancelacionAPedido({
    datos: DATOS_AVISO, cancelacion: { ...COBRO, ...cambios }, rolActor, canal,
  });
  assert.match(variantes({}), /^El equipo de Turismo canceló a tu pedido \(en persona\)/);
  assert.match(variantes({ porcentaje_reintegro: 0, monto_reintegro: 0, dias_previos: 3 }),
    /Faltaban 3 días para el ingreso: según la política de cancelación de tu reserva, no corresponde reintegro\./);
  assert.match(variantes({ dias_previos: 1 }), /Faltaba 1 día para el ingreso/);
  assert.match(variantes({ dias_previos: 0 }), /Era el día de ingreso/);
  assert.match(variantes({ politica: { reglas: [{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro: 0 }] }, porcentaje_reintegro: 0 }),
    /Esta reserva no tenía devoluciones: no corresponde reintegro\./);
  assert.match(variantes({ monto_base: 0, monto_reintegro: 0 }), /La estadía estaba bonificada: no hay importe para reintegrar\./);
  assert.match(variantes({ monto_base: 480000.5, monto_reintegro: 240000.25 }), /\$ 240\.000,25 sobre un total de \$ 480\.000,50/);
  assert.match(variantes({ motivo: "Se enfermó" }, "ESCRITO"), /\(por escrito\)[\s\S]+ Motivo: Se enfermó\. Si no pediste esta cancelación/);
  assert.match(variantes({ motivo: "¿Se puede?" }), / Motivo: ¿Se puede\? Si no pediste/);
  const sinFirma = variantes({ regla: "SIN_FIRMA", porcentaje_reintegro: 100 }, "TELEFONO", "departamental");
  assert.equal(sinFirma, "Tu departamental canceló a tu pedido (por teléfono) la reserva T-41 que tenías para firmar "
    + "(Hotel Solís, del 10/01/2027 al 17/01/2027). Como todavía no la habías firmado, no tiene ningún cargo y no tenés que hacer nada. "
    + "Si no pediste esta cancelación, comunicate con tu departamental.");
});

test("aviso al titular y a Turismo", () => {
  const titular = avisos.textoAvisoCancelacionTitular({ datos: DATOS_AVISO, cancelacion: COBRO, rolActor: "departamental", canal: "TELEFONO" });
  assert.match(titular, /^Tu departamental canceló, a pedido de Marta Gómez \(por teléfono\), la reserva T-41 de Hotel Solís/);
  assert.match(titular, /según la política de cancelación de la reserva, corresponde un reintegro estimado del 50%/);
  assert.match(titular, /Si nadie de tu grupo familiar pidió esta cancelación, comunicate con tu departamental\.$/);
  const staff = avisos.textoAvisoCancelacionStaff({ datos: DATOS_AVISO, cancelacion: { ...COBRO, motivo: "Se enfermó" }, rolActor: "departamental", canal: "TELEFONO" });
  assert.equal(staff, "Graciela López (Departamental Azul) la canceló a pedido de Marta Gómez, por teléfono. "
    + "Reintegro estimado: 50% ($ 240.000 sobre $ 480.000). Motivo: Se enfermó.");
  assert.match(avisos.textoAvisoCancelacionStaff({ datos: DATOS_AVISO, cancelacion: { ...COBRO, regla: "SIN_FIRMA" }, rolActor: "admin", canal: "ESCRITO" }),
    /^Graciela López \(Turismo\) la canceló a pedido de Marta Gómez, por escrito\. Sin penalidad: todavía no estaba firmada\.$/);
  assert.equal(avisos.textoAvisoCancelacionAfiliadoStaff({ ...COBRO, motivo: "Cambio de planes" }),
    "La persona afiliada canceló la reserva desde la app. Reintegro estimado: 50% ($ 240.000 sobre $ 480.000). Motivo: Cambio de planes.");
});

// ---------------------------------------------------------------------------
// HTTP: GET cotización y PUT estado
// ---------------------------------------------------------------------------

test("el staff tiene que decir cómo se lo pidió; admin-central y otra departamental no cancelan", async () => {
  preparar();
  let respuesta = await cancelar(DEPARTAMENTAL, { cancelacion_cotizacion: "x" });
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body.codigo, "CANCELACION_CANAL_REQUERIDO");
  respuesta = await cancelar(DEPARTAMENTAL, { cancelacion_canal: "MAIL", cancelacion_cotizacion: "x" });
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body.codigo, "CANCELACION_CANAL_INVALIDO");
  assert.ok(llamadas.every(({ sql }) => esConsultaAutorizacion(sql)), "rechaza antes de abrir la transacción");

  respuesta = await cancelar({ id: 100, rol: "admin-central" }, { cancelacion_canal: "TELEFONO" });
  assert.equal(respuesta.status, 403);
  assert.equal((await cotizar({ id: 100, rol: "admin-central" })).status, 403);

  preparar();
  respuesta = await cancelar({ ...DEPARTAMENTAL, departamental_id: 9 }, { cancelacion_canal: "TELEFONO", cancelacion_cotizacion: "x" });
  assert.equal(respuesta.status, 403);
  assert.equal(respuesta.body.codigo, "RESERVA_OTRA_DEPARTAMENTAL");
  assert.equal((await cotizar({ ...DEPARTAMENTAL, departamental_id: 9 })).status, 403);
  assert.equal(escenario.insercionesCancelacion.length, 0);
});

test("la departamental cancela a pedido en Verificada, Aprobada y 14 con la misma cotización que la persona afiliada", async () => {
  for (const estado of ["Verificada", "Aprobada", "Pendiente_Aprobacion_Titular"]) {
    preparar({ reserva: { estado_nombre: estado, estado_reserva_id: ESTADOS_ID[estado] } });
    const delAfiliado = await cotizar(DUENIO);
    const delStaff = await cotizar(DEPARTAMENTAL);
    assert.equal(delStaff.status, 200, estado);
    assert.equal(delStaff.body.cotizacion, delAfiliado.body.cotizacion, `${estado}: misma huella`);
    assert.equal(delStaff.body.porcentaje_reintegro, 50);
    assert.equal(delStaff.body.monto_reintegro, 240000);
    assert.equal(delStaff.body.regla, "POLITICA");
    assert.equal(delStaff.body.politica.motivo, undefined);

    preparar({ reserva: { estado_nombre: estado, estado_reserva_id: ESTADOS_ID[estado] } });
    const respuesta = await cancelar(DEPARTAMENTAL, {
      cancelacion_canal: "telefono", cancelacion_cotizacion: delStaff.body.cotizacion, observaciones: "Se enfermó",
    });
    assert.equal(respuesta.status, 200, `${estado}: ${JSON.stringify(respuesta.body)}`);
    assert.deepEqual(transacciones, ["begin", "commit"]);
    assert.equal(respuesta.body.reserva.estado, "Cancelada");
    assert.equal(respuesta.body.cancelacion.origen, "STAFF_A_PEDIDO");
    assert.equal(respuesta.body.cancelacion.canal, "TELEFONO");
    assert.equal(respuesta.body.cancelacion.motivo, "Se enfermó");
    assert.equal(respuesta.body.cancelacion.politica.motivo, undefined, "no expone el motivo interno de la política");
    assert.equal(respuesta.body.cancelacion.politica.creada_por, undefined);

    const [insercion] = escenario.insercionesCancelacion;
    assert.equal(insercion[3], 50);
    assert.equal(insercion[8], 100, "cancelada_por = quien lo cargó");
    assert.deepEqual(insercion.slice(12), ["STAFF_A_PEDIDO", "TELEFONO", "departamental", "Se enfermó", "POLITICA"]);
    // El motivo ya no pisa las observaciones de la reserva.
    const [actualizacion] = escenario.actualizacionesReserva;
    assert.equal(actualizacion[0], 13);
    assert.equal(actualizacion[1], null);
    assert.ok(!escenario.historial.some(({ params }) => params.includes("observaciones")));
    assert.ok(escenario.historial.some(({ params }) => /^Cancelación a pedido de la persona afiliada \(por teléfono\)/.test(params[3] || "")));

    // Avisos: a la persona afiliada (estados) y a Turismo sin el autor.
    const alAfiliado = escenario.notificaciones.filter((n) => n.usuario_id === 200);
    assert.equal(alAfiliado.length, 1);
    assert.equal(alAfiliado[0].tipo, "RESERVA_CANCELADA_A_PEDIDO");
    assert.equal(alAfiliado[0].categoria, "estados");
    assert.equal(alAfiliado[0].titulo, "Reserva T-41 cancelada a tu pedido");
    assert.match(alAfiliado[0].mensaje, /^Tu departamental canceló a tu pedido \(por teléfono\) la reserva T-41 de Hotel Solís/);
    assert.match(alAfiliado[0].mensaje, /reintegro estimado del 50%: \$ 240\.000 sobre un total de \$ 480\.000/);
    assert.match(alAfiliado[0].mensaje, /Motivo: Se enfermó\. Si no pediste esta cancelación, comunicate con tu departamental\.$/);
    assert.deepEqual(alAfiliado[0].payload, { reserva_id: 41, estado: "Cancelada", origen: "STAFF_A_PEDIDO", regla: "POLITICA" });
    const aTurismo = escenario.notificaciones.filter((n) => n.usuario_id !== 200);
    assert.deepEqual(aTurismo.map((n) => n.usuario_id).sort(), [300, 301], "el autor (100) no recibe su propio aviso");
    assert.ok(aTurismo.every((n) => n.tipo === "RESERVA_CANCELADA_A_PEDIDO" && n.categoria === "estados"));
    // El mismo código que los demás avisos nuevos de la reserva («T-41»).
    assert.ok(aTurismo.every((n) => n.titulo === "Reserva T-41 cancelada a pedido de la persona afiliada"));
    assert.match(aTurismo[0].mensaje, /^Graciela López \(Departamental Azul\) la canceló a pedido de Marta Gómez, por teléfono\./);

    const leida = escenario.actualizaciones.find(({ sql }) => /RESERVA_APROBACION_TITULAR/.test(sql));
    assert.equal(Boolean(leida), estado === "Pendiente_Aprobacion_Titular", `${estado}: aviso del titular leído`);
  }
});

test("si la reserva es de un familiar, también se avisa al titular", async () => {
  preparar({ duenio: { es_familiar: "S", usuario_familiar_id: 150, parentesco_id: 3, rol: "invitado" } });
  const { body } = await cotizar(DEPARTAMENTAL);
  const respuesta = await cancelar(DEPARTAMENTAL, { cancelacion_canal: "PRESENCIAL", cancelacion_cotizacion: body.cotizacion });
  assert.equal(respuesta.status, 200);
  const titular = escenario.notificaciones.find((n) => n.usuario_id === 150);
  assert.ok(titular);
  assert.equal(titular.titulo, "Reserva T-41 de Marta Gómez cancelada a su pedido");
  assert.equal(titular.categoria, "estados");
  assert.match(titular.mensaje, /a pedido de Marta Gómez \(en persona\)/);
});

test("Pendiente de firma: se cancela sin penalidad aunque haya pasado el ingreso y cierra la solicitud", async () => {
  preparar({ reserva: { estado_nombre: "Pendiente de firma", estado_reserva_id: 15, fecha_inicio: AYER, fecha_fin: EN_10 } });
  const cotizacion = await cotizar(DEPARTAMENTAL);
  assert.equal(cotizacion.status, 200);
  assert.equal(cotizacion.body.regla, "SIN_FIRMA");
  assert.equal(cotizacion.body.porcentaje_reintegro, 100);
  const respuesta = await cancelar(DEPARTAMENTAL, { cancelacion_canal: "TELEFONO", cancelacion_cotizacion: cotizacion.body.cotizacion });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.equal(escenario.insercionesCancelacion[0][3], 100);
  assert.equal(escenario.insercionesCancelacion[0][16], "SIN_FIRMA");
  // El historial no habla de un «reintegro» con importes de una reserva que nunca se firmó ni se pagó.
  const historialCancelacion = escenario.historial.find(({ sql }) => /'porcentaje_reintegro'/.test(sql));
  assert.equal(historialCancelacion.params[3], "Cancelación a pedido de la persona afiliada (por teléfono): "
    + "todavía no estaba firmada, sin penalidad (no se aplicaron las condiciones de cancelación).");
  const solicitud = escenario.actualizaciones.find(({ sql }) => /UPDATE reserva_firma_afiliado/.test(sql));
  assert.match(solicitud.sql, /decision = 'CANCELADA'[\s\S]+WHERE reserva_id = \? AND decision = 'PENDIENTE'/);
  assert.deepEqual(solicitud.params, [100, 41]);
  const avisoLeido = escenario.actualizaciones.find(({ sql }) => /RESERVA_FIRMA_PENDIENTE/.test(sql));
  assert.deepEqual(avisoLeido.params, [200, "41"]);
  const alAfiliado = escenario.notificaciones.find((n) => n.usuario_id === 200);
  assert.match(alAfiliado.mensaje, /que tenías para firmar[\s\S]+no tiene ningún cargo y no tenés que hacer nada/);
  assert.equal(alAfiliado.payload.regla, "SIN_FIRMA");

  // La persona afiliada no cancela un 15 por esta vía: lo rechaza desde la pantalla de firma.
  preparar({ reserva: { estado_nombre: "Pendiente de firma", estado_reserva_id: 15 } });
  assert.equal((await cotizar(DUENIO)).status, 403);
  const delAfiliado = await cancelar(DUENIO, { cancelacion_cotizacion: cotizacion.body.cotizacion });
  assert.equal(delAfiliado.status, 403);
  assert.equal(delAfiliado.body.codigo, "TRANSICION_NO_AUTORIZADA");
  assert.equal(escenario.insercionesCancelacion.length, 0);
});

test("fuera del 15, la fecha de ingreso vencida y la huella vieja frenan la cancelación sin escribir", async () => {
  preparar({ reserva: { estado_nombre: "Aprobada", estado_reserva_id: 3, fecha_inicio: AYER } });
  assert.equal((await cotizar(DEPARTAMENTAL)).body.codigo, "RESERVA_FECHA_VENCIDA");
  let respuesta = await cancelar(DEPARTAMENTAL, { cancelacion_canal: "TELEFONO", cancelacion_cotizacion: "x" });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "RESERVA_FECHA_VENCIDA");

  preparar();
  respuesta = await cancelar(ADMIN, { cancelacion_canal: "ESCRITO", cancelacion_cotizacion: "huella-vieja" });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "COTIZACION_CANCELACION_ACTUALIZADA");
  assert.equal(escenario.insercionesCancelacion.length, 0);
  assert.equal(escenario.notificaciones.length, 0);
  assert.deepEqual(transacciones, ["begin", "rollback"]);

  preparar();
  const { body } = await cotizar(ADMIN);
  respuesta = await cancelar(ADMIN, { cancelacion_canal: "TELEFONO", cancelacion_cotizacion: body.cotizacion, observaciones: "y".repeat(1001) });
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body.codigo, "MOTIVO_DEMASIADO_LARGO");
  assert.equal(escenario.insercionesCancelacion.length, 0);
});

test("admin cancela a pedido por escrito: el aviso dice «El equipo de Turismo»", async () => {
  preparar({ reserva: { estado_nombre: "Iniciada", estado_reserva_id: 1 }, actor: { actor_departamental: null } });
  const { body } = await cotizar(ADMIN);
  const respuesta = await cancelar(ADMIN, { cancelacion_canal: "ESCRITO", cancelacion_cotizacion: body.cotizacion });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(escenario.insercionesCancelacion[0].slice(12), ["STAFF_A_PEDIDO", "ESCRITO", "admin", null, "POLITICA"]);
  const alAfiliado = escenario.notificaciones.find((n) => n.usuario_id === 200);
  assert.match(alAfiliado.mensaje, /^El equipo de Turismo canceló a tu pedido \(por escrito\)/);
  const aTurismo = escenario.notificaciones.find((n) => n.usuario_id === 300);
  assert.match(aTurismo.mensaje, /^Graciela López \(Turismo\) la canceló/);
});

test("la persona afiliada cancela desde la app: canal APP, el motivo no pisa las observaciones y Turismo recibe el reintegro", async () => {
  preparar();
  const { body } = await cotizar(DUENIO);
  const respuesta = await cancelar(DUENIO, {
    cancelacion_cotizacion: body.cotizacion, cancelacion_canal: "TELEFONO", observaciones: "Cambio de planes",
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.deepEqual(escenario.insercionesCancelacion[0].slice(12), ["AFILIADO", "APP", "afiliado", "Cambio de planes", "POLITICA"]);
  assert.equal(escenario.actualizacionesReserva[0][1], null);
  assert.ok(!escenario.notificaciones.some((n) => n.usuario_id === 200), "no se avisa a sí misma");
  const aTurismo = escenario.notificaciones.filter((n) => n.tipo === "RESERVA_CANCELADA_AFILIADO");
  assert.deepEqual(aTurismo.map((n) => n.usuario_id).sort(), [100, 300, 301]);
  assert.equal(aTurismo[0].mensaje,
    "La persona afiliada canceló la reserva desde la app. Reintegro estimado: 50% ($ 240.000 sobre $ 480.000). Motivo: Cambio de planes.");
});

test("la departamental rechaza su propia carga verificada, no la de la persona afiliada ni la de otra departamental", async () => {
  preparar({ reserva: { creado_por_usuario_id: 500 }, creador: { rol: "departamental", departamental_id: 7 } });
  let respuesta = await pedir("/reserva/41/estado", {
    claims: DEPARTAMENTAL, method: "PUT", body: { estado: "Rechazada", observaciones: "Cargué mal las fechas" },
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.reserva.estado, "Rechazada");
  assert.equal(escenario.actualizacionesReserva[0][1], "Cargué mal las fechas", "el rechazo sigue usando las observaciones");
  const aviso = escenario.notificaciones.find((n) => n.usuario_id === 200);
  assert.equal(aviso.tipo, "RESERVA_RECHAZAR");
  assert.equal(aviso.categoria, "estados");
  assert.equal(escenario.insercionesCancelacion.length, 0, "rechazar no calcula reintegro");

  for (const caso of [
    { reserva: { creado_por_usuario_id: 200 }, creador: { rol: "afiliado", departamental_id: 7 } },
    { reserva: { creado_por_usuario_id: 501 }, creador: { rol: "departamental", departamental_id: 8 } },
    { reserva: { creado_por_usuario_id: null } },
  ]) {
    preparar(caso);
    respuesta = await pedir("/reserva/41/estado", { claims: DEPARTAMENTAL, method: "PUT", body: { estado: "Rechazada" } });
    assert.equal(respuesta.status, 403, JSON.stringify(caso));
    assert.equal(escenario.actualizacionesReserva.length, 0);
  }
});

test("verificar, aprobar y rechazar avisan en la categoría «estados»", async () => {
  preparar();
  const respuesta = await pedir("/reserva/41/estado", { claims: ADMIN, method: "PUT", body: { estado: "Aprobada" } });
  assert.equal(respuesta.status, 200);
  const aviso = escenario.notificaciones.find((n) => n.usuario_id === 200);
  assert.equal(aviso.tipo, "RESERVA_APROBAR");
  assert.equal(aviso.categoria, "estados");
  assert.equal(categoriaNotificacion("RESERVA_APROBAR"), "novedades", "sin la categoría explícita caería en «novedades»");
});

test("si el cambio de estado se cruza con la firma de la persona (deadlock), responde 409 para volver a intentar", async () => {
  // Esta ruta bloquea reserva → persona y la firma, persona → reserva: InnoDB revierte una.
  preparar();
  escenario.falla = {
    patron: /SELECT r\.\*, er\.nombre AS estado_nombre/,
    error: Object.assign(new Error("Deadlock found when trying to get lock; try restarting transaction"), { code: "ER_LOCK_DEADLOCK", errno: 1213 }),
  };
  const respuesta = await cancelar(DEPARTAMENTAL, { cancelacion_canal: "TELEFONO", cancelacion_cotizacion: "x" });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "RESERVA_MODIFICADA");
  assert.match(respuesta.body.message, /Volvé a cargarla e intentalo de nuevo\.$/);
  assert.deepEqual(transacciones, ["begin", "rollback"]);
  assert.equal(escenario.insercionesCancelacion.length, 0);
  assert.equal(escenario.notificaciones.length, 0);
});
