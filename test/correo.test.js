const test = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");

const correo = require("../api/services/correo");
const { configuracionCorreo } = require("../api/services/correo/config");
const { opcionesDeTransporte } = require("../api/services/correo/transporte");
const { construirCorreoHtml, textoPlanoDesdeHtml, urlSegura } = require("../api/services/correo/plantilla");

const CLAVES_MAIL = [
  "MAIL_HOST", "MAIL_PORT", "MAIL_SECURE", "MAIL_USER", "MAIL_PASSWORD",
  "MAIL_FROM", "MAIL_FROM_NAME", "MAIL_REPLY_TO", "MAIL_ENABLED", "MAIL_REDIRECT_TO", "MAIL_TEST_MODE",
  "MAIL_APP_URL", "MAIL_HELO_NAME", "MAIL_MAX_POR_MINUTO", "MAIL_MAX_CONEXIONES",
  "MAIL_TLS_ESTRICTO", "MAIL_DEBUG",
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

test("la configuracion de SES separa la credencial SMTP del remitente verificado", async () => {
  const entornoSes = {
    MAIL_HOST: "email-smtp.sa-east-1.amazonaws.com",
    MAIL_PORT: "465",
    MAIL_SECURE: "true",
    MAIL_USER: "USUARIO_SMTP_SES_DE_PRUEBA",
    MAIL_PASSWORD: "clave-smtp-de-prueba",
    MAIL_FROM: "no-responder@miajb.org.ar",
    MAIL_FROM_NAME: "Mi AJB",
    MAIL_REPLY_TO: "",
    MAIL_HELO_NAME: "miajb.org.ar",
    MAIL_ENABLED: "true",
    MAIL_MAX_POR_MINUTO: "300",
    MAIL_MAX_CONEXIONES: "5",
  };

  await conEntorno(entornoSes, () => {
    const config = configuracionCorreo();
    const transporte = opcionesDeTransporte(config);

    assert.equal(config.configurado, true);
    assert.equal(config.habilitado, true);
    assert.equal(config.usuario, entornoSes.MAIL_USER);
    assert.equal(config.remitenteEmail, "no-responder@miajb.org.ar");
    assert.deepEqual(config.remitente, { name: "Mi AJB", address: "no-responder@miajb.org.ar" });
    assert.equal(config.responderA, "");
    assert.equal(config.nombreHelo, "miajb.org.ar");

    assert.equal(transporte.host, "email-smtp.sa-east-1.amazonaws.com");
    assert.equal(transporte.port, 465);
    assert.equal(transporte.secure, true);
    assert.deepEqual(transporte.auth, { user: entornoSes.MAIL_USER, pass: entornoSes.MAIL_PASSWORD });
    assert.equal(transporte.name, "miajb.org.ar");
    assert.equal(transporte.tls.servername, entornoSes.MAIL_HOST);
    assert.equal(transporte.tls.minVersion, "TLSv1.2");
  });

  const sinRemitente = { ...entornoSes };
  delete sinRemitente.MAIL_FROM;
  await conEntorno(sinRemitente, () => {
    assert.equal(
      configuracionCorreo().configurado,
      false,
      "el usuario SMTP opaco de SES no puede usarse como remitente implicito"
    );
  });
});

test("el pool distribuye el maximo por minuto sin consumirlo en una sola rafaga", async () => {
  const base = {
    MAIL_HOST: "email-smtp.sa-east-1.amazonaws.com",
    MAIL_USER: "USUARIO_SMTP_SES_DE_PRUEBA",
    MAIL_PASSWORD: "clave-smtp-de-prueba",
    MAIL_FROM: "no-responder@miajb.org.ar",
  };
  const casos = [
    { maxPorMinuto: 300, maxConexiones: 5, conexiones: 5, rateLimit: 5, rateDelta: 1000 },
    { maxPorMinuto: 20, maxConexiones: 2, conexiones: 2, rateLimit: 2, rateDelta: 6000 },
    { maxPorMinuto: 3, maxConexiones: 10, conexiones: 3, rateLimit: 3, rateDelta: 60000 },
  ];

  for (const caso of casos) {
    await conEntorno({
      ...base,
      MAIL_MAX_POR_MINUTO: String(caso.maxPorMinuto),
      MAIL_MAX_CONEXIONES: String(caso.maxConexiones),
    }, () => {
      const transporte = opcionesDeTransporte(configuracionCorreo());
      assert.equal(transporte.maxConnections, caso.conexiones);
      assert.equal(transporte.rateLimit, caso.rateLimit);
      assert.equal(transporte.rateDelta, caso.rateDelta);
    });
  }
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

test("el modo de pruebas bloquea envio y verificacion SMTP sin redireccion valida", async (t) => {
  correo.cerrarTransporte();
  const crearTransporte = t.mock.method(nodemailer, "createTransport", () => {
    throw new Error("La prueba no debe abrir SMTP");
  });
  const base = {
    MAIL_HOST: "email-smtp.sa-east-1.amazonaws.com",
    MAIL_USER: "USUARIO_SMTP_SES_DE_PRUEBA",
    MAIL_PASSWORD: "clave-smtp-de-prueba",
    MAIL_FROM: "no-responder@miajbpruebas.com.ar",
    MAIL_ENABLED: "true",
    MAIL_TEST_MODE: "true",
  };

  for (const redireccion of [undefined, "", "correo-invalido"]) {
    const entorno = { ...base };
    if (redireccion !== undefined) entorno.MAIL_REDIRECT_TO = redireccion;

    await conEntorno(entorno, async () => {
      const config = configuracionCorreo();
      assert.equal(config.configurado, true, "la configuracion SMTP esta completa");
      assert.equal(config.modoPruebas, true);
      assert.equal(config.bloqueadoPorPruebas, true);
      assert.equal(config.habilitado, false);
      assert.equal(correo.estadoCorreo().habilitado, false);

      const envio = await correo.enviarCorreo({ para: "afiliado@ejemplo.com", asunto: "Prueba", texto: "Hola" });
      assert.equal(envio.enviado, false);
      assert.equal(envio.motivo, "destino_pruebas_invalido");
      assert.match(envio.error, /MAIL_REDIRECT_TO/);

      const verificacion = await correo.verificarCorreo();
      assert.equal(verificacion.conectado, false);
      assert.equal(verificacion.motivo, "destino_pruebas_invalido");
      assert.equal(verificacion.detalle.habilitado, false);
      assert.equal(verificacion.detalle.bloqueadoPorPruebas, true);
      assert.match(verificacion.error, /MAIL_REDIRECT_TO/);
    });
  }

  assert.equal(crearTransporte.mock.callCount(), 0, "no se crea ningun transporte SMTP");
});

test("el modo de pruebas redirige To CC y BCC solo a la casilla de pruebas", async (t) => {
  const mensajes = [];
  correo.cerrarTransporte();
  t.mock.method(nodemailer, "createTransport", () => ({
    async sendMail(mensaje) {
      mensajes.push(mensaje);
      return { messageId: "prueba-offline", accepted: mensaje.to };
    },
    close() {},
  }));

  try {
    await conEntorno({
      MAIL_HOST: "email-smtp.sa-east-1.amazonaws.com",
      MAIL_USER: "USUARIO_SMTP_SES_DE_PRUEBA",
      MAIL_PASSWORD: "clave-smtp-de-prueba",
      MAIL_FROM: "no-responder@miajbpruebas.com.ar",
      MAIL_FROM_NAME: "Mi AJB · Pruebas",
      MAIL_TEST_MODE: "true",
      MAIL_REDIRECT_TO: "pruebas@ejemplo.com",
    }, async () => {
      assert.equal(configuracionCorreo().habilitado, true);
      const resultado = await correo.enviarCorreo({
        para: ["uno@ejemplo.com", "dos@ejemplo.com"],
        cc: "copia@ejemplo.com",
        cco: "oculta@ejemplo.com",
        asunto: "Prueba de redireccion",
        texto: "Contenido sintetico de prueba",
      });

      assert.equal(resultado.enviado, true);
      assert.equal(mensajes.length, 1);
      const mensaje = mensajes[0];
      const originales = "uno@ejemplo.com, dos@ejemplo.com, copia@ejemplo.com, oculta@ejemplo.com";
      assert.deepEqual(mensaje.to, ["pruebas@ejemplo.com"]);
      assert.equal(Object.hasOwn(mensaje, "cc"), false);
      assert.equal(Object.hasOwn(mensaje, "bcc"), false);
      assert.deepEqual(mensaje.from, { name: "Mi AJB · Pruebas", address: "no-responder@miajbpruebas.com.ar" });
      assert.equal(mensaje.subject, `[DESARROLLO -> ${originales}] Prueba de redireccion`);
      assert.equal(mensaje.headers["X-Destinatarios-Originales"], originales);
    });
  } finally {
    correo.cerrarTransporte();
  }
});

test("MAIL_TEST_MODE ausente o false conserva el envio normal", async (t) => {
  const mensajes = [];
  correo.cerrarTransporte();
  t.mock.method(nodemailer, "createTransport", () => ({
    async sendMail(mensaje) {
      mensajes.push(mensaje);
      return { messageId: "prueba-offline", accepted: mensaje.to };
    },
    close() {},
  }));

  try {
    for (const modo of [undefined, "false"]) {
      const entorno = {
        MAIL_HOST: "email-smtp.sa-east-1.amazonaws.com",
        MAIL_USER: "USUARIO_SMTP_SES_DE_PRUEBA",
        MAIL_PASSWORD: "clave-smtp-de-prueba",
        MAIL_FROM: "no-responder@miajb.org.ar",
        MAIL_REDIRECT_TO: "correo-invalido",
      };
      if (modo !== undefined) entorno.MAIL_TEST_MODE = modo;

      await conEntorno(entorno, async () => {
        const config = configuracionCorreo();
        assert.equal(config.modoPruebas, false);
        assert.equal(config.bloqueadoPorPruebas, false);
        assert.equal(config.habilitado, true);
        const resultado = await correo.enviarCorreo({
          para: "uno@ejemplo.com",
          cc: "copia@ejemplo.com",
          cco: "oculta@ejemplo.com",
          asunto: "Envio normal",
          texto: "Contenido sintetico de prueba",
        });
        assert.equal(resultado.enviado, true);
        const mensaje = mensajes.at(-1);
        assert.deepEqual(mensaje.to, ["uno@ejemplo.com"]);
        assert.deepEqual(mensaje.cc, ["copia@ejemplo.com"]);
        assert.deepEqual(mensaje.bcc, ["oculta@ejemplo.com"]);
        assert.equal(mensaje.subject, "Envio normal");
        assert.equal(Object.hasOwn(mensaje.headers, "X-Destinatarios-Originales"), false);
      });
    }
    assert.equal(mensajes.length, 2);
  } finally {
    correo.cerrarTransporte();
  }
});

test("los perfiles de dominio de pruebas y definitivo solo requieren cambiar variables", () => {
  for (const dominio of ["miajbpruebas.com.ar", "miajb.org.ar"]) {
    const config = configuracionCorreo({
      MAIL_HOST: "email-smtp.sa-east-1.amazonaws.com",
      MAIL_USER: "USUARIO_SMTP_SES_DE_PRUEBA",
      MAIL_PASSWORD: "clave-smtp-de-prueba",
      MAIL_FROM: `no-responder@${dominio}`,
      MAIL_HELO_NAME: dominio,
      MAIL_APP_URL: `https://${dominio}/`,
    });

    assert.equal(config.configurado, true);
    assert.equal(config.remitenteEmail, `no-responder@${dominio}`);
    assert.deepEqual(config.remitente, { name: "Mi AJB", address: `no-responder@${dominio}` });
    assert.equal(config.nombreHelo, dominio);
    assert.equal(opcionesDeTransporte(config).name, dominio);
    assert.equal(correo.urlAplicacion("/mis-gestiones", config), `https://${dominio}/mis-gestiones`);
  }
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
