"use strict";

// Cambios de datos de familiares pedidos por el afiliado, con aprobación de la
// departamental (services/familiares-cambios.js + routes/familiares-cambios.js)
// y los caminos viejos que ya no escriben directo (PUT /acompaniantes/:id,
// PUT /acompaniantes masivo y PUT /coseguro/familiares/:id/documento).
// Las consultas se simulan con una conexión falsa que responde por patrón.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "familiares-cambios-test-secret";
process.env.BUCKET_REGION ||= "us-east-1";
process.env.ACCESS_KEY ||= "test-access-key";
process.env.SECRET_ACCESS_KEY ||= "test-secret-key";

const {
  calcularDiferencias,
  normalizarDatosSolicitados,
  puedeGestionarSolicitud,
  validarReglasSolicitud,
  versionSolicitud,
} = require("../api/services/familiares-cambios");

// ---------------------------------------------------------------------------
// Datos de prueba
// ---------------------------------------------------------------------------
const OK = [{ affectedRows: 1, insertId: 1 }];
const CARGA_OBJETIVO = /^SELECT u\.\*, r\.nombre AS rol_nombre FROM usuario u LEFT JOIN rol r/;
const HOY = "2026-09-24";

function familiar(extra = {}) {
  return {
    id: 8,
    rol_id: 4,
    rol_nombre: "invitado",
    nombre: "Carla",
    apellido: "Ortega",
    documento: 40756125,
    fecha_nacimiento: "1972-01-03",
    telefono: "2213649350",
    tipo_persona_id: 2,
    parentesco_id: 4,
    es_familiar: "S",
    usuario_familiar_id: 2,
    departamental_id: 1,
    email: null,
    password: null,
    cuil: null,
    cbu: null,
    habilitado: "Y",
    ...extra,
  };
}

const USUARIOS = {
  1: { id: 1, nombre: "Nahuel", apellido: "Admin", rol_id: 1, departamental_id: null, usuario_familiar_id: null },
  2: { id: 2, nombre: "Nahuel", apellido: "Staffa", rol_id: 2, departamental_id: 1, usuario_familiar_id: null, departamental_nombre: "La Plata" },
  3: { id: 3, nombre: "Departamental", apellido: "Departamental", rol_id: 3, departamental_id: 1, usuario_familiar_id: null, departamental_nombre: "La Plata" },
  8: { id: 8, nombre: "Carla", apellido: "Ortega", rol_id: 4, departamental_id: 1, usuario_familiar_id: 2 },
  11: { id: 11, nombre: "Servicios", apellido: "Sociales", rol_id: 5, departamental_id: null, usuario_familiar_id: null },
  13: { id: 13, nombre: "Otra", apellido: "Sede", rol_id: 3, departamental_id: 2, usuario_familiar_id: null, departamental_nombre: "Azul" },
};

