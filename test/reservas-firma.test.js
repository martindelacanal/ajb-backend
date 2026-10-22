"use strict";

// Ciclo de «Pendiente de firma»: envío, firma de la persona afiliada, «No la
// quiero», firma en pantalla del staff, recordatorios, vencimiento (al acceder y en el
// mantenimiento), concurrencia, permisos y una sola reserva esperando firma por persona.
// Base de datos y S3 simulados.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

process.env.JWT_SECRET = "reservas-firma-tests-only";

const ESTADOS = { Iniciada: 1, Verificada: 2, Aprobada: 3, Rechazada: 4, Cancelada: 13, "Pendiente_Aprobacion_Titular": 14, "Pendiente de firma": 15 };
const NOMBRE_ESTADO = Object.fromEntries(Object.entries(ESTADOS).map(([nombre, id]) => [id, nombre]));
const POLITICA = {
  id: 7, version: 3, titulo: "Política general", motivo: "interno", creada_por: 1,
  reglas: [
    { dias_desde: 0, dias_hasta: 6, porcentaje_reintegro: 0 },
    { dias_desde: 7, dias_hasta: 14, porcentaje_reintegro: 50 },
    { dias_desde: 15, dias_hasta: null, porcentaje_reintegro: 100 },
  ],
};
const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64")}`;

