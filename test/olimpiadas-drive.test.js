"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const { randomUUID } = require("node:crypto");

Object.assign(process.env, { JWT_SECRET: "drive-test-only", BUCKET_REGION: "us-east-1",
  BUCKET_NAME: "drive-test", ACCESS_KEY: "test", SECRET_ACCESS_KEY: "test" });
const actor = { id: 91, rol: "prensa", rol_id: 7, habilitado: "Y", requiere_cambio_clave: 0 };
const edicion = { id: 2, nombre: "Edición" };
let foto, video;
const historial = [];
const db = {
  async query(sql, p) {
    if (sql.includes("r.nombre AS rol")) return [[actor]];
    if (sql.includes("JOIN olimpiada_prensa")) return [Number(p[1]) === 2 ? [edicion] : []];
    if (sql.includes("SELECT * FROM olimpiada WHERE")) return [[edicion]];
    if (sql.includes("MAX(orden)") && sql.includes("olimpiada_foto")) return [[{ orden: 0 }]];
    if (sql.includes("f.carga_id")) return [foto ? [foto] : []];
    if (sql.includes("INSERT INTO olimpiada_foto")) {
      foto = { id: 21, olimpiada_id: p[0], archivo: p[1], miniatura_archivo: p[2], epigrafe: p[6] };
      return [{ insertId: foto.id }];
    }
    if (sql.includes("archivo LIKE")) return [video && video.archivo.startsWith(p[1].slice(0, -1)) ? [video] : []];
    if (sql.includes("COUNT(*)") && sql.includes("olimpiada_video")) return [[{ cantidad: video ? 1 : 0, orden: 0 }]];
    if (sql.includes("INSERT INTO olimpiada_video")) {
      video = { id: 31, titulo: p[1], archivo: p[4], bytes: p[6] };
      return [{ insertId: video.id }];
    }
    if (sql.includes("INSERT INTO olimpiada_historial")) { historial.push(p[0]); return [{ insertId: 1 }]; }
    throw new Error("SQL inesperado: " + sql);
  },
  async getConnection() { return { query: db.query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} }; },
};
const conexion = require.resolve("../api/connection/connection");
require.cache[conexion] = { id: conexion, filename: conexion, loaded: true, exports: { promise: () => db } };
const drive = require("../api/services/olimpiadas-drive");
const router = require("../api/routes/olimpiadas-contenido");
const { s3 } = require("../api/services/olimpiadas-comun");
const url = "https://drive.google.com/drive/u/1/folders/carpeta123456?resourcekey=clave-carpeta";
const html = `<div class="flip-entries"><a href="https://drive.google.com/file/d/foto0000001/view?resourcekey=clave-foto">
  <div class="flip-entry-thumb"><img src="https://lh3.googleusercontent.com/drive-storage/test=s190"/></div>
  <div class="flip-entry-title">Final &amp; podio.PNG</div></a>
  <a href="https://drive.google.com/file/d/video000001/view"><img src="https://drive-thirdparty.googleusercontent.com/16/type/video/mp4">Resumen.mp4</a>
  <a href="https://drive.google.com/drive/folders/secundaria001?resourcekey=clave-finales">Finales</a><a href="https://drive.google.com/file/d/documento001/view">Presupuesto.xlsx</a></div>`;