function filaSolicitud(extra = {}) {
  return {
    id: 7,
    persona_usuario_id: 8,
    solicitante_usuario_id: 2,
    departamental_id: 1,
    estado: "PENDIENTE",
    datos_anteriores: { documento: 40756125, telefono: "2213649350" },
    datos_propuestos: { documento: 40756126, telefono: "2215550000" },
    motivo_rechazo: null,
    resuelto_usuario_id: null,
    fecha_resolucion: null,
    fecha_creacion: "2026-09-24 10:00:00",
    fecha_modificacion: "2026-09-24 10:00:00",
    persona_nombre: "Carla",
    persona_apellido: "Ortega",
    persona_documento: 40756125,
    persona_es_familiar: "S",
    persona_usuario_familiar_id: 2,
    persona_rol_id: 4,
    persona_parentesco: "Familiar",
    solicitante_nombre: "Nahuel",
    solicitante_apellido: "Staffa",
    solicitante_documento: 333333,
    resuelto_nombre: null,
    resuelto_apellido: null,
    departamental_nombre: "La Plata",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Conexión falsa + app express
// ---------------------------------------------------------------------------
const sesiones = {
  1: { id: 1, rol_id: 1, rol: "admin", departamental_id: null },
  2: { id: 2, rol_id: 2, rol: "afiliado", departamental_id: 1 },
  3: { id: 3, rol_id: 3, rol: "departamental", departamental_id: 1 },
  11: { id: 11, rol_id: 5, rol: "admin-central", departamental_id: null },
  13: { id: 13, rol_id: 3, rol: "departamental", departamental_id: 2 },
};
let sesionExtra = {};
let manejadorRutas = async (sql) => { throw new Error(`Consulta inesperada: ${sql}`); };
const llamadas = [];
let commits = 0;
let rollbacks = 0;

function esConsultaSesion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

async function consultar(sql, params = []) {
  const texto = String(sql).replace(/\s+/g, " ").trim();
  llamadas.push({ sql: texto, params });
  if (esConsultaSesion(texto)) {
    const sesion = sesiones[params[0]];
    return [[{
      habilitado: "Y", area_turismo: 1, area_coseguro: 1, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1,
      ...sesion,
      ...(sesionExtra[params[0]] || {}),
    }]];
  }
  return manejadorRutas(texto, params);
}

const conexionTransaccional = {
  query: consultar,
  execute: consultar,
  async beginTransaction() {},
  async commit() { commits += 1; },
  async rollback() { rollbacks += 1; },
  release() {},
};
const rutaConexion = require.resolve("../api/connection/connection");
require.cache[rutaConexion] = {
  id: rutaConexion,
  filename: rutaConexion,
  loaded: true,
  exports: {
    promise() {
      return { query: consultar, execute: consultar, getConnection: async () => conexionTransaccional };
    },
  },
};

const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/familiares-cambios"));
app.use("/api", require("../api/routes/user"));
app.use("/api", require("../api/routes/coseguro"));

const consoleWarnOriginal = console.warn;
const consoleErrorOriginal = console.error;
test.before(() => {
  console.warn = () => {};
  console.error = () => {};
});
test.after(() => {
  console.warn = consoleWarnOriginal;
  console.error = consoleErrorOriginal;
});

// Respuestas comunes a casi todos los casos (las del test van primero).
const COMUNES = [
  [/^SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = \?$/, (_sql, [id]) => [[USUARIOS[id]].filter(Boolean)]],
  [/^SELECT u\.id, u\.nombre, u\.apellido, u\.rol_id, u\.departamental_id, d\.nombre AS departamental_nombre/, (_sql, [id]) => [[USUARIOS[id]]]],
  [/WHERE r\.nombre = 'departamental' AND u\.departamental_id = \? AND u\.habilitado = 'Y'/, (_sql, [dep]) => [
    dep === 1 ? [{ id: 3 }] : dep === 2 ? [{ id: 13 }] : [],
  ]],
  [/^INSERT INTO notificacion/, OK],
  [/^UPDATE notificacion SET leida = 1, fecha_lectura = NOW\(\) WHERE tipo = \?/, OK],
  [/^SELECT id FROM tipo_persona WHERE id = \?/, (_sql, [id]) => [[{ id }]]],
  [/^SELECT id FROM parentesco WHERE id = \?/, (_sql, [id]) => [[{ id }]]],
  [/^SELECT id, nombre FROM tipo_persona/, [[{ id: 1, nombre: "Afiliados" }, { id: 2, nombre: "Invitados familiares" }, { id: 5, nombre: "Menores de 2 años" }]]],
  [/^SELECT id, nombre FROM parentesco/, [[{ id: 2, nombre: "Pareja" }, { id: 3, nombre: "Hijo" }, { id: 4, nombre: "Familiar" }, { id: 5, nombre: "Otro" }]]],
  [/JSON_EXTRACT\(datos_propuestos, '\$\.documento'\)/, [[]]],
  [/^SELECT id FROM usuario WHERE documento = \? AND id <> \?/, [[]]],
];

function preparar(manejadores = [], { sesion = {} } = {}) {
  llamadas.length = 0;
  commits = 0;
  rollbacks = 0;
  sesionExtra = sesion;
  const todos = [...manejadores, ...COMUNES];
  manejadorRutas = async (sql, params) => {
    for (const [patron, respuesta] of todos) {
      if (patron.test(sql)) return typeof respuesta === "function" ? respuesta(sql, params) : respuesta;
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

async function pedir(ruta, { usuario, method = "GET", body } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify(sesiones[usuario]) }, process.env.JWT_SECRET);
    const respuesta = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const texto = await respuesta.text();
    return { status: respuesta.status, body: texto ? JSON.parse(texto) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function consultas(patron) {
  return llamadas.filter(({ sql }) => patron.test(sql));
}

function notificaciones() {
  return consultas(/^INSERT INTO notificacion/).map(({ params }) => ({
    usuario_id: params[0],
    tipo: params[1],
    titulo: params[2],
    mensaje: params[3],
    payload: JSON.parse(params[4]),
  }));
}

const UNIVERSO = /^SELECT u\.id FROM usuario u WHERE u\.id = \? AND u\.id <> \?/;
// El pedido pendiente se busca SIN bloquear (evita gap locks) y se bloquea por PK.
const PENDIENTE_PERSONA = /^SELECT id FROM familiar_cambio_solicitud WHERE pendiente_persona = \?$/;
const PENDIENTE_BLOQUEADO = /^SELECT id, solicitante_usuario_id, datos_propuestos, estado FROM familiar_cambio_solicitud WHERE (id|pendiente_persona) = \? FOR UPDATE$/;
const INSERT_SOLICITUD = /^INSERT INTO familiar_cambio_solicitud/;
const LEER_SOLICITUD = /FROM familiar_cambio_solicitud f INNER JOIN usuario p/;
const BLOQUEAR_SOLICITUD = /^SELECT id, persona_usuario_id, solicitante_usuario_id, departamental_id, estado, datos_anteriores, datos_propuestos FROM familiar_cambio_solicitud WHERE id = \? FOR UPDATE/;
// La resolución exige la versión del pedido que se revisó.
const VERSION_7 = versionSolicitud(filaSolicitud().datos_propuestos);

function manejadoresAlta({ universo = true, persona = familiar(), pendiente = null, insertId = 7 } = {}) {
  return [
    [UNIVERSO, [universo ? [{ id: persona.id }] : []]],
    [CARGA_OBJETIVO, [[persona]]],
    [PENDIENTE_PERSONA, [pendiente ? [{ id: pendiente.id }] : []]],
    [PENDIENTE_BLOQUEADO, [pendiente ? [{ estado: "PENDIENTE", ...pendiente }] : []]],
    [INSERT_SOLICITUD, [{ affectedRows: 1, insertId }]],
    [/^UPDATE familiar_cambio_solicitud SET datos_anteriores/, OK],
  ];
}

const FORMULARIO_CARLA = {
  tipo_persona_id: 2,
  parentesco_id: 4,
  nombre: "Carla",
  apellido: "Ortega",
  documento: "40756126",
  fecha_nacimiento: "1972-01-03",
  telefono: "2215550000",
  password: "no-se-usa",
};

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------
test("normalizar y diferenciar: sólo quedan los campos que cambian, con el DNI de 6 a 8 dígitos", () => {
  const persona = familiar();
  const normalizados = normalizarDatosSolicitados(
    { ...FORMULARIO_CARLA, documento: "40.756.126", fecha_nacimiento: "1972-01-03" },
    persona,
    { hoy: HOY }
  );
  const { anteriores, propuestos, campos } = calcularDiferencias(persona, normalizados);
  assert.deepEqual(campos, ["documento", "telefono"]);
  assert.deepEqual(propuestos, { documento: 40756126, telefono: "2215550000" });
  assert.deepEqual(anteriores, { documento: 40756125, telefono: "2213649350" });

  assert.throws(
    () => normalizarDatosSolicitados({ documento: "123456789" }, persona, { hoy: HOY }),
    (error) => error.statusCode === 400 && error.campo === "documento"
  );
  // Un dato viejo inválido reenviado tal cual no bloquea el pedido.
  const conTelefonoViejo = familiar({ telefono: "0221-15-4444-5555-9" });
  assert.deepEqual(
    normalizarDatosSolicitados({ telefono: "0221-15-4444-5555-9", nombre: "Carlita" }, conTelefonoViejo, { hoy: HOY }),
    { nombre: "Carlita" }
  );
});

test("reglas de tipo de persona, parentesco y grupo familiar", () => {
  const persona = familiar();
  const falla = (propuestos, codigo, objetivo = persona) => assert.throws(
    () => validarReglasSolicitud({ persona: objetivo, propuestos, hoy: HOY }),
    (error) => error.codigo === codigo
  );
  falla({ tipo_persona_id: 5 }, "TIPO_PERSONA_EDAD_INCONSISTENTE");
  falla({ fecha_nacimiento: "2025-07-09" }, "TIPO_PERSONA_EDAD_INCONSISTENTE");
  falla({ tipo_persona_id: 1 }, "TIPO_PERSONA_NO_VERIFICADO");
  falla({ parentesco_id: 1 }, "PARENTESCO_TITULAR_INVALIDO");
  falla({ parentesco_id: 5 }, "TIPO_PERSONA_PARENTESCO_INCONSISTENTE");
  falla({ parentesco_id: 5, tipo_persona_id: 3 }, "GRUPO_FAMILIAR_INVALIDO");
  falla({ documento: null }, "DATO_INVALIDO");
  // Un acompañante (no integra el grupo) sí puede pasar a "Otro" con tipo invitado general.
  const acompaniante = familiar({ es_familiar: "N", tipo_persona_id: 3, parentesco_id: 2 });
  assert.doesNotThrow(() => validarReglasSolicitud({ persona: acompaniante, propuestos: { parentesco_id: 5 }, hoy: HOY }));
  // Menor de 2 con tipo 5: válido.
  assert.doesNotThrow(() => validarReglasSolicitud({
    persona: familiar({ tipo_persona_id: 5, parentesco_id: 3, fecha_nacimiento: "2025-07-09" }),
    propuestos: { nombre: "Walter" },
    hoy: HOY,
  }));
});

test("permisos de la bandeja: admin y admin-central todo, departamental sólo su sede", () => {
  const solicitud = { departamental_id: 1 };
  assert.equal(puedeGestionarSolicitud({ id: 1, rol: "admin" }, solicitud), true);
  assert.equal(puedeGestionarSolicitud({ id: 11, rol: "admin-central" }, solicitud), true);
  assert.equal(puedeGestionarSolicitud({ id: 3, rol: "departamental", departamental_id: 1 }, solicitud), true);
  assert.equal(puedeGestionarSolicitud({ id: 13, rol: "departamental", departamental_id: 2 }, solicitud), false);
  assert.equal(puedeGestionarSolicitud({ id: 2, rol: "afiliado", departamental_id: 1 }, solicitud), false);
  assert.equal(puedeGestionarSolicitud({ id: 12, rol: "auditor" }, solicitud), false);
});

// ---------------------------------------------------------------------------
// Pedido del afiliado
// ---------------------------------------------------------------------------
test("POST /familiares/:id/cambios: crea la solicitud sin tocar usuario y avisa sólo a la departamental", async () => {
  preparar(manejadoresAlta());
  const respuesta = await pedir("/api/familiares/8/cambios", { usuario: 2, method: "POST", body: FORMULARIO_CARLA });

  assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.pendiente, true);
  assert.equal(respuesta.body.solicitud_id, 7);
  assert.equal(respuesta.body.codigo, "FC-7");
  assert.equal(respuesta.body.reemplazada, false);
  assert.deepEqual(respuesta.body.campos, ["documento", "telefono"]);
  assert.deepEqual(respuesta.body.datos_propuestos, { documento: 40756126, telefono: "2215550000" });
  assert.equal(respuesta.body.notificados, 1);
  assert.equal(commits, 1);

  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  const [insercion] = consultas(INSERT_SOLICITUD);
  assert.deepEqual(insercion.params.slice(0, 3), [8, 2, 1]);
  assert.deepEqual(JSON.parse(insercion.params[3]), { documento: 40756125, telefono: "2213649350" });

  const [destinatarios] = consultas(/WHERE r\.nombre = 'departamental'/);
  assert.deepEqual(destinatarios.params, [1]);
  assert.doesNotMatch(destinatarios.sql, /admin/);
  const avisos = notificaciones();
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].usuario_id, 3);
  assert.equal(avisos[0].tipo, "FAMILIAR_CAMBIO_SOLICITADO");
  assert.equal(avisos[0].titulo, "Nahuel Staffa pidió actualizar los datos de Carla Ortega");
  assert.match(avisos[0].mensaje, /FC-7 · DNI: 40756125 → 40756126; Teléfono: 2213649350 → 2215550000/);
  assert.deepEqual(avisos[0].payload, { solicitud_id: 7, persona_id: 8 });
});

test("si ya hay una pendiente, la reemplaza (UPDATE), conserva lo pedido que no vino y vuelve a notificar", async () => {
  preparar(manejadoresAlta({
    pendiente: { id: 5, solicitante_usuario_id: 2, datos_propuestos: JSON.stringify({ telefono: "2215550000" }) },
  }));
  const respuesta = await pedir("/api/familiares/8/cambios", { usuario: 2, method: "POST", body: { documento: "40756126" } });

  assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.solicitud_id, 5);
  assert.equal(respuesta.body.reemplazada, true);
  assert.equal(consultas(INSERT_SOLICITUD).length, 0);
  const [actualizacion] = consultas(/^UPDATE familiar_cambio_solicitud SET datos_anteriores/);
  assert.deepEqual(JSON.parse(actualizacion.params[1]), { documento: 40756126, telefono: "2215550000" });
  assert.equal(actualizacion.params[3], 5);
  const [aviso] = notificaciones();
  assert.equal(aviso.titulo, "Nahuel Staffa actualizó su pedido de cambios de Carla Ortega");
  // El aviso anterior de la misma solicitud queda leído (no se acumulan en la campana).
  const [viejos] = consultas(/^UPDATE notificacion SET leida = 1/);
  assert.deepEqual(viejos.params, ["FAMILIAR_CAMBIO_SOLICITADO", 5]);
  // La búsqueda de DNI en otros pedidos excluye al propio.
  const [otrosPedidos] = consultas(/JSON_EXTRACT/);
  assert.deepEqual(otrosPedidos.params, [8, 5, 40756126]);
});

test("DNI de otra persona: 409 DNI_DUPLICADO sin nombrarla y sin crear nada", async () => {
  preparar([
    [/^SELECT id FROM usuario WHERE documento = \? AND id <> \?/, [[{ id: 22 }]]],
    ...manejadoresAlta(),
  ]);
  const respuesta = await pedir("/api/familiares/8/cambios", { usuario: 2, method: "POST", body: { documento: "20111222" } });

  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "DNI_DUPLICADO");
  assert.equal(respuesta.body.campo, "documento");
  assert.equal(respuesta.body.usuario_existente_id, undefined);
  assert.doesNotMatch(respuesta.body.message, /22|Acompañante/);
  assert.equal(consultas(INSERT_SOLICITUD).length, 0);
  assert.equal(notificaciones().length, 0);
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
});

