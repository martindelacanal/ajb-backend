"use strict";

/**
 * Placas (flyers) de ofertas de turismo: validación del formulario del admin,
 * estado calculado y mapeo de salida. Funciones puras salvo procesarImagenPlaca
 * (sharp), para poder testearlas sin base ni S3.
 */

const sharp = require("sharp");
const { normalizarBooleano, normalizarFechaCivil } = require("./turismo-catalogo");

const MAX_TITULO = 140;
const MAX_DESCRIPCION = 300;
const MAX_ENLACE_URL = 500;
const MAX_ENLACE_TEXTO = 60;
const MAX_PLACAS_PUBLICAS = 12;
const MAX_IMAGEN_BYTES = 8 * 1024 * 1024;
const LADO_MAXIMO_IMAGEN = 1600;
const CALIDAD_WEBP = 85;
const MAX_PIXELES_ENTRADA = 40_000_000;
const PREFIJO_S3 = "turismo/placas";
const ZONA_HORARIA = "America/Argentina/Buenos_Aires";

const MIMES_PERMITIDOS = new Set(["image/jpeg", "image/png", "image/webp"]);
const FORMATO_SHARP_POR_MIME = Object.freeze({
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
});

const ESTADOS_PLACA = Object.freeze(["PUBLICADA", "PROGRAMADA", "VENCIDA", "OCULTA"]);

const MENSAJE_ENLACE_INVALIDO =
  "El enlace tiene que ser una dirección web completa (https://…) o una sección del sistema que empiece con / (por ejemplo /turismo)";

function crearErrorPlaca(mensaje, statusCode = 400) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  return error;
}

/** Fecha civil de hoy en Argentina (YYYY-MM-DD), igual que CURDATE() con la sesión en -03:00. */
function fechaHoyArgentina(fecha = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_HORARIA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(fecha);
}

function textoOpcional(valor) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "string") return undefined;
  const texto = valor.trim();
  return texto ? texto : null;
}

/**
 * Normaliza el enlace de una placa. Devuelve:
 *  - null si vino vacío,
 *  - el texto limpio si es http(s)://host… o una ruta interna "/algo" (no "//"),
 *  - undefined si no es válido.
 */
function normalizarEnlaceUrl(valor) {
  const texto = textoOpcional(valor);
  if (texto === null) return null;
  if (texto === undefined || texto.length > MAX_ENLACE_URL) return undefined;
  // Sin espacios, controles ni barras invertidas: "/\evil.com" el navegador lo toma como "//evil.com".
  if (/[\s\\\u0000-\u001f\u007f]/.test(texto)) return undefined;

  if (texto.startsWith("/")) {
    return texto.startsWith("//") ? undefined : texto;
  }

  if (!/^https?:\/\//i.test(texto)) return undefined;
  let url;
  try {
    url = new URL(texto);
  } catch (_error) {
    return undefined;
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    return undefined;
  }
  return texto;
}

function esEnlaceInterno(enlaceUrl) {
  return typeof enlaceUrl === "string" && enlaceUrl.startsWith("/") && !enlaceUrl.startsWith("//");
}

function normalizarFechaPlaca(valor) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "string") return undefined;
  const texto = valor.trim();
  if (!texto) return null;
  return normalizarFechaCivil(texto) || undefined;
}

/** DATE de MySQL como texto YYYY-MM-DD (o Date, si el pool no usa dateStrings). */
function fechaCivilDe(valor) {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : fechaHoyArgentina(valor);
  if (typeof valor !== "string") return null;
  return normalizarFechaCivil(valor.trim().slice(0, 10));
}

function tieneCampo(body, campo) {
  return Object.prototype.hasOwnProperty.call(body, campo);
}

/**
 * Valida los campos del formulario de una placa (multipart: todo llega como texto).
 * Con `actual` (edición), los campos que no vienen en el body conservan su valor;
 * sin `actual` (alta), el título es obligatorio y publicado vale 1 por defecto.
 * Devuelve { datos } o { error } con el mensaje para el usuario.
 */
