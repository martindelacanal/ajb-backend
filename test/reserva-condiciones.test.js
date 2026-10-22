"use strict";

// Lo que se ve después de reservar. Tramos con fechas reales
// (calcularTramosCondiciones), `condiciones_cancelacion` del resumen para la
// persona afiliada, su titular y el staff (los nombres sólo al staff), la
// constancia PDF opcional y la constancia firmada opcional (tipos, tamaño,
// bytes, tope, borrado lógico y permisos).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const express = require("express");
const jwt = require("jsonwebtoken");
const { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

process.env.JWT_SECRET = "reserva-condiciones-test-secret";

const {
  REGLAS_INICIALES, calcularTramosCondiciones, obtenerCondicionesReserva,
} = require("../api/services/politica-cancelacion");
const { datosConstanciaCondiciones, generarConstanciaCondiciones } = require("../api/services/reserva-condiciones-constancia");

const POLITICA = { id: 1, version: 1, titulo: "Política de hospedajes", reglas: REGLAS_INICIALES, motivo: "interno", creada_por: 9, autor_nombre: "Admin" };
const PNG = fs.readFileSync(path.join(__dirname, "..", "api", "assets", "ajb-logo.png"));
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PDF = Buffer.from("%PDF-1.7\n%constancia firmada\n");

// ---------------------------------------------------------------------------
// calcularTramosCondiciones
// ---------------------------------------------------------------------------

test("tramos con fechas reales: el ejemplo de ingreso 10/01/2027", () => {
  const tramos = calcularTramosCondiciones({ reglas: REGLAS_INICIALES, fechaCheckin: "2027-01-10", hoy: "2026-12-31" });
  assert.deepEqual(tramos.map(({ dias_desde, dias_hasta, desde_fecha, hasta_fecha }) => ({ dias_desde, dias_hasta, desde_fecha, hasta_fecha })), [
    { dias_desde: 15, dias_hasta: null, desde_fecha: null, hasta_fecha: "2026-12-26" },
    { dias_desde: 7, dias_hasta: 14, desde_fecha: "2026-12-27", hasta_fecha: "2027-01-03" },
    { dias_desde: 0, dias_hasta: 6, desde_fecha: "2027-01-04", hasta_fecha: "2027-01-10" },
  ]);
  // El 31/12 faltan 10 días: tramo del 50%.
  assert.deepEqual(tramos.map((tramo) => tramo.es_hoy), [false, true, false]);
  assert.deepEqual(tramos.map((tramo) => tramo.ya_paso), [true, false, false]);
  assert.deepEqual(tramos.map((tramo) => tramo.porcentaje_reintegro), [100, 50, 0]);
});

test("tramos: bordes de cada tramo, día de ingreso, reserva cerrada, reglas desordenadas y sin devoluciones", () => {
  const hoyEn = (hoy) => calcularTramosCondiciones({ reglas: REGLAS_INICIALES, fechaCheckin: "2027-01-10", hoy }).map((tramo) => tramo.es_hoy);
  assert.deepEqual(hoyEn("2026-12-26"), [true, false, false], "15 días antes");
  assert.deepEqual(hoyEn("2026-12-27"), [false, true, false], "14 días antes");
  assert.deepEqual(hoyEn("2027-01-03"), [false, true, false], "7 días antes");
  assert.deepEqual(hoyEn("2027-01-04"), [false, false, true], "6 días antes");
  assert.deepEqual(hoyEn("2027-01-10"), [false, false, true], "el día de ingreso");
  assert.deepEqual(hoyEn("2027-01-11"), [false, false, false], "ya pasó el ingreso");
  assert.deepEqual(calcularTramosCondiciones({ reglas: REGLAS_INICIALES, fechaCheckin: "2027-01-10", hoy: "2026-12-31", activa: false })
    .map((tramo) => tramo.es_hoy), [false, false, false]);
  const desordenadas = calcularTramosCondiciones({ reglas: [...REGLAS_INICIALES].reverse(), fechaCheckin: "2027-01-10", hoy: "2026-12-31" });
  assert.deepEqual(desordenadas.map((tramo) => tramo.dias_desde), [15, 7, 0]);
  const unico = calcularTramosCondiciones({ reglas: [{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro: 0 }], fechaCheckin: "2027-01-10", hoy: "2026-12-31" });
  assert.equal(unico.length, 1);
  assert.equal(unico[0].desde_fecha, null);
  assert.equal(unico[0].hasta_fecha, "2027-01-10");
  assert.equal(unico[0].es_hoy, true);
  assert.throws(() => calcularTramosCondiciones({ reglas: REGLAS_INICIALES, fechaCheckin: "no", hoy: "2026-12-31" }), { codigo: "FECHA_CHECKIN_INVALIDA" });
  assert.throws(() => calcularTramosCondiciones({ reglas: [], fechaCheckin: "2027-01-10" }), { codigo: "POLITICA_INVALIDA" });
});

// ---------------------------------------------------------------------------
// Base simulada (resumen + rutas de la constancia)
// ---------------------------------------------------------------------------

let usuarioSesionActual = null;
let escenario;
const llamadas = [];
const transacciones = [];

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

const ACEPTACION_TELEFONICA = {
  reserva_id: 41, politica_id: 1, version: 1, snapshot_json: JSON.stringify(POLITICA), aceptada_por: 100,
  aceptada_en: new Date("2026-10-12T13:32:00Z"), modo: "CARGA_ADMINISTRATIVA", canal: "TELEFONO", firma_por: "ADMINISTRATIVO",
  firma_archivo: "firmas/aceptacion41.png", firmada_en: new Date("2026-10-12T13:32:00Z"),
  aceptada_por_nombre_pila: "Graciela", aceptada_por_apellido: "López", aceptada_por_rol: "departamental",
};

function preparar(cambios = {}) {
  llamadas.length = 0;
  transacciones.length = 0;
  escenario = {
    reserva: {
      id: 41, usuario_id: 200, estado: "Verificada", modalidad: "FECHA_LIBRE", fecha_inicio: "2099-01-10", fecha_fin: "2099-01-17",
      fecha_creacion: new Date("2026-10-12T13:30:00Z"), firma_archivo: "firmas/aceptacion41.png", total_tarifa: 480000,
      precio_total: 480000, es_por_salud: 0, convenio_hotel_id: null, tiene_aprobacion_titular: 0, usuario_departamental_id: 7,
      servicio_nombre: "Hotel Solís", recurso_nombre: "Habitación doble", lugar: "Mar del Plata",
      afiliado_nombre: "Marta", afiliado_apellido: "Gómez", afiliado_documento: "30111222", departamental_nombre: "Azul",
      ...(cambios.reserva || {}),
    },
    carga: cambios.carga === undefined
      ? { creado_por_usuario_id: 100, nombre: "Graciela", apellido: "López", departamental_id: 7, rol: "departamental", departamental_nombre: "Azul" }
      : cambios.carga,
    aceptacion: cambios.aceptacion === undefined ? ACEPTACION_TELEFONICA : cambios.aceptacion,
    solicitud: cambios.solicitud || null,
    cancelacion: cambios.cancelacion || null,
    titularDe: cambios.titularDe || null,
    archivos: cambios.archivos || [],
    vigentes: cambios.vigentes ?? (cambios.archivos || []).length,
    vigentesTrasBloqueo: cambios.vigentesTrasBloqueo,
    falloInsert: Boolean(cambios.falloInsert),
    aceptadaParaSubida: cambios.aceptadaParaSubida ?? 1,
    enviadaParaSubida: cambios.enviadaParaSubida ?? 0,
    archivoABorrar: cambios.archivoABorrar === undefined
      ? { id: 9, nombre_original: "constancia.jpg", subido_por_usuario_id: 100 }
      : cambios.archivoABorrar,
    inserciones: [],
    historial: [],
    bajas: [],
    s3: { subidos: [], borrados: [], leidos: [] },
  };
}

function responder(sql, params) {
  // Resumen
  if (/r\.numero_parcela[\s\S]+FROM reserva r[\s\S]+WHERE r\.id = \?/.test(sql)) return [[{ ...escenario.reserva }]];
  if (/SELECT decision FROM reserva_aprobacion_titular/.test(sql)) {
    return [escenario.titularDe === params[1] ? [{ decision: "PENDIENTE" }] : []];
  }
  if (/SELECT id, departamental_id FROM usuario WHERE id IN/.test(sql)) {
    return [[{ id: params[0], departamental_id: usuarioSesionActual.departamental_id }, { id: params[1], departamental_id: 7 }]];
  }
  if (/FROM reserva_familiar rf/.test(sql)) {
    return [/SELECT u\.nombre, u\.apellido FROM reserva_familiar/.test(sql)
      ? [{ nombre: "Marta", apellido: "Gómez" }, { nombre: "Juan", apellido: "Gómez" }]
      : []];
  }
  if (/FROM reserva_adicional\s+WHERE reserva_id/.test(sql)) return [[]];
  if (/FROM reserva_descuento rd/.test(sql)) return [[]];
  if (/FROM reserva_observacion o/.test(sql)) return [[]];
  // Condiciones
  if (/FROM reserva_cancelacion_politica rcp/.test(sql)) return [escenario.cancelacion ? [escenario.cancelacion] : []];
  if (/SELECT r\.creado_por_usuario_id/.test(sql)) return [[escenario.carga || { creado_por_usuario_id: null }]];
  if (/FROM reserva_politica_cancelacion rpc/.test(sql)) return [escenario.aceptacion ? [escenario.aceptacion] : []];
  if (/FROM reserva_firma_afiliado f/.test(sql)) return [escenario.solicitud ? [escenario.solicitud] : []];
  if (/MAX\(fecha_modificacion\) AS ultima/.test(sql)) return [[{ ultima: new Date("2026-10-14T15:00:00Z") }]];
  if (/FROM reserva_constancia_archivo a/.test(sql)) return [escenario.archivos];
  if (/FROM reserva_politica_cancelacion_historica/.test(sql)) return [[]];
  if (/FROM politica_cancelacion p/.test(sql)) return [[{ ...POLITICA, reglas_json: POLITICA.reglas, servicio_id: 3 }]];
  // Rutas de la constancia
  if (/rpc\.firma_archivo AS aceptacion_firma_archivo/.test(sql)) {
    return [[{ ...escenario.reserva, aceptacion_firma_archivo: escenario.aceptacion?.firma_archivo || null }]];
  }
  if (/SELECT nombre, apellido FROM usuario WHERE id = \? LIMIT 1/.test(sql)) return [[{ nombre: "Rosa", apellido: "Díaz" }]];
  if (/AS aceptada,\s+EXISTS/.test(sql)) return [[{ aceptada: escenario.aceptadaParaSubida, enviada_a_firmar: escenario.enviadaParaSubida }]];
  if (/SELECT COUNT\(\*\) AS total FROM reserva_constancia_archivo/.test(sql)) {
    const bloqueada = transacciones.includes("begin") && escenario.vigentesTrasBloqueo !== undefined;
    return [[{ total: bloqueada ? escenario.vigentesTrasBloqueo : escenario.vigentes }]];
  }
  if (/SELECT id FROM reserva WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: params[0] }]];
  if (/INSERT INTO reserva_constancia_archivo/.test(sql)) {
    if (escenario.falloInsert) throw new Error("falla de base");
    escenario.inserciones.push(params);
    return [{ insertId: 70 + escenario.inserciones.length }];
  }
  if (/SELECT id, nombre_original, subido_por_usuario_id FROM reserva_constancia_archivo/.test(sql)) {
    return [escenario.archivoABorrar ? [escenario.archivoABorrar] : []];
  }
  if (/UPDATE reserva_constancia_archivo\s+SET eliminado = 1/.test(sql)) {
    escenario.bajas.push({ sql, params });
    return [{ affectedRows: 1 }];
  }
  if (/INSERT INTO historial_reserva/.test(sql)) {
    escenario.historial.push(params);
    return [{ insertId: 1 }];
  }
  // El resumen puede sumar lecturas de otros módulos: se responden vacías.
  if (/^\s*SELECT/i.test(sql)) return [[]];
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