test("persona fuera del universo del afiliado: 403 sin leer ni bloquear su ficha", async () => {
  preparar(manejadoresAlta({ universo: false }));
  const respuesta = await pedir("/api/familiares/2/cambios", { usuario: 2, method: "POST", body: { telefono: "1" } });
  assert.equal(respuesta.status, 400); // el propio afiliado usa Mi perfil

  preparar(manejadoresAlta({ universo: false }));
  const ajena = await pedir("/api/familiares/99/cambios", { usuario: 2, method: "POST", body: { telefono: "2215550000" } });
  assert.equal(ajena.status, 403);
  assert.equal(ajena.body.codigo, "PERSONA_FUERA_DEL_GRUPO");
  assert.equal(consultas(CARGA_OBJETIVO).length, 0);
  assert.equal(consultas(INSERT_SOLICITUD).length, 0);
});

test("sin diferencias → 400 SIN_CAMBIOS; staff no puede pedir por este camino", async () => {
  preparar(manejadoresAlta());
  const igual = await pedir("/api/familiares/8/cambios", {
    usuario: 2,
    method: "POST",
    body: { ...FORMULARIO_CARLA, documento: "40756125", telefono: "2213649350" },
  });
  assert.equal(igual.status, 400);
  assert.equal(igual.body.codigo, "SIN_CAMBIOS");
  assert.equal(consultas(INSERT_SOLICITUD).length, 0);

  preparar(manejadoresAlta());
  const staff = await pedir("/api/familiares/8/cambios", { usuario: 3, method: "POST", body: { telefono: "2215550000" } });
  assert.equal(staff.status, 403);
});

