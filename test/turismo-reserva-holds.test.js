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
  assert.match(source, /router\.post\("\/turismo\/reserva-holds\/:id\/latido"/);
  assert.match(source, /soportaLatido: req\.body\.soporta_latido === true/);
  assert.match(source, /reemplazarHoldPropio: req\.body\.reemplazar_hold_propio === true/);
  assert.match(source, /const requiereHold = cabecera\.rol === "afiliado" \|\| Boolean\(hold_token\)/);
  assert.match(source, /validarHoldParaReservaEnTransaccion\(connection/);
  assert.match(source, /consumirHoldEnTransaccion\(connection/);
  assert.match(source, /await connection\.commit\(\);\s*emitirInvalidacionDisponibilidad\(/);
});

// ---------------------------------------------------------------------------
// Latido (migración v2): plazo corto renovable + tope de 20 minutos.
// ---------------------------------------------------------------------------

const {
  expirarHoldsVencidos,
  liberarHoldTurismo,
  obtenerConfiguracionLatido,
  renovarLatidoHoldTurismo,
} = require("../api/services/turismo-reserva-holds");
const holdsV1 = require("../scripts/migrar-turismo-holds-v1");
const holdsV2 = require("../scripts/migrar-turismo-holds-v2-latido");

const SEGUNDO = 1000;
const TOPE_MS = 20 * 60 * SEGUNDO;

/**
 * Tabla de holds en memoria que interpreta las sentencias del servicio. El
 * reloj de la "base" (NOW(6)) es `reloj.ahora`, independiente de Date.now().
 */
function crearBaseSimulada() {
  const reloj = { ahora: Date.parse("2026-09-24T15:00:00.000Z") };
  const filas = [];
  let siguienteId = 500;
  const recursos = new Map([
    [7, { id: 7, servicio_id: 2, cupo_maximo: null, es_recurso_principal: 0, max_personas_reserva: 6, modelo_tarifa: "TEMPORADAS", tipo_codigo: "ALOJAMIENTO_RECURSO" }],
    [8, { id: 8, servicio_id: 2, cupo_maximo: null, es_recurso_principal: 0, max_personas_reserva: 6, modelo_tarifa: "TEMPORADAS", tipo_codigo: "ALOJAMIENTO_RECURSO" }],
    // Camping de 3 parcelas (sin cupo por período ni tarifa con parcelas).
    [9, { id: 9, servicio_id: 4, cupo_maximo: 3, es_recurso_principal: 1, max_personas_reserva: 6, modelo_tarifa: "TEMPORADAS", tipo_codigo: "CUPO_NUMERADO" }],
  ]);
  const consultas = [];
  const tope = (fila) => fila.vence_max_en ?? fila.vence_en;
  const motivoVencimiento = (fila) => (fila.vence_en < tope(fila) ? "ABANDONO" : "TIEMPO");
  const vista = (fila) => ({
    id: fila.id,
    actor_usuario_id: fila.actor_usuario_id,
    titular_usuario_id: fila.titular_usuario_id,
    servicio_id: fila.servicio_id,
    recurso_id: fila.recurso_id,
    bloque_fecha_id: fila.bloque_fecha_id,
    modalidad: fila.modalidad,
    fecha_inicio: fila.fecha_inicio,
    fecha_fin: fila.fecha_fin,
    numero_parcela: fila.numero_parcela,
    estado: fila.estado,
    motivo_cierre: fila.motivo_cierre,
    reserva_id: null,
    expira_en_ms: fila.vence_en,
    limite_en_ms: tope(fila),
    servidor_ahora_ms: reloj.ahora,
    token_hash: fila.token_hash,
  });
  const porId = (id) => filas.find((fila) => fila.id === Number(id));
  const vencer = (fila) => {
    fila.motivo_cierre = motivoVencimiento(fila);
    fila.estado = "VENCIDO";
  };
  const errorDuplicado = () => Object.assign(new Error("Duplicate entry for key uq_trh_actor_activo"), { code: "ER_DUP_ENTRY" });

  async function query(sql, params = []) {
    consultas.push({ sql, params });
    if (/GET_LOCK/.test(sql)) return [[{ adquirido: 1 }]];
    if (/RELEASE_LOCK/.test(sql)) return [[{}]];
    if (/FROM usuario u[\s\S]*INNER JOIN rol/i.test(sql)) {
      return [params.map((id) => ({ id, habilitado: "Y", departamental_id: 1, modulo_turismo: 1, rol: "afiliado" }))];
    }
    if (/SELECT r\.id, r\.servicio_id[\s\S]*FROM recurso r/i.test(sql)) {
      return [params.map(Number).filter((id) => recursos.has(id)).map((id) => recursos.get(id))];
    }
    if (/SELECT r\.id AS recurso_id, r\.cupo_maximo, ts\.codigo AS tipo_codigo[\s\S]*FOR UPDATE/i.test(sql)) {
      const recurso = recursos.get(Number(params[0]));
      return [recurso && recurso.servicio_id === Number(params[1])
        ? [{ recurso_id: recurso.id, cupo_maximo: recurso.cupo_maximo, tipo_codigo: recurso.tipo_codigo }]
        : []];
    }
    if (/FROM recurso_cupo_periodo/i.test(sql)) return [[{ cupo: null }]];
    if (/FROM tarifa/i.test(sql)) return [[{ parcelas: null }]];
    if (/FROM bloque_fecha bf/i.test(sql) || /FROM reserva r/i.test(sql)) return [[]];
    if (/^\s*UPDATE turismo_reserva_hold[\s\S]*WHERE id = \? AND actor_usuario_id = \? AND token_hash = \?/i.test(sql)) {
      const [gracia, id, actor, hash] = params;
      const fila = porId(id);
      if (!fila || fila.actor_usuario_id !== Number(actor) || !fila.token_hash.equals(hash) || fila.estado !== "ACTIVO" || !(fila.vence_en > reloj.ahora)) {
        return [{ affectedRows: 0 }];
      }
      fila.vence_max_en = tope(fila);
      fila.vence_en = Math.min(fila.vence_max_en, reloj.ahora + gracia * SEGUNDO);
      fila.ultimo_latido_en = reloj.ahora;
      return [{ affectedRows: 1 }];
    }
    // Recuperación al confirmar el alta (validarHoldParaReservaEnTransaccion).
    if (/estado = 'ACTIVO', fecha_cierre = NULL, motivo_cierre = NULL,\s*numero_parcela = \?\s*WHERE id = \? AND estado = \?/.test(sql)) {
      const [gracia, parcela, id, estadoEsperado] = params;
      const fila = porId(id);
      if (!fila || fila.estado !== estadoEsperado || !(tope(fila) > reloj.ahora) || !(fila.estado === "ACTIVO" || fila.motivo_cierre === "ABANDONO")) {
        return [{ affectedRows: 0 }];
      }
      if (filas.some((otra) => otra !== fila && otra.estado === "ACTIVO" && otra.actor_usuario_id === fila.actor_usuario_id)) {
        throw errorDuplicado();
      }
      fila.vence_max_en = tope(fila);
      fila.vence_en = Math.min(fila.vence_max_en, reloj.ahora + gracia * SEGUNDO);
      fila.ultimo_latido_en = reloj.ahora;
      Object.assign(fila, { estado: "ACTIVO", motivo_cierre: null, numero_parcela: parcela });
      return [{ affectedRows: 1 }];
    }
    // Extensión del plazo corto de un hold vigente al confirmar el alta.
    if (/SET vence_en = GREATEST\(vence_en, LEAST\(COALESCE\(vence_max_en, vence_en\), DATE_ADD\(NOW\(6\), INTERVAL \? SECOND\)\)\)/.test(sql)) {
      const [gracia, id] = params;
      const fila = porId(id);
      if (!fila || fila.estado !== "ACTIVO") return [{ affectedRows: 0 }];
      fila.vence_en = Math.max(fila.vence_en, Math.min(tope(fila), reloj.ahora + gracia * SEGUNDO));
      return [{ affectedRows: 1 }];
    }
    if (/SET estado = 'CONSUMIDO', reserva_id = \?/.test(sql)) {
      const [reserva, id] = params;
      const fila = porId(id);
      if (!fila || fila.estado !== "ACTIVO" || !(fila.vence_en > reloj.ahora)) return [{ affectedRows: 0 }];
      Object.assign(fila, { estado: "CONSUMIDO", reserva_id: Number(reserva) });
      return [{ affectedRows: 1 }];
    }
    if (/estado = 'ACTIVO', fecha_cierre = NULL, motivo_cierre = NULL,\s*titular_usuario_id = \?/.test(sql)) {
      const [gracia, titular, servicio, recurso, bloque, modalidad, inicio, fin, parcela, id, estadoEsperado] = params;
      const fila = porId(id);
      if (!fila || fila.estado !== estadoEsperado || !(tope(fila) > reloj.ahora) || !(fila.estado === "ACTIVO" || fila.motivo_cierre === "ABANDONO")) {
        return [{ affectedRows: 0 }];
      }
      if (filas.some((otra) => otra !== fila && otra.estado === "ACTIVO" && otra.actor_usuario_id === fila.actor_usuario_id)) {
        throw errorDuplicado();
      }
      fila.vence_max_en = tope(fila);
      fila.vence_en = Math.min(fila.vence_max_en, reloj.ahora + gracia * SEGUNDO);
      fila.ultimo_latido_en = reloj.ahora;
      Object.assign(fila, {
        estado: "ACTIVO", motivo_cierre: null, titular_usuario_id: titular, servicio_id: servicio, recurso_id: recurso,
        bloque_fecha_id: bloque, modalidad, fecha_inicio: inicio, fecha_fin: fin, numero_parcela: parcela,
      });
      return [{ affectedRows: 1 }];
    }
    if (/SET titular_usuario_id = \?/.test(sql)) {
      const [titular, servicio, recurso, bloque, modalidad, inicio, fin, parcela, id] = params;
      const fila = porId(id);
      if (!fila || fila.estado !== "ACTIVO" || !(fila.vence_en > reloj.ahora)) return [{ affectedRows: 0 }];
      Object.assign(fila, { titular_usuario_id: titular, servicio_id: servicio, recurso_id: recurso, bloque_fecha_id: bloque, modalidad, fecha_inicio: inicio, fecha_fin: fin, numero_parcela: parcela });
      return [{ affectedRows: 1 }];
    }
    if (/SET estado = 'LIBERADO', motivo_cierre = 'REEMPLAZADO'/.test(sql)) {
      const fila = porId(params[0]);
      if (!fila || fila.estado !== "ACTIVO") return [{ affectedRows: 0 }];
      Object.assign(fila, { estado: "LIBERADO", motivo_cierre: "REEMPLAZADO" });
      return [{ affectedRows: 1 }];
    }
    if (/SET estado = 'VENCIDO'/.test(sql)) {
      assert.match(sql, /motivo_cierre = IF\(vence_en < COALESCE\(vence_max_en, vence_en\), 'ABANDONO', 'TIEMPO'\)/);
      const ids = /WHERE id IN/.test(sql) ? params.map(Number) : [Number(params[0])];
      let afectadas = 0;
      for (const fila of filas.filter((f) => ids.includes(f.id) && f.estado === "ACTIVO")) {
        vencer(fila);
        afectadas += 1;
      }
      return [{ affectedRows: afectadas }];
    }
    if (/SET estado = \?, motivo_cierre = 'LIBERADO'/.test(sql)) {
      const [estado, id] = params;
      const fila = porId(id);
      if (!fila || fila.estado !== "ACTIVO") return [{ affectedRows: 0 }];
      Object.assign(fila, { estado, motivo_cierre: "LIBERADO" });
      return [{ affectedRows: 1 }];
    }
    if (/SET motivo_cierre = 'LIBERADO'/.test(sql)) {
      const fila = porId(params[0]);
      if (fila?.estado === "VENCIDO" && fila.motivo_cierre === "ABANDONO") fila.motivo_cierre = "LIBERADO";
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO turismo_reserva_hold/i.test(sql)) {
      if (filas.some((fila) => fila.estado === "ACTIVO" && fila.actor_usuario_id === Number(params[1]))) {
        throw errorDuplicado();
      }
      const fila = {
        id: siguienteId++,
        token_hash: params[0],
        actor_usuario_id: Number(params[1]),
        titular_usuario_id: params[2] == null ? null : Number(params[2]),
        servicio_id: Number(params[3]),
        recurso_id: Number(params[4]),
        bloque_fecha_id: params[5],
        modalidad: params[6],
        fecha_inicio: params[7],
        fecha_fin: params[8],
        numero_parcela: params[9],
        estado: "ACTIVO",
        motivo_cierre: null,
        vence_en: reloj.ahora + Number(params[10]) * SEGUNDO,
        vence_max_en: reloj.ahora + TOPE_MS,
        ultimo_latido_en: params[11] ? reloj.ahora : null,
      };
      filas.push(fila);
      return [{ insertId: fila.id, affectedRows: 1 }];
    }
    if (/WHERE token_hash = \?/i.test(sql)) {
      const fila = filas.find((f) => f.token_hash.equals(params[0]));
      return [fila ? [vista(fila)] : []];
    }
    if (/WHERE h\.token_hash = \?/i.test(sql)) {
      const [hash, id] = params;
      const fila = filas.find((f) => f.token_hash.equals(hash) && (id === undefined || f.id === Number(id)));
      return [fila ? [vista(fila)] : []];
    }
    if (/SELECT id, actor_usuario_id, numero_parcela[\s\S]*FROM turismo_reserva_hold/i.test(sql)) {
      const [recurso, , , excluir] = params;
      return [filas
        .filter((f) => f.recurso_id === Number(recurso) && f.estado === "ACTIVO" && f.vence_en > reloj.ahora && f.id !== Number(excluir))
        .map(vista)];
    }
    if (/h\.actor_usuario_id = \?[\s\S]*h\.estado = 'ACTIVO'/i.test(sql)) {
      return [filas.filter((f) => f.actor_usuario_id === Number(params[0]) && f.estado === "ACTIVO").map(vista)];
    }
    if (/h\.estado = 'ACTIVO' AND h\.vence_en <= NOW\(6\)/i.test(sql)) {
      return [filas.filter((f) => f.estado === "ACTIVO" && f.vence_en <= reloj.ahora).map(vista)];
    }
    if (/FROM turismo_reserva_hold h[\s\S]*WHERE h\.id = \?/i.test(sql)) {
      const fila = porId(params[0]);
      return [fila ? [vista(fila)] : []];
    }
    throw new Error(`Consulta no simulada: ${sql}`);
  }

  const conexion = () => ({
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    query,
  });
  return { reloj, filas, porId, consultas, conexion, db: { async getConnection() { return conexion(); } } };
}

const fechaFuturaLatido = (dias) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
const SOLICITUD_LATIDO = {
  actorUsuarioId: 12,
  titularUsuarioId: 12,
  servicioId: 2,
  recursoId: 7,
  modalidad: "FECHA_LIBRE",
  bloqueFechaId: null,
  fechaInicio: fechaFuturaLatido(3),
  fechaFin: fechaFuturaLatido(6),
};
const TOKEN_A = "A".repeat(48);
const TOKEN_B = "B".repeat(48);

test("la configuración del latido tiene defaults y se acota al tope", () => {
  assert.deepEqual(obtenerConfiguracionLatido({}), {
    topeSegundos: 1200,
    graciaSegundos: 150,
    graciaSegundoPlanoSegundos: 300,
    latidoCadaSegundos: 30,
  });
  const acotada = obtenerConfiguracionLatido({
    TURISMO_HOLDS_GRACIA_LATIDO_SEGUNDOS: "5",
    TURISMO_HOLDS_GRACIA_SEGUNDO_PLANO_SEGUNDOS: "99999",
    TURISMO_HOLDS_LATIDO_CADA_SEGUNDOS: "300",
  });
  assert.equal(acotada.graciaSegundos, 60);
  assert.equal(acotada.graciaSegundoPlanoSegundos, 1200);
  // Siempre al menos dos latidos dentro de la gracia.
  assert.equal(acotada.latidoCadaSegundos, 30);
  assert.equal(obtenerConfiguracionLatido({ TURISMO_HOLDS_GRACIA_LATIDO_SEGUNDOS: "abc" }).graciaSegundos, 150);
  // La gracia de segundo plano bajó a 5 minutos, pero el entorno puede subirla.
  assert.equal(obtenerConfiguracionLatido({ TURISMO_HOLDS_GRACIA_SEGUNDO_PLANO_SEGUNDOS: "600" }).graciaSegundoPlanoSegundos, 600);
  assert.equal(obtenerConfiguracionLatido({ TURISMO_HOLDS_GRACIA_SEGUNDO_PLANO_SEGUNDOS: "30" }).graciaSegundoPlanoSegundos, 150);
});

test("el mapeo cuenta los 20 minutos contra el tope y expone el plazo corto como abandono_en", () => {
  const ahora = Date.now();
  const hold = mapearHold(filaHold({
    servidor_ahora_ms: ahora,
    expira_en_ms: ahora + 150_000,
    limite_en_ms: ahora + 1_200_000,
  }));
  assert.equal(hold.segundos_restantes, 1200);
  assert.equal(hold.expira_en, new Date(ahora + 1_200_000).toISOString());
  assert.equal(hold.abandono_en, new Date(ahora + 150_000).toISOString());
  assert.equal(hold.latido_cada_segundos, 30);
  assert.equal(Object.hasOwn(hold, "vence_en"), false);
  assert.equal(Object.hasOwn(hold, "vence_max_en"), false);
  assert.equal(Object.hasOwn(hold, "token_hash"), false);
});

test("con soporta_latido el plazo corto arranca en la gracia; sin la marca queda como v1", async () => {
  const base = crearBaseSimulada();
  const conLatido = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  const fila = base.porId(conLatido.id);
  assert.equal(fila.vence_en - base.reloj.ahora, 150 * SEGUNDO);
  assert.equal(fila.vence_max_en - base.reloj.ahora, TOPE_MS);
  assert.equal(fila.ultimo_latido_en, base.reloj.ahora);
  assert.equal(conLatido.segundos_restantes, 1200);
  assert.equal(conLatido.creado, true);
  assert.equal(conLatido.hold_token, TOKEN_A);

  const legado = crearBaseSimulada();
  const sinLatido = await adquirirHoldTurismo(legado.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A });
  const filaLegado = legado.porId(sinLatido.id);
  assert.equal(filaLegado.vence_en, filaLegado.vence_max_en);
  assert.equal(filaLegado.vence_en - legado.reloj.ahora, TOPE_MS);
  assert.equal(filaLegado.ultimo_latido_en, null);
});

test("un latido renueva el plazo corto, en segundo plano usa la gracia larga y nunca pasa el tope", async () => {
  const base = crearBaseSimulada();
  const hold = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  const fila = base.porId(hold.id);
  const tope = fila.vence_max_en;

  base.reloj.ahora += 100 * SEGUNDO;
  const latido = await renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_A });
  assert.equal(latido.activo, true);
  assert.equal(latido.latido_cada_segundos, 30);
  assert.equal(fila.vence_en, base.reloj.ahora + 150 * SEGUNDO);
  assert.equal(fila.vence_max_en, tope);
  assert.equal(latido.hold.segundos_restantes, 1100);

  await renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_A, segundoPlano: true });
  assert.equal(fila.vence_en, base.reloj.ahora + 300 * SEGUNDO);

  // Latidos continuos hasta el final: el plazo corto nunca pasa el tope.
  while (base.reloj.ahora < tope - 60 * SEGUNDO) {
    base.reloj.ahora = Math.min(tope - 60 * SEGUNDO, base.reloj.ahora + 120 * SEGUNDO);
    await renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_A });
  }
  assert.equal(fila.vence_en, tope);
  base.reloj.ahora = tope + SEGUNDO;
  await assert.rejects(
    renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_A }),
    (error) => error.codigo === "HOLD_VENCIDO" && error.statusCode === 410
  );
  base.reloj.ahora = tope - 60 * SEGUNDO;

  await assert.rejects(
    renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_B }),
    (error) => error.codigo === "HOLD_NO_ENCONTRADO" && error.statusCode === 404
  );
  await assert.rejects(
    renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 13, holdId: hold.id, holdToken: TOKEN_A }),
    (error) => error.codigo === "HOLD_NO_ENCONTRADO"
  );
});

