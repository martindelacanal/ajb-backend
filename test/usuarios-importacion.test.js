"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const jwt = require("jsonwebtoken");
const express = require("express");
const { crearServicioImportacionUsuarios, leerArchivo, normalizarFilas, autorizarImportacion, MAX_FILAS } = require("../api/services/usuarios-importacion");
const { crearRouterImportacionUsuarios } = require("../api/routes/usuarios-importacion");
const { crearServicioRecuperacion } = require("../api/security/recuperacion-password");

const SECRET = "importacion-test-secret-".repeat(4);
const CABECERA = "nombre,apellido,documento,email,fecha_nacimiento";
const csv = (filas = ["Ana,Pérez,30123456,ana@example.test,1990-02-28"], cabecera = CABECERA) => ({
  originalname: "afiliados.csv", buffer: Buffer.from([cabecera, ...filas].join("\n")),
});
const actor = { id: 1, rol: "departamental", rol_id: 3, departamental_id: 3, habilitado: "Y", requiere_cambio_clave: 0 };
const catalogos = { actor, departamentales: [{ id: 3, nombre: "La Plata" }, { id: 4, nombre: "Azul" }], tipos: [{ id: 1, nombre: "Afiliado" }, { id: 2, nombre: "Familiar" }], hoy: "2026-10-11" };

function fixture({ rol = "departamental", fallarHistorial = false, fallarCola = false } = {}) {
  const consultas = [];
  const estado = { usuarios: [], cola: [], historial: [], commits: 0, rollbacks: 0, liberaciones: 0, actor: { ...actor, rol } };
  let borrador;
  const connection = {
    async beginTransaction() { borrador = { usuarios: [...estado.usuarios], cola: [...estado.cola], historial: [...estado.historial] }; },
    async commit() { Object.assign(estado, borrador); borrador = null; estado.commits++; },
    async rollback() { borrador = null; estado.rollbacks++; },
    release() { estado.liberaciones++; },
    async query(sql, params = []) {
      consultas.push({ sql, params });
      const datos = borrador || estado;
      if (/GET_LOCK/.test(sql)) return [[{ tomado: 1 }]];
      if (/SELECT.*auth_limite|FROM auth_limite/s.test(sql)) return [[{ cantidad: 0, intentos: 0 }]];
      if (/INNER JOIN rol r ON r.id = u.rol_id WHERE u.id|INNER JOIN rol r ON r.id = u.rol_id\s+WHERE u.id/s.test(sql)) return [[{ ...estado.actor }]];
      if (/SELECT id, nombre FROM departamental/.test(sql)) return [catalogos.departamentales];
      if (/SELECT id, nombre FROM tipo_persona/.test(sql)) return [catalogos.tipos];
      if (/SELECT documento, email FROM usuario/.test(sql)) return [datos.usuarios];
      if (/SELECT id, email, password, habilitado/.test(sql)) return [datos.usuarios.filter((usuario) => String(usuario.documento) === params[0]).map((usuario) => ({ ...usuario, habilitado: "Y" }))];
      if (/FROM auth_recuperacion/.test(sql)) return [[]];
      if (/SELECT id FROM rol WHERE nombre = 'afiliado'/.test(sql)) return [[{ id: 2 }]];
      if (/INSERT INTO usuario\s/.test(sql)) {
        const id = datos.usuarios.length + 10;
        datos.usuarios.push({ id, rol_id: params[0], departamental_id: params[1], documento: params[5], email: params[6], password: params[14] });
        return [{ insertId: id }];
      }
      if (/INSERT INTO historial_usuario/.test(sql)) {
        if (fallarHistorial) throw new Error("historial no disponible");
        datos.historial.push(params);
      }
      return [{ affectedRows: 1 }];
    },
  };
  const db = { query: (...args) => connection.query(...args), getConnection: async () => connection };
  const encolar = async (datos) => {
    assert.equal(datos.connection, connection);
    assert.ok(borrador, "la bienvenida se encola dentro de la transacción");
    if (fallarCola) throw new Error("cola no disponible");
    borrador.cola.push({ usuarioId: datos.usuarioId, para: datos.para });
  };
  const servicio = crearServicioImportacionUsuarios({ db, jwtSecret: SECRET, encolar });
  return { estado, consultas, db, servicio, encolar };
}