test("regla de edad al pedir: un adulto no puede pasar a Menores de 2 años", async () => {
  preparar(manejadoresAlta());
  const respuesta = await pedir("/api/familiares/8/cambios", {
    usuario: 2,
    method: "POST",
    body: { ...FORMULARIO_CARLA, documento: "40756125", tipo_persona_id: 5 },
  });
  assert.equal(respuesta.status, 422);
  assert.equal(respuesta.body.codigo, "TIPO_PERSONA_EDAD_INCONSISTENTE");
  assert.equal(respuesta.body.campo, "tipo_persona_id");
});

test("DELETE /familiares/cambios/:id: el afiliado retira su pedido pendiente", async () => {
  preparar([
    [/^SELECT id, solicitante_usuario_id, persona_usuario_id, estado FROM familiar_cambio_solicitud WHERE id = \? FOR UPDATE/, [[{
      id: 7, solicitante_usuario_id: 2, persona_usuario_id: 8, estado: "PENDIENTE",
    }]]],
    [/^UPDATE familiar_cambio_solicitud SET estado = 'CANCELADA'/, OK],
  ]);
  const respuesta = await pedir("/api/familiares/cambios/7", { usuario: 2, method: "DELETE" });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.estado, "CANCELADA");
  assert.deepEqual(consultas(/^UPDATE familiar_cambio_solicitud SET estado = 'CANCELADA'/)[0].params, [2, 7]);

  preparar([
    [/^SELECT id, solicitante_usuario_id, persona_usuario_id, estado FROM familiar_cambio_solicitud WHERE id = \? FOR UPDATE/, [[{
      id: 7, solicitante_usuario_id: 10, persona_usuario_id: 8, estado: "PENDIENTE",
    }]]],
  ]);
  const ajena = await pedir("/api/familiares/cambios/7", { usuario: 2, method: "DELETE" });
  assert.equal(ajena.status, 404);
});