test("perder el latido y reanudar con el mismo token recupera la misma fila y conserva el tope", async () => {
  const base = crearBaseSimulada();
  const hold = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  const fila = base.porId(hold.id);
  const tope = fila.vence_max_en;

  base.reloj.ahora += 200 * SEGUNDO;
  await assert.rejects(
    renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_A }),
    (error) => error.codigo === "HOLD_LATIDO_PERDIDO" && error.statusCode === 409 && error.detalles.hold.id === hold.id
  );
  assert.equal(fila.estado, "ACTIVO", "el latido no toca un hold que perdió el plazo");

  const recuperado = await adquirirHoldTurismo(base.db, {
    ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true, reanudar: true,
  });
  assert.equal(recuperado.id, hold.id);
  assert.equal(recuperado.reanudado, true);
  assert.equal(recuperado.creado, false);
  assert.equal(recuperado.reemplazado, false);
  assert.equal(fila.vence_max_en, tope);
  assert.equal(fila.vence_en, base.reloj.ahora + 150 * SEGUNDO);
  assert.equal(recuperado.segundos_restantes, 1000);
});

test("el barrido cierra por ABANDONO o por TIEMPO y reanudar revive la misma fila abandonada", async () => {
  const base = crearBaseSimulada();
  const abandonado = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  const legado = await adquirirHoldTurismo(base.db, {
    ...SOLICITUD_LATIDO, actorUsuarioId: 13, titularUsuarioId: 13, recursoId: 8, holdToken: TOKEN_B,
  });

  base.reloj.ahora += 160 * SEGUNDO;
  const primera = await expirarHoldsVencidos(base.db);
  assert.deepEqual(primera.holds.map((hold) => [hold.id, hold.motivo_cierre]), [[abandonado.id, "ABANDONO"]]);
  assert.equal(base.porId(abandonado.id).motivo_cierre, "ABANDONO");
  assert.equal(base.porId(legado.id).estado, "ACTIVO");

  await assert.rejects(
    renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: abandonado.id, holdToken: TOKEN_A }),
    (error) => error.codigo === "HOLD_LATIDO_PERDIDO"
  );
  const revivido = await adquirirHoldTurismo(base.db, {
    ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true, reanudar: true,
  });
  assert.equal(revivido.id, abandonado.id);
  assert.equal(revivido.estado, "ACTIVO");
  assert.equal(base.porId(abandonado.id).motivo_cierre, null);

  base.reloj.ahora += TOPE_MS;
  const segunda = await expirarHoldsVencidos(base.db);
  const motivos = Object.fromEntries(segunda.holds.map((hold) => [hold.id, hold.motivo_cierre]));
  assert.equal(motivos[legado.id], "TIEMPO");
  assert.equal(base.porId(legado.id).motivo_cierre, "TIEMPO");
  await assert.rejects(
    adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true, reanudar: true }),
    (error) => error.codigo === "HOLD_VENCIDO" && error.statusCode === 410
  );
  await assert.rejects(
    renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: abandonado.id, holdToken: TOKEN_A }),
    (error) => error.codigo === "HOLD_VENCIDO" && error.statusCode === 410
  );
});

