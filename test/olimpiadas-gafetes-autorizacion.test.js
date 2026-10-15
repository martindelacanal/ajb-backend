"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "gafetes-negative-tests-only";

let contexto;
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: {
  promise: () => ({ query: (...args) => contexto.query(...args) }),
} };
const pdfPath = require.resolve("../api/services/olimpiadas-gafetes");
require.cache[pdfPath] = { id: pdfPath, filename: pdfPath, loaded: true, exports: {
  generarGafetes: async (rows) => { contexto.pdfs.push(rows); return Buffer.from("%PDF-test-approved-only"); },
} };
const router = require("../api/routes/olimpiadas-gafetes");
const { crearTokenVoluntario } = require("../api/security/olimpiadas-voluntarios");

const aprobado = { id: 11, usuario_id: 20, departamental_id: 5, olimpiada_id: 7, estado: "VALIDADO", afiliado_nombre: "Ana", afiliado_apellido: "Pérez", foto_archivo: null };

async function servidor(t, { rol = "afiliado", usuarioId = 20, departamentalId = 5, rows = [aprobado] } = {}) {
  contexto = { pdfs: [], consultas: [], auditorias: [], usuario: {
    id: usuarioId, rol, rol_id: rol === "afiliado" ? 2 : 1, departamental_id: departamentalId,
    habilitado: "Y", modulo_olimpiadas: 1, modulo_turismo: 0, modulo_coseguro: 0,
    requiere_cambio_clave: 0, es_familiar: "N", usuario_familiar_id: null,
  } };
  contexto.query = async (sql, params = []) => {
    contexto.consultas.push({ sql, params });
    if (/FROM usuario u[\s\S]+INNER JOIN rol r/.test(sql)) return [[contexto.usuario]];
    if (/FROM olimpiada_inscripcion i JOIN usuario/.test(sql)) {
      let seleccion = rows;
      if (/AND i\.id=\?/.test(sql)) seleccion = seleccion.filter((r) => r.id === Number(params[0]));
      if (/AND i\.olimpiada_id=\?/.test(sql)) seleccion = seleccion.filter((r) => r.olimpiada_id === Number(params[0]));
      if (/i\.estado='VALIDADO'/.test(sql)) seleccion = seleccion.filter((r) => r.estado === "VALIDADO");
      const departamentales = [...sql.matchAll(/AND i\.departamental_id=\?/g)].length;
      for (let i = 0; i < departamentales; i++) seleccion = seleccion.filter((r) => r.departamental_id === Number(params[i + 1]));
      return [seleccion.map((r) => ({ ...r }))];
    }
    if (/FROM olimpiada_inscripcion_disciplina x JOIN/.test(sql)) return [[{ inscripcion_id: 11, nombre: "Vóley" }]];
    if (/INSERT INTO olimpiada_historial/.test(sql)) { contexto.auditorias.push(params); return [{ affectedRows: 1 }]; }
    assert.fail(`Consulta no prevista: ${sql}`);
  };
  const app = express(); app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const token = jwt.sign({ data: JSON.stringify({ id: usuarioId, rol, departamental_id: departamentalId }) }, process.env.JWT_SECRET);
  return {
    pedir: (path, auth = token) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} }),
    contexto,
  };
}

test("gafete: una inscripción pendiente o cancelada nunca genera una credencial, tampoco para el admin", async (t) => {
  const { pedir, contexto } = await servidor(t, { rol: "admin", rows: [
    { ...aprobado, estado: "PENDIENTE" }, { ...aprobado, id: 12, estado: "CANCELADO" },
  ] });
  for (const id of [11, 12]) {
    const response = await pedir(`/olimpiadas/inscripciones/${id}/gafete.pdf`);
    assert.equal(response.status, 409);
    assert.match(await response.json(), /apruebe/);
  }
  assert.equal(contexto.pdfs.length, 0);
  assert.equal(contexto.auditorias.length, 0);
});

