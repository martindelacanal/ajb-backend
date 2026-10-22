"use strict";

// scripts/rehabilitar-tarifas-temporada.js: lista lo dado de baja, simula y rehabilita
// un lote en una transacción, y nunca rehabilita si choca con tarifas vigentes.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aplicarRehabilitacion,
  listarTemporada,
  main,
  parsearArgumentos,
  prepararRehabilitacion,
  validarDestino,
} = require("../scripts/rehabilitar-tarifas-temporada");

const LOTE = "0f8fad5b-d9cb-469f-a165-70867728950e";

function escenarioBase() {
  return {
    temporada: { id: 28, nombre: "Verano 2027", origen: "GENERAL", fecha_inicio: "2026-12-15", fecha_fin: "2027-03-07" },
    tarifas: [
      { id: 901, recurso_id: 6, regimen_id: 2, motivo: "QUITADO", desde: "2026-12-15", hasta: "2027-01-31" },
      { id: 902, recurso_id: 6, regimen_id: 2, motivo: "QUITADO", desde: "2027-02-01", hasta: "2027-03-07" },
    ],
    adicionales: [{ id: 77, recurso_id: 6, regimen_id: 2, adicional_id: 4, motivo: "QUITADO" }],
    choques: { mismaTemporada: [], otrasTemporadas: [], fueraDeRango: [], sinRegimen: [], adicionales: [], adicionalesFuera: [] },
    usuarioExiste: true,
  };
}

