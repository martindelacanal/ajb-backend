const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ESTADO_APROBADA,
  ESTADO_RECHAZADA,
  ESTADO_VERIFICADA,
  PLAZO_RESPUESTA_HORAS,
  asegurarSinReservaIniciadaAfiliado,
  esModalidadTurismoRegular,
  expirarPendientes72Horas,
  expirarPropuestaConvenioEnTransaccion,
  expirarReservaTurismoEnTransaccion,
  normalizarModalidadTurismo,
  obtenerEstadoAltaTurismo,
  validarTransicionTurismo,
} = require("../api/services/reservas-turismo");

const rutaUser = path.resolve(__dirname, "../api/routes/user.js");
const rutaServer = path.resolve(__dirname, "../server.js");

function transicion(rol, actual, destino, opciones = {}) {
  return validarTransicionTurismo({
    rol,
    usuarioId: opciones.usuarioId || 10,
    propietarioId: opciones.propietarioId || 10,
    estadoActual: actual,
    estadoSolicitado: destino,
    modalidad: Object.prototype.hasOwnProperty.call(opciones, "modalidad")
      ? opciones.modalidad
      : "FECHA_LIBRE",
  });
}

test("la departamental crea turismo verificado pero el resto conserva Iniciada", () => {
  assert.equal(obtenerEstadoAltaTurismo("departamental"), ESTADO_VERIFICADA);
  assert.equal(obtenerEstadoAltaTurismo("afiliado"), "Iniciada");
  assert.equal(obtenerEstadoAltaTurismo("admin"), "Iniciada");
});

test("solo admin aprueba o rechaza una reserva verificada", () => {
  const aprobarAdmin = transicion("admin", "Verificada", "Aprobada");
  assert.equal(aprobarAdmin.valido, true);
  assert.equal(aprobarAdmin.estadoDestino, ESTADO_APROBADA);

  for (const rol of ["departamental", "afiliado"]) {
    const aprobar = transicion(rol, "Verificada", "Aprobada");
    const rechazar = transicion(rol, "Verificada", "Rechazada");
    assert.equal(aprobar.valido, false, rol);
    assert.equal(aprobar.statusCode, 403, rol);
    assert.equal(rechazar.valido, false, rol);
    assert.equal(rechazar.statusCode, 403, rol);
  }

  assert.equal(transicion("admin", "Verificada", "Rechazada").valido, true);
});

test("departamental verifica/rechaza Iniciada y afiliado solo cancela la propia", () => {
  assert.equal(transicion("departamental", "Iniciada", "Verificada").valido, true);
  assert.equal(transicion("departamental", "Iniciada", "Rechazada").valido, true);
  assert.equal(transicion("afiliado", "Iniciada", "Cancelada").valido, true);

  const ajena = transicion("afiliado", "Iniciada", "Cancelada", {
    usuarioId: 10,
    propietarioId: 11,
  });
  assert.equal(ajena.valido, false);
  assert.equal(ajena.statusCode, 403);
  assert.equal(transicion("afiliado", "Iniciada", "Rechazada").valido, false);
});

test("los flujos sorteo/convenio no aceptan el endpoint de estados regular", () => {
  for (const modalidad of ["SORTEO", "CONVENIO"]) {
    const resultado = transicion("admin", "Verificada", "Aprobada", { modalidad });
    assert.equal(resultado.valido, false);
    assert.equal(resultado.codigo, "FLUJO_RESERVA_ESPECIAL");
  }
});

test("NULL y modalidad vacia conservan la semantica legacy FECHA_LIBRE", () => {
  for (const modalidad of [null, undefined, "", "   "]) {
    assert.equal(normalizarModalidadTurismo(modalidad), "FECHA_LIBRE");
    assert.equal(esModalidadTurismoRegular(modalidad), true);
    assert.equal(
      transicion("admin", "Verificada", "Aprobada", { modalidad }).valido,
      true
    );
  }
  assert.equal(esModalidadTurismoRegular("CONVENIO"), false);
  assert.equal(esModalidadTurismoRegular("desconocida"), false);
  assert.equal(esModalidadTurismoRegular([]), false);
});

