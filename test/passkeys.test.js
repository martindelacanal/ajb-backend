"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const {
  crearLimitadorAnonimo,
  crearRouterWebAuthn,
} = require("../api/routes/webauthn");
const {
  ErrorOrigenWebAuthn,
  resolverContextoWebAuthn,
} = require("../api/security/webauthn-origen");

const ORIGEN = "https://portal.example.test";
const RP_ID = "portal.example.test";
const JWT_SECRET = "passkeys-test-secret";
const CEREMONIA_ID = "2ef17a96-499d-42a1-a6c2-ff41212b7007";

function filaAutorizacion() {
  return {
    id: 31,
    rol_id: 2,
    rol: "afiliado",
    departamental_id: 8,
    habilitado: "S",
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 1,
  };
}

function filaSesion() {
  return {
    ...filaAutorizacion(),
    nombre: "Ana",
    apellido: "Prueba",
    documento: 333333,
    email: "ana@example.test",
  };
}

function jwtFalso({ onSign } = {}) {
  return {
    verify(_token, _secret, callback) {
      callback(null, {
        data: JSON.stringify({
          id: 31,
          nombre: "Anterior",
          rol: "afiliado",
        }),
      });
    },
    sign(payload, secret, options, callback) {
      onSign?.({ payload, secret, options });
      callback(null, "jwt-passkey");
    },
  };
}

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

function crearApp({ db, webauthnLib, jwtLib = jwtFalso(), limitadorAnonimo } = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", crearRouterWebAuthn({
    db,
    webauthnLib,
    jwtLib,
    jwtSecret: JWT_SECRET,
    origenesPermitidos: new Set([ORIGEN]),
    randomUUID: () => CEREMONIA_ID,
    rpName: "Mi AJB Test",
    limitadorAnonimo: limitadorAnonimo || crearLimitadorAnonimo({ maxIntentos: 100 }),
  }));
  return app;
}

