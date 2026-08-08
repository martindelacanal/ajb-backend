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

test("POST /familiares hereda la departamental al promover un acompanante", async () => {
  conexionActual = crearConexion(({ sql }) => {
    if (sql.startsWith("SELECT id, departamental_id FROM usuario WHERE id")) {
      return [[{ id: 10, departamental_id: 7 }]];
    }
    if (sql.includes("FROM usuario WHERE documento")) {
      return [[{
        id: 22,
        usuario_familiar_id: 10,
        es_familiar: "N",
        parentesco_id: 4,
        departamental_id: null,
        password: null,
        email: null,
      }]];
    }
    return [{ affectedRows: 1, insertId: 1 }];
  });

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

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.promovido, true);
  assert.equal(conexionActual.estado.commits, 1);
  assert.equal(conexionActual.estado.rollbacks, 0);
  const actualizacion = conexionActual.estado.consultas.find(({ sql }) =>
    sql.startsWith("UPDATE usuario SET es_familiar = 'S'")
  );
  assert.ok(actualizacion);
  assert.match(actualizacion.sql, /departamental_id = \?/);
  assert.deepEqual(actualizacion.params, [3, 7, 22]);
  assert.ok(conexionActual.estado.consultas.some(({ sql, params }) =>
    sql.startsWith("INSERT INTO historial_usuario") && params[2] === "departamental_id" && params[4] === 7
  ));
});

test("PUT /familiares/:id/vinculo transfiere grupo y departamental juntos", async () => {
  conexionActual = crearConexion(({ sql }) => {
    if (sql.startsWith("SELECT id, departamental_id FROM usuario WHERE id")) {
      return [[{ id: 10, departamental_id: 9 }]];
    }
    if (sql.startsWith("SELECT id, usuario_familiar_id")) {
      return [[{
        id: 33,
        usuario_familiar_id: null,
        es_familiar: "N",
        parentesco_id: 4,
        departamental_id: 2,
        password: null,
        email: null,
      }]];
    }
    if (sql.startsWith("SELECT COUNT(*) AS c")) {
      return [[{ c: 1 }]];
    }
    return [{ affectedRows: 1, insertId: 1 }];
  });

  const req = crearRequest({
    params: { id: "33" },
    body: { es_familiar: "S", parentesco_id: 3 },
  });
  const res = crearRespuesta();

  await obtenerHandler("/familiares/:id/vinculo", "put")(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(conexionActual.estado.commits, 1);
  const actualizacion = conexionActual.estado.consultas.find(({ sql }) =>
    sql.startsWith("UPDATE usuario SET es_familiar = ?")
  );
  assert.ok(actualizacion);
  assert.match(actualizacion.sql, /departamental_id = CASE WHEN \? = 'S' THEN \?/);
  assert.deepEqual(actualizacion.params, ["S", 10, 3, "S", 9, 33]);
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
