"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const {
  CACHE_CONTROL_IMMUTABLE,
  crearServicioNoticiaMedia,
  clavesDeMedia,
  parsearVariantes,
  validarLoteImagenes,
} = require("../api/services/noticia-media");

async function crearImagen(width, height, format = "jpeg") {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 27, g: 92, b: 145 },
    },
  });
  return format === "webp" ? pipeline.webp().toBuffer() : pipeline.jpeg().toBuffer();
}

test("genera fallback y variantes WebP sin ampliar ni procesar en paralelo", async () => {
  const entrada = await crearImagen(1000, 500);
  const objetos = [];
  let activos = 0;
  let maximoActivos = 0;
  const servicio = crearServicioNoticiaMedia({
    crearId: () => "estable",
    subirObjeto: async ({ key, buffer, contentType, cacheControl }) => {
      activos += 1;
      maximoActivos = Math.max(maximoActivos, activos);
      const metadata = await sharp(buffer).metadata();
      objetos.push({ key, contentType, cacheControl, width: metadata.width, height: metadata.height });
      activos -= 1;
    },
  });

  const media = await servicio.procesarYSubir({ buffer: entrada, mimetype: "image/jpeg" }, "portadas");

  assert.equal(media.archivo, "noticias/portadas/noticia_estable/original.jpg");
  assert.equal(media.ancho, 1000);
  assert.equal(media.alto, 500);
  assert.deepEqual(media.variantes.map(({ ancho }) => ancho), [320, 640, 960, 1000]);
  assert.deepEqual(objetos.map(({ contentType }) => contentType), [
    "image/jpeg", "image/webp", "image/webp", "image/webp", "image/webp",
  ]);
  assert.ok(objetos.every(({ cacheControl }) => cacheControl === CACHE_CONTROL_IMMUTABLE));
  assert.equal(maximoActivos, 1);
});

test("reutiliza el fallback WebP como la variante de ancho completo", async () => {
  const entrada = await crearImagen(200, 100, "webp");
  const objetos = [];
  const servicio = crearServicioNoticiaMedia({
    crearId: () => "webp",
    subirObjeto: async (objeto) => objetos.push(objeto.key),
  });

  const media = await servicio.procesarYSubir({ buffer: entrada, mimetype: "image/webp" }, "galeria");

  assert.equal(objetos.length, 1);
  assert.equal(media.variantes.length, 1);
  assert.equal(media.variantes[0].archivo, media.archivo);
  assert.equal(media.variantes[0].ancho, 200);
});

test("limpia en orden inverso todas las keys intentadas si una carga falla", async () => {
  const entrada = await crearImagen(700, 350);
  const intentadas = [];
  const eliminadas = [];
  const servicio = crearServicioNoticiaMedia({
    crearId: () => "falla",
    subirObjeto: async ({ key }) => {
      intentadas.push(key);
      if (intentadas.length === 2) throw new Error("fallo simulado");
    },
    eliminarObjeto: async (key) => eliminadas.push(key),
    logger: { error() {} },
  });

  await assert.rejects(
    servicio.procesarYSubir({ buffer: entrada, mimetype: "image/jpeg" }),
    (error) => error.statusCode === 502
  );
  assert.deepEqual(eliminadas, [...intentadas].reverse());
});

test("resuelve CDN estable solo con base configurada y firma en su ausencia", async () => {
  const descriptor = {
    archivo: "noticias/portadas/nota con espacio/original.jpg",
    ancho: 800,
    alto: 400,
    mime: "image/jpeg",
    variantes: JSON.stringify([
      { archivo: "noticias/portadas/nota con espacio/w320.webp", ancho: 320, alto: 160, mime: "image/webp" },
    ]),
  };
  let firmas = 0;
  const conCdn = crearServicioNoticiaMedia({
    publicBaseUrl: "https://cdn.ajb.test/media/",
    firmarObjeto: async () => {
      firmas += 1;
      return "no-debe-usarse";
    },
  });
  const resueltaCdn = await conCdn.resolver(descriptor);
  assert.equal(resueltaCdn.url, "https://cdn.ajb.test/media/noticias/portadas/nota%20con%20espacio/original.jpg");
  assert.match(resueltaCdn.variantes[0].url, /w320\.webp$/);
  assert.equal(firmas, 0);

  const sinCdn = crearServicioNoticiaMedia({
    firmarObjeto: async (key) => {
      firmas += 1;
      return `firmada:${key}`;
    },
  });
  const resueltaFirmada = await sinCdn.resolver(descriptor);
  assert.equal(resueltaFirmada.url, `firmada:${descriptor.archivo}`);
  assert.equal(firmas, 2);

  const cdnInvalido = crearServicioNoticiaMedia({
    publicBaseUrl: "javascript:alert(1)",
    firmarObjeto: async (key) => `segura:${key}`,
  });
  assert.equal((await cdnInvalido.resolver(descriptor)).url, `segura:${descriptor.archivo}`);
});

test("limita bytes agregados y píxeles antes de producir variantes", async () => {
  assert.throws(
    () => validarLoteImagenes([{ buffer: Buffer.alloc(6) }, { buffer: Buffer.alloc(5) }], 10),
    (error) => error.statusCode === 413
  );

  const entrada = await crearImagen(20, 20);
  const servicio = crearServicioNoticiaMedia({
    maxInputPixels: 100,
    subirObjeto: async () => assert.fail("no debe subir una imagen fuera del límite"),
  });
  await assert.rejects(
    servicio.procesarYSubir({ buffer: entrada, mimetype: "image/jpeg" }),
    (error) => error.statusCode === 400 && /píxeles/.test(error.message)
  );
});

test("tolera metadata legacy y enumera una sola vez todas las keys", () => {
  const variantes = parsearVariantes(JSON.stringify([
    { archivo: "noticias/a/w320.webp", ancho: 320, alto: 180, mime: "image/webp" },
    { archivo: "", ancho: 640, alto: 360, mime: "image/webp" },
  ]));
  assert.equal(variantes.length, 1);
  assert.deepEqual(
    clavesDeMedia({ archivo: "noticias/a/original.webp", ancho: 320, alto: 180, mime: "image/webp", variantes: [
      { archivo: "noticias/a/original.webp", ancho: 320, alto: 180, mime: "image/webp" },
      ...variantes,
    ] }),
    ["noticias/a/original.webp", "noticias/a/w320.webp"]
  );
  assert.deepEqual(parsearVariantes("json inválido"), []);
});
