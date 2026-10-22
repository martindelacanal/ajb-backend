"use strict";

// Búsqueda por código en las bandejas que muestran «T-», «TR-», «B-» y los códigos
// de Mis gestiones: con prefijo (con o sin guion) es el id exacto; el número solo
// y el texto libre siguen buscando en forma amplia.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "busqueda-codigos-rutas-test-secret";

const llamadas = [];
let sesionActual;

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

// Todas las bandejas responden vacías: interesa la consulta que arman
async function consultar(sql, params = []) {
  if (esConsultaAutorizacion(sql)) return [[{ ...sesionActual }]];
  llamadas.push({ sql, params });
  if (/COUNT\(\*\) AS total/.test(sql) && !/GROUP BY/.test(sql)) return [[{ total: 0, importe_total: 0 }]];
  if (/COUNT\(\*\) AS count/.test(sql)) return [[{ count: 0 }]]; // total de la tabla de Reservas
  return [[]];
}

const db = {
  query: consultar,
  execute: consultar,
  async getConnection() {
    return { query: consultar, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => db } };

const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/descuentos"));
app.use("/api", require("../api/routes/beneficios"));
app.use("/api", require("../api/routes/user"));
app.use("/api", require("../api/routes/traslados"));

const consoleLogOriginal = console.log;
test.before(() => {
  console.log = () => {};
});
test.after(() => {
  console.log = consoleLogOriginal;
});

function sesion(overrides) {
  return {
    id: 100, rol_id: 1, rol: "admin", departamental_id: null, habilitado: "Y",
    area_turismo: 1, area_coseguro: 1, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1,
    ...overrides,
  };
}

async function buscar(ruta, texto, claims = {}, { method = "GET" } = {}) {
  llamadas.length = 0;
  sesionActual = sesion(claims);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify({ id: sesionActual.id, rol: sesionActual.rol }) }, process.env.JWT_SECRET);
    const separador = ruta.includes("?") ? "&" : "?";
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${ruta}${separador}search=${encodeURIComponent(texto)}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    const body = await response.json();
    assert.equal(response.status, 200, `${ruta} «${texto}»: ${JSON.stringify(body)}`);
    return [...llamadas];
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function consulta(consultas, patron) {
  const encontrada = consultas.find(({ sql }) => patron.test(sql));
  assert.ok(encontrada, `No se encontró la consulta ${patron}`);
  return encontrada;
}

function likes(params) {
  return params.filter((p) => typeof p === "string" && p.startsWith("%"));
}

