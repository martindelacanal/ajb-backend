"use strict";

const DOCUMENTO_SIGNIN_PATTERN = /^\d{1,10}$/;
const PASSWORD_SIGNIN_MAX_LENGTH = 128;

function normalizarCredencialesSignin(body = {}) {
  const documento = String(body?.documento ?? "").trim();
  const password = typeof body?.password === "string" ? body.password : "";
  const recordar = body?.recordar === true || body?.recordar === 1 || body?.recordar === "true";
  const validas = DOCUMENTO_SIGNIN_PATTERN.test(documento)
    && password.length >= 1
    && password.length <= PASSWORD_SIGNIN_MAX_LENGTH;

  return { documento, password, recordar, validas };
}

module.exports = {
  DOCUMENTO_SIGNIN_PATTERN,
  PASSWORD_SIGNIN_MAX_LENGTH,
  normalizarCredencialesSignin,
};