test("CSV UTF-8 admite BOM, punto y coma, encabezados con tildes y valores entrecomillados", async () => {
  const archivo = { originalname: "ALTAS.CSV", buffer: Buffer.from('\uFEFFNombre;Apellido;DNI;Correo electrónico;Fecha de nacimiento\r\nAna;"Pérez, Gómez";30.123.456;ANA@example.test;28/02/1990') };
  const filas = normalizarFilas(await leerArchivo(archivo), catalogos);
  assert.equal(filas[0].apellido, "Pérez, Gómez");
  assert.equal(filas[0].documento, "30123456");
  assert.equal(filas[0].email, "ana@example.test");
  assert.equal(filas[0].fecha_nacimiento, "1990-02-28");
  assert.equal(filas[0].departamental_id, 3);
  assert.deepEqual(filas[0].errores, []);
});

test("rechaza archivos inválidos, columnas reservadas, cabeceras repetidas y exceso de filas", async () => {
  for (const archivo of [undefined, { originalname: "altas.xls", buffer: Buffer.from("xls") }, csv([], CABECERA),
    csv(["Ana,Pérez,30123456,ana@example.test,1990-02-28,admin"], `${CABECERA},rol`),
    csv(["Ana,Pérez,30123456,ana@example.test,1990-02-28,30123456"], `${CABECERA},dni`),
    csv(Array.from({ length: MAX_FILAS + 1 }, () => "Ana,Pérez,30123456,ana@example.test,1990-02-28")),
    { originalname: "altas.csv", buffer: Buffer.alloc(2 * 1024 * 1024 + 1) },
    { originalname: "altas.csv", buffer: Buffer.from([0xff, 0xff]) },
  ]) await assert.rejects(leerArchivo(archivo), (error) => [400, 413].includes(error.statusCode));
});

test("Excel lee fechas reales y rechaza fórmulas, hojas adicionales y ZIPs dañados", async () => {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet("Afiliados");
  hoja.addRow(CABECERA.split(","));
  hoja.addRow(["Ana", "Pérez", 30123456, "ana@example.test", new Date("1990-02-28T00:00:00Z")]);
  const archivo = async () => ({ originalname: "afiliados.xlsx", buffer: Buffer.from(await libro.xlsx.writeBuffer()) });
  const filas = normalizarFilas(await leerArchivo(await archivo()), catalogos);
  assert.equal(filas[0].fecha_nacimiento, "1990-02-28");
  assert.equal(filas[0].errores.length, 0);
  hoja.getCell("A2").value = { formula: '"Ana"', result: "Ana" };
  await assert.rejects(leerArchivo(await archivo()), /fórmulas/);
  hoja.getCell("A2").value = "Ana";
  libro.addWorksheet("Otra").addRow(["datos"]);
  await assert.rejects(leerArchivo(await archivo()), /única hoja/);
  await assert.rejects(leerArchivo({ originalname: "bomba.xlsx", buffer: Buffer.from("no es un zip") }), /Excel/);
});

test("validación por fila informa duplicados de todo el lote, fechas imposibles y ámbito departamental", async () => {
  const filas = normalizarFilas(await leerArchivo(csv([
    "Ana,Pérez,30.123.456,ana@example.test,1990-02-28,Azul",
    "Luis,Gómez,30123456,ANA@example.test,2026-02-31,La Plata",
  ], `${CABECERA},departamental`)), catalogos);
  assert.ok(filas.every((fila) => fila.errores.some((error) => /DNI repetido/.test(error))));
  assert.ok(filas.every((fila) => fila.errores.some((error) => /Email repetido/.test(error))));
  assert.ok(filas[0].errores.some((error) => /Solo podés/.test(error)));
  assert.ok(filas[1].errores.some((error) => /Fecha de nacimiento/.test(error)));
});

test("solo los cuatro roles autorizados importan; departamental siempre queda en su ámbito", () => {
  for (const rol of ["admin", "admin-central", "auditor", "departamental"]) assert.doesNotThrow(() => autorizarImportacion({ ...actor, rol }));
  for (const rol of ["afiliado", "invitado", "prensa"]) assert.throws(() => autorizarImportacion({ ...actor, rol }), { statusCode: 403 });
  for (const patch of [{ departamental_id: null }, { habilitado: "N" }, { bloqueo_tipo: "total" }, { requiere_cambio_clave: 1 }]) {
    assert.throws(() => autorizarImportacion({ ...actor, ...patch }), { statusCode: 403 });
  }
});

