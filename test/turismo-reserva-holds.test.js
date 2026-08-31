"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  adquirirHoldTurismo,
  consumirHoldEnTransaccion,
  crearEventoInvalidacionHold,
  generarTokenHold,
  HOLD_TTL_MINUTOS,
  hashTokenHold,
  mapearHold,
  validarHoldParaReservaEnTransaccion,
} = require("../api/services/turismo-reserva-holds");
const {
  CREATE_TABLE_SQL,
  compactarSql,
  ejecutarMigracion,
  parsearArgumentos,
  validarApplySeguro,
} = require("../scripts/migrar-turismo-holds-v1");

const TOKEN = "a".repeat(64);

function filaHold(overrides = {}) {
  const ahora = Date.now();
  return {
    id: 91,
    actor_usuario_id: 12,
    titular_usuario_id: 12,
    servicio_id: 2,
    recurso_id: 7,
    bloque_fecha_id: null,
    modalidad: "FECHA_LIBRE",
    fecha_inicio: "2026-09-10",
    fecha_fin: "2026-09-13",
    numero_parcela: null,
    estado: "ACTIVO",
    reserva_id: null,
    expira_en_ms: ahora + 20 * 60 * 1000,
    servidor_ahora_ms: ahora,
    ...overrides,
  };
}

test("el token opaco se persiste como SHA-256 binario y nunca aparece en el mapeo", () => {
  const token = generarTokenHold();
  assert.ok(token.length >= 32);
  const hash = hashTokenHold(token);
  assert.ok(Buffer.isBuffer(hash));
  assert.equal(hash.length, 32);
  assert.equal(hash.equals(hashTokenHold(token)), true);
  assert.equal(hash.equals(hashTokenHold(`${token}x`)), false);
  assert.equal(Object.hasOwn(mapearHold(filaHold()), "hold_token"), false);
});

test("el contrato público usa reloj de servidor y segundos restantes", () => {
  const ahora = Date.now();
  const hold = mapearHold(filaHold({
    servidor_ahora_ms: ahora,
    expira_en_ms: ahora + 90_900,
  }));
  assert.equal(hold.segundos_restantes, 90);
  assert.match(hold.expira_en, /Z$/);
  assert.match(hold.servidor_ahora, /Z$/);
  assert.equal(Object.hasOwn(hold, "vence_en"), false);
});

test("la validación final bloquea el hold y exige coincidencia null-safe del titular", async () => {
  const consultas = [];
  const connection = {
    async query(sql) {
      consultas.push(sql);
      return [[filaHold()]];
    },
  };
  const resultado = await validarHoldParaReservaEnTransaccion(connection, {
    actorUsuarioId: 12,
    titularUsuarioId: 12,
    servicioId: 2,
    recursoId: 7,
    bloqueFechaId: null,
    modalidad: "FECHA_LIBRE",
    fechaInicio: "2026-09-10",
    fechaFin: "2026-09-13",
    holdId: 91,
    holdToken: TOKEN,
  });
  assert.equal(resultado.id, 91);
  assert.match(consultas[0], /FOR UPDATE/);

  const sinTitular = { query: async () => [[filaHold({ titular_usuario_id: null })]] };
  await assert.rejects(
    validarHoldParaReservaEnTransaccion(sinTitular, {
      actorUsuarioId: 12,
      titularUsuarioId: 12,
      servicioId: 2,
      recursoId: 7,
      bloqueFechaId: null,
      modalidad: "FECHA_LIBRE",
      fechaInicio: "2026-09-10",
      fechaFin: "2026-09-13",
      holdToken: TOKEN,
    }),
    (error) => error.codigo === "HOLD_DATOS_NO_COINCIDEN"
  );
});

test("un hold vencido devuelve el código amigable exacto aun sin worker", async () => {
  const connection = {
    async query(sql) {
      if (/^\s*SELECT/i.test(sql)) {
        return [[filaHold({ expira_en_ms: Date.now() - 1_000 })]];
      }
      return [{ affectedRows: 1 }];
    },
  };
  await assert.rejects(
    validarHoldParaReservaEnTransaccion(connection, {
      actorUsuarioId: 12,
      titularUsuarioId: 12,
      servicioId: 2,
      recursoId: 7,
      modalidad: "FECHA_LIBRE",
      fechaInicio: "2026-09-10",
      fechaFin: "2026-09-13",
      holdToken: TOKEN,
    }),
    (error) => error.statusCode === 410
      && error.codigo === "HOLD_VENCIDO"
      && error.message === "Se terminó el tiempo para completar la reserva. Liberamos el alojamiento para que otras personas puedan elegirlo."
  );
});

test("consumir es una operación atómica condicionada a ACTIVO y no vencido", async () => {
  let sqlEjecutado = "";
  const connection = {
    async query(sql) {
      sqlEjecutado = sql;
      return [{ affectedRows: 1 }];
    },
  };
  await consumirHoldEnTransaccion(connection, { holdId: 91, reservaId: 501 });
  assert.match(sqlEjecutado, /estado = 'CONSUMIDO'/);
  assert.match(sqlEjecutado, /estado = 'ACTIVO' AND vence_en > NOW\(6\)/);

  connection.query = async () => [{ affectedRows: 0 }];
  await assert.rejects(
    consumirHoldEnTransaccion(connection, { holdId: 91, reservaId: 501 }),
    (error) => error.codigo === "HOLD_VENCIDO" && error.statusCode === 410
  );
});

