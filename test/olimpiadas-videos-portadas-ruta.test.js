"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");
const sharp = require("sharp");

Object.assign(process.env, { BUCKET_REGION: "us-east-1", BUCKET_NAME: "portadas-test",
  ACCESS_KEY: "test", SECRET_ACCESS_KEY: "test", JWT_SECRET: "portadas-test-only" });

test("la galería genera una portada por video y conserva la miniatura de Drive cuando está disponible", { timeout: 10000 }, async t => {
  const drive = require("../api/services/olimpiadas-drive");
  const { s3 } = require("../api/services/olimpiadas-comun");
  const registrarVideos = require("../api/routes/olimpiadas-videos");
  const edicion = { id: 2, habilitado: "Y", publicada_publico: 1 };
  const existente = { id: 1, olimpiada_id: 2, titulo: "Video sin portada", archivo: "videos/1.mov", bytes: 160 * 1024 * 1024,
    mime: "video/quicktime", estado: "LISTO", poster_archivo: null };
  const filas = [existente];
  const fotosGrabadas = new Map();
  const clip = Buffer.alloc(32);
  clip.write("ftypqt  ", 4);
  const jpg = await sharp({ create: { width: 20, height: 12, channels: 3, background: "#36a" } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 12, height: 20, channels: 3, background: "#623" } }).png().toBuffer();
  const registradas = new Map();
  const esperarPortada = id => {
    const pendiente = Promise.withResolvers();
    registradas.set(id, pendiente.resolve);
    return pendiente.promise;
  };
  const db = { async query(sql, args) {
    if (sql.includes("FROM olimpiada WHERE")) return [[edicion]];
    if (sql.includes("FROM olimpiada_video f")) return [filas.map(fila => ({ ...fila }))];
    if (sql.includes("AND archivo LIKE")) return [filas.filter(fila => fila.archivo.startsWith(args[1].slice(0, -1)))];
    if (sql.includes("SELECT * FROM olimpiada_video WHERE id")) return [filas.filter(fila => fila.id === args[0]).map(fila => ({ ...fila }))];
    if (sql.includes("COUNT(*)") && sql.includes("olimpiada_video")) return [[{ cantidad: filas.length, orden: filas.length }]];
    if (sql.includes("INSERT INTO olimpiada_video")) {
      const fila = { id: filas.length + 1, olimpiada_id: args[0], titulo: args[1], archivo: args[4], mime: args[5], bytes: args[6], estado: "LISTO", poster_archivo: null };
      filas.push(fila);
      return [{ insertId: fila.id }];
    }
    if (sql.includes("UPDATE olimpiada_video SET poster_archivo")) {
      assert.match(sql, /archivo = \?.*estado = 'LISTO' AND eliminado = 0 AND poster_archivo IS NULL/s);
      const fila = filas.find(actual => actual.id === args[1] && actual.archivo === args[2] && !actual.poster_archivo);
      if (!fila) return [{ affectedRows: 0 }];
      fila.poster_archivo = args[0];
      registradas.get(fila.id)?.(args[0]);
      return [{ affectedRows: 1 }];
    }
    throw new Error("Consulta inesperada: " + sql);
  } };
  const mediosS3 = t.mock.method(s3, "send", async comando => {
    const args = comando.input;
    switch (comando.constructor.name) {
      case "CreateMultipartUploadCommand": return { UploadId: "subida-prueba" };
      case "UploadPartCommand": return { ETag: "etiqueta-prueba" };
      case "CompleteMultipartUploadCommand": return {};
      case "PutObjectCommand":
        assert.equal(args.ContentType, "image/webp");
        fotosGrabadas.set(args.Key, await sharp(args.Body).metadata());
        return {};
      default: assert.fail(`Comando de almacenamiento inesperado: ${comando.constructor.name}`);
    }
  });
  const lecturaDrive = t.mock.method(drive, "archivoSeleccionado", async () => ({ nombre: "Drive.mov", mime: "video/quicktime" }));
  t.mock.method(drive, "descargar", async function* () { yield clip; });
  let miniaturaDrive = async () => null;
  const pedirMiniatura = t.mock.method(drive, "descargarMiniatura", () => miniaturaDrive());
  const solicitudes = [];
  const capturas = [];
  const separarCaptura = () => {
    const iniciada = Promise.withResolvers();
    const resultado = Promise.withResolvers();
    solicitudes.push({ iniciada, resultado });
    return { iniciada: iniciada.promise, entregar: () => resultado.resolve({ buffer: jpg, fieldname: "POSTER", mimetype: "image/jpeg" }) };
  };
  const app = express();
  app.use(express.json());
  const { listarVideos } = registrarVideos(app, {
    db, cargarOlimpiada: async () => edicion, enTransaccion: fn => fn(db), historial: async () => {}, idDeRuta: Number,
    leerTexto: (body, campo, base) => body[campo] ?? base[campo] ?? null, leerEntero: () => 0, leerFecha: () => null,
    clasificarMedio: async () => ({ cambios: {} }), consultarPartidos: async () => [],
    verifyTokenMultimedia(req, _res, next) { req.data = { data: JSON.stringify({ id: 42, rol: "admin" }) }; next(); },
    soloGestionMultimedia: (_req, _res, next) => next(),
  }, { clienteS3: s3, bucket: "portadas-test", capturarPortada: async args => {
    capturas.push(args.key);
    const solicitud = solicitudes.shift();
    assert.ok(solicitud, "sólo se decodifican las portadas previstas");
    solicitud.iniciada.resolve(args);
    return solicitud.resultado.promise;
  } });
  const conexion = require.resolve("../api/connection/connection");
  require.cache[conexion] = { id: conexion, filename: conexion, loaded: true, exports: { promise: () => db } };
  const contenido = require.resolve("../api/routes/olimpiadas-contenido");
  require.cache[contenido] = { id: contenido, filename: contenido, loaded: true, exports: { lecturasPublicas: { listarVideos } } };
  app.use(require("../api/routes/olimpiadas-publico"));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/olimpiadas`;
  const ver = async () => {
    const respuesta = await fetch(`${base}/publico/2/videos`, { signal: AbortSignal.timeout(2500) });
    assert.equal(respuesta.status, 200);
    assert.equal(respuesta.headers.get("cache-control"), "no-store");
    return respuesta.json();
  };
  const importar = carga_id => fetch(`${base}/2/drive/video`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ carga_id, archivoId: "drive-id" }), signal: AbortSignal.timeout(2500) });

  await t.test("las lecturas públicas informan el trabajo pendiente y comparten una única captura", async () => {
    const captura = separarCaptura();
    const persistida = esperarPortada(1);
    const pendientes = await Promise.all([ver(), ver()]);
    for (const [video] of pendientes) {
      assert.equal(video.poster_url, null);
      assert.equal(video.poster_en_proceso, true);
    }
    const { key, bytes, mime } = await captura.iniciada;
    assert.deepEqual([key, bytes, mime], [existente.archivo, existente.bytes, existente.mime]);
    assert.deepEqual(capturas, [existente.archivo]);
    assert.equal(mediosS3.mock.callCount(), 0, "el listado devuelve metadatos sin esperar ni transferir el video");
    captura.entregar();
    const portada = await persistida;
    const [video] = await ver();
    assert.equal(video.poster_en_proceso, undefined);
    assert.ok(new URL(video.poster_url).pathname.endsWith(portada));
    assert.deepEqual([fotosGrabadas.get(portada).width, fotosGrabadas.get(portada).height], [20, 12]);
  });

  await t.test("una importación sin miniatura arranca su captura y un reintento sólo devuelve el video previo", async () => {
    const captura = separarCaptura();
    const persistida = esperarPortada(2);
    const carga = randomUUID();
    const primera = await importar(carga);
    assert.equal(primera.status, 201);
    assert.equal((await primera.json()).id, 2);
    const segunda = await importar(carga);
    assert.equal(segunda.status, 201);
    assert.equal((await segunda.json()).id, 2);
    assert.equal(lecturaDrive.mock.callCount(), 1);
    assert.equal(pedirMiniatura.mock.callCount(), 1);
    assert.equal((await ver()).find(video => video.id === 2).poster_en_proceso, true);
    assert.equal((await captura.iniciada).key, filas[1].archivo);
    captura.entregar();
    const portada = await persistida;
    const guardado = (await ver()).find(video => video.id === 2);
    assert.ok(new URL(guardado.poster_url).pathname.endsWith(portada));
    assert.deepEqual(capturas, [existente.archivo, filas[1].archivo]);
  });

  await t.test("la miniatura de Drive gana incluso si se consulta la galería durante la importación", async () => {
    const iniciada = Promise.withResolvers();
    const completa = Promise.withResolvers();
    miniaturaDrive = () => { iniciada.resolve(); return completa.promise; };
    const importacion = importar(randomUUID());
    await iniciada.promise;
    const pendiente = (await ver()).find(video => video.id === 3);
    assert.equal(pendiente.poster_en_proceso, true);
    assert.equal(pendiente.poster_url, null);
    completa.resolve({ buffer: png, fieldname: "POSTER", mimetype: "image/png" });
    const respuesta = await importacion;
    assert.equal(respuesta.status, 201);
    assert.equal((await respuesta.json()).id, 3);
    const portada = filas[2].poster_archivo;
    const guardado = (await ver()).find(video => video.id === 3);
    assert.equal(guardado.poster_en_proceso, undefined);
    assert.ok(new URL(guardado.poster_url).pathname.endsWith(portada));
    assert.deepEqual([fotosGrabadas.get(portada).width, fotosGrabadas.get(portada).height], [12, 20]);
    assert.equal(capturas.length, 2);
  });
});
