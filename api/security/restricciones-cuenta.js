"use strict";

const MODULOS = Object.freeze(["turismo", "coseguro", "traslados", "beneficios", "olimpiadas"]);
// Turismo subsidiado y reintegros médicos comprometen fondos institucionales.
const MODULOS_ECONOMICOS = Object.freeze(["turismo", "coseguro"]);
const MENSAJE_DEUDA = "Tenés una deuda pendiente con la institución. Contactá a tu departamental para regularizar tu situación y solicitar la habilitación de tus gestiones.";

class ErrorRestriccionCuenta extends Error {
  constructor(mensaje, code, extra = {}, statusCode = 403) {
    super(mensaje); this.statusCode = statusCode; this.code = code; this.extra = extra;
  }
}

function obtenerBloqueo(usuario) {
  if (!["total", "modulos"].includes(usuario?.bloqueo_tipo)) return null;
  let modulos = usuario.bloqueo_modulos;
  if (typeof modulos === "string") {
    try { modulos = JSON.parse(modulos); } catch (_) { modulos = []; }
  }
  return { tipo: usuario.bloqueo_tipo,
    modulos: usuario.bloqueo_tipo === "total" ? [...MODULOS] : (Array.isArray(modulos) ? modulos.filter((m) => MODULOS.includes(m)) : []),
    mensaje: usuario.bloqueo_mensaje || MENSAJE_DEUDA };
}

function datosPublicosAcceso(usuario) {
  const { bloqueo_tipo, bloqueo_modulos, bloqueo_mensaje, ...datos } = usuario;
  return { ...datos, bloqueo: obtenerBloqueo(usuario), requiere_cambio_clave: Number(usuario.requiere_cambio_clave) === 1 };
}

function exigirAccesoCuenta(usuario) {
  const bloqueo = usuario.bloqueo || obtenerBloqueo(usuario);
  if (bloqueo?.tipo === "total") throw new ErrorRestriccionCuenta(bloqueo.mensaje, "ACCOUNT_BLOCKED", { bloqueo });
}

// Se aplica también cuando personal habilitado carga una nueva gestión para
// otra persona. No confundir este error con el bloqueo de la sesión del actor.
function exigirAltaParaUsuario(usuario, modulo) {
  const bloqueo = usuario.bloqueo || obtenerBloqueo(usuario);
  if (bloqueo && (bloqueo.tipo === "total" || bloqueo.modulos.includes(modulo))) {
    const error = new ErrorRestriccionCuenta(bloqueo.mensaje, "BENEFICIARY_BLOCKED", { bloqueo, modulo, usuarioId: usuario.id });
    error.codigo = error.code;
    throw error;
  }
}

function normalizarRuta(req) {
  return String(req.path || req.url || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
}

function moduloDeRuta(req) {
  const ruta = normalizarRuta(req);
  if (/^\/(?:admin\/|gestion\/)?(?:turismo(?:-gestion)?|reserva|reservas|servicios|sorteos|convenios-hoteleros|bloques|temporada|temporadas)(?:\/|$)/.test(ruta)
    || /^\/(?:descuentos\/admin|flujo-descuento-escalonado|valores-predeterminados-temporada)(?:\/|$)/.test(ruta)) return "turismo";
  for (const modulo of MODULOS.filter((m) => m !== "turismo")) {
    if (ruta === `/${modulo}` || ruta.startsWith(`/${modulo}/`) || ruta.startsWith(`/${modulo}-`)) return modulo;
  }
  return null;
}

function exigirOperacionCuenta(usuario, req) {
  exigirAccesoCuenta(usuario);
  const ruta = normalizarRuta(req);
  const metodo = String(req.method || "GET").toUpperCase();
  if (usuario.requiere_cambio_clave && !((metodo === "GET" && ruta === "/sesion/permisos")
    || (metodo === "POST" && ruta === "/auth/password/cambiar-obligatoria"))) {
    throw new ErrorRestriccionCuenta("Para continuar, elegí una nueva contraseña.", "PASSWORD_CHANGE_REQUIRED");
  }
  // La consulta sigue habilitada: el bloqueo se aplica a gestiones operativas.
  if (["GET", "HEAD", "OPTIONS"].includes(metodo)) return;
  if (metodo === "POST" && (/^\/reserva\/(?:recursos|tarifa\/fechas|adicionales)$/.test(ruta)
    || /^\/sorteos\/\d+\/cotizacion$/.test(ruta))) return;
  const modulo = moduloDeRuta(req);
  const bloqueo = usuario.bloqueo || obtenerBloqueo(usuario);
  if (modulo && bloqueo?.modulos.includes(modulo)) {
    throw new ErrorRestriccionCuenta(bloqueo.mensaje, "MODULE_BLOCKED", { bloqueo, modulo });
  }
}

function cuerpoRestriccion(error) { return { mensaje: error.message, code: error.code, ...error.extra }; }

module.exports = { MODULOS, MODULOS_ECONOMICOS, MENSAJE_DEUDA, ErrorRestriccionCuenta,
  obtenerBloqueo, datosPublicosAcceso, exigirAccesoCuenta, exigirAltaParaUsuario, exigirOperacionCuenta, moduloDeRuta, cuerpoRestriccion };