// ---------------------------------------------------------------------------
// Bandeja y detalle del staff
// ---------------------------------------------------------------------------
test("GET /familiares/cambios: la departamental sólo ve su sede y recibe conteos por estado", async () => {
  preparar([
    [/^SELECT f\.id, f\.persona_usuario_id[\s\S]+LIMIT \? OFFSET \?$/, [[filaSolicitud()]]],
    [/^SELECT COUNT\(\*\) AS total FROM familiar_cambio_solicitud f/, [[{ total: 1 }]]],
    [/^SELECT f\.estado, COUNT\(\*\) AS cantidad/, [[{ estado: "PENDIENTE", cantidad: 1 }, { estado: "RECHAZADA", cantidad: 2 }]]],
  ]);
  const respuesta = await pedir("/api/familiares/cambios?estado=PENDIENTE&search=carla", { usuario: 13 });
  assert.equal(respuesta.status, 200);
  const [listado] = consultas(/LIMIT \? OFFSET \?$/);
  assert.match(listado.sql, /f\.departamental_id = \?/);
  assert.equal(listado.params[0], 2);
  assert.ok(listado.params.includes("PENDIENTE"));
  assert.deepEqual(respuesta.body.conteos, { PENDIENTE: 1, APROBADA: 0, RECHAZADA: 2, CANCELADA: 0, TOTAL: 3 });
  const [item] = respuesta.body.results;
  assert.equal(item.codigo, "FC-7");
  assert.equal(item.persona.vinculo, "FAMILIAR");
  assert.deepEqual(item.cambios.map(({ campo, anterior_texto, nuevo_texto }) => [campo, anterior_texto, nuevo_texto]), [
    ["documento", "40756125", "40756126"],
    ["telefono", "2213649350", "2215550000"],
  ]);

  preparar([]);
  const afiliado = await pedir("/api/familiares/cambios", { usuario: 2 });
  assert.equal(afiliado.status, 403);
});

