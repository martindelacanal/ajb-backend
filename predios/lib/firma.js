"use strict";

// Firma Ed25519 de los paquetes que manda el sistema general (actualizaciones de código y
// paquetes para pendrive). La notebook sólo acepta lo que verifica con la clave pública que
// trae su instalador: así nadie puede meterle código o cambios con un archivo armado a mano.

const crypto = require("node:crypto");

function firmar(buffer, clavePrivadaPem) {
  return crypto.sign(null, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), crypto.createPrivateKey(clavePrivadaPem)).toString("base64");
}

function verificar(buffer, firmaBase64, clavePublicaPem) {
  if (!firmaBase64 || !clavePublicaPem) return false;
  try {
    return crypto.verify(null, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), crypto.createPublicKey(clavePublicaPem), Buffer.from(String(firmaBase64), "base64"));
  } catch (_e) {
    return false;
  }
}

function generarPar() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privada: privateKey.export({ type: "pkcs8", format: "pem" }),
    publica: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function publicaDe(clavePrivadaPem) {
  return crypto.createPublicKey(crypto.createPrivateKey(clavePrivadaPem)).export({ type: "spki", format: "pem" });
}

module.exports = { firmar, verificar, generarPar, publicaDe };
