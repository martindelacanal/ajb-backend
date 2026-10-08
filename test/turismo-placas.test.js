"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const {
  MENSAJE_ENLACE_INVALIDO,
  calcularEstadoPlaca,
  combinarOrden,
  contenidoCoincideConMime,
  fechaHoyArgentina,
  mapearPlacaAdmin,
  mapearPlacaPublica,
  normalizarEnlaceUrl,
  normalizarIdsOrden,
  procesarImagenPlaca,
  validarDatosPlaca,
} = require("../api/services/turismo-placas");

// ── enlace_url ─────────────────────────────────────────────────────────────

test("enlace de placa: vacío es null; acepta http(s) completo y rutas internas", () => {
  assert.equal(normalizarEnlaceUrl(undefined), null);
  assert.equal(normalizarEnlaceUrl(""), null);
  assert.equal(normalizarEnlaceUrl("   "), null);
  assert.equal(normalizarEnlaceUrl("/turismo"), "/turismo");
  assert.equal(normalizarEnlaceUrl("  /turismo/convenios?ciudad=Miramar  "), "/turismo/convenios?ciudad=Miramar");
  assert.equal(normalizarEnlaceUrl("https://agencia.com.ar/promo"), "https://agencia.com.ar/promo");
  assert.equal(normalizarEnlaceUrl("HTTP://agencia.com.ar"), "HTTP://agencia.com.ar");
});

test("enlace de placa: rechaza protocolos peligrosos, // y trucos con barras invertidas", () => {
  for (const malo of [
    "javascript:alert(1)",
    "data:text/html,hola",
    "//evil.com",
    "/\\evil.com",
    "ftp://archivo.com",
    "agencia.com.ar",
    "https://",
    "https://usuario:clave@agencia.com",
    "/turismo con espacio",
    "/turismo\nSet-Cookie",
    `https://a.com/${"x".repeat(500)}`,
  ]) {
    assert.equal(normalizarEnlaceUrl(malo), undefined, malo);
  }
  assert.equal(normalizarEnlaceUrl(123), undefined);
});

// ── validación del formulario ──────────────────────────────────────────────

test("alta de placa: título obligatorio y con tope de 140", () => {
  assert.match(validarDatosPlaca({}).error, /título es obligatorio/);
  assert.match(validarDatosPlaca({ titulo: "   " }).error, /título es obligatorio/);
  assert.match(validarDatosPlaca({ titulo: "x".repeat(141) }).error, /hasta 140/);
  const { datos } = validarDatosPlaca({ titulo: `  ${"x".repeat(140)}  ` });
  assert.equal(datos.titulo.length, 140);
});

test("alta de placa: normaliza vacíos a null y publica por defecto", () => {
  const { datos, error } = validarDatosPlaca({
    titulo: "Escapada de primavera",
    descripcion: "",
    enlace_url: "",
    enlace_texto: "  ",
    vigencia_desde: "",
    vigencia_hasta: "",
  });
  assert.equal(error, undefined);
  assert.deepEqual(datos, {
    titulo: "Escapada de primavera",
    descripcion: null,
    enlace_url: null,
    enlace_texto: null,
    vigencia_desde: null,
    vigencia_hasta: null,
    publicado: 1,
  });
});

test("alta de placa: valida topes de descripción, texto del botón y enlace", () => {
  assert.match(validarDatosPlaca({ titulo: "Ok", descripcion: "d".repeat(301) }).error, /descripción puede tener hasta 300/);
  assert.match(validarDatosPlaca({ titulo: "Ok", enlace_texto: "t".repeat(61) }).error, /texto del botón puede tener hasta 60/);
  assert.equal(validarDatosPlaca({ titulo: "Ok", enlace_url: "javascript:alert(1)" }).error, MENSAJE_ENLACE_INVALIDO);
  assert.equal(validarDatosPlaca({ titulo: "Ok", enlace_url: "/turismo", enlace_texto: "Ver alojamientos" }).datos.enlace_url, "/turismo");
});

test("alta de placa: vigencias en AAAA-MM-DD y hasta >= desde", () => {
  assert.match(validarDatosPlaca({ titulo: "Ok", vigencia_desde: "07/10/2026" }).error, /«desde».*no es válida/);
  assert.match(validarDatosPlaca({ titulo: "Ok", vigencia_hasta: "2026-02-30" }).error, /«hasta».*no es válida/);
  assert.match(
    validarDatosPlaca({ titulo: "Ok", vigencia_desde: "2026-12-01", vigencia_hasta: "2026-11-30" }).error,
    /no puede ser anterior/
  );
  const mismoDia = validarDatosPlaca({ titulo: "Ok", vigencia_desde: "2026-12-01", vigencia_hasta: "2026-12-01" });
  assert.equal(mismoDia.error, undefined);
  assert.equal(mismoDia.datos.vigencia_hasta, "2026-12-01");
});