test("detalle: departamental de otra sede no lo ve; la propia recibe advertencias para decidir", async () => {
  preparar([[LEER_SOLICITUD, [[filaSolicitud()]]]]);
  const ajena = await pedir("/api/familiares/cambios/7", { usuario: 13 });
  assert.equal(ajena.status, 403);

  preparar([
    [LEER_SOLICITUD, [[filaSolicitud()]]],
    [CARGA_OBJETIVO, [[familiar({ telefono: "2219999999" })]]],
    [/FROM reserva_familiar rf INNER JOIN reserva r/, [[{ id: 29, estado_reserva_id: 2, estado_nombre: "Verificada", fecha_inicio: "2026-12-01", fecha_fin: "2026-12-08" }]]],
    [/FROM coseguro_solicitud WHERE \(usuario_id = \? OR familiar_usuario_id = \?\)/, [[{ id: 40, estado_id: 2 }]]],
  ]);
  const propia = await pedir("/api/familiares/cambios/7", { usuario: 3 });
  assert.equal(propia.status, 200);
  const codigos = propia.body.data.advertencias.map(({ codigo }) => codigo);
  assert.deepEqual(codigos, ["FICHA_MODIFICADA", "RESERVAS_ABIERTAS", "COSEGURO_EN_CURSO"]);
  assert.equal(propia.body.data.ficha_actual.telefono, "2219999999");
  assert.equal(propia.body.data.puede_resolver, true);
});

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------
function manejadoresResolucion({ solicitud = filaSolicitud(), persona = familiar(), bloqueada = null } = {}) {
  return [
    [LEER_SOLICITUD, [[solicitud]]],
    [CARGA_OBJETIVO, [[persona]]],
    [BLOQUEAR_SOLICITUD, [[bloqueada || solicitud]]],
    [/^SELECT id FROM usuario WHERE documento = \? AND id <> \? LIMIT 1 FOR UPDATE/, [[]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/FROM olimpiada_bono b/, [[]]],
    [/^SELECT id FROM usuario WHERE usuario_familiar_id = \?/, [[]]],
    [/FROM olimpiada_inscripcion_acompaniante a/, [[]]],
    [/^UPDATE familiar_cambio_solicitud SET estado = 'APROBADA'/, OK],
    [/^UPDATE familiar_cambio_solicitud SET estado = 'RECHAZADA'/, OK],
  ];
}

test("aprobar aplica los cambios con el aprobador como actor, deja historial y avisa al afiliado", async () => {
  preparar(manejadoresResolucion());
  const respuesta = await pedir("/api/familiares/cambios/7/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "APROBAR", version: VERSION_7 },
  });

  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.estado, "APROBADA");
  assert.equal(respuesta.body.forzada, false);
  assert.deepEqual(respuesta.body.cambios.map(({ campo }) => campo), ["documento", "telefono"]);
  assert.equal(commits, 1);

  const [actualizacion] = consultas(/^UPDATE usuario SET/);
  assert.equal(actualizacion.sql, "UPDATE usuario SET documento = ?, telefono = ? WHERE id = ?");
  assert.deepEqual(actualizacion.params, [40756126, "2215550000", 8]);
  const historial = consultas(/^INSERT INTO historial_usuario/);
  assert.equal(historial.length, 2);
  assert.deepEqual(historial[0].params.slice(0, 7), [8, "UPDATE", "documento", 40756125, 40756126, "usuario", 3]);
  assert.equal(historial[0].params[9], "Solicitado por Nahuel Staffa (FC-7), aprobado por Departamental Departamental");
  assert.deepEqual(consultas(/^UPDATE familiar_cambio_solicitud SET estado = 'APROBADA'/)[0].params, [3, 7]);
  assert.deepEqual(consultas(/^UPDATE notificacion SET leida = 1/)[0].params, ["FAMILIAR_CAMBIO_SOLICITADO", 7]);

  const avisos = notificaciones();
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].usuario_id, 2);
  assert.equal(avisos[0].tipo, "FAMILIAR_CAMBIO_APROBADO");
  assert.equal(avisos[0].titulo, "Se aprobaron los cambios de Carla Ortega");
  assert.match(avisos[0].mensaje, /Departamental Departamental \(departamental La Plata\) aprobó el cambio de DNI y teléfono \(FC-7\)/);
  assert.deepEqual(avisos[0].payload, { solicitud_id: 7, persona_id: 8 });
});

test("aprobar cuando la ficha cambió desde el pedido: 409 FICHA_MODIFICADA salvo forzar", async () => {
  const persona = familiar({ telefono: "2219999999" });
  preparar(manejadoresResolucion({ persona }));
  const bloqueada = await pedir("/api/familiares/cambios/7/resolucion", {
    usuario: 11,
    method: "POST",
    body: { accion: "APROBAR", version: VERSION_7 },
  });
  assert.equal(bloqueada.status, 409);
  assert.equal(bloqueada.body.codigo, "FICHA_MODIFICADA");
  assert.deepEqual(bloqueada.body.campos, ["telefono"]);
  assert.equal(consultas(/^UPDATE usuario SET/).length, 0);
  assert.equal(rollbacks, 1);

  preparar(manejadoresResolucion({ persona }));
  const forzada = await pedir("/api/familiares/cambios/7/resolucion", {
    usuario: 11,
    method: "POST",
    body: { accion: "APROBAR", forzar: true, version: VERSION_7 },
  });
  assert.equal(forzada.status, 200, JSON.stringify(forzada.body));
  assert.equal(forzada.body.forzada, true);
  const historial = consultas(/^INSERT INTO historial_usuario/);
  assert.match(historial[0].params[9], /aprobado por Servicios Sociales\. Se aplicó aunque la ficha había cambiado/);
});

test("rechazar exige motivo y avisa al afiliado con el motivo, sin tocar la ficha", async () => {
  preparar(manejadoresResolucion());
  const sinMotivo = await pedir("/api/familiares/cambios/7/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "RECHAZAR", motivo: "  ", version: VERSION_7 },
  });
  assert.equal(sinMotivo.status, 400);
  assert.equal(sinMotivo.body.codigo, "MOTIVO_OBLIGATORIO");
  assert.equal(consultas(LEER_SOLICITUD).length, 0);

  preparar(manejadoresResolucion());
  const respuesta = await pedir("/api/familiares/cambios/7/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "RECHAZAR", motivo: "El DNI no coincide con la copia que presentaste", version: VERSION_7 },
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.estado, "RECHAZADA");
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  assert.deepEqual(
    consultas(/^UPDATE familiar_cambio_solicitud SET estado = 'RECHAZADA'/)[0].params,
    ["El DNI no coincide con la copia que presentaste", 3, 7]
  );
  const [aviso] = notificaciones();
  assert.equal(aviso.usuario_id, 2);
  assert.equal(aviso.tipo, "FAMILIAR_CAMBIO_RECHAZADO");
  assert.match(aviso.mensaje, /Motivo: El DNI no coincide con la copia que presentaste/);
});

