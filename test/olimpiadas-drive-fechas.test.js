"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const drive = require("../api/services/olimpiadas-drive");

test("las fechas de la vista pública pertenecen al archivo exacto y se interpretan en el día del evento", async t => {
  const origen = { id: "carpeta-compartida", clave: "lectura" };
  const archivo = (id, nombre) => ({ id, nombre, mime: "image/jpeg", carpeta_origen: origen });
  const foto = archivo("una-fotografia", "Vóley.jpg");
  const faltante = archivo("otro-archivo", "Sin fecha.jpg");
  const archivos = new Map([foto, faltante].map(a => [a.id, a]));
  const fila = (a, creacion) => [a.id, [origen.id], a.nombre, a.mime, 0, null, 0, 0, 0, creacion, Date.parse("2026-11-27T18:00:00Z")];
  const filas = [[fila(foto, Date.parse("2026-11-26T01:00:00Z")), fila(faltante, null)]];
  const contenido = JSON.stringify(filas).replace(/"/g, "\\x22");
  const red = t.mock.method(global, "fetch", async url => {
    assert.equal(url.origin + url.pathname, "https://drive.google.com/drive/folders/" + origen.id);
    assert.equal(url.searchParams.get("resourcekey"), "lectura");
    return new Response("window['_DRIVE_ivd'] = '" + contenido + "';");
  });
  assert.deepEqual(await drive.fechasCreacionDrive(archivos), new Map([[foto.id, "2026-11-25"]]));
  assert.equal(red.mock.callCount(), 1);
});

test("permite importar ante una vista sin metadatos o un enlace directo sin fecha de creación pública", async t => {
  const red = t.mock.method(global, "fetch", async () => new Response("HTML actualizado"));
  assert.equal((await drive.fechasCreacionDrive(new Map([["foto", { id: "foto", carpeta_origen: { id: "carpeta-compartida" } }]]))).size, 0);
  assert.equal((await drive.fechasCreacionDrive(new Map([["video", { id: "video" }]]))).size, 0);
  assert.equal(red.mock.callCount(), 1);
});
