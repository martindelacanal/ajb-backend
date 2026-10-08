"use strict";

/**
 * Portada pública (sin sesión): condiciones SQL y mapeos de salida.
 *
 * Todo lo que sale por /api/publico/* pasa por estas funciones, que arman el objeto
 * campo por campo (lista blanca): aunque la fila de la base traiga razon_social,
 * dni_titulares, convenios, correos o precios, nunca llegan al visitante.
 */

const { textoPlanoDesdeHtml } = require("./correo/plantilla");

const MAX_IMAGENES_POR_ITEM = 6;
const MAX_DETALLE_TEXTO = 700;
const MAX_BUSQUEDA = 200;
const MAX_BENEFICIOS_PUBLICOS = 200;
const ESTADO_BENEFICIO_APROBADO = 3;
const TIPOS_SERVICIO_RESERVABLES = Object.freeze(["ALOJAMIENTO_RECURSO", "CUPO_NUMERADO"]);
// Los visitantes ven sólo lo que está publicado para TODAS las departamentales.
const CABECERA_PUBLICA = Object.freeze({ rol: "publico" });

// Igual que CONDICION_PUBLICABLE de beneficios.js pero SIN el filtro por departamental:
// la portada muestra todo lo vigente y aclara a quiénes alcanza cada beneficio.
const CONDICION_BENEFICIO_PUBLICO = `b.eliminado = 0 AND b.estado_id = ${ESTADO_BENEFICIO_APROBADO} AND b.habilitado = 1
  AND (b.fecha_vigencia_desde IS NULL OR b.fecha_vigencia_desde <= CURDATE())
  AND (b.fecha_vigencia_hasta IS NULL OR b.fecha_vigencia_hasta >= CURDATE())`;

// Tipos de viaje con descuento que el afiliado puede elegir al reservar.
const CONDICION_VIAJE_PUBLICO = `dr.tipo = 'TIPO_VIAJE' AND dr.habilitado = 1 AND dr.oculto = 0 AND dr.eliminado = 0
  AND (dr.vigencia_desde IS NULL OR dr.vigencia_desde <= CURDATE())
  AND (dr.vigencia_hasta IS NULL OR dr.vigencia_hasta >= CURDATE())`;

function esVerdadero(valor) {
  return valor === true || Number(valor) === 1;
}

function numeroONulo(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function textoONulo(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto ? texto : null;
}

function fechaCivilONula(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(valor);
  }
  const texto = String(valor).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}

/** Texto plano del HTML del editor, recortado en el último espacio antes del tope. */
function textoPlanoAcotado(html, maximo = MAX_DETALLE_TEXTO) {
  const texto = textoPlanoDesdeHtml(html)
    .replace(/&#x([0-9a-f]+);/gi, (_todo, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .trim();
  if (!texto) return null;
  if (texto.length <= maximo) return texto;
  const corte = texto.slice(0, maximo - 1);
  const ultimoEspacio = corte.search(/\s\S*$/);
  const base = ultimoEspacio > maximo * 0.6 ? corte.slice(0, ultimoEspacio) : corte;
  return `${base.replace(/[\s.,;:–-]+$/, "")}…`;
}

/** Filtro de búsqueda: texto recortado, null si vino vacío, undefined si es inválido. */
function normalizarBusqueda(valor) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "string") return undefined;
  const texto = valor.trim();
  if (!texto) return null;
  return texto.length > MAX_BUSQUEDA ? undefined : texto;
}

/** Agrupa filas por una clave conservando el orden de llegada. */
function agruparPor(filas, clave) {
  const mapa = new Map();
  for (const fila of filas || []) {
    const id = Number(fila[clave]);
    if (!mapa.has(id)) mapa.set(id, []);
    mapa.get(id).push(fila);
  }
  return mapa;
}

// ── Turismo ────────────────────────────────────────────────────────────────

function mapearServicioPublico(fila, imagenes = []) {
  return {
    id: Number(fila.id),
    nombre: fila.nombre,
    lugar: textoONulo(fila.lugar),
    tipo_codigo: fila.tipo_codigo,
    descripcion: textoONulo(fila.descripcion),
    imagenes: (imagenes || []).filter(Boolean).slice(0, MAX_IMAGENES_POR_ITEM),
  };
}

function mapearConvenioPublico(fila, imagenes = []) {
  return {
    id: Number(fila.id),
    servicio_id: numeroONulo(fila.servicio_id),
    nombre: fila.nombre,
    ciudad: textoONulo(fila.ciudad),
    provincia: textoONulo(fila.provincia),
    descripcion: textoONulo(fila.descripcion),
    imagenes: (imagenes || []).filter(Boolean).slice(0, MAX_IMAGENES_POR_ITEM),
  };
}

function mapearAlojamientoSalud(fila) {
  return { id: Number(fila.id), nombre: fila.nombre, lugar: textoONulo(fila.lugar) };
}

