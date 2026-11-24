"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "prensa-test-only";

const usuario = { id: 91, rol: "prensa", rol_id: 7, habilitado: "Y", requiere_cambio_clave: 0 };
let acceso = true;
const edicion = { id: 2, nombre: "Edición asignada" };
const db = { async query(sql, params) {
  if (sql.includes("r.nombre AS rol")) return [[usuario]];
  if (sql.includes("JOIN olimpiada_prensa")) {
    assert.equal(params[0], usuario.id);
    if (sql.includes("FROM olimpiada_foto m")) return [params[1].includes(11) && acceso ? [{ id: 11 }] : []];
    if (sql.includes("FROM olimpiada_video m")) return [[]];
    if (sql.includes("AND o.id = ?")) return [Number(params[1]) === 2 && acceso ? [edicion] : []];
    return [acceso ? [edicion] : []];
  }
  if (sql.includes("FROM olimpiada o WHERE")) return [[edicion]];
  if (sql.includes("FROM olimpiada_disciplina_config c")) return [[{ id: 5, nombre: "Fútbol" }]];
  throw new Error("Se ejecutó una consulta fuera del alcance esperado");
} };
const modulePath = require.resolve("../api/connection/connection");
require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: { promise: () => db } };
const contenido = require("../api/routes/olimpiadas-contenido");
const { exigirAsignacion } = require("../api/routes/olimpiadas-prensa");

test("Prensa accede sólo a las galerías asignadas; retirar el permiso afecta la sesión vigente", async t => {
  const app = express();
  app.use(express.json(), contenido);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const token = jwt.sign({ data: JSON.stringify(usuario) }, process.env.JWT_SECRET);
  const pedir = (ruta, method = "GET", body) => fetch(`http://127.0.0.1:${server.address().port}/olimpiadas/${ruta}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.deepEqual(await (await pedir("prensa/ediciones")).json(), [edicion]);
  const contexto = await pedir("2/fotos/contexto");
  assert.equal(contexto.status, 200);
  assert.deepEqual((await contexto.json()).disciplinas, [{ id: 5, nombre: "Fútbol" }]);
  for (const [ruta, method, body] of [
    ["3/fotos/contexto"], ["3/fotos", "POST"], ["3/videos", "POST"],
    ["fotos/12", "PUT", { etiqueta: "Equipo" }], ["fotos/lote", "PUT", { ids: [11, 12] }],
    ["videos/22/partes/1", "PUT"], ["videos/22/completar", "POST"],
    ["2/prensa"], ["2/prensa/92", "PUT"], ["2/fixture"], ["2/sedes"], ["2/novedades", "POST"],
    ["fotos/11", "DELETE"], ["fotos/eliminar-lote", "POST", { ids: [11] }],
  ]) assert.equal((await pedir(ruta, method, body)).status, 403, ruta);
  await exigirAsignacion(db, usuario.id, { fotoId: 11 });
  acceso = false;
  try {
    assert.deepEqual(await (await pedir("prensa/ediciones")).json(), []);
    assert.equal((await pedir("2/fotos/contexto")).status, 403);
  } finally { acceso = true; }
});
