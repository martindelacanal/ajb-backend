const test = require("node:test");
const assert = require("node:assert/strict");

const {
  crearSalaChat,
  normalizarConversacion,
  puedeAccederSegunEntidad,
  registrarEventosChatTiempoReal,
} = require("../api/socket/chat-tiempo-real");

test("normaliza únicamente conversaciones y cursores enteros válidos", () => {
  assert.deepEqual(
    normalizarConversacion({ modulo: "Turismo", entidad_id: "42", desde_id: 7 }),
    { modulo: "turismo", entidadId: 42, desdeId: 7 }
  );
  assert.equal(normalizarConversacion({ modulo: "otro", entidad_id: 1 }), null);
  assert.equal(normalizarConversacion({ modulo: "turismo", entidad_id: "1e2" }), null);
  assert.equal(normalizarConversacion({ modulo: "turismo", entidad_id: 1, desde_id: -1 }), null);
  assert.equal(
    crearSalaChat({ modulo: "olimpiadas", entidadId: 9 }),
    "chat:olimpiadas:9"
  );
});

test("autoriza cada room por entidad, rol, departamental y área", () => {
  const turismo = { modulo: "turismo", entidadId: 1, desdeId: 0 };
  const coseguro = { modulo: "coseguro", entidadId: 2, desdeId: 0 };
  const traslados = { modulo: "traslados", entidadId: 3, desdeId: 0 };
  const olimpiadas = { modulo: "olimpiadas", entidadId: 4, desdeId: 0 };

  assert.equal(puedeAccederSegunEntidad(
    { id: 8, rol: "afiliado" }, turismo, { usuario_id: 8, departamental_id: 2 }
  ), true);
  assert.equal(puedeAccederSegunEntidad(
    { id: 9, rol: "afiliado" }, turismo, { usuario_id: 8, departamental_id: 2 }
  ), false);
  assert.equal(puedeAccederSegunEntidad(
    { id: 8, rol: "afiliado", modulo_turismo: 0 },
    turismo,
    { usuario_id: 8, departamental_id: 2 }
  ), false);
  assert.equal(puedeAccederSegunEntidad(
    { rol: "departamental", departamentalId: 2, area_turismo: 0 },
    turismo,
    { usuario_id: 8, departamental_id: 2 }
  ), false);
  assert.equal(puedeAccederSegunEntidad(
    { rol: "auditor" }, coseguro, { estado_id: 7 }
  ), true);
  assert.equal(puedeAccederSegunEntidad(
    { rol: "auditor" }, coseguro, { estado_id: 3 }
  ), false);
  assert.equal(puedeAccederSegunEntidad(
    { rol: "departamental", departamentalId: 5 },
    traslados,
    { departamental_origen_id: 2, departamental_destino_id: 5 }
  ), false);
  assert.equal(puedeAccederSegunEntidad(
    { rol: "admin" }, traslados, { departamental_origen_id: 2, departamental_destino_id: 5 }
  ), true);
  assert.equal(puedeAccederSegunEntidad(
    { id: 11, rol: "afiliado" }, olimpiadas, { usuario_id: 12, departamental_id: 5 }
  ), false);
});

function crearSocketFalso(auth) {
  const handlers = new Map();
  const salasUnidas = [];
  const salasAbandonadas = [];
  return {
    data: { auth },
    handlers,
    salasUnidas,
    salasAbandonadas,
    on(evento, handler) {
      handlers.set(evento, handler);
    },
    async join(sala) {
      salasUnidas.push(sala);
    },
    async leave(sala) {
      salasAbandonadas.push(sala);
    },
  };
}

function invocarConAck(handler, payload) {
  return new Promise((resolve) => {
    handler(payload, resolve);
  });
}

function usuarioChatActual(overrides = {}) {
  return {
    id: 8,
    documento: "12345678",
    departamental_id: 2,
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 1,
    rol: "afiliado",
    ...overrides,
  };
}

