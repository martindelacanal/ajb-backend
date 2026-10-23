"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PLAZO_RESPUESTA_TITULAR_HORAS, calcularVencimientoTitular, asegurarSinSolicitudTitularPendiente,
  expirarSolicitudesTitularVencidas,
} = require("../api/services/reservas-familiares");
const { migrar, DECISIONES } = require("../scripts/migrar-aprobacion-titular-vencimiento");
const { convertirAviso } = require("../scripts/unificar-codigos-avisos");

// El titular tiene hasta 48 horas para responder la solicitud de un familiar; si no, se da de baja.

test("el plazo del titular: 48 horas, sin pasar del día del ingreso ni del cierre de la inscripción al sorteo", () => {
  assert.equal(PLAZO_RESPUESTA_TITULAR_HORAS, 48);
  const ahora = new Date("2026-10-23T13:05:30.500Z"); // 23/10 10:05:30 en Argentina
  // Ingreso lejano: 48 horas justas (sin milisegundos)
  assert.equal(calcularVencimientoTitular({ fechaInicio: "2026-12-01", ahora }).toISOString(), "2026-10-25T13:05:30.000Z");
  // Ingreso mañana: hasta el fin de ese día (después ya no se puede aprobar)
  assert.equal(calcularVencimientoTitular({ fechaInicio: "2026-10-24", ahora }).toISOString(), "2026-10-25T02:59:59.000Z");
  // Sorteo cuya inscripción cierra hoy: hasta el fin de hoy
  assert.equal(calcularVencimientoTitular({ fechaInicio: "2027-01-10", finInscripcion: "2026-10-23", ahora }).toISOString(),
    "2026-10-24T02:59:59.000Z");
  // Fecha de mysql2 (DATE como Date) y sin fecha: 48 horas
  assert.equal(calcularVencimientoTitular({ fechaInicio: new Date(Date.UTC(2026, 9, 24)), ahora }).toISOString(), "2026-10-25T02:59:59.000Z");
  assert.equal(calcularVencimientoTitular({ fechaInicio: null, ahora }).toISOString(), "2026-10-25T13:05:30.000Z");
});