test("departamental de otra sede no resuelve; un pedido ya resuelto da 409", async () => {
  preparar(manejadoresResolucion());
  const ajena = await pedir("/api/familiares/cambios/7/resolucion", {
    usuario: 13,
    method: "POST",
    body: { accion: "APROBAR", version: VERSION_7 },
  });
  assert.equal(ajena.status, 403);
  assert.equal(consultas(CARGA_OBJETIVO).length, 0);
  assert.equal(notificaciones().length, 0);

  preparar(manejadoresResolucion({ bloqueada: filaSolicitud({ estado: "CANCELADA" }) }));
  const resuelta = await pedir("/api/familiares/cambios/7/resolucion", {
    usuario: 1,
    method: "POST",
    body: { accion: "APROBAR", version: VERSION_7 },
  });
  assert.equal(resuelta.status, 409);
  assert.equal(resuelta.body.codigo, "SOLICITUD_YA_RESUELTA");
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
});

// ---------------------------------------------------------------------------
// Caminos viejos del afiliado que ya no escriben directo
// ---------------------------------------------------------------------------
test("PUT /acompaniantes/:id del afiliado ya no actualiza: crea el pedido pendiente (202)", async () => {
  preparar(manejadoresAlta());
  const respuesta = await pedir("/api/acompaniantes/8", { usuario: 2, method: "PUT", body: FORMULARIO_CARLA });
  assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.pendiente, true);
  assert.equal(respuesta.body.solicitud_id, 7);
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  assert.equal(consultas(/^INSERT INTO historial_usuario/).length, 0);
  assert.equal(consultas(INSERT_SOLICITUD).length, 1);
});

test("PUT /acompaniantes masivo del afiliado no cambia personas existentes y dice cuáles ignoró", async () => {
  preparar([
    [/^SELECT \* FROM usuario WHERE documento = \?/, [[familiar()]]],
  ]);
  const respuesta = await pedir("/api/acompaniantes", {
    usuario: 2,
    method: "PUT",
    body: {
      usuarioId: 2,
      personas: [{
        nombre: "Carlita", apellido: "Ortega", dni: "40756125", fechaNacimiento: "1972-01-03",
        telefono: "2215550000", tipoPersonaId: 2, parentescoId: 4,
      }],
    },
  });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.success, false);
  assert.equal(respuesta.body.actualizadas, 0);
  assert.deepEqual(respuesta.body.ignoradas, [{
    persona_id: 8, dni: "40756125", nombre: "Carla", apellido: "Ortega", campos: ["nombre", "telefono"],
  }]);
  assert.match(respuesta.body.message, /Familiares y acompañantes/);
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  assert.equal(consultas(/^INSERT INTO historial_usuario/).length, 0);
});

test("PUT /coseguro/familiares/:id/documento del afiliado deja el DNI en revisión (202) sin escribirlo", async () => {
  preparar([
    [/^SELECT id, nombre, usuario_familiar_id FROM usuario WHERE id = \?/, [[{ id: 8, nombre: "Carla", usuario_familiar_id: 2 }]]],
    ...manejadoresAlta(),
  ]);
  const respuesta = await pedir("/api/coseguro/familiares/8/documento", {
    usuario: 2,
    method: "PUT",
    body: { documento: "40.756.126" },
  });
  assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.pendiente, true);
  assert.match(respuesta.body.message, /Enviamos el DNI de Carla a tu departamental/);
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  const [insercion] = consultas(INSERT_SOLICITUD);
  assert.deepEqual(JSON.parse(insercion.params[4]), { documento: 40756126 });

  preparar([]);
  const nueve = await pedir("/api/coseguro/familiares/8/documento", {
    usuario: 2,
    method: "PUT",
    body: { documento: "123456789" },
  });
  assert.equal(nueve.status, 400);
  assert.match(nueve.body, /entre 6 y 8 dígitos/);
});

test("GET /coseguro/perfil marca el DNI del familiar que está en revisión", async () => {
  preparar([
    [/FROM usuario u LEFT JOIN departamental d ON d\.id = u\.departamental_id WHERE u\.id = \?/, [[{ id: 2, nombre: "Nahuel", apellido: "Staffa", departamental_id: 1 }]]],
    [/WHERE u\.usuario_familiar_id = \? AND u\.es_familiar = 'S'/, [[{ id: 9, nombre: "Walter", apellido: "Olmos", documento: null }]]],
    [/FROM familiar_cambio_solicitud WHERE pendiente_persona IN \(\?\)/, [[{
      id: 4, persona_usuario_id: 9, solicitante_usuario_id: 2,
      datos_anteriores: { documento: null }, datos_propuestos: { documento: 55123456 },
    }]]],
  ]);
  const respuesta = await pedir("/api/coseguro/perfil", { usuario: 2 });
  assert.equal(respuesta.status, 200);
  const [walter] = respuesta.body.familiares;
  assert.equal(walter.dni_cargado, false);
  assert.equal(walter.dni_en_revision, true);
  assert.equal(walter.cambio_pendiente.codigo, "FC-4");
});