test("el control de reserva iniciada bloquea la fila del afiliado y devuelve datos amigables", async () => {
  const consultas = [];
  const connection = {
    async query(sql, params) {
      consultas.push({ sql, params });
      if (sql.startsWith("SELECT id FROM usuario")) return [[{ id: 7 }]];
      if (sql.startsWith("SELECT id, nombre FROM estado_reserva")) {
        return [[{ id: 1, nombre: "Iniciada" }, { id: 4, nombre: "Rechazada" }]];
      }
      if (sql.includes("FROM reserva r") && sql.includes("FOR UPDATE")) {
        return [[{
          id: 55,
          usuario_id: 7,
          estado_reserva_id: 1,
          modalidad: null,
          fecha_inicio: "2026-09-01",
          fecha_fin: "2026-09-04",
          fecha_creacion: "2026-08-19 12:00:00",
          vencida: 0,
        }]];
      }
      if (sql.includes("SELECT ? AS estado")) {
        return [[{ estado: "Iniciada", servicio: "Turismo", recurso: "Cabaña" }]];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };

  const reserva = await asegurarSinReservaIniciadaAfiliado(connection, 7);
  assert.deepEqual(reserva, {
    id: 55,
    numero_reserva: "55",
    estado: "Iniciada",
    modalidad: "FECHA_LIBRE",
    servicio: "Turismo",
    recurso: "Cabaña",
    fecha_inicio: "2026-09-01",
    fecha_fin: "2026-09-04",
    fecha_creacion: "2026-08-19 12:00:00",
  });
  assert.match(consultas[0].sql, /usuario WHERE id = \? FOR UPDATE/);
  assert.match(consultas[2].sql, new RegExp(`INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR`));
  assert.match(consultas[2].sql, /r\.modalidad IS NULL/);
  assert.match(consultas[2].sql, /TRIM\(CAST\(r\.modalidad AS CHAR\)\) = ''/);
});

test("el worker de 72 horas incluye reservas legacy NULL o vacias", async () => {
  const consultas = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      consultas.push({ sql, params });
      if (sql.includes("GET_LOCK")) return [[{ adquirido: 1 }]];
      if (sql.startsWith("SELECT id, nombre FROM estado_reserva")) {
        return [[
          { id: 1, nombre: "Iniciada" },
          { id: 4, nombre: "Rechazada" },
          { id: 8, nombre: "Propuesta convenio" },
          { id: 9, nombre: "Convenio rechazado" },
        ]];
      }
      if (sql.includes("STRAIGHT_JOIN reserva_convenio_propuesta")) return [[]];
      if (sql.includes("FROM reserva r") && sql.includes("FOR UPDATE SKIP LOCKED")) return [[]];
      if (sql.includes("RELEASE_LOCK")) return [[{ liberado: 1 }]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };

  const resultado = await expirarPendientes72Horas({
    async getConnection() {
      return connection;
    },
  });

  assert.deepEqual(resultado, { ejecutado: true, turismo: 0, convenios: 0 });
  const consultaTurismo = consultas.find(({ sql }) =>
    sql.includes("FROM reserva r") &&
    !sql.includes("reserva_convenio_propuesta") &&
    sql.includes("FOR UPDATE SKIP LOCKED")
  );
  assert.ok(consultaTurismo);
  assert.match(consultaTurismo.sql, /r\.modalidad IS NULL/);
  assert.match(consultaTurismo.sql, /TRIM\(CAST\(r\.modalidad AS CHAR\)\) = ''/);
});

test("vencer turismo cambia a Rechazada, libera el bloque y deja historial/notificacion", async () => {
  const consultas = [];
  const connection = {
    async query(sql, params) {
      consultas.push({ sql, params });
      if (sql.includes("UPDATE reserva") && sql.includes("estado_reserva_id")) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM bloque_fecha_recurso")) {
        return [[{
          bloque_fecha_id: 8,
          recurso_id: 3,
          modalidad: "BLOQUE",
          bloque_estado: "ACTIVO",
          sorteo_estado: null,
        }]];
      }
      return [{ affectedRows: 1 }];
    },
  };

  const vencida = await expirarReservaTurismoEnTransaccion(
    connection,
    { id: 40, usuario_id: 9, estado_reserva_id: 1 },
    4
  );
  assert.equal(vencida, true);
  assert.ok(consultas.some(({ sql, params }) =>
    sql.includes("UPDATE bloque_fecha_recurso") && params[0] === "DISPONIBLE"));
  assert.ok(consultas.some(({ sql, params }) =>
    sql.includes("INSERT INTO historial_reserva") && params.at(-1).includes("72 horas")));
  assert.ok(consultas.some(({ sql, params }) =>
    sql.includes("INSERT INTO notificacion") && params[1] === "RESERVA_RECHAZADA_SIN_RESPUESTA"));
});

test("vencer una cotizacion rechaza propuesta/reserva y notifica al afiliado", async () => {
  const consultas = [];
  const connection = {
    async query(sql, params) {
      consultas.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  };

  const vencida = await expirarPropuestaConvenioEnTransaccion(
    connection,
    { id: 80, usuario_id: 12, estado_reserva_id: 10 },
    { respuesta: "PENDIENTE" },
    12
  );
  assert.equal(vencida, true);
  assert.ok(consultas.some(({ sql }) =>
    sql.includes("reserva_convenio_propuesta") && sql.includes("respuesta = 'RECHAZADA'")));
  assert.ok(consultas.some(({ sql, params }) =>
    sql.includes("INSERT INTO notificacion") && params[1] === "CONVENIO_PROPUESTA_VENCIDA"));
});

test("las rutas publican los contratos nuevos y el servidor inicia el mantenimiento", () => {
  const userSource = fs.readFileSync(rutaUser, "utf8");
  const serverSource = fs.readFileSync(rutaServer, "utf8");

  assert.match(userSource, /RESERVA_INICIADA_EXISTENTE/);
  assert.match(userSource, /esRolCargaAdministrativa = \["admin", "departamental"\]/);
  assert.match(userSource, /TITULAR_OTRA_DEPARTAMENTAL/);
  assert.match(userSource, /"Propuesta de cotización"/);
  assert.match(userSource, /PROPUESTA_CONVENIO_VENCIDA/);
  assert.match(userSource, /\["Verificada", "Aprobada", "Rechazada", "Cancelada"\]/);
  assert.match(serverSource, /iniciarMantenimientoReservas\(mysqlConnection\.promise\(\)\)/);
});
