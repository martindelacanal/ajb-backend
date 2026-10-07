"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ESTADO_PENDIENTE_TITULAR, MENSAJE_ADULTO, MENSAJE_CBU, obtenerGrupoReserva,
  exigirCbu, validarAdultoResponsable, decidirSolicitudTitular,
} = require("../api/services/reservas-familiares");

const titular = { id: 10, rol: "afiliado", habilitado: "Y", modulo_turismo: 1, cbu: "2850590940090418135201", usuario_familiar_id: null };
const familiar = { id: 20, rol: "invitado", habilitado: "Y", usuario_familiar_id: 10, es_familiar: "S", parentesco_id: 3, cbu: "" };

test("el CBU requerido pertenece al titular real y nunca se devuelve en elegibilidad", async () => {
  const conn = { query: async (_sql, params) => { assert.equal(params[0], 10); return [[titular]]; } };
  const grupo = await obtenerGrupoReserva(conn, familiar);
  assert.equal(grupo.requiereAprobacionTitular, true);
  assert.equal(grupo.titular.id, 10);
  assert.equal(grupo.cbuCompleto, true);
  exigirCbu(grupo);
  for (const cbu of [null, "", "   "]) {
    const vacio = await obtenerGrupoReserva(conn, { ...titular, cbu });
    assert.throws(() => exigirCbu(vacio), { message: MENSAJE_CBU, codigo: "CBU_REQUERIDO", statusCode: 422 });
  }
});

test("acompañante vinculado no obtiene derechos del titular y ciclos familiares fallan cerrados", async () => {
  const grupo = await obtenerGrupoReserva({ query() { throw new Error("No debe seguir vínculo de invitado"); } },
    { ...familiar, es_familiar: "N", parentesco_id: 5 });
  assert.equal(grupo.requiereAprobacionTitular, false);
  assert.equal(grupo.cbuCompleto, false);
  await assert.rejects(obtenerGrupoReserva({ query: async () => [[{ ...titular, usuario_familiar_id: 20 }]] }, familiar), { codigo: "TITULAR_INVALIDO" });
});

test("adulto responsable se calcula por cumpleaños exacto al check-in sin confiar en edad declarada", () => {
  const joven = { fecha_nacimiento: "2008-10-08", edad: 99 };
  assert.throws(() => validarAdultoResponsable([joven], "2026-10-07"), { message: MENSAJE_ADULTO });
  assert.deepEqual(validarAdultoResponsable([joven], "2026-10-08"), [18]);
  assert.deepEqual(validarAdultoResponsable([
    joven, { fecha_nacimiento: "2024-10-08" }, { fecha_nacimiento: "2024-10-09" },
  ], "2026-10-08"), [18, 2, 1]);
  assert.throws(() => validarAdultoResponsable([{ fecha_nacimiento: "2099-01-01" }], "2026-10-07"), { codigo: "FECHA_NACIMIENTO_INVALIDA" });
  assert.throws(() => validarAdultoResponsable([], "2026-10-07"), { codigo: "ADULTO_RESPONSABLE_REQUERIDO" });
});