test("si otra persona tomó el alojamiento mientras no estaba, reanudar no lo recupera", async () => {
  const base = crearBaseSimulada();
  const propio = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  base.reloj.ahora += 200 * SEGUNDO;
  const ajeno = await adquirirHoldTurismo(base.db, {
    ...SOLICITUD_LATIDO, actorUsuarioId: 13, titularUsuarioId: 13, holdToken: TOKEN_B, soportaLatido: true,
  });
  assert.equal(ajeno.recurso_id, 7);
  await assert.rejects(
    adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true, reanudar: true }),
    (error) => error.codigo === "HOLD_RECURSO_NO_DISPONIBLE"
  );
  assert.notEqual(base.porId(propio.id).estado, "CONSUMIDO");
});

test("un latido nunca revive un hold liberado y distingue el reemplazo desde otra pestaña", async () => {
  const base = crearBaseSimulada();
  const hold = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  // El DELETE del pagehide llega antes que el latido keepalive de visibilitychange.
  const liberacion = await liberarHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_A });
  assert.equal(liberacion.liberado, true);
  assert.equal(base.porId(hold.id).motivo_cierre, "LIBERADO");
  await assert.rejects(
    renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_A, segundoPlano: true }),
    (error) => error.codigo === "HOLD_NO_ACTIVO" && error.statusCode === 409
  );
  assert.equal(base.porId(hold.id).estado, "LIBERADO");
  await assert.rejects(
    adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true, reanudar: true }),
    (error) => error.codigo === "HOLD_TOKEN_REUTILIZADO"
  );
});