test("el DDL impone exclusión concurrente por actor y conserva sólo el hash", () => {
  assert.match(CREATE_TABLE_SQL, /token_hash BINARY\(32\) NOT NULL/);
  assert.doesNotMatch(CREATE_TABLE_SQL, /hold_token/i);
  assert.match(CREATE_TABLE_SQL, /actor_activo_id INT GENERATED ALWAYS/);
  assert.match(CREATE_TABLE_SQL, /UNIQUE KEY uq_trh_actor_activo \(actor_activo_id\)/);
  assert.match(CREATE_TABLE_SQL, /UNIQUE KEY uq_trh_token_hash \(token_hash\)/);
  assert.match(CREATE_TABLE_SQL, /estado ENUM\('ACTIVO','CONSUMIDO','LIBERADO','VENCIDO'\)/);
});

test("reemplazar una opción no renueva los veinte minutos originales", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "api", "services", "turismo-reserva-holds.js"),
    "utf8"
  );
  const updateReemplazo = source.match(/SET titular_usuario_id[\s\S]+?WHERE id = \? AND estado = 'ACTIVO' AND vence_en > NOW\(6\)/)?.[0];
  assert.ok(updateReemplazo);
  assert.doesNotMatch(updateReemplazo, /SET[\s\S]*vence_en\s*=/);
  assert.equal(HOLD_TTL_MINUTOS, 20);
  assert.match(source, /DATE_ADD\(NOW\(6\), INTERVAL \$\{HOLD_TTL_MINUTOS\} MINUTE\)/);
});

test("check y apply son mutuamente excluyentes y una DB remota exige TLS también en check", () => {
  assert.equal(parsearArgumentos(["--check"]).checkOnly, true);
  assert.equal(parsearArgumentos(["--apply"]).apply, true);
  assert.throws(() => parsearArgumentos([]), /exactamente uno/);
  assert.throws(() => parsearArgumentos(["--check", "--apply"]), /exactamente uno/);
  assert.throws(
    () => validarApplySeguro(parsearArgumentos(["--check"]), {
      DB_HOST: "db.example.internal",
      DB_SSL_MODE: "disabled",
    }),
    /verify-full/
  );
});

test("el modo --check inspecciona el esquema sin ejecutar DDL ni DML", async () => {
  const consultas = [];
  const connection = {
    async query(sql, params = []) {
      consultas.push(sql.trim());
      if (/information_schema\.TABLES/i.test(sql)) {
        return [params[0] === "turismo_reserva_hold"
          ? []
          : [{ TABLE_NAME: params[0], ENGINE: "InnoDB" }]];
      }
      if (/information_schema\.COLUMNS/i.test(sql)) return [[{ COLUMN_TYPE: "int" }]];
      throw new Error(`Consulta inesperada en check: ${sql}`);
    },
  };
  await ejecutarMigracion(connection, { checkOnly: true });
  assert.ok(consultas.length >= 6);
  assert.equal(consultas.every((sql) => /^SELECT/i.test(sql)), true);
});

test("la verificación acepta los introductores de charset que devuelve MySQL 8.4", () => {
  assert.equal(
    compactarSql("((`modalidad` = _utf8mb4'FECHA_LIBRE') and (`bloque_fecha_id` is null))"),
    compactarSql("modalidad = 'FECHA_LIBRE' AND bloque_fecha_id IS NULL")
  );
  assert.equal(
    compactarSql("(`estado` <> _utf8mb4'CONSUMIDO')"),
    compactarSql("estado <> 'CONSUMIDO'")
  );
  assert.equal(
    compactarSql("(case when (`estado` = _utf8mb4\\'ACTIVO\\') then `actor_usuario_id` else NULL end)"),
    compactarSql("case when estado = 'ACTIVO' then actor_usuario_id else NULL end")
  );
});

test("el evento de invalidación no contiene actor, titular ni token", () => {
  const evento = crearEventoInvalidacionHold(filaHold(), "HOLD_CREADO");
  assert.deepEqual(evento.servicio_ids, [2]);
  assert.equal(evento.motivo, "HOLD_CREADO");
  assert.equal(Object.hasOwn(evento, "actor_usuario_id"), false);
  assert.equal(Object.hasOwn(evento, "titular_usuario_id"), false);
  assert.equal(Object.hasOwn(evento, "hold_token"), false);
});

