"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Jimp, JimpMime, rgbaToInt } = require("jimp");
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

test("imagen-hash falla de forma cerrada para contenido corrupto", async () => {
  assert.equal(await calcularPhashes(Buffer.from("no es una imagen"), "image/png"), null);
  assert.equal(await calcularPhashes(Buffer.from("pdf"), "application/pdf"), null);
});