test("HOLD_ACTIVO_EXISTENTE informa cuándo se libera solo y reemplazar_hold_propio lo libera y continúa", async () => {
  const base = crearBaseSimulada();
  const primera = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  base.reloj.ahora += 30 * SEGUNDO;

  await assert.rejects(
    adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, recursoId: 8, holdToken: TOKEN_B, soportaLatido: true }),
    (error) => error.codigo === "HOLD_ACTIVO_EXISTENTE"
      && error.detalles.segundos_para_liberar === 120
      && error.detalles.puede_reemplazar === true
      && error.detalles.hold.id === primera.id
  );

  const segunda = await adquirirHoldTurismo(base.db, {
    ...SOLICITUD_LATIDO, recursoId: 8, holdToken: TOKEN_B, soportaLatido: true, reemplazarHoldPropio: true,
  });
  assert.notEqual(segunda.id, primera.id);
  assert.equal(segunda.creado, true);
  assert.equal(segunda.hold_liberado.id, primera.id);
  assert.equal(segunda.segundos_restantes, 1200);
  assert.equal(base.porId(primera.id).estado, "LIBERADO");
  assert.equal(base.porId(primera.id).motivo_cierre, "REEMPLAZADO");

  await assert.rejects(
    renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: primera.id, holdToken: TOKEN_A }),
    (error) => error.codigo === "HOLD_REEMPLAZADO" && error.statusCode === 409
  );
  await assert.rejects(
    adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true, reanudar: true }),
    (error) => error.codigo === "HOLD_ACTIVO_EXISTENTE"
  );
});

