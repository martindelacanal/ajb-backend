"use strict";

// El rol educativo sólo administra estos dos rubros. No usar coincidencias
// parciales: un rubro como "Seguros para educación" no concede permisos.
const RUBROS_EDUCATIVOS = Object.freeze(["Capacitación", "Convenios educativos"]);
function esRubroEducativo(nombre) {
  const clave = String(nombre || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  return ["capacitacion", "convenios educativos"].includes(clave);
}
function puedeGestionarEducacion(cabecera, beneficio) {
  return cabecera?.rol === "educacion" && esRubroEducativo(beneficio?.rubro_nombre);
}
const CONDICION_BENEFICIO_EDUCATIVO = "b.rubro_id IN (SELECT er.id FROM beneficio_rubro er WHERE er.nombre COLLATE utf8mb4_0900_ai_ci IN ('Capacitación', 'Convenios educativos'))";

module.exports = { RUBROS_EDUCATIVOS, esRubroEducativo, puedeGestionarEducacion, CONDICION_BENEFICIO_EDUCATIVO };