test("GET /acompaniantes/:id y POST /tabla/acompaniantes informan el pedido en revisión", async () => {
  const pendiente = {
    id: 7,
    persona_usuario_id: 8,
    solicitante_usuario_id: 2,
    datos_anteriores: { telefono: "2213649350" },
    datos_propuestos: { telefono: "2215550000" },
    fecha_creacion: "2026-09-24 10:00:00",
    fecha_modificacion: "2026-09-24 10:05:00",
  };
  preparar([
    [/^SELECT u\.id, u\.nombre, u\.apellido, u\.documento, u\.fecha_nacimiento, u\.telefono, u\.parentesco_id, u\.tipo_persona_id, TIMESTAMPDIFF/, [[{
      id: 8, nombre: "Carla", apellido: "Ortega", documento: 40756125, telefono: "2213649350",
    }]]],
    [/FROM familiar_cambio_solicitud WHERE pendiente_persona IN \(\?\)/, [[pendiente]]],
  ]);
  const detalle = await pedir("/api/acompaniantes/8", { usuario: 2 });
  assert.equal(detalle.status, 200);
  assert.equal(detalle.body.cambio_pendiente.id, 7);
  assert.equal(detalle.body.cambio_pendiente.codigo, "FC-7");
  assert.deepEqual(detalle.body.cambio_pendiente.datos_propuestos, { telefono: "2215550000" });

  preparar([
    [/^SELECT base\.\* FROM/, [[{ id: 8, nombre: "Carla", apellido: "Ortega" }, { id: 9, nombre: "Walter", apellido: "Olmos" }]]],
    [/^SELECT COUNT\(\*\) AS count FROM/, [[{ count: 2 }]]],
    [/^SELECT COUNT\(\*\) AS total, COALESCE/, [[{ total: 2, familiares: 2, acompaniantes: 0, listos_coseguro: 2 }]]],
    [/FROM familiar_cambio_solicitud WHERE pendiente_persona IN \(\?\)/, [[pendiente]]],
    [/INNER JOIN familiar_cambio_solicitud fcs ON fcs\.pendiente_persona = base\.id/, [[{ pendientes: 1 }]]],
  ]);
  const tabla = await pedir("/api/tabla/acompaniantes", { usuario: 2, method: "POST", body: {} });
  assert.equal(tabla.status, 200);
  assert.equal(tabla.body.results[0].cambio_pendiente.id, 7);
  assert.equal(tabla.body.results[1].cambio_pendiente, null);
  assert.equal(tabla.body.stats.pendientes, 1);
});

test("POST /tabla/acompaniantes: por reservas compartidas no lista a quien integra el grupo de otro afiliado", async () => {
  preparar([
    [/^SELECT base\.\* FROM/, [[]]],
    [/^SELECT COUNT\(\*\) AS count FROM/, [[{ count: 0 }]]],
    [/^SELECT COUNT\(\*\) AS total, COALESCE/, [[{ total: 0, familiares: 0, acompaniantes: 0, listos_coseguro: 0 }]]],
    [/INNER JOIN familiar_cambio_solicitud fcs ON fcs\.pendiente_persona = base\.id/, [[{ pendientes: 0 }]]],
  ]);
  const tabla = await pedir("/api/tabla/acompaniantes", { usuario: 2, method: "POST", body: {} });
  assert.equal(tabla.status, 200);

  // Misma restricción que personaEnUniversoAfiliado (services/familiares-cambios.js),
  // para que la tabla no ofrezca personas que después dan 403 PERSONA_FUERA_DEL_GRUPO.
  const restriccion = /\( \(u\.usuario_familiar_id IS NULL OR u\.usuario_familiar_id = \?\) AND u\.id IN \( SELECT rf5\.usuario_id FROM reserva_familiar rf5 WHERE rf5\.reserva_id IN \(SELECT rf6\.reserva_id FROM reserva_familiar rf6 WHERE rf6\.usuario_id = \?\) \) \)/;
  const listado = consultas(/^SELECT base\.\* FROM/);
  const conteo = consultas(/^SELECT COUNT\(\*\) AS count FROM/);
  const stats = consultas(/^SELECT COUNT\(\*\) AS total, COALESCE/);
  const pendientes = consultas(/INNER JOIN familiar_cambio_solicitud fcs ON fcs\.pendiente_persona = base\.id/);
  for (const [consulta] of [listado, conteo, stats, pendientes]) {
    assert.ok(consulta, "falta una de las consultas del universo");
    assert.match(consulta.sql, restriccion);
    // Cada placeholder tiene su parámetro y todos son el afiliado de la sesión.
    assert.equal((consulta.sql.match(/\?/g) || []).length, consulta.params.length);
    assert.ok(consulta.params.every((param) => param === 2));
  }
});

test("GET /notificaciones no oculta los avisos de familiares aunque el afiliado no tenga módulos", async () => {
  preparar([
    [/FROM notificacion n LEFT JOIN sorteo_adjudicacion_respuesta/, [[]]],
    [/^SELECT COUNT\(\*\) AS total FROM notificacion n/, [[{ total: 0 }]]],
  ], { sesion: { 2: { modulo_turismo: 0, modulo_coseguro: 0, modulo_olimpiadas: 0 } } });
  const respuesta = await pedir("/api/notificaciones?modulo=familiares", { usuario: 2 });
  assert.equal(respuesta.status, 200);
  const [listado] = consultas(/FROM notificacion n LEFT JOIN/);
  assert.ok(listado.params.includes("FAMILIAR%"));
  // Los módulos apagados se ocultan (NOT ...), pero FAMILIAR sólo aparece como filtro positivo.
  assert.doesNotMatch(listado.sql, /NOT \(n\.tipo LIKE \?\)[^)]*FAMILIAR/);
  assert.equal(listado.params.filter((param) => param === "FAMILIAR%").length, 1);
});