test("la validación del alta extiende el plazo corto sin acortarlo ni pasar el tope", async () => {
  const consultas = [];
  const connection = {
    async query(sql, params) {
      consultas.push({ sql, params });
      return [[filaHold()]];
    },
  };
  await validarHoldParaReservaEnTransaccion(connection, {
    actorUsuarioId: 12,
    titularUsuarioId: 12,
    servicioId: 2,
    recursoId: 7,
    modalidad: "FECHA_LIBRE",
    fechaInicio: "2026-09-10",
    fechaFin: "2026-09-13",
    holdToken: TOKEN,
  });
  const extension = consultas.find(({ sql }) => /SET vence_en = GREATEST/.test(sql));
  assert.ok(extension);
  assert.match(extension.sql, /GREATEST\(vence_en, LEAST\(COALESCE\(vence_max_en, vence_en\)/);
  assert.equal(extension.params[0], 150);
});

test("el latido es un UPDATE condicionado que no puede cambiar el estado", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "api", "services", "turismo-reserva-holds.js"),
    "utf8"
  );
  const latido = source.match(/SET vence_max_en = COALESCE\(vence_max_en, vence_en\),\s*vence_en = LEAST\(vence_max_en, DATE_ADD\(NOW\(6\), INTERVAL \? SECOND\)\),\s*ultimo_latido_en = NOW\(6\)\s*WHERE[\s\S]+?AND estado = 'ACTIVO' AND vence_en > NOW\(6\)/)?.[0];
  assert.ok(latido);
  assert.doesNotMatch(latido, /SET[\s\S]*estado\s*=\s*'ACTIVO',/);
  assert.match(latido, /WHERE id = \? AND actor_usuario_id = \? AND token_hash = \?/);
});

