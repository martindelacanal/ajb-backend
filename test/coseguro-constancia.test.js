"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const express = require("express");
const jwt = require("jsonwebtoken");
const { formatearFechaConstancia, formatearNumeroComprobante, generarConstanciaReintegro } = require("../api/services/coseguro-constancia");

process.env.JWT_SECRET = "coseguro-constancia-test";

let sesion;
let solicitud;
const consultas = [];
const db = {
  async query(sql, params = []) {
    if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u/.test(sql)) return [[{ ...sesion }]];
    consultas.push({ sql, params });
    if (/FROM coseguro_solicitud s/.test(sql)) return [solicitud ? [{ ...solicitud }] : []];
    if (/FROM coseguro_solicitud_concepto/.test(sql)) return [[
      { solicitud_id: 320907, id: 1, nombre: "Medicamentos" },
      { solicitud_id: 320907, id: 2, nombre: "Prestación complementaria" },
    ]];
    throw new Error(`Consulta inesperada: ${sql}`);
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => db } };

const router = require("../api/routes/coseguro");
const app = express();
app.use("/api", router);

function preparar({ usuario = {}, tramite = {}, ausente = false } = {}) {
  consultas.length = 0;
  sesion = { id: 9, rol: "afiliado", rol_id: 2, departamental_id: 7, habilitado: "Y", area_coseguro: 1, modulo_coseguro: 1, ...usuario };
  solicitud = ausente ? null : {
    id: 320907, usuario_id: 9, departamental_id: 7, estado_id: 7,
    tipo_reintegro: "Medicamentos con cobertura del IOMA", concepto: "Medicamentos",
    fecha_aprobacion_central_civil: "2026-09-25", fecha_comprobante_civil: "2026-09-16",
    importe_autorizado: "13053.00", importe: "998999.90",
    comprobante_pto_venta: "13", comprobante_numero: "83027", emisor_nombre: "Farmacia de prueba", emisor_cuit: "20172084568",
    afiliado_nombre: "ANA MARIA", afiliado_apellido: "PEREZ", afiliado_documento: "30111222", afiliado_legajo: "2030111222",
    afiliado_email: "afiliada@example.com", afiliado_telefono: "2281-111111", afiliado_direccion: "Calle 10 N°123",
    afiliado_dependencia_judicial: "Juzgado Civil 1", departamental_nombre: "AZUL",
    ...tramite,
  };
}