test("dos adquisiciones concurrentes del mismo recurso dejan un solo ganador", async () => {
  const filas = [];
  let siguienteId = 1;
  let recursoBloqueado = false;
  const esperas = [];

  async function tomarLockRecurso() {
    if (!recursoBloqueado) {
      recursoBloqueado = true;
      return;
    }
    await new Promise((resolve) => esperas.push(resolve));
    recursoBloqueado = true;
  }

  function liberarLockRecurso(connection) {
    if (!connection.tieneLockRecurso) return;
    connection.tieneLockRecurso = false;
    recursoBloqueado = false;
    esperas.shift()?.();
  }

  function nuevaConexion() {
    const connection = {
      tieneLockRecurso: false,
      async beginTransaction() {},
      async commit() { liberarLockRecurso(connection); },
      async rollback() { liberarLockRecurso(connection); },
      release() { liberarLockRecurso(connection); },
      async query(sql, params = []) {
        if (/FROM usuario u[\s\S]*INNER JOIN rol/i.test(sql)) {
          return [params.map((id) => ({
            id,
            habilitado: "Y",
            departamental_id: 1,
            modulo_turismo: 1,
            rol: "afiliado",
          }))];
        }
        if (/h\.actor_usuario_id = \?[\s\S]*h\.estado = 'ACTIVO'/i.test(sql)) {
          return [[...filas.filter((fila) => fila.actor_usuario_id === Number(params[0]) && fila.estado === "ACTIVO")]];
        }
        if (/SELECT r\.id, r\.servicio_id[\s\S]*FROM recurso r/i.test(sql)) {
          await tomarLockRecurso();
          connection.tieneLockRecurso = true;
          return [[{
            id: 7,
            servicio_id: 2,
            cupo_maximo: null,
            es_recurso_principal: 0,
            max_personas_reserva: 6,
            modelo_tarifa: "TEMPORADAS",
            tipo_codigo: "ALOJAMIENTO_RECURSO",
          }]];
        }
        if (/WHERE token_hash = \?/i.test(sql)) return [[]];
        if (/FROM bloque_fecha bf/i.test(sql)) return [[]];
        if (/FROM reserva r/i.test(sql)) return [[]];
        if (/SELECT id, actor_usuario_id, numero_parcela[\s\S]*FROM turismo_reserva_hold/i.test(sql)) {
          return [[...filas.filter((fila) => fila.recurso_id === 7 && fila.estado === "ACTIVO")]];
        }
        if (/INSERT INTO turismo_reserva_hold/i.test(sql)) {
          const ahora = Date.now();
          const fila = filaHold({
            id: siguienteId++,
            token_hash: params[0],
            actor_usuario_id: Number(params[1]),
            titular_usuario_id: Number(params[2]),
            servicio_id: Number(params[3]),
            recurso_id: Number(params[4]),
            bloque_fecha_id: params[5],
            modalidad: params[6],
            fecha_inicio: params[7],
            fecha_fin: params[8],
            numero_parcela: params[9],
            expira_en_ms: ahora + 20 * 60 * 1000,
            servidor_ahora_ms: ahora,
          });
          filas.push(fila);
          return [{ insertId: fila.id, affectedRows: 1 }];
        }
        if (/FROM turismo_reserva_hold h[\s\S]*WHERE h\.id = \?/i.test(sql)) {
          return [[filas.find((fila) => fila.id === Number(params[0]))].filter(Boolean)];
        }
        throw new Error(`Consulta no simulada: ${sql}`);
      },
    };
    return connection;
  }

  const db = { async getConnection() { return nuevaConexion(); } };
  const fechaFutura = (dias) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
  const base = {
    servicioId: 2,
    recursoId: 7,
    modalidad: "FECHA_LIBRE",
    bloqueFechaId: null,
    fechaInicio: fechaFutura(2),
    fechaFin: fechaFutura(5),
  };
  const resultados = await Promise.allSettled([
    adquirirHoldTurismo(db, { ...base, actorUsuarioId: 12, titularUsuarioId: 12, holdToken: "a".repeat(64) }),
    adquirirHoldTurismo(db, { ...base, actorUsuarioId: 13, titularUsuarioId: 13, holdToken: "b".repeat(64) }),
  ]);
  assert.equal(resultados.filter((resultado) => resultado.status === "fulfilled").length, 1);
  const rechazo = resultados.find((resultado) => resultado.status === "rejected");
  assert.equal(rechazo.reason.codigo, "HOLD_RECURSO_NO_DISPONIBLE");
  assert.equal(
    rechazo.reason.message,
    "Este alojamiento acaba de ser elegido por otra persona. Te ayudamos a buscar otra opción."
  );
  assert.equal(filas.filter((fila) => fila.estado === "ACTIVO").length, 1);
});

test("las rutas exigen y consumen el hold en la misma transacción de alta", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "api", "routes", "user.js"), "utf8");
  assert.match(source, /router\.post\("\/turismo\/reserva-holds"/);
  assert.match(source, /router\.get\("\/turismo\/reserva-holds\/:id\?"/);
  assert.match(source, /router\.delete\("\/turismo\/reserva-holds\/:id"/);
  assert.match(source, /const requiereHold = cabecera\.rol === "afiliado" \|\| Boolean\(hold_token\)/);
  assert.match(source, /validarHoldParaReservaEnTransaccion\(connection/);
  assert.match(source, /consumirHoldEnTransaccion\(connection/);
  assert.match(source, /await connection\.commit\(\);\s*emitirInvalidacionDisponibilidad\(/);
});
