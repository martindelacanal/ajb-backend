"use strict";

// El rol siempre debe venir de la cuenta persistida o del alta ya autorizada.
function politicaPassword(usuario) {
  const rol = typeof usuario === "string" ? usuario : usuario?.rol || usuario?.rol_nombre;
  const rolId = typeof usuario === "number" ? usuario : usuario?.rol_id;
  return ["afiliado", "invitado"].includes(rol) || (!rol && [2, 4].includes(Number(rolId))) ? "afiliado" : "personal";
}

const COMUNES = new Set(["password", "password1", "password123", "password1234", "contraseña", "contrasena", "contrasena1", "contrasena123", "qwerty123", "qwerty1234", "admin123", "admin1234", "administrador1", "abc12345", "abcd1234", "abc123456", "bienvenido1", "bienvenido123", "miajb123", "miajb1234"]);

function erroresPassword(password, usuario, documento) {
  if (typeof password !== "string") return ["Ingresá una contraseña válida."];
  const personal = politicaPassword(usuario) === "personal";
  const errores = [];
  if ([...password].length < (personal ? 12 : 8)) errores.push(`Usá al menos ${personal ? 12 : 8} caracteres.`);
  if (Buffer.byteLength(password, "utf8") > 72) errores.push("La contraseña es demasiado larga. Usá una frase más corta.");
  if (personal) {
    if (!/\p{Lu}/u.test(password)) errores.push("Agregá una mayúscula.");
    if (!/\p{Ll}/u.test(password)) errores.push("Agregá una minúscula.");
    if (!/[^\p{L}\p{N}\s]/u.test(password)) errores.push("Agregá un carácter especial, como !, @ o #.");
  } else if (!/\p{L}/u.test(password)) errores.push("Agregá al menos una letra.");
  if (!/[0-9]/.test(password)) errores.push("Agregá al menos un número.");
  const simple = password.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const dni = String(documento ?? usuario?.documento ?? "").replace(/\D/g, "");
  if (COMUNES.has(simple) || /^(.)\1+$/u.test(simple) || (dni.length >= 6 && password.includes(dni))) {
    errores.push("Evitá contraseñas comunes, caracteres repetidos y tu documento.");
  }
  return errores;
}

function validarPassword(password, usuario, documento) {
  const errores = erroresPassword(password, usuario, documento);
  if (errores.length) throw Object.assign(new Error(errores.join(" ")), { statusCode: 400, code: "PASSWORD_POLICY", politicaPassword: politicaPassword(usuario) });
}

module.exports = { politicaPassword, erroresPassword, validarPassword };