// ── Salud / subsidios ──────────────────────────────────────────────────────

function parsearAdjuntos(valor) {
  if (Array.isArray(valor)) return valor;
  if (typeof valor !== "string" || !valor.trim()) return [];
  try {
    const parseado = JSON.parse(valor);
    return Array.isArray(parseado) ? parseado : [];
  } catch (_error) {
    return [];
  }
}

/** Requisitos (adjuntos) de un tipo de reintegro, sin la key interna. */
function mapearRequisitos(adjuntosConfig) {
  return parsearAdjuntos(adjuntosConfig)
    .filter((adjunto) => adjunto && typeof adjunto === "object" && textoONulo(adjunto.label))
    .map((adjunto) => ({ label: textoONulo(adjunto.label), requerido: esVerdadero(adjunto.requerido) }));
}

function mapearTipoReintegroPublico(fila) {
  const modo = String(fila.modo_cobertura || "").toUpperCase() === "PORCENTAJE" ? "PORCENTAJE" : "MANUAL";
  return {
    id: Number(fila.id),
    nombre: fila.nombre,
    icono: textoONulo(fila.icono),
    modo_cobertura: modo,
    porcentaje_cobertura: modo === "PORCENTAJE" ? numeroONulo(fila.porcentaje_cobertura) : null,
    tope_reintegro: modo === "PORCENTAJE" ? numeroONulo(fila.tope_reintegro) : null,
    es_subsidio: esVerdadero(fila.es_subsidio),
    requisitos: mapearRequisitos(fila.adjuntos_config),
  };
}

function mapearViajePublico(fila) {
  return {
    codigo: fila.codigo,
    nombre: fila.nombre,
    descripcion: textoONulo(fila.descripcion),
    porcentaje_descuento: numeroONulo(fila.porcentaje_descuento) ?? 0,
    requiere_comprobante: esVerdadero(fila.requiere_comprobante),
  };
}

// ── Beneficios ─────────────────────────────────────────────────────────────

/**
 * Beneficio para la portada. `extras` trae lo ya resuelto por la ruta:
 * { imagenUrl, logoUrl, departamentales: string[], sucursales: [{ ...fila, imagen_url }] }.
 */
function mapearBeneficioPublico(fila, extras = {}) {
  const alcanceTodas = esVerdadero(fila.alcance_todas);
  const mostrarMapa = esVerdadero(fila.mostrar_mapa);
  return {
    id: Number(fila.id),
    nombre: fila.nombre,
    rubro_id: Number(fila.rubro_id),
    rubro_nombre: fila.rubro_nombre || null,
    descripcion_corta: textoONulo(fila.descripcion_corta),
    detalle_texto: textoPlanoAcotado(fila.promocion_html),
    imagen_url: extras.imagenUrl || null,
    logo_url: extras.logoUrl || null,
    sitio_web: esVerdadero(fila.sitio_web_visible) ? textoONulo(fila.sitio_web) : null,
    vigencia_hasta: fechaCivilONula(fila.fecha_vigencia_hasta),
    cupo_limitado: fila.cupo_maximo !== null && fila.cupo_maximo !== undefined,
    alcance: alcanceTodas ? "PROVINCIA" : "DEPARTAMENTALES",
    departamentales: alcanceTodas ? [] : [...(extras.departamentales || [])],
    sucursales: mostrarMapa
      ? (extras.sucursales || []).map((sucursal) => ({
        direccion: sucursal.direccion,
        latitud: numeroONulo(sucursal.latitud),
        longitud: numeroONulo(sucursal.longitud),
        etiqueta: textoONulo(sucursal.etiqueta),
        imagen_url: sucursal.imagen_url || null,
      }))
      : [],
  };
}

function mapearRubroPublico(fila) {
  return { id: Number(fila.id), nombre: fila.nombre, cantidad: Number(fila.cantidad || 0) };
}

// ── Departamentales ────────────────────────────────────────────────────────

function mapearDepartamentalPublica(fila) {
  return {
    id: Number(fila.id),
    nombre: fila.nombre,
    direccion: textoONulo(fila.direccion),
    localidad: textoONulo(fila.localidad),
  };
}

module.exports = {
  CABECERA_PUBLICA,
  CONDICION_BENEFICIO_PUBLICO,
  CONDICION_VIAJE_PUBLICO,
  MAX_BENEFICIOS_PUBLICOS,
  MAX_DETALLE_TEXTO,
  MAX_IMAGENES_POR_ITEM,
  TIPOS_SERVICIO_RESERVABLES,
  agruparPor,
  fechaCivilONula,
  mapearAlojamientoSalud,
  mapearBeneficioPublico,
  mapearConvenioPublico,
  mapearDepartamentalPublica,
  mapearRequisitos,
  mapearRubroPublico,
  mapearServicioPublico,
  mapearTipoReintegroPublico,
  mapearViajePublico,
  normalizarBusqueda,
  textoPlanoAcotado,
};