test("alta de placa: publicado acepta '1'/'0'/true/false y rechaza basura", () => {
  assert.equal(validarDatosPlaca({ titulo: "Ok", publicado: "0" }).datos.publicado, 0);
  assert.equal(validarDatosPlaca({ titulo: "Ok", publicado: "1" }).datos.publicado, 1);
  assert.equal(validarDatosPlaca({ titulo: "Ok", publicado: false }).datos.publicado, 0);
  assert.equal(validarDatosPlaca({ titulo: "Ok", publicado: "" }).datos.publicado, 1);
  assert.match(validarDatosPlaca({ titulo: "Ok", publicado: "quizás" }).error, /publicación no es válido/);
});

test("edición de placa: lo que no viene se conserva y la vigencia se valida contra lo guardado", () => {
  const actual = {
    titulo: "Temporada de verano",
    descripcion: "Promo en Miramar",
    enlace_url: "/turismo",
    enlace_texto: "Ver más",
    vigencia_desde: "2026-12-01",
    vigencia_hasta: "2027-02-28",
    publicado: 0,
  };
  const soloTitulo = validarDatosPlaca({ titulo: "Temporada 2027" }, actual);
  assert.deepEqual(soloTitulo.datos, { ...actual, titulo: "Temporada 2027", publicado: 0 });

  // Vaciar explícitamente un campo sí lo borra
  assert.equal(validarDatosPlaca({ enlace_url: "" }, actual).datos.enlace_url, null);

  // hasta nueva anterior al desde guardado
  assert.match(validarDatosPlaca({ vigencia_hasta: "2026-11-01" }, actual).error, /no puede ser anterior/);

  // el título, si viene, sigue siendo obligatorio
  assert.match(validarDatosPlaca({ titulo: "" }, actual).error, /título es obligatorio/);
});

// ── estado ─────────────────────────────────────────────────────────────────

test("estado de placa: OCULTA, PROGRAMADA, VENCIDA o PUBLICADA según hoy", () => {
  const hoy = "2026-10-07";
  assert.equal(calcularEstadoPlaca({ publicado: 0, vigencia_desde: null, vigencia_hasta: null }, hoy), "OCULTA");
  // oculta gana aunque esté vencida o programada
  assert.equal(calcularEstadoPlaca({ publicado: 0, vigencia_desde: "2027-01-01", vigencia_hasta: null }, hoy), "OCULTA");
  assert.equal(calcularEstadoPlaca({ publicado: 1, vigencia_desde: "2026-10-08", vigencia_hasta: null }, hoy), "PROGRAMADA");
  assert.equal(calcularEstadoPlaca({ publicado: 1, vigencia_desde: null, vigencia_hasta: "2026-10-06" }, hoy), "VENCIDA");
  assert.equal(calcularEstadoPlaca({ publicado: 1, vigencia_desde: "2026-10-07", vigencia_hasta: "2026-10-07" }, hoy), "PUBLICADA");
  assert.equal(calcularEstadoPlaca({ publicado: 1, vigencia_desde: null, vigencia_hasta: null }, hoy), "PUBLICADA");
  assert.equal(calcularEstadoPlaca({ publicado: "1", vigencia_desde: "2026-01-01", vigencia_hasta: "2026-12-31" }, hoy), "PUBLICADA");
  assert.equal(calcularEstadoPlaca(null, hoy), "OCULTA");
});

test("fecha de hoy se calcula en Argentina (UTC-3)", () => {
  // 02:30 UTC del 8 de octubre todavía es 7 de octubre en Buenos Aires
  assert.equal(fechaHoyArgentina(new Date("2026-10-08T02:30:00Z")), "2026-10-07");
  assert.equal(fechaHoyArgentina(new Date("2026-10-08T03:00:00Z")), "2026-10-08");
});

// ── mapeos ─────────────────────────────────────────────────────────────────

