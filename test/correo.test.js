const test = require("node:test");
const assert = require("node:assert/strict");

const correo = require("../api/services/correo");
const { configuracionCorreo } = require("../api/services/correo/config");
const { opcionesDeTransporte } = require("../api/services/correo/transporte");
const { construirCorreoHtml, textoPlanoDesdeHtml, urlSegura } = require("../api/services/correo/plantilla");

const CLAVES_MAIL = [
  "MAIL_HOST", "MAIL_PORT", "MAIL_SECURE", "MAIL_USER", "MAIL_PASSWORD",
  "MAIL_FROM", "MAIL_FROM_NAME", "MAIL_ENABLED", "MAIL_REDIRECT_TO", "MAIL_APP_URL", "MAIL_HELO_NAME",
];

/** Ejecuta la prueba con un entorno de correo controlado y luego lo restaura. */
async function conEntorno(valores, ejecutar) {
  const previo = {};
  for (const clave of CLAVES_MAIL) {
    previo[clave] = process.env[clave];
    delete process.env[clave];
  }
  Object.assign(process.env, valores);
  try {
    await ejecutar();
  } finally {
    for (const clave of CLAVES_MAIL) {
      if (previo[clave] === undefined) delete process.env[clave];
      else process.env[clave] = previo[clave];
    }
  }
}

test("los destinatarios se normalizan, deduplican y descartan los invalidos", () => {
  assert.deepEqual(
    correo.normalizarDestinatarios("Uno@Dominio.com, uno@dominio.com; dos@dominio.com"),
    ["uno@dominio.com", "dos@dominio.com"]
  );
  assert.deepEqual(correo.normalizarDestinatarios(["sin-arroba", "a@b", "  ", null]), []);
  assert.deepEqual(correo.normalizarDestinatarios("ok@dominio.com.ar"), ["ok@dominio.com.ar"]);
});

test("el asunto no permite inyectar cabeceras con saltos de linea", () => {
  const asunto = correo.normalizarAsunto("Hola\r\nBcc: intruso@dominio.com");
  assert.ok(!/[\r\n]/.test(asunto));
  assert.equal(asunto, "Hola Bcc: intruso@dominio.com");
  assert.ok(correo.normalizarAsunto("x".repeat(500)).length <= 200);
});

test("la plantilla escapa el contenido y bloquea esquemas de URL peligrosos", () => {
  const { html, texto, adjuntos } = construirCorreoHtml({
    titulo: "<script>alert(1)</script>",
    parrafos: ["Comillas \" y & ampersand"],
    boton: { texto: "Entrar", url: "javascript:alert(1)" },
  });

  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("&amp;"));
  assert.ok(texto.includes("alert(1)"));
  assert.equal(adjuntos.length, 1, "el logo viaja embebido como adjunto cid:");
  assert.equal(adjuntos[0].cid, "logo-ajb");
  assert.equal(urlSegura("https://ajb.org.ar"), "https://ajb.org.ar");
  assert.equal(urlSegura("data:text/html,<b>x</b>"), "");
});

test("el texto plano derivado del HTML queda legible", () => {
  const plano = textoPlanoDesdeHtml("<p>Hola&nbsp;&nbsp;mundo</p><br><div>Uno &amp; dos</div>");
  assert.equal(plano, "Hola mundo\n\nUno & dos");
  assert.equal(textoPlanoDesdeHtml("<p>Se&#241;a</p>"), "Seña");
});

test("la configuracion deduce el modo seguro segun el puerto y detecta datos faltantes", async () => {
  await conEntorno(
    { MAIL_HOST: "mail.ajb.org.ar", MAIL_PORT: "587", MAIL_USER: "a@b.com", MAIL_PASSWORD: "x" },
    () => {
      const config = configuracionCorreo();
      assert.equal(config.seguro, false, "587 usa STARTTLS");
      assert.equal(config.configurado, true);
      assert.equal(config.habilitado, true);
    }
  );

  await conEntorno({ MAIL_HOST: "mail.ajb.org.ar", MAIL_PORT: "465", MAIL_USER: "a@b.com", MAIL_PASSWORD: "x" }, () => {
    assert.equal(configuracionCorreo().seguro, true, "465 usa SSL/TLS implicito");
  });

  await conEntorno({ MAIL_HOST: "mail.ajb.org.ar" }, () => {
    assert.equal(configuracionCorreo().configurado, false, "sin usuario ni clave no hay envio posible");
  });
});

test("enviarCorreo no toca la red ni lanza cuando falta configuracion o esta apagado", async () => {
  await conEntorno({}, async () => {
    const sinConfigurar = await correo.enviarCorreo({ para: "x@y.com", asunto: "Hola", texto: "Hola" });
    assert.deepEqual(sinConfigurar, { enviado: false, motivo: "sin_configurar" });
  });

  const base = { MAIL_HOST: "mail.ajb.org.ar", MAIL_USER: "a@b.com", MAIL_PASSWORD: "x", MAIL_ENABLED: "false" };

  await conEntorno(base, async () => {
    const apagado = await correo.enviarCorreo({ para: "x@y.com", asunto: "Hola", texto: "Hola" });
    assert.deepEqual(apagado, { enviado: false, motivo: "deshabilitado" });
  });

  await conEntorno({ ...base, MAIL_ENABLED: "true" }, async () => {
    assert.equal((await correo.enviarCorreo({ para: "no-es-mail", asunto: "Hola", texto: "x" })).motivo, "destinatario_invalido");
    assert.equal((await correo.enviarCorreo({ para: "x@y.com", asunto: "   ", texto: "x" })).motivo, "asunto_invalido");
    assert.equal((await correo.enviarCorreo({ para: "x@y.com", asunto: "Hola" })).motivo, "cuerpo_vacio");
  });
});

test("urlAplicacion arma rutas absolutas sin barras duplicadas", async () => {
  await conEntorno({ MAIL_APP_URL: "https://mi.ajb.org.ar/" }, () => {
    assert.equal(correo.urlAplicacion("/mis-gestiones"), "https://mi.ajb.org.ar/mis-gestiones");
    assert.equal(correo.urlAplicacion("home"), "https://mi.ajb.org.ar/home");
    assert.equal(correo.urlAplicacion(), "https://mi.ajb.org.ar");
  });
});

test("el backend se presenta en EHLO con un nombre de dominio real, nunca como [127.0.0.1]", async () => {
  const base = { MAIL_HOST: "mail.ajb.org.ar", MAIL_USER: "notificaciones@ajb.org.ar", MAIL_PASSWORD: "x" };

  await conEntorno(base, () => {
    const config = configuracionCorreo();
    assert.equal(config.nombreHelo, "ajb.org.ar", "sin MAIL_HELO_NAME se usa el dominio del remitente");
    assert.equal(opcionesDeTransporte(config).name, "ajb.org.ar", "el nombre llega al transporte de nodemailer");
  });

  await conEntorno({ ...base, MAIL_HELO_NAME: "api.miajb.ajb.org.ar" }, () => {
    assert.equal(configuracionCorreo().nombreHelo, "api.miajb.ajb.org.ar");
  });

  for (const invalido of ["[127.0.0.1]", "localhost", "con espacios.com", "-mal.com"]) {
    await conEntorno({ ...base, MAIL_HELO_NAME: invalido }, () => {
      assert.equal(configuracionCorreo().nombreHelo, "ajb.org.ar", `"${invalido}" no es un HELO valido y cae al dominio`);
    });
  }
});
