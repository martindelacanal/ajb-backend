"use strict";

// Primer segmento de las rutas de Angular y de los recursos del sitio.
const RUTAS_RESERVADAS = new Set([
  "afiliate", "api", "assets", "barras", "beneficios", "beneficios-admin", "cambiar-clave",
  "cambios-familiares", "configuracion-login", "configuracion-usuario", "convenios-hoteleros",
  "coseguro-medico", "credencial-digital", "departamental", "departamentales", "familiares-acompaniantes",
  "gremial", "historial-departamental", "historial-usuario", "home", "inicio", "kits-admin", "login",
  "media", "mi-predio", "mis-gestiones", "noticias", "noticias-admin", "notificaciones", "olimpiadas",
  "olimpiadas-admin", "olimpiadas-colaboradores", "olimpiadas-publicas", "olimpiadas-veedores",
  "portada", "predios", "reservas", "servicios", "solicitud-traslado", "temporada-alta",
  "temporada-baja", "traslados", "traslados-admin", "turismo", "usuarios", "verificacion",
]);
const INDICE_RUTA = "uq_olimpiada_ruta_publica";
const MENSAJE_OCUPADA = "Otra edición ya usa esta ruta.";

function validarRutaPublica(ruta) {
  if (ruta === null || ruta === "") return { value: null };
  if (typeof ruta !== "string" || ruta.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ruta)) {
    return { error: "Usá hasta 80 letras minúsculas, números y guiones simples entre palabras." };
  }
  if (RUTAS_RESERVADAS.has(ruta)) return { error: "Esta ruta ya está reservada por MiAJB." };
  return { value: ruta };
}

function esRutaDuplicada(error) {
  if (error?.code !== "ER_DUP_ENTRY") return false;
  const detalle = error.sqlMessage || error.message || "";
  return detalle.endsWith(`'${INDICE_RUTA}'`) || detalle.endsWith(`.${INDICE_RUTA}'`);
}

module.exports = { validarRutaPublica, esRutaDuplicada, INDICE_RUTA, MENSAJE_OCUPADA };