const routerCondiciones = require("../api/routes/reserva-condiciones");
routerCondiciones.__test.s3.send = async (comando) => {
  if (comando instanceof PutObjectCommand) {
    escenario.s3.subidos.push(comando.input.Key);
    return {};
  }
  if (comando instanceof DeleteObjectCommand) {
    escenario.s3.borrados.push(comando.input.Key);
    return {};
  }
  if (comando instanceof GetObjectCommand) {
    escenario.s3.leidos.push(comando.input.Key);
    return { Body: PNG };
  }
  throw new Error(`Comando de S3 no previsto: ${comando.constructor.name}`);
};

const app = express();
app.use(express.json());
app.use("/api", routerCondiciones);
app.use("/api", require("../api/routes/user"));

const consoleOriginal = { log: console.log, error: console.error };
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
  console.log = consoleOriginal.log;
  console.error = consoleOriginal.error;
  await new Promise((resolve) => server.close(resolve));
});

function sesion(claims) {
  const rolIds = { admin: 1, departamental: 2, afiliado: 3 };
  const completos = { area_turismo: 1, departamental_id: null, ...claims };
  usuarioSesionActual = {
    id: completos.id, rol_id: rolIds[completos.rol] || 99, rol: completos.rol, departamental_id: completos.departamental_id,
    habilitado: "Y", area_turismo: completos.area_turismo, area_coseguro: 0,
    modulo_turismo: 1, modulo_coseguro: 0, modulo_olimpiadas: 1,
  };
  return jwt.sign({ data: JSON.stringify(completos) }, process.env.JWT_SECRET);
}

