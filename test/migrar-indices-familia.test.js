"use strict";

// scripts/migrar-indices-familia.js: índices usuario(usuario_familiar_id) y
// reserva_familiar(usuario_id). Idempotente y sin duplicar índices que ya
// existan con otro nombre.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INDICES,
  buscarIndiceEquivalente,
  ejecutarMigracion,
  parsearArgumentos,
  validarDestino,
} = require("../scripts/migrar-indices-familia");

// Conexión falsa: `esquema` es { tabla: { indice: [columnas] } } y se actualiza
// con cada ADD INDEX que ejecuta el script.
function crearConexion(esquema) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params = []) {
      const texto = String(sql).replace(/\s+/g, " ").trim();
      consultas.push({ sql: texto, params });
      if (/FROM information_schema\.TABLES/.test(texto)) {
        return [[{ total: esquema[params[0]] ? 1 : 0 }]];
      }
      if (/FROM information_schema\.STATISTICS/.test(texto)) {
        const filas = Object.entries(esquema[params[0]] || {}).flatMap(([INDEX_NAME, columnas]) => (
          columnas.map((COLUMN_NAME, indice) => ({ INDEX_NAME, SEQ_IN_INDEX: indice + 1, COLUMN_NAME }))
        ));
        return [filas];
      }
      const alta = /^ALTER TABLE (\w+) ADD INDEX (\w+) \((\w+)\), ALGORITHM=INPLACE, LOCK=NONE$/.exec(texto);
      if (alta) {
        esquema[alta[1]][alta[2]] = [alta[3]];
        return [{ affectedRows: 0 }];
      }
      throw new Error(`Consulta inesperada: ${texto}`);
    },
  };
}

const ESQUEMA_ACTUAL = () => ({
  usuario: { PRIMARY: ["id"], documento_UNIQUE: ["documento"] },
  reserva_familiar: {
    PRIMARY: ["id"],
    reserva_id_idx: ["reserva_id"],
    // Empieza por reserva_id: no sirve para buscar por usuario_id.
    uq_rf_reserva_usuario: ["reserva_id", "usuario_id"],
  },
});

const silencio = () => {};

test("crea los dos índices en línea y una segunda corrida no hace nada", async () => {
  const esquema = ESQUEMA_ACTUAL();
  const conexion = crearConexion(esquema);
  const primera = await ejecutarMigracion(conexion, { log: silencio });
  assert.deepEqual(primera.creados, ["usuario.idx_usuario_familiar", "reserva_familiar.idx_rf_usuario"]);
  const altas = conexion.consultas.filter(({ sql }) => /^ALTER TABLE/.test(sql)).map(({ sql }) => sql);
  assert.deepEqual(altas, INDICES.map(({ ddl }) => ddl));
  assert.ok(altas.every((sql) => /ALGORITHM=INPLACE, LOCK=NONE$/.test(sql)));

  const otra = crearConexion(esquema);
  const segunda = await ejecutarMigracion(otra, { log: silencio });
  assert.deepEqual(segunda.creados, []);
  assert.deepEqual(segunda.existentes, ["usuario.idx_usuario_familiar", "reserva_familiar.idx_rf_usuario"]);
  assert.equal(otra.consultas.filter(({ sql }) => /^ALTER TABLE/.test(sql)).length, 0);
});

test("no duplica un índice que ya existe con otro nombre (también compuesto)", async () => {
  const esquema = ESQUEMA_ACTUAL();
  esquema.usuario.fk_usuario_familiar = ["usuario_familiar_id"];
  esquema.reserva_familiar.idx_rf_usuario_reserva = ["usuario_id", "reserva_id"];
  const conexion = crearConexion(esquema);
  const resultado = await ejecutarMigracion(conexion, { log: silencio });
  assert.deepEqual(resultado.creados, []);
  assert.deepEqual(resultado.existentes, ["usuario.fk_usuario_familiar", "reserva_familiar.idx_rf_usuario_reserva"]);
  assert.equal(conexion.consultas.filter(({ sql }) => /^ALTER TABLE/.test(sql)).length, 0);
});

test("--check sólo informa lo pendiente, sin DDL", async () => {
  const conexion = crearConexion(ESQUEMA_ACTUAL());
  const lineas = [];
  const resultado = await ejecutarMigracion(conexion, { checkOnly: true, log: (linea) => lineas.push(linea) });
  assert.deepEqual(resultado.pendientes, ["usuario.idx_usuario_familiar", "reserva_familiar.idx_rf_usuario"]);
  assert.equal(conexion.consultas.filter(({ sql }) => /^ALTER TABLE/.test(sql)).length, 0);
  assert.ok(lineas.some((linea) => /\[PENDIENTE\] ALTER TABLE usuario ADD INDEX idx_usuario_familiar/.test(linea)));
});

test("frena si el nombre del índice ya está tomado por otras columnas", () => {
  const indices = new Map([["idx_rf_usuario", ["reserva_id"]]]);
  assert.throws(
    () => buscarIndiceEquivalente(indices, INDICES[1]),
    /ya tiene un índice idx_rf_usuario sobre \(reserva_id\)/
  );
});

test("argumentos y destino: producción exige --allow-production", () => {
  assert.deepEqual(parsearArgumentos(["--check"]), { checkOnly: true, allowProduction: false });
  assert.throws(() => parsearArgumentos(["--force"]), /Argumentos desconocidos/);
  const remoto = { DB_HOST: "db.rds.test", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db_miajb" };
  assert.throws(() => validarDestino({ checkOnly: false, allowProduction: false }, remoto), /--allow-production/);
  assert.doesNotThrow(() => validarDestino({ checkOnly: true, allowProduction: false }, remoto));
  assert.doesNotThrow(() => validarDestino({ checkOnly: false, allowProduction: true }, remoto));
  assert.doesNotThrow(() => validarDestino(
    { checkOnly: false, allowProduction: false },
    { ...remoto, DB_HOST: "localhost" }
  ));
});