function validarDatosPlaca(body, actual = null) {
  const entrada = body && typeof body === "object" ? body : {};
  const errores = [];
  const base = actual || {};
  const tomar = (campo) => (actual && !tieneCampo(entrada, campo) ? { conservar: true } : { valor: entrada[campo] });

  // Título
  let titulo = base.titulo ?? null;
  const tituloEntrada = tomar("titulo");
  if (!tituloEntrada.conservar) {
    const texto = textoOpcional(tituloEntrada.valor);
    if (!texto) {
      errores.push("El título es obligatorio");
    } else if (texto.length > MAX_TITULO) {
      errores.push(`El título puede tener hasta ${MAX_TITULO} caracteres`);
    } else {
      titulo = texto;
    }
  }

  // Descripción (texto alternativo)
  let descripcion = base.descripcion ?? null;
  const descripcionEntrada = tomar("descripcion");
  if (!descripcionEntrada.conservar) {
    const texto = textoOpcional(descripcionEntrada.valor);
    if (texto === undefined) errores.push("La descripción no es válida");
    else if (texto && texto.length > MAX_DESCRIPCION) {
      errores.push(`La descripción puede tener hasta ${MAX_DESCRIPCION} caracteres`);
    } else descripcion = texto;
  }

  // Enlace
  let enlaceUrl = base.enlace_url ?? null;
  const enlaceEntrada = tomar("enlace_url");
  if (!enlaceEntrada.conservar) {
    const normalizado = normalizarEnlaceUrl(enlaceEntrada.valor);
    if (normalizado === undefined) errores.push(MENSAJE_ENLACE_INVALIDO);
    else enlaceUrl = normalizado;
  }

  let enlaceTexto = base.enlace_texto ?? null;
  const enlaceTextoEntrada = tomar("enlace_texto");
  if (!enlaceTextoEntrada.conservar) {
    const texto = textoOpcional(enlaceTextoEntrada.valor);
    if (texto === undefined) errores.push("El texto del botón no es válido");
    else if (texto && texto.length > MAX_ENLACE_TEXTO) {
      errores.push(`El texto del botón puede tener hasta ${MAX_ENLACE_TEXTO} caracteres`);
    } else enlaceTexto = texto;
  }

  // Vigencias
  let vigenciaDesde = base.vigencia_desde ?? null;
  const desdeEntrada = tomar("vigencia_desde");
  if (!desdeEntrada.conservar) {
    const fecha = normalizarFechaPlaca(desdeEntrada.valor);
    if (fecha === undefined) errores.push("La fecha «desde» de la vigencia no es válida (AAAA-MM-DD)");
    else vigenciaDesde = fecha;
  }

  let vigenciaHasta = base.vigencia_hasta ?? null;
  const hastaEntrada = tomar("vigencia_hasta");
  if (!hastaEntrada.conservar) {
    const fecha = normalizarFechaPlaca(hastaEntrada.valor);
    if (fecha === undefined) errores.push("La fecha «hasta» de la vigencia no es válida (AAAA-MM-DD)");
    else vigenciaHasta = fecha;
  }

  if (vigenciaDesde && vigenciaHasta && vigenciaHasta < vigenciaDesde) {
    errores.push("La vigencia «hasta» no puede ser anterior a la vigencia «desde»");
  }

  // Publicado
  let publicado = 1;
  if (actual) publicado = Number(base.publicado) === 1 ? 1 : 0;
  const publicadoEntrada = tomar("publicado");
  if (!publicadoEntrada.conservar && publicadoEntrada.valor !== undefined) {
    const valor = normalizarBooleano(publicadoEntrada.valor, actual ? publicado : 1);
    if (valor === undefined) errores.push("El estado de publicación no es válido");
    else publicado = valor;
  }

  if (errores.length > 0) return { error: errores.join(". ") };
  return {
    datos: {
      titulo,
      descripcion,
      enlace_url: enlaceUrl,
      enlace_texto: enlaceTexto,
      vigencia_desde: vigenciaDesde,
      vigencia_hasta: vigenciaHasta,
      publicado,
    },
  };
}

/**
 * Estado visible en el panel del admin:
 * OCULTA si no está publicada; PROGRAMADA si arranca después de hoy;
 * VENCIDA si terminó antes de hoy; si no, PUBLICADA.
 */
function calcularEstadoPlaca(placa, hoy = fechaHoyArgentina()) {
  if (!placa || Number(placa.publicado) !== 1) return "OCULTA";
  const desde = fechaCivilDe(placa.vigencia_desde);
  const hasta = fechaCivilDe(placa.vigencia_hasta);
  if (desde && desde > hoy) return "PROGRAMADA";
  if (hasta && hasta < hoy) return "VENCIDA";
  return "PUBLICADA";
}

