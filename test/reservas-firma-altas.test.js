"use strict";

// Carga del staff con «¿Quién firma?» en las tres altas de user.js y la edición
// del staff que no pisa la firma: cada canal, cada error del contrato y lo que se guarda.
// Base de datos y S3 simulados.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { S3Client } = require("@aws-sdk/client-s3");

process.env.JWT_SECRET = "reservas-firma-altas-tests-only";

const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64")}`;
const ESTADOS = { Iniciada: 1, Verificada: 2, Rechazada: 4, Cancelada: 13, "Pendiente de firma": 15, "Solicitud convenio": 9, "Solicitud sorteo": 6 };
const POLITICA_FILA = {
  id: 1, version: 1, titulo: "Cancelación", motivo: "interno", creada_por: 9,
  reglas_json: [{ dias_desde: 0, dias_hasta: 6, porcentaje_reintegro: 0 }, { dias_desde: 7, dias_hasta: null, porcentaje_reintegro: 100 }],
};

let consultas = [];
let transaccion = [];
let usuarioSesion = null;
let manejador = async () => [[]];

const conexion = {
  async beginTransaction() { transaccion.push("begin"); },
  async commit() { transaccion.push("commit"); },
  async rollback() { transaccion.push("rollback"); },
  release() {},
  async query(sql, params = []) {
    consultas.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
    if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql)) {
      return [usuarioSesion ? [usuarioSesion] : []];
    }
    return manejador(String(sql), params);
  },
  async execute(sql, params = []) { return conexion.query(sql, params); },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true,
  exports: { promise: () => ({ getConnection: async () => conexion, query: conexion.query, execute: conexion.execute }) },
};

const subidasS3 = [];
S3Client.prototype.send = async (comando) => {
  subidasS3.push(comando.input?.Key);
  return {};
};

const userRouter = require("../api/routes/user");
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/api", userRouter);

const consoleLogOriginal = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = consoleLogOriginal; });

function token(claims) {
  const rolIds = { admin: 1, afiliado: 2, departamental: 3 };
  usuarioSesion = {
    id: claims.id, rol_id: rolIds[claims.rol] || 99, rol: claims.rol, departamental_id: claims.departamental_id ?? null,
    habilitado: "Y", area_turismo: 1, area_coseguro: 1, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1,
  };
  return jwt.sign({ data: JSON.stringify(claims) }, process.env.JWT_SECRET);
}

