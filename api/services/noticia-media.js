const crypto = require("crypto");
const sharp = require("sharp");

const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";
const MAX_TOTAL_UPLOAD_BYTES = 35 * 1024 * 1024;
const MAX_INPUT_PIXELS = 25_000_000;
const MAX_OUTPUT_WIDTH = 1920;
const RESPONSIVE_WIDTHS = Object.freeze([320, 640, 960, 1440, 1920]);

const FORMATOS = Object.freeze({
  "image/jpeg": Object.freeze({ extension: "jpg", sharpFormat: "jpeg" }),
  "image/png": Object.freeze({ extension: "png", sharpFormat: "png" }),
  "image/webp": Object.freeze({ extension: "webp", sharpFormat: "webp" }),
});

function crearErrorMedia(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizarMime(mime) {
  if (mime === "image/jpg") return "image/jpeg";
  return FORMATOS[mime] ? mime : null;
}

function parsearVariantes(valor) {
  if (!valor) return [];

  let parseado = valor;
  if (Buffer.isBuffer(parseado)) parseado = parseado.toString("utf8");
  if (typeof parseado === "string") {
    try {
      parseado = JSON.parse(parseado);
    } catch (_) {
      return [];
    }
  }
  if (!Array.isArray(parseado)) return [];

  return parseado.slice(0, RESPONSIVE_WIDTHS.length + 1).flatMap((variante) => {
    const archivo = typeof variante?.archivo === "string" ? variante.archivo.trim() : "";
    const ancho = Number(variante?.ancho);
    const alto = Number(variante?.alto);
    const mime = normalizarMime(variante?.mime);
    if (!archivo || !Number.isSafeInteger(ancho) || ancho <= 0 || !Number.isSafeInteger(alto) || alto <= 0 || !mime) {
      return [];
    }
    return [{ archivo, ancho, alto, mime }];
  });
}

function descriptorPersistible(media) {
  if (!media?.archivo) {
    return { archivo: null, ancho: null, alto: null, mime: null, variantes: [] };
  }
  const ancho = Number(media.ancho);
  const alto = Number(media.alto);
  return {
    archivo: media.archivo,
    ancho: Number.isSafeInteger(ancho) && ancho > 0 ? ancho : null,
    alto: Number.isSafeInteger(alto) && alto > 0 ? alto : null,
    mime: normalizarMime(media.mime),
    variantes: parsearVariantes(media.variantes),
  };
}

function clavesDeMedia(media) {
  const descriptor = descriptorPersistible(media);
  return [...new Set([
    descriptor.archivo,
    ...descriptor.variantes.map((variante) => variante.archivo),
  ].filter(Boolean))];
}

function validarLoteImagenes(files, maxBytes = MAX_TOTAL_UPLOAD_BYTES) {
  const totalBytes = (files || []).reduce((total, file) => total + (Buffer.isBuffer(file?.buffer) ? file.buffer.length : 0), 0);
  if (totalBytes > maxBytes) {
    throw crearErrorMedia(`Las imágenes superan el límite total de ${Math.floor(maxBytes / 1024 / 1024)} MB`, 413);
  }
  return totalBytes;
}

function aplicarFormato(pipeline, mime) {
  if (mime === "image/jpeg") {
    return pipeline.jpeg({ quality: 84, mozjpeg: true });
  }
  if (mime === "image/png") {
    return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  }
  return pipeline.webp({ quality: 84, effort: 4 });
}

function pipelineDesde(buffer, maxInputPixels) {
  return sharp(buffer, {
    failOn: "error",
    limitInputPixels: maxInputPixels,
    sequentialRead: true,
  }).rotate();
}

async function subirObjetoSeguro(subirObjeto, objeto) {
  try {
    await subirObjeto(objeto);
  } catch (cause) {
    const error = crearErrorMedia("No se pudo almacenar la imagen", 502);
    error.cause = cause;
    throw error;
  }
}

function codificarSegmentos(key) {
  return String(key).split("/").map((segmento) => encodeURIComponent(segmento)).join("/");
}

function normalizarBasePublica(base) {
  const valor = typeof base === "string" ? base.trim().replace(/\/+$/, "") : "";
  if (!valor) return "";
  try {
    const url = new URL(valor);
    return url.protocol === "https:" || url.protocol === "http:" ? valor : "";
  } catch (_) {
    return "";
  }
}

function crearServicioNoticiaMedia({
  subirObjeto,
  eliminarObjeto = async () => {},
  firmarObjeto,
  publicBaseUrl = "",
  crearId = () => `${Date.now()}_${crypto.randomBytes(8).toString("hex")}`,
  maxInputPixels = MAX_INPUT_PIXELS,
  logger = console,
} = {}) {
  const basePublica = normalizarBasePublica(publicBaseUrl);

  async function resolverClave(key) {
    if (!key) return null;
    if (basePublica) return `${basePublica}/${codificarSegmentos(key)}`;
    if (typeof firmarObjeto !== "function") return null;
    return firmarObjeto(key);
  }

  async function eliminar(media) {
    const errores = [];
    for (const key of clavesDeMedia(media)) {
      try {
        await eliminarObjeto(key);
      } catch (error) {
        errores.push({ key, error });
      }
    }
    if (errores.length > 0) {
      const error = new Error(`No se pudieron eliminar ${errores.length} objetos de media`);
      error.causas = errores;
      throw error;
    }
  }

  async function limpiarKeysParciales(keys) {
    for (const key of [...new Set(keys)].reverse()) {
      try {
        await eliminarObjeto(key);
      } catch (error) {
        logger.error("No se pudo limpiar un objeto parcial de una noticia:", key, error);
      }
    }
  }

  async function procesarYSubir(file, carpeta = "portadas") {
    if (typeof subirObjeto !== "function") throw new Error("Falta configurar subirObjeto");
    const mime = normalizarMime(file?.mimetype);
    if (!mime || !Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) {
      throw crearErrorMedia("La imagen no tiene un formato permitido");
    }
    if (!/^[a-z0-9_-]+$/i.test(carpeta)) throw new Error("Carpeta de media inválida");

    let metadata;
    try {
      metadata = await sharp(file.buffer, {
        failOn: "error",
        limitInputPixels: maxInputPixels,
        sequentialRead: true,
      }).metadata();
    } catch (error) {
      throw crearErrorMedia("La imagen está dañada o excede el límite de píxeles");
    }
    if ((metadata.pages || 1) !== 1) throw crearErrorMedia("No se admiten imágenes animadas o multipágina");
    if (FORMATOS[mime].sharpFormat !== metadata.format) {
      throw crearErrorMedia("El contenido de la imagen no coincide con su formato declarado");
    }

    const formato = FORMATOS[mime];
    const baseKey = `noticias/${carpeta}/noticia_${crearId()}`;
    const archivo = `${baseKey}/original.${formato.extension}`;
    const subidas = [];

    try {
      let salidaFallback = await aplicarFormato(
        pipelineDesde(file.buffer, maxInputPixels).resize({
          width: MAX_OUTPUT_WIDTH,
          height: MAX_OUTPUT_WIDTH,
          withoutEnlargement: true,
          fit: "inside",
        }),
        mime
      ).toBuffer({ resolveWithObject: true });

      const ancho = salidaFallback.info.width;
      const alto = salidaFallback.info.height;
      subidas.push(archivo);
      await subirObjetoSeguro(subirObjeto, {
        key: archivo,
        buffer: salidaFallback.data,
        contentType: mime,
        cacheControl: CACHE_CONTROL_IMMUTABLE,
      });
      salidaFallback = null;

      const anchos = [...new Set([
        ...RESPONSIVE_WIDTHS.filter((width) => width < ancho),
        ancho,
      ])].sort((a, b) => a - b);
      const variantes = [];

      for (const width of anchos) {
        if (mime === "image/webp" && width === ancho) {
          variantes.push({ archivo, ancho, alto, mime });
          continue;
        }

        const key = `${baseKey}/w${width}.webp`;
        subidas.push(key);
        let salidaVariante = await pipelineDesde(file.buffer, maxInputPixels)
          .resize({ width, withoutEnlargement: true, fit: "inside" })
          .webp({ quality: 82, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        await subirObjetoSeguro(subirObjeto, {
          key,
          buffer: salidaVariante.data,
          contentType: "image/webp",
          cacheControl: CACHE_CONTROL_IMMUTABLE,
        });
        variantes.push({
          archivo: key,
          ancho: salidaVariante.info.width,
          alto: salidaVariante.info.height,
          mime: "image/webp",
        });
        salidaVariante = null;
      }

      return { archivo, ancho, alto, mime, variantes };
    } catch (error) {
      await limpiarKeysParciales(subidas);
      if (error.statusCode) throw error;
      throw crearErrorMedia("No se pudo procesar la imagen", 422);
    }
  }

  async function resolver(media) {
    const descriptor = descriptorPersistible(media);
    let url = null;
    try {
      url = await resolverClave(descriptor.archivo);
    } catch (error) {
      logger.error("No se pudo resolver la URL principal de una noticia:", error);
    }

    const variantes = [];
    for (const variante of descriptor.variantes) {
      try {
        const varianteUrl = await resolverClave(variante.archivo);
        if (varianteUrl) {
          variantes.push({
            url: varianteUrl,
            ancho: variante.ancho,
            alto: variante.alto,
            mime: variante.mime,
          });
        }
      } catch (error) {
        logger.error("No se pudo resolver una variante de una noticia:", error);
      }
    }
    return { url, variantes };
  }

  return Object.freeze({ procesarYSubir, eliminar, resolver, resolverClave });
}

module.exports = {
  CACHE_CONTROL_IMMUTABLE,
  MAX_TOTAL_UPLOAD_BYTES,
  MAX_INPUT_PIXELS,
  MAX_OUTPUT_WIDTH,
  RESPONSIVE_WIDTHS,
  crearServicioNoticiaMedia,
  descriptorPersistible,
  clavesDeMedia,
  normalizarBasePublica,
  parsearVariantes,
  validarLoteImagenes,
};