test("el listado reconoce carpetas y medios, conserva la clave de cada recurso e ignora documentos", async t => {
  assert.deepEqual(drive.recursoDeEnlace(url), { id: "carpeta123456", clave: "clave-carpeta", tipo: "carpeta" });
  assert.equal(drive.recursoDeEnlace("https://drive.google.com/open?id=carpeta123456").tipo, "carpeta");
  for (const ruta of ["/file/d/foto0000001/view", "/file/u/2/d/foto0000001/preview", "/file/d/foto0000001"]) {
    assert.deepEqual(drive.recursoDeEnlace("https://drive.google.com" + ruta + "?resourcekey=clave-foto"),
      { id: "foto0000001", clave: "clave-foto", tipo: "archivo" });
  }
  for (const enlace of [url.replace("google.com", "google.com.example"), url.replace("https:", "http:"),
    url.replace("drive.google.com/", "usuario@drive.google.com/"), "https://drive.google.com/file/d/foto0000001/edit"]) {
    assert.throws(() => drive.recursoDeEnlace(enlace), /enlace de Google Drive/);
  }
  const { archivos, subcarpetas } = drive.leerListado(html);
  assert.deepEqual(subcarpetas, [{ id: "secundaria001", clave: "clave-finales", nombre: "Finales" }]);
  assert.deepEqual([...archivos.keys()], ["foto0000001", "video000001"]);
  assert.equal(archivos.get("foto0000001").nombre, "Final & podio.PNG");
  assert.match(archivos.get("foto0000001").miniatura_url, /lh3\.googleusercontent\.com/);
  assert.equal(archivos.get("foto0000001").clave, "clave-foto");
  const red = t.mock.method(global, "fetch", async () => new Response(null,
    { status: 302, headers: { location: "https://accounts.google.com/signin" } }));
  await assert.rejects(drive.listarCarpeta(url), /Drive no permitió el acceso/);
  assert.equal(red.mock.callCount(), 1);
  await assert.rejects(drive.juntar(drive.cuerpoLimitado(new Response(Buffer.alloc(8)), 7, "Demasiado grande")), /Demasiado grande/);
});

test("avisa al alcanzar el límite de carpetas y permite reintentar sin cachear resultados parciales", async t => {
  const urlGrande = "https://drive.google.com/drive/folders/carpeta-grande";
  const hijas = Array.from({ length: 256 }, (_, i) => `<a href="/drive/folders/subcarpeta-${i}">Carpeta ${i}</a>`).join("");
  let intentos = 0;
  t.mock.method(global, "fetch", async () => new Response(intentos++ === 0 ? hijas : '<div class="flip-entries"></div>'));
  await assert.rejects(drive.listarCarpeta(urlGrande), { statusCode: 413 });
  assert.equal((await drive.listarCarpeta(urlGrande)).archivos.size, 0);
  assert.equal(intentos, 2);
});

test("distingue carpetas hermanas homónimas de forma estable y respeta nombres que ya incluyen números", () => {
  const hermanas = [
    '<a href="/drive/folders/carpeta00001">Sábado</a>',
    '<a href="/drive/folders/carpeta00002">Sábado</a>',
    '<a href="/drive/folders/carpeta00003">Sábado (2)</a>',
  ];
  for (const orden of [hermanas, [...hermanas].reverse()]) {
    const { subcarpetas } = drive.leerListado(orden.join(""));
    assert.deepEqual(Object.fromEntries(subcarpetas.map(c => [c.id, c.nombre])), {
      carpeta00001: "Sábado", carpeta00002: "Sábado (3)", carpeta00003: "Sábado (2)",
    });
  }
  assert.equal(drive.leerListado('<div class="flip-entries"></div>').archivos.size, 0);
  assert.throws(() => drive.leerListado('<div class="flip-not-found"></div>'), { code: "DRIVE_SIN_ACCESO" });
});