test("preview no escribe; confirmar crea afiliados, auditoría y bienvenida atómicamente sin contraseñas utilizables", async () => {
  const f = fixture();
  const archivo = csv();
  const preview = await f.servicio.preview({ actorId: 1, archivo });
  assert.equal(preview.validos, 1);
  assert.equal(f.estado.usuarios.length, 0);
  assert.equal(f.estado.cola.length, 0);
  assert.ok(f.consultas.every(({ sql }) => sql.startsWith("SELECT")));
  const result = await f.servicio.confirmar({ actorId: 1, archivo, token: preview.token, enviarBienvenida: "true" });
  assert.equal(result.creados, 1);
  assert.equal(result.emailsPendientes, 1);
  assert.equal(f.estado.commits, 1);
  assert.equal(f.estado.cola.length, 1);
  assert.equal(f.estado.historial.length, 1);
  assert.equal(f.estado.usuarios[0].rol_id, 2);
  assert.equal(f.estado.usuarios[0].password.length, 44);
  assert.match(f.estado.usuarios[0].password, /^!sin-acceso:/);
  assert.equal(await bcrypt.compare(f.estado.usuarios[0].password, f.estado.usuarios[0].password), false);
  assert.ok(!JSON.stringify(f.estado.historial).includes("!sin-acceso"));
  assert.ok(f.consultas.some(({ sql }) => /SELECT documento, email.*FOR UPDATE/s.test(sql)));
});

test("no enviar bienvenida conserva la cuenta y no invoca la cola", async () => {
  const f = fixture({ rol: "auditor", fallarCola: true });
  const archivo = csv();
  const preview = await f.servicio.preview({ actorId: 1, archivo, departamentalId: "Azul" });
  const result = await f.servicio.confirmar({ actorId: 1, archivo, departamentalId: "Azul", token: preview.token, enviarBienvenida: false });
  assert.equal(result.emailsPendientes, 0);
  assert.equal(f.estado.usuarios[0].departamental_id, 4);
  assert.equal(f.estado.cola.length, 0);
});

test("la credencial inicial permite solicitar recuperación por DNI sin enviar correos en la prueba", async () => {
  const f = fixture();
  const archivo = csv();
  const preview = await f.servicio.preview({ actorId: 1, archivo });
  await f.servicio.confirmar({ actorId: 1, archivo, token: preview.token, enviarBienvenida: false });
  const recuperacion = crearServicioRecuperacion({ db: f.db, jwtSecret: SECRET, enviarCodigo: async () => { throw new Error("No debe enviarse correo"); } });
  const solicitud = await recuperacion.solicitar({ identificador: "30123456", ip: "127.0.0.1" });
  assert.equal(solicitud.para, "ana@example.test");
  assert.match(solicitud.codigo, /^\d{6}$/);
  assert.equal(f.estado.cola.length, 0);
});

test("reintentar la confirmación no duplica usuarios ni bienvenidas; se revalida también el email", async () => {
  const f = fixture();
  const archivo = csv();
  const preview = await f.servicio.preview({ actorId: 1, archivo });
  const args = { actorId: 1, archivo, token: preview.token, enviarBienvenida: true };
  await f.servicio.confirmar(args);
  await assert.rejects(f.servicio.confirmar(args), (error) => error.statusCode === 409 && error.detalles.errores === 1);
  assert.equal(f.estado.usuarios.length, 1);
  assert.equal(f.estado.cola.length, 1);
  const diferente = csv(["Ana,Pérez,30999999,ana@example.test,1990-02-28"]);
  assert.equal((await f.servicio.preview({ actorId: 1, archivo: diferente })).errores, 1);
});