async function request(id = "320907", { authorization } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify({ id: 9, rol: "afiliado" }) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/coseguro/solicitudes/${id}/constancia`, {
      headers: { authorization: authorization ?? `Bearer ${token}` },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, buffer, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(buffer.toString()) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// PDFKit usa WinAnsi y operadores TJ en streams comprimidos. Leer los streams
// reales comprueba que el documento contiene los datos impresos, además del
// encabezado PDF, sin agregar un parser como dependencia de producción.
function extraerTextoPdf(buffer) {
  const fuente = buffer.toString("latin1");
  const partes = [];
  for (const [, diccionario, contenido] of fuente.matchAll(/(<<[\s\S]*?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (!/\/Length/.test(diccionario)) continue;
    let stream = Buffer.from(contenido, "latin1");
    if (/\/FlateDecode/.test(diccionario)) stream = zlib.inflateSync(stream);
    const comandos = stream.toString("latin1");
    if (!/\bBT\b/.test(comandos)) continue;
    partes.push([...comandos.matchAll(/<([a-f\d]+)>/gi)].map(([, hex]) => Buffer.from(hex, "hex").toString("latin1")).join(""));
  }
  return partes.join(" ");
}

test("constancia genera PDF A4 con titular, todos los conceptos y monto autorizado", async () => {
  preparar();
  const result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "application/pdf");
  assert.equal(result.headers.get("content-disposition"), 'inline; filename="constancia_reintegro_320907.pdf"');
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(result.buffer.subarray(0, 5).toString(), "%PDF-");
  assert.match(result.buffer.toString("latin1"), /\/MediaBox \[0 0 595\.28 841\.89\]/);
  const contenido = extraerTextoPdf(result.buffer);
  for (const dato of [
    "ASOCIACION JUDICIAL BONAERENSE", "CONSTANCIA DE REINTEGRO", "Medicamentos con cobertura del IOMA",
    "Medicamentos, Prestación complementaria", "25/09/2026", "13.053,00", "16/09/2026", "0013-00083027",
    "Farmacia de prueba", "20172084568", "DATOS DEL AFILIADO", "PEREZ ANA MARIA", "30111222", "2030111222",
    "afiliada@example.com", "2281-111111", "Calle 10 N°123 / Juzgado Civil 1", "AZUL",
  ]) assert.ok(contenido.includes(dato), dato);
  assert.ok(!contenido.includes("998.999,90"), "no se imprime el importe de factura como reintegro");
  assert.match(consultas[0].sql, /WHERE s\.id = \? AND s\.eliminado = 0/);
  assert.match(consultas[0].sql, /DATE_FORMAT\(s\.fecha_aprobacion_central, '%Y-%m-%d'\)/);
  assert.deepEqual(consultas[0].params, [320907]);
});

test("constancia disponible en aprobación, exportado, pendiente y liquidado", async () => {
  for (const estado_id of [7, 8, 9, 10]) {
    preparar({ tramite: { estado_id } });
    assert.equal((await request()).status, 200, `estado ${estado_id}`);
  }
  for (const estado_id of [1, 2, 3, 4, 5, 6, 11, 12]) {
    preparar({ tramite: { estado_id, fecha_aprobacion_central: "2026-09-25" } });
    assert.equal((await request()).status, 409, `estado ${estado_id}`);
    assert.equal(consultas.length, 1, "rechaza antes de completar conceptos o generar PDF");
  }
});

test("constancia respeta propietario, departamental, roles y autorización actual", async () => {
  for (const usuario of [
    { rol: "departamental", departamental_id: 7 }, { rol: "admin-central" }, { rol: "admin" }, { rol: "auditor" },
  ]) {
    preparar({ usuario });
    assert.equal((await request()).status, 200, usuario.rol);
  }
  for (const opciones of [
    { tramite: { usuario_id: 10 } },
    { usuario: { rol: "departamental", departamental_id: 8 } },
    { usuario: { rol: "operador" } },
    { usuario: { rol: "afiliado", modulo_coseguro: 0 } },
    { usuario: { rol: "admin-central", area_coseguro: 0 } },
    { usuario: { rol: "departamental", area_coseguro: 0 } },
  ]) {
    preparar(opciones);
    assert.equal((await request()).status, 401, JSON.stringify(opciones));
    assert.ok(consultas.length <= 1);
  }
  preparar();
  assert.equal((await request("320907", { authorization: "Bearer invalid" })).status, 401);
  assert.equal(consultas.length, 0);
});

test("constancia rechaza ID inválido y solicitud ausente o eliminada", async () => {
  for (const id of ["1e3", "0", "-1", "2.5", "9007199254740992"]) {
    preparar();
    assert.equal((await request(id)).status, 400, id);
    assert.equal(consultas.length, 0);
  }
  preparar({ ausente: true });
  assert.equal((await request()).status, 404);
  assert.equal(consultas.length, 1);
});

test("PDF conserva el autorizado cero y explicita montos históricos faltantes", async () => {
  for (const [importe_autorizado, esperado] of [[0, "0,00"], [null, "No informado"], [undefined, "No informado"], ["", "No informado"]]) {
    preparar({ tramite: { importe_autorizado } });
    const result = await request();
    assert.equal(result.status, 200);
    const contenido = extraerTextoPdf(result.buffer);
    assert.ok(contenido.includes(`Importe: ${esperado}`));
    assert.ok(!contenido.includes("998.999,90"));
  }
});

test("fechas civiles y números de comprobante no sufren desplazamiento ni truncado", () => {
  assert.equal(formatearFechaConstancia("2026-09-25"), "25/09/2026");
  assert.equal(formatearFechaConstancia("2026-09-25T00:00:00.000Z"), "25/09/2026");
  assert.equal(formatearFechaConstancia("2027-02-29"), "No informado");
  assert.equal(formatearNumeroComprobante("13", "83027"), "0013-00083027");
  assert.equal(formatearNumeroComprobante("12345", "123456789"), "12345-123456789");
  assert.equal(formatearNumeroComprobante(null, "AB-123"), "AB-123");
});

test("PDF envuelve valores largos y continúa sin perder los campos del afiliado", async () => {
  preparar();
  const pdf = await generarConstanciaReintegro({ ...solicitud,
    conceptos: [{ nombre: "Concepto médico muy extenso ".repeat(220) }],
    afiliado_direccion: "Dirección extensa ".repeat(200),
  });
  const contenido = extraerTextoPdf(pdf);
  assert.ok(contenido.includes("Concepto médico muy extenso"));
  assert.ok(contenido.includes("DATOS DEL AFILIADO"));
  assert.ok(contenido.includes("Departamental: AZUL"));
  assert.ok((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length > 1);
});

test("aprobación notifica la impresión y conserva observación y avisos posteriores", async () => {
  const notificaciones = [];
  const estados = { 4: "Aprobado por departamental", 7: "Aprobado por servicios sociales", 8: "Pendiente de acreditación", 9: "Pendiente de acreditación", 10: "Liquidado" };
  const connection = {
    async query(sql, params) {
      if (/FROM coseguro_estado/.test(sql)) return [[{ nombre: estados[params[0]] }]];
      if (/INSERT INTO notificacion/.test(sql)) { notificaciones.push(params); return [{ affectedRows: 1 }]; }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  await router.__test.notificarCambioEstadoAfiliado(connection, { id: 32, usuario_id: 9 }, 4, 7, "Aprobación completa");
  assert.equal(notificaciones.length, 1);
  assert.match(notificaciones[0][3], /Ya podés imprimir la constancia de reintegro.*presentarla ante la Corte/);
  assert.match(notificaciones[0][3], /Observación: Aprobación completa/);
  assert.equal(JSON.parse(notificaciones[0][4]).estado_id, 7);
  await router.__test.notificarCambioEstadoAfiliado(connection, { id: 32, usuario_id: 9 }, 7, 8, null);
  assert.doesNotMatch(notificaciones[1][3], /imprimir/);
  await router.__test.notificarCambioEstadoAfiliado(connection, { id: 32, usuario_id: 9 }, 8, 9, null);
  assert.equal(notificaciones.length, 2, "el alias de estado 8 a 9 sigue sin duplicar avisos");
});
