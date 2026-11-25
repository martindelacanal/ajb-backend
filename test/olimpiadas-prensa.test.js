"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
Object.assign(process.env, { JWT_SECRET: "prensa-test-only", BUCKET_REGION: "us-east-1", BUCKET_NAME: "prensa-test",
  ACCESS_KEY: "test", SECRET_ACCESS_KEY: "test" });

const usuario = { id: 91, rol: "prensa", rol_id: 7, habilitado: "Y", requiere_cambio_clave: 0 };
let acceso = true;
const edicion = { id: 2, nombre: "Edición asignada" };
// Lo que Prensa puede borrar: una foto y un video ya subido de su edición, y un video ajeno a medio subir.
const fotos = new Map([[11, { id: 11, olimpiada_id: 2, archivo: "galeria/11.webp", miniatura_archivo: "mini/11.webp", epigrafe: "Final", eliminado: 0 }]]);
const videos = new Map([
  [22, { id: 22, olimpiada_id: 2, titulo: "Resumen del jueves", archivo: "videos/22.mp4", poster_archivo: "videos/22.webp", estado: "LISTO", usuario_id: 5, eliminado: 0 }],
  [23, { id: 23, olimpiada_id: 2, titulo: "Subida ajena", archivo: "videos/23.mp4", poster_archivo: null, estado: "SUBIENDO", usuario_id: 5, eliminado: 0 }],
]);
const historial = [];
const db = {
  async query(sql, params) {
    if (sql.includes("r.nombre AS rol")) return [[usuario]];
    if (sql.includes("JOIN olimpiada_prensa")) {
      assert.equal(params[0], usuario.id);
      if (sql.includes("FROM olimpiada_foto m")) {
        return [acceso ? params[1].filter(id => fotos.has(id) && !fotos.get(id).eliminado).map(id => ({ id })) : []];
      }
      if (sql.includes("FROM olimpiada_video m")) {
        // Una subida en curso sólo la toca quien la empezó.
        assert.match(sql, /m\.estado <> 'SUBIENDO' OR m\.usuario_id = \?/);
        return [acceso ? params[1].filter(id => videos.has(id) && !videos.get(id).eliminado
          && (videos.get(id).estado !== "SUBIENDO" || videos.get(id).usuario_id === params[2])).map(id => ({ id })) : []];
      }
      if (sql.includes("AND o.id = ?")) return [Number(params[1]) === 2 && acceso ? [edicion] : []];
      return [acceso ? [edicion] : []];
    }
    if (sql.includes("FROM olimpiada o WHERE")) return [[edicion]];
    if (sql.includes("FROM olimpiada_disciplina_config c")) return [[{ id: 5, nombre: "Fútbol" }]];
    if (sql.includes("FROM departamental WHERE habilitado = 'Y'")) return [[{ id: 3, nombre: "La Plata" }, { id: 7, nombre: "Mar del Plata" }]];
    if (sql.startsWith("SELECT * FROM olimpiada_foto WHERE id = ? AND eliminado = 0")) {
      const foto = fotos.get(params[0]);
      return [foto && !foto.eliminado ? [{ ...foto }] : []];
    }
    if (sql.startsWith("SELECT id, olimpiada_id, archivo, miniatura_archivo FROM olimpiada_foto WHERE id IN (?)")) {
      return [params[0].map(id => fotos.get(id)).filter(foto => foto && !foto.eliminado).map(foto => ({ ...foto }))];
    }
    if (sql.startsWith("SELECT * FROM olimpiada_video WHERE id = ? AND eliminado = 0")) {
      const video = videos.get(params[0]);
      return [video && !video.eliminado ? [{ ...video }] : []];
    }
    if (sql.startsWith("UPDATE olimpiada_foto SET eliminado = 1")) {
      for (const id of [params[0]].flat()) fotos.get(id).eliminado = 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE olimpiada_video SET eliminado = 1")) {
      videos.get(params[0]).eliminado = 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("INSERT INTO olimpiada_historial")) {
      historial.push({ entidad: params[0], entidad_id: params[1], usuario_id: params[4], rol: params[5], operacion: params[6] });
      return [{ insertId: historial.length }];
    }
    throw new Error("Se ejecutó una consulta fuera del alcance esperado");
  },
  async getConnection() {
    return { query: db.query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  },
};
const modulePath = require.resolve("../api/connection/connection");
require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: { promise: () => db } };
const contenido = require("../api/routes/olimpiadas-contenido");
const { exigirAsignacion } = require("../api/routes/olimpiadas-prensa");
const { s3 } = require("../api/services/olimpiadas-comun");