function crearConexion(escenario) {
  const consultas = [];
  const conexion = {
    consultas,
    transaccion: [],
    terminada: false,
    async beginTransaction() { conexion.transaccion.push("BEGIN"); },
    async commit() { conexion.transaccion.push("COMMIT"); },
    async rollback() { conexion.transaccion.push("ROLLBACK"); },
    async end() { conexion.terminada = true; },
    async query(sql, params = []) {
      const texto = String(sql).replace(/\s+/g, " ").trim();
      consultas.push({ sql: texto, params });
      if (/^SELECT temporada_tarifa_id FROM tarifa WHERE eliminado_lote = \? UNION/.test(texto)) {
        return [[{ temporada_tarifa_id: escenario.temporada.id }]];
      }
      if (/FROM temporada_tarifa WHERE id = \?/.test(texto)) return [[escenario.temporada]];
      if (/FROM bloque_fecha WHERE temporada_tarifa_id = \? LIMIT 1/.test(texto)) return [[]];
      if (/FROM tarifa t WHERE t\.eliminado_lote = \? AND t\.eliminado = 1/.test(texto)) return [escenario.tarifas];
      if (/FROM tarifa_adicional ta WHERE ta\.eliminado_lote = \? AND ta\.activo = 0/.test(texto)) return [escenario.adicionales];
      if (/ON b\.temporada_tarifa_id = a\.temporada_tarifa_id/.test(texto)) return [escenario.choques.mismaTemporada];
      if (/AND b\.temporada_tarifa_id <> a\.temporada_tarifa_id/.test(texto)) return [escenario.choques.otrasTemporadas];
      if (/FROM tarifa t INNER JOIN temporada_tarifa tt .*\(t\.fecha_inicio < tt\.fecha_inicio/.test(texto)) return [escenario.choques.fueraDeRango];
      if (/LEFT JOIN servicio_regimen sr/.test(texto)) return [escenario.choques.sinRegimen];
      if (/FROM tarifa_adicional a INNER JOIN tarifa_adicional b/.test(texto)) return [escenario.choques.adicionales];
      if (/FROM tarifa_adicional ta INNER JOIN temporada_tarifa tt/.test(texto)) return [escenario.choques.adicionalesFuera];
      if (/^SELECT id FROM usuario WHERE id = \?/.test(texto)) return [escenario.usuarioExiste ? [{ id: params[0] }] : []];
      if (/^UPDATE tarifa SET eliminado = 0/.test(texto)) return [{ affectedRows: params[0].length }];
      if (/^UPDATE tarifa_adicional SET activo = 1/.test(texto)) return [{ affectedRows: params[0].length }];
      if (/^INSERT INTO historial_temporada/.test(texto)) return [{ insertId: 1 }];
      throw new Error(`Consulta inesperada: ${texto}`);
    },
  };
  return conexion;
}

const silencio = () => {};
const opciones = (extra = {}) => ({ ...parsearArgumentos([`--lote=${LOTE}`]), ...extra });
const escrituras = (conexion) => conexion.consultas.filter(({ sql }) => /^(UPDATE|INSERT|DELETE)/.test(sql));

test("argumentos: --temporada lista, --lote simula y --aplicar exige --usuario", () => {
  assert.equal(parsearArgumentos(["--temporada=28"]).temporadaId, 28);
  assert.deepEqual(
    parsearArgumentos([`--lote=${LOTE.toUpperCase()}`, "--recurso=6", "--regimen=2", "--motivo=todos"]),
    { temporadaId: null, lote: LOTE, recursoId: 6, regimenId: 2, motivo: "TODOS", aplicar: false, usuarioId: null, allowProduction: false }
  );
  assert.throws(() => parsearArgumentos([]), /--temporada=ID/);
  assert.throws(() => parsearArgumentos(["--temporada=28", `--lote=${LOTE}`]), /--temporada=ID/);
  assert.throws(() => parsearArgumentos(["--lote=abc"]), /UUID/);
  assert.throws(() => parsearArgumentos([`--lote=${LOTE}`, "--recurso=6"]), /van juntos/);
  assert.throws(() => parsearArgumentos([`--lote=${LOTE}`, "--aplicar"]), /--usuario/);
  assert.throws(() => parsearArgumentos(["--temporada=28", "--aplicar"]), /van con --lote/);
  assert.throws(() => parsearArgumentos([`--lote=${LOTE}`, "--motivo=OTRO"]), /--motivo/);
  assert.throws(() => parsearArgumentos(["--borrar"]), /Argumento desconocido/);
});

test("sólo --aplicar contra una base remota exige --allow-production", () => {
  const remoto = { DB_HOST: "db.rds.test", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db_miajb" };
  assert.doesNotThrow(() => validarDestino(parsearArgumentos(["--temporada=28"]), remoto));
  assert.doesNotThrow(() => validarDestino(opciones(), remoto));
  const aplicar = parsearArgumentos([`--lote=${LOTE}`, "--aplicar", "--usuario=1"]);
  assert.throws(() => validarDestino(aplicar, remoto), /--allow-production/);
  assert.doesNotThrow(() => validarDestino({ ...aplicar, allowProduction: true }, remoto));
  assert.doesNotThrow(() => validarDestino(aplicar, { ...remoto, DB_HOST: "127.0.0.1" }));
});

test("la simulación muestra qué se rehabilitaría, filtra por motivo y no escribe nada", async () => {
  const conexion = crearConexion(escenarioBase());
  const plan = await prepararRehabilitacion(conexion, opciones({ recursoId: 6, regimenId: 2 }));
  assert.equal(plan.tarifas.length, 2);
  assert.equal(plan.adicionales.length, 1);
  assert.deepEqual(plan.pares, [{
    recurso_id: 6, regimen_id: 2, motivo: "QUITADO", tarifas: 2, adicionales: 1, desde: "2026-12-15", hasta: "2027-03-07",
  }]);
  assert.deepEqual(plan.choques, []);
  const candidatas = conexion.consultas.find(({ sql }) => /FROM tarifa t WHERE t\.eliminado_lote = \?/.test(sql));
  assert.match(candidatas.sql, /AND t\.recurso_id = \? AND t\.regimen_id = \? AND t\.eliminado_motivo = \?/);
  assert.deepEqual(candidatas.params, [LOTE, 6, 2, "QUITADO"]);
  assert.doesNotMatch(candidatas.sql, /FOR UPDATE/);
  assert.deepEqual(escrituras(conexion), []);
});

test("informa los choques con vigentes, fechas y adicionales", async () => {
  const escenario = escenarioBase();
  escenario.choques.mismaTemporada = [{ tarifa_id: 901, vigente_id: 950, recurso_id: 6, regimen_id: 2, desde: "2027-01-01", hasta: "2027-01-31" }];
  escenario.choques.otrasTemporadas = [{ tarifa_id: 902, vigente_id: 960, recurso_id: 6, temporada_id: 27, temporada: "Primavera", origen: "GENERAL", desde: "2027-02-01", hasta: "2027-02-10" }];
  escenario.choques.fueraDeRango = [{ id: 902, desde: "2027-02-01", hasta: "2027-03-07" }];
  escenario.choques.adicionales = [{ tarifa_adicional_id: 77, vigente_id: 80, recurso_id: 6, regimen_id: 2, adicional_id: 4, temporada_id: 28, desde: "2027-01-01", hasta: "2027-01-31" }];
  const plan = await prepararRehabilitacion(crearConexion(escenario), opciones());
  assert.equal(plan.choques.length, 4);
  assert.match(plan.choques[0], /ya tiene la tarifa vigente 950 del 2027-01-01 al 2027-01-31 en esta temporada/);
  assert.match(plan.choques[1], /temporada 27 «Primavera»/);
  assert.match(plan.choques[2], /fuera de las fechas actuales de la temporada/);
  assert.match(plan.choques[3], /Adicional 4 del recurso 6/);
});

test("una temporada de bloque que ya nadie usa no se rehabilita", async () => {
  const escenario = escenarioBase();
  escenario.temporada = { ...escenario.temporada, origen: "BLOQUE" };
  const plan = await prepararRehabilitacion(crearConexion(escenario), opciones({ motivo: "TODOS" }));
  assert.equal(plan.choques.length, 1);
  assert.match(plan.choques[0], /ningún bloque la usa/);
});

test("--aplicar rehabilita en una transacción, bloquea la temporada y deja historial", async () => {
  const conexion = crearConexion(escenarioBase());
  const resultado = await aplicarRehabilitacion(conexion, opciones({ aplicar: true, usuarioId: 1 }), { log: silencio });
  assert.deepEqual(resultado.rehabilitadas, { tarifas: 2, adicionales: 1 });
  assert.deepEqual(conexion.transaccion, ["BEGIN", "COMMIT"]);

  // La temporada del lote se busca antes de la transacción; lo primero adentro es su bloqueo.
  assert.match(conexion.consultas[0].sql, /^SELECT temporada_tarifa_id FROM tarifa WHERE eliminado_lote = \? UNION/);
  assert.match(conexion.consultas[1].sql, /FROM temporada_tarifa WHERE id = \? FOR UPDATE$/);
  assert.match(conexion.consultas.find(({ sql }) => /FROM tarifa t WHERE t\.eliminado_lote/.test(sql)).sql, /FOR UPDATE$/);

  const [tarifas, adicionales, historial] = escrituras(conexion);
  assert.match(tarifas.sql, /^UPDATE tarifa SET eliminado = 0, fecha_eliminacion = NULL, eliminado_usuario_id = NULL, eliminado_motivo = NULL, eliminado_lote = NULL WHERE id IN \(\?\) AND eliminado = 1$/);
  assert.deepEqual(tarifas.params, [[901, 902]]);
  assert.match(adicionales.sql, /^UPDATE tarifa_adicional SET activo = 1, .* WHERE id IN \(\?\) AND activo = 0$/);
  assert.deepEqual(adicionales.params, [[77]]);
  assert.match(historial.sql, /^INSERT INTO historial_temporada/);
  assert.equal(historial.params[0], 28);
  assert.equal(historial.params[1], 1);
  assert.deepEqual(JSON.parse(historial.params[2]), { baja_logica: true, lote: LOTE, motivo: "QUITADO", recurso_id: null, regimen_id: null });
  const nuevo = JSON.parse(historial.params[3]);
  assert.equal(nuevo.accion, "rehabilitar");
  assert.equal(nuevo.tarifas, 2);
});

test("--aplicar con choques no escribe nada y deshace la transacción", async () => {
  const escenario = escenarioBase();
  escenario.choques.otrasTemporadas = [{ tarifa_id: 901, vigente_id: 960, recurso_id: 6, temporada_id: 27, temporada: "Primavera", origen: "GENERAL", desde: "2027-01-01", hasta: "2027-01-10" }];
  const conexion = crearConexion(escenario);
  await assert.rejects(
    () => aplicarRehabilitacion(conexion, opciones({ aplicar: true, usuarioId: 1 }), { log: silencio }),
    /No se rehabilitó nada/
  );
  assert.deepEqual(conexion.transaccion, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(escrituras(conexion), []);
});

test("--aplicar sin nada QUITADO sugiere --motivo y no escribe", async () => {
  const escenario = escenarioBase();
  escenario.tarifas = [];
  escenario.adicionales = [];
  const conexion = crearConexion(escenario);
  await assert.rejects(
    () => aplicarRehabilitacion(conexion, opciones({ aplicar: true, usuarioId: 1 }), { log: silencio }),
    /--motivo=REEMPLAZADO/
  );
  assert.deepEqual(escrituras(conexion), []);
});

test("--temporada lista los lotes con sus pares y cierra la conexión", async () => {
  const consultas = [];
  const conexion = {
    terminada: false,
    async end() { conexion.terminada = true; },
    async query(sql, params) {
      consultas.push({ sql, params });
      if (/FROM temporada_tarifa/.test(sql)) return [[escenarioBase().temporada]];
      if (/AS tarifas,/.test(sql)) return [[{ tarifas: 909, adicionales: 40 }]];
      if (/FROM tarifa t\s+LEFT JOIN recurso r/.test(sql)) {
        return [[
          { lote: LOTE, motivo: "QUITADO", fecha: "2026-10-21 10:00", usuario_id: 1, servicio_id: 11, servicio: "Camping", regimen_id: 2, regimen: "Sin comida", recurso_id: 6, recurso: "Parcela", filas: 2, desde: "2026-12-15", hasta: "2027-03-07" },
          { lote: LOTE, motivo: "REEMPLAZADO", fecha: "2026-10-21 10:00", usuario_id: 1, servicio_id: 10, servicio: "Hotel", regimen_id: 2, regimen: "Media pensión", recurso_id: 5, recurso: "Habitación", filas: 3, desde: "2026-12-15", hasta: "2027-03-07" },
        ]];
      }
      if (/FROM tarifa_adicional\s+WHERE temporada_tarifa_id = \? AND activo = 0/.test(sql)) {
        return [[{ lote: LOTE, motivo: "QUITADO", filas: 1 }, { lote: null, motivo: null, filas: 3 }]];
      }
      if (/SELECT id, nombre, apellido FROM usuario WHERE id IN/.test(sql)) return [[{ id: 1, nombre: "Ana", apellido: "Pérez" }]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  const lineas = [];
  const listado = await main({
    argv: ["--temporada=28"],
    env: { DB_HOST: "localhost", DB_USER: "root", DB_PASSWORD: "x", DB_DATABASE: "db" },
    conectar: async () => conexion,
    log: (linea) => lineas.push(linea),
  });
  assert.equal(conexion.terminada, true);
  assert.equal(listado.lotes.length, 1);
  assert.deepEqual(listado.lotes[0].motivos, { QUITADO: 2, REEMPLAZADO: 3 });
  assert.equal(listado.lotes[0].adicionales, 1);
  assert.equal(listado.adicionalesLegado, 3);
  assert.ok(lineas.some((linea) => linea.includes(`Lote ${LOTE} · 2026-10-21 10:00 · usuario 1 (Pérez, Ana)`)));
  assert.ok(lineas.some((linea) => /QUITADO: Camping › Sin comida \(régimen 2\) › Parcela \(recurso 6\)/.test(linea)));
  const [listadoSql] = consultas.filter(({ sql }) => /FROM tarifa t\s+LEFT JOIN recurso r/.test(sql));
  assert.match(listadoSql.sql, /WHERE t\.temporada_tarifa_id = \? AND t\.eliminado = 1/);
  assert.equal(consultas.some(({ sql }) => /^\s*(UPDATE|INSERT|DELETE)/.test(sql)), false);
});
