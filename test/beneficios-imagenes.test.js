"use strict";
// Pruebas offline de procesarImagenBeneficio (sharp) y del marcador del correo con mensaje propio.
const test = require("node:test");
const assert = require("node:assert/strict");
const BACKEND = require("path").join(__dirname, "..");
const sharp = require("sharp");
const { construirCorreoHtml } = require("../api/services/correo");
const router = require("../api/routes/beneficios");
const { procesarImagenBeneficio, renderizarHtmlBeneficio, sanitizarHtmlBeneficio } = router.__test;

async function imagen(ancho, alto, formato) {
  const pipeline = sharp({ create: { width: ancho, height: alto, channels: 3, background: { r: 10, g: 120, b: 200 } } });
  const buffer = await (formato === "png" ? pipeline.png() : formato === "webp" ? pipeline.webp() : pipeline.jpeg()).toBuffer();
  return { buffer, mimetype: formato === "png" ? "image/png" : formato === "webp" ? "image/webp" : "image/jpeg", originalname: `a.${formato}` };
}

test("galería: rechaza menos de 400px de ancho con mensaje claro", async () => {
  const file = await imagen(300, 200, "jpeg");
  await assert.rejects(
    procesarImagenBeneficio(file, { anchoMinimo: 400, anchoMaximo: 1920, etiqueta: "La imagen 1 de la galería" }),
    (e) => e.statusCode === 400 && /300px de ancho.*400px/.test(e.message)
  );
});

test("galería: reduce a 1920 conservando formato; no toca lo que ya entra", async () => {
  const grande = await imagen(2500, 1000, "png");
  const salida = await procesarImagenBeneficio(grande, { anchoMinimo: 400, anchoMaximo: 1920, etiqueta: "X" });
  const meta = await sharp(salida.buffer).metadata();
  assert.equal(meta.width, 1920);
  assert.equal(meta.format, "png");
  assert.equal(salida.contentType, "image/png");
  assert.equal(salida.extension, "png");

  const chica = await imagen(800, 600, "webp");
  const intacta = await procesarImagenBeneficio(chica, { anchoMinimo: 400, anchoMaximo: 1920, etiqueta: "X" });
  assert.equal(intacta.buffer, chica.buffer);
  assert.equal(intacta.extension, "webp");
});

test("logo a 640 y pin a 160; image/jpg se normaliza a jpeg", async () => {
  const logo = await imagen(1000, 500, "jpeg");
  logo.mimetype = "image/jpg";
  const salidaLogo = await procesarImagenBeneficio(logo, { anchoMaximo: 640, etiqueta: "El logo" });
  assert.equal((await sharp(salidaLogo.buffer).metadata()).width, 640);
  assert.equal(salidaLogo.contentType, "image/jpeg");
  const pin = await imagen(400, 400, "png");
  const salidaPin = await procesarImagenBeneficio(pin, { anchoMaximo: 160, etiqueta: "El pin" });
  assert.equal((await sharp(salidaPin.buffer).metadata()).width, 160);
});

test("contenido que no coincide con el mime declarado o basura => 400", async () => {
  const png = await imagen(500, 500, "png");
  png.mimetype = "image/jpeg";
  await assert.rejects(procesarImagenBeneficio(png, { anchoMaximo: 640 }), (e) => e.statusCode === 400 && /no coincide/.test(e.message));
  await assert.rejects(procesarImagenBeneficio({ mimetype: "image/png", buffer: Buffer.alloc(100, 7) }, { anchoMaximo: 640 }), (e) => e.statusCode === 400);
  await assert.rejects(procesarImagenBeneficio({ mimetype: "image/gif", buffer: Buffer.alloc(100, 7) }, {}), (e) => /formato permitido/.test(e.message));
});

test("marcador del correo: la plantilla lo deja intacto en HTML y texto, y un HTML saneado lo reemplaza", () => {
  const MARCADOR = "%%MENSAJE_BENEFICIO%%";
  const { html, texto } = construirCorreoHtml({ titulo: "T", saludo: "Hola", parrafos: ["Registro.", MARCADOR], datos: [], boton: null });
  assert.match(html, new RegExp(`<p[^>]*>${MARCADOR}</p>`));
  assert.ok(texto.includes(MARCADOR));
  const reemplazado = html.replace(new RegExp(`<p[^>]*>${MARCADOR}</p>`), () => "<div>$&<b>x</b></div>");
  assert.ok(reemplazado.includes("<div>$&<b>x</b></div>"), "la función de reemplazo evita patrones $ del replace");
});

test("renderizarHtmlBeneficio sin S3: no lanza; sin firma la imagen se omite y los embeds quedan", async () => {
  const limpio = sanitizarHtmlBeneficio('<p>Hola</p><img data-archivo="beneficios/editor_x.png" alt="a"><div data-embed="youtube" data-ref="abc">v</div>');
  const salida = await renderizarHtmlBeneficio(limpio);
  assert.ok(typeof salida === "string");
  assert.ok(salida.includes("<p>Hola</p>"));
  assert.ok(salida.includes('<div data-embed="youtube" data-ref="abc">v</div>'));
  const correo = await renderizarHtmlBeneficio(limpio, { paraCorreo: true, expiresIn: 86400 });
  assert.match(correo, /<p><a href="https:\/\/www\.youtube\.com\/watch\?v=abc"/);
  assert.equal(await renderizarHtmlBeneficio(null), null);
});