test("Prensa accede sólo a las galerías asignadas; retirar el permiso afecta la sesión vigente", async t => {
  const borradosS3 = [];
  t.mock.method(s3, "send", async comando => {
    assert.equal(comando.constructor.name, "DeleteObjectCommand");
    borradosS3.push(comando.input.Key);
    return {};
  });
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
  const datosContexto = await contexto.json();
  assert.deepEqual(datosContexto.disciplinas, [{ id: 5, nombre: "Fútbol" }]);
  // Las departamentales para clasificar las fotos llegan con el contexto de la galería.
  assert.deepEqual(datosContexto.departamentales, [{ id: 3, nombre: "La Plata" }, { id: 7, nombre: "Mar del Plata" }]);
  for (const [ruta, method, body] of [
    ["3/fotos/contexto"], ["3/fotos", "POST"], ["3/videos", "POST"],
    ["fotos/12", "PUT", { etiqueta: "Equipo" }], ["fotos/lote", "PUT", { ids: [11, 12] }],
    ["videos/24/partes/1", "PUT"], ["videos/24/completar", "POST"],
    ["2/prensa"], ["2/prensa/92", "PUT"], ["2/fixture"], ["2/sedes"], ["2/novedades", "POST"],
    // Borrar: nada que no sea de una edición asignada, ni una subida de video que empezó otra persona.
    ["fotos/12", "DELETE"], ["fotos/eliminar-lote", "POST", { ids: [11, 12] }], ["videos/24", "DELETE"], ["videos/23", "DELETE"],
  ]) assert.equal((await pedir(ruta, method, body)).status, 403, ruta);
  assert.equal(historial.length, 0);
  assert.equal(fotos.get(11).eliminado, 0);
  await exigirAsignacion(db, usuario.id, { fotoId: 11 });
  acceso = false;
  try {
    assert.deepEqual(await (await pedir("prensa/ediciones")).json(), []);
    assert.equal((await pedir("2/fotos/contexto")).status, 403);
    assert.equal((await pedir("fotos/11", "DELETE")).status, 403);
    assert.equal((await pedir("videos/22", "DELETE")).status, 403);
  } finally { acceso = true; }

  // Con la edición asignada, Prensa elimina fotos (de a una o varias) y videos ya subidos, sin pasar por la administración.
  const unaFoto = await pedir("fotos/11", "DELETE");
  assert.equal(unaFoto.status, 200);
  assert.equal((await unaFoto.json()).message, "Foto eliminada");
  assert.equal(fotos.get(11).eliminado, 1);
  fotos.get(11).eliminado = 0;
  const lote = await pedir("fotos/eliminar-lote", "POST", { ids: [11] });
  assert.equal(lote.status, 200);
  assert.deepEqual(await lote.json(), { success: true, message: "Se eliminó 1 foto", eliminadas: 1 });
  const video = await pedir("videos/22", "DELETE");
  assert.equal(video.status, 200);
  assert.equal((await video.json()).message, "Video eliminado");
  assert.equal(videos.get(22).eliminado, 1);
  assert.equal(videos.get(23).eliminado, 0);
  // Cada baja queda en el historial con quien la hizo, y se limpian los archivos.
  assert.deepEqual(historial.map(h => [h.entidad, h.usuario_id, h.rol, h.operacion]),
    [["FOTO", 91, "prensa", "DELETE"], ["FOTO", 91, "prensa", "DELETE"], ["VIDEO", 91, "prensa", "DELETE"]]);
  assert.deepEqual(borradosS3, ["galeria/11.webp", "mini/11.webp", "galeria/11.webp", "mini/11.webp", "videos/22.mp4", "videos/22.webp"]);
  assert.equal((await pedir("fotos/11", "DELETE")).status, 403, "una foto ya eliminada no se vuelve a tocar");
});
