const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "reservas-autorizacion-test-secret";

const databaseCalls = [];
const transactionCalls = [];
let usuarioSesionActual = null;
let databaseHandler = async () => [[]];

const transactionalConnection = {
  async beginTransaction() { transactionCalls.push("begin"); },
  async commit() { transactionCalls.push("commit"); },
  async rollback() { transactionCalls.push("rollback"); },
  release() {},
  async query(sql, params = []) {
    databaseCalls.push({ method: "query", sql, params });
    if (esConsultaAutorizacion(sql)) {
      return usuarioSesionActual ? [[usuarioSesionActual]] : [[]];
    }
    return databaseHandler(sql, params);
  },
  async execute(sql, params = []) {
    databaseCalls.push({ method: "execute", sql, params });
    return databaseHandler(sql, params);
  },
};

const fakePool = {
  promise() {
    return {
      getConnection: async () => transactionalConnection,
      query: transactionalConnection.query.bind(transactionalConnection),
      execute: transactionalConnection.execute.bind(transactionalConnection),
    };
  },
};

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: fakePool,
};

const userRouter = require("../api/routes/user");
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/api", userRouter);

const consoleLogOriginal = console.log;
test.before(() => {
  console.log = () => {};
});
test.after(() => {
  console.log = consoleLogOriginal;
});

function setDatabaseHandler(handler) {
  databaseCalls.length = 0;
  transactionCalls.length = 0;
  databaseHandler = handler;
}

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

function filaAutorizacion(claims) {
  const rolIds = { admin: 1, departamental: 2, afiliado: 3 };
  return {
    id: Number(claims.id),
    rol_id: rolIds[claims.rol] || 99,
    rol: claims.rol,
    departamental_id: claims.departamental_id ?? null,
    habilitado: claims.habilitado ?? "Y",
    area_turismo: claims.area_turismo ?? 1,
    area_coseguro: claims.area_coseguro ?? 1,
    modulo_turismo: claims.modulo_turismo ?? 1,
    modulo_coseguro: claims.modulo_coseguro ?? 1,
    modulo_olimpiadas: claims.modulo_olimpiadas ?? 1,
  };
}

function tokenFor(overrides = {}) {
  const claims = {
    id: 100,
    rol: "admin",
    departamental_id: null,
    area_turismo: 1,
    ...overrides,
  };
  usuarioSesionActual = filaAutorizacion(claims);
  return jwt.sign({
    data: JSON.stringify(claims),
  }, process.env.JWT_SECRET);
}

