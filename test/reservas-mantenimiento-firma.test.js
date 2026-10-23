const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// «Pendiente de firma» en el mantenimiento de reservas y el inicio único del plazo
// de 72 horas: la reserva que no se firmó a tiempo se da
// de baja sola, y una «Iniciada» que viene de una firma cuenta las 72 horas desde
// la firma (no desde la creación) en el alta, el mantenimiento y el detalle.

const firmaService = require("../api/services/reservas-firma");
const familiaresService = require("../api/services/reservas-familiares");
const {
  PLAZO_RESPUESTA_HORAS,
  asegurarSinReservaIniciadaAfiliado,
  expirarPendientes72Horas,
  iniciarMantenimientoReservas,
} = require("../api/services/reservas-turismo");

const rutaUser = path.resolve(__dirname, "../api/routes/user.js");

async function esperar(condicion, ms = 2000) {
  const limite = Date.now() + ms;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error("El mantenimiento no corrió a tiempo");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function silenciarConsola(t) {
  const logs = [];
  const errores = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  t.mock.method(console, "error", (...args) => errores.push(args.join(" ")));
  return { logs, errores };
}

test("el mantenimiento también da de baja las firmas vencidas, en un bloque aparte del de 72 horas", async (t) => {
  const llamadas = [];
  t.mock.method(firmaService, "expirarFirmasVencidas", async (db) => {
    llamadas.push(db);
    return { ejecutado: true, firmas: 2, eventos: [] };
  });
  t.mock.method(familiaresService, "expirarSolicitudesTitularVencidas", async () => ({ ejecutado: true, solicitudes: 0 }));
  const { logs, errores } = silenciarConsola(t);
  // El vencimiento de 72 horas falla (sin conexión): igual corre el de las firmas.
  const db = {
    async getConnection() {
      throw Object.assign(new Error("sin conexión"), { code: "ECONNREFUSED" });
    },
  };
  const detener = iniciarMantenimientoReservas(db, { demoraInicialMs: 0, intervaloMs: 60000 });
  try {
    await esperar(() => llamadas.length === 1 && logs.length === 1);
  } finally {
    detener();
  }
  assert.equal(llamadas[0], db);
  assert.deepEqual(errores, ["Error en mantenimiento de reservas de 72 horas: ECONNREFUSED"]);
  assert.deepEqual(logs, ["Mantenimiento de reservas: 2 reservas sin firmar dadas de baja"]);
});

test("el mantenimiento da de baja las solicitudes que el titular no respondió, en un bloque aparte", async (t) => {
  // Las de 72 horas y las firmas fallan: igual corre el bloque del titular, y su error no frena el de las firmas.
  t.mock.method(firmaService, "expirarFirmasVencidas", async () => {
    throw Object.assign(new Error("Lock wait timeout"), { code: "ER_LOCK_WAIT_TIMEOUT" });
  });
  let llamadas = 0;
  t.mock.method(familiaresService, "expirarSolicitudesTitularVencidas", async (db) => {
    llamadas += 1;
    assert.ok(db);
    return { ejecutado: true, solicitudes: 1 };
  });
  const { logs, errores } = silenciarConsola(t);
  const db = {
    async getConnection() {
      throw Object.assign(new Error("sin conexión"), { code: "ECONNREFUSED" });
    },
  };
  const detener = iniciarMantenimientoReservas(db, { demoraInicialMs: 0, intervaloMs: 60000 });
  try {
    await esperar(() => errores.length === 2);
  } finally {
    detener();
  }
  assert.equal(llamadas, 1);
  assert.deepEqual(logs, ["Mantenimiento de reservas: 1 solicitud sin respuesta del titular dada de baja"]);
  assert.deepEqual(errores, [
    "Error en mantenimiento de reservas de 72 horas: ECONNREFUSED",
    "Error en mantenimiento de firmas pendientes: ER_LOCK_WAIT_TIMEOUT",
  ]);

  // Un error propio se registra aparte (y no impide el de las firmas).
  t.mock.method(familiaresService, "expirarSolicitudesTitularVencidas", async () => {
    throw Object.assign(new Error("Lock wait timeout"), { code: "ER_LOCK_WAIT_TIMEOUT" });
  });
  errores.length = 0;
  const detener2 = iniciarMantenimientoReservas(db, { demoraInicialMs: 0, intervaloMs: 60000 });
  try {
    await esperar(() => errores.length === 3);
  } finally {
    detener2();
  }
  assert.ok(errores.includes("Error en mantenimiento de solicitudes del titular: ER_LOCK_WAIT_TIMEOUT"));
  assert.ok(errores.includes("Error en mantenimiento de firmas pendientes: ER_LOCK_WAIT_TIMEOUT"));
});

test("un error en las firmas vencidas se registra y no frena las corridas siguientes", async (t) => {
  let llamadas = 0;
  t.mock.method(firmaService, "expirarFirmasVencidas", async () => {
    llamadas += 1;
    throw Object.assign(new Error("Lock wait timeout"), { code: "ER_LOCK_WAIT_TIMEOUT" });
  });
  t.mock.method(familiaresService, "expirarSolicitudesTitularVencidas", async () => ({ ejecutado: true, solicitudes: 0 }));
  const { logs, errores } = silenciarConsola(t);
  const db = {
    async getConnection() {
      throw Object.assign(new Error("sin conexión"), { code: "ECONNREFUSED" });
    },
  };
  const detener = iniciarMantenimientoReservas(db, { demoraInicialMs: 0, intervaloMs: 60000 });
  try {
    await esperar(() => errores.length === 2);
  } finally {
    detener();
  }
  assert.equal(llamadas, 1);
  assert.deepEqual(errores, [
    "Error en mantenimiento de reservas de 72 horas: ECONNREFUSED",
    "Error en mantenimiento de firmas pendientes: ER_LOCK_WAIT_TIMEOUT",
  ]);
  assert.deepEqual(logs, []);
});

test("sin la migración, el mantenimiento deja a la vista que no vence las firmas (con el código del error)", async (t) => {
  // La base real sin la tabla: expirarFirmasVencidas la omite y el mantenimiento lo avisa.
  t.mock.method(familiaresService, "expirarSolicitudesTitularVencidas", async () => ({ ejecutado: true, solicitudes: 0 }));
  const avisos = [];
  t.mock.method(console, "warn", (...args) => avisos.push(args.join(" ")));
  const { logs } = silenciarConsola(t);
  const conexion = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql) {
      if (sql.includes("GET_LOCK")) return [[{ adquirido: 1 }]];
      if (sql.includes("RELEASE_LOCK")) return [[{ liberado: 1 }]];
      if (sql.startsWith("SELECT id, nombre FROM estado_reserva")) return [[]];
      if (sql.startsWith("SELECT id FROM estado_reserva WHERE nombre = ?")) return [[{ id: 15 }]];
      if (sql.includes("FROM reserva_firma_afiliado f")) {
        throw Object.assign(new Error("Table 'reserva_firma_afiliado' doesn't exist"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  const detener = iniciarMantenimientoReservas({ getConnection: async () => conexion }, { demoraInicialMs: 0, intervaloMs: 60000 });
  try {
    await esperar(() => avisos.length === 1);
  } finally {
    detener();
  }
  assert.deepEqual(avisos, ["Vencimiento de firmas omitido: SIN_MIGRACION (ER_NO_SUCH_TABLE)"]);
  assert.deepEqual(logs, []);
});

test("las 72 horas de una «Iniciada» empiezan en el mismo momento en el alta, el mantenimiento y el detalle", async () => {
  const inicio = firmaService.sqlInicioPlazoVerificacion("r");
  assert.match(inicio, /reserva_firma_afiliado f WHERE f\.reserva_id = r\.id AND f\.decision = 'FIRMADA'/);

  // Alta: la «Iniciada» que viene de una firma no se toma como vencida a las 72 horas de creada.
  const consultasAlta = [];
  const conexionAlta = {
    async query(sql) {
      consultasAlta.push(sql);
      if (sql.startsWith("SELECT id FROM usuario")) return [[{ id: 7 }]];
      if (sql.startsWith("SELECT id, nombre FROM estado_reserva")) {
        return [[{ id: 1, nombre: "Iniciada" }, { id: 4, nombre: "Rechazada" }]];
      }
      if (sql.includes("FROM reserva r") && sql.includes("FOR UPDATE")) return [[]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  assert.equal(await asegurarSinReservaIniciadaAfiliado(conexionAlta, 7), null);
  const consultaAlta = consultasAlta.find((sql) => sql.includes("AS vencida"));
  assert.ok(consultaAlta.includes(`(${inicio} <= DATE_SUB(NOW(), INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR)) AS vencida`));

  // Mantenimiento: la misma cuenta.
  const consultas = [];
  const conexion = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql) {
      consultas.push(sql);
      if (sql.includes("GET_LOCK")) return [[{ adquirido: 1 }]];
      if (sql.startsWith("SELECT id, nombre FROM estado_reserva")) {
        return [[
          { id: 1, nombre: "Iniciada" },
          { id: 4, nombre: "Rechazada" },
          { id: 10, nombre: "Propuesta convenio" },
          { id: 12, nombre: "Convenio rechazado" },
        ]];
      }
      if (sql.includes("FOR UPDATE SKIP LOCKED") || sql.includes("RELEASE_LOCK")) return [[]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  assert.deepEqual(await expirarPendientes72Horas({ getConnection: async () => conexion }), {
    ejecutado: true, turismo: 0, convenios: 0,
  });
  const consultaTurismo = consultas.find((sql) => sql.includes("FROM reserva r") && !sql.includes("reserva_convenio_propuesta"));
  assert.ok(consultaTurismo.includes(`AND ${inicio} <= DATE_SUB(NOW(), INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR)`));

  // Detalle: «El plazo vence el …» del resumen y de la edición sale del mismo fragmento.
  const userSource = fs.readFileSync(rutaUser, "utf8");
  const vencimientos = userSource.match(
    /DATE_ADD\(\$\{reservasFirma\.sqlInicioPlazoVerificacion\("r"\)\}, INTERVAL \$\{PLAZO_RESPUESTA_HORAS\} HOUR\) AS fecha_vencimiento_respuesta/g
  ) || [];
  assert.equal(vencimientos.length, 2);
  assert.doesNotMatch(userSource, /COALESCE\(\(SELECT a\.fecha_respuesta FROM reserva_aprobacion_titular a/);
});