test("Prensa puede importar una selección, conserva metadata y los reintentos no duplican archivos", async t => {
  const realFetch = global.fetch;
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#36a" } }).png().toBuffer();
  const mib = 1024 * 1024;
  const bloque = Buffer.alloc(8 * mib);
  bloque.write("ftypisom", 4);
  let bytesVideo = 500 * mib;
  async function* flujoVideo() {
    for (let restantes = bytesVideo; restantes > 0; restantes -= bloque.length) {
      yield bloque.subarray(0, Math.min(bloque.length, restantes));
    }
  }
  const lecturas = [];
  let permisoConcedido = false;
  t.mock.method(global, "fetch", async destino => {
    lecturas.push(destino);
    if (destino.pathname === "/embeddedfolderview") {
      switch (destino.searchParams.get("id")) {
        case "carpeta123456":
          assert.equal(destino.searchParams.get("resourcekey"), "clave-carpeta");
          return new Response(`<div class="flip-entries"><a href="/drive/folders/secundaria001?resourcekey=clave-finales">
            <div class="flip-entry-title">Finales</div></a><a href="/drive/folders/restringida01">Prensa</a>
            <a href="/drive/folders/secundaria001">Finales repetida</a></div>`);
        case "secundaria001":
          assert.equal(destino.searchParams.get("resourcekey"), "clave-finales");
          return new Response(`<a href="/drive/u/1/folders/jueves0000001"><div class="flip-entry-title">Jueves &amp; viernes</div></a>
            <a href="/drive/folders/carpeta123456">Volver</a>`);
        case "restringida01": return permisoConcedido ? new Response('<div class="flip-entries"></div>') : new Response(null, { status: 403 });
        case "jueves0000001": return new Response(html);
        default: assert.fail("ID de carpeta inesperado");
      }
    }
    assert.equal(destino.hostname, "drive.usercontent.google.com");
    if (destino.searchParams.get("id") === "foto0000001") {
      assert.equal(destino.searchParams.get("resourcekey"), "clave-foto");
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    return new Response(flujoVideo(), { headers: { "content-type": "video/mp4" } });
  });
  const partes = [], imagenes = [];
  let abortos = 0;
  // El mock de node:test conservaría los cuerpos de todas las partes hasta finalizar.
  const enviarS3 = s3.send;
  t.after(() => { s3.send = enviarS3; });
  s3.send = async comando => {
    const args = comando.input;
    switch (comando.constructor.name) {
      case "PutObjectCommand": imagenes.push([args.Key, args.ContentType]); return {};
      case "CreateMultipartUploadCommand": return { UploadId: "upload-test" };
      case "UploadPartCommand": partes.push(args.ContentLength); return { ETag: "e" + args.PartNumber };
      case "CompleteMultipartUploadCommand": assert.equal(args.MultipartUpload.Parts.length, 63); return {};
      case "AbortMultipartUploadCommand": abortos++; return {};
      default: throw Error(comando.constructor.name);
    }
  };
  const app = express();
  app.use(express.json(), router);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const token = jwt.sign({ data: JSON.stringify(actor) }, process.env.JWT_SECRET);
  const post = (ruta, body) => realFetch("http://127.0.0.1:" + server.address().port + "/olimpiadas/" + ruta,
    { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const accion of ["listar", "foto", "video"]) assert.equal((await post("3/drive/" + accion, { url })).status, 403);
  assert.equal(lecturas.length, 0);
  const lista = await post("2/drive/listar", { url });
  assert.equal(lista.status, 200);
  const indice = await lista.json();
  assert.deepEqual(indice.archivos.map(v => v.tipo), ["foto", "video"]);
  for (const archivo of indice.archivos) assert.deepEqual(archivo.ruta_carpetas, ["Finales", "Jueves & viernes"]);
  assert.deepEqual(indice.carpetas_sin_acceso, [["Prensa"]]);
  assert.equal((await post("2/drive/foto", { url, archivoId: "no-elegible" })).status, 400);
  assert.equal(lecturas.length, 4);
  const datosFoto = { url, archivoId: "foto0000001", carga_id: randomUUID(), epigrafe: "Final" };
  for (let i = 0; i < 2; i++) assert.equal((await post("2/drive/foto", datosFoto)).status, 201);
  assert.deepEqual(imagenes.map(i => i[1]), ["image/webp", "image/webp"]);
  assert.equal(foto.epigrafe, "Final");
  const datosVideo = { url, archivoId: "video000001", carga_id: randomUUID() };
  await t.test("acepta 500 MiB exactos y aborta la transferencia al superar el límite sin Content-Length", async () => {
    for (let i = 0; i < 2; i++) assert.equal((await post("2/drive/video", datosVideo)).status, 201);
    assert.equal(video.titulo, "Resumen");
    assert.equal(video.bytes, 500 * mib);
    assert.deepEqual(partes, [...Array(62).fill(8 * mib), 4 * mib]);
    bytesVideo++;
    const excedido = await post("2/drive/video", { ...datosVideo, carga_id: randomUUID() });
    assert.equal(excedido.status, 413);
    assert.match(await excedido.json(), /máximo de 500/);
    assert.equal(abortos, 1);
  });
  assert.deepEqual(historial, ["FOTO", "VIDEO"]);
  permisoConcedido = true;
  const actualizado = await post("2/drive/listar", { url });
  assert.deepEqual((await actualizado.json()).carpetas_sin_acceso, []);
});
