"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const drive = require("../api/services/olimpiadas-drive");

test("un enlace de foto lee únicamente las cabeceras y permite importar ese mismo archivo", async t => {
  const id = "archivo-foto-individual";
  const url = "https://drive.google.com/file/d/" + id + "/view?usp=sharing&resourcekey=clave-foto";
  const red = t.mock.method(global, "fetch", async (destino, opciones) => {
    assert.equal(destino.origin + destino.pathname, "https://drive.usercontent.google.com/download");
    assert.equal(destino.searchParams.get("id"), id);
    assert.equal(destino.searchParams.get("resourcekey"), "clave-foto");
    assert.equal(destino.searchParams.has("usp"), false);
    if (opciones.method === "HEAD") {
      assert.equal(opciones.headers.Range, "bytes=0-0");
      return new Response(null, { status: 206, headers: {
        "content-type": "image/jpeg",
        "content-disposition": "attachment; filename=\"Voley.jpg\"; filename*=UTF-8''V%C3%B3ley%20final.jpg",
      } });
    }
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  });
  const { archivos, carpetas_sin_acceso } = await drive.listarCarpeta(url);
  assert.deepEqual([...archivos.keys()], [id]);
  assert.deepEqual(carpetas_sin_acceso, []);
  const foto = await drive.archivoSeleccionado({ url, archivoId: id }, "foto");
  assert.deepEqual(foto.ruta_carpetas, []);
  assert.equal(foto.nombre, "Vóley final.jpg");
  assert.equal(foto.vista_url, "https://drive.google.com/file/d/" + id + "/view?resourcekey=clave-foto");
  await assert.rejects(drive.archivoSeleccionado({ url, archivoId: "otra-foto-individual" }, "foto"), { statusCode: 400 });
  await assert.rejects(drive.archivoSeleccionado({ url, archivoId: id }, "video"), { statusCode: 400 });
  assert.equal(red.mock.callCount(), 1);
  assert.deepEqual(await drive.juntar(await drive.descargar(foto, 20)), Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal(red.mock.callCount(), 2);
});

test("un video de MIME genérico usa la extensión y un PDF o una página de permisos informa su motivo", async t => {
  const enlace = id => "https://drive.google.com/file/d/" + id + "/view";
  const respuestas = [
    { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="Final.MP4"' },
    { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Final.jpg"' },
    { "content-type": "text/html; charset=UTF-8" },
  ];
  t.mock.method(global, "fetch", async (_, opciones) => {
    assert.equal(opciones.method, "HEAD");
    return new Response(null, { headers: respuestas.shift() });
  });
  const videoId = "archivo-video-individual";
  const video = await drive.archivoSeleccionado({ url: enlace(videoId), archivoId: videoId }, "video");
  assert.equal(video.nombre, "Final.MP4");
  assert.equal(video.mime, "video/mp4");
  await assert.rejects(drive.listarCarpeta(enlace("documento-individual")), /formato.*compatible/i);
  await assert.rejects(drive.listarCarpeta(enlace("archivo-sin-permiso")), /pueda verlo y descargarlo/i);
});
