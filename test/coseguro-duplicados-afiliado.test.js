"use strict";

// El afiliado que carga un comprobante repetido sólo se entera de que hay un
// posible duplicado (y, si es suyo, de su código C-): nunca del nombre, el
// importe ni el código de la solicitud de otra persona. El staff ve todo.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "coseguro-duplicados-afiliado-test-secret";

const databaseCalls = [];
let sesionActual;
let databaseHandler = async (sql) => {
  throw new Error(`Consulta inesperada: ${sql}`);
};

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

async function consultar(sql, params = []) {
  databaseCalls.push({ sql, params });
  if (esConsultaAutorizacion(sql)) return [[{ ...sesionActual }]];
  return databaseHandler(sql, params);
}

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: { promise: () => ({ query: consultar, execute: consultar }) },
};

const coseguroRouter = require("../api/routes/coseguro");
const { duplicadosVisiblesAfiliado, mensajeDuplicadoAfiliado } = coseguroRouter.__test;
const app = express();
app.use(express.json());
app.use("/api", coseguroRouter);

const SESIONES = {
  afiliado: { id: 9, rol_id: 3, rol: "afiliado", departamental_id: 7, habilitado: "Y", area_turismo: 0, area_coseguro: 0, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1 },
  departamental: { id: 100, rol_id: 2, rol: "departamental", departamental_id: 7, habilitado: "Y", area_turismo: 1, area_coseguro: 1, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1 },
};

// Una solicitud propia (C-12) y una de otra afiliada (C-57) con el mismo comprobante
const COMPROBANTE_AJENO = { id: 57, usuario_id: 77, estado_id: 1, fecha_creacion: "2026-10-01", importe: 18500, afiliado: "Gómez, Rosa", estado: "Solicitud iniciada", estado_afiliado: "Solicitud iniciada" };
const COMPROBANTE_PROPIO = { id: 12, usuario_id: 9, estado_id: 8, fecha_creacion: "2026-09-01", importe: 9000, afiliado: "Benítez, Ana", estado: "Exportado para liquidar", estado_afiliado: "Pendiente de acreditación" };
const ARCHIVO_AJENO = { archivo_id: 300, sha256: "a".repeat(64), tipo_adjunto: "FACTURA", solicitud_id: 57, usuario_id: 77, estado: "Solicitud iniciada", estado_afiliado: "Solicitud iniciada", afiliado: "Gómez, Rosa" };