const FILA = {
  id: 7,
  titulo: "Convenio con agencia de viajes",
  descripcion: "10% en paquetes",
  imagen_archivo: "turismo/placas/abc.webp",
  imagen_ancho: 1080,
  imagen_alto: 1350,
  enlace_url: "https://agencia.com.ar",
  enlace_texto: "Ver paquetes",
  vigencia_desde: "2026-10-01",
  vigencia_hasta: "2026-12-31",
  publicado: 1,
  orden: -2,
  eliminado: 0,
  creado_por_usuario_id: 1,
  modificado_por_usuario_id: 11,
  fecha_modificacion: new Date("2026-10-07T12:00:00Z"),
};

test("placa pública: sólo los campos del contrato (sin key S3, orden ni auditoría)", () => {
  const placa = mapearPlacaPublica(FILA, "https://s3/firmada");
  assert.deepEqual(Object.keys(placa).sort(), [
    "descripcion", "enlace_texto", "enlace_url", "id", "imagen_alto", "imagen_ancho", "imagen_url", "titulo", "vigencia_hasta",
  ]);
  assert.equal(placa.imagen_url, "https://s3/firmada");
  assert.equal(placa.vigencia_hasta, "2026-12-31");
});

test("placa admin: estado calculado, publicado booleano y sin key S3", () => {
  const placa = mapearPlacaAdmin(FILA, "https://s3/firmada", "2026-10-07");
  assert.equal(placa.estado, "PUBLICADA");
  assert.equal(placa.publicado, true);
  assert.equal(placa.orden, -2);
  assert.equal(placa.imagen_archivo, undefined);
  assert.equal(placa.creado_por_usuario_id, undefined);
  assert.equal(mapearPlacaAdmin({ ...FILA, publicado: 0 }, null, "2026-10-07").estado, "OCULTA");
});

// ── orden ──────────────────────────────────────────────────────────────────

test("reordenar: ids positivos sin repetir; los que no vienen quedan atrás en su orden", () => {
  assert.deepEqual(normalizarIdsOrden([3, "1", 2]), [3, 1, 2]);
  assert.deepEqual(normalizarIdsOrden("[4,5]"), [4, 5]);
  assert.equal(normalizarIdsOrden([]), null);
  assert.equal(normalizarIdsOrden([1, 1]), null);
  assert.equal(normalizarIdsOrden([1, -2]), null);
  assert.equal(normalizarIdsOrden([1.5]), null);
  assert.equal(normalizarIdsOrden("no"), null);
  assert.equal(normalizarIdsOrden(undefined), null);

  assert.deepEqual(combinarOrden([3, 1], [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]), [3, 1, 2, 4]);
});

// ── imagen ─────────────────────────────────────────────────────────────────

test("imagen de placa: verifica magic bytes contra el mimetype", async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#0097de" } }).png().toBuffer();
  assert.equal(contenidoCoincideConMime({ mimetype: "image/png", buffer: png }), true);
  assert.equal(contenidoCoincideConMime({ mimetype: "image/jpeg", buffer: png }), false);
  await assert.rejects(procesarImagenPlaca({ mimetype: "image/jpeg", buffer: png }), /JPG, PNG o WebP/);
  await assert.rejects(procesarImagenPlaca({ mimetype: "image/gif", buffer: png }), /JPG, PNG o WebP/);
});

test("imagen de placa: se achica para entrar en 1600×1600 sin agrandar y sale WebP", async () => {
  const grande = await sharp({ create: { width: 3200, height: 1800, channels: 3, background: "#0d5482" } }).jpeg().toBuffer();
  const resultado = await procesarImagenPlaca({ mimetype: "image/jpeg", buffer: grande });
  assert.equal(resultado.contentType, "image/webp");
  assert.equal(resultado.ancho, 1600);
  assert.equal(resultado.alto, 900);
  assert.equal(resultado.buffer.subarray(8, 12).toString("ascii"), "WEBP");

  const chica = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#eaf6fd" } }).png().toBuffer();
  const sinAgrandar = await procesarImagenPlaca({ mimetype: "image/png", buffer: chica });
  assert.equal(sinAgrandar.ancho, 800);
  assert.equal(sinAgrandar.alto, 1000);
});

// ── montaje ────────────────────────────────────────────────────────────────

test("app.js monta el router público y el de placas antes del 404 de /api", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const publico = appSource.indexOf("app.use('/api', publicoRoute)");
  const placas = appSource.indexOf("app.use('/api', turismoPlacasRoute)");
  const notFound = appSource.indexOf("No encontramos el recurso solicitado");
  assert.ok(publico > 0 && placas > 0 && notFound > 0);
  assert.ok(publico < notFound && placas < notFound);
});
