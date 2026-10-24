"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Jimp, JimpMime, rgbaToInt } = require("../api/services/jimp-hash");
const {
  calcularPhashes,
  sonMismaImagen,
} = require("../api/services/imagen-hash");

async function imagenDePrueba() {
  const imagen = new Jimp({ width: 128, height: 128, color: 0xffffffff });
  for (let y = 8; y < 120; y += 8) {
    for (let x = 8; x < 120; x += 8) {
      const tono = (x * 3 + y * 5) % 256;
      const color = rgbaToInt(tono, 255 - tono, (x + y) % 256, 255);
      imagen.setPixelColor(color, x, y);
      if ((x + y) % 24 === 0) imagen.setPixelColor(0x101010ff, x + 1, y);
    }
  }
  return imagen;
}

test("imagen-hash procesa buffers con la API vigente de Jimp", async () => {
  const imagen = await imagenDePrueba();
  const buffer = await imagen.getBuffer(JimpMime.png);
  const hashes = await calcularPhashes(buffer, "image/png");

  assert.ok(Array.isArray(hashes));
  assert.equal(hashes.length, 8);
  assert.ok(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
});

test("imagen-hash reconoce la misma imagen rotada", async () => {
  const imagen = await imagenDePrueba();
  const original = await imagen.getBuffer(JimpMime.png);
  const rotada = await imagen.clone().rotate({ deg: 90, mode: false }).getBuffer(JimpMime.png);

  const hashesOriginal = await calcularPhashes(original, "image/png");
  const hashesRotados = await calcularPhashes(rotada, "image/png");
  assert.equal(sonMismaImagen(hashesOriginal, hashesRotados), true);
});

// Valores calculados antes de actualizar dependencias: los hashes ya guardados
// en la base deben seguir siendo comparables con las imágenes nuevas.
const HASHES_PNG_HISTORICOS = [
  "000000006593cb2672496c93db2452496493cb2452486493d92652486493c926",
  "000000009324cd92a6c89324c192a4c89364c992e6c89324c992a0c89264c996",
  "000024896c9b5b2472496d935b6472cd6c935b26564d6c99592656496c915932",
  "000059326c91564c49266499524c4926649172cc49626493526c492664990000",
  "000092249364c992a0c89024c892a6489224c912a4c89204c992a4c89224d9b2",
  "0000c92664935248c92664937248cb2664935248d92664935249c92665930000",
  "0000c992926ca4cac9969364e6c8c9929264a4cac9b69324a6dac99293240000",
  "0000c9b29264a4cac9b69324a4cac936b264a448c9b69264a4c8c9b293640000",
];
const HASHES_JPEG_HISTORICOS = [
  "000000006593c92652496c93db2452496493cb2452486493d92672486493c926",
  "000000009324cd92a6c89324c192a4c89364cd92e6c89324c9b2a0c89364c996",
  "000024896c9b5b2672496d93596476cc6c935b26564c6c995926564d6c915932",
  "000059326c91564c49266499524c4926649372cc49626493526c492664990000",
  "000092249364c992a0c89024c892a6489224c912a6c89204c992a4c89224d9b2",
  "0000c92664935248c92664937248cb2664935248d92664935249c92665930000",
  "0000c992932ca4c8c9969364e6c8c9929264a4cac9b69324a6dac99693240000",
  "0000c9b29264a4cac9b6932ca4cac9369264a4c8c9b69264a4c8c9b293640000",
];

test("imagen-hash conserva los hashes históricos y los codecs existentes", async () => {
  const imagen = await imagenDePrueba();
  for (const mime of [JimpMime.png, JimpMime.bmp, JimpMime.tiff, JimpMime.jpeg]) {
    const hashes = await calcularPhashes(await imagen.getBuffer(mime), mime);
    assert.deepEqual(hashes, mime === JimpMime.jpeg ? HASHES_JPEG_HISTORICOS : HASHES_PNG_HISTORICOS, mime);
  }
  const gif = await calcularPhashes(await imagen.getBuffer(JimpMime.gif), JimpMime.gif);
  assert.equal(gif.length, 8);
  assert.equal(sonMismaImagen(gif, HASHES_PNG_HISTORICOS), true);
});

test("imagen-hash falla de forma cerrada para contenido corrupto", async () => {
  assert.equal(await calcularPhashes(Buffer.from("no es una imagen"), "image/png"), null);
  assert.equal(await calcularPhashes(Buffer.from("pdf"), "application/pdf"), null);
});