test("join y sync entregan solo mensajes persistidos a la room autorizada", async () => {
  const socket = crearSocketFalso({ id: 8, rol: "afiliado" });
  const emisiones = [];
  const io = {
    to(sala) {
      return {
        emit(evento, payload) {
          emisiones.push({ sala, evento, payload });
        },
      };
    },
  };
  const mensaje = {
    id: 12,
    usuario_id: 8,
    usuario_rol: "afiliado",
    mensaje: "Ya persistido",
    fecha_creacion: "2026-08-19T10:00:00.000Z",
    usuario_nombre: "Ana",
    usuario_apellido: "Pérez",
    estado_nombre: "Iniciada",
  };
  const db = {
    async query(sql) {
      if (sql.includes("FROM usuario u") && sql.includes("INNER JOIN rol")) {
        return [[usuarioChatActual()]];
      }
      if (sql.includes("FROM reserva r")) {
        return [[{ usuario_id: 8, departamental_id: 2 }]];
      }
      if (sql.includes("FROM reserva_observacion")) {
        return [[mensaje]];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };

  registrarEventosChatTiempoReal({ io, socket, db });
  const joinAck = await invocarConAck(
    socket.handlers.get("chat:join"),
    { modulo: "turismo", entidad_id: 21, desde_id: 0 }
  );

  assert.equal(joinAck.ok, true);
  assert.deepEqual(joinAck.mensajes, [mensaje]);
  assert.deepEqual(socket.salasUnidas, ["chat:turismo:21"]);

  const syncAck = await invocarConAck(
    socket.handlers.get("chat:sync"),
    { modulo: "turismo", entidad_id: 21, desde_id: 0 }
  );
  assert.equal(syncAck.ok, true);
  assert.equal(emisiones.length, 1);
  assert.equal(emisiones[0].sala, "chat:turismo:21");
  assert.equal(emisiones[0].evento, "chat:mensaje");
  assert.equal(emisiones[0].payload.mensaje.id, 12);
});

test("un usuario no puede unirse ni sincronizar una conversación ajena", async () => {
  const socket = crearSocketFalso({ id: 99, rol: "afiliado" });
  const db = {
    async query(sql) {
      if (sql.includes("FROM usuario u") && sql.includes("INNER JOIN rol")) {
        return [[usuarioChatActual({ id: 99, documento: "87654321" })]];
      }
      if (sql.includes("FROM reserva r")) {
        return [[{ usuario_id: 8, departamental_id: 2 }]];
      }
      return [[]];
    },
  };
  registrarEventosChatTiempoReal({ io: { to: () => ({ emit() {} }) }, socket, db });

  const joinAck = await invocarConAck(
    socket.handlers.get("chat:join"),
    { modulo: "turismo", entidad_id: 21, desde_id: 0 }
  );
  assert.equal(joinAck.error, "No autorizado");
  assert.deepEqual(socket.salasUnidas, []);

  const syncAck = await invocarConAck(
    socket.handlers.get("chat:sync"),
    { modulo: "turismo", entidad_id: 21, desde_id: 0 }
  );
  assert.equal(syncAck.error, "Conversación no suscripta");
});

test("sync revoca la room si cambian los permisos con el socket abierto", async () => {
  const socket = crearSocketFalso({ id: 8, rol: "afiliado", modulo_turismo: 1 });
  let turismoHabilitado = 1;
  const db = {
    async query(sql) {
      if (sql.includes("FROM usuario u") && sql.includes("INNER JOIN rol")) {
        return [[usuarioChatActual({ modulo_turismo: turismoHabilitado })]];
      }
      if (sql.includes("FROM reserva r")) {
        return [[{ usuario_id: 8, departamental_id: 2 }]];
      }
      if (sql.includes("FROM reserva_observacion")) return [[]];
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };

  registrarEventosChatTiempoReal({ io: { to: () => ({ emit() {} }) }, socket, db });
  const joinAck = await invocarConAck(
    socket.handlers.get("chat:join"),
    { modulo: "turismo", entidad_id: 21, desde_id: 0 }
  );
  assert.equal(joinAck.ok, true);

  turismoHabilitado = 0;
  const syncAck = await invocarConAck(
    socket.handlers.get("chat:sync"),
    { modulo: "turismo", entidad_id: 21, desde_id: 0 }
  );
  assert.equal(syncAck.error, "No autorizado");
  assert.deepEqual(socket.salasAbandonadas, ["chat:turismo:21"]);
  assert.equal(socket.data.chatConversacion, null);
});