test("v1 tolera las columnas de v2 sin cambiar su checksum registrado", () => {
  assert.equal(holdsV1.MIGRATION_CHECKSUM, "93b9de033ced87474529d181826366efb81bd9f56a1a2d7e6e454af182502eed");
  const { TABLE_DEFINITION } = holdsV1;
  const expresionActorActivo = "(case when (estado = _utf8mb4'ACTIVO') then actor_usuario_id else NULL end)";
  const esquema = (extras = []) => ({
    tabla: { ENGINE: "InnoDB" },
    columns: [
      ...TABLE_DEFINITION.columns.map(([nombre, tipo, nullable]) => ({
        COLUMN_NAME: nombre,
        COLUMN_TYPE: tipo,
        IS_NULLABLE: nullable,
        COLUMN_DEFAULT: nombre === "estado"
          ? "ACTIVO"
          : (["fecha_creacion", "fecha_modificacion"].includes(nombre) ? "CURRENT_TIMESTAMP(6)" : null),
        EXTRA: {
          id: "auto_increment",
          fecha_modificacion: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)",
          actor_activo_id: "STORED GENERATED",
        }[nombre] || "",
        GENERATION_EXPRESSION: nombre === "actor_activo_id" ? expresionActorActivo : "",
      })),
      ...extras,
    ],
    indexes: Object.entries(TABLE_DEFINITION.indexes).flatMap(([nombre, definicion]) => definicion.columns.map((columna, indice) => ({
      INDEX_NAME: nombre, NON_UNIQUE: definicion.unique ? 0 : 1, COLUMN_NAME: columna, SEQ_IN_INDEX: indice + 1,
    }))),
    foreignKeys: Object.entries(TABLE_DEFINITION.foreignKeys).map(([nombre, [columna, tabla, referencia, regla]]) => ({
      CONSTRAINT_NAME: nombre, COLUMN_NAME: columna, REFERENCED_TABLE_NAME: tabla, REFERENCED_COLUMN_NAME: referencia, DELETE_RULE: regla,
    })),
    checks: Object.entries(TABLE_DEFINITION.checks).map(([nombre, expresion]) => ({ CONSTRAINT_NAME: nombre, CHECK_CLAUSE: expresion })),
  });
  const v2 = [
    { COLUMN_NAME: "vence_max_en", COLUMN_TYPE: "datetime(6)", IS_NULLABLE: "YES" },
    { COLUMN_NAME: "ultimo_latido_en", COLUMN_TYPE: "datetime(6)", IS_NULLABLE: "YES" },
    { COLUMN_NAME: "motivo_cierre", COLUMN_TYPE: "varchar(24)", IS_NULLABLE: "YES" },
  ];
  assert.doesNotThrow(() => holdsV1.validarEsquemaExacto(esquema()));
  assert.doesNotThrow(() => holdsV1.validarEsquemaExacto(esquema(v2)));
  assert.throws(
    () => holdsV1.validarEsquemaExacto(esquema([{ ...v2[0], IS_NULLABLE: "NO" }])),
    /Columna v2 incompatible/
  );
  assert.throws(
    () => holdsV1.validarEsquemaExacto(esquema([{ COLUMN_NAME: "otra", COLUMN_TYPE: "int", IS_NULLABLE: "YES" }])),
    /cantidad de columnas incompatible/
  );
});