const DEPARTAMENTAL = { id: 100, rol: "departamental", departamental_id: 7 };
const OTRA_DEPARTAMENTAL = { id: 101, rol: "departamental", departamental_id: 9 };
const COLEGA = { id: 102, rol: "departamental", departamental_id: 7 };
const ADMIN = { id: 1, rol: "admin" };
const ADMIN_CENTRAL = { id: 5, rol: "admin-central" };
const DUENIO = { id: 200, rol: "afiliado", departamental_id: 7 };
const TITULAR = { id: 150, rol: "afiliado", departamental_id: 7 };

async function pedir(ruta, { claims, method = "GET", body, form } = {}) {
  const token = sesion(claims);
  const response = await fetch(`${base}${ruta}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const esJson = response.headers.get("content-type")?.includes("json");
  return { status: response.status, headers: response.headers, buffer, body: esJson && buffer.length ? JSON.parse(buffer.toString()) : null };
}

// ---------------------------------------------------------------------------
// Resumen: condiciones_cancelacion y es_propietario
// ---------------------------------------------------------------------------

test("staff: condiciones con fechas, cómo se aceptaron, quién cargó y firmó, y la constancia con autores", async () => {
  preparar({
    reserva: { firma_archivo: "firmas/edicion41.png" },
    archivos: [
      { id: 9, archivo: "turismo/constancias/a.jpg", nombre_original: "constancia.jpg", mime: "image/jpeg", tamanio: 2048,
        subido_por_usuario_id: 100, fecha_creacion: new Date("2026-10-12T14:00:00Z"), subido_por_nombre_pila: "Graciela", subido_por_apellido: "López" },
      { id: 10, archivo: "turismo/constancias/b.pdf", nombre_original: "dorso.pdf", mime: "application/pdf", tamanio: 4096,
        subido_por_usuario_id: 102, fecha_creacion: new Date("2026-10-12T14:05:00Z"), subido_por_nombre_pila: "Rosa", subido_por_apellido: "Díaz" },
    ],
  });
  const { status, body } = await pedir("/reserva/41/resumen", { claims: DEPARTAMENTAL });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.es_propietario, false);
  assert.equal(body.puede_cancelar_a_pedido, true);
  assert.equal(body.puede_rechazar, true, "Verificada cargada por su departamental: la puede rechazar");
  const condiciones = body.condiciones_cancelacion;
  assert.equal(condiciones.origen, "ACEPTADA");
  assert.deepEqual(condiciones.politica, { id: 1, version: 1, titulo: "Política de hospedajes", reglas: REGLAS_INICIALES });
  assert.equal(condiciones.sin_devoluciones, false);
  assert.equal(condiciones.fecha_checkin, "2099-01-10");
  assert.deepEqual(condiciones.tramos.map((tramo) => [tramo.desde_fecha, tramo.hasta_fecha, tramo.es_hoy]), [
    [null, "2098-12-26", true], ["2098-12-27", "2099-01-03", false], ["2099-01-04", "2099-01-10", false],
  ]);
  assert.deepEqual(condiciones.aceptacion, {
    aceptada_en: "2026-10-12T13:32:00.000Z", modo: "CARGA_ADMINISTRATIVA", canal: "TELEFONO",
    aceptada_por_rol: "departamental", aceptada_por_nombre: "Graciela López",
  });
  assert.equal(condiciones.firma.firmante, "ADMINISTRATIVO");
  assert.equal(condiciones.firma.firmante_nombre, "Graciela López");
  assert.equal(condiciones.firma.firmada_en, "2026-10-12T13:32:00.000Z");
  assert.equal(condiciones.firma.re_firmada_en, "2026-10-14T15:00:00.000Z", "una edición tomó otra firma después");
  assert.ok("url" in condiciones.firma);
  assert.deepEqual(condiciones.carga, {
    rol: "departamental", fecha: "2026-10-12T13:30:00.000Z", nombre: "Graciela López", departamental_nombre: "Azul",
  });
  assert.equal(condiciones.solicitud_firma, null);
  assert.equal(condiciones.constancia.puede_imprimir, true);
  assert.equal(condiciones.constancia.puede_adjuntar, true);
  assert.equal(condiciones.constancia.maximo_archivos, 5);
  assert.deepEqual(condiciones.constancia.archivos.map((archivo) => [archivo.id, archivo.subido_por_nombre, archivo.puede_quitar]), [
    [9, "Graciela López", true], [10, "Rosa Díaz", false],
  ]);
  assert.ok(!llamadas.some(({ sql }) => /FROM politica_cancelacion p/.test(sql)), "con aceptación no busca la histórica");
});

test("persona afiliada: las mismas condiciones, con roles y sin nombres del staff", async () => {
  preparar({
    archivos: [{ id: 9, archivo: "turismo/constancias/a.jpg", nombre_original: "constancia.jpg", mime: "image/jpeg", tamanio: 2048,
      subido_por_usuario_id: 100, fecha_creacion: new Date("2026-10-12T14:00:00Z"), subido_por_nombre_pila: "Graciela", subido_por_apellido: "López" }],
  });
  const { status, body } = await pedir("/reserva/41/resumen", { claims: DUENIO });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.es_propietario, true);
  assert.equal(body.puede_cancelar_a_pedido, false);
  assert.equal(body.puede_rechazar, false);
  const condiciones = body.condiciones_cancelacion;
  assert.ok(!/Graciela|López/.test(JSON.stringify(condiciones)), "ningún nombre del staff");
  // Quién registró la aceptación, sólo por su rol (sin nombre).
  assert.deepEqual(condiciones.aceptacion, {
    aceptada_en: "2026-10-12T13:32:00.000Z", modo: "CARGA_ADMINISTRATIVA", canal: "TELEFONO", aceptada_por_rol: "departamental",
  });
  assert.equal(condiciones.firma.firmante, "ADMINISTRATIVO");
  assert.equal("firmante_nombre" in condiciones.firma, false);
  assert.deepEqual(condiciones.carga, { rol: "departamental", fecha: "2026-10-12T13:30:00.000Z" });
  assert.equal(condiciones.constancia.puede_imprimir, false);
  assert.equal(condiciones.constancia.puede_adjuntar, false);
  assert.deepEqual(Object.keys(condiciones.constancia.archivos[0]).sort(), ["fecha_creacion", "id", "mime", "nombre_original", "tamanio", "url"]);
});

test("reserva enviada a firmar: sólo la persona afiliada dueña puede firmar; el titular ve, el staff ve quién la envió", async () => {
  const solicitud = {
    reserva_id: 41, afiliado_usuario_id: 200, solicitada_por_usuario_id: 100, estado_destino: "Verificada", decision: "PENDIENTE",
    fecha_solicitud: new Date("2026-10-22T13:00:00Z"), vence_en: new Date(Date.now() + 3600 * 1000), fecha_respuesta: null,
    motivo: null, avisos_enviados: 2, ultimo_aviso_en: new Date("2026-10-22T15:00:00Z"),
    politica_id: 1, politica_version: 1, politica_snapshot_json: JSON.stringify(POLITICA),
    solicitada_por_nombre_pila: "Graciela", solicitada_por_apellido: "López",
  };
  const escenarioFirma = { reserva: { estado: "Pendiente de firma", firma_archivo: null }, aceptacion: null, solicitud, titularDe: 150 };

  preparar(escenarioFirma);
  let { body } = await pedir("/reserva/41/resumen", { claims: DUENIO });
  assert.equal(body.condiciones_cancelacion.origen, "PENDIENTE_FIRMA");
  assert.equal(body.condiciones_cancelacion.solicitud_firma.puede_firmar, true);
  assert.equal(body.condiciones_cancelacion.solicitud_firma.estado, "PENDIENTE");
  assert.equal(body.condiciones_cancelacion.solicitud_firma.estado_destino, "Verificada");
  assert.equal(body.condiciones_cancelacion.solicitud_firma.solicitada_por_nombre, undefined);
  assert.equal(body.condiciones_cancelacion.aceptacion, null);
  assert.equal(body.condiciones_cancelacion.firma, null);
  assert.equal(body.puede_cancelar, false, "la persona afiliada no cancela un 15 desde «Cancelar»");

  preparar(escenarioFirma);
  ({ body } = await pedir("/reserva/41/resumen", { claims: TITULAR }));
  assert.equal(body.es_propietario, false);
  assert.equal(body.condiciones_cancelacion.solicitud_firma.puede_firmar, false);
  assert.ok(!/Graciela|López/.test(JSON.stringify(body.condiciones_cancelacion)));

  preparar(escenarioFirma);
  ({ body } = await pedir("/reserva/41/resumen", { claims: DEPARTAMENTAL }));
  const solicitudStaff = body.condiciones_cancelacion.solicitud_firma;
  assert.equal(solicitudStaff.puede_firmar, false);
  assert.equal(solicitudStaff.solicitada_por_nombre, "Graciela López");
  assert.equal(solicitudStaff.avisos_enviados, 2);
  assert.equal(body.condiciones_cancelacion.constancia.puede_imprimir, false, "sin condiciones aceptadas no hay constancia");
  assert.equal(body.condiciones_cancelacion.constancia.puede_adjuntar, false);
  assert.equal(body.puede_cancelar_a_pedido, true);

  // Vencida: ya no se puede firmar aunque la decisión siga PENDIENTE hasta que corra el mantenimiento.
  preparar({ ...escenarioFirma, solicitud: { ...solicitud, vence_en: new Date(Date.now() - 1000) } });
  ({ body } = await pedir("/reserva/41/resumen", { claims: DUENIO }));
  assert.equal(body.condiciones_cancelacion.solicitud_firma.puede_firmar, false);
});

test("reserva cancelada a pedido: «Cancelada por» con nombre sólo para el staff y condiciones sin consulta histórica", async () => {
  const cancelacion = {
    cancelada_en: new Date("2099-01-01T12:00:00Z"), fecha_calculo_civil: "2099-01-01", fecha_checkin_civil: "2099-01-10", dias_previos: 9,
    porcentaje_reintegro: 50, monto_base: 480000, monto_reintegro: 240000, tipo_base: "TOTAL_RESERVA",
    snapshot_json: { politica: POLITICA, origen_politica: "HISTORICA_RESERVA_ANTERIOR" },
    origen: "STAFF_A_PEDIDO", canal: "TELEFONO", cancelada_por_rol: "departamental", motivo: "Se enfermó", regla: "POLITICA",
    cancelada_por_nombre_pila: "Graciela", cancelada_por_apellido: "López",
  };
  for (const [claims, conNombre] of [[DEPARTAMENTAL, true], [DUENIO, false]]) {
    preparar({ reserva: { estado: "Cancelada", firma_archivo: null }, aceptacion: null, carga: null, cancelacion });
    const { status, body } = await pedir("/reserva/41/resumen", { claims });
    assert.equal(status, 200);
    assert.equal(body.cancelacion.origen, "STAFF_A_PEDIDO");
    assert.equal(body.cancelacion.canal, "TELEFONO");
    assert.equal(body.cancelacion.cancelada_por_rol, "departamental");
    assert.equal(body.cancelacion.cancelada_por_nombre, conNombre ? "Graciela López" : undefined);
    assert.equal(body.condiciones_cancelacion.origen, "HISTORICA_RESERVA_ANTERIOR");
    assert.equal(body.condiciones_cancelacion.carga, null);
    assert.ok(body.condiciones_cancelacion.tramos.every((tramo) => !tramo.es_hoy), "una reserva cerrada no marca el tramo de hoy");
    assert.equal(body.condiciones_cancelacion.constancia.puede_imprimir, false);
    assert.equal(body.condiciones_cancelacion.constancia.puede_adjuntar, conNombre, "la constancia firmada se puede adjuntar aunque esté cerrada");
    assert.equal(body.puede_cancelar_a_pedido, false);
    assert.ok(!llamadas.some(({ sql }) => /FROM politica_cancelacion p/.test(sql)));
  }
});

test("condiciones: reserva vieja sin aceptación usa la histórica y sin política devuelve null", async () => {
  const base = { reserva: { id: 41, usuario_id: 200, estado: "Iniciada", fecha_inicio: "2099-01-10", firma_archivo: "firmas/vieja.png" } };
  const consultas = [];
  let historica = [{ ...POLITICA, reglas_json: POLITICA.reglas, servicio_id: 3 }];
  const db = { query: async (sql) => {
    consultas.push(sql);
    if (/FROM reserva_politica_cancelacion rpc|FROM reserva_firma_afiliado f|FROM reserva_cancelacion_politica rcp|historica|reserva_constancia_archivo/.test(sql)) return [[]];
    if (/FROM politica_cancelacion p/.test(sql)) return [historica];
    throw new Error(`Consulta inesperada: ${sql}`);
  } };
  const condiciones = await obtenerCondicionesReserva(db, { ...base, rol: "afiliado", usuarioId: 200, firmarArchivo: async (clave) => `https://s3/${clave}` });
  assert.equal(condiciones.origen, "HISTORICA_RESERVA_ANTERIOR");
  assert.equal(condiciones.politica.motivo, undefined);
  assert.deepEqual(condiciones.firma, { url: "https://s3/firmas/vieja.png", firmante: null, firmada_en: null, re_firmada_en: null });
  assert.equal(condiciones.carga, null);
  historica = [];
  assert.equal(await obtenerCondicionesReserva(db, { ...base, rol: "admin", usuarioId: 1 }), null);
});

