"use strict";

// Utilidades compartidas por el servidor local del predio y por el backend central.
// Sin dependencias: sólo módulos de Node.

const crypto = require("node:crypto");

class ErrorPredio extends Error {
  constructor(mensaje, status = 400, extra = {}) {
    super(mensaje);
    this.name = "ErrorPredio";
    this.status = status;
    Object.assign(this, extra);
  }
}

function error(mensaje, status = 400, extra) {
  return new ErrorPredio(mensaje, status, extra);
}

// Argentina no tiene horario de verano: -03:00 fijo.
const OFFSET_AR_MS = -3 * 60 * 60 * 1000;

function ahoraAR(fecha = new Date()) {
  return new Date(fecha.getTime() + OFFSET_AR_MS);
}

function pad(n, l = 2) {
  return String(n).padStart(l, "0");
}

// 'YYYY-MM-DD HH:MM:SS' en hora de Argentina.
function fechaHora(fecha = new Date()) {
  const a = ahoraAR(fecha);
  return `${a.getUTCFullYear()}-${pad(a.getUTCMonth() + 1)}-${pad(a.getUTCDate())} ${pad(a.getUTCHours())}:${pad(a.getUTCMinutes())}:${pad(a.getUTCSeconds())}`;
}

function hoy(fecha = new Date()) {
  return fechaHora(fecha).slice(0, 10);
}

function sumarDias(fechaIso, dias) {
  const [y, m, d] = String(fechaIso).slice(0, 10).split("-").map(Number);
  const f = new Date(Date.UTC(y, m - 1, d + dias));
  return `${f.getUTCFullYear()}-${pad(f.getUTCMonth() + 1)}-${pad(f.getUTCDate())}`;
}

function esFechaIso(valor) {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [y, m, d] = valor.split("-").map(Number);
  const f = new Date(Date.UTC(y, m - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

function redondear(valor, decimales = 2) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimales;
  return Math.round((n + Number.EPSILON) * f) / f;
}

function numero(valor, { min = -Infinity, max = Infinity, decimales = 2, campo = "El valor", requerido = true } = {}) {
  if (valor === null || valor === undefined || valor === "") {
    if (!requerido) return null;
    throw error(`${campo} es obligatorio`);
  }
  const n = typeof valor === "number" ? valor : Number(String(valor).replace(",", "."));
  if (!Number.isFinite(n)) throw error(`${campo} tiene que ser un número`);
  if (n < min) throw error(`${campo} no puede ser menor que ${min}`);
  if (n > max) throw error(`${campo} no puede ser mayor que ${max}`);
  return redondear(n, decimales);
}

function entero(valor, opciones = {}) {
  const n = numero(valor, { ...opciones, decimales: 0 });
  return n === null ? null : Math.trunc(n);
}

function id(valor, campo = "El identificador", requerido = true) {
  if ((valor === null || valor === undefined || valor === "") && !requerido) return null;
  const n = Number(valor);
  if (!Number.isSafeInteger(n) || n <= 0) throw error(`${campo} no es válido`);
  return n;
}

function texto(valor, { max = 255, min = 0, campo = "El texto", requerido = false } = {}) {
  const t = valor === null || valor === undefined ? "" : String(valor).replace(/\s+/g, " ").trim();
  if (!t) {
    if (requerido) throw error(`${campo} es obligatorio`);
    return null;
  }
  if (t.length < min) throw error(`${campo} tiene que tener al menos ${min} caracteres`);
  if (t.length > max) throw error(`${campo} no puede superar los ${max} caracteres`);
  return t;
}

function textoLargo(valor, { max = 4000, campo = "El texto" } = {}) {
  const t = valor === null || valor === undefined ? "" : String(valor).trim();
  if (!t) return null;
  if (t.length > max) throw error(`${campo} no puede superar los ${max} caracteres`);
  return t;
}

function bool(valor) {
  return valor === true || valor === 1 || valor === "1" || valor === "true" || valor === "S" || valor === "si" ? 1 : 0;
}

function fecha(valor, { campo = "La fecha", requerido = false } = {}) {
  if (valor === null || valor === undefined || valor === "") {
    if (requerido) throw error(`${campo} es obligatoria`);
    return null;
  }
  const v = String(valor).slice(0, 10);
  if (!esFechaIso(v)) throw error(`${campo} no es válida`);
  return v;
}

function opcion(valor, opciones, campo = "La opción") {
  const v = String(valor ?? "").trim().toUpperCase();
  if (!opciones.includes(v)) throw error(`${campo} no es válida`);
  return v;
}

function normalizarBusqueda(valor) {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function cuitValido(cuit) {
  const limpio = String(cuit || "").replace(/\D/g, "");
  if (limpio.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(limpio[i]) * pesos[i];
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === Number(limpio[10]);
}

function formatoCuit(cuit) {
  const l = String(cuit || "").replace(/\D/g, "");
  if (l.length !== 11) return l || null;
  return `${l.slice(0, 2)}-${l.slice(2, 10)}-${l.slice(10)}`;
}

function sha256(valor) {
  return crypto.createHash("sha256").update(String(valor)).digest("hex");
}

function tokenAleatorio(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function uuid() {
  return crypto.randomUUID();
}

// Contraseñas de los usuarios del predio: scrypt con sal (sin dependencias).
function hashPassword(password) {
  const sal = crypto.randomBytes(16);
  const clave = crypto.scryptSync(String(password), sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${sal.toString("base64")}$${clave.toString("base64")}`;
}

function verificarPassword(password, almacenado) {
  try {
    const [tipo, n, salB64, claveB64] = String(almacenado || "").split("$");
    if (tipo !== "scrypt") return false;
    const esperado = Buffer.from(claveB64, "base64");
    const calculado = crypto.scryptSync(String(password), Buffer.from(salB64, "base64"), esperado.length, {
      N: Number(n), r: 8, p: 1,
    });
    return crypto.timingSafeEqual(esperado, calculado);
  } catch (_e) {
    return false;
  }
}

function igualesSeguros(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function pesos(valor) {
  const n = redondear(valor, 2);
  const [entero, dec] = Math.abs(n).toFixed(2).split(".");
  const miles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}$ ${miles},${dec}`;
}

module.exports = {
  ErrorPredio,
  error,
  fechaHora,
  hoy,
  sumarDias,
  esFechaIso,
  redondear,
  numero,
  entero,
  id,
  texto,
  textoLargo,
  bool,
  fecha,
  opcion,
  normalizarBusqueda,
  cuitValido,
  formatoCuit,
  sha256,
  tokenAleatorio,
  uuid,
  hashPassword,
  verificarPassword,
  igualesSeguros,
  pesos,
};