function enteroONulo(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

/** Lo que ve cualquier visitante (sin datos de gestión). */
function mapearPlacaPublica(fila, imagenUrl) {
  return {
    id: Number(fila.id),
    titulo: fila.titulo,
    descripcion: fila.descripcion || null,
    imagen_url: imagenUrl || null,
    imagen_ancho: enteroONulo(fila.imagen_ancho),
    imagen_alto: enteroONulo(fila.imagen_alto),
    enlace_url: fila.enlace_url || null,
    enlace_texto: fila.enlace_texto || null,
    vigencia_hasta: fechaCivilDe(fila.vigencia_hasta),
  };
}

/** Lo que ve el admin en /turismo/placas. */
function mapearPlacaAdmin(fila, imagenUrl, hoy = fechaHoyArgentina()) {
  return {
    id: Number(fila.id),
    titulo: fila.titulo,
    descripcion: fila.descripcion || null,
    imagen_url: imagenUrl || null,
    imagen_ancho: enteroONulo(fila.imagen_ancho),
    imagen_alto: enteroONulo(fila.imagen_alto),
    enlace_url: fila.enlace_url || null,
    enlace_texto: fila.enlace_texto || null,
    vigencia_desde: fechaCivilDe(fila.vigencia_desde),
    vigencia_hasta: fechaCivilDe(fila.vigencia_hasta),
    publicado: Number(fila.publicado) === 1,
    orden: Number(fila.orden || 0),
    estado: calcularEstadoPlaca(fila, hoy),
    fecha_modificacion: fila.fecha_modificacion || null,
  };
}

/**
 * Lista de ids para reordenar: array (o JSON) de enteros positivos, sin repetidos.
 * Devuelve el array normalizado o null si no es válido.
 */
function normalizarIdsOrden(valor, maximo = 500) {
  let items = valor;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch (_error) {
      return null;
    }
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > maximo) return null;
  const ids = [];
  for (const item of items) {
    const texto = typeof item === "number" ? String(item) : typeof item === "string" ? item.trim() : "";
    if (!/^\d+$/.test(texto)) return null;
    const id = Number(texto);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    ids.push(id);
  }
  return new Set(ids).size === ids.length ? ids : null;
}

/**
 * Orden final: primero los ids pedidos (en ese orden) y después las placas que no
 * vinieron, respetando su orden actual. `actuales` = filas { id } ya ordenadas.
 */
function combinarOrden(idsPedidos, actuales) {
  const pedidos = new Set(idsPedidos);
  const resto = actuales.map((fila) => Number(fila.id)).filter((id) => !pedidos.has(id));
  return [...idsPedidos, ...resto];
}

/** Coincidencia entre el mimetype declarado y los primeros bytes del archivo. */
function contenidoCoincideConMime(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  switch (file.mimetype) {
    case "image/jpeg":
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/png":
      return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    default:
      return false;
  }
}

/**
 * Normaliza la imagen de una placa: corrige la orientación EXIF, la achica para que
 * entre en 1600×1600 (sin agrandar) y la guarda como WebP. Devuelve
 * { buffer, ancho, alto, contentType }.
 */
async function procesarImagenPlaca(file) {
  if (!file || !MIMES_PERMITIDOS.has(file.mimetype) || !contenidoCoincideConMime(file)) {
    throw crearErrorPlaca("La imagen tiene que ser JPG, PNG o WebP");
  }
  let metadata;
  try {
    metadata = await sharp(file.buffer, { failOn: "error", limitInputPixels: MAX_PIXELES_ENTRADA }).metadata();
  } catch (_error) {
    throw crearErrorPlaca("La imagen está dañada o es demasiado grande");
  }
  if ((metadata.pages || 1) !== 1) throw crearErrorPlaca("No se admiten imágenes animadas");
  if (FORMATO_SHARP_POR_MIME[file.mimetype] !== metadata.format) {
    throw crearErrorPlaca("El contenido de la imagen no coincide con su formato");
  }
  try {
    const { data, info } = await sharp(file.buffer, { failOn: "error", limitInputPixels: MAX_PIXELES_ENTRADA })
      .rotate()
      .resize({ width: LADO_MAXIMO_IMAGEN, height: LADO_MAXIMO_IMAGEN, fit: "inside", withoutEnlargement: true })
      .webp({ quality: CALIDAD_WEBP })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, ancho: info.width, alto: info.height, contentType: "image/webp" };
  } catch (_error) {
    throw crearErrorPlaca("No se pudo procesar la imagen", 422);
  }
}

module.exports = {
  ESTADOS_PLACA,
  LADO_MAXIMO_IMAGEN,
  MAX_DESCRIPCION,
  MAX_ENLACE_TEXTO,
  MAX_ENLACE_URL,
  MAX_IMAGEN_BYTES,
  MAX_PLACAS_PUBLICAS,
  MAX_TITULO,
  MENSAJE_ENLACE_INVALIDO,
  MIMES_PERMITIDOS,
  PREFIJO_S3,
  calcularEstadoPlaca,
  combinarOrden,
  contenidoCoincideConMime,
  crearErrorPlaca,
  esEnlaceInterno,
  fechaHoyArgentina,
  mapearPlacaAdmin,
  mapearPlacaPublica,
  normalizarEnlaceUrl,
  normalizarIdsOrden,
  procesarImagenPlaca,
  validarDatosPlaca,
};