// ---------------------------------------------------------------------------
// Constancia PDF
// ---------------------------------------------------------------------------

function extraerTextoPdf(buffer) {
  const fuente = buffer.toString("latin1");
  const partes = [];
  for (const [, diccionario, contenido] of fuente.matchAll(/(<<[\s\S]*?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (!/\/Length/.test(diccionario)) continue;
    let stream = Buffer.from(contenido, "latin1");
    if (/\/FlateDecode/.test(diccionario)) {
      try {
        stream = zlib.inflateSync(stream);
      } catch (_) {
        continue;
      }
    }
    const comandos = stream.toString("latin1");
    if (!/\bBT\b/.test(comandos)) continue;
    partes.push([...comandos.matchAll(/<([a-f\d]+)>/gi)].map(([, hex]) => Buffer.from(hex, "hex").toString("latin1")).join(""));
  }
  return partes.join(" ");
}

function cantidadImagenes(buffer) {
  return (buffer.toString("latin1").match(/\/Subtype \/Image/g) || []).length;
}

test("constancia PDF: A4 con datos, condiciones con fechas, declaración y la firma en el recuadro de quien firmó", async () => {
  preparar();
  const resultado = await pedir("/reserva/41/condiciones/constancia", { claims: DEPARTAMENTAL });
  assert.equal(resultado.status, 200, resultado.buffer.toString());
  assert.equal(resultado.headers.get("content-type"), "application/pdf");
  assert.equal(resultado.headers.get("content-disposition"), 'inline; filename="constancia_condiciones_T-41.pdf"');
  assert.equal(resultado.headers.get("cache-control"), "private, no-store");
  assert.equal(resultado.buffer.subarray(0, 5).toString(), "%PDF-");
  assert.match(resultado.buffer.toString("latin1"), /\/MediaBox \[0 0 595\.28 841\.89\]/);
  const contenido = extraerTextoPdf(resultado.buffer);
  for (const dato of [
    "ASOCIACION JUDICIAL BONAERENSE", "CONSTANCIA DE CONDICIONES DE CANCELACIÓN", "Reserva T-41",
    "GÓMEZ, Marta · DNI 30111222", "Azul", "Hotel Solís · Habitación doble", "Mar del Plata",
    "del 10/01/2099 al 17/01/2099 (7 noches)", "Marta Gómez, Juan Gómez", "480.000,00",
    "Graciela López (Departamental Azul) el 12/10/2026", "Política de hospedajes · versión 1",
    "Hasta el 26/12/2098", "Del 27/12/2098 al 03/01/2099", "Desde el 04/01/2099", "100%", "50%", "Sin reintegro",
    "15 días o más antes del ingreso", "De 7 a 14 días antes del ingreso", "Menos de 7 días antes del ingreso",
    "Me informaron estas condiciones de cancelación y estoy de acuerdo.",
    "Firma de la persona afiliada", "Firma y sello de quien cargó la reserva", "Aclaración: Graciela López",
    "Firmada en pantalla el 12/10/2026",
  ]) assert.ok(contenido.includes(dato), dato);
  assert.deepEqual(escenario.s3.leidos, ["firmas/aceptacion41.png"]);

  // Sin firma atribuible (reserva vieja): no se imprime ninguna y entrega quien la imprime.
  preparar({ aceptacion: null, carga: null });
  const vieja = await pedir("/reserva/41/condiciones/constancia", { claims: ADMIN_CENTRAL });
  assert.equal(vieja.status, 200);
  // PDFKit guarda cada PNG con transparencia como imagen + máscara: la firma suma las suyas al logo.
  assert.ok(cantidadImagenes(resultado.buffer) > cantidadImagenes(vieja.buffer), "la constancia firmada en pantalla lleva la firma");
  const textoViejo = extraerTextoPdf(vieja.buffer);
  assert.ok(textoViejo.includes("Firma y sello de quien entrega la constancia"));
  assert.ok(textoViejo.includes("Aclaración: Rosa Díaz"));
  assert.ok(!textoViejo.includes("Firmada en pantalla"));
  assert.equal(escenario.s3.leidos.length, 0);

  // Firmó desde Mi AJB lo que le enviaron: la constancia no dice «en pantalla».
  preparar({
    aceptacion: {
      ...ACEPTACION_TELEFONICA, modo: "AFILIADO", canal: "ENVIO", firma_por: "AFILIADO", aceptada_por: 200,
      aceptada_por_nombre_pila: "Marta", aceptada_por_apellido: "Gómez",
    },
  });
  const enviada = await pedir("/reserva/41/condiciones/constancia", { claims: DEPARTAMENTAL });
  assert.equal(enviada.status, 200, enviada.buffer.toString());
  const textoEnviada = extraerTextoPdf(enviada.buffer);
  assert.ok(textoEnviada.includes("Firmada desde Mi AJB el 12/10/2026"), "firma desde Mi AJB");
  assert.ok(!textoEnviada.includes("Firmada en pantalla"));
});

test("constancia PDF: si la firma telefónica la registró otra persona del staff, el recuadro lleva su nombre", async () => {
  // Graciela cargó la reserva y se la envió a firmar; Bruno la firmó después por teléfono.
  preparar({
    aceptacion: { ...ACEPTACION_TELEFONICA, aceptada_por: 300, aceptada_por_nombre_pila: "Bruno", aceptada_por_apellido: "Pérez" },
  });
  const resultado = await pedir("/reserva/41/condiciones/constancia", { claims: DEPARTAMENTAL });
  assert.equal(resultado.status, 200, resultado.buffer.toString());
  const contenido = extraerTextoPdf(resultado.buffer);
  assert.ok(contenido.includes("Firma y sello de quien registró la aceptación"));
  assert.ok(contenido.includes("Aclaración: Bruno Pérez"));
  assert.ok(contenido.includes("Graciela López (Departamental Azul) el 12/10/2026"), "«Cargada por» sigue siendo quien cargó");
  assert.ok(!contenido.includes("Aclaración: Graciela López"));
  assert.ok(!contenido.includes("Firma y sello de quien cargó la reserva"));
});

test("constancia PDF: permisos por rol y jurisdicción; nada que imprimir sin condiciones aceptadas o con la reserva cerrada", async () => {
  for (const claims of [DUENIO, TITULAR, { id: 7, rol: "auditor" }, { ...DEPARTAMENTAL, area_turismo: 0 }]) {
    preparar();
    const respuesta = await pedir("/reserva/41/condiciones/constancia", { claims });
    assert.equal(respuesta.status, 403, claims.rol);
    assert.ok(llamadas.every(({ sql }) => esConsultaAutorizacion(sql)), "rechaza antes de leer la reserva");
  }
  preparar();
  let respuesta = await pedir("/reserva/41/condiciones/constancia", { claims: OTRA_DEPARTAMENTAL });
  assert.equal(respuesta.status, 403);
  assert.equal(respuesta.body.codigo, "RESERVA_OTRA_DEPARTAMENTAL");
  for (const claims of [ADMIN, ADMIN_CENTRAL, COLEGA]) {
    preparar();
    assert.equal((await pedir("/reserva/41/condiciones/constancia", { claims })).status, 200, claims.rol);
  }
  preparar({
    reserva: { estado: "Pendiente de firma" }, aceptacion: null,
    solicitud: { decision: "PENDIENTE", estado_destino: "Iniciada", vence_en: new Date(Date.now() + 3600000), politica_id: 1, politica_version: 1, politica_snapshot_json: POLITICA },
  });
  respuesta = await pedir("/reserva/41/condiciones/constancia", { claims: DEPARTAMENTAL });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "CONDICIONES_SIN_ACEPTAR");
  preparar({ reserva: { estado: "Rechazada" } });
  respuesta = await pedir("/reserva/41/condiciones/constancia", { claims: DEPARTAMENTAL });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "RESERVA_CERRADA");
});