async function request(app, path, {
  method = "GET",
  body,
  token,
  origin,
  ip,
} = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {}),
        ...(ip ? { "x-forwarded-for": ip } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("deriva el rpID del Origin permitido y rechaza ausencia u origen inseguro", () => {
  assert.deepEqual(
    resolverContextoWebAuthn(
      { headers: { origin: `${ORIGEN}/ruta-ignorada` } },
      new Set([ORIGEN])
    ),
    { origen: ORIGEN, rpID: RP_ID }
  );
  assert.throws(
    () => resolverContextoWebAuthn({ headers: {} }, new Set([ORIGEN])),
    ErrorOrigenWebAuthn
  );
  assert.throws(
    () => resolverContextoWebAuthn(
      { headers: { origin: "http://portal.example.test" } },
      new Set(["http://portal.example.test"])
    ),
    ErrorOrigenWebAuthn
  );
});

test("authentication/options es username-less, persiste recordar y devuelve el contrato frontend", async () => {
  const consultas = [];
  let parametrosDesafio;
  let parametrosOpciones;
  const db = {
    async query(sql, params = []) {
      consultas.push({ sql, params });
      if (/INSERT INTO webauthn_desafio/i.test(sql)) parametrosDesafio = params;
      return [{ affectedRows: 1 }];
    },
  };
  const webauthnLib = {
    async generateAuthenticationOptions(params) {
      parametrosOpciones = params;
      return { challenge: "challenge-auth", rpId: params.rpID };
    },
  };
  const app = crearApp({ db, webauthnLib });

  const response = await request(app, "/api/passkeys/authentication/options", {
    method: "POST",
    origin: ORIGEN,
    body: { recordar: true },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ceremonia_id: CEREMONIA_ID,
    opciones: { challenge: "challenge-auth", rpId: RP_ID },
  });
  assert.deepEqual(parametrosOpciones, {
    rpID: RP_ID,
    timeout: 300000,
    userVerification: "required",
    allowCredentials: [],
  });
  assert.deepEqual(parametrosDesafio, [
    CEREMONIA_ID,
    "AUTENTICACION",
    null,
    "challenge-auth",
    null,
    ORIGEN,
    RP_ID,
    1,
  ]);
  assert.match(
    consultas.find(({ sql }) => /INSERT INTO webauthn_desafio/i.test(sql)).sql,
    /DATE_ADD\(NOW\(6\), INTERVAL 5 MINUTE\)/i
  );
  assert.ok(consultas.some(({ sql }) => /DELETE FROM webauthn_desafio/i.test(sql)));
});

test("un desafio se consume antes de verificar y no puede reutilizarse tras un fallo", async () => {
  let consumido = false;
  let verificaciones = 0;
  let conexiones = 0;
  const desafio = {
    id: CEREMONIA_ID,
    tipo: "AUTENTICACION",
    usuario_id: null,
    challenge: "challenge-auth",
    webauthn_usuario_id: null,
    origen: ORIGEN,
    rp_id: RP_ID,
    recordar: 0,
  };
  const connection = {
    async beginTransaction() {},
    async query(sql) {
      if (/SELECT c\.id AS webauthn_credencial_id/i.test(sql)) {
        return [[{
          ...filaSesion(),
          webauthn_credencial_id: 77,
          credential_id: "credencial_abc",
          clave_publica: Buffer.from([1, 2, 3]),
          contador: 2,
          transportes: "[]",
          webauthn_usuario_id: "usuario_web_31",
        }]];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const db = {
    async query(sql) {
      if (/UPDATE webauthn_desafio/i.test(sql)) {
        if (consumido) return [{ affectedRows: 0 }];
        consumido = true;
        return [{ affectedRows: 1 }];
      }
      if (/SELECT id, tipo, usuario_id, challenge/i.test(sql)) return [[desafio]];
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async getConnection() {
      conexiones += 1;
      return connection;
    },
  };
  const webauthnLib = {
    async verifyAuthenticationResponse() {
      verificaciones += 1;
      throw new Error("firma invalida");
    },
  };
  const app = crearApp({ db, webauthnLib });
  const body = {
    ceremonia_id: CEREMONIA_ID,
    respuesta: {
      id: "credencial_abc",
      response: { userHandle: "usuario_web_31" },
    },
  };

  const primera = await request(app, "/api/passkeys/authentication/verify", {
    method: "POST",
    origin: ORIGEN,
    body,
  });
  const segunda = await request(app, "/api/passkeys/authentication/verify", {
    method: "POST",
    origin: ORIGEN,
    body,
  });

  assert.equal(primera.status, 401);
  assert.equal(segunda.status, 401);
  assert.equal(primera.body, segunda.body);
  assert.equal(verificaciones, 1);
  assert.equal(conexiones, 1);
});

test("authentication/verify no enumera credenciales ni usuarios inhabilitados o sin rol", async (t) => {
  const casos = [
    { nombre: "credencial inexistente", fila: null },
    { nombre: "usuario inhabilitado", fila: { ...filaSesion(), habilitado: "N" } },
    { nombre: "rol excluido", fila: { ...filaSesion(), rol_id: 4 } },
  ];
  const respuestas = [];

  for (const caso of casos) {
    await t.test(caso.nombre, async () => {
      let verificaciones = 0;
      let rollback = false;
      const connection = {
        async beginTransaction() {},
        async query(sql) {
          if (/SELECT c\.id AS webauthn_credencial_id/i.test(sql)) {
            return caso.fila ? [[{
              ...caso.fila,
              webauthn_credencial_id: 77,
              credential_id: "credencial_abc",
              clave_publica: Buffer.from([1]),
              contador: 0,
              transportes: "[]",
              webauthn_usuario_id: "usuario_web_31",
            }]] : [[]];
          }
          throw new Error(`SQL inesperado: ${sql}`);
        },
        async rollback() { rollback = true; },
        release() {},
      };
      const db = {
        async query(sql) {
          if (/UPDATE webauthn_desafio/i.test(sql)) return [{ affectedRows: 1 }];
          if (/SELECT id, tipo, usuario_id, challenge/i.test(sql)) {
            return [[{
              id: CEREMONIA_ID,
              challenge: "challenge-auth",
              origen: ORIGEN,
              rp_id: RP_ID,
              recordar: 0,
            }]];
          }
          throw new Error(`SQL inesperado: ${sql}`);
        },
        async getConnection() { return connection; },
      };
      const app = crearApp({
        db,
        webauthnLib: {
          async verifyAuthenticationResponse() {
            verificaciones += 1;
            throw new Error("no deberia verificarse");
          },
        },
      });

      const response = await request(app, "/api/passkeys/authentication/verify", {
        method: "POST",
        origin: ORIGEN,
        body: {
          ceremonia_id: CEREMONIA_ID,
          respuesta: {
            id: "credencial_abc",
            response: { userHandle: "usuario_web_31" },
          },
        },
      });

      assert.equal(response.status, 401);
      assert.equal(verificaciones, 0);
      assert.equal(rollback, true);
      respuestas.push(response.body);
    });
  }

  assert.equal(new Set(respuestas).size, 1);
});

test("authentication/verify bloquea la credencial, actualiza contador y emite el JWT habitual", async () => {
  const eventos = [];
  let parametrosVerificacion;
  let firmaJwt;
  const desafio = {
    id: CEREMONIA_ID,
    challenge: "challenge-auth",
    origen: ORIGEN,
    rp_id: RP_ID,
    recordar: 1,
  };
  const credencial = {
    ...filaSesion(),
    webauthn_credencial_id: 77,
    credential_id: "credencial_abc",
    clave_publica: Buffer.from([1, 2, 3]),
    contador: 2,
    transportes: JSON.stringify(["internal"]),
    webauthn_usuario_id: "usuario_web_31",
  };
  const connection = {
    async beginTransaction() { eventos.push("begin"); },
    async query(sql, params = []) {
      if (/SELECT c\.id AS webauthn_credencial_id/i.test(sql)) {
        eventos.push("select-for-update");
        assert.match(sql, /FOR UPDATE/i);
        assert.deepEqual(params, ["credencial_abc", RP_ID]);
        return [[credencial]];
      }
      if (/UPDATE webauthn_credencial/i.test(sql)) {
        eventos.push("counter-update");
        assert.deepEqual(params, [9, "multiDevice", 1, 77]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async commit() { eventos.push("commit"); },
    async rollback() { eventos.push("rollback"); },
    release() { eventos.push("release"); },
  };
  const db = {
    async query(sql) {
      if (/UPDATE webauthn_desafio/i.test(sql)) return [{ affectedRows: 1 }];
      if (/SELECT id, tipo, usuario_id, challenge/i.test(sql)) return [[desafio]];
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async getConnection() { return connection; },
  };
  const webauthnLib = {
    async verifyAuthenticationResponse(params) {
      parametrosVerificacion = params;
      return {
        verified: true,
        authenticationInfo: {
          newCounter: 9,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
        },
      };
    },
  };
  const app = crearApp({
    db,
    webauthnLib,
    jwtLib: jwtFalso({ onSign: (params) => { firmaJwt = params; } }),
  });

  const response = await request(app, "/api/passkeys/authentication/verify", {
    method: "POST",
    origin: ORIGEN,
    body: {
      ceremonia_id: CEREMONIA_ID,
      respuesta: {
        id: "credencial_abc",
        response: { userHandle: "usuario_web_31" },
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.token, "jwt-passkey");
  assert.deepEqual(response.body.data, {
    id: 31,
    nombre: "Ana",
    apellido: "Prueba",
    documento: 333333,
    email: "ana@example.test",
    departamental_id: 8,
    rol: "afiliado",
    habilitado: "S",
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 1,
  });
  assert.equal(parametrosVerificacion.expectedChallenge, "challenge-auth");
  assert.equal(parametrosVerificacion.expectedOrigin, ORIGEN);
  assert.equal(parametrosVerificacion.expectedRPID, RP_ID);
  assert.equal(parametrosVerificacion.requireUserVerification, true);
  assert.equal(parametrosVerificacion.credential.counter, 2);
  assert.deepEqual(parametrosVerificacion.credential.transports, ["internal"]);
  assert.equal(firmaJwt.secret, JWT_SECRET);
  assert.equal(firmaJwt.options.expiresIn, "7d");
  assert.deepEqual(JSON.parse(firmaJwt.payload.data), response.body.data);
  assert.deepEqual(eventos, ["begin", "select-for-update", "counter-update", "commit", "release"]);
});

test("registration/options exige sesion actual y configura una passkey discoverable", async () => {
  let parametrosOpciones;
  let desafioGuardado;
  const db = {
    async query(sql, params = []) {
      if (esConsultaAutorizacion(sql)) return [[filaAutorizacion()]];
      if (/SELECT u\.id, u\.nombre, u\.apellido, u\.documento/i.test(sql)) {
        return [[filaSesion()]];
      }
      if (/SELECT rp_id, credential_id, transportes/i.test(sql)) {
        return [[{
          rp_id: RP_ID,
          credential_id: "ya_registrada",
          transportes: '["internal"]',
        }]];
      }
      if (/DELETE FROM webauthn_desafio/i.test(sql)) return [{ affectedRows: 0 }];
      if (/INSERT INTO webauthn_desafio/i.test(sql)) {
        desafioGuardado = params;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
  const webauthnLib = {
    async generateRegistrationOptions(params) {
      parametrosOpciones = params;
      return {
        challenge: "challenge-registro",
        user: { id: "usuario_web_31" },
      };
    },
  };
  const app = crearApp({ db, webauthnLib });

  const response = await request(app, "/api/passkeys/registration/options", {
    method: "POST",
    origin: ORIGEN,
    token: "sesion-valida",
    body: {},
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ceremonia_id, CEREMONIA_ID);
  assert.equal(response.body.opciones.challenge, "challenge-registro");
  assert.equal(parametrosOpciones.rpID, RP_ID);
  assert.equal(parametrosOpciones.rpName, "Mi AJB Test");
  assert.deepEqual(parametrosOpciones.userID, Buffer.from("miajb-usuario:31", "utf8"));
  assert.equal(parametrosOpciones.attestationType, "none");
  assert.deepEqual(parametrosOpciones.supportedAlgorithmIDs, [-7, -257]);
  assert.deepEqual(parametrosOpciones.authenticatorSelection, {
    residentKey: "required",
    userVerification: "required",
  });
  assert.deepEqual(parametrosOpciones.excludeCredentials, [{
    id: "ya_registrada",
    transports: ["internal"],
  }]);
  assert.deepEqual(desafioGuardado, [
    CEREMONIA_ID,
    "REGISTRO",
    31,
    "challenge-registro",
    "usuario_web_31",
    ORIGEN,
    RP_ID,
    0,
  ]);
});

test("registration/verify guarda la clave y devuelve metadata segura en castellano", async () => {
  const fecha = "2026-08-29T12:00:00.000Z";
  let parametrosInsert;
  let parametrosVerificacion;
  const eventos = [];
  const desafio = {
    id: CEREMONIA_ID,
    tipo: "REGISTRO",
    usuario_id: 31,
    challenge: "challenge-registro",
    webauthn_usuario_id: "usuario_web_31",
    origen: ORIGEN,
    rp_id: RP_ID,
    recordar: 0,
  };
  const connection = {
    async beginTransaction() { eventos.push("begin"); },
    async query(sql, params = []) {
      if (/SELECT id, rol_id, habilitado[\s\S]+FROM usuario/i.test(sql)) {
        eventos.push("usuario-lock");
        assert.match(sql, /FOR UPDATE/i);
        return [[{ id: 31, rol_id: 2, habilitado: "S" }]];
      }
      if (/SELECT COUNT\(\*\) AS total/i.test(sql)) {
        eventos.push("count");
        return [[{ total: 0 }]];
      }
      if (/INSERT INTO webauthn_credencial/i.test(sql)) {
        eventos.push("insert");
        parametrosInsert = params;
        return [{ insertId: 88, affectedRows: 1 }];
      }
      if (/SELECT id, nombre, rp_id, tipo_dispositivo/i.test(sql)) {
        eventos.push("metadata");
        return [[{
          id: 88,
          nombre: "Notebook Windows",
          rp_id: RP_ID,
          tipo_dispositivo: "singleDevice",
          respaldada: 0,
          fecha_creacion: fecha,
          fecha_ultimo_uso: null,
        }]];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async commit() { eventos.push("commit"); },
    async rollback() { eventos.push("rollback"); },
    release() { eventos.push("release"); },
  };
  const db = {
    async query(sql) {
      if (esConsultaAutorizacion(sql)) return [[filaAutorizacion()]];
      if (/UPDATE webauthn_desafio/i.test(sql)) return [{ affectedRows: 1 }];
      if (/SELECT id, tipo, usuario_id, challenge/i.test(sql)) return [[desafio]];
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async getConnection() { return connection; },
  };
  const webauthnLib = {
    async verifyRegistrationResponse(params) {
      parametrosVerificacion = params;
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: "credencial_nueva",
            publicKey: new Uint8Array([9, 8, 7]),
            counter: 0,
            transports: ["internal"],
          },
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
        },
      };
    },
  };
  const app = crearApp({ db, webauthnLib });

  const response = await request(app, "/api/passkeys/registration/verify", {
    method: "POST",
    origin: ORIGEN,
    token: "sesion-valida",
    body: {
      ceremonia_id: CEREMONIA_ID,
      respuesta: { id: "credencial_nueva", response: {} },
      nombre: "  Notebook   Windows  ",
    },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.body, {
    id: 88,
    nombre: "Notebook Windows",
    creada_en: fecha,
    ultimo_uso_en: null,
    tipo_dispositivo: "singleDevice",
    respaldada: false,
    dominio: RP_ID,
  });
  assert.equal(parametrosVerificacion.expectedChallenge, "challenge-registro");
  assert.equal(parametrosVerificacion.expectedOrigin, ORIGEN);
  assert.equal(parametrosVerificacion.expectedRPID, RP_ID);
  assert.equal(parametrosVerificacion.requireUserVerification, true);
  assert.deepEqual(parametrosVerificacion.supportedAlgorithmIDs, [-7, -257]);
  assert.equal(parametrosInsert[0], 31);
  assert.equal(parametrosInsert[1], RP_ID);
  assert.equal(parametrosInsert[2], "usuario_web_31");
  assert.equal(parametrosInsert[3], "credencial_nueva");
  assert.deepEqual(parametrosInsert[4], Buffer.from([9, 8, 7]));
  assert.equal(parametrosInsert[9], "Notebook Windows");
  assert.deepEqual(eventos, [
    "begin",
    "usuario-lock",
    "count",
    "insert",
    "metadata",
    "commit",
    "release",
  ]);
});

test("registration/verify revalida rol y limite bajo el lock del usuario", async (t) => {
  const casos = [
    {
      nombre: "rol cambiado a excluido",
      usuario: { id: 31, rol_id: 4, habilitado: "S" },
      total: 0,
      status: 403,
    },
    {
      nombre: "limite alcanzado por otra ceremonia",
      usuario: { id: 31, rol_id: 2, habilitado: "S" },
      total: 10,
      status: 409,
    },
  ];

  for (const caso of casos) {
    await t.test(caso.nombre, async () => {
      let inserciones = 0;
      let rollback = false;
      const connection = {
        async beginTransaction() {},
        async query(sql) {
          if (/SELECT id, rol_id, habilitado[\s\S]+FROM usuario/i.test(sql)) {
            assert.match(sql, /FOR UPDATE/i);
            return [[caso.usuario]];
          }
          if (/SELECT COUNT\(\*\) AS total/i.test(sql)) return [[{ total: caso.total }]];
          if (/INSERT INTO webauthn_credencial/i.test(sql)) {
            inserciones += 1;
            return [{ insertId: 99 }];
          }
          throw new Error(`SQL inesperado: ${sql}`);
        },
        async rollback() { rollback = true; },
        release() {},
      };
      const db = {
        async query(sql) {
          if (esConsultaAutorizacion(sql)) return [[filaAutorizacion()]];
          if (/UPDATE webauthn_desafio/i.test(sql)) return [{ affectedRows: 1 }];
          if (/SELECT id, tipo, usuario_id, challenge/i.test(sql)) {
            return [[{
              id: CEREMONIA_ID,
              tipo: "REGISTRO",
              usuario_id: 31,
              challenge: "challenge-registro",
              webauthn_usuario_id: "usuario_web_31",
              origen: ORIGEN,
              rp_id: RP_ID,
              recordar: 0,
            }]];
          }
          throw new Error(`SQL inesperado: ${sql}`);
        },
        async getConnection() { return connection; },
      };
      const app = crearApp({
        db,
        webauthnLib: {
          async verifyRegistrationResponse() {
            return {
              verified: true,
              registrationInfo: {
                credential: {
                  id: "credencial_nueva",
                  publicKey: new Uint8Array([1]),
                  counter: 0,
                  transports: ["internal"],
                },
                credentialDeviceType: "singleDevice",
                credentialBackedUp: false,
              },
            };
          },
        },
      });

      const response = await request(app, "/api/passkeys/registration/verify", {
        method: "POST",
        origin: ORIGEN,
        token: "sesion-valida",
        body: {
          ceremonia_id: CEREMONIA_ID,
          respuesta: { id: "credencial_nueva", response: {} },
        },
      });

      assert.equal(response.status, caso.status);
      assert.equal(inserciones, 0);
      assert.equal(rollback, true);
    });
  }
});

test("listado y borrado administran todas las passkeys propias sin depender de Origin", async () => {
  const consultas = [];
  const db = {
    async query(sql, params = []) {
      consultas.push({ sql, params });
      if (esConsultaAutorizacion(sql)) return [[filaAutorizacion()]];
      if (/SELECT id, nombre, rp_id, tipo_dispositivo/i.test(sql)) {
        return [[{
          id: 4,
          nombre: "iPhone",
          rp_id: "dominio-anterior.example",
          tipo_dispositivo: "multiDevice",
          respaldada: 1,
          fecha_creacion: "2026-08-01T10:00:00.000Z",
          fecha_ultimo_uso: null,
        }]];
      }
      if (/DELETE FROM webauthn_credencial/i.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
  const app = crearApp({ db, webauthnLib: {} });

  const listado = await request(app, "/api/passkeys", { token: "sesion-valida" });
  const borrado = await request(app, "/api/passkeys/4", {
    method: "DELETE",
    token: "sesion-valida",
  });

  assert.equal(listado.status, 200);
  assert.deepEqual(listado.body, [{
    id: 4,
    nombre: "iPhone",
    creada_en: "2026-08-01T10:00:00.000Z",
    ultimo_uso_en: null,
    tipo_dispositivo: "multiDevice",
    respaldada: true,
    dominio: "dominio-anterior.example",
  }]);
  assert.equal(borrado.status, 200);
  assert.deepEqual(borrado.body, { success: true });

  const consultaListado = consultas.find(({ sql }) => /FROM webauthn_credencial[\s\S]+ORDER BY/i.test(sql));
  assert.deepEqual(consultaListado.params, [31]);
  assert.doesNotMatch(consultaListado.sql, /rp_id\s*=\s*\?/i);
  const consultaBorrado = consultas.find(({ sql }) => /DELETE FROM webauthn_credencial/i.test(sql));
  assert.deepEqual(consultaBorrado.params, [4, 31]);
  assert.doesNotMatch(consultaBorrado.sql, /rp_id\s*=\s*\?/i);
});

test("el limitador anonimo devuelve 429 con Retry-After sin invocar el handler", async () => {
  let generadas = 0;
  const db = {
    async query() { return [{ affectedRows: 1 }]; },
  };
  const webauthnLib = {
    async generateAuthenticationOptions() {
      generadas += 1;
      return { challenge: `challenge-${generadas}` };
    },
  };
  const limitador = crearLimitadorAnonimo({ maxIntentos: 1, ventanaMs: 60000 });
  const app = crearApp({ db, webauthnLib, limitadorAnonimo: limitador });

  const primera = await request(app, "/api/passkeys/authentication/options", {
    method: "POST",
    origin: ORIGEN,
    body: {},
  });
  const segunda = await request(app, "/api/passkeys/authentication/options", {
    method: "POST",
    origin: ORIGEN,
    body: {},
  });

  assert.equal(primera.status, 200);
  assert.equal(segunda.status, 429);
  assert.ok(Number(segunda.headers.get("retry-after")) > 0);
  assert.equal(generadas, 1);
});
