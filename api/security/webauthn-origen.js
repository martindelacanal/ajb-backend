"use strict";

const {
  normalizarOrigen,
  obtenerOrigenesPermitidos,
} = require("./http-config");

class ErrorOrigenWebAuthn extends Error {
  constructor(message = "Origen no permitido") {
    super(message);
    this.name = "ErrorOrigenWebAuthn";
    this.statusCode = 403;
  }
}

function esOrigenSeguro(url) {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function resolverContextoWebAuthn(req, origenesPermitidos = obtenerOrigenesPermitidos()) {
  const origen = normalizarOrigen(req.headers?.origin);
  if (!origen || !origenesPermitidos.has(origen)) {
    throw new ErrorOrigenWebAuthn();
  }

  const url = new URL(origen);
  if (!esOrigenSeguro(url)) {
    throw new ErrorOrigenWebAuthn("WebAuthn requiere un origen seguro");
  }

  return {
    origen,
    rpID: url.hostname.toLowerCase(),
  };
}

module.exports = {
  ErrorOrigenWebAuthn,
  esOrigenSeguro,
  resolverContextoWebAuthn,
};