test("constancia PDF: sorteo, convenio a cotizar y política sin devoluciones", async () => {
  const condiciones = {
    politica: { titulo: "Convenios", version: 2 }, sin_devoluciones: true, carga: null,
    tramos: calcularTramosCondiciones({ reglas: [{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro: 0 }], fechaCheckin: "2099-01-10", hoy: "2098-12-01" }),
  };
  const datos = datosConstanciaCondiciones({
    reserva: { id: 8, modalidad: "CONVENIO", fecha_inicio: "2099-01-10", fecha_fin: "2099-01-11", precio_total: 0, convenio_nombre: "Hotel del Lago", sorteo_nombre: "" },
    condiciones,
    entregadaPor: "Rosa Díaz",
  });
  assert.deepEqual(datos.filas.find(([rotulo]) => rotulo === "Total de la reserva"), ["Total de la reserva", "A cotizar"]);
  assert.deepEqual(datos.filas.find(([rotulo]) => rotulo === "Alojamiento"), ["Alojamiento", "Hotel del Lago"]);
  assert.equal(datos.filas.find(([rotulo]) => rotulo === "Estadía")[1], "del 10/01/2099 al 11/01/2099 (1 noche)");
  assert.deepEqual(datos.tramos, [{ cuando: "En cualquier momento", anticipacion: "", reintegro: "Sin reintegro" }]);
  assert.equal(datos.sinDevoluciones, true);
  assert.deepEqual(datos.recuadroStaff, { titulo: "Firma y sello de quien entrega la constancia", aclaracion: "Rosa Díaz" });
  const pdf = await generarConstanciaCondiciones({
    reserva: { id: 9, modalidad: "SORTEO", fecha_inicio: "2099-01-10", fecha_fin: "2099-01-17", precio_total: 1000, sorteo_nombre: "Verano 2099" },
    condiciones: { ...condiciones, sin_devoluciones: false, tramos: calcularTramosCondiciones({ reglas: REGLAS_INICIALES, fechaCheckin: "2099-01-10", hoy: "2098-12-01" }) },
    entregadaPor: "Rosa Díaz",
    firma: { imagen: Buffer.from("no es una imagen"), firmante: "AFILIADO", firmada_en: new Date("2026-10-12T13:00:00Z") },
  });
  const contenido = extraerTextoPdf(pdf);
  assert.ok(contenido.includes("Se aplican si se adjudica el lugar."));
  assert.ok(contenido.includes("Sorteo: Verano 2099"));
  assert.ok(contenido.includes("Firmada en pantalla el 12/10/2026"), "una imagen ilegible no impide imprimir");
});

