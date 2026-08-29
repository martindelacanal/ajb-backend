"use strict";

const jwt = require("jsonwebtoken");

function emitirTokenSesion({
  data,
  recordar = false,
  jwtLib = jwt,
  jwtSecret = process.env.JWT_SECRET,
}) {
  return new Promise((resolve, reject) => {
    const expiresIn = recordar ? "7d" : "8h";
    jwtLib.sign(
      { data: JSON.stringify(data) },
      jwtSecret,
      { expiresIn },
      (error, token) => {
        if (error || !token) {
          reject(error || new Error("No se pudo emitir el token de acceso"));
          return;
        }
        resolve(token);
      }
    );
  });
}

module.exports = {
  emitirTokenSesion,
};