test("gafete: el afiliado no puede descargar otra inscripción aprobada", async (t) => {
  const { pedir, contexto } = await servidor(t, { usuarioId: 21 });
  const response = await pedir("/olimpiadas/inscripciones/11/gafete.pdf");
  assert.equal(response.status, 403);
  assert.equal(contexto.pdfs.length, 0);
});

test("gafete: la departamental no puede descargar la credencial de otra departamental", async (t) => {
  const { pedir, contexto } = await servidor(t, { rol: "departamental", departamentalId: 9 });
  const response = await pedir("/olimpiadas/inscripciones/11/gafete.pdf");
  assert.equal(response.status, 403);
  assert.equal(contexto.pdfs.length, 0);
});

test("gafete: usuarios públicos y tokens de voluntarios no tienen acceso a fotos ni credenciales", async (t) => {
  const { pedir, contexto } = await servidor(t);
  for (const token of [null, crearTokenVoluntario({ id: 20, sesion_version: 1 })]) {
    const response = await pedir("/olimpiadas/inscripciones/11/gafete.pdf", token);
    assert.equal(response.status, 401);
  }
  assert.equal(contexto.pdfs.length, 0);
  assert.equal(contexto.consultas.length, 0);
});

test("gafete: la inscripción propia aprobada se descarga sin caché y deja auditoría PDF válida", async (t) => {
  const { pedir, contexto } = await servidor(t);
  const response = await pedir("/olimpiadas/inscripciones/11/gafete.pdf");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/pdf/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(await response.text(), /^%PDF/);
  assert.equal(contexto.pdfs.length, 1);
  assert.deepEqual(contexto.pdfs[0][0].disciplinas, ["Vóley"]);
  assert.equal(contexto.auditorias.length, 1);
  assert.equal(contexto.auditorias[0][6], "PDF");
});

test("lote de gafetes: afiliados no pueden imprimir a otros participantes", async (t) => {
  const { pedir, contexto } = await servidor(t);
  const response = await pedir("/olimpiadas/7/gafetes.pdf");
  assert.equal(response.status, 403);
  assert.equal(contexto.pdfs.length, 0);
  assert.equal(contexto.consultas.some((q) => /FROM olimpiada_inscripcion i JOIN usuario/.test(q.sql)), false);
});

test("lote de gafetes: filtrar otra departamental no permite saltar el ámbito de la propia", async (t) => {
  const { pedir, contexto } = await servidor(t, { rol: "departamental", departamentalId: 9, rows: [aprobado, { ...aprobado, id: 12, departamental_id: 9 }] });
  const response = await pedir("/olimpiadas/7/gafetes.pdf?departamental_id=5");
  assert.equal(response.status, 404);
  assert.equal(contexto.pdfs.length, 0);
  const query = contexto.consultas.find((q) => /FROM olimpiada_inscripcion i JOIN usuario/.test(q.sql));
  assert.deepEqual(query.params, ["7", 9, 5]);
});

test("lote de gafetes: excluye pendientes y cancelados y conserva únicamente aprobados", async (t) => {
  const { pedir, contexto } = await servidor(t, { rol: "admin", rows: [aprobado,
    { ...aprobado, id: 12, estado: "PENDIENTE" }, { ...aprobado, id: 13, estado: "CANCELADO" },
  ] });
  const response = await pedir("/olimpiadas/7/gafetes.pdf");
  assert.equal(response.status, 200);
  assert.deepEqual(contexto.pdfs[0].map((r) => r.id), [11]);
});

test("lote de gafetes: rechaza filtros inválidos y lotes sin límite antes de generar PDFs", async (t) => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ ...aprobado, id: i + 1 }));
  const { pedir, contexto } = await servidor(t, { rol: "admin", rows });
  for (const query of ["departamental_id=1abc", "disciplina_id=-1", "inscripcion_ids=11,xyz", `inscripcion_ids=${rows.map((r) => r.id).join(",")}`]) {
    const response = await pedir(`/olimpiadas/7/gafetes.pdf?${query}`);
    assert.equal(response.status, 400);
  }
  assert.equal((await pedir("/olimpiadas/7/gafetes.pdf")).status, 422);
  assert.equal(contexto.pdfs.length, 0);
});