async function pedir(ruta, { method = "POST", claims, body }) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const respuesta = await fetch(`http://127.0.0.1:${server.address().port}/api${ruta}`, {
      method,
      headers: { authorization: `Bearer ${token(claims)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const texto = await respuesta.text();
    return { status: respuesta.status, body: texto ? JSON.parse(texto) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const STAFF = {
  departamental: { id: 100, rol: "departamental", departamental_id: 7 },
  admin: { id: 101, rol: "admin" },
};

function cuerpoAlta(extra = {}) {
  return {
    nombre: "Reserva de prueba", fecha_inicio: "2099-01-10", fecha_fin: "2099-01-13",
    servicio_id: 1, recurso_id: 2, regimen_id: 1, usuario_id: 200,
    personas: [{ id: 200, dni: "12345678" }],
    politica_cancelacion_aceptada: true, politica_cancelacion_id: 1, politica_cancelacion_version: 1,
    ...extra,
  };
}

/**
 * Todo el alta de POST /reserva (fecha libre, sin hold ni descuentos). `firmasPendientes`:
 * filas de reserva_firma_afiliado de la persona.
 */
function responderAlta({ cbu = "2850590940090418135201", firmasPendientes = [], iniciadas = [] } = {}) {
  const guardado = { reservas: [], aceptaciones: [], solicitudes: [], avisos: [], historial: [], estados: [] };
  manejador = async (sql, params) => {
    if (/SELECT u\.id, u\.nombre[\s\S]+FOR UPDATE/i.test(sql)) {
      return [[{ id: 200, nombre: "Ana", apellido: "Afiliada", documento: "12345678", usuario_familiar_id: null, departamental_id: 7,
        habilitado: "Y", rol: "afiliado", modulo_turismo: 1, modulo_coseguro: 1, cbu }]];
    }
    if (/SELECT departamental_id FROM usuario WHERE id = \?/i.test(sql)) return [[{ departamental_id: 7 }]];
    if (/er\.nombre = \? LIMIT 1 FOR UPDATE/.test(sql) && /FROM reserva r/.test(sql)) return [[]];
    if (/SELECT s\.id, s\.tipo_servicio_id[\s\S]+FROM servicio s/i.test(sql)) {
      return [[{ id: 1, tipo_servicio_id: 1, propietario_departamental_id: null, modelo_tarifa: "TEMPORADAS", unidad_cobro: "POR_PERSONA_NOCHE",
        permite_acompanantes: 1, max_personas_reserva: 6, tipo_codigo: "ALOJAMIENTO_RECURSO", nombre: "Hotel Solís" }]];
    }
    if (/SELECT p\.\* FROM politica_cancelacion p/.test(sql)) return [[POLITICA_FILA]];
    if (/^\s*SELECT id FROM estado_reserva WHERE nombre = \? LIMIT 1/i.test(sql)) {
      return [ESTADOS[params[0]] ? [{ id: ESTADOS[params[0]] }] : []];
    }
    if (/SELECT id, nombre FROM estado_reserva WHERE nombre IN \(\?\)/.test(sql)) {
      return [params[0].map((nombre) => ({ id: ESTADOS[nombre], nombre }))];
    }
    if (/FROM reserva_firma_afiliado f\s+INNER JOIN reserva r ON r\.id = f\.reserva_id\s+WHERE f\.afiliado_usuario_id = \?/.test(sql)) {
      return [firmasPendientes];
    }
    if (/SELECT id FROM usuario WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: params[0] }]];
    if (/FROM reserva r\s+WHERE r\.usuario_id = \?\s+AND r\.estado_reserva_id = \?/.test(sql)) return [iniciadas];
    if (/SELECT \? AS estado,\s+COALESCE\(s\.nombre, 'Turismo'\) AS servicio/.test(sql)) return [[{ estado: params[0], servicio: "Hotel", recurso: "Hab" }]];
    if (/SELECT s\.id AS servicio_id, s\.modelo_tarifa[\s\S]+FROM servicio s/i.test(sql)) {
      return [[{ servicio_id: 1, modelo_tarifa: "TEMPORADAS", permite_acompanantes: 1, max_personas_reserva: 6, anticipacion_minima_dias: 0,
        tipo_codigo: "ALOJAMIENTO_RECURSO", recurso_id: 2, cupo_maximo: null, es_recurso_principal: 0 }]];
    }
    if (/SELECT r\.id, r\.servicio_id, s\.modelo_tarifa[\s\S]+FROM recurso r/i.test(sql)) {
      return [[{ id: 2, servicio_id: 1, modelo_tarifa: "TEMPORADAS", unidad_cobro: "POR_PERSONA_NOCHE", propietario_departamental_id: null,
        permite_acompanantes: 1, anticipacion_minima_dias: 0 }]];
    }
    if (/^\s*UPDATE bloque_fecha/i.test(sql)) return [{ affectedRows: 0 }];
    if (/FROM bloque_fecha_recurso bfr[\s\S]+bf\.estado = 'ACTIVO'/i.test(sql)) return [[]];
    if (/SELECT id FROM recurso WHERE id = \? AND servicio_id = \? FOR UPDATE/i.test(sql)) return [[{ id: 2 }]];
    // Reserva temporal (hold) del afiliado que reserva solo.
    if (/FROM turismo_reserva_hold h\s+WHERE h\.token_hash = \?/.test(sql)) {
      const ahora = Date.now();
      return [[{ id: 90, actor_usuario_id: 200, titular_usuario_id: 200, servicio_id: 1, recurso_id: 2, bloque_fecha_id: null,
        modalidad: "FECHA_LIBRE", fecha_inicio: "2099-01-10", fecha_fin: "2099-01-13", numero_parcela: null, estado: "ACTIVO",
        motivo_cierre: null, reserva_id: null, expira_en_ms: ahora + 600000, limite_en_ms: ahora + 900000, servidor_ahora_ms: ahora }]];
    }
    if (/UPDATE turismo_reserva_hold\s+SET (vence_en = GREATEST|estado = 'CONSUMIDO')/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM turismo_reserva_hold/i.test(sql)) return [[]];
    if (/SELECT r\.id[\s\S]+FROM reserva r[\s\S]+FOR UPDATE/i.test(sql)) return [[]];
    if (/SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{ id: 200, usuario_familiar_id: null, departamental_id: 7 }]];
    }
    if (/SELECT id, documento, nombre, apellido, fecha_nacimiento, tipo_persona_id,[\s\S]+FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{ id: 200, documento: "12345678", nombre: "Ana", apellido: "Afiliada", fecha_nacimiento: "1985-06-15",
        tipo_persona_id: 1, parentesco_id: null, telefono: null, email: null }]];
    }
    if (/FROM turismo_tarifa_regla tr[\s\S]+LEFT JOIN tarifa t/i.test(sql)) return [[]];
    if (/FROM tarifa[\s\S]+WHERE recurso_id = \?/i.test(sql)) {
      return [[{ id: 31, precio: 1000, fecha_inicio: "2090-01-01", fecha_fin: "2099-12-31", usa_porcentaje: 0, porcentaje_descuento: 0 }]];
    }
    if (/INSERT INTO reserva \(/i.test(sql)) {
      guardado.reservas.push({ sql, params });
      return [{ insertId: 501 }];
    }
    if (/INSERT INTO reserva_politica_cancelacion/.test(sql)) {
      guardado.aceptaciones.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO historial_reserva/i.test(sql)) {
      guardado.historial.push({ sql, params });
      return [{ insertId: 601 }];
    }
    if (/UPDATE reserva SET estado_reserva_id = \?/i.test(sql)) {
      guardado.estados.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO reserva_firma_afiliado/.test(sql)) {
      guardado.solicitudes.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
    if (/SELECT u\.id\s+FROM usuario u\s+INNER JOIN rol r ON r\.id = u\.rol_id\s+WHERE u\.habilitado = 'Y' AND r\.nombre = 'admin'/i.test(sql)) {
      return [[{ id: 1 }]];
    }
    if (/SELECT r\.id, r\.usuario_id, r\.precio_total, r\.servicio_id/.test(sql)) {
      return [[{ id: 501, usuario_id: 200, precio_total: 3000, servicio_id: 1, recurso_id: 2, bloque_fecha_id: null, modalidad: "FECHA_LIBRE",
        fecha_inicio: "2099-01-10", fecha_fin: "2099-01-13", servicio: "Hotel Solís", recurso: "Hab 4", afiliado_nombre: "Ana",
        afiliado_apellido: "Afiliada", usuario_departamental_id: 7 }]];
    }
    if (/INSERT INTO notificacion/.test(sql)) {
      guardado.avisos.push({ sql, tipo: params[1], usuarioId: params[0], titulo: params[2], mensaje: params[3], payload: JSON.parse(params[4]),
        obligatoria: !/usuario_notificacion_preferencia/.test(sql) });
      return [{ insertId: 1, affectedRows: 1 }];
    }
    if (/INSERT INTO reserva_familiar \(/i.test(sql)) return [{ insertId: 701 }];
    if (/INSERT INTO reserva_familiar_tarifa/i.test(sql)) return [{ insertId: 801 }];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  return guardado;
}

function reiniciar() {
  consultas = [];
  transaccion = [];
  subidasS3.length = 0;
}

async function alta(rol, extra, opciones) {
  reiniciar();
  const guardado = responderAlta(opciones);
  const respuesta = await pedir("/reserva", { claims: STAFF[rol] || rol, body: cuerpoAlta(extra) });
  return { respuesta, guardado };
}

// --- Errores del contrato -----------------------------------------------------------
test("POST /reserva del staff: cada error del contrato, sin insertar nada", async () => {
  const casos = [
    // La pantalla de antes de «¿Quién firma?» no manda el canal, pero sí la firma: no se sube.
    [{}, 400, "PANTALLA_DESACTUALIZADA"],
    [{ firma: PNG }, 400, "PANTALLA_DESACTUALIZADA"],
    [{ politica_cancelacion_canal: "" }, 400, "CANAL_POLITICA_REQUERIDO"],
    [{ politica_cancelacion_canal: "REMOTA" }, 400, "CANAL_POLITICA_REQUERIDO"],
    [{ politica_cancelacion_canal: "PRESENCIAL", firma_por: "ADMINISTRATIVO", firma: PNG }, 400, "FIRMA_POR_INVALIDA"],
    [{ politica_cancelacion_canal: "TELEFONO", firma_por: "AFILIADO", firma: PNG }, 400, "FIRMA_POR_INVALIDA"],
    [{ politica_cancelacion_canal: "PRESENCIAL", firma_por: "AFILIADO" }, 400, "FIRMA_REQUERIDA"],
    [{ politica_cancelacion_canal: "TELEFONO", firma_por: "ADMINISTRATIVO" }, 400, "FIRMA_REQUERIDA"],
  ];
  for (const rol of ["departamental", "admin"]) {
    for (const [extra, status, codigo] of casos) {
      const { respuesta } = await alta(rol, extra);
      assert.equal(respuesta.status, status, `${rol} ${codigo}`);
      assert.equal(respuesta.body.codigo, codigo, `${rol} ${codigo}`);
      if (codigo === "PANTALLA_DESACTUALIZADA") assert.match(respuesta.body.message, /Recargá la página \(F5\)/);
      assert.equal(consultas.some(({ sql }) => /INSERT INTO reserva/.test(sql)), false);
      assert.equal(subidasS3.length, 0);
    }
  }
});

test("el 422 de CBU sale antes que los errores de «¿Quién firma?»", async () => {
  const { respuesta } = await alta("departamental", {}, { cbu: "  " });
  assert.equal(respuesta.status, 422);
  assert.equal(respuesta.body.codigo, "CBU_REQUERIDO");
  // También en convenio y sorteo: el titular se resuelve antes que el envío no disponible.
  for (const [ruta, body] of [
    ["/convenios-hoteleros/3/reservas", { fecha_inicio: "2099-01-10", fecha_fin: "2099-01-13", personas: [{ id: 200 }], usuario_id: 200 }],
    ["/sorteos/4/inscripciones", { bloque_fecha_id: 5, regimen_id: 1, personas: [{ id: 200 }], usuario_id: 200 }],
  ]) {
    reiniciar();
    responderAlta({ cbu: "  " });
    const otra = await pedir(ruta, { claims: STAFF.departamental, body: { ...body, politica_cancelacion_canal: "ENVIO" } });
    assert.equal(otra.status, 422, ruta);
    assert.equal(otra.body.codigo, "CBU_REQUERIDO", ruta);
  }
});

test("envío a firmar: FIRMA_SIN_TIEMPO con el ingreso encima y FIRMA_PENDIENTE_EXISTENTE con otra esperando", async () => {
  // Ingreso hoy: el plazo (fin del día anterior) ya pasó.
  const fecha = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(d);
  const { respuesta } = await alta("departamental", {
    politica_cancelacion_canal: "ENVIO", fecha_inicio: fecha(new Date()), fecha_fin: fecha(new Date(Date.now() + 3 * 24 * 3600 * 1000)),
  });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "FIRMA_SIN_TIEMPO");

  const pendiente = { reserva_id: 40, estado_destino: "Verificada", vence_en: "2099-01-01 10:00:00", vencida: 0, modalidad: "FECHA_LIBRE",
    fecha_inicio: "2099-02-01", fecha_fin: "2099-02-05", fecha_creacion: "2026-10-22 10:00:00" };
  const otra = await alta("departamental", { politica_cancelacion_canal: "ENVIO" }, { firmasPendientes: [pendiente] });
  assert.equal(otra.respuesta.status, 409);
  assert.equal(otra.respuesta.body.codigo, "FIRMA_PENDIENTE_EXISTENTE");
  assert.match(otra.respuesta.body.message, /^Ana Afiliada ya tiene la reserva T-40 esperando su firma/);
  assert.equal(otra.respuesta.body.reserva.id, 40);
  assert.equal(consultas.some(({ sql }) => /INSERT INTO reserva/.test(sql)), false);
});

// --- Cada canal ---------------------------------------------------------------------
test("PRESENCIAL: la firma de la persona en la oficina queda con la aceptación y el aviso lleva las condiciones", async () => {
  const { respuesta, guardado } = await alta("departamental", { politica_cancelacion_canal: "PRESENCIAL", firma_por: "AFILIADO", firma: PNG });
  assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.estado, "Verificada");
  assert.equal(respuesta.body.canal, "PRESENCIAL");
  assert.equal(respuesta.body.requiere_firma_afiliado, false);
  assert.equal(subidasS3.length, 1);
  // Quién cargó la reserva.
  assert.match(guardado.reservas[0].sql, /monto_descuentos, creado_por_usuario_id\s*\)/);
  assert.equal(guardado.reservas[0].params.at(-1), 100);
  // Aceptación: el staff, carga administrativa en la oficina, firma de la persona.
  const [aceptacion] = guardado.aceptaciones;
  assert.deepEqual(aceptacion.params.slice(4), [100, "CARGA_ADMINISTRATIVA", "PRESENCIAL", "AFILIADO", subidasS3[0]]);
  assert.match(aceptacion.sql, /NOW\(\)\)$/);
  // Aviso obligatorio con las condiciones; el de administración, como hoy.
  const aviso = guardado.avisos.find((item) => item.tipo === "RESERVA_CREADA_POR_TURISMO");
  assert.equal(aviso.usuarioId, 200);
  assert.equal(aviso.obligatoria, true);
  assert.match(aviso.mensaje, /^Tu departamental cargó y verificó una reserva a tu nombre \(Hotel Solís, del 10\/01\/2099 al 13\/01\/2099, por \$ 3\.000\) y la firmaste en la oficina con estas condiciones de cancelación: si cancelás con 7 días o más de anticipación, te devolvemos el 100%; con menos de 7 días, no hay devolución\./);
  assert.ok(guardado.avisos.some((item) => item.tipo === "RESERVA_PARA_APROBAR" && item.usuarioId === 1));
  assert.equal(guardado.solicitudes.length, 0);
  assert.ok(transaccion.includes("commit"));
});

test("TELEFONO: firma el administrativo y la persona recibe las condiciones que se le leyeron", async () => {
  const { respuesta, guardado } = await alta("admin", { politica_cancelacion_canal: "TELEFONO", firma_por: "ADMINISTRATIVO", firma: PNG });
  assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.estado, "Iniciada");
  assert.deepEqual(guardado.aceptaciones[0].params.slice(4, 8), [101, "CARGA_ADMINISTRATIVA", "TELEFONO", "ADMINISTRATIVO"]);
  const aviso = guardado.avisos.find((item) => item.tipo === "RESERVA_CREADA_POR_TURISMO");
  assert.equal(aviso.obligatoria, true);
  // «te leyó» va con quien cargó, y el plazo de la departamental después de las condiciones.
  assert.match(aviso.mensaje, /^El equipo de Turismo cargó por teléfono una reserva a tu nombre \([^)]+\) y te leyó estas condiciones de cancelación: .* La departamental tiene 72 horas para verificarla\. Si no estás de acuerdo, avisale a tu departamental cuanto antes\.$/);
});

test("ENVIO (departamental): queda «Pendiente de firma» con destino Verificada, sin aceptación ni pase a Verificada todavía", async () => {
  const { respuesta, guardado } = await alta("departamental", { politica_cancelacion_canal: "ENVIO", firma: PNG });
  assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.estado, "Pendiente de firma");
  assert.equal(respuesta.body.canal, "ENVIO");
  assert.equal(respuesta.body.requiere_firma_afiliado, true);
  assert.equal(respuesta.body.firma_estado_destino, "Verificada");
  assert.match(respuesta.body.firma_vence_en, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.equal(subidasS3.length, 0, "con el envío nadie firma ahora");
  assert.equal(guardado.reservas[0].params[7], null, "sin firma_archivo");
  assert.equal(guardado.aceptaciones.length, 0, "la aceptación se guarda al firmar");
  // Iniciada → 15 (nunca a Verificada en el alta) y la solicitud con la política enviada.
  assert.deepEqual(guardado.estados.map(({ params }) => params[0]), [15]);
  assert.deepEqual(guardado.solicitudes[0].params.slice(0, 6), [501, 200, 100, "Verificada", 1, 1]);
  assert.deepEqual(JSON.parse(guardado.solicitudes[0].params[6]).reglas, POLITICA_FILA.reglas_json);
  // Ni RESERVA_PARA_APROBAR ni RESERVA_CREADA_POR_TURISMO: sólo el aviso obligatorio de la firma.
  assert.deepEqual(guardado.avisos.map((item) => item.tipo), ["RESERVA_FIRMA_PENDIENTE"]);
  assert.equal(guardado.avisos[0].obligatoria, true);
  assert.equal(guardado.avisos[0].titulo, "Firmá tu reserva T-501");
  assert.match(guardado.avisos[0].mensaje, /^Tu departamental cargó a tu nombre la reserva T-501 \(Hotel Solís, del 10\/01\/2099 al 13\/01\/2099, por \$ 3\.000\)\. Para confirmarla, leé las condiciones y firmá desde Mi AJB antes del /);
  // Historial: CREATE en Iniciada y el paso a «Pendiente de firma» con el estado anterior
  // real, con la IP y el navegador del staff.
  const paso = guardado.historial.find(({ params }) => params[1] === "estado_reserva_id" && params[3] === "15");
  assert.equal(paso.params[2], "1");
  assert.equal(paso.params[4], 100);
  assert.ok(transaccion.includes("commit"));
});

test("ENVIO (administración): destino Iniciada y la otra Iniciada de la persona bloquea", async () => {
  const { respuesta, guardado } = await alta("admin", { politica_cancelacion_canal: "ENVIO" });
  assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.firma_estado_destino, "Iniciada");
  assert.equal(guardado.solicitudes[0].params[3], "Iniciada");
  assert.match(guardado.avisos[0].mensaje, /^El equipo de Turismo cargó a tu nombre la reserva T-501/);

  const iniciada = { id: 39, usuario_id: 200, estado_reserva_id: 1, modalidad: "FECHA_LIBRE", fecha_inicio: "2099-03-01", fecha_fin: "2099-03-04", vencida: 0 };
  const conOtra = await alta("admin", { politica_cancelacion_canal: "ENVIO" }, { iniciadas: [iniciada] });
  assert.equal(conOtra.respuesta.status, 409);
  assert.equal(conOtra.respuesta.body.codigo, "RESERVA_INICIADA_EXISTENTE");
});

test("el afiliado que reserva solo no cambia: canal APP, firma propia y una firma pendiente que queda Iniciada bloquea otra Iniciada", async () => {
  const afiliado = { id: 200, rol: "afiliado", departamental_id: 7 };
  const hold = { hold_id: 90, hold_token: "t".repeat(40) };
  const { respuesta, guardado } = await alta(afiliado, { usuario_id: undefined, ...hold, firma: PNG, politica_cancelacion_canal: "ENVIO" });
  assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.canal, "APP");
  assert.deepEqual(guardado.aceptaciones[0].params.slice(4), [200, "AFILIADO", "APP", "AFILIADO", subidasS3[0]]);
  assert.equal(guardado.reservas[0].params.at(-1), 200, "creado_por = la propia persona");
  assert.equal(guardado.avisos.some((item) => item.tipo === "RESERVA_CREADA_POR_TURISMO"), false);

  const sinFirma = await alta(afiliado, { usuario_id: undefined, ...hold });
  assert.equal(sinFirma.respuesta.status, 201);
  assert.deepEqual(sinFirma.guardado.aceptaciones[0].params.slice(4), [200, "AFILIADO", "APP", null, null]);
  assert.match(sinFirma.guardado.aceptaciones[0].sql, /NULL\)$/);

  const pendiente = { reserva_id: 40, estado_destino: "Iniciada", vence_en: "2099-01-01 10:00:00", vencida: 0, modalidad: "FECHA_LIBRE",
    fecha_inicio: "2099-02-01", fecha_fin: "2099-02-05", fecha_creacion: "2026-10-22 10:00:00" };
  const bloqueada = await alta(afiliado, { usuario_id: undefined }, { firmasPendientes: [pendiente] });
  assert.equal(bloqueada.respuesta.status, 409);
  assert.equal(bloqueada.respuesta.body.codigo, "RESERVA_INICIADA_EXISTENTE");
  assert.match(bloqueada.respuesta.body.message, /^Ya tenés la reserva T-40 esperando tu firma/);
  // Nombra el botón tal cual se ve en el detalle (la persona afiliada no tiene «Rechazar»)
  assert.match(bloqueada.respuesta.body.message, /si no la querés, presioná «No la quiero» en esa reserva antes de crear otra\.$/);
  assert.equal(bloqueada.respuesta.body.reserva.estado, "Pendiente de firma");
});

// --- Convenio y sorteo ----------------------------------------------------------------
test("convenio y sorteo: el envío a firmar no está disponible (400 ENVIO_NO_DISPONIBLE)", async () => {
  for (const [ruta, body] of [
    ["/convenios-hoteleros/3/reservas", { fecha_inicio: "2099-01-10", fecha_fin: "2099-01-13", personas: [{ id: 200 }], usuario_id: 200 }],
    ["/sorteos/4/inscripciones", { bloque_fecha_id: 5, regimen_id: 1, personas: [{ id: 200 }], usuario_id: 200 }],
  ]) {
    reiniciar();
    responderAlta();
    const respuesta = await pedir(ruta, { claims: STAFF.departamental, body: { ...body, politica_cancelacion_canal: "ENVIO" } });
    assert.equal(respuesta.status, 400, ruta);
    assert.equal(respuesta.body.codigo, "ENVIO_NO_DISPONIBLE", ruta);
    assert.equal(consultas.some(({ sql }) => /INSERT INTO reserva/.test(sql)), false);
  }
});

// --- Edición ------------------------------------------------------------------------
function responderEdicion({ usuarioId = 200 } = {}) {
  manejador = async (sql) => {
    if (/FROM reserva r[\s\S]+FOR UPDATE/i.test(sql) && /tiene_politica_aceptada/.test(sql)) {
      return [[{ id: 77, usuario_id: usuarioId, usuario_departamental_id: 7, estado_nombre: "Iniciada", modalidad: "FECHA_LIBRE",
        fecha_inicio: "2099-01-10", fecha_fin: "2099-01-13", usuario_cbu: "2850590940090418135201", tiene_aprobacion_titular: 0,
        tiene_politica_aceptada: 1, servicio_original_id: 1, firma_archivo: "firma_del_afiliado.png" }]];
    }
    if (/SELECT departamental_id FROM usuario WHERE id = \? LIMIT 1/.test(sql)) return [[{ departamental_id: 7 }]];
    if (/SELECT s\.id, s\.tipo_servicio_id[\s\S]+FROM servicio s/i.test(sql)) {
      return [[{ id: 1, tipo_servicio_id: 1, modelo_tarifa: "TEMPORADAS", unidad_cobro: "POR_PERSONA_NOCHE", permite_acompanantes: 1,
        max_personas_reserva: 6, tipo_codigo: "ALOJAMIENTO_RECURSO" }]];
    }
    // Lo que sigue (bloques y tarifas) no importa acá: la firma se procesa antes.
    throw new Error("fin de la prueba");
  };
}

test("la edición del staff no pide firma ni pisa la de la persona afiliada; la persona sí puede volver a firmar", async () => {
  for (const claims of [STAFF.departamental, STAFF.admin]) {
    reiniciar();
    responderEdicion();
    await pedir("/reserva/77", { method: "PUT", claims, body: { ...cuerpoAlta(), firma_base64: PNG } });
    assert.equal(subidasS3.length, 0, `${claims.rol}: la firma del staff se ignora`);
    assert.ok(consultas.some(({ sql }) => /SELECT s\.id, s\.tipo_servicio_id/.test(sql)), "llegó a procesar la firma");
  }
  reiniciar();
  responderEdicion({ usuarioId: 200 });
  await pedir("/reserva/77", { method: "PUT", claims: { id: 200, rol: "afiliado", departamental_id: 7 }, body: { ...cuerpoAlta(), firma_base64: PNG } });
  assert.equal(subidasS3.length, 1, "la persona dueña sí vuelve a firmar");
});
