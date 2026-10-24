"use strict";

// Conserva los codecs y algoritmos de Jimp 1.6.1 usados por los hashes guardados.
// Cargar solo estos plugins permite usar Zod corregido sin el plugin de impresión,
// cuya API antigua de funciones no es compatible con Zod 4.
const { createJimp } = require("@jimp/core");
const bmp = require("@jimp/js-bmp");
const gif = require("@jimp/js-gif").default;
const jpeg = require("@jimp/js-jpeg").default;
const png = require("@jimp/js-png").default;
const tiff = require("@jimp/js-tiff").default;
const blur = require("@jimp/plugin-blur");
const color = require("@jimp/plugin-color");
const flip = require("@jimp/plugin-flip");
const resize = require("@jimp/plugin-resize");
const rotate = require("@jimp/plugin-rotate");
const { intToRGBA, rgbaToInt } = require("@jimp/utils");

const Jimp = createJimp({
  formats: [bmp.default, bmp.msBmp, gif, jpeg, png, tiff],
  plugins: [blur.methods, color.methods, flip.methods, resize.methods, rotate.methods],
});

module.exports = {
  Jimp,
  ResizeStrategy: resize.ResizeStrategy,
  intToRGBA,
  rgbaToInt,
  JimpMime: { bmp: bmp.default().mime, gif: gif().mime, jpeg: jpeg().mime, png: png().mime, tiff: tiff().mime },
};
