const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "security-regression-test-secret";

const databaseCalls = [];
let databaseHandler = async (sql) => {
  if (/COUNT\(\*\)/i.test(sql)) {
    return [[{ count: 0, total: 0 }]];
  }
  return [[]];
};

const fakeConnection = {
  promise() {
    return {
      execute: async (sql, params = []) => {
        databaseCalls.push({ method: "execute", sql, params });
        return databaseHandler(sql, params);
      },
      query: async (sql, params = []) => {
        databaseCalls.push({ method: "query", sql, params });
        return databaseHandler(sql, params);
      },
    };
  },
};

const connectionPath = require.resolve("../../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: fakeConnection,
};

const userRouter = require("../../api/routes/user");
const app = express();
app.use(express.json());
app.use("/api", userRouter);

function setDatabaseHandler(handler) {
  databaseCalls.length = 0;
  databaseHandler = handler;
}

function tokenFor(overrides = {}) {
  const claims = {
    id: 100,
    rol: "admin",
    departamental_id: null,
    area_turismo: 1,
    ...overrides,
  };
  return jwt.sign({ data: JSON.stringify(claims) }, process.env.JWT_SECRET);
}

async function request(path, { method = "GET", token, body } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
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

function tableResponder(sql) {
  if (/COUNT\(\*\)\s+AS count/i.test(sql)) {
    return [[{ count: 1 }]];
  }
  return [[{ id: 501, afiliado: 30111222, observaciones: "dato reservado" }]];
}

function userHistoryResponder(targetDepartamentalId) {
  return async (sql, params) => {
    if (
      /SELECT\s+id[\s\S]+FROM usuario/i.test(sql) &&
      /AND departamental_id = \?/i.test(sql)
    ) {
      return Number(params[1]) === Number(targetDepartamentalId)
        ? [[{ id: params[0] }]]
        : [[]];
    }
    if (/COUNT\(\*\)\s+as total/i.test(sql)) {
      return [[{ total: 1 }]];
    }
    return [[{ id: 601, usuario_id: 222, observaciones: "historial ajeno" }]];
  };
}

function reservationHistoryResponder(targetDepartamentalId) {
  return async (sql, params) => {
    if (
      /SELECT\s+r\.id/i.test(sql) &&
      /FROM reserva r/i.test(sql) &&
      /AND u\.departamental_id = \?/i.test(sql)
    ) {
      return Number(params[1]) === Number(targetDepartamentalId)
        ? [[{ id: params[0] }]]
        : [[]];
    }
    if (/COUNT\(\*\)\s+as total/i.test(sql)) {
      return [[{ total: 1 }]];
    }
    return [[{ id: 701, reserva_id: 333, observaciones: "historial ajeno" }]];
  };
}

test("tabla de reservas rechaza roles no autorizados antes de consultar la base", async (t) => {
  for (const rol of ["auditor", "admin-central", "afiliado", "invitado"]) {
    await t.test(rol, async () => {
      setDatabaseHandler(tableResponder);

      const response = await request("/api/tabla/reservas?page=1", {
        method: "POST",
        token: tokenFor({ rol, id: 444, area_turismo: 1 }),
        body: {},
      });

      assert.equal(response.status, 403);
      assert.equal(databaseCalls.length, 0);
    });
  }
});

test("tabla de reservas conserva el acceso global de admin", async () => {
  setDatabaseHandler(tableResponder);

  const response = await request("/api/tabla/reservas?page=1", {
    method: "POST",
    token: tokenFor({ rol: "admin" }),
    body: {},
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.results.length, 1);
  const reservationQueries = databaseCalls.filter(({ sql }) => /FROM reserva r/i.test(sql));
  assert.equal(reservationQueries.length, 2);
  for (const call of reservationQueries) {
    assert.doesNotMatch(call.sql, /u\.departamental_id = \?/);
  }
});

test("tabla de reservas limita al departamental en datos y conteo", async () => {
  setDatabaseHandler(tableResponder);

  const response = await request("/api/tabla/reservas?page=1", {
    method: "POST",
    token: tokenFor({ rol: "departamental", departamental_id: 7 }),
    body: {},
  });

  assert.equal(response.status, 200);
  const reservationQueries = databaseCalls.filter(({ sql }) => /FROM reserva r/i.test(sql));
  assert.equal(reservationQueries.length, 2);
  for (const call of reservationQueries) {
    assert.match(call.sql, /u\.departamental_id = \?/);
    assert.ok(call.params.includes(7));
  }
});

test("tabla de reservas falla cerrada ante un departamental sin alcance valido", async (t) => {
  const casos = [
    { nombre: "sin area Turismo", claims: { area_turismo: 0, departamental_id: 7 } },
    { nombre: "sin departamental", claims: { area_turismo: 1, departamental_id: null } },
  ];

  for (const caso of casos) {
    await t.test(caso.nombre, async () => {
      setDatabaseHandler(tableResponder);

      const response = await request("/api/tabla/reservas?page=1", {
        method: "POST",
        token: tokenFor({ rol: "departamental", ...caso.claims }),
        body: {},
      });

      assert.equal(response.status, 403);
      assert.equal(databaseCalls.length, 0);
    });
  }
});

test("historial de usuarios devuelve 403 ante un ID de otra departamental", async () => {
  setDatabaseHandler(userHistoryResponder(22));

  const response = await request("/api/tabla/historial-usuario/222", {
    token: tokenFor({ rol: "departamental", departamental_id: 7 }),
  });

  assert.equal(response.status, 403);
  assert.equal(
    databaseCalls.filter(({ sql }) => /FROM historial_usuario/i.test(sql)).length,
    0
  );
});

test("historial de usuarios exige ID al departamental", async () => {
  setDatabaseHandler(userHistoryResponder(7));

  const response = await request("/api/tabla/historial-usuario", {
    token: tokenFor({ rol: "departamental", departamental_id: 7 }),
  });

  assert.equal(response.status, 400);
  assert.equal(databaseCalls.length, 0);
});

test("historial de usuarios rechaza IDs, claims y roles no validos sin leer historiales", async (t) => {
  const casos = [
    {
      nombre: "ID no numerico",
      path: "/api/tabla/historial-usuario/abc",
      claims: { rol: "departamental", departamental_id: 7 },
      status: 400,
    },
    {
      nombre: "departamental sin jurisdiccion",
      path: "/api/tabla/historial-usuario/222",
      claims: { rol: "departamental", departamental_id: null },
      status: 403,
    },
    {
      nombre: "rol no autorizado",
      path: "/api/tabla/historial-usuario/222",
      claims: { rol: "admin-central", departamental_id: 7 },
      status: 403,
    },
  ];

  for (const caso of casos) {
    await t.test(caso.nombre, async () => {
      setDatabaseHandler(userHistoryResponder(7));

      const response = await request(caso.path, {
        token: tokenFor(caso.claims),
      });

      assert.equal(response.status, caso.status);
      assert.equal(databaseCalls.length, 0);
    });
  }
});

test("historial de usuarios mantiene el acceso propio y aplica alcance en ambas consultas", async () => {
  setDatabaseHandler(userHistoryResponder(7));

  const response = await request("/api/tabla/historial-usuario/222", {
    token: tokenFor({ rol: "departamental", departamental_id: 7 }),
  });

  assert.equal(response.status, 200);
  const historyQueries = databaseCalls.filter(({ sql }) => /FROM historial_usuario/i.test(sql));
  assert.equal(historyQueries.length, 2);
  for (const call of historyQueries) {
    assert.match(call.sql, /h\.usuario_id = \?/);
    assert.match(call.sql, /u\.departamental_id = \?/);
    assert.ok(call.params.includes(222));
    assert.ok(call.params.includes(7));
  }
});

test("historial global de usuarios sigue disponible para admin", async () => {
  setDatabaseHandler(userHistoryResponder(22));

  const response = await request("/api/tabla/historial-usuario", {
    token: tokenFor({ rol: "admin" }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.results.length, 1);
  const historyQueries = databaseCalls.filter(({ sql }) => /FROM historial_usuario/i.test(sql));
  assert.equal(historyQueries.length, 2);
  for (const call of historyQueries) {
    assert.doesNotMatch(call.sql, /u\.departamental_id = \?/);
  }
});

test("historial de usuarios devuelve aliases legibles y los incluye en la busqueda", async () => {
  setDatabaseHandler(userHistoryResponder(22));

  const response = await request("/api/tabla/historial-usuario?search=Madre", {
    token: tokenFor({ rol: "admin" }),
  });

  assert.equal(response.status, 200);
  const historyQueries = databaseCalls.filter(({ sql }) => /FROM historial_usuario/i.test(sql));
  assert.equal(historyQueries.length, 2);

  const dataQuery = historyQueries.find(({ sql }) => !/COUNT\(\*\)/i.test(sql));
  assert.ok(dataQuery);
  assert.match(dataQuery.sql, /as valor_anterior_legible/i);
  assert.match(dataQuery.sql, /as valor_nuevo_legible/i);
  assert.match(dataQuery.sql, /LEFT JOIN parentesco hu_parentesco_anterior/i);
  assert.match(dataQuery.sql, /LEFT JOIN tipo_persona hu_tipo_persona_nuevo/i);
  assert.match(dataQuery.sql, /LEFT JOIN rol hu_rol_anterior/i);
  assert.match(dataQuery.sql, /LEFT JOIN departamental hu_departamental_nuevo/i);

  for (const call of historyQueries) {
    assert.match(
      call.sql,
      /COALESCE\(hu_parentesco_anterior\.nombre, h\.valor_anterior\)[\s\S]+END LIKE \?/i
    );
    assert.equal(call.params.filter((param) => param === "%Madre%").length, 10);
  }
});

test("historial de reservas devuelve 403 ante un ID de otra departamental", async () => {
  setDatabaseHandler(reservationHistoryResponder(22));

  const response = await request("/api/tabla/historial-reserva/333", {
    token: tokenFor({ rol: "departamental", departamental_id: 7, area_turismo: 1 }),
  });

  assert.equal(response.status, 403);
  assert.equal(
    databaseCalls.filter(({ sql }) => /FROM historial_reserva/i.test(sql)).length,
    0
  );
});

test("historial de reservas exige ID al departamental", async () => {
  setDatabaseHandler(reservationHistoryResponder(7));

  const response = await request("/api/tabla/historial-reserva", {
    token: tokenFor({ rol: "departamental", departamental_id: 7, area_turismo: 1 }),
  });

  assert.equal(response.status, 400);
  assert.equal(databaseCalls.length, 0);
});

test("historial de reservas rechaza IDs y claims no validos sin leer historiales", async (t) => {
  const casos = [
    {
      nombre: "ID no numerico",
      path: "/api/tabla/historial-reserva/abc",
      claims: { departamental_id: 7, area_turismo: 1 },
      status: 400,
    },
    {
      nombre: "departamental sin jurisdiccion",
      path: "/api/tabla/historial-reserva/333",
      claims: { departamental_id: null, area_turismo: 1 },
      status: 403,
    },
    {
      nombre: "departamental sin area Turismo",
      path: "/api/tabla/historial-reserva/333",
      claims: { departamental_id: 7, area_turismo: 0 },
      status: 403,
    },
  ];

  for (const caso of casos) {
    await t.test(caso.nombre, async () => {
      setDatabaseHandler(reservationHistoryResponder(7));

      const response = await request(caso.path, {
        token: tokenFor({ rol: "departamental", ...caso.claims }),
      });

      assert.equal(response.status, caso.status);
      assert.equal(databaseCalls.length, 0);
    });
  }
});

test("historial de reservas mantiene el acceso propio y aplica alcance en ambas consultas", async () => {
  setDatabaseHandler(reservationHistoryResponder(7));

  const response = await request("/api/tabla/historial-reserva/333", {
    token: tokenFor({ rol: "departamental", departamental_id: 7, area_turismo: 1 }),
  });

  assert.equal(response.status, 200);
  const historyQueries = databaseCalls.filter(({ sql }) => /FROM historial_reserva/i.test(sql));
  assert.equal(historyQueries.length, 2);
  for (const call of historyQueries) {
    assert.match(call.sql, /INNER JOIN reserva r ON r\.id = h\.reserva_id/);
    assert.match(call.sql, /INNER JOIN usuario u ON u\.id = r\.usuario_id/);
    assert.match(call.sql, /h\.reserva_id = \?/);
    assert.match(call.sql, /u\.departamental_id = \?/);
    assert.ok(call.params.includes(333));
    assert.ok(call.params.includes(7));
  }
});

test("historial global de reservas sigue disponible para admin", async () => {
  setDatabaseHandler(reservationHistoryResponder(22));

  const response = await request("/api/tabla/historial-reserva", {
    token: tokenFor({ rol: "admin", area_turismo: 1 }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.results.length, 1);
  const historyQueries = databaseCalls.filter(({ sql }) => /FROM historial_reserva/i.test(sql));
  assert.equal(historyQueries.length, 2);
  for (const call of historyQueries) {
    assert.doesNotMatch(call.sql, /u\.departamental_id = \?/);
    assert.doesNotMatch(call.sql, /INNER JOIN reserva r ON r\.id = h\.reserva_id/);
  }
});

test("historial de reservas devuelve aliases legibles y los incluye en la busqueda", async () => {
  setDatabaseHandler(reservationHistoryResponder(22));

  const response = await request("/api/tabla/historial-reserva?search=Caba%C3%B1a", {
    token: tokenFor({ rol: "admin", area_turismo: 1 }),
  });

  assert.equal(response.status, 200);
  const historyQueries = databaseCalls.filter(({ sql }) => /FROM historial_reserva/i.test(sql));
  assert.equal(historyQueries.length, 2);

  const dataQuery = historyQueries.find(({ sql }) => !/COUNT\(\*\)/i.test(sql));
  assert.ok(dataQuery);
  assert.match(dataQuery.sql, /as valor_anterior_legible/i);
  assert.match(dataQuery.sql, /as valor_nuevo_legible/i);
  assert.match(dataQuery.sql, /LEFT JOIN estado_reserva hr_estado_reserva_anterior/i);
  assert.match(dataQuery.sql, /LEFT JOIN recurso hr_recurso_nuevo/i);
  assert.match(dataQuery.sql, /LEFT JOIN regimen hr_regimen_anterior/i);

  for (const call of historyQueries) {
    assert.match(
      call.sql,
      /COALESCE\(hr_recurso_nuevo\.nombre, h\.valor_nuevo\)[\s\S]+END LIKE \?/i
    );
    assert.equal(call.params.filter((param) => param === "%Cabaña%").length, 9);
  }
});