function baseSimulada() {
  const reserva = { id: 7, usuario_id: 20, estado_reserva_id: 14, estado_nombre: ESTADO_PENDIENTE_TITULAR,
    decision: "PENDIENTE", estado_destino: "Iniciada", modalidad: "FECHA_LIBRE", fecha_inicio: "2099-10-10" };
  const consultas = [];
  let cola = Promise.resolve();
  function connection() {
    let liberar;
    return {
      async query(sql, params = []) {
        consultas.push({ sql, params });
        if (/SELECT solicitante_usuario_id/.test(sql)) return params[1] === 10 ? [[{ solicitante_usuario_id: 20 }]] : [[]];
        if (/WHERE u.id = \? FOR UPDATE/.test(sql)) {
          const anterior = cola;
          cola = new Promise((resolve) => { liberar = resolve; });
          await anterior;
          return [[familiar]];
        }
        if (/FROM usuario u INNER JOIN rol/.test(sql)) return [[titular]];
        if (/SELECT r.\*, er.nombre AS estado_nombre/.test(sql)) return [[{ ...reserva }]];
        if (/SELECT id FROM usuario/.test(sql)) return [[{ id: 20 }]];
        if (/SELECT id, nombre FROM estado_reserva/.test(sql)) return [[{ id: 1, nombre: "Iniciada" }, { id: 4, nombre: "Rechazada" }]];
        if (/FROM reserva r/.test(sql)) return [[]];
        if (/SELECT id FROM estado_reserva/.test(sql)) return [[{ id: params[0] === "Iniciada" ? 1 : 4 }]];
        if (/UPDATE reserva SET/.test(sql)) {
          if (reserva.estado_reserva_id !== params[2]) return [{ affectedRows: 0 }];
          reserva.estado_reserva_id = params[0];
          reserva.estado_nombre = params[0] === 1 ? "Iniciada" : "Rechazada";
        }
        if (/UPDATE reserva_aprobacion_titular SET decision/.test(sql)) reserva.decision = params[0];
        if (/FROM bloque_fecha_recurso/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
      },
      finish() { liberar?.(); },
    };
  }
  async function resolver(accion, actorId = 10) {
    const conn = connection();
    try { return await decidirSolicitudTitular(conn, { reservaId: 7, actorId, accion }); }
    finally { conn.finish(); }
  }
  return { resolver, consultas, reserva };
}

test("solo el titular asociado decide y una acción repetida no altera reserva ni auditoría", async () => {
  const db = baseSimulada();
  await assert.rejects(db.resolver("APROBAR", 20), { codigo: "APROBACION_TITULAR_NO_AUTORIZADA" });
  await assert.rejects(db.resolver("APROBAR", 999), { codigo: "APROBACION_TITULAR_NO_AUTORIZADA" });
  assert.equal((await db.resolver("APROBAR")).estado, "Iniciada");
  await assert.rejects(db.resolver("RECHAZAR"), { codigo: "APROBACION_TITULAR_RESUELTA" });
  assert.equal(db.consultas.filter((c) => /INSERT INTO historial_reserva/.test(c.sql)).length, 1);
});

test("dos decisiones simultáneas se serializan y sólo una confirma", async () => {
  const db = baseSimulada();
  const resultados = await Promise.allSettled([db.resolver("APROBAR"), db.resolver("RECHAZAR")]);
  assert.equal(resultados.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(resultados.find((r) => r.status === "rejected").reason.codigo, "APROBACION_TITULAR_RESUELTA");
  assert.equal(db.consultas.filter((c) => /INSERT INTO notificacion/.test(c.sql)).length, 1);
});

test("rechazar libera recursos y avisa al solicitante sin pasar por administración", async () => {
  const db = baseSimulada();
  const respuesta = await db.resolver("RECHAZAR");
  assert.equal(respuesta.estado, "Rechazada");
  assert.equal(db.consultas.some((c) => /FROM bloque_fecha_recurso/.test(c.sql)), true);
  assert.equal(db.consultas.find((c) => /INSERT INTO notificacion/.test(c.sql)).params[0], 20);
});

test("la migración puede chequearse sin escrituras y reaplicarse sin duplicar el estado", async () => {
  const { migrar } = require("../scripts/migrar-reservas-aprobacion-titular");
  let estado = false;
  let tabla = false;
  let altasEstado = 0;
  const consultas = [];
  const db = { async query(sql) {
    consultas.push(sql);
    if (/SELECT id FROM estado_reserva/.test(sql)) return [estado ? [{ id: 14 }] : []];
    if (/information_schema.TABLES/.test(sql)) return [tabla ? [{ TABLE_NAME: "reserva_aprobacion_titular" }] : []];
    if (/CREATE TABLE/.test(sql)) tabla = true;
    if (/INSERT INTO estado_reserva/.test(sql)) { estado = true; altasEstado++; }
    return [{ affectedRows: 1 }];
  } };
  assert.deepEqual(await migrar(db, { checkOnly: true }), { estado: false, tabla: false });
  assert.equal(consultas.every((sql) => sql.startsWith("SELECT")), true);
  assert.deepEqual(await migrar(db), { estado: true, tabla: true });
  assert.deepEqual(await migrar(db), { estado: true, tabla: true });
  assert.equal(altasEstado, 1);
});
