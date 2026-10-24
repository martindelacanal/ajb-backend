"use strict";

const multer = require("multer");

// Multer deja estos límites en Infinity por compatibilidad. Un campo como
// a[999999999] crea un array disperso que agota recursos al recorrer req.body.
// Los formularios de AJB usan nombres simples y JSON para estructuras complejas.
const LIMITES_CAMPOS = { fieldNestingDepth: 8, fieldArrayIndexLimit: 1000 };

function multipart(options = {}) {
  const limits = typeof options.limits === "function"
    ? (req) => ({ ...LIMITES_CAMPOS, ...options.limits(req) })
    : { ...LIMITES_CAMPOS, ...options.limits };
  return multer({ ...options, limits });
}

// Mantiene memoryStorage, diskStorage y la identidad de MulterError.
module.exports = Object.assign(multipart, multer);