// ---------------------------------------------------------------------------
// Constancia firmada (opcional)
// ---------------------------------------------------------------------------

function formulario(archivos) {
  const form = new FormData();
  for (const { contenido, tipo, nombre } of archivos) form.append("archivos", new Blob([contenido], { type: tipo }), nombre);
  return form;
}

async function subir(claims, archivos) {
  return pedir("/reserva/41/condiciones/constancia-firmada", { claims, method: "POST", form: formulario(archivos) });
}

test("constancia firmada: sube fotos y PDF, guarda quién y deja historial", async () => {
  preparar({ vigentes: 1 });
  const respuesta = await subir(DEPARTAMENTAL, [
    { contenido: JPG, tipo: "image/jpeg", nombre: "constancia frente.jpg" },
    { contenido: PDF, tipo: "application/pdf", nombre: "dorso.pdf" },
  ]);
  assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.success, true);
  assert.deepEqual(respuesta.body.archivos.map((archivo) => [archivo.id, archivo.nombre_original, archivo.mime, archivo.puede_quitar, archivo.subido_por_nombre]), [
    [71, "constancia frente.jpg", "image/jpeg", true, "Rosa Díaz"], [72, "dorso.pdf", "application/pdf", true, "Rosa Díaz"],
  ]);
  assert.ok(respuesta.body.archivos.every((archivo) => !("key" in archivo)), "no expone la clave de S3");
  assert.equal(escenario.s3.subidos.length, 2);
  assert.ok(escenario.s3.subidos.every((key) => /^turismo\/constancias\/reserva41_\d+_[a-f0-9]{16}\.(jpg|pdf)$/.test(key)));
  assert.deepEqual(escenario.inserciones.map((params) => [params[0], params[2], params[3], params[5]]), [
    [41, "constancia frente.jpg", "image/jpeg", 100], [41, "dorso.pdf", "application/pdf", 100],
  ]);
  assert.deepEqual(escenario.historial[0].slice(0, 4), [41, "1", "3", 100]);
  assert.equal(escenario.historial[0].at(-1), "Se adjuntó la constancia firmada (2 archivos)");
  assert.deepEqual(transacciones, ["begin", "commit"]);
  assert.equal(escenario.s3.borrados.length, 0);
});

