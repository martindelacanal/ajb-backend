"use strict";
// Pruebas offline de los helpers puros de api/routes/beneficios.js (sin base ni S3).
const test = require("node:test");
const assert = require("node:assert/strict");
const router = require("../api/routes/beneficios");

const T = router.__test;

test("router expone __test congelado con verifyToken", () => {
  assert.equal(typeof T.verifyToken, "function");
  assert.ok(Object.isFrozen(T));
});

test("sanitizarHtmlBeneficio: lista blanca, links seguros, img solo con data-archivo, embeds válidos", () => {
  const entrada = `<p style="text-align:center;color:red">Hola <b onclick="x()">mundo</b><script>alert(1)</script>
    <a href="javascript:alert(1)">mal</a> <a href="https://ajb.org.ar" onclick="x">ok</a>
    <span style="color:#ff0000;background-color:rgb(1,2,3);font-size:99px">c</span>
    <img src="blob:x" data-archivo="beneficios/editor_1_ab.jpg" alt="Foto &quot;a&quot;">
    <img src="http://evil/x.png"> <iframe src="x"></iframe>
    <div data-embed="youtube" data-ref="dQw4w9WgXcQ">video</div>
    <div data-embed="tiktok" data-ref="123">x</div>
    <h2 style="text-align:right">T</h2><u>u</u><table><tr><td>t</td></tr></table></p>`;
  const salida = T.sanitizarHtmlBeneficio(entrada);
  assert.match(salida, /^<p style="text-align:center">Hola <b>mundo<\/b>/);
  assert.doesNotMatch(salida, /script|onclick|iframe|javascript:|font-size|blob:|evil|<table|<td/);
  assert.match(salida, /<a>mal<\/a>/);
  assert.match(salida, /<a href="https:\/\/ajb\.org\.ar" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(salida, /<span style="color:#ff0000;background-color:rgb\(1,2,3\)">c<\/span>/);
  assert.match(salida, /<img data-archivo="beneficios\/editor_1_ab\.jpg" alt="Foto &quot;a&quot;">/);
  assert.match(salida, /<div data-embed="youtube" data-ref="dQw4w9WgXcQ">video<\/div>/);
  assert.match(salida, /<div>x<\/div>/);
  assert.match(salida, /<h2 style="text-align:right">T<\/h2><u>u<\/u>t/);
  assert.equal(T.sanitizarHtmlBeneficio("   "), null);
  assert.equal(T.sanitizarHtmlBeneficio(42), null);
});

test("normalizarHtmlBeneficio: vacío tras sanear => null; largo => error", () => {
  assert.deepEqual(T.normalizarHtmlBeneficio("<script>x</script>", "X"), { value: null });
  assert.deepEqual(T.normalizarHtmlBeneficio("", "X"), { value: null });
  assert.ok(T.normalizarHtmlBeneficio("a".repeat(200 * 1024 + 1), "X").error);
  assert.equal(T.normalizarHtmlBeneficio("<p>Hola</p>", "X").value, "<p>Hola</p>");
  assert.equal(T.normalizarHtmlBeneficio('<p><img data-archivo="beneficios/editor_x.png"></p>', "X").value, '<p><img data-archivo="beneficios/editor_x.png" alt=""></p>');
});

test("extraerArchivosEditor devuelve keys únicas del prefijo beneficios/", () => {
  const html = '<img data-archivo="beneficios/editor_a.jpg"><img data-archivo="beneficios/editor_a.jpg"><img data-archivo="otros/x.jpg">';
  assert.deepEqual(T.extraerArchivosEditor(html), ["beneficios/editor_a.jpg"]);
  assert.deepEqual(T.extraerArchivosEditor(null), []);
});

test("normalizarDniTitulares acepta 6..8 dígitos con separadores y puntos de miles", () => {
  assert.deepEqual(T.normalizarDniTitulares("12.345.678, 23456789 / 345678"), { value: "12345678, 23456789, 345678" });
  assert.deepEqual(T.normalizarDniTitulares(""), { value: null });
  assert.ok(T.normalizarDniTitulares("12345").error);
  assert.ok(T.normalizarDniTitulares("123456789").error);
  assert.ok(T.normalizarDniTitulares("abc").error);
});

test("transicionesDisponibles según rol y propiedad", () => {
  const admin = { rol: "admin" };
  const central = { rol: "admin-central" };
  const dep = { rol: "departamental", departamental_id: 3 };
  assert.deepEqual(T.transicionesDisponibles(admin, 1, false), [3, 2, 4]);
  assert.deepEqual(T.transicionesDisponibles(central, 2, false), [3, 4]);
  assert.deepEqual(T.transicionesDisponibles(admin, 3, false), [2]);
  assert.deepEqual(T.transicionesDisponibles(admin, 4, false), [1]);
  assert.deepEqual(T.transicionesDisponibles(dep, 2, true), [1]);
  assert.deepEqual(T.transicionesDisponibles(dep, 2, false), []);
  assert.deepEqual(T.transicionesDisponibles(dep, 1, true), []);
  assert.deepEqual(T.transicionesDisponibles({ rol: "afiliado" }, 1, true), []);
});

test("permisos: ver / editar / eliminar / observar", () => {
  const dep = { rol: "departamental", departamental_id: 3 };
  const otra = { rol: "departamental", departamental_id: 9 };
  const admin = { rol: "admin-central" };
  const propio = { departamental_id: 3, estado_id: 1, alcance_todas: 0, incluye_departamental: 0 };
  assert.equal(T.esDepartamentalDuenia(dep, propio), true);
  assert.equal(T.esDepartamentalDuenia(otra, propio), false);
  assert.equal(T.puedeVerBeneficio(dep, propio), true);
  assert.equal(T.puedeVerBeneficio(otra, propio), false);
  // Una propuesta ajena (pendiente/observada/rechazada) es privada aunque la incluya:
  // la no dueña recién la ve cuando está aprobada, y en modo lectura sin lo interno.
  assert.equal(T.puedeVerBeneficio(otra, { ...propio, alcance_todas: 1 }), false);
  assert.equal(T.puedeVerBeneficio(otra, { ...propio, incluye_departamental: 1 }), false);
  assert.equal(T.puedeVerBeneficio(otra, { ...propio, alcance_todas: 1, estado_id: 3 }), true);
  assert.equal(T.puedeVerBeneficio(otra, { ...propio, incluye_departamental: 1, estado_id: 3 }), true);
  assert.equal(T.puedeVerDatosInternos(otra, { ...propio, alcance_todas: 1, estado_id: 3 }), false);
  assert.equal(T.puedeVerDatosInternos(dep, propio), true);
  assert.equal(T.puedeVerDatosInternos(admin, propio), true);
  assert.equal(T.puedeVerBeneficio(admin, propio), true);
  assert.equal(T.puedeVerBeneficio({ rol: "afiliado" }, propio), false);
  assert.equal(T.puedeEditarBeneficio(dep, propio), true);
  assert.equal(T.puedeEditarBeneficio(dep, { ...propio, estado_id: 2 }), true);
  assert.equal(T.puedeEditarBeneficio(dep, { ...propio, estado_id: 3 }), false);
  assert.equal(T.puedeEditarBeneficio(otra, propio), false);
  assert.equal(T.puedeEditarBeneficio(admin, { ...propio, estado_id: 3 }), true);
  assert.equal(T.puedeEliminarBeneficio(dep, { ...propio, estado_id: 4 }), true);
  assert.equal(T.puedeEliminarBeneficio(dep, { ...propio, estado_id: 3 }), false);
  assert.equal(T.puedeObservarBeneficio(dep, propio), true);
  assert.equal(T.puedeObservarBeneficio(otra, { ...propio, alcance_todas: 1 }), false);
  assert.equal(T.puedeObservarBeneficio(admin, propio), true);
});

test("calcularCupo: pocos = restantes <= max(5, ceil(15%)), completo cuando llega al máximo", () => {
  assert.deepEqual(T.calcularCupo(null, 7), { maximo: null, inscriptos: 7, restantes: null, pocos: false, completo: false });
  assert.deepEqual(T.calcularCupo(10, 4), { maximo: 10, inscriptos: 4, restantes: 6, pocos: false, completo: false });
  assert.deepEqual(T.calcularCupo(10, 5), { maximo: 10, inscriptos: 5, restantes: 5, pocos: true, completo: false });
  assert.deepEqual(T.calcularCupo(100, 84), { maximo: 100, inscriptos: 84, restantes: 16, pocos: false, completo: false });
  assert.deepEqual(T.calcularCupo(100, 85), { maximo: 100, inscriptos: 85, restantes: 15, pocos: true, completo: false });
  assert.deepEqual(T.calcularCupo(10, 12), { maximo: 10, inscriptos: 12, restantes: 0, pocos: false, completo: true });
});

test("normalizarSucursales valida dirección, coordenadas e índices de imagen", () => {
  const ok = T.normalizarSucursales(JSON.stringify([
    { direccion: " Calle 1 ", latitud: "-34.6", longitud: "-58.4", etiqueta: "Casa central", imagen_index: 0 },
    { id: 5, direccion: "Calle 2", quitar_imagen: "1" },
  ]), { cantidadPines: 1 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.length, 2);
  assert.equal(ok.value[0].direccion, "Calle 1");
  assert.equal(ok.value[0].latitud, -34.6);
  assert.equal(ok.value[0].imagen_index, 0);
  assert.equal(ok.value[1].id, 5);
  assert.equal(ok.value[1].latitud, null);
  assert.equal(ok.value[1].quitar_imagen, 1);
  assert.equal(ok.value[1].orden, 1);
  assert.ok(T.normalizarSucursales('[{"direccion":""}]').error);
  assert.ok(T.normalizarSucursales('[{"direccion":"x","latitud":"91","longitud":"0"}]').error);
  assert.ok(T.normalizarSucursales('[{"direccion":"x","latitud":"1"}]').error);
  assert.ok(T.normalizarSucursales('[{"direccion":"x","imagen_index":0}]', { cantidadPines: 0 }).error);
  assert.ok(T.normalizarSucursales("no-json").error);
  assert.deepEqual(T.normalizarSucursales(""), { value: [] });
});

test("normalizarSitioWeb agrega https:// y rechaza basura; emails validados", () => {
  assert.deepEqual(T.normalizarSitioWeb("ajb.org.ar/beneficios"), { value: "https://ajb.org.ar/beneficios" });
  assert.deepEqual(T.normalizarSitioWeb("http://x.com"), { value: "http://x.com" });
  assert.ok(T.normalizarSitioWeb("javascript:alert(1)").error);
  assert.ok(T.normalizarSitioWeb("sin espacios ni puntos").error);
  assert.deepEqual(T.normalizarEmailOpcional(" Info@Empresa.com ", "El email"), { value: "info@empresa.com" });
  assert.ok(T.normalizarEmailOpcional("no-es-email", "El email").error);
});

test("contenidoCoincideConMime, normalizarMimeImagen y magic bytes", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  assert.equal(T.contenidoCoincideConMime({ mimetype: "image/png", buffer: png }), true);
  assert.equal(T.contenidoCoincideConMime({ mimetype: "image/jpeg", buffer: png }), false);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(8)]);
  assert.equal(T.contenidoCoincideConMime({ mimetype: "application/pdf", buffer: pdf }), true);
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(12)]);
  assert.equal(T.contenidoCoincideConMime({ mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx }), true);
  assert.equal(T.normalizarMimeImagen("image/jpg"), "image/jpeg");
  assert.equal(T.normalizarMimeImagen("image/gif"), null);
});