// ---------------------------------------------------------------------------
// Descuentos › Usos e Historial (la tabla muestra «Reserva T-120»)
// ---------------------------------------------------------------------------
test("Descuentos › Usos encuentra la reserva por su código T-, con o sin guion", async () => {
  for (const texto of ["T-120", "t120", "T 120", "#120"]) {
    const consultas = (await buscar("/descuentos/admin/usos", texto)).filter(({ sql }) => /FROM reserva_descuento rd/.test(sql));
    assert.equal(consultas.length, 2, texto); // la página y el total
    for (const { sql, params } of consultas) {
      assert.match(sql, /\(rd\.reserva_id = \? OR rd\.codigo = \?\)/, texto);
      assert.doesNotMatch(sql, /LIKE/, texto);
      assert.deepEqual(params.slice(0, 2), [120, texto.trim().replace(/^#+/, "")], texto);
    }
  }
});

test("Descuentos › Usos sigue buscando amplio con el número solo o un nombre", async () => {
  for (const texto of ["120", "Pérez"]) {
    const consultas = await buscar("/descuentos/admin/usos", texto);
    const { sql, params } = consulta(consultas, /SELECT rd\.id, rd\.reserva_id/);
    assert.doesNotMatch(sql, /rd\.reserva_id = \?/, texto);
    assert.equal(likes(params).length, 9, texto);
  }
});

test("Descuentos › Usos encuentra el cupón escrito como se ve, con su «#»", async () => {
  const consultas = await buscar("/descuentos/admin/usos", "#JUBILADO");
  const { sql, params } = consulta(consultas, /SELECT rd\.id, rd\.reserva_id/);
  assert.match(sql, /CAST\(rd\.reserva_id AS CHAR\) LIKE \? OR rd\.codigo LIKE \?/);
  assert.equal(params[1], "%JUBILADO%");
  assert.equal(likes(params).filter((p) => p === "%#JUBILADO%").length, 8);
});

test("Descuentos › Historial encuentra los movimientos de la reserva por su código T-", async () => {
  for (const texto of ["T-120", "T120", "#120"]) {
    const consultas = await buscar("/descuentos/admin/historial", texto);
    assert.equal(consultas.length, 2, texto); // la página y el total
    for (const { sql, params } of consultas) {
      assert.match(sql, /\(h\.reserva_id = \? OR r\.codigo = \?\)/, texto);
      assert.doesNotMatch(sql, /LIKE/, texto);
      assert.equal(params[0], 120, texto);
    }
  }
  const amplia = await buscar("/descuentos/admin/historial", "Verano");
  const { sql, params } = consulta(amplia, /FROM descuento_historial h/);
  assert.doesNotMatch(sql, /h\.reserva_id = \?/);
  assert.equal(likes(params).length, 5);
});

// ---------------------------------------------------------------------------
// Reservas («T-41») y Traslados («TR-12») del staff
// ---------------------------------------------------------------------------
test("Reservas trae sólo la reserva del código T-, con o sin guion, o «#n»", async () => {
  for (const texto of ["T-41", "t41", "T 41", "#41"]) {
    const consultas = (await buscar("/tabla/reservas", texto, {}, { method: "POST" })).filter(({ sql }) => /FROM reserva r/.test(sql));
    assert.equal(consultas.length, 2, texto); // la página y el total
    for (const { sql, params } of consultas) {
      assert.match(sql, /AND r\.id = \?/, texto);
      assert.doesNotMatch(sql, /LIKE/, texto);
      assert.equal(params[0], 41, texto);
    }
  }
});

test("Reservas sigue buscando amplio con el número solo o un nombre", async () => {
  for (const texto of ["41", "Pérez"]) {
    const consultas = (await buscar("/tabla/reservas", texto, {}, { method: "POST" })).filter(({ sql }) => /FROM reserva r/.test(sql));
    assert.equal(consultas.length, 2, texto);
    for (const { sql, params } of consultas) {
      assert.doesNotMatch(sql, /r\.id = \?/, texto);
      assert.equal(likes(params).length, 19, texto);
    }
  }
});

test("Reservas: con el código, la departamental sigue viendo sólo las suyas", async () => {
  const consultas = (await buscar("/tabla/reservas", "T-41", { rol_id: 2, rol: "departamental", departamental_id: 7 }, { method: "POST" }))
    .filter(({ sql }) => /FROM reserva r/.test(sql));
  assert.equal(consultas.length, 2);
  for (const { sql, params } of consultas) {
    assert.match(sql, /AND r\.id = \?[\s\S]+u\.departamental_id = \?/);
    assert.equal(params[0], 41);
    assert.equal(params.at(-1), 7);
  }
});

test("Traslados trae sólo la solicitud del código TR-, con o sin guion, o «#n»", async () => {
  for (const texto of ["TR-12", "tr12", "TR 12", "#12"]) {
    const consultas = await buscar("/traslados/solicitudes", texto);
    for (const patron of [/SELECT COUNT\(\*\) AS total\s+FROM traslado_solicitud s/, /SELECT s\.id, s\.usuario_id/]) {
      const { sql, params } = consulta(consultas, patron);
      assert.match(sql, /s\.id = \?/, texto);
      assert.doesNotMatch(sql, /LIKE/, texto);
      assert.equal(params[0], 12, texto);
    }
  }
});

test("Traslados sigue buscando amplio con el número solo o un nombre", async () => {
  for (const texto of ["12", "Staffa"]) {
    const consultas = await buscar("/traslados/solicitudes", texto);
    const { sql, params } = consulta(consultas, /SELECT COUNT\(\*\) AS total\s+FROM traslado_solicitud s/);
    assert.doesNotMatch(sql, /s\.id = \?/, texto);
    assert.match(sql, /CONCAT\('TR-', s\.id\) LIKE \?/, texto);
    assert.equal(likes(params).length, 12, texto);
  }
});

// ---------------------------------------------------------------------------
// Beneficios › Inscripciones y Catálogo («B-12»)
// ---------------------------------------------------------------------------
test("Beneficios › Inscripciones acepta el código B con o sin guion y busca el id exacto", async () => {
  for (const texto of ["B-12", "b12", "B 12", "#12"]) {
    const consultas = await buscar("/beneficios/inscripciones", texto);
    const { sql, params } = consulta(consultas, /SELECT COUNT\(\*\) AS total FROM beneficio_inscripcion bi/);
    assert.match(sql, /\(bi\.id = \? OR b\.id = \?\)/, texto);
    assert.doesNotMatch(sql, /LIKE/, texto);
    assert.deepEqual(params, [12, 12], texto);
  }
  const amplia = await buscar("/beneficios/inscripciones", "Mirador");
  const { sql, params } = consulta(amplia, /SELECT COUNT\(\*\) AS total FROM beneficio_inscripcion bi/);
  assert.match(sql, /CONCAT\('B-', bi\.id\) LIKE \?/);
  assert.equal(likes(params).length, 8);
});

test("Beneficios › Catálogo acepta el código B con o sin guion y busca el id exacto", async () => {
  for (const texto of ["B-12", "B12", "b 12"]) {
    const consultas = await buscar("/beneficios", texto);
    const { sql, params } = consulta(consultas, /SELECT COUNT\(\*\) AS total FROM beneficio b/);
    assert.match(sql, /b\.id = \?/, texto);
    assert.doesNotMatch(sql, /LIKE/, texto);
    assert.deepEqual(params, [12], texto);
  }
  const amplia = await buscar("/beneficios", "12");
  const { sql, params } = consulta(amplia, /SELECT COUNT\(\*\) AS total FROM beneficio b/);
  assert.match(sql, /CONCAT\('B-', b\.id\) LIKE \?/);
  assert.equal(likes(params).length, 7);
});

// ---------------------------------------------------------------------------
// Mis gestiones (afiliado): T-, C-, TR-, B-, K- y «#n»
// ---------------------------------------------------------------------------
const AFILIADO = { id: 9, rol_id: 3, rol: "afiliado", departamental_id: 7 };

test("Mis gestiones encuentra la gestión por su código con o sin guion", async () => {
  const casos = [["T-120", "T-120"], ["t120", "T-120"], ["C 22", "C-22"], ["tr12", "TR-12"], ["B-5", "B-5"], ["k7", "K-7"]];
  for (const [texto, codigo] of casos) {
    const consultas = await buscar("/mis-gestiones", texto, AFILIADO);
    const { sql, params } = consulta(consultas, /SELECT g\.tipo, COUNT\(\*\) AS total FROM \(/);
    assert.match(sql, /WHERE g\.codigo = \? GROUP BY/, texto);
    assert.doesNotMatch(sql, /LIKE/, texto);
    assert.equal(params.at(-1), codigo, texto);
  }
});

test("Mis gestiones entiende «#n» como el número en cualquier módulo", async () => {
  const consultas = await buscar("/mis-gestiones", "#7", AFILIADO);
  const { sql, params } = consulta(consultas, /SELECT g\.tipo, COUNT\(\*\) AS total FROM \(/);
  assert.match(sql, /WHERE g\.id = \? GROUP BY/);
  assert.equal(params.at(-1), 7);
});

test("Mis gestiones ya no busca por el código interno del estado del subsidio", async () => {
  const consultas = await buscar("/mis-gestiones", "Pendiente", AFILIADO);
  for (const patron of [/SELECT g\.tipo, COUNT\(\*\) AS total FROM \(/, /SELECT g\.\* FROM \(/]) {
    const { sql, params } = consulta(consultas, patron);
    assert.doesNotMatch(sql, /g\.salud_estado LIKE/);
    assert.match(sql, /g\.codigo LIKE \?/);
    assert.equal(params.filter((p) => p === "%Pendiente%").length, 14);
  }
});
