"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Sustituye el transporte antes de cargar el servicio: ninguna prueba abre SMTP.
let plantilla;
const correoPath = require.resolve("../api/services/correo");
require.cache[correoPath] = { id: correoPath, filename: correoPath, loaded: true, exports: {
  enviarCorreoPlantilla: async (datos) => { plantilla = datos; return { enviado: true }; },
  urlAplicacion: (ruta) => `https://app.example.test${ruta}`,
} };
const { encolarBienvenida, bienvenidaDisponible, enviarBienvenida, resultadoEnvio, procesarBienvenidas } = require("../api/services/usuarios-bienvenida");
const { aplicarMigracion, verificarEsquema } = require("../scripts/migrar-usuarios-alta-v1");
const { crearSesion } = require("../api/security/sesiones-persistentes");

const fila = (cambios = {}) => ({ id: "a7749a30-d227-421f-9b4b-713fc75397ca", usuario_id: 10,
  email: "ana@example.test", email_actual: "ana@example.test", nombre: "Ana Pérez", habilitado: "Y",
  estado: "pendiente", procesando_en: null, ...cambios });

function cola(filas, { tomado = 1, fallaLiberacion = false } = {}) {
  const llamadas = [];
  let liberada = false;
  const connection = {
    async query(sql, params = []) {
      llamadas.push({ sql, params });
      if (/GET_LOCK/.test(sql)) return [[{ tomado }]];
      if (/RELEASE_LOCK/.test(sql)) { if (fallaLiberacion) throw new Error("liberacion_fallida"); return [[{ liberado: 1 }]]; }
      if (/INTERVAL 10 MINUTE/.test(sql)) {
        for (const item of filas) if (item.estado === "pendiente" && item.procesando_en === "anterior") item.estado = "error";
        return [{ affectedRows: 1 }];
      }
      if (/SELECT b\.\*/.test(sql)) return [filas.filter(item => item.estado === "pendiente" && !item.procesando_en)];
      if (/SET procesando_en=NOW/.test(sql)) {
        filas.find(item => item.id === params[0]).procesando_en = "actual";
        return [{ affectedRows: 1 }];
      }
      if (/SET estado='error', detalle=\?/.test(sql)) {
        const item = filas.find(row => row.id === params[1]); item.estado = "error"; item.detalle = params[0];
        return [{ affectedRows: 1 }];
      }
      if (/SET estado=\?, detalle=\?, message_id/.test(sql)) {
        const item = filas.find(row => row.id === params[4]);
        if (item.estado !== "pendiente") return [{ affectedRows: 0 }];
        item.estado = params[0]; item.detalle = params[1]; item.message_id ??= params[2];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    release() { liberada = true; },
  };
  return { db: { getConnection: async () => connection }, llamadas, get liberada() { return liberada; } };
}

async function conCorreo(env, fn) {
  const seguro = { MAIL_HOST: "smtp.example.test", MAIL_USER: "usuario", MAIL_PASSWORD: "solo-pruebas",
    MAIL_FROM: "noreply@example.test", MAIL_ENABLED: "true", MAIL_TEST_MODE: "false", MAIL_REDIRECT_TO: "",
    MAIL_TLS_ESTRICTO: "true", MAIL_DEBUG: "false", MAIL_SES_CONFIGURATION_SET: "config-prueba", ...env };
  const anteriores = Object.fromEntries(Object.keys(seguro).map(key => [key, process.env[key]]));
  Object.assign(process.env, seguro);
  try { return await fn(); }
  finally { for (const [key, valor] of Object.entries(anteriores)) if (valor === undefined) delete process.env[key]; else process.env[key] = valor; }
}

test("encola en la conexión del importador, normaliza email y no envía SMTP", async () => {
  let consulta;
  const id = await encolarBienvenida({ connection: { query: async (sql, params) => { consulta = { sql, params }; } },
    usuarioId: 10, para: " ANA@EXAMPLE.TEST ", nombre: "Ana", apellido: "Pérez" });
  assert.match(id, /^[a-f\d-]{36}$/);
  assert.deepEqual(consulta.params, [id, 10, "ana@example.test", "Ana Pérez"]);
  assert.equal(plantilla, undefined);
});

test("solo habilita bienvenidas con SMTP real, TLS estricto y sin depuración ni redirección", async () => {
  await conCorreo({}, () => assert.equal(bienvenidaDisponible(), true));
  for (const env of [{ MAIL_ENABLED: "false" }, { MAIL_TEST_MODE: "true" }, { MAIL_REDIRECT_TO: "prueba@example.test" },
    { MAIL_TLS_ESTRICTO: "false" }, { MAIL_DEBUG: "true" }, { MAIL_HOST: "" }]) {
    await conCorreo(env, () => assert.equal(bienvenidaDisponible(), false));
  }
});

test("la bienvenida usa el destinatario declarado, guía al código y etiqueta SES sin contraseña", async () => {
  await conCorreo({}, async () => {
    assert.equal((await enviarBienvenida(fila())).enviado, true);
    assert.equal(plantilla.para, "ana@example.test");
    assert.equal(plantilla.boton.url, "https://app.example.test/login");
    assert.match(plantilla.parrafos.join(" "), /Recibirás un código/);
    assert.equal(plantilla.encabezados["X-SES-MESSAGE-TAGS"], `bienvenida_id=${fila().id}`);
    assert.equal(plantilla.encabezados["X-SES-CONFIGURATION-SET"], "config-prueba");
    assert.equal(JSON.stringify(plantilla).includes("solo-pruebas"), false);
  });
});

test("SMTP apagado conserva pendientes sin abrir conexión; otra instancia con lock tampoco envía", async () => {
  assert.equal(await procesarBienvenidas({ db: { getConnection: () => assert.fail("no debe conectar") }, disponible: () => false }), 0);
  const fake = cola([fila()], { tomado: 0 });
  assert.equal(await procesarBienvenidas({ ...fake, disponible: () => true, enviar: () => assert.fail("no debe enviar") }), 0);
  assert.equal(fake.liberada, true);
});

test("envío aceptado guarda el identificador SES y un segundo pase no duplica el correo", async () => {
  const item = fila(); const fake = cola([item]); let enviados = 0;
  const opciones = { db: fake.db, disponible: () => true, enviar: async () => {
    assert.equal(item.procesando_en, "actual"); enviados += 1;
    return { enviado: true, respuesta: "250 Ok 0102019f-example-ses-id", messageId: "local@nodemailer" };
  } };
  assert.equal(await procesarBienvenidas(opciones), 1);
  assert.equal(await procesarBienvenidas(opciones), 0);
  assert.equal(enviados, 1); assert.equal(item.estado, "enviado");
  assert.equal(item.message_id, "0102019f-example-ses-id"); assert.equal(fake.liberada, true);
});

test("no envía si cambió el email, la cuenta está deshabilitada o tiene bloqueo total", async () => {
  for (const cambio of [{ email_actual: "otra@example.test" }, { habilitado: "N" }, { bloqueo_tipo: "total" }]) {
    const item = fila(cambio); const fake = cola([item]);
    await procesarBienvenidas({ db: fake.db, disponible: () => true, enviar: () => assert.fail("no debe enviar") });
    assert.equal(item.estado, "error");
  }
});

test("una caída incierta y un error SMTP quedan visibles, sin reintento automático", async () => {
  const incierto = fila({ procesando_en: "anterior" }); const fallido = fila({ id: "otro-id" });
  const fake = cola([incierto, fallido]); let intentos = 0;
  const opciones = { db: fake.db, disponible: () => true, enviar: async () => { intentos += 1; throw new Error("secreto SMTP"); } };
  await procesarBienvenidas(opciones); await procesarBienvenidas(opciones);
  assert.equal(intentos, 1); assert.equal(incierto.estado, "error"); assert.equal(fallido.estado, "error");
  assert.equal(fallido.detalle.includes("secreto SMTP"), false);
  assert.equal(resultadoEnvio({ enviado: true, rechazados: ["ana@example.test"] }).estado, "error");
});

test("no retrocede el estado si SNS confirma entrega antes de terminar SMTP", async () => {
  const item = fila(); const fake = cola([item]);
  await procesarBienvenidas({ db: fake.db, disponible: () => true, enviar: async () => {
    item.estado = "entregado"; item.message_id = "ses-event-id";
    return { enviado: true, respuesta: "250 Ok ses-event-id" };
  } });
  assert.equal(item.estado, "entregado"); assert.equal(item.message_id, "ses-event-id");
});

test("libera la conexión aunque falle la liberación del lock", async () => {
  const fake = cola([], { fallaLiberacion: true });
  await assert.rejects(procesarBienvenidas({ db: fake.db, disponible: () => true }), /liberacion_fallida/);
  assert.equal(fake.liberada, true);
});

function esquema() {
  const columnas = new Set(); const llamadas = []; let creada = false;
  return { llamadas, async query(sql) {
    llamadas.push(sql);
    if (/GET_LOCK/.test(sql)) return [[{ tomado: 1 }]];
    if (/RELEASE_LOCK/.test(sql)) return [[{ liberado: 1 }]];
    if (/information_schema.COLUMNS/.test(sql)) return [[...columnas].map(COLUMN_NAME => ({ COLUMN_NAME }))];
    const alter = /ALTER TABLE usuario ADD COLUMN (\w+)/.exec(sql);
    if (alter) { assert.equal(columnas.has(alter[1]), false); columnas.add(alter[1]); return [{}]; }
    if (/CREATE TABLE IF NOT EXISTS correo_bienvenida/.test(sql)) { creada = true; return [{}]; }
    if (/SHOW INDEX/.test(sql)) return [creada ? [{ Key_name: "uq_bienvenida_usuario", Non_unique: 0 }] : []];
    if (/SELECT id, usuario_id/.test(sql)) { assert.equal(creada, true); return [[]]; }
    if (/UPDATE usuario u INNER JOIN/.test(sql)) return [{ affectedRows: 1 }];
    assert.fail(`Consulta inesperada: ${sql}`);
  } };
}

test("migración repetible agrega columnas una vez y conserva evidencia histórica de sesiones y passkeys", async () => {
  const db = esquema(); await aplicarMigracion(db); await aplicarMigracion(db); await verificarEsquema(db);
  assert.equal(db.llamadas.filter(sql => /ALTER TABLE/.test(sql)).length, 2);
  assert.ok(db.llamadas.some(sql => /MIN\(creada_en\)/.test(sql) && /COALESCE\(u.primer_ingreso,s.primero\)/.test(sql)));
  assert.ok(db.llamadas.some(sql => /webauthn_credencial/.test(sql) && /LEAST\(/.test(sql) && /GREATEST\(/.test(sql)));
  assert.equal(db.llamadas.filter(sql => /RELEASE_LOCK/.test(sql)).length, 2);
});

test("migración falla cerrada si faltan columnas y no modifica esquema sin lock", async () => {
  await assert.rejects(verificarEsquema(esquema()), /Falta usuario.primer_ingreso/);
  let consultas = 0;
  await assert.rejects(aplicarMigracion({ query: async () => { consultas += 1; return [[{ tomado: 0 }]]; } }), /bloquear/);
  assert.equal(consultas, 1);
});

test("solo sesiones emitidas registran el primer ingreso, preservándolo en ingresos posteriores", async () => {
  const llamadas = []; const db = { query: async (sql, params) => { llamadas.push({ sql, params }); return [{ affectedRows: 1 }]; } };
  const opciones = { db, data: { id: 10, rol: "afiliado" }, password: "hash", jwtSecret: "secreto-de-prueba" };
  await crearSesion(opciones);
  const ingreso = llamadas.find(item => /UPDATE usuario SET primer_ingreso/.test(item.sql));
  assert.match(ingreso.sql, /primer_ingreso=COALESCE\(primer_ingreso,NOW\(6\)\)/);
  assert.match(ingreso.sql, /ultimo_ingreso=NOW\(6\)/); assert.deepEqual(ingreso.params, [10]);
  llamadas.length = 0;
  await assert.rejects(crearSesion({ ...opciones, jwtLib: { sign: (_p, _s, _o, cb) => cb(new Error("firma fallida")) } }), /firma fallida/);
  assert.equal(llamadas.some(item => /UPDATE usuario/.test(item.sql)), false);
  llamadas.length = 0;
  await assert.rejects(crearSesion({ ...opciones, data: { id: 10, bloqueo_tipo: "total" } }));
  assert.equal(llamadas.length, 0);
});
