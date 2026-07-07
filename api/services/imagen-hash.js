/**
 * Hash perceptual de imágenes para el módulo de coseguro médico.
 *
 * Detecta que dos fotos son "la misma imagen" aunque el archivo sea distinto:
 * rotada (90/180/270°), espejada (horizontal/vertical), recomprimida, redimensionada
 * o con pequeños retoques. Complementa al SHA-256 (que solo detecta archivos idénticos
 * byte a byte) para evitar que un afiliado cargue dos veces el mismo comprobante
 * "disimulado" con una transformación básica.
 *
 * Método: dHash de 256 bits (grilla de 16x16 comparaciones sobre una miniatura en
 * escala de grises levemente desenfocada). Se calculan y GUARDAN los hashes de las
 * 8 orientaciones posibles (grupo dihedral: 4 rotaciones × espejo). Dos imágenes son
 * "la misma" si algún par de orientaciones queda a distancia de Hamming <= umbral:
 * comparar contra las 8 orientaciones hace la detección inmune a rotaciones y espejos
 * sin depender de una canonización inestable.
 */
const Jimp = require("jimp");

const TAMANIO_NORMALIZADO = 128; // miniatura cuadrada de trabajo
const GRILLA = 16; // 16x16 comparaciones -> 256 bits -> 64 caracteres hex
// Dos imágenes se consideran "la misma" si difieren en 20 o menos de los 256 bits.
// Medido con documentos reales: transformaciones exactas dan 0-5 bits; documentos
// distintos (incluso con el mismo formato de papel/tipografía) dan 35+ bits.
const UMBRAL_HAMMING = 20;
// Una imagen casi lisa (fondo blanco con muy poco contenido) no tiene suficiente
// estructura para compararla perceptualmente: dos imágenes distintas pero "casi vacías"
// quedarían a distancia mínima y darían falsos positivos. Medido: imágenes de un solo
// dígito dan 10-15 bits de información; comprobantes reales dan 55+. Por debajo de este
// mínimo NO se genera hash perceptual (la detección exacta por SHA-256 sigue aplicando).
const MINIMO_BITS_INFORMACION = 30;

/** dHash de 256 bits de una imagen Jimp cuadrada; devuelve hex de 64 caracteres */
function dhash256(imagen) {
  const chica = imagen.clone().resize(GRILLA + 1, GRILLA, Jimp.RESIZE_BILINEAR);
  let hash = 0n;
  for (let y = 0; y < GRILLA; y++) {
    for (let x = 0; x < GRILLA; x++) {
      const izquierda = Jimp.intToRGBA(chica.getPixelColor(x, y)).r;
      const derecha = Jimp.intToRGBA(chica.getPixelColor(x + 1, y)).r;
      hash = (hash << 1n) | (izquierda > derecha ? 1n : 0n);
    }
  }
  return hash.toString(16).padStart(64, "0");
}

/**
 * Calcula los 8 hashes perceptuales (una por orientación) de una imagen (Buffer).
 * Devuelve un array de 8 strings hex de 64 caracteres, o null si el buffer no es
 * una imagen procesable (ej: PDF) — en ese caso solo aplica la detección por SHA-256.
 */
async function calcularPhashes(buffer, mime) {
  if (!mime || !mime.startsWith("image/")) return null;
  try {
    const imagen = await Jimp.read(buffer);
    imagen
      .grayscale()
      // Bicúbica + blur: con esta combinación una rotación/espejo exacto da distancia 0
      // y documentos distintos quedan lejos (medido: 35+ bits)
      .resize(TAMANIO_NORMALIZADO, TAMANIO_NORMALIZADO, Jimp.RESIZE_BICUBIC)
      .blur(3);

    const hashes = [];
    for (const espejar of [false, true]) {
      let base = imagen.clone();
      if (espejar) base.flip(true, false);
      for (let giro = 0; giro < 4; giro++) {
        const orientada = giro === 0 ? base : base.clone().rotate(giro * 90, false);
        hashes.push(dhash256(orientada));
      }
    }
    // Imagen sin estructura suficiente -> sin hash perceptual (evita falsos positivos)
    const maxBits = Math.max(...hashes.map((hex) => bitsEnHex(hex)));
    if (maxBits < MINIMO_BITS_INFORMACION) return null;

    // Ordenados: así el JSON guardado es idéntico para la imagen original y cualquier
    // rotación/espejo exacto (permite detectar coincidencias exactas por igualdad en SQL)
    hashes.sort();
    return hashes;
  } catch (error) {
    // Una imagen corrupta o un formato exótico no debe bloquear la carga:
    // simplemente queda sin hash perceptual (el SHA-256 sigue aplicando).
    console.error("No se pudo calcular el hash perceptual:", error.message);
    return null;
  }
}

/** Cantidad de bits en 1 de un hash hex */
function bitsEnHex(hex) {
  let valor = BigInt("0x" + hex);
  let bits = 0;
  while (valor > 0n) {
    bits += Number(valor & 1n);
    valor >>= 1n;
  }
  return bits;
}

/** Distancia de Hamming entre dos hashes hex de 64 caracteres */
function distanciaHamming(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return Number.MAX_SAFE_INTEGER;
  let xor = BigInt("0x" + hexA) ^ BigInt("0x" + hexB);
  let bits = 0;
  while (xor > 0n) {
    bits += Number(xor & 1n);
    xor >>= 1n;
  }
  return bits;
}

/** Mínima distancia de Hamming entre dos conjuntos de hashes de orientación */
function distanciaMinima(hashesA, hashesB) {
  let minima = Number.MAX_SAFE_INTEGER;
  for (const a of hashesA || []) {
    for (const b of hashesB || []) {
      const distancia = distanciaHamming(a, b);
      if (distancia < minima) minima = distancia;
    }
  }
  return minima;
}

/** true si dos conjuntos de hashes corresponden a "la misma imagen" (en cualquier orientación) */
function sonMismaImagen(hashesA, hashesB) {
  return distanciaMinima(hashesA, hashesB) <= UMBRAL_HAMMING;
}

/** Parsea la columna phash de la base (JSON con el array de 8 hashes) */
function parsearPhash(valor) {
  if (!valor) return null;
  if (Array.isArray(valor)) return valor;
  try {
    const parseado = JSON.parse(valor);
    return Array.isArray(parseado) ? parseado : null;
  } catch (e) {
    return null;
  }
}

module.exports = { calcularPhashes, distanciaHamming, distanciaMinima, sonMismaImagen, parsearPhash, UMBRAL_HAMMING };