function preparar(rol, { comprobantes = [], archivos = [] } = {}) {
  databaseCalls.length = 0;
  sesionActual = { ...SESIONES[rol] };
  databaseHandler = async (sql) => {
    if (/FROM coseguro_solicitud s\s+INNER JOIN usuario u/i.test(sql)) return [comprobantes];
    if (/FROM coseguro_archivo a/i.test(sql)) return [archivos];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

function token(rol) {
  const sesion = SESIONES[rol];
  return jwt.sign({ data: JSON.stringify({ id: sesion.id, rol: sesion.rol, departamental_id: sesion.departamental_id }) }, process.env.JWT_SECRET);
}

async function request(path, { rol, body }) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const esFormulario = body instanceof FormData;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST",
      headers: esFormulario
        ? { authorization: `Bearer ${token(rol)}` }
        : { authorization: `Bearer ${token(rol)}`, "content-type": "application/json" },
      body: esFormulario ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const CONSULTA = { emisor_cuit: "20123456786", comprobante_pto_venta: "1", comprobante_numero: "123", hashes: ["a".repeat(64)] };

test("el afiliado sabe que hay un duplicado ajeno pero no de quién, de cuánto ni con qué código", async () => {
  preparar("afiliado", { comprobantes: [COMPROBANTE_AJENO], archivos: [ARCHIVO_AJENO] });

  const respuesta = await request("/api/coseguro/verificar-duplicados", { rol: "afiliado", body: CONSULTA });

  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.duplicado_comprobante, true);
  assert.equal(respuesta.body.duplicado_archivo, true);
  assert.deepEqual(respuesta.body.comprobantes, [{ id: null, estado: null, propia: false }]);
  assert.deepEqual(respuesta.body.archivos, [{ solicitud_id: null, estado: null, propia: false }]);
  for (const dato of ["Gómez", "Rosa", "18500", "57", "77"]) assert.equal(respuesta.text.includes(dato), false, dato);
});

test("si la solicitud repetida es suya, el afiliado ve su código y el estado como lo ve él", async () => {
  preparar("afiliado", { comprobantes: [COMPROBANTE_AJENO, COMPROBANTE_PROPIO] });

  const respuesta = await request("/api/coseguro/verificar-duplicados", { rol: "afiliado", body: CONSULTA });

  assert.equal(respuesta.status, 200);
  // La propia va primero (el formulario muestra la primera) y la ajena queda anónima
  assert.deepEqual(respuesta.body.comprobantes, [
    { id: 12, estado: "Pendiente de acreditación", propia: true },
    { id: null, estado: null, propia: false },
  ]);
  assert.equal(respuesta.text.includes("Gómez"), false);
});

test("el staff sigue viendo la solicitud repetida completa", async () => {
  preparar("departamental", { comprobantes: [COMPROBANTE_AJENO], archivos: [ARCHIVO_AJENO] });

  const respuesta = await request("/api/coseguro/verificar-duplicados", { rol: "departamental", body: CONSULTA });

  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.comprobantes[0].id, 57);
  assert.equal(respuesta.body.comprobantes[0].afiliado, "Gómez, Rosa");
  assert.equal(respuesta.body.archivos[0].solicitud_id, 57);
  assert.equal(respuesta.body.archivos[0].afiliado, "Gómez, Rosa");
});

function formularioConPdf() {
  const form = new FormData();
  form.append("COMPROBANTE", new Blob(["%PDF-1.4\ncomprobante de prueba"], { type: "application/pdf" }), "factura.pdf");
  return form;
}

test("al subir un archivo ajeno repetido, el afiliado no recibe el código de la otra solicitud", async () => {
  preparar("afiliado", { archivos: [ARCHIVO_AJENO] });

  const respuesta = await request("/api/coseguro/verificar-archivo", { rol: "afiliado", body: formularioConPdf() });

  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.body, { duplicado: true, coincidencia: "archivo", solicitud_id: null, estado: null, mismo_afiliado: false });
});

test("al subir un archivo repetido, el staff ve el código y el estado de la otra solicitud", async () => {
  preparar("departamental", { archivos: [ARCHIVO_AJENO] });

  const respuesta = await request("/api/coseguro/verificar-archivo", { rol: "departamental", body: formularioConPdf() });

  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.solicitud_id, 57);
  assert.equal(respuesta.body.estado, "Solicitud iniciada");
});

test("los avisos de duplicado al guardar no nombran a otra persona ni su código", () => {
  const afiliado = { id: 9, rol: "afiliado" };

  const ajeno = mensajeDuplicadoAfiliado(afiliado, [COMPROBANTE_AJENO], "comprobante");
  assert.match(ajeno, /otra solicitud de reintegro/);
  assert.doesNotMatch(ajeno, /Gómez|C-57/);

  const propio = mensajeDuplicadoAfiliado(afiliado, [COMPROBANTE_AJENO, COMPROBANTE_PROPIO], "comprobante");
  assert.match(propio, /tu solicitud C-12 \(Pendiente de acreditación\)/);

  const archivoAjeno = mensajeDuplicadoAfiliado(afiliado, [ARCHIVO_AJENO], "archivo", " (la imagen coincide)");
  assert.match(archivoAjeno, /otra solicitud de reintegro \(la imagen coincide\)/);
  assert.doesNotMatch(archivoAjeno, /Gómez|C-57/);

  assert.deepEqual(duplicadosVisiblesAfiliado(afiliado, [], "id"), []);
});
