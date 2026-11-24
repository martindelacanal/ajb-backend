"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

// La firma es real, con credenciales locales ficticias. Los comandos de almacenamiento se interceptan.
Object.assign(process.env, { BUCKET_REGION: "us-east-1", BUCKET_NAME: "videos-test",
  ACCESS_KEY: "test", SECRET_ACCESS_KEY: "test", JWT_SECRET: "test-only" });

test("video de 200 MiB: partes, reintento de cierre y enlaces de lectura y descarga", async t => {
  const bytes = 200 * 1024 * 1024;
  const titulo = 'Final / vóley "2026"';
  let fila, fallarRegistro = false;
  const historial = [];
  const db = { async query(sql, p) {
    if (sql.includes("FROM olimpiada WHERE")) return [[{ id: 1, habilitado: "Y", publicada_publico: 1 }]];
    if (sql.includes("COUNT(*)")) return [[{ cantidad: 0 }]];
    if (sql.includes("MAX(orden)")) return [[{ orden: 0 }]];
    if (sql.includes("INSERT INTO olimpiada_video")) {
      fila = { id: 12, olimpiada_id: p[0], titulo: p[1], archivo: p[4], mime: p[5], bytes: p[6],
        orden: p[7], subida_id: p[8], usuario_id: p[9], partes: "[]", estado: "SUBIENDO", eliminado: 0 };
      return [{ insertId: fila.id }];
    }
    if (sql.includes("FROM olimpiada_video WHERE olimpiada_id")) {
      return [fila.estado === "LISTO" && !fila.eliminado ? [{ ...fila }] : []];
    }
    if (sql.includes("FROM olimpiada_video WHERE id")) return [fila.eliminado ? [] : [{ ...fila }]];
    if (sql.includes("SET partes = ?")) fila.partes = p[0];
    else if (sql.includes("SET estado = 'LISTO'")) {
      if (fallarRegistro) { fallarRegistro = false; throw new Error("Corte simulado antes de guardar"); }
      Object.assign(fila, { estado: "LISTO", partes: null, subida_id: null });
    } else if (sql.includes("SET eliminado = 1")) {
      if (sql.includes("estado = 'SUBIENDO'") && fila.estado !== "SUBIENDO") return [{ affectedRows: 0 }];
      fila.eliminado = 1;
    } else throw new Error("SQL inesperado: " + sql);
    return [{ affectedRows: 1 }];
  } };
  const conexion = require.resolve("../api/connection/connection");
  require.cache[conexion] = { id: conexion, filename: conexion, loaded: true, exports: { promise: () => db } };
  const { s3 } = require("../api/services/olimpiadas-comun");
  const registrarVideos = require("../api/routes/olimpiadas-videos");
  const partesS3 = new Map();
  let objetoCreado = false, controlesHead = 0, bajas = 0, cierresS3 = 0;
  // No registrar los comandos completos: cada UploadPart lleva un búfer de 8 MiB.
  const enviarS3 = s3.send;
  t.after(() => { s3.send = enviarS3; });
  s3.send = async comando => {
    const entrada = comando.input;
    switch (comando.constructor.name) {
      case "CreateMultipartUploadCommand": return { UploadId: "subida-12" };
      case "UploadPartCommand": {
        assert.equal(entrada.ContentLength, entrada.Body.length);
        assert.equal(entrada.ContentLength, 8 * 1024 * 1024);
        const ETag = '"parte-' + entrada.PartNumber + '"';
        partesS3.set(entrada.PartNumber, ETag);
        return { ETag };
      }
      case "CompleteMultipartUploadCommand":
        if (objetoCreado) throw Object.assign(new Error("Subida cerrada"), { name: "NoSuchUpload", $metadata: { httpStatusCode: 404 } });
        assert.deepEqual(entrada.MultipartUpload.Parts, Array.from({ length: 25 }, (_, i) =>
          ({ PartNumber: i + 1, ETag: partesS3.get(i + 1) })));
        objetoCreado = true;
        cierresS3++;
        return {};
      case "HeadObjectCommand":
        assert.ok(objetoCreado);
        controlesHead++;
        return { ContentLength: bytes, ContentType: "video/mp4" };
      case "DeleteObjectCommand": bajas++; return {};
      default: throw new Error("Comando S3 inesperado: " + comando.constructor.name);
    }
  };

  const app = express();
  app.use(express.json(), require("../api/routes/olimpiadas-publico"));
  const pasar = (_req, _res, next) => next();
  registrarVideos(app, {
    db, cargarOlimpiada: async () => ({}), idDeRuta: Number,
    enTransaccion: fn => fn(db), historial: async (_db, _actor, cambio) => historial.push(cambio.tipo_operacion),
    leerTexto: (body, campo) => body[campo] ?? null, leerEntero: () => 0, leerFecha: () => null,
    verifyTokenMultimedia(req, _res, next) { req.data = { data: JSON.stringify({ id: 91, rol: "admin" }) }; next(); },
    soloGestionMultimedia: pasar,
  });
  const servidor = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { servidor.closeAllConnections(); servidor.close(resolve); }));
  const base = "http://127.0.0.1:" + servidor.address().port + "/olimpiadas/";
  const enviar = (ruta, method, body, tipo = "application/json") =>
    fetch(base + ruta, { method, headers: { "Content-Type": tipo }, body });
  const abrir = tamano => enviar("1/videos", "POST", JSON.stringify({ titulo, bytes: tamano, mime: "video/mp4" }));
  const transferir = (numero, datos) => enviar("videos/12/partes/" + numero, "PUT", datos, "application/octet-stream");
  const completar = () => enviar("videos/12/completar", "POST");
  assert.equal((await abrir(bytes + 1)).status, 400);
  const inicio = await abrir(bytes);
  assert.equal(inicio.status, 201);
  const { partes, tamano_parte } = await inicio.json();
  assert.equal(partes, 25);
  const trozo = Buffer.alloc(tamano_parte);
  trozo.write("ftypisom", 4);
  assert.equal((await transferir(26, trozo.subarray(0, 16))).status, 400);
  assert.equal((await transferir(1, trozo.subarray(0, 16))).status, 400);
  assert.equal((await completar()).status, 409);
  assert.equal(partesS3.size, 0);
  for (let n = 1; n <= partes; n++) {
    const respuesta = await transferir(n, trozo);
    assert.equal(respuesta.status, 200);
    assert.equal((await respuesta.json()).recibidas, n);
    if (n === 1) assert.equal((await (await transferir(n, trozo)).json()).recibidas, 1);
  }
  assert.equal(partesS3.size, 25);
  fallarRegistro = true;
  assert.equal((await completar()).status, 500);
  assert.equal((await completar()).status, 200);
  assert.equal((await completar()).status, 200);
  assert.equal(cierresS3, 1);
  assert.ok(controlesHead >= 1);
  assert.deepEqual(historial, ["CREATE"]);

  for (const ruta of ["1/videos", "publico/1/videos"]) {
    const respuesta = await fetch(base + ruta);
    assert.equal(respuesta.status, 200);
    const [video] = await respuesta.json();
    const lectura = new URL(video.url), descarga = new URL(video.descarga_url);
    assert.equal(lectura.pathname, descarga.pathname);
    assert.equal(lectura.searchParams.get("response-content-disposition"), null);
    for (const url of [lectura, descarga]) {
      assert.ok(url.searchParams.has("X-Amz-Signature"));
      assert.ok(!url.searchParams.get("X-Amz-SignedHeaders").split(";").includes("range"));
    }
    const disposicion = descarga.searchParams.get("response-content-disposition");
    assert.match(disposicion, /^attachment;/);
    assert.match(disposicion, /filename="[^"\/\\\r\n]+\.mp4"/);
    const nombre = decodeURIComponent(disposicion.match(/filename\*=UTF-8''([^;]+)/i)[1]);
    assert.match(nombre, /vóley.*\.mp4$/);
    assert.doesNotMatch(nombre, /["/\\\r\n]/);
  }
  const cancelar = await enviar("videos/12?cancelar=1", "DELETE");
  assert.ok(cancelar.status >= 400 && cancelar.status < 500);
  assert.equal(fila.eliminado, 0);
  assert.equal(bajas, 0);
  assert.equal((await enviar("videos/12", "DELETE")).status, 200);
  assert.equal(fila.eliminado, 1);
  assert.equal(bajas, 1);
  assert.deepEqual(historial, ["CREATE", "DELETE"]);
});