async function request(path, { method = "GET", token, body } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function bodyEdicion(overrides = {}) {
  return {
    nombre: "Reserva de prueba",
    fecha_inicio: "2099-01-10",
    fecha_fin: "2099-01-13",
    servicio_id: 1,
    recurso_id: 2,
    regimen_id: 1,
    personas: [{ id: 200 }],
    ...overrides,
  };
}

function bodyConvenio(overrides = {}) {
  return {
    fecha_inicio: "2099-01-10",
    fecha_fin: "2099-01-13",
    personas: [{ id: 200 }],
    firma: "firma-de-prueba",
    ...overrides,
  };
}

function responderReservaEdicion({
  estado = "Iniciada",
  usuarioId = 200,
  usuarioDepartamentalId = 8,
  modalidad = "FECHA_LIBRE",
  departamentalEditorId = 7,
} = {}) {
  return async (sql) => {
    if (/FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql)) {
      return [[{
        id: 100,
        rol_id: 3,
        rol: "afiliado",
        departamental_id: 7,
        habilitado: "Y",
        area_turismo: 1,
        area_coseguro: 1,
        modulo_turismo: 1,
        modulo_coseguro: 1,
        modulo_olimpiadas: 1,
      }]];
    }
    if (/FROM reserva r[\s\S]+FOR UPDATE/i.test(sql)) {
      return [[{
        id: 77,
        usuario_id: usuarioId,
        usuario_departamental_id: usuarioDepartamentalId,
        estado_nombre: estado,
        modalidad,
        fecha_inicio: "2099-01-10",
        fecha_fin: "2099-01-13",
      }]];
    }
    if (/SELECT departamental_id FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{ departamental_id: departamentalEditorId }]];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

test("PUT /reserva/:id rechaza cualquier estado distinto de Iniciada", async () => {
  for (const estado of ["Verificada", "Aprobada", "Rechazada"]) {
    setDatabaseHandler(responderReservaEdicion({ estado, usuarioId: 100 }));

    const response = await request("/api/reserva/77", {
      method: "PUT",
      token: tokenFor({ rol: "admin" }),
      body: bodyEdicion(),
    });

    assert.equal(response.status, 409, estado);
    assert.equal(response.body.codigo, "RESERVA_NO_EDITABLE_POR_ESTADO", estado);
    assert.equal(databaseCalls.filter(({ sql }) => /UPDATE reserva/i.test(sql)).length, 0, estado);
  }
});

test("PUT /reserva/:id autoriza propietario y jurisdiccion antes de revelar el estado", async () => {
  setDatabaseHandler(responderReservaEdicion({ estado: "Verificada", usuarioId: 200 }));
  const afiliado = await request("/api/reserva/77", {
    method: "PUT",
    token: tokenFor({ id: 100, rol: "afiliado", departamental_id: 7 }),
    body: bodyEdicion(),
  });
  assert.equal(afiliado.status, 403);

  setDatabaseHandler(responderReservaEdicion({
    estado: "Iniciada",
    usuarioId: 200,
    usuarioDepartamentalId: 8,
    departamentalEditorId: 7,
  }));
  const departamental = await request("/api/reserva/77", {
    method: "PUT",
    token: tokenFor({ id: 100, rol: "departamental", departamental_id: 7 }),
    body: bodyEdicion(),
  });
  assert.equal(departamental.status, 403);
  assert.equal(databaseCalls.filter(({ sql }) => /UPDATE reserva/i.test(sql)).length, 0);
});

function responderLecturaFueraDeJurisdiccion(modalidad) {
  return async (sql) => {
    if (/FROM reserva r/i.test(sql)) {
      return [[{
        id: 77,
        usuario_id: 200,
        usuario_departamental_id: 8,
        modalidad,
      }]];
    }
    if (/SELECT id, departamental_id FROM usuario WHERE id IN/i.test(sql)) {
      return [[
        { id: 100, departamental_id: 7 },
        { id: 200, departamental_id: 8 },
      ]];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

test("edicion y resumen niegan a departamental ajena en todas las modalidades", async () => {
  const token = tokenFor({ id: 100, rol: "departamental", departamental_id: 7 });
  for (const endpoint of ["edicion", "resumen"]) {
    for (const modalidad of ["FECHA_LIBRE", "BLOQUE", "SORTEO", "CONVENIO"]) {
      setDatabaseHandler(responderLecturaFueraDeJurisdiccion(modalidad));
      const response = await request(`/api/reserva/77/${endpoint}`, { token });
      assert.equal(response.status, 403, `${endpoint} ${modalidad}`);
      assert.equal(
        databaseCalls.some(({ sql }) => /FROM reserva_familiar/i.test(sql)),
        false,
        `${endpoint} ${modalidad}`
      );
    }
  }
});

function responderConvenio({ estado = "Solicitud convenio", propuesta = null } = {}) {
  return async (sql) => {
    if (/FROM reserva r[\s\S]+r\.modalidad = \?/i.test(sql)) {
      return [[{
        id: 88,
        usuario_id: 200,
        usuario_departamental_id: 7,
        modalidad: "CONVENIO",
        estado_nombre: estado,
        convenio_hotel_id: 3,
      }]];
    }
    if (/FROM reserva_convenio_propuesta[\s\S]+FOR UPDATE/i.test(sql)) {
      return [propuesta ? [propuesta] : []];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

const bodyPropuesta = {
  mensaje: "Cotizacion de prueba",
  costos: [{ reserva_familiar_id: 1, precio: 1000 }],
};

test("una propuesta solo puede nacer desde Solicitud convenio", async () => {
  for (const estado of ["Propuesta convenio", "Convenio aceptado", "Convenio rechazado", "Rechazada"]) {
    setDatabaseHandler(responderConvenio({ estado }));
    const response = await request("/api/reserva/88/convenio/propuesta", {
      method: "PUT",
      token: tokenFor({ rol: "departamental", departamental_id: 7 }),
      body: bodyPropuesta,
    });
    assert.equal(response.status, 409, estado);
    assert.equal(response.body.codigo, "CONVENIO_NO_COTIZABLE", estado);
    assert.equal(databaseCalls.some(({ sql }) => /INSERT INTO reserva_convenio_propuesta/i.test(sql)), false);
  }
});

test("una solicitud no permite reemplazar una cotizacion ya registrada", async () => {
  setDatabaseHandler(responderConvenio({
    propuesta: { id: 9, respuesta: "RECHAZADA", fecha_propuesta: "2099-01-01" },
  }));
  const response = await request("/api/reserva/88/convenio/propuesta", {
    method: "PUT",
    token: tokenFor({ rol: "departamental", departamental_id: 7 }),
    body: bodyPropuesta,
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.codigo, "CONVENIO_PROPUESTA_EXISTENTE");
  assert.equal(databaseCalls.some(({ sql }) => /INSERT INTO reserva_convenio_propuesta/i.test(sql)), false);
});

test("las altas administrativas regulares y de convenio exigen usuario_id", async () => {
  setDatabaseHandler(async (sql) => {
    throw new Error(`No debio consultar la base: ${sql}`);
  });

  for (const rol of ["admin", "departamental"]) {
    for (const alta of [
      { endpoint: "/api/reserva", body: bodyEdicion() },
      { endpoint: "/api/convenios-hoteleros/3/reservas", body: bodyConvenio() },
    ]) {
      const response = await request(alta.endpoint, {
        method: "POST",
        token: tokenFor({ rol, departamental_id: rol === "departamental" ? 7 : null }),
        body: alta.body,
      });
      assert.equal(response.status, 400, `${rol} ${alta.endpoint}`);
      assert.equal(response.body.codigo, "TITULAR_REQUERIDO", `${rol} ${alta.endpoint}`);
    }
  }
});

test("las altas administrativas rechazan titulares no afiliados o deshabilitados", async () => {
  for (const titular of [
    { id: 200, habilitado: "Y", rol: "departamental", departamental_id: 7 },
    { id: 200, habilitado: "N", rol: "afiliado", departamental_id: 7 },
  ]) {
    setDatabaseHandler(async (sql) => {
      if (/SELECT u\.id, u\.nombre/i.test(sql)) return [[titular]];
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    const response = await request("/api/reserva", {
      method: "POST",
      token: tokenFor({ rol: "admin" }),
      body: bodyEdicion({ usuario_id: 200 }),
    });
    assert.equal(response.status, 422, titular);
    assert.equal(response.body.codigo, "TITULAR_NO_AFILIADO", titular);
  }
});

test("una departamental no puede cargar para un afiliado de otra jurisdiccion", async () => {
  setDatabaseHandler(async (sql) => {
    if (/SELECT u\.id, u\.nombre/i.test(sql)) {
      return [[{
        id: 200,
        habilitado: "Y",
        rol: "afiliado",
        departamental_id: 8,
        modulo_turismo: 1,
      }]];
    }
    if (/SELECT departamental_id FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{ departamental_id: 7 }]];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const response = await request("/api/reserva", {
    method: "POST",
    token: tokenFor({ rol: "departamental", departamental_id: 7 }),
    body: bodyEdicion({ usuario_id: 200 }),
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.codigo, "TITULAR_OTRA_DEPARTAMENTAL");
  assert.equal(databaseCalls.some(({ sql }) => /INSERT INTO reserva/i.test(sql)), false);
});

function responderTitularParaAlta(overrides = {}) {
  const titular = {
    id: 200,
    nombre: "Ana",
    apellido: "Afiliada",
    usuario_familiar_id: null,
    departamental_id: 7,
    habilitado: "Y",
    rol: "afiliado",
    modulo_turismo: 1,
    modulo_coseguro: 1,
    ...overrides,
  };
  return async (sql) => {
    if (/SELECT u\.id, u\.nombre[\s\S]+FOR UPDATE/i.test(sql)) return [[titular]];
    throw new Error(`No debio avanzar despues de validar el titular: ${sql}`);
  };
}

const altasTurismo = [
  {
    nombre: "regular",
    endpoint: "/api/reserva",
    body: (overrides) => bodyEdicion({ usuario_id: 200, ...overrides }),
  },
  {
    nombre: "convenio",
    endpoint: "/api/convenios-hoteleros/3/reservas",
    body: (overrides) => bodyConvenio({ usuario_id: 200, ...overrides }),
  },
];

test("staff no puede crear turismo regular ni convenio para un titular con Turismo apagado", async () => {
  for (const alta of altasTurismo) {
    setDatabaseHandler(responderTitularParaAlta({ modulo_turismo: 0 }));
    const response = await request(alta.endpoint, {
      method: "POST",
      token: tokenFor({ rol: "admin" }),
      body: alta.body({}),
    });

    assert.equal(response.status, 403, alta.nombre);
    assert.equal(response.body.codigo, "MODULO_TURISMO_DESHABILITADO", alta.nombre);
    assert.equal(databaseCalls.some(({ sql }) => /INSERT INTO reserva/i.test(sql)), false, alta.nombre);
    assert.equal(databaseCalls.some(({ sql }) => /FROM convenio_hotel/i.test(sql)), false, alta.nombre);
  }
});

test("un convenio no admite reservas si su servicio no es visible para la departamental del titular", async () => {
  setDatabaseHandler(async (sql) => {
    if (/SELECT u\.id, u\.nombre[\s\S]+FOR UPDATE/i.test(sql)) {
      return [[{
        id: 100,
        nombre: "Ana",
        apellido: "Afiliada",
        usuario_familiar_id: null,
        departamental_id: 7,
        habilitado: "Y",
        modulo_turismo: 1,
        modulo_coseguro: 1,
        rol: "afiliado",
      }]];
    }
    if (/SELECT id, nombre, servicio_id FROM convenio_hotel/i.test(sql)) {
      return [[{ id: 3, nombre: "Hotel oculto", servicio_id: 44 }]];
    }
    if (/SELECT s\.id, s\.tipo_servicio_id[\s\S]+FROM servicio s/i.test(sql)) return [[]];
    throw new Error(`Consulta inesperada: ${sql}`);
  });

  const response = await request("/api/convenios-hoteleros/3/reservas", {
    method: "POST",
    token: tokenFor({ id: 100, rol: "afiliado", departamental_id: 7 }),
    body: bodyConvenio(),
  });

  assert.equal(response.status, 404);
  assert.equal(response.body, "Convenio hotelero no disponible");
  assert.equal(transactionCalls.includes("rollback"), true);
  assert.equal(transactionCalls.includes("commit"), false);
  assert.equal(databaseCalls.some(({ sql }) => /INSERT INTO reserva/i.test(sql)), false);
});

function configuracionServicioVisible(overrides = {}) {
  return {
    id: 1,
    tipo_servicio_id: 1,
    propietario_departamental_id: 7,
    modelo_tarifa: "TEMPORADAS",
    unidad_cobro: "POR_PERSONA_NOCHE",
    permite_acompanantes: 1,
    max_personas_reserva: 6,
    recurso_cupo_maximo: null,
    tipo_codigo: "ALOJAMIENTO_RECURSO",
    ...overrides,
  };
}

test("SOLO_TITULAR y la capacidad se validan antes de insertar reservas regulares o de convenio", async () => {
  const escenarios = [
    {
      nombre: "precio unico con otra persona",
      endpoint: "/api/reserva",
      body: bodyEdicion({ usuario_id: 200, personas: [{ id: 201 }] }),
      configuracion: configuracionServicioVisible({
        modelo_tarifa: "PRECIO_UNICO",
        unidad_cobro: "POR_ESTADIA",
        permite_acompanantes: 0,
        max_personas_reserva: 1,
      }),
    },
    {
      nombre: "capacidad general excedida",
      endpoint: "/api/reserva",
      body: bodyEdicion({
        usuario_id: 200,
        personas: [{ id: 200 }, { id: 201 }, { id: 202 }],
      }),
      configuracion: configuracionServicioVisible({ max_personas_reserva: 2 }),
    },
    {
      nombre: "convenio precio unico con grupo",
      endpoint: "/api/convenios-hoteleros/3/reservas",
      body: bodyConvenio({
        usuario_id: 200,
        personas: [{ id: 200 }, { id: 201 }],
      }),
      configuracion: configuracionServicioVisible({
        id: 44,
        modelo_tarifa: "PRECIO_UNICO",
        unidad_cobro: "POR_ESTADIA",
        permite_acompanantes: 0,
        max_personas_reserva: 1,
        tipo_codigo: "CONVENIO_HOTELERO",
      }),
    },
  ];

  for (const escenario of escenarios) {
    setDatabaseHandler(async (sql) => {
      if (/SELECT u\.id, u\.nombre[\s\S]+FOR UPDATE/i.test(sql)) {
        return [[{
          id: 200,
          nombre: "Ana",
          apellido: "Afiliada",
          documento: "12345678",
          usuario_familiar_id: null,
          departamental_id: 7,
          habilitado: "Y",
          modulo_turismo: 1,
          modulo_coseguro: 1,
          rol: "afiliado",
        }]];
      }
      if (/SELECT id, nombre, servicio_id FROM convenio_hotel/i.test(sql)) {
        return [[{ id: 3, nombre: "Hotel", servicio_id: 44 }]];
      }
      if (/SELECT s\.id, s\.tipo_servicio_id[\s\S]+FROM servicio s/i.test(sql)) {
        return [[escenario.configuracion]];
      }
      throw new Error(`Consulta inesperada en ${escenario.nombre}: ${sql}`);
    });

    const response = await request(escenario.endpoint, {
      method: "POST",
      token: tokenFor({ rol: "admin" }),
      body: escenario.body,
    });

    assert.equal(response.status, 422, escenario.nombre);
    assert.equal(response.body.codigo, "CAPACIDAD_SERVICIO_EXCEDIDA", escenario.nombre);
    assert.equal(databaseCalls.some(({ sql }) => /INSERT INTO reserva/i.test(sql)), false, escenario.nombre);
    assert.equal(transactionCalls.includes("rollback"), true, escenario.nombre);
  }
});

function responderCotizacionTarifa({ configuracion = null } = {}) {
  return async (sql) => {
    if (/SELECT u\.id, u\.habilitado, r\.nombre AS rol/i.test(sql)) {
      return [[{ id: 100, habilitado: "Y", rol: "afiliado" }]];
    }
    if (/SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{ id: 100, usuario_familiar_id: null, departamental_id: 7 }]];
    }
    if (/SELECT id, documento, nombre, apellido, fecha_nacimiento, tipo_persona_id,[\s\S]+FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{
        id: 100,
        documento: "12345678",
        nombre: "Ana",
        apellido: "Afiliada",
        fecha_nacimiento: "1985-06-15",
        tipo_persona_id: 1,
        parentesco_id: 1,
        telefono: null,
        email: null,
      }]];
    }
    if (/SELECT id, documento, departamental_id FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{ id: 100, documento: "12345678", departamental_id: 7 }]];
    }
    if (/SELECT s\.id, s\.tipo_servicio_id[\s\S]+FROM servicio s/i.test(sql)) {
      return [configuracion ? [configuracion] : []];
    }
    if (/SELECT id FROM recurso\s+WHERE id = \? AND servicio_id = \?/i.test(sql)) {
      return [[{ id: 2 }]];
    }
    if (/SELECT r\.id, r\.servicio_id, s\.modelo_tarifa[\s\S]+FROM recurso r/i.test(sql)) {
      return [[{
        id: 2,
        servicio_id: 1,
        modelo_tarifa: configuracion.modelo_tarifa,
        unidad_cobro: configuracion.unidad_cobro,
        propietario_departamental_id: 7,
        permite_acompanantes: configuracion.permite_acompanantes,
        anticipacion_minima_dias: 0,
      }]];
    }
    if (/FROM turismo_tarifa_regla tr[\s\S]+LEFT JOIN tarifa t/i.test(sql)) {
      return [[{
        id: 90,
        servicio_id: 1,
        recurso_id: 2,
        audiencia_departamental: "PROPIA",
        fecha_inicio: "2099-01-01",
        fecha_fin: "2099-12-31",
        precio: 1000,
        porcentaje_descuento: 0,
        tarifa_id: 91,
      }]];
    }
    throw new Error(`Consulta inesperada en cotizacion: ${sql}`);
  };
}

test("tarifa/fechas aplica visibilidad del titular y exige regimen solo en TEMPORADAS", async () => {
  const body = {
    fecha_inicio: "2099-01-10",
    fecha_fin: "2099-01-13",
    servicio_id: 1,
    recurso_id: 2,
    personas: [{ id: 100, dni: "12345678" }],
  };

  setDatabaseHandler(responderCotizacionTarifa());
  const oculta = await request("/api/reserva/tarifa/fechas", {
    method: "POST",
    token: tokenFor({ id: 100, rol: "afiliado", departamental_id: 7 }),
    body,
  });
  assert.equal(oculta.status, 404);
  assert.equal(databaseCalls.some(({ sql }) => /FROM turismo_tarifa_regla tr[\s\S]+LEFT JOIN tarifa t/i.test(sql)), false);

  setDatabaseHandler(responderCotizacionTarifa({
    configuracion: configuracionServicioVisible({
      modelo_tarifa: "PRECIO_UNICO",
      unidad_cobro: "POR_ESTADIA",
      permite_acompanantes: 0,
      max_personas_reserva: 1,
    }),
  }));
  const precioUnico = await request("/api/reserva/tarifa/fechas", {
    method: "POST",
    token: tokenFor({ id: 100, rol: "afiliado", departamental_id: 7 }),
    body,
  });
  assert.equal(precioUnico.status, 200);
  assert.equal(databaseCalls.some(({ sql }) => /FROM turismo_tarifa_regla tr[\s\S]+LEFT JOIN tarifa t/i.test(sql)), true);

  setDatabaseHandler(responderCotizacionTarifa({
    configuracion: configuracionServicioVisible(),
  }));
  const temporadas = await request("/api/reserva/tarifa/fechas", {
    method: "POST",
    token: tokenFor({ id: 100, rol: "afiliado", departamental_id: 7 }),
    body,
  });
  assert.equal(temporadas.status, 400);
  assert.equal(databaseCalls.some(({ sql }) => /FROM turismo_tarifa_regla tr[\s\S]+LEFT JOIN tarifa t/i.test(sql)), false);
});

test("por_salud exige Coseguro activo en el titular para turismo regular y convenio", async () => {
  const salud = {
    por_salud: true,
    salud_motivo: "Tratamiento medico",
  };
  for (const alta of altasTurismo) {
    setDatabaseHandler(responderTitularParaAlta({ modulo_coseguro: 0 }));
    const response = await request(alta.endpoint, {
      method: "POST",
      token: tokenFor({ rol: "admin", modulo_coseguro: 1 }),
      body: alta.body(salud),
    });

    assert.equal(response.status, 403, alta.nombre);
    assert.equal(response.body.codigo, "MODULO_COSEGURO_DESHABILITADO", alta.nombre);
    assert.equal(databaseCalls.some(({ sql }) => /INSERT INTO reserva/i.test(sql)), false, alta.nombre);
  }
});

test("departamental solo Turismo no puede crear por_salud regular ni convenio", async () => {
  setDatabaseHandler(async (sql) => {
    throw new Error(`No debió consultar datos ni subir archivos: ${sql}`);
  });

  const salud = {
    por_salud: true,
    salud_motivo: "Tratamiento medico",
    usuario_id: 200,
  };
  for (const alta of altasTurismo) {
    const response = await request(alta.endpoint, {
      method: "POST",
      token: tokenFor({
        id: 100,
        rol: "departamental",
        departamental_id: 7,
        area_turismo: 1,
        area_coseguro: 0,
      }),
      body: alta.body(salud),
    });

    assert.equal(response.status, 403, alta.nombre);
    assert.equal(response.body.codigo, "AREA_COSEGURO_REQUERIDA", alta.nombre);
    assert.equal(
      databaseCalls.some(({ sql }) => /INSERT INTO reserva|FROM convenio_hotel|SELECT u\.id, u\.nombre/i.test(sql)),
      false,
      alta.nombre
    );
  }
});

test("el afiliado directo tambien usa sus flags canonicos bloqueados para por_salud", async () => {
  setDatabaseHandler(responderTitularParaAlta({ id: 100, modulo_coseguro: 0 }));
  const response = await request("/api/reserva", {
    method: "POST",
    token: tokenFor({ id: 100, rol: "afiliado", modulo_turismo: 1, modulo_coseguro: 1 }),
    body: bodyEdicion({
      por_salud: true,
      salud_motivo: "Tratamiento medico",
    }),
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.codigo, "MODULO_COSEGURO_DESHABILITADO");
  assert.ok(databaseCalls.some(({ sql }) => /SELECT u\.id, u\.nombre[\s\S]+FOR UPDATE/i.test(sql)));
});

test("recursos y adicionales no exponen datos si Turismo esta deshabilitado", async () => {
  setDatabaseHandler(async (sql) => {
    throw new Error(`No debio consultar datos de Turismo: ${sql}`);
  });

  for (const endpoint of ["/api/recursos", "/api/adicionales"]) {
    const response = await request(endpoint, {
      token: tokenFor({
        id: 100,
        rol: "afiliado",
        modulo_turismo: 0,
      }),
    });

    assert.equal(response.status, 401, endpoint);
    assert.equal(response.body, "No autorizado", endpoint);
    assert.equal(
      databaseCalls.some(({ sql }) => /FROM (?:recurso|adicional)/i.test(sql)),
      false,
      endpoint
    );
  }
});

test("recursos y adicionales siguen accesibles con Turismo habilitado", async () => {
  setDatabaseHandler(async (sql) => {
    if (/FROM recurso/i.test(sql)) return [[{ id: 1, nombre: "Departamento" }]];
    if (/FROM adicional/i.test(sql)) return [[{ id: 2, nombre: "Desayuno" }]];
    throw new Error(`Consulta inesperada: ${sql}`);
  });

  for (const endpoint of ["/api/recursos", "/api/adicionales"]) {
    const response = await request(endpoint, {
      token: tokenFor({
        id: 100,
        rol: "afiliado",
        modulo_turismo: 1,
      }),
    });

    assert.equal(response.status, 200, endpoint);
    assert.equal(Array.isArray(response.body), true, endpoint);
  }
});

test("el alta departamental revierte Iniciada y Verificada si falla el segundo hito de historial", async () => {
  let insercionesHistorial = 0;
  setDatabaseHandler(async (sql) => {
    if (/SELECT u\.id, u\.nombre[\s\S]+FOR UPDATE/i.test(sql)) {
      return [[{
        id: 200,
        nombre: "Ana",
        apellido: "Afiliada",
        usuario_familiar_id: null,
        departamental_id: 7,
        habilitado: "Y",
        modulo_turismo: 1,
        modulo_coseguro: 1,
        rol: "afiliado",
      }]];
    }
    if (/SELECT departamental_id FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{ departamental_id: 7 }]];
    }
    if (/SELECT s\.id, s\.tipo_servicio_id[\s\S]+FROM servicio s/i.test(sql)) {
      return [[{
        id: 1,
        tipo_servicio_id: 1,
        propietario_departamental_id: null,
        modelo_tarifa: "TEMPORADAS",
        unidad_cobro: "POR_PERSONA_NOCHE",
        permite_acompanantes: 1,
        max_personas_reserva: 6,
        tipo_codigo: "ALOJAMIENTO_RECURSO",
      }]];
    }
    if (/SELECT s\.id AS servicio_id, s\.modelo_tarifa[\s\S]+FROM servicio s/i.test(sql)) {
      return [[{
        servicio_id: 1,
        modelo_tarifa: "TEMPORADAS",
        permite_acompanantes: 1,
        max_personas_reserva: 6,
        anticipacion_minima_dias: 0,
        tipo_codigo: "ALOJAMIENTO_RECURSO",
        recurso_id: 2,
        cupo_maximo: null,
        es_recurso_principal: 0,
      }]];
    }
    if (/SELECT r\.id, r\.servicio_id, s\.modelo_tarifa[\s\S]+FROM recurso r/i.test(sql)) {
      return [[{
        id: 2,
        servicio_id: 1,
        modelo_tarifa: "TEMPORADAS",
        unidad_cobro: "POR_PERSONA_NOCHE",
        propietario_departamental_id: null,
        permite_acompanantes: 1,
        anticipacion_minima_dias: 0,
      }]];
    }
    if (/^\s*UPDATE bloque_fecha/i.test(sql)) return [{ affectedRows: 0 }];
    if (/FROM bloque_fecha_recurso bfr[\s\S]+bf\.estado = 'ACTIVO'/i.test(sql)) return [[]];
    if (/SELECT id FROM recurso WHERE id = \? AND servicio_id = \? FOR UPDATE/i.test(sql)) {
      return [[{ id: 2 }]];
    }
    if (/FROM turismo_reserva_hold/i.test(sql)) return [[]];
    if (/SELECT r\.id[\s\S]+FROM reserva r[\s\S]+FOR UPDATE/i.test(sql)) return [[]];
    if (/SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{ id: 200, usuario_familiar_id: null, departamental_id: 7 }]];
    }
    if (/SELECT id, documento, nombre, apellido, fecha_nacimiento, tipo_persona_id,[\s\S]+FROM usuario WHERE id = \?/i.test(sql)) {
      return [[{
        id: 200,
        documento: "12345678",
        nombre: "Ana",
        apellido: "Afiliada",
        fecha_nacimiento: "1985-06-15",
        tipo_persona_id: 1,
        parentesco_id: null,
        telefono: null,
        email: null,
      }]];
    }
    if (/FROM turismo_tarifa_regla tr[\s\S]+LEFT JOIN tarifa t/i.test(sql)) return [[]];
    if (/FROM tarifa[\s\S]+WHERE recurso_id = \?/i.test(sql)) {
      return [[{
        id: 31,
        precio: 1000,
        fecha_inicio: "2090-01-01",
        fecha_fin: "2099-12-31",
        usa_porcentaje: 0,
        porcentaje_descuento: 0,
      }]];
    }
    if (/INSERT INTO reserva \(/i.test(sql)) return [{ insertId: 501 }];
    if (/INSERT INTO historial_reserva/i.test(sql)) {
      insercionesHistorial += 1;
      if (insercionesHistorial === 2) throw new Error("historial no disponible");
      return [{ insertId: 601 }];
    }
    if (/SELECT id FROM estado_reserva WHERE nombre = \?/i.test(sql)) return [[{ id: 2 }]];
    if (/UPDATE reserva SET estado_reserva_id = \?/i.test(sql)) return [{ affectedRows: 1 }];
    throw new Error(`Consulta inesperada: ${sql}`);
  });

  const response = await request("/api/reserva", {
    method: "POST",
    token: tokenFor({ id: 100, rol: "departamental", departamental_id: 7 }),
    body: bodyEdicion({
      usuario_id: 200,
      personas: [{ id: 200, dni: "12345678" }],
    }),
  });

  assert.equal(response.status, 500);
  assert.equal(response.body, "Error al procesar la reserva");
  assert.equal(insercionesHistorial, 2);
  assert.equal(transactionCalls.includes("rollback"), true);
  assert.equal(transactionCalls.includes("commit"), false);
  assert.equal(
    databaseCalls.some(({ sql }) => /UPDATE reserva SET estado_reserva_id = \?/i.test(sql)),
    true
  );
});

function responderResumenConSaludOculta(propietarioId) {
  return async (sql) => {
    if (/r\.numero_parcela[\s\S]+FROM reserva r[\s\S]+WHERE r\.id = \?/i.test(sql)) {
      return [[{
        id: 77,
        usuario_id: propietarioId,
        es_por_salud: 1,
        modalidad: "FECHA_LIBRE",
        estado: "Iniciada",
        firma_archivo: null,
        convenio_hotel_id: null,
        fecha_creacion: "2099-01-01 10:00:00",
        fecha_inicio: "2099-01-10",
        fecha_fin: "2099-01-13",
      }]];
    }
    if (/SELECT id, departamental_id FROM usuario WHERE id IN/i.test(sql)) {
      return [[
        { id: 100, departamental_id: 7 },
        { id: propietarioId, departamental_id: 7 },
      ]];
    }
    if (/FROM reserva_familiar rf/i.test(sql)) return [[]];
    if (/FROM reserva_adicional\s+WHERE reserva_id/i.test(sql)) return [[]];
    if (/FROM reserva_observacion o/i.test(sql)) return [[]];
    if (/\b(?:FROM|JOIN)\s+reserva_salud(?:_archivo)?\b/i.test(sql)) {
      throw new Error(`No debió consultar datos médicos: ${sql}`);
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

test("el resumen oculta salud a afiliado sin Coseguro y departamental solo Turismo", async () => {
  const casos = [
    {
      nombre: "afiliado sin Coseguro",
      propietarioId: 100,
      claims: {
        id: 100,
        rol: "afiliado",
        modulo_turismo: 1,
        modulo_coseguro: 0,
      },
    },
    {
      nombre: "departamental solo Turismo",
      propietarioId: 200,
      claims: {
        id: 100,
        rol: "departamental",
        departamental_id: 7,
        area_turismo: 1,
        area_coseguro: 0,
      },
    },
  ];

  for (const caso of casos) {
    setDatabaseHandler(responderResumenConSaludOculta(caso.propietarioId));
    const response = await request("/api/reserva/77/resumen", {
      token: tokenFor(caso.claims),
    });

    assert.equal(response.status, 200, caso.nombre);
    assert.equal(response.body.es_por_salud, false, caso.nombre);
    assert.equal(response.body.salud, null, caso.nombre);
    assert.equal(
      databaseCalls.some(({ sql }) => /\b(?:FROM|JOIN)\s+reserva_salud(?:_archivo)?\b/i.test(sql)),
      false,
      caso.nombre
    );
  }
});

test("Mis gestiones no proyecta ni une datos de salud con Coseguro apagado", async () => {
  setDatabaseHandler(async (sql) => {
    if (/SELECT g\.tipo, COUNT\(\*\) AS total FROM \(/i.test(sql)) {
      assert.doesNotMatch(sql, /r\.es_por_salud|rs\.estado|JOIN reserva_salud/i);
      assert.match(sql, /0 AS es_por_salud/);
      assert.match(sql, /NULL AS salud_estado/);
      return [[{ tipo: "turismo", total: 1 }]];
    }
    if (/SELECT g\.\* FROM \(/i.test(sql)) {
      assert.doesNotMatch(sql, /r\.es_por_salud|rs\.estado|JOIN reserva_salud/i);
      return [[{
        id: 77,
        tipo: "turismo",
        codigo: "T-77",
        estado_id: 1,
        estado: "Iniciada",
        es_por_salud: 0,
        salud_estado: null,
        fecha_creacion: "2099-01-01 10:00:00",
      }]];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  });

  const response = await request("/api/mis-gestiones", {
    token: tokenFor({
      id: 100,
      rol: "afiliado",
      modulo_turismo: 1,
      modulo_coseguro: 0,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.results[0].es_por_salud, 0);
  assert.equal(response.body.results[0].salud_estado, null);
});

test("notificaciones excluye Traslados para departamental pero no para admin", async () => {
  async function consultarComo(claims) {
    setDatabaseHandler(async (sql) => {
      if (/SELECT\s+n\.id,[\s\S]+FROM notificacion n/i.test(sql)) {
        return [[{
          id: 1,
          tipo: "RESERVA_VERIFICADA",
          titulo: "Reserva",
          mensaje: "Actualizada",
          leida: 0,
          payload: "{}",
        }]];
      }
      if (/SELECT COUNT\(\*\) AS total FROM notificacion n/i.test(sql)) {
        return [[{ total: 1 }]];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    });

    const response = await request("/api/notificaciones", { token: tokenFor(claims) });
    assert.equal(response.status, 200);
    return databaseCalls.filter(({ sql }) => /FROM notificacion n/i.test(sql));
  }

  const consultasDepartamental = await consultarComo({
    rol: "departamental",
    departamental_id: 7,
    area_turismo: 1,
  });
  assert.equal(consultasDepartamental.length, 3);
  for (const consulta of consultasDepartamental) {
    assert.match(consulta.sql, /NOT \(n\.tipo LIKE \?\)/i);
    assert.ok(consulta.params.includes("TRASLADO%"));
  }

  const consultasAdmin = await consultarComo({ rol: "admin" });
  assert.equal(consultasAdmin.length, 3);
  for (const consulta of consultasAdmin) {
    assert.doesNotMatch(consulta.sql, /NOT \(n\.tipo LIKE \?\)/i);
    assert.equal(consulta.params.includes("TRASLADO%"), false);
  }
});

test("departamental solo Turismo busca titulares habilitados de su jurisdiccion", async () => {
  setDatabaseHandler(async (sql, params) => {
    if (/FROM usuario u[\s\S]+u\.modulo_turismo = 1/i.test(sql)) {
      assert.match(sql, /r\.nombre = 'afiliado'/i);
      assert.match(sql, /u\.habilitado = 'Y'/i);
      assert.match(sql, /u\.usuario_familiar_id IS NULL/i);
      assert.match(sql, /u\.departamental_id = \?/i);
      assert.equal(params[0], 7);
      return [[{
        id: 200,
        nombre: "Ana",
        apellido: "Afiliada",
        documento: 12345678,
        departamental_id: 7,
        departamental_nombre: "Departamental 7",
        modulo_coseguro: "0",
      }]];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  });

  const response = await request("/api/turismo/afiliados-buscar?q=Ana", {
    token: tokenFor({
      id: 100,
      rol: "departamental",
      departamental_id: 7,
      area_turismo: 1,
      area_coseguro: 0,
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [{
    id: 200,
    nombre: "Ana",
    apellido: "Afiliada",
    documento: 12345678,
    departamental_id: 7,
    departamental_nombre: "Departamental 7",
    modulo_coseguro: 0,
  }]);
});
