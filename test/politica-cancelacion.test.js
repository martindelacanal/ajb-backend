"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  REGLAS_INICIALES, validarReglas, calcularCotizacion, validarAceptacionPolitica,
  cotizarCancelacion, confirmarCancelacionPolitica, crearVersionPolitica,
} = require("../api/services/politica-cancelacion");
const { parsearArgumentos, validarDestino, ejecutarMigracion } = require("../scripts/migrar-politicas-cancelacion");

const politica = { id: 3, version: 2, titulo: "Hospedajes", reglas: REGLAS_INICIALES };
const fila = { ...politica, reglas_json: JSON.stringify(REGLAS_INICIALES), creada_por: 1 };
const reserva = { id: 50, usuario_id: 20, fecha_inicio: "2026-10-22", estado_nombre: "Iniciada" };
const ahora = new Date("2026-10-07T12:00:00Z");

test("rangos cubren días 0, 6, 7, 14, 15 y posteriores sin huecos", () => {
  for (const [fecha, porcentaje] of [["2026-10-22", 100], ["2026-10-21", 50], ["2026-10-14", 50], ["2026-10-13", 0], ["2026-10-07", 0], ["2026-10-06", 0], ["2027-10-07", 100]]) {
    const resultado = calcularCotizacion({ reserva: { ...reserva, fecha_inicio: fecha }, politica, ahora });
    assert.equal(resultado.porcentaje_reintegro, porcentaje, fecha);
  }
});

test("el día cambia a medianoche de Argentina, no a medianoche UTC", () => {
  for (const [fechaCheckin, antes, despues] of [["2026-10-21", 100, 50], ["2026-10-13", 50, 0]]) {
    const a = calcularCotizacion({ reserva: { ...reserva, fecha_inicio: fechaCheckin }, politica, ahora: new Date("2026-10-07T02:59:59Z") });
    const b = calcularCotizacion({ reserva: { ...reserva, fecha_inicio: fechaCheckin }, politica, ahora: new Date("2026-10-07T03:00:00Z") });
    assert.equal(a.fecha_actual, "2026-10-06");
    assert.equal(b.fecha_actual, "2026-10-07");
    assert.equal(a.porcentaje_reintegro, antes);
    assert.equal(b.porcentaje_reintegro, despues);
    assert.notEqual(a.cotizacion, b.cotizacion);
  }
});

test("validación rechaza huecos, superposiciones, fin abierto intermedio, tipos inválidos y porcentajes fuera de rango", () => {
  for (const reglas of [[], [{ dias_desde: 1, dias_hasta: null, porcentaje_reintegro: 0 }],
    [{ dias_desde: 0, dias_hasta: 6, porcentaje_reintegro: 0 }, { dias_desde: 8, dias_hasta: null, porcentaje_reintegro: 50 }],
    [{ dias_desde: 0, dias_hasta: 7, porcentaje_reintegro: 0 }, { dias_desde: 7, dias_hasta: null, porcentaje_reintegro: 50 }],
    [{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro: 0 }, { dias_desde: 1, dias_hasta: null, porcentaje_reintegro: 50 }],
    [{ dias_desde: 0, dias_hasta: 7, porcentaje_reintegro: 0 }],
    ...[null, true, "", -1, 101, 2.111].map((porcentaje_reintegro) => [{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro }]),
    [{ dias_desde: null, dias_hasta: null, porcentaje_reintegro: 100 }],
    [{ dias_desde: 0, porcentaje_reintegro: 100 }]]) {
    assert.throws(() => validarReglas(reglas), { codigo: "POLITICA_INVALIDA" });
  }
  assert.deepEqual(validarReglas([...REGLAS_INICIALES].reverse()), REGLAS_INICIALES);
  assert.equal(validarReglas([{ dias_desde: 0, dias_hasta: null, porcentaje_reintegro: "75.25" }])[0].porcentaje_reintegro, 75.25);
});

test("aceptación explícita requiere la versión vigente y la bloquea durante el alta", async () => {
  const consultas = [];
  const db = { query: async (sql) => {
    consultas.push(sql);
    return sql.includes("SELECT politica_id") ? [[{ politica_id: 3 }]] : [[fila]];
  } };
  for (const aceptada of [false, undefined, "true", 1]) {
    await assert.rejects(validarAceptacionPolitica(db, { aceptada, politicaId: 3, version: 2 }), { codigo: "POLITICA_NO_ACEPTADA" });
  }
  assert.equal(consultas.length, 0);
  await assert.rejects(validarAceptacionPolitica(db, { aceptada: true, politicaId: 3, version: 1 }), { statusCode: 409, codigo: "POLITICA_ACTUALIZADA" });
  const aceptada = await validarAceptacionPolitica(db, { aceptada: true, politicaId: 3, version: 2 });
  assert.equal(aceptada.version, 2);
  assert.match(consultas[0], /LOCK IN SHARE MODE/);
});