test("la migración v2 es idempotente, NULL-able y su --check no ejecuta DDL ni DML", async () => {
  function conexionMigracion(columnasIniciales) {
    const columnas = new Map(columnasIniciales);
    const consultas = [];
    return {
      consultas,
      columnas,
      async query(sql, params = []) {
        consultas.push(sql.trim());
        if (/information_schema\.TABLES/i.test(sql)) return [[{ total: 1 }]];
        if (/information_schema\.COLUMNS/i.test(sql)) {
          const tipo = columnas.get(params[1]);
          return [tipo ? [{ COLUMN_TYPE: tipo, IS_NULLABLE: "YES" }] : []];
        }
        if (/^ALTER TABLE/i.test(sql.trim())) {
          const [, nombre, tipo] = sql.match(/ADD COLUMN (\w+) (\w+(?:\(\d+\))?) NULL/);
          columnas.set(nombre, tipo.toLowerCase());
          return [{}];
        }
        if (/^UPDATE turismo_reserva_hold SET vence_max_en = vence_en/i.test(sql.trim())) return [{ affectedRows: 9 }];
        if (/WHERE vence_max_en IS NULL/i.test(sql)) return [[{ total: 0 }]];
        throw new Error(`Consulta inesperada: ${sql}`);
      },
    };
  }
  const silenciar = console.log;
  console.log = () => {};
  try {
    const chequeo = conexionMigracion([]);
    const resultadoCheck = await holdsV2.ejecutarMigracion(chequeo, { checkOnly: true });
    assert.deepEqual(resultadoCheck.pendientes, ["vence_max_en", "ultimo_latido_en", "motivo_cierre"]);
    assert.equal(chequeo.consultas.every((sql) => /^SELECT/i.test(sql)), true);

    const aplicar = conexionMigracion([]);
    const resultado = await holdsV2.ejecutarMigracion(aplicar, { checkOnly: false });
    assert.deepEqual(resultado.agregadas, ["vence_max_en", "ultimo_latido_en", "motivo_cierre"]);
    assert.equal(resultado.rellenadas, 9);
    assert.equal(aplicar.consultas.filter((sql) => /^ALTER/i.test(sql)).every((sql) => / NULL AFTER /.test(sql)), true);

    const repetir = conexionMigracion(aplicar.columnas);
    const segunda = await holdsV2.ejecutarMigracion(repetir, { checkOnly: false });
    assert.deepEqual(segunda.agregadas, []);
    assert.equal(repetir.consultas.some((sql) => /^ALTER/i.test(sql)), false);

    await assert.rejects(
      holdsV2.ejecutarMigracion(conexionMigracion([["vence_max_en", "datetime"]]), { checkOnly: true }),
      /tipo incompatible/
    );
  } finally {
    console.log = silenciar;
  }
  assert.throws(() => holdsV2.parsearArgumentos(["--apply"]), /desconocidos/);
  const remoto = { DB_HOST: "db.example.internal", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db" };
  assert.throws(() => holdsV2.validarDestino(holdsV2.parsearArgumentos([]), remoto), /--allow-production/);
  assert.doesNotThrow(() => holdsV2.validarDestino(holdsV2.parsearArgumentos(["--check"]), remoto));
  assert.doesNotThrow(() => holdsV2.validarDestino(holdsV2.parsearArgumentos(["--allow-production"]), remoto));
});

// ---------------------------------------------------------------------------
// Confirmar el alta con el plazo corto vencido y el tope vigente.
// ---------------------------------------------------------------------------

function altaConHold(hold, extra = {}) {
  return {
    actorUsuarioId: 12,
    titularUsuarioId: 12,
    servicioId: 2,
    recursoId: 7,
    bloqueFechaId: null,
    modalidad: "FECHA_LIBRE",
    fechaInicio: SOLICITUD_LATIDO.fechaInicio,
    fechaFin: SOLICITUD_LATIDO.fechaFin,
    holdId: hold.id,
    holdToken: TOKEN_A,
    ...extra,
  };
}

test("confirmar sin plazo corto pero con tope vigente revalida, extiende el plazo y sigue en la misma fila", async () => {
  const base = crearBaseSimulada();
  const hold = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  const fila = base.porId(hold.id);
  const tope = fila.vence_max_en;

  // Notebook suspendida más de 150 s: sin latidos, el contador todavía muestra minutos.
  base.reloj.ahora += 200 * SEGUNDO;
  const desde = base.consultas.length;
  const conexion = base.conexion();
  const validado = await validarHoldParaReservaEnTransaccion(conexion, altaConHold(hold));

  assert.equal(validado.id, hold.id);
  assert.equal(validado.recuperado, true);
  assert.equal(fila.estado, "ACTIVO");
  assert.equal(fila.vence_en, base.reloj.ahora + 150 * SEGUNDO);
  assert.equal(fila.vence_max_en, tope, "el tope de 20 minutos no cambia");
  assert.equal(fila.ultimo_latido_en, base.reloj.ahora);
  assert.equal(validado.hold.estado, "ACTIVO");
  assert.equal(validado.hold.segundos_restantes, 1000);

  // Locks: hold propio -> recurso (FOR UPDATE) -> holds solapados sin el propio, FOR UPDATE.
  const consultas = base.consultas.slice(desde);
  const iHold = consultas.findIndex(({ sql }) => /WHERE h\.token_hash = \?/.test(sql));
  const iRecurso = consultas.findIndex(({ sql }) => /SELECT r\.id AS recurso_id/.test(sql));
  const iSolapados = consultas.findIndex(({ sql }) => /SELECT id, actor_usuario_id, numero_parcela/.test(sql));
  const iRecuperacion = consultas.findIndex(({ sql }) => /estado = 'ACTIVO', fecha_cierre = NULL/.test(sql));
  assert.ok(iHold === 0 && iRecurso > iHold && iSolapados > iRecurso && iRecuperacion > iSolapados);
  assert.match(consultas[iHold].sql, /FOR UPDATE/);
  assert.match(consultas[iRecurso].sql, /FOR UPDATE/);
  assert.match(consultas[iSolapados].sql, /FOR UPDATE/);
  assert.equal(consultas[iSolapados].params.at(-1), hold.id, "excluye el hold propio");
  assert.match(consultas[iRecuperacion].sql, /vence_en = LEAST\(vence_max_en, DATE_ADD\(NOW\(6\), INTERVAL \? SECOND\)\)/);

  await consumirHoldEnTransaccion(conexion, { holdId: validado.id, reservaId: 501 });
  assert.equal(fila.estado, "CONSUMIDO");
});

test("confirmar revive el hold que el barrido cerró por ABANDONO si el tope sigue vigente", async () => {
  const base = crearBaseSimulada();
  const hold = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  const fila = base.porId(hold.id);
  base.reloj.ahora += 160 * SEGUNDO;
  await expirarHoldsVencidos(base.db);
  assert.equal(fila.estado, "VENCIDO");
  assert.equal(fila.motivo_cierre, "ABANDONO");

  const validado = await validarHoldParaReservaEnTransaccion(base.conexion(), altaConHold(hold));
  assert.equal(validado.id, hold.id);
  assert.equal(validado.recuperado, true);
  assert.equal(fila.estado, "ACTIVO");
  assert.equal(fila.motivo_cierre, null);
  assert.equal(fila.vence_en, base.reloj.ahora + 150 * SEGUNDO);
  assert.equal(validado.hold.segundos_restantes, 1040);
});

test("si otra persona tomó el alojamiento mientras el hold no latía, confirmar responde HOLD_RECURSO_NO_DISPONIBLE", async () => {
  const base = crearBaseSimulada();
  const hold = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  const fila = base.porId(hold.id);
  base.reloj.ahora += 200 * SEGUNDO;
  await adquirirHoldTurismo(base.db, {
    ...SOLICITUD_LATIDO, actorUsuarioId: 13, titularUsuarioId: 13, holdToken: TOKEN_B, soportaLatido: true,
  });
  const vencePrevio = fila.vence_en;

  await assert.rejects(
    validarHoldParaReservaEnTransaccion(base.conexion(), altaConHold(hold)),
    (error) => error.codigo === "HOLD_RECURSO_NO_DISPONIBLE" && error.statusCode === 409
  );
  assert.equal(fila.vence_en, vencePrevio, "no extiende un hold que ya no puede recuperar");

  // Lo mismo si el barrido ya lo había cerrado por ABANDONO.
  await expirarHoldsVencidos(base.db);
  assert.equal(fila.motivo_cierre, "ABANDONO");
  await assert.rejects(
    validarHoldParaReservaEnTransaccion(base.conexion(), altaConHold(hold)),
    (error) => error.codigo === "HOLD_RECURSO_NO_DISPONIBLE"
  );
  assert.equal(fila.estado, "VENCIDO");
});

test("con el tope vencido confirmar sigue respondiendo HOLD_VENCIDO", async () => {
  const base = crearBaseSimulada();
  const hold = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  const fila = base.porId(hold.id);
  base.reloj.ahora += TOPE_MS + SEGUNDO;
  await assert.rejects(
    validarHoldParaReservaEnTransaccion(base.conexion(), altaConHold(hold)),
    (error) => error.codigo === "HOLD_VENCIDO" && error.statusCode === 410
  );
  assert.equal(fila.estado, "VENCIDO");

  // Abandonado y después pasado el tope: tampoco se revive.
  const otra = crearBaseSimulada();
  const abandonado = await adquirirHoldTurismo(otra.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  otra.reloj.ahora += 160 * SEGUNDO;
  await expirarHoldsVencidos(otra.db);
  otra.reloj.ahora += TOPE_MS;
  await assert.rejects(
    validarHoldParaReservaEnTransaccion(otra.conexion(), altaConHold(abandonado)),
    (error) => error.codigo === "HOLD_VENCIDO"
  );
  assert.equal(otra.porId(abandonado.id).estado, "VENCIDO");
});

test("revivir al confirmar respeta el único hold activo por actor", async () => {
  const base = crearBaseSimulada();
  const viejo = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  base.reloj.ahora += 160 * SEGUNDO;
  await expirarHoldsVencidos(base.db);
  // Mientras tanto empezó otra reserva en otra pestaña.
  const nuevo = await adquirirHoldTurismo(base.db, {
    ...SOLICITUD_LATIDO, recursoId: 8, holdToken: TOKEN_B, soportaLatido: true,
  });
  await assert.rejects(
    validarHoldParaReservaEnTransaccion(base.conexion(), altaConHold(viejo)),
    (error) => error.codigo === "HOLD_ACTIVO_EXISTENTE" && error.detalles.hold.id === nuevo.id
  );
  assert.equal(base.porId(viejo.id).estado, "VENCIDO");
  assert.equal(base.porId(nuevo.id).estado, "ACTIVO");

  // Si la otra pestaña también dejó de latir, no retiene nada: se cierra y sigue el alta.
  base.reloj.ahora += 200 * SEGUNDO;
  const validado = await validarHoldParaReservaEnTransaccion(base.conexion(), altaConHold(viejo));
  assert.equal(validado.id, viejo.id);
  assert.equal(base.porId(viejo.id).estado, "ACTIVO");
  assert.equal(base.porId(nuevo.id).estado, "VENCIDO");
  assert.equal(base.porId(nuevo.id).motivo_cierre, "ABANDONO");
});

test("en camping recuperar al confirmar conserva la parcela si sigue libre y si no asigna otra", async () => {
  const camping = { ...SOLICITUD_LATIDO, servicioId: 4, recursoId: 9 };
  const alta = (hold, token) => altaConHold(hold, { servicioId: 4, recursoId: 9, holdToken: token });

  const base = crearBaseSimulada();
  const ajeno = await adquirirHoldTurismo(base.db, { ...camping, actorUsuarioId: 13, titularUsuarioId: 13, holdToken: TOKEN_B, soportaLatido: true });
  const propio = await adquirirHoldTurismo(base.db, { ...camping, holdToken: TOKEN_A, soportaLatido: true });
  assert.equal(ajeno.numero_parcela, 1);
  assert.equal(propio.numero_parcela, 2);
  await liberarHoldTurismo(base.db, { actorUsuarioId: 13, holdId: ajeno.id, holdToken: TOKEN_B });
  base.reloj.ahora += 200 * SEGUNDO;
  const conservada = await validarHoldParaReservaEnTransaccion(base.conexion(), alta(propio, TOKEN_A));
  assert.equal(conservada.numeroParcela, 2, "la 1 quedó libre, pero se conserva la que ya tenía");

  const otra = crearBaseSimulada();
  const primero = await adquirirHoldTurismo(otra.db, { ...camping, holdToken: TOKEN_A, soportaLatido: true });
  assert.equal(primero.numero_parcela, 1);
  otra.reloj.ahora += 200 * SEGUNDO;
  const intruso = await adquirirHoldTurismo(otra.db, {
    ...camping, actorUsuarioId: 13, titularUsuarioId: 13, holdToken: "C".repeat(48), soportaLatido: true,
  });
  assert.equal(intruso.numero_parcela, 1);
  const reasignada = await validarHoldParaReservaEnTransaccion(otra.conexion(), alta(primero, TOKEN_A));
  assert.equal(reasignada.numeroParcela, 2);
  assert.equal(otra.porId(primero.id).numero_parcela, 2);
});

test("una liberación explícita cierra siempre con motivo LIBERADO y no se puede revivir", async () => {
  const base = crearBaseSimulada();
  const hold = await adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  const fila = base.porId(hold.id);
  // Perdió el plazo corto pero el barrido todavía no pasó.
  base.reloj.ahora += 200 * SEGUNDO;
  const liberacion = await liberarHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_A });
  assert.equal(liberacion.liberado, true);
  assert.equal(liberacion.estado, "LIBERADO");
  assert.equal(fila.estado, "LIBERADO");
  assert.equal(fila.motivo_cierre, "LIBERADO");

  await assert.rejects(
    adquirirHoldTurismo(base.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true, reanudar: true }),
    (error) => error.codigo === "HOLD_TOKEN_REUTILIZADO"
  );
  await assert.rejects(
    renovarLatidoHoldTurismo(base.db, { actorUsuarioId: 12, holdId: hold.id, holdToken: TOKEN_A }),
    (error) => error.codigo === "HOLD_NO_ACTIVO"
  );
  await assert.rejects(
    validarHoldParaReservaEnTransaccion(base.conexion(), altaConHold(hold)),
    (error) => error.codigo === "HOLD_NO_ACTIVO"
  );
  assert.equal(fila.estado, "LIBERADO");

  // Con el tope también vencido: queda VENCIDO, pero igual con motivo LIBERADO.
  const otra = crearBaseSimulada();
  const tarde = await adquirirHoldTurismo(otra.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true });
  otra.reloj.ahora += TOPE_MS + SEGUNDO;
  const cierre = await liberarHoldTurismo(otra.db, { actorUsuarioId: 12, holdId: tarde.id, holdToken: TOKEN_A });
  assert.equal(cierre.liberado, false);
  assert.equal(cierre.estado, "VENCIDO");
  assert.equal(otra.porId(tarde.id).motivo_cierre, "LIBERADO");
  await assert.rejects(
    adquirirHoldTurismo(otra.db, { ...SOLICITUD_LATIDO, holdToken: TOKEN_A, soportaLatido: true, reanudar: true }),
    (error) => error.codigo === "HOLD_VENCIDO"
  );
});