test("constancia firmada: tipos, tamaño, bytes y cantidad por vez se controlan antes de subir", async () => {
  const casos = [
    [[{ contenido: Buffer.from("hola"), tipo: "text/plain", nombre: "nota.txt" }], "CONSTANCIA_TIPO_INVALIDO"],
    [[{ contenido: JPG, tipo: "image/png", nombre: "foto.png" }], "CONSTANCIA_CONTENIDO_INVALIDO"],
    [[{ contenido: Buffer.from("no es un pdf de verdad"), tipo: "application/pdf", nombre: "falso.pdf" }], "CONSTANCIA_CONTENIDO_INVALIDO"],
    [[{ contenido: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), tipo: "application/pdf", nombre: "grande.pdf" }], "LIMIT_FILE_SIZE"],
    [Array.from({ length: 4 }, (_, indice) => ({ contenido: JPG, tipo: "image/jpeg", nombre: `hoja${indice}.jpg` })), "LIMIT_FILE_COUNT"],
  ];
  for (const [archivos, codigo] of casos) {
    preparar();
    const respuesta = await subir(DEPARTAMENTAL, archivos);
    assert.equal(respuesta.status, 400, codigo);
    assert.equal(respuesta.body.codigo, codigo);
    assert.equal(escenario.s3.subidos.length, 0, codigo);
    assert.equal(escenario.inserciones.length, 0, codigo);
  }
  preparar();
  const vacia = await pedir("/reserva/41/condiciones/constancia-firmada", { claims: DEPARTAMENTAL, method: "POST", form: new FormData() });
  assert.equal(vacia.status, 400);
  assert.equal(vacia.body.codigo, "CONSTANCIA_REQUERIDA");
});