test("una política aceptada conserva sus porcentajes aunque admin publique otra versión", async () => {
  const consultas = [];
  const db = { query: async (sql) => {
    consultas.push(sql);
    assert.match(sql, /FROM reserva_politica_cancelacion/);
    return [[{ snapshot_json: JSON.stringify(politica) }]];
  } };
  const cotizacion = await cotizarCancelacion(db, { reserva, ahora });
  assert.equal(cotizacion.politica.version, 2);
  assert.equal(cotizacion.porcentaje_reintegro, 100);
  assert.equal(cotizacion.origen_politica, "ACEPTADA");
  assert.equal(consultas.length, 1);
});

test("reservas anteriores consultan política vigente y dejan explícito que no tenían aceptación registrada", async () => {
  const db = { query: async (sql) => [sql.includes("FROM reserva_politica_cancelacion") ? [] : [fila]] };
  const cotizacion = await cotizarCancelacion(db, { reserva, ahora });
  assert.equal(cotizacion.origen_politica, "VIGENTE_RESERVA_ANTERIOR");
  assert.equal(cotizacion.porcentaje_reintegro, 100);
});

test("cancelación rechaza cotización vieja o sin consentimiento sin escribir auditoría", async () => {
  const escrituras = [];
  const db = { query: async (sql, params) => {
    if (sql.includes("SELECT snapshot_json")) return [[{ snapshot_json: politica }]];
    escrituras.push({ sql, params });
    return [{ affectedRows: 1 }];
  } };
  const cotizacion = calcularCotizacion({ reserva, politica, ahora }).cotizacion;
  await assert.rejects(confirmarCancelacionPolitica(db, { reserva, usuarioId: 20, confirmada: false, cotizacion, ahora }), { codigo: "CANCELACION_NO_CONFIRMADA" });
  await assert.rejects(confirmarCancelacionPolitica(db, { reserva, usuarioId: 20, confirmada: true, cotizacion, ahora: new Date("2026-10-08T03:00:00Z") }), { codigo: "COTIZACION_CANCELACION_ACTUALIZADA" });
  await assert.rejects(confirmarCancelacionPolitica(db, { reserva: { ...reserva, fecha_inicio: "2026-10-23" }, usuarioId: 20, confirmada: true, cotizacion, ahora }), { codigo: "COTIZACION_CANCELACION_ACTUALIZADA" });
  assert.equal(escrituras.length, 0);
  const resultado = await confirmarCancelacionPolitica(db, { reserva, usuarioId: 20, confirmada: true, cotizacion, ahora });
  assert.equal(resultado.porcentaje_reintegro, 100);
  assert.equal(escrituras.length, 2);
  assert.match(escrituras[0].sql, /INSERT INTO reserva_cancelacion_politica/);
  assert.equal(escrituras[0].params[3], 100);
  assert.match(escrituras[1].sql, /INSERT INTO historial_reserva/);
});

test("ediciones concurrentes usan el singleton y la segunda versión vieja se rechaza sin pisar el historial", async () => {
  let actual = { ...fila };
  const versiones = [actual];
  const consultas = [];
  const db = { query: async (sql, params) => {
    consultas.push(sql);
    if (sql.includes("SELECT politica_id")) return [[{ politica_id: actual.id }]];
    if (sql.startsWith("SELECT *")) return [[versiones.find((p) => p.id === params[0])]];
    if (sql.includes("INSERT INTO politica_cancelacion")) {
      versiones.push({ id: 4, version: params[0], titulo: params[1], reglas_json: params[2], motivo: params[3], creada_por: params[4] });
      return [{ insertId: 4 }];
    }
    if (sql.startsWith("UPDATE politica_cancelacion_vigente")) actual = versiones.at(-1);
    return [{ affectedRows: 1 }];
  } };
  const cambios = { versionActual: 2, titulo: "Política nueva", motivo: "Cambio aprobado", reglas: REGLAS_INICIALES, usuarioId: 1 };
  const publicada = await crearVersionPolitica(db, cambios);
  assert.equal(publicada.version, 3);
  await assert.rejects(crearVersionPolitica(db, cambios), { codigo: "POLITICA_ACTUALIZADA", statusCode: 409 });
  assert.equal(versiones.length, 2);
  assert.match(consultas[0], /FOR UPDATE/);
  assert.ok(!consultas.some((sql) => /^UPDATE politica_cancelacion SET/.test(sql)));
});

test("migración por defecto es sólo check y nunca escribe; producción requiere flag explícito", async () => {
  assert.deepEqual(parsearArgumentos(), { checkOnly: true, allowProduction: false });
  assert.throws(() => parsearArgumentos(["--check", "--apply"]));
  assert.throws(() => validarDestino({ checkOnly: false }, { DB_HOST: "remoto", DB_USER: "u", DB_PASSWORD: "p", DB_DATABASE: "d" }));
  const consultas = [];
  const resultado = await ejecutarMigracion({ query: async (sql) => { consultas.push(sql); return [[]]; } }, { log: () => {} });
  assert.equal(resultado.faltantes.length, 4);
  assert.ok(consultas.every((sql) => sql.trim().startsWith("SELECT")));
});
