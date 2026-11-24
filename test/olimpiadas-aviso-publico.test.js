"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");

Object.assign(process.env, { JWT_SECRET: "aviso-prueba", BUCKET_REGION: "us-east-1",
  BUCKET_NAME: "aviso-prueba", ACCESS_KEY: "test", SECRET_ACCESS_KEY: "test" });

test("solo la administración puede publicar, reemplazar o retirar el aviso de su edición", async t => {
  const admin = { id: 5, rol: "admin", rol_id: 1, habilitado: "Y", requiere_cambio_clave: 0 };
  const departamental = { ...admin, id: 6, rol: "departamental", rol_id: 3 };
  const db = { async query(sql, params) {
    if (sql.includes("r.nombre AS rol")) return [[Number(params[0]) === admin.id ? admin : departamental]];
    if (sql.includes("FROM olimpiada WHERE")) return [Number(params[0]) === 2 ? [{ id: 2 }] : []];
    assert.match(sql, /INSERT INTO olimpiada_historial/);
    return [{}];
  } };
  const conexion = require.resolve("../api/connection/connection");
  require.cache[conexion] = { id: conexion, filename: conexion, loaded: true, exports: { promise: () => db } };
  const { s3, obtenerUrlAvisoPublico } = require("../api/services/olimpiadas-comun");
  const objetos = new Map();
  t.mock.method(s3, "send", async comando => {
    const { Key, Body, ContentType, CacheControl } = comando.input;
    if (comando.constructor.name === "PutObjectCommand") {
      assert.match(CacheControl, /no-cache/);
      const ETag = crypto.createHash("md5").update(Body).digest("hex");
      objetos.set(Key, { Body, ContentType, ContentLength: Body.length, ETag });
    }
    if (!objetos.has(Key)) throw Object.assign(new Error("Not Found"), { $metadata: { httpStatusCode: 404 } });
    return objetos.get(Key);
  });

  const app = express();
  app.use(require("../api/routes/olimpiadas"));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = "http://127.0.0.1:" + server.address().port + "/olimpiadas/";
  const sesion = usuario => ({ Authorization: "Bearer " + jwt.sign({ data: JSON.stringify(usuario) }, process.env.JWT_SECRET) });
  const headers = sesion(admin);
  const ruta = base + "2/popup-imagen";
  assert.equal(await obtenerUrlAvisoPublico(2), null);
  assert.equal((await fetch(ruta, { method: "DELETE", headers: sesion(departamental) })).status, 401);
  assert.equal((await fetch(base + "3/popup-imagen", { method: "DELETE", headers })).status, 404);
  assert.equal((await fetch(ruta, { method: "PUT", headers })).status, 400);
  assert.equal(objetos.size, 0);
  let version;
  for (const background of ["blue", "red"]) {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer();
    const body = new FormData();
    body.append("IMAGEN", new Blob([png], { type: "image/png" }), "aviso.png");
    const respuesta = await fetch(ruta, { method: "PUT", headers, body });
    assert.equal(respuesta.status, 200);
    const url = new URL((await respuesta.json()).popup_imagen_url);
    assert.equal(url.pathname, "/olimpiadas/ediciones/2/aviso-publico");
    assert.equal((await sharp(objetos.get(url.pathname.slice(1)).Body).metadata()).format, "webp");
    const nombre = url.searchParams.get("response-content-disposition");
    assert.notEqual(nombre, version);
    assert.equal(new URL(await obtenerUrlAvisoPublico(2)).searchParams.get("response-content-disposition"), nombre);
    version = nombre;
  }
  assert.equal(await obtenerUrlAvisoPublico(3), null);
  const baja = await fetch(ruta, { method: "DELETE", headers });
  assert.equal(baja.status, 200);
  assert.equal((await baja.json()).popup_imagen_url, null);
  assert.equal(objetos.get("olimpiadas/ediciones/2/aviso-publico").ContentLength, 0);
  assert.equal(await obtenerUrlAvisoPublico(2), null);
});