test("constancia firmada: hasta 5 por reserva (también si dos cargan a la vez) y sin objetos huérfanos", async () => {
  preparar({ vigentes: 4 });
  let respuesta = await subir(DEPARTAMENTAL, [
    { contenido: JPG, tipo: "image/jpeg", nombre: "a.jpg" }, { contenido: JPG, tipo: "image/jpeg", nombre: "b.jpg" },
  ]);
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "CONSTANCIA_MAXIMO");
  assert.equal(escenario.s3.subidos.length, 0, "no sube si ya se sabe que no entra");

  preparar({ vigentes: 3, vigentesTrasBloqueo: 4 });
  respuesta = await subir(DEPARTAMENTAL, [
    { contenido: JPG, tipo: "image/jpeg", nombre: "a.jpg" }, { contenido: JPG, tipo: "image/jpeg", nombre: "b.jpg" },
  ]);
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "CONSTANCIA_MAXIMO");
  assert.deepEqual(escenario.s3.borrados, escenario.s3.subidos, "lo subido se borra si otra carga ganó el lugar");
  assert.deepEqual(transacciones, ["begin", "rollback"]);

  preparar({ falloInsert: true });
  respuesta = await subir(DEPARTAMENTAL, [{ contenido: PDF, tipo: "application/pdf", nombre: "a.pdf" }]);
  assert.equal(respuesta.status, 500);
  assert.equal(escenario.s3.subidos.length, 1);
  assert.deepEqual(escenario.s3.borrados, escenario.s3.subidos);
});

test("constancia firmada: sólo staff de la jurisdicción y con condiciones aceptadas", async () => {
  for (const claims of [DUENIO, { id: 7, rol: "auditor" }]) {
    preparar();
    const respuesta = await subir(claims, [{ contenido: JPG, tipo: "image/jpeg", nombre: "a.jpg" }]);
    assert.equal(respuesta.status, 403, claims.rol);
    assert.equal(respuesta.body.codigo, "CONSTANCIA_NO_AUTORIZADA");
    assert.ok(llamadas.every(({ sql }) => esConsultaAutorizacion(sql)));
  }
  preparar();
  let respuesta = await subir(OTRA_DEPARTAMENTAL, [{ contenido: JPG, tipo: "image/jpeg", nombre: "a.jpg" }]);
  assert.equal(respuesta.status, 403);
  assert.equal(respuesta.body.codigo, "RESERVA_OTRA_DEPARTAMENTAL");
  assert.equal(escenario.s3.subidos.length, 0);

  preparar({ aceptadaParaSubida: 0, enviadaParaSubida: 1 });
  respuesta = await subir(DEPARTAMENTAL, [{ contenido: JPG, tipo: "image/jpeg", nombre: "a.jpg" }]);
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "CONDICIONES_SIN_ACEPTAR");

  for (const claims of [ADMIN, ADMIN_CENTRAL]) {
    preparar();
    assert.equal((await subir(claims, [{ contenido: PNG, tipo: "image/png", nombre: "a.png" }])).status, 201, claims.rol);
  }
});

test("quitar la constancia firmada es un borrado lógico: sólo quien la subió o un admin", async () => {
  preparar({ vigentes: 2 });
  let respuesta = await pedir("/reserva/41/condiciones/constancia-firmada/9", { claims: DEPARTAMENTAL, method: "DELETE" });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.equal(escenario.bajas.length, 1);
  assert.match(escenario.bajas[0].sql, /SET eliminado = 1, eliminado_por_usuario_id = \?, eliminado_en = NOW\(\)/);
  assert.deepEqual(escenario.bajas[0].params, [100, 9, 41]);
  assert.equal(escenario.s3.borrados.length, 0, "el archivo queda en S3: es prueba");
  assert.deepEqual(escenario.historial[0].slice(0, 4), [41, "2", "1", 100]);
  assert.equal(escenario.historial[0].at(-1), "Se quitó «constancia.jpg» de la constancia firmada");

  preparar();
  respuesta = await pedir("/reserva/41/condiciones/constancia-firmada/9", { claims: COLEGA, method: "DELETE" });
  assert.equal(respuesta.status, 403);
  assert.equal(respuesta.body.codigo, "CONSTANCIA_AJENA");
  assert.equal(escenario.bajas.length, 0);
  assert.deepEqual(transacciones, ["begin", "rollback"]);

  preparar();
  assert.equal((await pedir("/reserva/41/condiciones/constancia-firmada/9", { claims: ADMIN, method: "DELETE" })).status, 200);

  for (const claims of [DUENIO, OTRA_DEPARTAMENTAL]) {
    preparar();
    assert.equal((await pedir("/reserva/41/condiciones/constancia-firmada/9", { claims, method: "DELETE" })).status, 403, claims.rol);
    assert.equal(escenario.bajas.length, 0);
  }
  preparar({ archivoABorrar: null });
  respuesta = await pedir("/reserva/41/condiciones/constancia-firmada/9", { claims: ADMIN, method: "DELETE" });
  assert.equal(respuesta.status, 404);
  assert.equal(respuesta.body.codigo, "CONSTANCIA_NO_ENCONTRADA");
});
