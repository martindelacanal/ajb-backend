const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.BUCKET_REGION ||= "us-east-1";
process.env.ACCESS_KEY ||= "test-access-key";
process.env.SECRET_ACCESS_KEY ||= "test-secret-key";

let conexionActual;
const rutaConexion = require.resolve("../api/connection/connection");
require.cache[rutaConexion] = {
  id: rutaConexion,
  filename: rutaConexion,
  loaded: true,
  exports: {
    promise() {
      return {
        async getConnection() {
          return conexionActual;
        },
      };
    },
  },
};

const router = require("../api/routes/user");

function obtenerHandler(ruta, metodo) {
  const layer = router.stack.find((item) => item.route?.path === ruta && item.route.methods?.[metodo]);
  assert.ok(layer, `No se encontro ${metodo.toUpperCase()} ${ruta}`);
  return layer.route.stack.at(-1).handle;
}

function crearRespuesta() {
  return {
    statusCode: 200,
    payload: undefined,
    status(codigo) {
      this.statusCode = codigo;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function crearRequest({ body, params = {} }) {
  return {
    body,
    params,
    data: { data: JSON.stringify({ rol: "afiliado", id: 10 }) },
    ip: "127.0.0.1",
    connection: { remoteAddress: "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
    get() {
      return null;
    },
  };
}

function crearConexion(resolverQuery) {
  const estado = {
    consultas: [],
    commits: 0,
    rollbacks: 0,
    releases: 0,
  };
  return {
    estado,
    async beginTransaction() {},
    async query(sql, params = []) {
      const consulta = { sql: String(sql).replace(/\s+/g, " ").trim(), params };
      estado.consultas.push(consulta);
      return resolverQuery(consulta, estado);
    },
    async commit() {
      estado.commits += 1;
    },
    async rollback() {
      estado.rollbacks += 1;
    },
    release() {
      estado.releases += 1;
    },
  };
}

// Todo cambio del afiliado sobre el vínculo de una persona de su grupo queda
// como pedido PENDIENTE (services/familiares-cambios.js); la aplicación con
// usuario_familiar_id + departamental del titular se prueba en
// test/familiares-cambios-vinculo.test.js (aprobación).
function personaCompleta(extra = {}) {
  return {
    id: 22,
    rol_id: 4,
    rol_nombre: "invitado",
    nombre: "Ana",
    apellido: "Perez",
    documento: 40111222,
    fecha_nacimiento: "2010-05-20",
    telefono: null,
    tipo_persona_id: 2,
    parentesco_id: 4,
    es_familiar: "N",
    usuario_familiar_id: 10,
    departamental_id: null,
    password: null,
    email: null,
    habilitado: "Y",
    ...extra,
  };
}

// Respuestas del flujo de pedidos (universo, ficha, departamental, catálogo,
// alta de la solicitud y aviso a la departamental).
function resolverPedido(persona, { titularDepartamental = 7, insertId = 41 } = {}) {
  return ({ sql, params }) => {
    if (sql.startsWith("SELECT id, departamental_id FROM usuario WHERE id")) {
      return [[{ id: 10, departamental_id: titularDepartamental }]];
    }
    if (sql.startsWith("SELECT id, usuario_familiar_id, es_familiar, parentesco_id, departamental_id, password, email FROM usuario WHERE documento")) {
      return [[persona]];
    }
    if (sql.startsWith("SELECT u.id FROM usuario u WHERE u.id = ? AND u.id <> ?")) return [[{ id: persona.id }]];
    if (sql.startsWith("SELECT u.*, r.nombre AS rol_nombre FROM usuario u")) return [[persona]];
    if (sql.startsWith("SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?")) {
      return [[{ id: params[0], usuario_familiar_id: null, departamental_id: titularDepartamental }]];
    }
    if (sql === "SELECT id FROM familiar_cambio_solicitud WHERE pendiente_persona = ?") return [[]];
    if (sql.startsWith("SELECT id FROM parentesco WHERE id = ?")) return [[{ id: params[0] }]];
    if (sql.startsWith("INSERT INTO familiar_cambio_solicitud")) return [{ affectedRows: 1, insertId }];
    if (sql.startsWith("SELECT id, nombre FROM tipo_persona")) return [[{ id: 2, nombre: "Invitados familiares" }]];
    if (sql.startsWith("SELECT id, nombre FROM parentesco")) {
      return [[{ id: 2, nombre: "Pareja" }, { id: 3, nombre: "Hijo" }, { id: 4, nombre: "Familiar" }]];
    }
    if (sql.startsWith("SELECT u.id, u.nombre, u.apellido, u.rol_id")) {
      return [[{ id: 10, nombre: "Martina", apellido: "Rodriguez", rol_id: 2, departamental_id: titularDepartamental }]];
    }
    if (sql.startsWith("SELECT u.id FROM usuario u INNER JOIN rol r")) return [[{ id: 3 }]];
    if (sql.startsWith("INSERT INTO notificacion")) return [{ affectedRows: 1, insertId: 1 }];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

function solicitudInsertada() {
  const insercion = conexionActual.estado.consultas.find(({ sql }) => sql.startsWith("INSERT INTO familiar_cambio_solicitud"));
  assert.ok(insercion, "no se creó el pedido");
  return {
    params: insercion.params,
    anteriores: JSON.parse(insercion.params[3]),
    propuestos: JSON.parse(insercion.params[4]),
  };
}

test("POST /familiares con el DNI de un acompañante del grupo pide sumarlo (202) sin tocar su ficha", async () => {
  conexionActual = crearConexion(resolverPedido(personaCompleta()));

  const req = crearRequest({
    body: {
      nombre: "Ana",
      apellido: "Perez",
      parentesco_id: 3,
      fecha_nacimiento: "2010-05-20",
      documento: "40111222",
      telefono: "",
    },
  });
  const res = crearRespuesta();

  await obtenerHandler("/familiares", "post")(req, res);

  assert.equal(res.statusCode, 202, JSON.stringify(res.payload));
  assert.equal(res.payload.pendiente, true);
  assert.equal(res.payload.solicitud_id, 41);
  assert.equal(res.payload.id, 22);
  assert.equal(res.payload.cambio_vinculo.descripcion, "Pasa a integrar el grupo familiar como Hijo");
  assert.equal(conexionActual.estado.commits, 1);
  assert.equal(conexionActual.estado.rollbacks, 0);
  // Nada se escribe en la ficha ni en su historial hasta que se apruebe.
  assert.ok(!conexionActual.estado.consultas.some(({ sql }) => sql.startsWith("UPDATE usuario")));
  assert.ok(!conexionActual.estado.consultas.some(({ sql }) => sql.startsWith("INSERT INTO historial_usuario")));
  const { params, anteriores, propuestos } = solicitudInsertada();
  // persona, solicitante y departamental del titular
  assert.deepEqual(params.slice(0, 3), [22, 10, 7]);
  assert.deepEqual(propuestos, { parentesco_id: 3, es_familiar: "S" });
  assert.deepEqual(anteriores, { parentesco_id: 4, es_familiar: "N" });
  const aviso = conexionActual.estado.consultas.find(({ sql }) => sql.startsWith("INSERT INTO notificacion"));
  assert.equal(aviso.params[1], "FAMILIAR_CAMBIO_SOLICITADO");
  assert.equal(aviso.params[2], "Martina Rodriguez pidió sumar a Ana Perez a su grupo familiar");
});

test("PUT /familiares/:id/vinculo S de alguien sin grupo que viajó con el afiliado queda pendiente (202)", async () => {
  conexionActual = crearConexion(resolverPedido(personaCompleta({
    id: 33,
    usuario_familiar_id: null,
    departamental_id: 2,
  }), { titularDepartamental: 9 }));

  const req = crearRequest({
    params: { id: "33" },
    body: { es_familiar: "S", parentesco_id: 3 },
  });
  const res = crearRespuesta();

  await obtenerHandler("/familiares/:id/vinculo", "put")(req, res);

  assert.equal(res.statusCode, 202, JSON.stringify(res.payload));
  assert.equal(res.payload.pendiente, true);
  assert.match(res.payload.message, /Queda en revisión/);
  assert.equal(conexionActual.estado.commits, 1);
  assert.ok(!conexionActual.estado.consultas.some(({ sql }) => sql.startsWith("UPDATE usuario")));
  const { params, propuestos } = solicitudInsertada();
  assert.deepEqual(params.slice(0, 3), [33, 10, 9]);
  assert.deepEqual(propuestos, { parentesco_id: 3, es_familiar: "S" });
});

test("PUT /familiares/:id/vinculo con N queda pendiente y no toca la ficha", async () => {
  conexionActual = crearConexion(resolverPedido(personaCompleta({
    id: 33,
    usuario_familiar_id: 10,
    es_familiar: "S",
    parentesco_id: 3,
    departamental_id: 9,
  }), { titularDepartamental: 9 }));

  const req = crearRequest({ params: { id: "33" }, body: { es_familiar: "N" } });
  const res = crearRespuesta();

  await obtenerHandler("/familiares/:id/vinculo", "put")(req, res);

  assert.equal(res.statusCode, 202, JSON.stringify(res.payload));
  assert.equal(res.payload.cambio_vinculo.descripcion, "Deja el grupo familiar; queda como acompañante de viaje");
  assert.ok(!conexionActual.estado.consultas.some(({ sql }) => sql.startsWith("UPDATE usuario")));
  const { propuestos, anteriores } = solicitudInsertada();
  assert.deepEqual(propuestos, { es_familiar: "N" });
  assert.deepEqual(anteriores, { es_familiar: "S" });
});

test("PUT /familiares/:id/vinculo: nunca se suma a quien integra el grupo de otro afiliado", async () => {
  conexionActual = crearConexion(({ sql }) => {
    // Fuera del universo del afiliado 10 (usuario_familiar_id de otro).
    if (sql.startsWith("SELECT u.id FROM usuario u WHERE u.id = ? AND u.id <> ?")) return [[]];
    throw new Error(`Consulta inesperada: ${sql}`);
  });

  const req = crearRequest({ params: { id: "33" }, body: { es_familiar: "S", parentesco_id: 3 } });
  const res = crearRespuesta();

  await obtenerHandler("/familiares/:id/vinculo", "put")(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.codigo, "PERSONA_FUERA_DEL_GRUPO");
  assert.equal(conexionActual.estado.commits, 0);
  assert.equal(conexionActual.estado.rollbacks, 1);
});

test("los flujos familiares rechazan titulares sin departamental valida", async () => {
  conexionActual = crearConexion(({ sql }) => {
    if (sql.startsWith("SELECT id, departamental_id FROM usuario WHERE id")) {
      return [[{ id: 10, departamental_id: null }]];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  });

  const req = crearRequest({
    body: {
      nombre: "Ana",
      apellido: "Perez",
      parentesco_id: 3,
      fecha_nacimiento: "2010-05-20",
      documento: "40111222",
    },
  });
  const res = crearRespuesta();

  await obtenerHandler("/familiares", "post")(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(conexionActual.estado.commits, 0);
  assert.equal(conexionActual.estado.rollbacks, 1);
  assert.equal(conexionActual.estado.consultas.length, 1);
});

test("las respuestas de sorteo usan exclusivamente valores validos del ENUM", () => {
  const fuente = fs.readFileSync(path.join(__dirname, "../api/routes/user.js"), "utf8");
  assert.doesNotMatch(fuente, /sorteo_adjudicacion_respuesta[\s\S]{0,180}estado\s*=\s*'RECHAZADO'/);
  assert.match(fuente, /sorteo_adjudicacion_respuesta[\s\S]{0,180}estado\s*=\s*'RECHAZADA'/);
});