test("fechas, vigencia y resumen de texto", () => {
  assert.equal(T.formatearFechaCivil("2026-08-31"), "31/08/2026");
  assert.equal(T.describirVigencia({ fecha_vigencia_hasta: "2026-12-31" }), "Hasta el 31/12/2026");
  assert.equal(T.describirVigencia({ fecha_vigencia_desde: "2026-01-01", fecha_vigencia_hasta: "2026-12-31" }), "Del 01/01/2026 al 31/12/2026");
  assert.equal(T.describirVigencia({}), null);
  assert.equal(T.resumenHtml("<p>Hola   <b>mundo</b></p>"), "Hola mundo");
  assert.equal(T.resumenHtml("<p>" + "x".repeat(200) + "</p>", 10).length, 10);
  assert.equal(T.describirMotivoCorreo({ motivo: "error_smtp", error: "boom" }), "Error SMTP: boom");
});

test("normalizarListaIds y flags", () => {
  assert.deepEqual(T.normalizarListaIds("[1,2,2,3]"), [1, 2, 3]);
  assert.deepEqual(T.normalizarListaIds("1,2"), [1, 2]);
  assert.deepEqual(T.normalizarListaIds(""), []);
  assert.equal(T.normalizarListaIds("[1,\"x\"]"), null);
  assert.equal(T.normalizarFlag(undefined, 1), 1);
  assert.equal(T.normalizarFlag("0", 1), 0);
  assert.equal(T.normalizarFlag("si", 1), null);
});