test("una solicitud vencida (todavía sin dar de baja) no frena una nueva; una vigente sí", async () => {
  const consultas = [];
  const conexion = (vencida) => ({ async query(sql, params) {
    consultas.push(sql);
    if (/SELECT r\.id, \(a\.vence_en/.test(sql)) return [[{ id: 7, vencida }]];
    if (/SELECT id, nombre FROM estado_reserva WHERE nombre IN/.test(sql)) {
      return [[{ id: 14, nombre: params[0] }, { id: 4, nombre: params[1] }]];
    }
    if (/SELECT a\.titular_usuario_id/.test(sql)) return [[{ titular_usuario_id: 10, usuario_id: 20, vence_en: null }]];
    if (/FROM bloque_fecha_recurso|SELECT/.test(sql)) return [[]];
    return [{ affectedRows: 1 }];
  } });
  await assert.rejects(asegurarSinSolicitudTitularPendiente(conexion(0), 20), { codigo: "RESERVA_PENDIENTE_TITULAR_EXISTENTE" });
  consultas.length = 0;
  await asegurarSinSolicitudTitularPendiente(conexion(1), 20);
  assert.ok(consultas.some((sql) => /SET decision = 'VENCIDA'/.test(sql)), "la vencida se da de baja");
  assert.ok(consultas.some((sql) => /INSERT INTO historial_reserva/.test(sql)));
});

test("el mantenimiento da de baja las vencidas con su propio lock; sin la migración no hace nada", async () => {
  const consultas = [];
  let cerradas = 0;
  const conexion = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() { cerradas += 1; },
    async query(sql, params) {
      consultas.push(sql);
      if (sql.includes("GET_LOCK")) return [[{ adquirido: 1 }]];
      if (sql.includes("RELEASE_LOCK")) return [[{ liberado: 1 }]];
      if (/FROM reserva_aprobacion_titular a\s+STRAIGHT_JOIN/.test(sql)) return [[{ reserva_id: 7 }, { reserva_id: 8 }]];
      if (/SELECT id, nombre FROM estado_reserva WHERE nombre IN/.test(sql)) return [[{ id: 14, nombre: params[0] }, { id: 4, nombre: params[1] }]];
      if (/UPDATE reserva SET estado_reserva_id/.test(sql)) return [{ affectedRows: params[1] === 7 ? 1 : 0 }]; // la 8 ya la resolvió otro
      if (/SELECT a\.titular_usuario_id/.test(sql)) return [[{ titular_usuario_id: 10, usuario_id: 20, vence_en: null }]];
      if (/^\s*SELECT/.test(sql) || /FROM bloque_fecha_recurso/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  const resultado = await expirarSolicitudesTitularVencidas({ getConnection: async () => conexion });
  assert.deepEqual(resultado, { ejecutado: true, solicitudes: 1 });
  assert.ok(consultas.some((sql) => /a\.vence_en <= NOW\(\)[\s\S]+FOR UPDATE SKIP LOCKED/.test(sql)));
  assert.ok(consultas.some((sql) => sql.includes("RELEASE_LOCK")));
  assert.equal(cerradas, 1);

  const sinColumna = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql) {
      if (sql.includes("GET_LOCK")) return [[{ adquirido: 1 }]];
      if (sql.includes("RELEASE_LOCK")) return [[{ liberado: 1 }]];
      throw Object.assign(new Error("Unknown column 'a.vence_en' in 'where clause'"), { code: "ER_BAD_FIELD_ERROR" });
    },
  };
  assert.deepEqual(await expirarSolicitudesTitularVencidas({ getConnection: async () => sinColumna }),
    { ejecutado: false, solicitudes: 0, omitido: "SIN_MIGRACION" });
  // Si otro proceso tiene el lock, no corre.
  const ocupado = { ...sinColumna, async query(sql) { return sql.includes("GET_LOCK") ? [[{ adquirido: 0 }]] : [[]]; } };
  assert.deepEqual(await expirarSolicitudesTitularVencidas({ getConnection: async () => ocupado }), { ejecutado: false, solicitudes: 0 });
});

test("migración del plazo: informa sin tocar, aplica una vez y es idempotente", async () => {
  let esquema = { tipoDecision: "enum('PENDIENTE','APROBADA','RECHAZADA','CANCELADA')", venceEn: false, indice: false };
  const ejecutadas = [];
  const conexion = { async query(sql) {
    ejecutadas.push(sql);
    if (sql.startsWith("SET SESSION")) return [{}];
    if (/information_schema\.COLUMNS/.test(sql)) {
      return [[{ nombre: "decision", tipo: esquema.tipoDecision }, ...(esquema.venceEn ? [{ nombre: "vence_en", tipo: "datetime" }] : [])]];
    }
    if (/information_schema\.STATISTICS/.test(sql)) return [esquema.indice ? [{ nombre: "idx_rat_vence" }] : []];
    if (/SELECT COUNT\(\*\)/.test(sql)) return [[{ n: 2 }]];
    if (/MODIFY COLUMN decision/.test(sql)) esquema.tipoDecision = `enum(${DECISIONES.map((d) => `'${d}'`).join(",")})`;
    if (/ADD COLUMN vence_en/.test(sql)) esquema.venceEn = true;
    if (/ADD INDEX idx_rat_vence/.test(sql)) esquema.indice = true;
    if (/^UPDATE reserva_aprobacion_titular SET vence_en/.test(sql)) return [{ affectedRows: 2 }];
    return [{}];
  } };
  const chequeo = await migrar(conexion, { checkOnly: true });
  assert.equal(chequeo.pendientes.length, 3);
  assert.equal(chequeo.solicitudes_sin_vencimiento, 2);
  assert.equal(ejecutadas.some((sql) => /^ALTER|^UPDATE/.test(sql)), false);
  // La sesión va en hora de Argentina antes de usar NOW()
  assert.equal(ejecutadas[0], "SET SESSION time_zone = '-03:00'");
  assert.deepEqual(await migrar(conexion), { aplicados: 3, solicitudes_con_plazo_nuevo: 2 });
  assert.ok(ejecutadas.some((sql) => /NOW\(\) \+ INTERVAL 48 HOUR/.test(sql)));
  assert.deepEqual((await migrar(conexion, { checkOnly: true })).pendientes, []);
});

test("avisos viejos: «#N» pasa al código de cada pantalla y nada más", () => {
  const casos = [
    [{ tipo: "RESERVA_APROBAR", titulo: "Reserva #34: Aprobada", mensaje: "Tu reserva #34 quedó aprobada." },
      { titulo: "Reserva T-34: Aprobada", mensaje: "Tu reserva T-34 quedó aprobada." }],
    [{ tipo: "RESERVA_CREADA_POR_TURISMO", titulo: "Nueva reserva de turismo #34", mensaje: "Cupón #2026 aplicado" },
      { titulo: "Nueva reserva de turismo T-34", mensaje: "Cupón #2026 aplicado" }],
    [{ tipo: "RESERVA_SALUD_PARA_CONTROL", titulo: "Subsidio por salud de la reserva #25 para aprobar", mensaje: null },
      { titulo: "Subsidio por salud de la reserva T-25 para aprobar", mensaje: null }],
    [{ tipo: "COSEGURO_PARA_CONTROL", titulo: "Solicitud #19 aprobada por departamental", mensaje: "La solicitud de reintegro #19 quedó lista." },
      { titulo: "Solicitud C-19 aprobada por departamental", mensaje: "La solicitud de reintegro C-19 quedó lista." }],
    [{ tipo: "TRASLADO_ESTADO", titulo: "Tu solicitud de traslado #7 pasó a \"Concretado\"", mensaje: "" },
      { titulo: "Tu solicitud de traslado TR-7 pasó a \"Concretado\"", mensaje: "" }],
    [{ tipo: "OLIMPIADA_ESTADO", titulo: "Inscripción #1 cancelada", mensaje: "Tu inscripción #12 fue cancelada." },
      { titulo: "Inscripción Nº 001 cancelada", mensaje: "Tu inscripción Nº 012 fue cancelada." }],
  ];
  for (const [aviso, esperado] of casos) assert.deepEqual(convertirAviso(aviso), esperado, aviso.titulo);
  // Lo ya convertido, otros módulos y números que no son códigos de trámite quedan igual.
  assert.equal(convertirAviso({ tipo: "RESERVA_OBSERVACION", titulo: "Nuevo mensaje en la reserva T-30", mensaje: "" }), null);
  assert.equal(convertirAviso({ tipo: "BENEFICIO_ESTADO", titulo: "Inscripción #3", mensaje: "" }), null);
  assert.equal(convertirAviso({ tipo: "OLIMPIADA_NUEVA", titulo: "Acompañante #2 agregado", mensaje: "" }), null);
});