test("cambios entre preview y confirmación detienen el lote completo", async () => {
  const f = fixture();
  const archivo = csv(["Ana,Pérez,30123456,ana@example.test,1990-02-28", "Luis,Gómez,31123456,luis@example.test,1988-06-12"]);
  const preview = await f.servicio.preview({ actorId: 1, archivo });
  f.estado.usuarios.push({ documento: 31123456, email: "otro@example.test" });
  await assert.rejects(f.servicio.confirmar({ actorId: 1, archivo, token: preview.token, enviarBienvenida: true }), { statusCode: 409 });
  assert.equal(f.estado.usuarios.length, 1);
  assert.equal(f.estado.cola.length, 0);
  assert.equal(f.estado.rollbacks, 1);
});

test("fallar auditoría o encolado revierte usuarios y libera conexión y bloqueo", async () => {
  for (const opciones of [{ fallarHistorial: true }, { fallarCola: true }]) {
    const f = fixture(opciones);
    const archivo = csv();
    const preview = await f.servicio.preview({ actorId: 1, archivo });
    await assert.rejects(f.servicio.confirmar({ actorId: 1, archivo, token: preview.token, enviarBienvenida: true }));
    assert.equal(f.estado.usuarios.length, 0);
    assert.equal(f.estado.cola.length, 0);
    assert.equal(f.estado.rollbacks, 1);
    assert.equal(f.estado.liberaciones, 1);
    assert.ok(f.consultas.some(({ sql }) => /RELEASE_LOCK/.test(sql)));
  }
});

test("token se vincula a actor, archivo y sede; se verifica su vencimiento y los permisos actuales", async () => {
  const f = fixture();
  const archivo = csv();
  const preview = await f.servicio.preview({ actorId: 1, archivo });
  const args = { actorId: 1, archivo, token: preview.token, enviarBienvenida: true };
  for (const patch of [{ actorId: 2 }, { archivo: csv(["Ana,Pérez,30999999,ana@example.test,1990-02-28"]) }, { departamentalId: "4" }, { token: `${preview.token}x` }]) {
    await assert.rejects(f.servicio.confirmar({ ...args, ...patch }), { statusCode: 409 });
  }
  const futuro = crearServicioImportacionUsuarios({ db: f.db, jwtSecret: SECRET, ahora: () => Date.now() + 16 * 60 * 1000 });
  await assert.rejects(futuro.confirmar(args), { statusCode: 409 });
  f.estado.actor.rol = "afiliado";
  await assert.rejects(f.servicio.confirmar(args), { statusCode: 403 });
  assert.equal(f.estado.usuarios.length, 0);
});

test("HTTP niega JWT ausente y rol no autorizado antes de procesar el archivo", async () => {
  const f = fixture({ rol: "afiliado" });
  const app = express();
  app.use(crearRouterImportacionUsuarios({ db: f.db, jwtSecret: SECRET, encolar: f.encolar }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/usuarios/importacion/preview`;
    const sinToken = await fetch(url, { method: "POST" });
    assert.equal(sinToken.status, 401);
    const token = jwt.sign({ data: JSON.stringify({ id: 1, rol: "admin" }) }, SECRET, { expiresIn: "1h" });
    const sinPermiso = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    assert.equal(sinPermiso.status, 403, "se consulta el rol vigente, no el rol antiguo del token");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("HTTP multipart completa preview y confirmación con el mismo archivo y devuelve bienvenida pendiente", async () => {
  const f = fixture();
  const app = express();
  app.use(crearRouterImportacionUsuarios({ db: f.db, jwtSecret: SECRET, encolar: f.encolar }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/usuarios/importacion`;
    const token = jwt.sign({ data: JSON.stringify({ id: 1 }) }, SECRET, { expiresIn: "1h" });
    const headers = { Authorization: `Bearer ${token}` };
    const archivo = csv();
    const form = (previo) => {
      const body = new FormData();
      body.append("archivo", new Blob([archivo.buffer], { type: "text/csv" }), archivo.originalname);
      if (previo) { body.append("token", previo); body.append("enviarBienvenida", "true"); }
      return body;
    };
    const pre = await fetch(`${url}/preview`, { method: "POST", headers, body: form() });
    assert.equal(pre.status, 200);
    const previo = await pre.json();
    assert.equal(previo.validos, 1);
    const confirmacion = await fetch(`${url}/confirmar`, { method: "POST", headers, body: form(previo.token) });
    assert.equal(confirmacion.status, 201);
    assert.equal((await confirmacion.json()).emailsPendientes, 1);
    assert.equal(f.estado.usuarios.length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
