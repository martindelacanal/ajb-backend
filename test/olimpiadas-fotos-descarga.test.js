"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

Object.assign(process.env, { JWT_SECRET: "fotos-prueba", BUCKET_REGION: "us-east-1",
  BUCKET_NAME: "fotos-prueba", ACCESS_KEY: "test", SECRET_ACCESS_KEY: "test" });

test("las galerías autorizadas firman la descarga del archivo completo de cada foto visible", async t => {
  const prensa = { id: 10, rol: "prensa", rol_id: 7, habilitado: "Y", requiere_cambio_clave: 0 };
  const fotos = ["partido.webp", "historica.jpg", "archivo.png", "sin-extension", "con-mime", "borrada.jpg"].map((nombre, i) => ({
    id: i + 1, olimpiada_id: 2, archivo: "galeria/" + nombre, miniatura_archivo: "mini/" + (i + 1) + ".webp",
    mime: nombre === "con-mime" ? "image/jpeg" : null, epigrafe: 'Vóley / "Final"', eliminado: nombre === "borrada.jpg" ? 1 : 0,
  }));
  let consultasFotos = 0;
  const db = { async query(sql, params) {
    if (sql.includes("r.nombre AS rol")) return [[prensa]];
    if (sql.includes("JOIN olimpiada_prensa")) return [Number(params[1]) === 2 ? [{ id: 2 }] : []];
    if (sql.includes("FROM olimpiada WHERE")) return [[{ id: Number(params[0]), habilitado: "Y",
      publicada_publico: Number(params[0]) === 2 ? 1 : 0 }]];
    assert.match(sql, /FROM olimpiada_foto/);
    consultasFotos++;
    assert.match(sql, /WHERE (?:f\.)?olimpiada_id = \? AND (?:f\.)?eliminado = 0/);
    const visibles = fotos.filter(f => f.olimpiada_id === Number(params[0]) && !f.eliminado);
    if (sql.startsWith("SELECT COUNT(*) AS total")) return [[{ total: visibles.length }]];
    if (sql.startsWith("SELECT f.id,")) { assert.match(sql, /f\.mime\b/); return [visibles]; }
    if (sql.includes("GROUP BY")) return [[]];
    throw new Error("Consulta inesperada de fotos");
  } };
  const conexion = require.resolve("../api/connection/connection");
  require.cache[conexion] = { id: conexion, filename: conexion, loaded: true, exports: { promise: () => db } };
  const { s3 } = require("../api/services/olimpiadas-comun");
  const comandosS3 = t.mock.method(s3, "send", () => { throw new Error("La galería sólo debe firmar enlaces"); });
  const app = express();
  app.use(require("../api/routes/olimpiadas-publico"), require("../api/routes/olimpiadas-contenido"));
  const servidor = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { servidor.closeAllConnections(); servidor.close(resolve); }));
  const base = "http://127.0.0.1:" + servidor.address().port + "/olimpiadas/";
  const token = jwt.sign({ data: JSON.stringify(prensa) }, process.env.JWT_SECRET);
  const sesion = { headers: { Authorization: "Bearer " + token } };

  assert.equal((await fetch(base + "publico/3/fotos")).status, 404);
  assert.equal((await fetch(base + "3/fotos", sesion)).status, 403);
  const privadaSinSesion = await fetch(base + "2/fotos");
  assert.ok([401, 403].includes(privadaSinSesion.status));
  assert.equal(consultasFotos, 0);
  for (const [ruta, opciones] of [["publico/2/fotos", {}], ["2/fotos", sesion]]) {
    const respuesta = await fetch(base + ruta, opciones);
    assert.equal(respuesta.status, 200);
    const { results, totalItems } = await respuesta.json();
    assert.equal(totalItems, 5);
    assert.deepEqual(results.map(f => f.id), [1, 2, 3, 4, 5]);
    for (const foto of results) {
      const original = fotos[foto.id - 1];
      const lectura = new URL(foto.url), descarga = new URL(foto.descarga_url), miniatura = new URL(foto.url_miniatura);
      assert.equal(lectura.pathname, "/" + original.archivo);
      assert.equal(descarga.pathname, lectura.pathname);
      assert.equal(miniatura.pathname, "/" + original.miniatura_archivo);
      assert.equal(descarga.origin, lectura.origin);
      assert.notEqual(descarga.href, lectura.href);
      assert.equal(descarga.protocol, "https:");
      for (const enlace of [descarga, lectura, miniatura]) {
        assert.ok(enlace.searchParams.get("X-Amz-Signature"));
        assert.ok(Number(enlace.searchParams.get("X-Amz-Expires")) > 0);
      }
      assert.equal(lectura.searchParams.get("response-content-disposition"), null);
      const adjunto = descarga.searchParams.get("response-content-disposition");
      assert.match(adjunto, /^attachment;\s*filename="[^"/\\\r\n]+"/);
      const nombre = adjunto.match(/filename="([^"]+)"/)[1];
      const extension = original.archivo.split(".")[1] || (original.mime === "image/jpeg" ? "jpg" : null);
      assert.equal(nombre, "olimpiadas-2-foto-" + foto.id + (extension ? "." + extension : ""));
    }
  }
  assert.equal(comandosS3.mock.callCount(), 0);
});