function normalizar(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

// --- Base de datos simulada con estado ------------------------------------------
function crearEstado({ destino = "Verificada", decision = "PENDIENTE", estadoReserva = 15, vencida = false,
  avisoReciente = false, avisosEnviados = 1, sinSolicitud = false, cbu = "2850590940090418135201",
  otraIniciada = null, solicitanteRol = "departamental" } = {}) {
  return {
    estados: { ...ESTADOS },
    usuarios: {
      200: { id: 200, nombre: "Marta", apellido: "Gómez", cbu, usuario_familiar_id: null, es_familiar: "N", parentesco_id: 1,
        departamental_id: 7, habilitado: "Y", modulo_turismo: 1, rol: "afiliado", bloqueo_tipo: null },
      300: { id: 300, nombre: "Otra", apellido: "Persona", departamental_id: 7, rol: "afiliado" },
      50: { id: 50, departamental_id: 7, rol: solicitanteRol },
      51: { id: 51, departamental_id: 7, rol: "departamental" },
      60: { id: 60, departamental_id: 8, rol: "departamental" },
      1: { id: 1, departamental_id: null, rol: "admin" },
    },
    staff: [{ id: 1, rol: "admin" }, { id: 2, rol: "admin" }, { id: 50, rol: solicitanteRol }, { id: 51, rol: "departamental" }, { id: 70, rol: "admin-central" }],
    reservas: {
      41: { id: 41, usuario_id: 200, estado_reserva_id: estadoReserva, modalidad: "FECHA_LIBRE", servicio_id: 5, recurso_id: 9,
        bloque_fecha_id: null, precio_total: 480000, firma_archivo: null, fecha_inicio: "2099-01-10", fecha_fin: "2099-01-17",
        fecha_creacion: "2026-10-22 10:00:00" },
    },
    firmas: sinSolicitud ? {} : {
      41: { reserva_id: 41, afiliado_usuario_id: 200, solicitada_por_usuario_id: 50, estado_destino: destino,
        politica_id: POLITICA.id, politica_version: POLITICA.version, politica_snapshot_json: JSON.stringify(POLITICA),
        decision, fecha_solicitud: "2026-10-22 10:05:00", vence_en: "2026-10-25 10:05:00", avisos_enviados: avisosEnviados,
        ultimo_aviso_en: "2026-10-22 10:05:00", motivo: null, respondida_por_usuario_id: null, vencida, avisoReciente },
    },
    otraIniciada,
    aceptaciones: [],
    cancelaciones: [],
    historial: [],
    notificaciones: [],
    leidas: [],
    bloquesLiberados: [],
    transaccion: [],
    consultas: [],
    fallas: {},
  };
}

function crearConexion(estado) {
  const r = (fila) => [[fila].filter(Boolean)];
  return {
    async beginTransaction() { estado.transaccion.push("begin"); },
    async commit() { estado.transaccion.push("commit"); },
    async rollback() { estado.transaccion.push("rollback"); },
    release() { estado.transaccion.push("release"); },
    async query(sqlOriginal, params = []) {
      const sql = normalizar(sqlOriginal);
      estado.consultas.push({ sql, params });
      for (const [patron, error] of Object.entries(estado.fallas)) {
        if (new RegExp(patron).test(sql)) throw error;
      }
      if (/^SELECT GET_LOCK/.test(sql)) return [[{ adquirido: 1 }]];
      if (/^SELECT RELEASE_LOCK/.test(sql)) return [[{ liberado: 1 }]];
      if (/^SELECT id FROM estado_reserva WHERE nombre = \? LIMIT 1$/.test(sql)) {
        return [estado.estados[params[0]] ? [{ id: estado.estados[params[0]] }] : []];
      }
      if (/^SELECT id, nombre FROM estado_reserva WHERE nombre IN \(\?\)$/.test(sql)) {
        return [params[0].filter((nombre) => estado.estados[nombre]).map((nombre) => ({ id: estado.estados[nombre], nombre }))];
      }
      if (/^SELECT r\.id, r\.usuario_id, u\.departamental_id AS usuario_departamental_id, f\.afiliado_usuario_id FROM reserva r/.test(sql)) {
        const reserva = estado.reservas[params[0]];
        if (!reserva) return [[]];
        return r({ id: reserva.id, usuario_id: reserva.usuario_id, usuario_departamental_id: estado.usuarios[reserva.usuario_id].departamental_id,
          afiliado_usuario_id: estado.firmas[reserva.id]?.afiliado_usuario_id ?? null });
      }
      if (/^SELECT departamental_id FROM usuario WHERE id = \? LIMIT 1$/.test(sql)) {
        return r(estado.usuarios[params[0]] ? { departamental_id: estado.usuarios[params[0]].departamental_id } : null);
      }
      if (/^SELECT u\.id, u\.nombre, u\.apellido, u\.cbu, u\.email, u\.usuario_familiar_id, u\.es_familiar, u\.parentesco_id, u\.departamental_id, u\.habilitado, u\.modulo_turismo, r\.nombre AS rol, u\.bloqueo_tipo, u\.bloqueo_modulos, u\.bloqueo_mensaje FROM usuario u INNER JOIN rol r ON r\.id = u\.rol_id WHERE u\.id = \? LIMIT 1 FOR UPDATE$/.test(sql)) {
        return r(estado.usuarios[params[0]]);
      }
      if (/LEFT JOIN reserva_firma_afiliado f ON f\.reserva_id = r\.id WHERE r\.id = \? FOR UPDATE$/.test(sql)) {
        const reserva = estado.reservas[params[0]];
        const firma = estado.firmas[params[0]];
        if (!reserva) return [[]];
        return r({ ...reserva, solicitud_reserva_id: firma ? firma.reserva_id : null, ...(firma || {}),
          vencida: firma?.vencida ? 1 : 0, aviso_reciente: firma?.avisoReciente ? 1 : 0, id: reserva.id });
      }
      // asegurarSinReservaIniciadaAfiliado (reservas-turismo)
      if (/^SELECT id FROM usuario WHERE id = \? FOR UPDATE$/.test(sql)) return r({ id: params[0] });
      if (/FROM reserva r WHERE r\.usuario_id = \? AND r\.estado_reserva_id = \? AND/.test(sql)) {
        return [estado.otraIniciada ? [{ ...estado.otraIniciada, vencida: 0 }] : []];
      }
      if (/^SELECT \? AS estado, COALESCE\(s\.nombre, 'Turismo'\) AS servicio/.test(sql)) {
        return r({ estado: params[0], servicio: "Cabañas", recurso: "Cabaña 2" });
      }
      // Transiciones de la reserva
      let coincidencia = /^UPDATE reserva SET estado_reserva_id = \?, firma_archivo = \?, fecha_modificacion = NOW\(\) WHERE id = \? AND estado_reserva_id = \?$/.exec(sql);
      if (coincidencia) {
        const reserva = estado.reservas[params[2]];
        if (!reserva || reserva.estado_reserva_id !== params[3] || estado.carrera) return [{ affectedRows: 0 }];
        Object.assign(reserva, { estado_reserva_id: params[0], firma_archivo: params[1] });
        return [{ affectedRows: 1 }];
      }
      coincidencia = /^UPDATE reserva SET estado_reserva_id = \?(?:, fecha_modificacion = NOW\(\))? WHERE id = \? AND estado_reserva_id = \?$/.exec(sql);
      if (coincidencia) {
        const reserva = estado.reservas[params[1]];
        if (!reserva || reserva.estado_reserva_id !== params[2] || estado.carrera) return [{ affectedRows: 0 }];
        reserva.estado_reserva_id = params[0];
        return [{ affectedRows: 1 }];
      }
      if (/^INSERT INTO reserva_politica_cancelacion/.test(sql)) {
        estado.aceptaciones.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
      if (/^INSERT INTO reserva_firma_afiliado/.test(sql)) {
        const [reservaId, afiliado, solicitante, destino, politicaId, version, snapshot, vence] = params;
        estado.firmas[reservaId] = { reserva_id: reservaId, afiliado_usuario_id: afiliado, solicitada_por_usuario_id: solicitante,
          estado_destino: destino, politica_id: politicaId, politica_version: version, politica_snapshot_json: snapshot,
          decision: "PENDIENTE", vence_en: vence, avisos_enviados: 1 };
        return [{ affectedRows: 1 }];
      }
      coincidencia = /^UPDATE reserva_firma_afiliado SET decision = '(\w+)'/.exec(sql);
      if (coincidencia) {
        const reservaId = params.at(-1);
        const firma = estado.firmas[reservaId];
        if (!firma || firma.decision !== "PENDIENTE") return [{ affectedRows: 0 }];
        Object.assign(firma, { decision: coincidencia[1], respondida_por_usuario_id: coincidencia[1] === "VENCIDA" ? null : params[0],
          ...(coincidencia[1] === "RECHAZADA" ? { motivo: params[1] } : {}) });
        return [{ affectedRows: 1 }];
      }
      if (/^UPDATE reserva_firma_afiliado SET avisos_enviados = avisos_enviados \+ 1/.test(sql)) {
        const firma = estado.firmas[params[0]];
        if (!firma || firma.decision !== "PENDIENTE" || firma.avisos_enviados !== params[1]) return [{ affectedRows: 0 }];
        firma.avisos_enviados += 1;
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT solicitada_por_usuario_id, afiliado_usuario_id, vence_en FROM reserva_firma_afiliado WHERE reserva_id = \?$/.test(sql)) {
        return r(estado.firmas[params[0]]);
      }
      if (/^SELECT politica_id, politica_version, politica_snapshot_json FROM reserva_firma_afiliado WHERE reserva_id = \? LIMIT 1$/.test(sql)) {
        return r(estado.firmas[params[0]]);
      }
      if (/^INSERT INTO reserva_cancelacion_politica/.test(sql)) {
        estado.cancelaciones.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
      if (/^INSERT INTO historial_reserva/.test(sql)) {
        estado.historial.push({ sql, params });
        return [{ insertId: estado.historial.length }];
      }
      if (/^UPDATE notificacion SET leida = 1/.test(sql)) {
        estado.leidas.push(params);
        return [{ affectedRows: 1 }];
      }
      if (/^INSERT INTO notificacion/.test(sql)) {
        estado.notificaciones.push({ sql, usuarioId: params[0], tipo: params[1], titulo: params[2], mensaje: params[3],
          payload: JSON.parse(params[4]), obligatoria: !/usuario_notificacion_preferencia/.test(sql) });
        return [{ insertId: estado.notificaciones.length, affectedRows: 1 }];
      }
      if (/^SELECT r\.id, r\.usuario_id, r\.precio_total, r\.servicio_id, r\.recurso_id/.test(sql)) {
        const reserva = estado.reservas[params[0]];
        const persona = estado.usuarios[reserva.usuario_id];
        return r({ ...reserva, servicio: "Hotel Solís", recurso: "Habitación 4", afiliado_nombre: persona.nombre,
          afiliado_apellido: persona.apellido, usuario_departamental_id: persona.departamental_id });
      }
      if (/^SELECT u\.id, r\.nombre AS rol FROM usuario u INNER JOIN rol r ON r\.id = u\.rol_id WHERE u\.habilitado = 'Y'/.test(sql)) {
        return [estado.staff];
      }
      if (/^SELECT u\.id FROM usuario u INNER JOIN rol r ON r\.id = u\.rol_id WHERE u\.habilitado = 'Y' AND r\.nombre = 'admin'$/.test(sql)) {
        return [estado.staff.filter((usuario) => usuario.rol === "admin").map(({ id }) => ({ id }))];
      }
      if (/^SELECT r\.nombre AS rol FROM usuario u INNER JOIN rol r ON r\.id = u\.rol_id WHERE u\.id = \? LIMIT 1$/.test(sql)) {
        return r({ rol: estado.usuarios[params[0]]?.rol });
      }
      // liberarRecursoBloque (reservas-turismo)
      if (/FROM bloque_fecha_recurso bfr INNER JOIN bloque_fecha bf/.test(sql)) {
        estado.bloquesLiberados.push(params[0]);
        return [[]];
      }
      // Pendientes de la persona (alta) y mantenimiento
      if (/FROM reserva_firma_afiliado f INNER JOIN reserva r ON r\.id = f\.reserva_id WHERE f\.afiliado_usuario_id = \? AND f\.decision = 'PENDIENTE' AND r\.estado_reserva_id = \?/.test(sql)) {
        return [Object.values(estado.firmas)
          .filter((firma) => firma.afiliado_usuario_id === params[0] && firma.decision === "PENDIENTE"
            && estado.reservas[firma.reserva_id]?.estado_reserva_id === params[1])
          .map((firma) => ({ ...firma, ...estado.reservas[firma.reserva_id], vencida: firma.vencida ? 1 : 0 }))];
      }
      if (/FROM reserva_firma_afiliado f STRAIGHT_JOIN reserva r ON r\.id = f\.reserva_id WHERE f\.decision = 'PENDIENTE' AND f\.vence_en <= NOW\(\)/.test(sql)) {
        return [Object.values(estado.firmas)
          .filter((firma) => firma.decision === "PENDIENTE" && firma.vencida && estado.reservas[firma.reserva_id]?.estado_reserva_id === params[0])
          .map((firma) => ({ reserva_id: firma.reserva_id }))];
      }
      // Lista de la persona
      if (/^SELECT r\.id, COALESCE\(r\.modalidad, 'FECHA_LIBRE'\) AS modalidad, r\.precio_total/.test(sql)) {
        return [Object.values(estado.firmas)
          .filter((firma) => firma.afiliado_usuario_id === params[0] && firma.decision === "PENDIENTE" && !firma.vencida
            && estado.reservas[firma.reserva_id]?.estado_reserva_id === params[2])
          .map((firma) => ({ ...estado.reservas[firma.reserva_id], ...firma, id: firma.reserva_id, servicio: "Hotel Solís",
            recurso: "Habitación 4", solicitada_por_rol: estado.usuarios[firma.solicitada_por_usuario_id]?.rol, departamental: "Azul" }))];
      }
      if (/^SELECT rf\.reserva_id, u\.nombre, u\.apellido, rf\.edad FROM reserva_familiar rf/.test(sql)) {
        return [[{ reserva_id: 41, nombre: "Marta", apellido: "Gómez", edad: 74 }]];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
}

const firmaService = require("../api/services/reservas-firma");
const { resumenPoliticaTexto, validarAceptacionPolitica, guardarAceptacionPolitica } = require("../api/services/politica-cancelacion");
const { rutaPermitidaFamiliar } = require("../api/security/autorizacion-sesion");

const afiliado = { id: 200, rol: "afiliado", modulo_turismo: 1 };
const departamental = { id: 51, rol: "departamental", departamental_id: 7, area_turismo: 1 };
const contexto = { ip: "10.0.0.8", userAgent: "Navegador de prueba" };

async function responder(estado, { actor = afiliado, accion = "FIRMAR", body = {}, subidas = [] } = {}) {
  return firmaService.responderFirma(crearConexion(estado), {
    reservaId: 41, actor, accion, body, contexto,
    subirFirma: async (buffer) => {
      assert.ok(Buffer.isBuffer(buffer));
      subidas.push(buffer);
      return `firma_prueba_${subidas.length}.png`;
    },
  });
}

const historialDe = (estado, campo) => estado.historial.filter(({ params }) => params[1] === campo);
const avisosDe = (estado, tipo) => estado.notificaciones.filter((aviso) => aviso.tipo === tipo);

// --- Carga del staff: «¿Quién firma?» y el plazo -------------------------------------
test("resolverFirmaCarga: cada canal del staff y el afiliado que reserva solo", () => {
  const { resolverFirmaCarga } = firmaService;
  assert.deepEqual(resolverFirmaCarga({ rol: "afiliado", body: { politica_cancelacion_canal: "ENVIO" } }),
    { modo: "AFILIADO", canal: "APP", firmaPor: "AFILIADO", esEnvio: false, esCargaAdministrativa: false });
  assert.deepEqual(resolverFirmaCarga({ rol: "departamental", body: { politica_cancelacion_canal: "presencial", firma_por: "afiliado", firma: PNG } }),
    { modo: "CARGA_ADMINISTRATIVA", canal: "PRESENCIAL", firmaPor: "AFILIADO", esEnvio: false, esCargaAdministrativa: true });
  assert.deepEqual(resolverFirmaCarga({ rol: "admin", body: { politica_cancelacion_canal: "TELEFONO", firma_por: "ADMINISTRATIVO", firma: PNG } }),
    { modo: "CARGA_ADMINISTRATIVA", canal: "TELEFONO", firmaPor: "ADMINISTRATIVO", esEnvio: false, esCargaAdministrativa: true });
  assert.deepEqual(resolverFirmaCarga({ rol: "admin", body: { politica_cancelacion_canal: "ENVIO", firma: PNG } }),
    { modo: null, canal: "ENVIO", firmaPor: null, esEnvio: true, esCargaAdministrativa: true });
  // Convenio y sorteo: sin canal queda sin dato; el envío no está disponible.
  assert.deepEqual(resolverFirmaCarga({ rol: "admin", body: {}, canalObligatorio: false, permiteEnvio: false }),
    { modo: "CARGA_ADMINISTRATIVA", canal: null, firmaPor: null, esEnvio: false, esCargaAdministrativa: true });
});

test("resolverFirmaCarga: cada error del contrato", () => {
  const { resolverFirmaCarga } = firmaService;
  const casos = [
    // Sin la clave: la pantalla de carga anterior a «¿Quién firma?» (pestaña abierta antes del deploy).
    [{ rol: "admin", body: {} }, "PANTALLA_DESACTUALIZADA"],
    [{ rol: "departamental", body: { politica_cancelacion_aceptada: true, firma: PNG } }, "PANTALLA_DESACTUALIZADA"],
    [{ rol: "admin", body: { politica_cancelacion_canal: "" } }, "CANAL_POLITICA_REQUERIDO"],
    [{ rol: "admin", body: { politica_cancelacion_canal: "REMOTA" } }, "CANAL_POLITICA_REQUERIDO"],
    [{ rol: "departamental", body: { politica_cancelacion_canal: "PRESENCIAL", firma_por: "ADMINISTRATIVO", firma: PNG } }, "FIRMA_POR_INVALIDA"],
    [{ rol: "departamental", body: { politica_cancelacion_canal: "TELEFONO", firma_por: "AFILIADO", firma: PNG } }, "FIRMA_POR_INVALIDA"],
    [{ rol: "departamental", body: { politica_cancelacion_canal: "TELEFONO", firma: PNG } }, "FIRMA_POR_INVALIDA"],
    [{ rol: "departamental", body: { politica_cancelacion_canal: "PRESENCIAL", firma_por: "AFILIADO" } }, "FIRMA_REQUERIDA"],
    [{ rol: "admin", body: { politica_cancelacion_canal: "ENVIO" }, permiteEnvio: false }, "ENVIO_NO_DISPONIBLE"],
  ];
  for (const [entrada, codigo] of casos) {
    assert.throws(() => resolverFirmaCarga(entrada), (error) => error.codigo === codigo && error.statusCode === 400, codigo);
  }
  // La pantalla vieja muestra el mensaje tal cual: tiene que decir qué hacer.
  assert.throws(() => resolverFirmaCarga({ rol: "admin", body: {} }), {
    codigo: "PANTALLA_DESACTUALIZADA",
    message: /^Mi AJB se actualizó y esta pantalla quedó vieja: la reserva no se creó\. Recargá la página \(F5\)/,
  });
});

test("el plazo para firmar es lo primero entre 72 horas y el fin del día anterior al ingreso, con 12 horas como mínimo", () => {
  const { calcularVencimientoFirma } = firmaService;
  const ahora = new Date("2026-10-22T13:05:30.400Z"); // 10:05:30 en Argentina
  assert.equal(calcularVencimientoFirma({ fechaInicio: "2027-01-10", ahora }).toISOString(), "2026-10-25T13:05:30.000Z");
  // Ingreso el 24/10: vence el 23/10 a las 23:59:59 de Argentina.
  assert.equal(calcularVencimientoFirma({ fechaInicio: "2026-10-24", ahora }).toISOString(), "2026-10-24T02:59:59.000Z");
  // Ingreso el 23/10: a las 10:05 quedan casi 14 horas (vence el 22/10 a las 23:59:59)…
  assert.equal(calcularVencimientoFirma({ fechaInicio: "2026-10-23", ahora }).toISOString(), "2026-10-23T02:59:59.000Z");
  // …y a las 13:00 quedan menos de 12: no se envía.
  assert.throws(() => calcularVencimientoFirma({ fechaInicio: "2026-10-23", ahora: new Date("2026-10-22T16:00:00Z") }),
    { statusCode: 409, codigo: "FIRMA_SIN_TIEMPO" });
  assert.throws(() => calcularVencimientoFirma({ fechaInicio: "2026-10-22", ahora }), { statusCode: 409, codigo: "FIRMA_SIN_TIEMPO" });
  assert.throws(() => calcularVencimientoFirma({ fechaInicio: "no", ahora }), { codigo: "FECHA_INICIO_INVALIDA" });
});

test("el inicio del plazo de 72 horas es único: titular, firma o creación", () => {
  const sql = firmaService.sqlInicioPlazoVerificacion("r");
  assert.match(sql, /reserva_aprobacion_titular a WHERE a\.reserva_id = r\.id AND a\.decision = 'APROBADA'/);
  assert.match(sql, /reserva_firma_afiliado f WHERE f\.reserva_id = r\.id AND f\.decision = 'FIRMADA'/);
  assert.match(sql, /r\.fecha_creacion\)$/);
  assert.throws(() => firmaService.sqlInicioPlazoVerificacion("r; DROP"), /Alias SQL inválido/);
});

test("resumen de las condiciones en una oración (guion para el teléfono y avisos)", () => {
  assert.equal(resumenPoliticaTexto(POLITICA),
    "Si cancelás con 15 días o más de anticipación, te devolvemos el 100%; de 7 a 14 días, el 50%; con menos de 7 días, no hay devolución.");
  assert.equal(resumenPoliticaTexto({ reglas: [{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro: 0 }] }),
    "Esta reserva no tiene devolución: si la cancelás, el reintegro es del 0%, sin importar la anticipación.");
  assert.equal(resumenPoliticaTexto({ reglas: [{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro: 100 }] }),
    "Si cancelás, te devolvemos el 100%, sin importar la anticipación.");
  assert.equal(resumenPoliticaTexto({ reglas: [
    { dias_desde: 0, dias_hasta: 0, porcentaje_reintegro: 0 },
    { dias_desde: 1, dias_hasta: 1, porcentaje_reintegro: 12.5 },
    { dias_desde: 2, dias_hasta: null, porcentaje_reintegro: 100 },
  ] }), "Si cancelás con 2 días o más de anticipación, te devolvemos el 100%; con 1 día, el 12,5%; el mismo día del ingreso, no hay devolución.");
  // Si el tramo de más anticipación no devuelve, el primero que sí devuelve dice «te devolvemos».
  assert.equal(resumenPoliticaTexto({ reglas: [
    { dias_desde: 0, dias_hasta: 6, porcentaje_reintegro: 50 },
    { dias_desde: 7, dias_hasta: null, porcentaje_reintegro: 0 },
  ] }), "Si cancelás con 7 días o más de anticipación, no hay devolución; con menos de 7 días, te devolvemos el 50%.");
});

test("con el envío a firmar el staff no acepta: sólo se controla la versión vigente", async () => {
  const fila = { ...POLITICA, reglas_json: JSON.stringify(POLITICA.reglas) };
  const db = { query: async () => [[fila]] };
  await assert.rejects(validarAceptacionPolitica(db, { servicioId: 5, politicaId: 7, version: 3 }), { codigo: "POLITICA_NO_ACEPTADA" });
  const presentada = await validarAceptacionPolitica(db, { servicioId: 5, politicaId: 7, version: 3, exigirAceptacion: false });
  assert.equal(presentada.version, 3);
  await assert.rejects(validarAceptacionPolitica(db, { servicioId: 5, politicaId: 7, version: 2, exigirAceptacion: false }),
    { statusCode: 409, codigo: "POLITICA_ACTUALIZADA" });
});

test("guardarAceptacionPolitica: cómo se aceptó y la copia de la firma, sin romper las llamadas viejas", async () => {
  const escrituras = [];
  const db = { query: async (sql, params) => { escrituras.push({ sql: normalizar(sql), params }); return [{ affectedRows: 1 }]; } };
  await guardarAceptacionPolitica(db, { reservaId: 41, usuarioId: 51, politica: POLITICA });
  assert.deepEqual(escrituras[0].params.slice(4), [51, null, null, null, null]);
  assert.match(escrituras[0].sql, /NULL\)$/, "sin firma no hay fecha de firma");
  await guardarAceptacionPolitica(db, { reservaId: 41, usuarioId: 51, politica: POLITICA, modo: "CARGA_ADMINISTRATIVA", canal: "TELEFONO", firmaPor: "ADMINISTRATIVO", firmaArchivo: " firma.png " });
  assert.deepEqual(escrituras[1].params.slice(4), [51, "CARGA_ADMINISTRATIVA", "TELEFONO", "ADMINISTRATIVO", "firma.png"]);
  assert.match(escrituras[1].sql, /NOW\(\)\)$/);
  // Un firmante sin firma no se guarda.
  await guardarAceptacionPolitica(db, { reservaId: 41, usuarioId: 200, politica: POLITICA, modo: "AFILIADO", canal: "APP", firmaPor: "AFILIADO" });
  assert.deepEqual(escrituras[2].params.slice(5), ["AFILIADO", "APP", null, null]);
  for (const datos of [{ modo: "OTRO" }, { canal: "REMOTA" }, { firmaPor: "TITULAR" }]) {
    await assert.rejects(guardarAceptacionPolitica(db, { reservaId: 41, usuarioId: 1, politica: POLITICA, ...datos }), /inválido/);
  }
  assert.equal(escrituras.length, 3);
});

test("los avisos a la persona llevan la reserva, el plazo y las condiciones", () => {
  const datos = { servicio: "Hotel Solís", fecha_inicio: "2027-01-10", fecha_fin: "2027-01-17", precio_total: 480000 };
  const aviso = firmaService.textoAvisoFirmaPendiente({
    reservaId: 123, rolSolicitante: "departamental", datos, politica: POLITICA, venceEn: new Date("2026-10-25T21:30:00Z"),
  });
  assert.equal(aviso, "Tu departamental cargó a tu nombre la reserva T-123 (Hotel Solís, del 10/01/2027 al 17/01/2027, por $ 480.000). "
    + "Para confirmarla, leé las condiciones y firmá desde Mi AJB antes del 25/10/2026 a las 18:30. "
    + "Condiciones de cancelación: si cancelás con 15 días o más de anticipación, te devolvemos el 100%; de 7 a 14 días, el 50%; "
    + "con menos de 7 días, no hay devolución. Si no la firmás a tiempo, se da de baja y se libera el lugar.");
  // Quién le leyó las condiciones va en la misma oración que quién cargó (no pegado a «La
  // departamental…») y el paso siguiente, al final.
  const telefono = firmaService.textoAvisoCargaStaff({ rolSolicitante: "admin", canal: "TELEFONO", estado: "Iniciada", datos, politica: POLITICA });
  assert.equal(telefono, "El equipo de Turismo cargó por teléfono una reserva a tu nombre (Hotel Solís, del 10/01/2027 al 17/01/2027, "
    + "por $ 480.000) y te leyó estas condiciones de cancelación: si cancelás con 15 días o más de anticipación, te devolvemos el 100%; "
    + "de 7 a 14 días, el 50%; con menos de 7 días, no hay devolución. La departamental tiene 72 horas para verificarla. "
    + "Si no estás de acuerdo, avisale a tu departamental cuanto antes.");
  const oficina = firmaService.textoAvisoCargaStaff({ rolSolicitante: "departamental", canal: "PRESENCIAL", estado: "Verificada", datos: { ...datos, precio_total: 0 }, politica: POLITICA });
  assert.match(oficina, /^Tu departamental cargó y verificó una reserva a tu nombre \(Hotel Solís, del 10\/01\/2027 al 17\/01\/2027, sin cargo\) y la firmaste en la oficina con estas condiciones de cancelación: si cancelás .* Las podés ver siempre en el detalle de la reserva\.$/);
  const oficinaAdmin = firmaService.textoAvisoCargaStaff({ rolSolicitante: "admin", canal: "PRESENCIAL", estado: "Iniciada", datos, politica: POLITICA });
  assert.match(oficinaAdmin, /y la firmaste en la oficina con estas condiciones de cancelación: .* Las podés ver siempre en el detalle de la reserva\. La departamental tiene 72 horas para verificarla\.$/);
  const convenio = firmaService.textoAvisoCargaStaff({ rolSolicitante: "departamental", canal: "TELEFONO", estado: "Solicitud convenio", datos, politica: POLITICA, tipoAlta: "CONVENIO" });
  assert.match(convenio, /^Tu departamental cargó a tu nombre una solicitud de convenio hotelero \(Hotel Solís, del 10\/01\/2027 al 17\/01\/2027\) y te leyó estas condiciones de cancelación: si cancelás .* Si no estás de acuerdo, avisale a tu departamental cuanto antes\.$/);
  const sorteo = firmaService.textoAvisoCargaStaff({ rolSolicitante: "departamental", estado: "Solicitud sorteo", datos, politica: POLITICA, tipoAlta: "SORTEO", sorteoNombre: "Verano 2027" });
  assert.match(sorteo, /^Tu departamental te anotó en el sorteo «Verano 2027» para la estadía del 10\/01\/2027 al 17\/01\/2027\. Si salís sorteado, se aplican estas condiciones de cancelación: si cancelás/);
});

// --- Envío a firmar ---------------------------------------------------------------
test("registrarSolicitudFirma deja el estado 15, la solicitud con la política, el aviso obligatorio y el historial con el estado anterior real", async () => {
  const estado = crearEstado({ sinSolicitud: true, estadoReserva: 1 });
  const vence = new Date("2026-10-25T13:05:00Z");
  const resultado = await firmaService.registrarSolicitudFirma(crearConexion(estado), {
    reservaId: 41, afiliadoId: 200, solicitante: { id: 51, rol: "departamental" }, estadoAnteriorId: 1,
    estadoDestino: "Verificada", politica: POLITICA, venceEn: vence, contexto,
  });
  assert.deepEqual(resultado, { estado: "Pendiente de firma", estado_destino: "Verificada", vence_en: vence });
  assert.equal(estado.reservas[41].estado_reserva_id, 15);
  assert.equal(estado.firmas[41].estado_destino, "Verificada");
  assert.deepEqual(JSON.parse(estado.firmas[41].politica_snapshot_json).reglas, POLITICA.reglas);
  assert.equal(estado.firmas[41].vence_en, vence);
  const [aviso] = avisosDe(estado, "RESERVA_FIRMA_PENDIENTE");
  assert.equal(aviso.usuarioId, 200);
  assert.equal(aviso.obligatoria, true, "llega aunque haya silenciado avisos");
  assert.equal(aviso.titulo, "Firmá tu reserva T-41");
  assert.match(aviso.mensaje, /^Tu departamental cargó a tu nombre la reserva T-41 \(Hotel Solís/);
  assert.deepEqual(aviso.payload, { reserva_id: 41, estado: "Pendiente de firma", vence_en: vence.toISOString(), url: "/turismo/reserva/detalle/41" });
  const [cambioEstado] = historialDe(estado, "estado_reserva_id");
  assert.deepEqual(cambioEstado.params.slice(2, 7), ["1", "15", 51, "10.0.0.8", "Navegador de prueba"]);
  assert.match(cambioEstado.params[7], /^Enviada a firmar a la persona afiliada desde Mi AJB; vence el 25\/10\/2026 a las 10:05\. Cuando la firme, queda «Verificada»\.$/);
  assert.equal(historialDe(estado, "reserva_firma_afiliado.decision")[0].params[3], "PENDIENTE");
  // La aceptación de la política se guarda recién al firmar.
  assert.equal(estado.aceptaciones.length, 0);
});

test("sin la migración, el envío responde 503 y no toca la reserva", async () => {
  const estado = crearEstado({ sinSolicitud: true, estadoReserva: 1 });
  delete estado.estados["Pendiente de firma"];
  await assert.rejects(firmaService.registrarSolicitudFirma(crearConexion(estado), {
    reservaId: 41, afiliadoId: 200, solicitante: { id: 51, rol: "departamental" }, estadoAnteriorId: 1,
    estadoDestino: "Verificada", politica: POLITICA, venceEn: new Date(), contexto,
  }), { statusCode: 503, codigo: "FIRMA_AFILIADO_NO_MIGRADA" });
  assert.equal(estado.reservas[41].estado_reserva_id, 1);
});

test("una sola reserva esperando firma por persona; la vencida se da de baja y no cuenta", async () => {
  const estado = crearEstado();
  await assert.rejects(
    firmaService.asegurarSinFirmaPendiente(crearConexion(estado), { usuarioId: 200, nombre: "Marta Gómez" }),
    (error) => error.statusCode === 409 && error.codigo === "FIRMA_PENDIENTE_EXISTENTE"
      && /^Marta Gómez ya tiene la reserva T-41 esperando su firma/.test(error.message)
      && error.detalles.reserva.id === 41 && error.detalles.reserva.estado === "Pendiente de firma"
  );
  assert.ok(estado.consultas.some(({ sql }) => /FOR UPDATE OF f, r$/.test(sql)));

  const vencida = crearEstado({ vencida: true });
  await firmaService.asegurarSinFirmaPendiente(crearConexion(vencida), { usuarioId: 200 });
  assert.equal(vencida.reservas[41].estado_reserva_id, 4, "vence al acceder: Rechazada");
  assert.equal(vencida.firmas[41].decision, "VENCIDA");
});

test("una firma pendiente que queda Iniciada bloquea otra Iniciada; la que queda Verificada no", async () => {
  const iniciada = await firmaService.buscarFirmaPendienteIniciada(crearConexion(crearEstado({ destino: "Iniciada" })), 200);
  assert.equal(iniciada.id, 41);
  assert.equal(iniciada.estado, "Pendiente de firma");
  assert.equal(iniciada.servicio, "Hotel Solís");
  assert.equal(await firmaService.buscarFirmaPendienteIniciada(crearConexion(crearEstado({ destino: "Verificada" })), 200), null);
});

// --- Firma de la persona afiliada --------------------------------------------------
test("FIRMAR: acepta la política enviada, pasa a Verificada y avisa a la departamental y a administración", async () => {
  const estado = crearEstado({ destino: "Verificada" });
  const subidas = [];
  const resultado = await responder(estado, { body: { firma: PNG, acepta: true, politica_version: 3 }, subidas });

  assert.equal(resultado.estado, "Verificada");
  assert.match(resultado.message, /^¡Listo! Firmaste tu reserva/);
  assert.equal(subidas.length, 1);
  assert.equal(estado.reservas[41].estado_reserva_id, 2);
  assert.equal(estado.reservas[41].firma_archivo, "firma_prueba_1.png");
  // Aceptación con la política enviada (aunque la vigente haya cambiado): AFILIADO / ENVIO / AFILIADO.
  const [aceptacion] = estado.aceptaciones;
  assert.match(aceptacion.sql, /\(reserva_id, politica_id, version, snapshot_json, aceptada_por, modo, canal, firma_por, firma_archivo, firmada_en\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, NOW\(\)\)/);
  assert.deepEqual([aceptacion.params[0], aceptacion.params[1], aceptacion.params[2], aceptacion.params[4]], [41, 7, 3, 200]);
  assert.deepEqual(aceptacion.params.slice(5), ["AFILIADO", "ENVIO", "AFILIADO", "firma_prueba_1.png"]);
  assert.deepEqual(JSON.parse(aceptacion.params[3]).reglas, POLITICA.reglas);
  assert.equal(estado.firmas[41].decision, "FIRMADA");
  // Historial con IP y navegador.
  const [cambio] = historialDe(estado, "estado_reserva_id");
  assert.deepEqual(cambio.params.slice(2, 7), ["15", "2", 200, "10.0.0.8", "Navegador de prueba"]);
  assert.match(cambio.params[7], /firmó desde Mi AJB\. Queda «Verificada» \(carga de la departamental\) y pasa a administración\.$/);
  assert.equal(historialDe(estado, "firma_archivo")[0].params[3], "firma_prueba_1.png");
  // El aviso de «firmá» queda leído.
  assert.deepEqual(estado.leidas[0], [200, "RESERVA_FIRMA_PENDIENTE", "41"]);
  // Departamental (sin los admins, que reciben «para aprobar») + admin-central; los admins, RESERVA_PARA_APROBAR.
  assert.deepEqual(avisosDe(estado, "RESERVA_FIRMA_RECIBIDA").map((aviso) => aviso.usuarioId).sort(), [50, 51, 70]);
  assert.deepEqual(avisosDe(estado, "RESERVA_PARA_APROBAR").map((aviso) => aviso.usuarioId), [1, 2]);
  assert.equal(avisosDe(estado, "RESERVA_PARA_APROBAR")[0].mensaje,
    "La departamental cargó la reserva y Marta Gómez firmó desde Mi AJB. Ya está disponible para aprobación administrativa.");
  assert.match(avisosDe(estado, "RESERVA_FIRMA_RECIBIDA")[0].mensaje, /^Marta Gómez firmó desde Mi AJB la reserva que se le envió/);
  assert.ok(avisosDe(estado, "RESERVA_FIRMA_RECIBIDA").every((aviso) => !aviso.obligatoria), "respetan preferencias (categoría estados)");
  assert.ok(avisosDe(estado, "RESERVA_FIRMA_RECIBIDA").every((aviso) => /SELECT estados FROM usuario_notificacion_preferencia/.test(aviso.sql)));
});

test("FIRMAR con destino Iniciada: la departamental tiene 72 horas desde la firma; con otra Iniciada responde 409 sin subir la firma", async () => {
  const estado = crearEstado({ destino: "Iniciada", solicitanteRol: "admin" });
  const resultado = await responder(estado, { body: { firma: PNG, acepta: true } });
  assert.equal(resultado.estado, "Iniciada");
  assert.equal(estado.reservas[41].estado_reserva_id, 1);
  assert.equal(avisosDe(estado, "RESERVA_PARA_APROBAR").length, 0);
  assert.ok(avisosDe(estado, "RESERVA_FIRMA_RECIBIDA").some((aviso) => aviso.usuarioId === 1), "administración también se entera");

  const conOtra = crearEstado({ destino: "Iniciada", otraIniciada: { id: 39, usuario_id: 200, estado_reserva_id: 1, modalidad: "FECHA_LIBRE", fecha_inicio: "2099-02-01", fecha_fin: "2099-02-03" } });
  const subidas = [];
  await assert.rejects(responder(conOtra, { body: { firma: PNG, acepta: true }, subidas }),
    (error) => error.statusCode === 409 && error.codigo === "RESERVA_INICIADA_EXISTENTE" && error.detalles.reserva.id === 39
      && /^Ya tenés otra reserva «Iniciada» \(T-39\)/.test(error.message));
  assert.equal(subidas.length, 0);
  assert.equal(conOtra.reservas[41].estado_reserva_id, 15);
});

test("FIRMAR exige casilla, firma válida, la versión que se envió y CBU", async () => {
  const casos = [
    [{ firma: PNG }, 400, "POLITICA_NO_ACEPTADA"],
    [{ acepta: true }, 400, "FIRMA_REQUERIDA"],
    [{ acepta: true, firma: "data:image/jpeg;base64,AAAA" }, 400, "FIRMA_INVALIDA"],
    [{ acepta: true, firma: `data:image/png;base64,${Buffer.from("no es png").toString("base64")}` }, 400, "FIRMA_INVALIDA"],
    [{ acepta: true, firma: PNG, politica_version: 2 }, 409, "POLITICA_VERSION_DISTINTA"],
  ];
  for (const [body, statusCode, codigo] of casos) {
    const estado = crearEstado();
    await assert.rejects(responder(estado, { body }), { statusCode, codigo }, codigo);
    assert.equal(estado.reservas[41].estado_reserva_id, 15, codigo);
  }
  const sinCbu = crearEstado({ cbu: " " });
  await assert.rejects(responder(sinCbu, { body: { firma: PNG, acepta: true } }), { statusCode: 422, codigo: "CBU_REQUERIDO" });
});

test("RECHAZAR («No la quiero»): Cancelada sin penalidad (regla SIN_FIRMA), libera el lugar y avisa al staff", async () => {
  const estado = crearEstado();
  const resultado = await responder(estado, { accion: "RECHAZAR", body: { motivo: "Ya no viajo" } });
  assert.equal(resultado.estado, "Cancelada");
  assert.deepEqual(resultado.invalidacion, { servicio_id: 5, recurso_id: 9, bloque_fecha_id: null, fecha_inicio: "2099-01-10", fecha_fin: "2099-01-17" });
  assert.equal(estado.reservas[41].estado_reserva_id, 13);
  assert.equal(estado.firmas[41].decision, "RECHAZADA");
  assert.equal(estado.firmas[41].motivo, "Ya no viajo");
  assert.deepEqual(estado.bloquesLiberados, [41]);
  // La baja queda registrada con la política que se le envió, al 100% y como SIN_FIRMA.
  const [cancelacion] = estado.cancelaciones;
  assert.equal(cancelacion.params[3], 100);
  assert.deepEqual(cancelacion.params.slice(12), ["AFILIADO", "APP", "afiliado", "Ya no viajo", "SIN_FIRMA"]);
  assert.equal(estado.aceptaciones.length, 0, "nadie aceptó condiciones");
  assert.match(historialDe(estado, "estado_reserva_id")[0].params[7], /no aceptó la reserva \(«No la quiero»\): se dio de baja sin cargo/);
  assert.deepEqual(avisosDe(estado, "RESERVA_FIRMA_RECHAZADA").map((aviso) => aviso.usuarioId).sort(), [1, 2, 50, 51, 70]);
  assert.match(avisosDe(estado, "RESERVA_FIRMA_RECHAZADA")[0].mensaje, /Motivo: Ya no viajo$/);
  await assert.rejects(responder(crearEstado(), { accion: "RECHAZAR", body: { motivo: "x".repeat(501) } }), { codigo: "MOTIVO_DEMASIADO_LARGO" });
});

// --- Staff: firmar en pantalla y volver a avisar -------------------------------------
test("FIRMAR_EN_PANTALLA: con la persona en la oficina o por teléfono, modo carga administrativa y aviso con las condiciones", async () => {
  const oficina = crearEstado();
  const resultado = await responder(oficina, {
    actor: departamental, accion: "FIRMAR_EN_PANTALLA",
    body: { canal: "PRESENCIAL", firma_por: "AFILIADO", acepta: true, firma: PNG },
  });
  assert.equal(resultado.estado, "Verificada");
  assert.deepEqual(oficina.aceptaciones[0].params.slice(4), [51, "CARGA_ADMINISTRATIVA", "PRESENCIAL", "AFILIADO", "firma_prueba_1.png"]);
  assert.equal(oficina.firmas[41].respondida_por_usuario_id, 51);
  const [aviso] = avisosDe(oficina, "RESERVA_FIRMA_REGISTRADA");
  assert.equal(aviso.usuarioId, 200);
  assert.equal(aviso.obligatoria, true);
  assert.match(aviso.mensaje, /^Firmaste en la oficina la reserva T-41 \(Hotel Solís, del 10\/01\/2099 al 17\/01\/2099, por \$ 480\.000\) con estas condiciones de cancelación: si cancelás .* Las podés ver siempre en el detalle de la reserva\. Ya pasó a administración para aprobarla\.$/);
  assert.ok(!avisosDe(oficina, "RESERVA_FIRMA_RECIBIDA").some((avisoStaff) => avisoStaff.usuarioId === 51), "no se avisa a quien firmó");
  assert.match(avisosDe(oficina, "RESERVA_PARA_APROBAR")[0].mensaje, /^La departamental cargó la reserva y Marta Gómez firmó en la oficina\. /);

  const telefono = crearEstado();
  await responder(telefono, {
    actor: departamental, accion: "FIRMAR_EN_PANTALLA",
    body: { canal: "TELEFONO", firma_por: "ADMINISTRATIVO", acepta: true, firma: PNG },
  });
  assert.deepEqual(telefono.aceptaciones[0].params.slice(5, 8), ["CARGA_ADMINISTRATIVA", "TELEFONO", "ADMINISTRATIVO"]);
  assert.match(historialDe(telefono, "estado_reserva_id")[0].params[7], /^Reserva telefónica: se le leyeron las condiciones/);
  // Quien aprueba lee que firmó el administrativo, no la persona.
  assert.match(avisosDe(telefono, "RESERVA_PARA_APROBAR")[0].mensaje, /y Marta Gómez aceptó por teléfono \(firmó el administrativo\)\. Ya está disponible/);
  // «te leyó» va con quien registró la conformidad; el paso siguiente, después de las condiciones.
  assert.match(avisosDe(telefono, "RESERVA_FIRMA_REGISTRADA")[0].mensaje,
    /^Tu departamental registró por teléfono tu conformidad con la reserva T-41 \([^)]+\) y te leyó estas condiciones de cancelación: si cancelás .* no hay devolución\. Ya pasó a administración para aprobarla\. Si no estás de acuerdo, avisale a tu departamental cuanto antes\.$/);

  for (const [body, codigo] of [
    [{ canal: "ENVIO", firma_por: "AFILIADO", acepta: true, firma: PNG }, "CANAL_POLITICA_REQUERIDO"],
    [{ canal: "TELEFONO", firma_por: "AFILIADO", acepta: true, firma: PNG }, "FIRMA_POR_INVALIDA"],
    [{ canal: "PRESENCIAL", firma_por: "AFILIADO", firma: PNG }, "POLITICA_NO_ACEPTADA"],
  ]) {
    await assert.rejects(responder(crearEstado(), { actor: departamental, accion: "FIRMAR_EN_PANTALLA", body }), { codigo }, codigo);
  }
});

test("REENVIAR: vuelve a avisar (obligatorio) hasta 3 veces y no más de una por hora", async () => {
  const estado = crearEstado();
  const resultado = await responder(estado, { actor: departamental, accion: "REENVIAR" });
  assert.equal(resultado.avisos_enviados, 2);
  assert.equal(estado.firmas[41].avisos_enviados, 2);
  const [aviso] = avisosDe(estado, "RESERVA_FIRMA_PENDIENTE");
  assert.equal(aviso.obligatoria, true);
  assert.equal(aviso.titulo, "Recordatorio: firmá tu reserva T-41");
  assert.match(aviso.mensaje, /^Te recordamos que el equipo de turismo cargó a tu nombre la reserva T-41|^Te recordamos que tu departamental cargó a tu nombre la reserva T-41/);
  assert.deepEqual(estado.leidas[0], [200, "RESERVA_FIRMA_PENDIENTE", "41"], "el recordatorio reemplaza al aviso anterior");
  assert.match(historialDe(estado, "reserva_firma_afiliado.avisos_enviados")[0].params[7], /aviso 2 de 3/);

  await assert.rejects(responder(crearEstado({ avisosEnviados: 3 }), { actor: departamental, accion: "REENVIAR" }), { statusCode: 409, codigo: "AVISOS_AGOTADOS" });
  await assert.rejects(responder(crearEstado({ avisoReciente: true }), { actor: departamental, accion: "REENVIAR" }), { statusCode: 409, codigo: "AVISO_RECIENTE" });
});

// --- Permisos ----------------------------------------------------------------------
test("permisos: sólo la persona dueña firma o rechaza; el staff de la jurisdicción firma en pantalla o reenvía", async () => {
  const casos = [
    [{ id: 300, rol: "afiliado" }, "FIRMAR", 403],
    [{ id: 300, rol: "afiliado" }, "RECHAZAR", 403],
    [departamental, "FIRMAR", 403],
    [afiliado, "REENVIAR", 403],
    [afiliado, "FIRMAR_EN_PANTALLA", 403],
    [{ id: 60, rol: "departamental", departamental_id: 8 }, "REENVIAR", 403],
    [{ id: 70, rol: "admin-central" }, "REENVIAR", 403],
    [{ id: 80, rol: "auditor" }, "FIRMAR_EN_PANTALLA", 403],
    [afiliado, "APROBAR", 400],
  ];
  for (const [actor, accion, statusCode] of casos) {
    const estado = crearEstado();
    await assert.rejects(responder(estado, { actor, accion, body: { firma: PNG, acepta: true } }), { statusCode }, `${actor.rol} ${accion}`);
    assert.equal(estado.reservas[41].estado_reserva_id, 15);
    assert.equal(estado.consultas.some(({ sql }) => /FOR UPDATE$/.test(sql) && /reserva_firma_afiliado/.test(sql)), false, "autoriza antes de bloquear");
  }
  // Admin de cualquier departamental sí.
  const admin = crearEstado();
  await responder(admin, { actor: { id: 1, rol: "admin" }, accion: "REENVIAR" });
  assert.equal(admin.firmas[41].avisos_enviados, 2);
  // Reserva que nunca se envió a firmar.
  await assert.rejects(responder(crearEstado({ sinSolicitud: true }), { body: { firma: PNG, acepta: true } }), { statusCode: 404, codigo: "FIRMA_NO_SOLICITADA" });
});

// --- Concurrencia y vencimiento ------------------------------------------------------
test("concurrencia: una firma ya resuelta o una reserva que cambió responde 409 y no deja nada a medias", async () => {
  for (const decision of ["FIRMADA", "RECHAZADA", "CANCELADA", "VENCIDA"]) {
    const estado = crearEstado({ decision });
    await assert.rejects(responder(estado, { body: { firma: PNG, acepta: true } }), { statusCode: 409, codigo: "FIRMA_RESUELTA" }, decision);
  }
  // Dada de baja por el staff mientras la persona firmaba: el estado ya no es 15.
  await assert.rejects(responder(crearEstado({ estadoReserva: 13 }), { body: { firma: PNG, acepta: true } }), { statusCode: 409, codigo: "FIRMA_RESUELTA" });
  // El UPDATE … WHERE estado_reserva_id = 15 no afecta filas (otra transacción ganó).
  const carrera = crearEstado();
  carrera.carrera = true;
  const subidas = [];
  await assert.rejects(responder(carrera, { body: { firma: PNG, acepta: true }, subidas }), { statusCode: 409, codigo: "RESERVA_MODIFICADA" });
  assert.equal(carrera.aceptaciones.length, 0);
  assert.ok(carrera.consultas.some(({ sql }) => /WHERE id = \? AND estado_reserva_id = \?$/.test(sql)));
});

test("vencida al acceder: la da de baja (Rechazada, VENCIDA), libera el lugar y avisa a la persona y al staff", async () => {
  const estado = crearEstado({ vencida: true });
  const subidas = [];
  const resultado = await responder(estado, { body: { firma: PNG, acepta: true }, subidas });
  assert.equal(resultado.vencida, true);
  assert.equal(resultado.estado, "Rechazada");
  assert.equal(subidas.length, 0);
  assert.equal(estado.reservas[41].estado_reserva_id, 4);
  assert.equal(estado.firmas[41].decision, "VENCIDA");
  assert.deepEqual(estado.bloquesLiberados, [41]);
  const [cambio] = historialDe(estado, "estado_reserva_id");
  assert.equal(cambio.params[4], null, "baja automática, sin usuario");
  assert.match(cambio.params[7], /^Se dio de baja sola: la persona afiliada no la firmó a tiempo \(vencía el 25\/10\/2026 a las 10:05\)/);
  assert.equal(avisosDe(estado, "RESERVA_FIRMA_VENCIDA").filter((aviso) => aviso.usuarioId === 200).length, 1);
  assert.ok(avisosDe(estado, "RESERVA_FIRMA_VENCIDA").some((aviso) => aviso.usuarioId === 50), "le avisa a quien la envió");
});

test("mantenimiento: vence lo pendiente con su propio lock y es tolerante a que falte la migración", async () => {
  const estado = crearEstado({ vencida: true });
  const pool = { getConnection: async () => crearConexion(estado) };
  const resultado = await firmaService.expirarFirmasVencidas(pool, { limite: 10 });
  assert.equal(resultado.ejecutado, true);
  assert.equal(resultado.firmas, 1);
  assert.equal(estado.reservas[41].estado_reserva_id, 4);
  assert.deepEqual(estado.transaccion, ["begin", "commit", "release"]);
  const seleccion = estado.consultas.find(({ sql }) => /STRAIGHT_JOIN reserva r/.test(sql));
  assert.match(seleccion.sql, /LIMIT 10 FOR UPDATE SKIP LOCKED$/);
  assert.ok(estado.consultas.some(({ sql, params }) => /^SELECT GET_LOCK/.test(sql) && params[0] === firmaService.LOCK_VENCIMIENTO_FIRMAS));
  assert.match(estado.consultas.at(-1).sql, /^SELECT RELEASE_LOCK/);

  // Sin el estado (migración pendiente) no hace nada.
  const sinEstado = crearEstado({ vencida: true });
  delete sinEstado.estados["Pendiente de firma"];
  assert.deepEqual(await firmaService.expirarFirmasVencidas({ getConnection: async () => crearConexion(sinEstado) }),
    { ejecutado: false, firmas: 0, eventos: [], omitido: "SIN_MIGRACION" });
  // Sin la tabla (ER_NO_SUCH_TABLE) tampoco: no corta los demás vencimientos.
  const sinTabla = crearEstado({ vencida: true });
  sinTabla.fallas["STRAIGHT_JOIN reserva r"] = Object.assign(new Error("Table 'reserva_firma_afiliado' doesn't exist"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
  const omitido = await firmaService.expirarFirmasVencidas({ getConnection: async () => crearConexion(sinTabla) });
  assert.equal(omitido.omitido, "SIN_MIGRACION");
  assert.equal(omitido.codigo, "ER_NO_SUCH_TABLE", "el mantenimiento lo deja en el log");
  assert.ok(sinTabla.transaccion.includes("rollback"));
  // Otros errores sí se propagan: tampoco una columna desconocida, que es un error de verdad.
  for (const error of [
    Object.assign(new Error("Lock wait timeout"), { code: "ER_LOCK_WAIT_TIMEOUT" }),
    Object.assign(new Error("Unknown column 'f.vence_en' in 'where clause'"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 }),
  ]) {
    const roto = crearEstado({ vencida: true });
    roto.fallas["STRAIGHT_JOIN reserva r"] = error;
    await assert.rejects(firmaService.expirarFirmasVencidas({ getConnection: async () => crearConexion(roto) }), { code: error.code });
    assert.ok(roto.transaccion.includes("rollback"), error.code);
  }
});

test("la lista de la persona trae personas, plazo y condiciones, sin nombres del staff", async () => {
  const reservas = await firmaService.listarFirmasPendientes(crearConexion(crearEstado()), 200);
  assert.equal(reservas.length, 1);
  const [reserva] = reservas;
  assert.equal(reserva.codigo, "T-41");
  assert.equal(reserva.origen, "DEPARTAMENTAL");
  assert.deepEqual(reserva.personas, [{ nombre: "Marta", apellido: "Gómez", edad: 74 }]);
  assert.deepEqual(reserva.politica, { id: 7, version: 3, titulo: "Política general", reglas: POLITICA.reglas });
  assert.match(reserva.condiciones_resumen, /^Si cancelás con 15 días o más/);
  assert.equal(JSON.stringify(reserva).includes("motivo"), false);
  assert.equal(Object.keys(reserva).some((clave) => /solicitada_por_(nombre|usuario)/.test(clave)), false);
  assert.deepEqual(await firmaService.listarFirmasPendientes(crearConexion(crearEstado({ vencida: true })), 200), []);
  assert.deepEqual(await firmaService.listarFirmasPendientes(crearConexion(crearEstado()), 300), []);
});

test("la cuenta de un familiar invitado puede ver y firmar sus reservas enviadas", () => {
  assert.equal(rutaPermitidaFamiliar({ method: "GET", path: "/reservas/firmas-pendientes" }), true);
  assert.equal(rutaPermitidaFamiliar({ method: "PUT", path: "/reserva/41/firma-afiliado" }), true);
});

// --- Rutas -------------------------------------------------------------------------
let estadoRuta = crearEstado();
let usuarioSesion = null;
const pool = {
  query: (...args) => consultaPool(...args),
  getConnection: async () => crearConexion(estadoRuta),
};
async function consultaPool(sql, params) {
  if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql)) {
    return [usuarioSesion ? [usuarioSesion] : []];
  }
  if (/SELECT p\.\* FROM politica_cancelacion p\s+INNER JOIN politica_cancelacion_servicio_vigente v/.test(sql)) {
    return [[{ ...POLITICA, reglas_json: JSON.stringify(POLITICA.reglas) }]];
  }
  return crearConexion(estadoRuta).query(sql, params);
}
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => pool } };
const router = require("../api/routes/reservas-firma");
const s3Llamadas = [];
router.__test.s3.send = async (comando) => {
  if (comando instanceof PutObjectCommand) s3Llamadas.push(["subir", comando.input.Key]);
  else if (comando instanceof DeleteObjectCommand) s3Llamadas.push(["borrar", comando.input.Key]);
  return {};
};
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/api", router);
app.use("/api", require("../api/routes/politica-cancelacion"));

function token(claims) {
  usuarioSesion = {
    id: claims.id, rol_id: 1, rol: claims.rol, departamental_id: claims.departamental_id ?? null, habilitado: "Y",
    area_turismo: claims.area_turismo ?? 1, area_coseguro: 1, modulo_turismo: claims.modulo_turismo ?? 1, modulo_coseguro: 1, modulo_olimpiadas: 1,
  };
  return jwt.sign({ data: JSON.stringify(claims) }, process.env.JWT_SECRET);
}

async function pedir(ruta, { method = "GET", claims, body } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const respuesta = await fetch(`http://127.0.0.1:${server.address().port}/api${ruta}`, {
      method,
      headers: {
        ...(claims ? { authorization: `Bearer ${token(claims)}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: respuesta.status, body: await respuesta.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /turismo/politica-cancelacion trae el resumen para leérselo a la persona por teléfono", async () => {
  const respuesta = await pedir("/turismo/politica-cancelacion?servicio_id=5", { claims: { id: 51, rol: "departamental", departamental_id: 7 } });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.resumen,
    "Si cancelás con 15 días o más de anticipación, te devolvemos el 100%; de 7 a 14 días, el 50%; con menos de 7 días, no hay devolución.");
  assert.equal(respuesta.body.politica.version, 3);
  assert.equal(respuesta.body.politica.motivo, undefined, "el motivo sigue siendo de auditoría");
});

test("GET /reservas/firmas-pendientes: sólo la persona afiliada", async () => {
  estadoRuta = crearEstado();
  const respuesta = await pedir("/reservas/firmas-pendientes", { claims: { id: 200, rol: "afiliado" } });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.body.reservas.map((reserva) => reserva.id), [41]);
  for (const claims of [{ id: 51, rol: "departamental", departamental_id: 7 }, { id: 1, rol: "admin" }, { id: 200, rol: "afiliado", modulo_turismo: 0 }]) {
    assert.equal((await pedir("/reservas/firmas-pendientes", { claims })).status, 403, claims.rol);
  }
  assert.equal((await pedir("/reservas/firmas-pendientes")).status, 401);
});

test("PUT /reserva/:id/firma-afiliado: firma, confirma la transacción y responde el estado nuevo", async () => {
  estadoRuta = crearEstado();
  s3Llamadas.length = 0;
  const respuesta = await pedir("/reserva/41/firma-afiliado", {
    method: "PUT", claims: { id: 200, rol: "afiliado" }, body: { accion: "FIRMAR", acepta: true, firma: PNG },
  });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.success, true);
  assert.equal(respuesta.body.estado, "Verificada");
  assert.deepEqual(respuesta.body.reserva, { id: 41, estado: "Verificada" });
  assert.equal(s3Llamadas.length, 1);
  assert.match(s3Llamadas[0][1], /^firma_\d+_[0-9a-f]{12}\.png$/);
  assert.deepEqual(estadoRuta.transaccion.filter((paso) => paso !== "release"), ["begin", "commit"]);
});

test("PUT /reserva/:id/firma-afiliado: si algo falla después de subir la firma, revierte y la borra de S3", async () => {
  estadoRuta = crearEstado();
  estadoRuta.fallas["^INSERT INTO reserva_politica_cancelacion"] = new Error("falla de base");
  s3Llamadas.length = 0;
  const respuesta = await pedir("/reserva/41/firma-afiliado", {
    method: "PUT", claims: { id: 200, rol: "afiliado" }, body: { accion: "FIRMAR", acepta: true, firma: PNG },
  });
  assert.equal(respuesta.status, 500);
  assert.equal(respuesta.body.message, "No se pudo responder la firma de la reserva");
  assert.ok(estadoRuta.transaccion.includes("rollback"));
  assert.deepEqual(s3Llamadas.map(([accion]) => accion), ["subir", "borrar"]);
  assert.equal(s3Llamadas[0][1], s3Llamadas[1][1]);
});

test("PUT /reserva/:id/firma-afiliado: si se cruza con un cambio de estado (deadlock), 409 RESERVA_MODIFICADA para volver a abrirla", async () => {
  // La firma bloquea persona → reserva y PUT /reserva/:id/estado, reserva → persona: InnoDB revierte una.
  estadoRuta = crearEstado();
  estadoRuta.fallas["LEFT JOIN reserva_firma_afiliado f ON f\\.reserva_id = r\\.id WHERE r\\.id = \\? FOR UPDATE$"] =
    Object.assign(new Error("Deadlock found when trying to get lock; try restarting transaction"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
  s3Llamadas.length = 0;
  const respuesta = await pedir("/reserva/41/firma-afiliado", {
    method: "PUT", claims: { id: 200, rol: "afiliado" }, body: { accion: "FIRMAR", acepta: true, firma: PNG },
  });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "RESERVA_MODIFICADA", "el detalle la vuelve a cargar");
  assert.match(respuesta.body.message, /Volvé a abrirla e intentalo de nuevo\.$/);
  assert.ok(estadoRuta.transaccion.includes("rollback"));
  assert.deepEqual(s3Llamadas, [], "todavía no se había subido la firma");
  assert.equal(estadoRuta.reservas[41].estado_reserva_id, 15);
});

test("PUT /reserva/:id/firma-afiliado: vencida responde 409 FIRMA_VENCIDA pero confirma la baja", async () => {
  estadoRuta = crearEstado({ vencida: true });
  const respuesta = await pedir("/reserva/41/firma-afiliado", {
    method: "PUT", claims: { id: 200, rol: "afiliado" }, body: { accion: "FIRMAR", acepta: true, firma: PNG },
  });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "FIRMA_VENCIDA");
  assert.equal(respuesta.body.estado, "Rechazada");
  assert.ok(estadoRuta.transaccion.includes("commit"));
  assert.equal(estadoRuta.reservas[41].estado_reserva_id, 4);
});

test("PUT /reserva/:id/firma-afiliado: errores con código y sin Turismo, 403", async () => {
  estadoRuta = crearEstado();
  const ajeno = await pedir("/reserva/41/firma-afiliado", {
    method: "PUT", claims: { id: 300, rol: "afiliado" }, body: { accion: "FIRMAR", acepta: true, firma: PNG },
  });
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.codigo, "FIRMA_NO_AUTORIZADA");
  const sinTurismo = await pedir("/reserva/41/firma-afiliado", {
    method: "PUT", claims: { id: 51, rol: "departamental", departamental_id: 7, area_turismo: 0 }, body: { accion: "REENVIAR" },
  });
  assert.equal(sinTurismo.status, 403);
  const existente = crearEstado({ destino: "Iniciada", otraIniciada: { id: 39, usuario_id: 200, estado_reserva_id: 1, modalidad: "FECHA_LIBRE" } });
  estadoRuta = existente;
  const conflicto = await pedir("/reserva/41/firma-afiliado", {
    method: "PUT", claims: { id: 200, rol: "afiliado" }, body: { accion: "FIRMAR", acepta: true, firma: PNG },
  });
  assert.equal(conflicto.status, 409);
  assert.equal(conflicto.body.codigo, "RESERVA_INICIADA_EXISTENTE");
  assert.equal(conflicto.body.reserva.id, 39);
});
