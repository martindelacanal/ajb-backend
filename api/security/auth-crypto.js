"use strict";

const crypto = require("crypto");

function huella(valor, contexto, secret = process.env.JWT_SECRET) {
  if (!secret) throw new Error("Falta JWT_SECRET");
  return crypto.createHmac("sha256", secret).update(`${contexto}\0${valor}`).digest("hex");
}

function secretoAleatorio() { return crypto.randomBytes(32).toString("base64url"); }
function huellaPassword(password, secret) { return huella(password || "", "password-version", secret); }
function igualesSeguros(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

module.exports = { huella, huellaPassword, igualesSeguros, secretoAleatorio };
