"use strict";

// "Pedir baja" de un familiar o acompañante (services/familiares-cambios.js):
//  1) el afiliado sólo la pide para alguien que cargó en su grupo y sin cuenta propia;
//  2) queda PENDIENTE (habilitado 'N'), reemplaza lo pedido antes y avisa a la departamental;
//  3) con una baja en revisión no se aceptan otros pedidos sobre esa persona;
//  4) al aprobarse aplica la baja lógica del staff (habilitado = 'N'), nunca un DELETE;
//  5) rechazar avisa al afiliado que la persona sigue en su lista.
// Además, el alta (POST /familiares) acepta lo mismo que la edición en nombre y teléfono.
// Mismo arnés que familiares-cambios-vinculo.test.js (conexión falsa por patrón).

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "familiares-baja-test-secret";
process.env.BUCKET_REGION ||= "us-east-1";
process.env.ACCESS_KEY ||= "test-access-key";
process.env.SECRET_ACCESS_KEY ||= "test-secret-key";

const { esPedidoBaja, problemaBaja, versionSolicitud } = require("../api/services/familiares-cambios");

// ---------------------------------------------------------------------------
// Datos de prueba
// ---------------------------------------------------------------------------
const OK = [{ affectedRows: 1, insertId: 1 }];
const CARGA_OBJETIVO = /^SELECT u\.\*, r\.nombre AS rol_nombre FROM usuario u LEFT JOIN rol r/;
const HOY = "2026-09-24";

function persona(extra = {}) {
  return {
    id: 33,
    rol_id: 4,
    rol_nombre: "invitado",
    nombre: "Lucía",
    apellido: "Paz",
    documento: 45111222,
    fecha_nacimiento: "2012-03-10",
    telefono: null,
    tipo_persona_id: 2,
    parentesco_id: 4,
    es_familiar: "N",
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

let usuarios = {};
function usuariosBase() {
  return {
    1: { id: 1, nombre: "Nahuel", apellido: "Admin", rol_id: 1, departamental_id: null, usuario_familiar_id: null },
    2: { id: 2, nombre: "Nahuel", apellido: "Staffa", rol_id: 2, departamental_id: 1, usuario_familiar_id: null, departamental_nombre: "La Plata" },
    3: { id: 3, nombre: "Departamental", apellido: "Departamental", rol_id: 3, departamental_id: 1, usuario_familiar_id: null, departamental_nombre: "La Plata" },
    11: { id: 11, nombre: "Servicios", apellido: "Sociales", rol_id: 5, departamental_id: null, usuario_familiar_id: null },
  };
}

function filaSolicitud(extra = {}) {
  return {
    id: 9,
    persona_usuario_id: 33,
    solicitante_usuario_id: 2,
    departamental_id: 1,
    estado: "PENDIENTE",
    datos_anteriores: { parentesco_id: 4, es_familiar: "N" },
    datos_propuestos: { parentesco_id: 3, es_familiar: "S" },
    motivo_rechazo: null,
    resuelto_usuario_id: null,
    fecha_resolucion: null,
    fecha_creacion: "2026-09-24 10:00:00",
    fecha_modificacion: "2026-09-24 10:00:00",
    persona_nombre: "Lucía",
    persona_apellido: "Paz",
    persona_documento: 45111222,
    persona_es_familiar: "N",
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
};
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
    return [[{
      habilitado: "Y", area_turismo: 1, area_coseguro: 1, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1,
      ...sesiones[params[0]],
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

const COMUNES = [
  [/^SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = \?$/, (_sql, [id]) => [[usuarios[id]].filter(Boolean)]],
  [/^SELECT u\.id, u\.nombre, u\.apellido, u\.rol_id, u\.departamental_id, d\.nombre AS departamental_nombre/, (_sql, [id]) => [[usuarios[id] || { id }]]],
  [/^SELECT nombre FROM departamental WHERE id = \?/, (_sql, [id]) => [[{ nombre: id === 2 ? "Azul" : "La Plata" }]]],
  [/WHERE r\.nombre = 'departamental' AND u\.departamental_id = \? AND u\.habilitado = 'Y'/, (_sql, [dep]) => [
    dep === 1 ? [{ id: 3 }] : dep === 2 ? [{ id: 13 }] : [],
  ]],
  [/^INSERT INTO notificacion/, OK],
  [/^UPDATE notificacion SET leida = 1, fecha_lectura = NOW\(\) WHERE tipo = \?/, OK],
  [/^SELECT id FROM tipo_persona WHERE id = \?/, (_sql, [id]) => [[{ id }]]],
  [/^SELECT id FROM parentesco WHERE id = \?/, (_sql, [id]) => [[{ id }]]],
  [/^SELECT id, nombre FROM tipo_persona/, [[{ id: 2, nombre: "Invitados familiares" }, { id: 3, nombre: "Invitados generales" }]]],
  [/^SELECT id, nombre FROM parentesco/, [[{ id: 2, nombre: "Pareja" }, { id: 3, nombre: "Hijo" }, { id: 4, nombre: "Familiar" }, { id: 5, nombre: "Otro" }]]],
  [/JSON_EXTRACT\(datos_propuestos, '\$\.documento'\)/, [[]]],
  [/^SELECT id FROM usuario WHERE documento = \? AND id <> \?/, [[]]],
  // Advertencias del detalle
  [/^SELECT DISTINCT r\.id, r\.estado_reserva_id/, [[]]],
  [/FROM coseguro_solicitud WHERE \(usuario_id = \? OR familiar_usuario_id = \?\)/, [[]]],
];

function preparar(manejadores = []) {
  llamadas.length = 0;
  commits = 0;
  rollbacks = 0;
  usuarios = usuariosBase();
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
const PENDIENTE_SIN_BLOQUEO = /^SELECT id FROM familiar_cambio_solicitud WHERE pendiente_persona = \?$/;
const PENDIENTE_POR_ID = /^SELECT id, solicitante_usuario_id, datos_propuestos, estado FROM familiar_cambio_solicitud WHERE id = \? FOR UPDATE$/;
const PENDIENTE_POR_PERSONA_BLOQUEADO = /^SELECT id, solicitante_usuario_id, datos_propuestos, estado FROM familiar_cambio_solicitud WHERE pendiente_persona = \? FOR UPDATE$/;
const INSERT_SOLICITUD = /^INSERT INTO familiar_cambio_solicitud/;
const LEER_SOLICITUD = /FROM familiar_cambio_solicitud f INNER JOIN usuario p/;
const BLOQUEAR_SOLICITUD = /^SELECT id, persona_usuario_id, solicitante_usuario_id, departamental_id, estado, datos_anteriores, datos_propuestos FROM familiar_cambio_solicitud WHERE id = \? FOR UPDATE/;
const PROPAGAR_PARENTESCO = /FROM reserva_familiar rf INNER JOIN reserva r ON r\.id = rf\.reserva_id WHERE rf\.usuario_id = \?[\s\S]*FOR UPDATE OF rf$/;

const SOLICITUD_BAJA = filaSolicitud({ datos_anteriores: { habilitado: "Y" }, datos_propuestos: { habilitado: "N" } });
const VERSION_BAJA = versionSolicitud(SOLICITUD_BAJA.datos_propuestos);

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------
test("esPedidoBaja: sólo habilitado 'N' es baja", () => {
  assert.equal(esPedidoBaja({ habilitado: "N" }), true);
  assert.equal(esPedidoBaja({ habilitado: "Y" }), false);
  assert.equal(esPedidoBaja({ telefono: "2215550000" }), false);
  assert.equal(esPedidoBaja({}), false);
});

test("problemaBaja: sólo personas del grupo del afiliado y sin cuenta propia", () => {
  assert.equal(problemaBaja(persona(), { solicitanteId: 2 }), null);
  assert.equal(problemaBaja(persona({ usuario_familiar_id: null }), { solicitanteId: 2 }).codigo, "BAJA_INVALIDA");
  assert.equal(problemaBaja(persona({ usuario_familiar_id: 77 }), { solicitanteId: 2 }).codigo, "BAJA_INVALIDA");
  const conCuenta = problemaBaja(persona({ password: "hash" }), { solicitanteId: 2 });
  assert.equal(conCuenta.codigo, "BAJA_INVALIDA");
  assert.match(conCuenta.mensajeAfiliado, /Quitar del grupo familiar/);
  assert.equal(problemaBaja(persona({ rol_id: 2, rol_nombre: "afiliado" }), { solicitanteId: 2 }).codigo, "BAJA_INVALIDA");
});

// ---------------------------------------------------------------------------
// Pedido del afiliado
// ---------------------------------------------------------------------------
function manejadoresBaja({ ficha = persona(), pendiente = null } = {}) {
  return [
    [UNIVERSO, [[{ id: ficha.id }]]],
    [CARGA_OBJETIVO, [[ficha]]],
    [PENDIENTE_SIN_BLOQUEO, [pendiente ? [{ id: pendiente.id }] : []]],
    [PENDIENTE_POR_ID, [pendiente ? [{ estado: "PENDIENTE", ...pendiente }] : []]],
    [INSERT_SOLICITUD, [{ affectedRows: 1, insertId: 12 }]],
    [/^UPDATE familiar_cambio_solicitud SET datos_anteriores/, OK],
  ];
}

test("POST /familiares/:id/baja crea el pedido PENDIENTE con habilitado 'N' y avisa a la departamental", async () => {
  preparar(manejadoresBaja());
  const respuesta = await pedir("/api/familiares/33/baja", { usuario: 2, method: "POST" });
  assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.pendiente, true);
  assert.equal(respuesta.body.baja, true);
  assert.equal(respuesta.body.codigo, "FC-12");
  assert.deepEqual(respuesta.body.campos, ["habilitado"]);
  assert.match(respuesta.body.message, /^Le pedimos la baja a tu departamental\. Mientras la revisa, la persona sigue en tu lista/);

  const [insercion] = consultas(INSERT_SOLICITUD);
  assert.deepEqual(JSON.parse(insercion.params[3]), { habilitado: "Y" });
  assert.deepEqual(JSON.parse(insercion.params[4]), { habilitado: "N" });
  // Nada se aplica todavía sobre la persona.
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  assert.equal(commits, 1);

  const [aviso] = notificaciones();
  assert.equal(aviso.usuario_id, 3);
  assert.equal(aviso.tipo, "FAMILIAR_CAMBIO_SOLICITADO");
  assert.equal(aviso.titulo, "Nahuel Staffa pidió dar de baja a Lucía Paz");
  assert.match(aviso.mensaje, /^FC-12 · Pide la baja: deja de figurar entre sus familiares y acompañantes\. Sigue en su lista/);
  assert.deepEqual(aviso.payload, { solicitud_id: 12, persona_id: 33 });
});

test("la baja reemplaza un pedido de corrección propio en revisión (no se mezclan)", async () => {
  preparar(manejadoresBaja({
    pendiente: { id: 5, solicitante_usuario_id: 2, datos_propuestos: JSON.stringify({ telefono: "2215550000" }) },
  }));
  const respuesta = await pedir("/api/familiares/33/baja", { usuario: 2, method: "POST" });
  assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.reemplazada, true);
  assert.match(respuesta.body.message, /^Reemplazamos tu pedido de cambios por el de baja\./);
  const [actualizacion] = consultas(/^UPDATE familiar_cambio_solicitud SET datos_anteriores/);
  assert.deepEqual(JSON.parse(actualizacion.params[0]), { habilitado: "Y" });
  assert.deepEqual(JSON.parse(actualizacion.params[1]), { habilitado: "N" });
  const [aviso] = notificaciones();
  assert.equal(aviso.titulo, "Nahuel Staffa cambió su pedido: ahora pide dar de baja a Lucía Paz");
});

test("con una baja en revisión no se aceptan otros pedidos sobre esa persona (ni repetir la baja)", async () => {
  const pendiente = { id: 5, solicitante_usuario_id: 2, datos_propuestos: JSON.stringify({ habilitado: "N" }) };

  preparar(manejadoresBaja({ pendiente }));
  const correccion = await pedir("/api/familiares/33/cambios", { usuario: 2, method: "POST", body: { telefono: "2215550000" } });
  assert.equal(correccion.status, 409, JSON.stringify(correccion.body));
  assert.equal(correccion.body.codigo, "BAJA_PENDIENTE");
  assert.equal(correccion.body.solicitud_id, 5);
  assert.match(correccion.body.message, /retirá ese pedido/);

  preparar(manejadoresBaja({ pendiente }));
  const vinculo = await pedir("/api/familiares/33/vinculo", { usuario: 2, method: "PUT", body: { es_familiar: "S", parentesco_id: 3 } });
  assert.equal(vinculo.status, 409);
  assert.equal(vinculo.body.codigo, "BAJA_PENDIENTE");

  preparar(manejadoresBaja({ pendiente }));
  const otraVez = await pedir("/api/familiares/33/baja", { usuario: 2, method: "POST" });
  assert.equal(otraVez.status, 409);
  assert.equal(otraVez.body.codigo, "BAJA_PENDIENTE");
  assert.match(otraVez.body.message, /^Ya pediste la baja de Lucía Paz/);
  assert.equal(consultas(/^UPDATE familiar_cambio_solicitud/).length, 0);
  assert.equal(notificaciones().length, 0);
});

test("no se pide la baja de quien no cargó el afiliado ni de quien tiene cuenta propia", async () => {
  for (const ficha of [persona({ usuario_familiar_id: null }), persona({ es_familiar: "S", parentesco_id: 2, password: "hash" })]) {
    preparar(manejadoresBaja({ ficha }));
    const respuesta = await pedir("/api/familiares/33/baja", { usuario: 2, method: "POST" });
    assert.equal(respuesta.status, 403, JSON.stringify(respuesta.body));
    assert.equal(respuesta.body.codigo, "BAJA_INVALIDA");
    assert.equal(consultas(INSERT_SOLICITUD).length, 0);
    assert.equal(notificaciones().length, 0);
  }
});

test("sólo el afiliado puede pedir una baja", async () => {
  preparar(manejadoresBaja());
  const respuesta = await pedir("/api/familiares/33/baja", { usuario: 3, method: "POST" });
  assert.equal(respuesta.status, 403);
  assert.equal(consultas(INSERT_SOLICITUD).length, 0);
});

// ---------------------------------------------------------------------------
// Resolución del staff
// ---------------------------------------------------------------------------
function manejadoresResolucionBaja({ ficha = persona(), solicitud = SOLICITUD_BAJA, reservas = [] } = {}) {
  return [
    [LEER_SOLICITUD, [[solicitud]]],
    [CARGA_OBJETIVO, [[ficha]]],
    [BLOQUEAR_SOLICITUD, [[solicitud]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/^SELECT DISTINCT r\.id, r\.estado_reserva_id/, [reservas]],
    [/^UPDATE familiar_cambio_solicitud SET estado = 'APROBADA'/, OK],
    [/^UPDATE familiar_cambio_solicitud SET estado = 'RECHAZADA'/, OK],
  ];
}

test("el detalle del staff marca la baja y explica qué pasa con las reservas abiertas", async () => {
  preparar(manejadoresResolucionBaja({
    reservas: [{ id: 50, estado_reserva_id: 2, estado_nombre: "Aprobada", fecha_inicio: "2099-01-10", fecha_fin: "2099-01-15" }],
  }));
  const detalle = await pedir("/api/familiares/cambios/9", { usuario: 3 });
  assert.equal(detalle.status, 200, JSON.stringify(detalle.body));
  assert.equal(detalle.body.data.baja, true);
  assert.deepEqual(detalle.body.data.campos, ["habilitado"]);
  assert.deepEqual(detalle.body.data.cambios.map(({ campo, anterior_texto, nuevo_texto }) => [campo, anterior_texto, nuevo_texto]), [
    ["habilitado", "Activa", "Dada de baja"],
  ]);
  const [reservas] = detalle.body.data.advertencias;
  assert.equal(reservas.codigo, "RESERVAS_ABIERTAS");
  assert.match(reservas.mensaje, /la baja no la saca de esas reservas/);
  assert.equal(detalle.body.data.puede_resolver, true);
});

test("si la persona sacó cuenta propia, el detalle bloquea la aprobación y aprobar responde 409", async () => {
  const conCuenta = persona({ password: "hash" });
  preparar(manejadoresResolucionBaja({ ficha: conCuenta }));
  const detalle = await pedir("/api/familiares/cambios/9", { usuario: 3 });
  const codigos = detalle.body.data.advertencias.map(({ codigo }) => codigo);
  assert.ok(codigos.includes("BAJA_INVALIDA"), codigos.join(","));
  assert.ok(!codigos.includes("CUENTA_PROPIA"));

  preparar(manejadoresResolucionBaja({ ficha: conCuenta }));
  const respuesta = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "APROBAR", version: VERSION_BAJA },
  });
  assert.equal(respuesta.status, 409, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.codigo, "BAJA_INVALIDA");
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  assert.equal(rollbacks, 1);
});

test("aprobar la baja aplica la baja lógica del staff (habilitado = 'N'), sin borrar, y avisa al afiliado", async () => {
  preparar(manejadoresResolucionBaja());
  const respuesta = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "APROBAR", version: VERSION_BAJA },
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.estado, "APROBADA");
  assert.equal(respuesta.body.baja, true);
  assert.equal(respuesta.body.message, "Baja aprobada: la persona ya no figura en el grupo y avisamos al afiliado");

  const actualizaciones = consultas(/^UPDATE usuario SET/);
  assert.equal(actualizaciones.length, 1);
  assert.equal(actualizaciones[0].sql, "UPDATE usuario SET habilitado = ?, auth_revocado_desde = NOW(6) WHERE id = ?");
  assert.deepEqual(actualizaciones[0].params, ["N", 33]);
  assert.equal(consultas(/^DELETE /).length, 0);
  assert.equal(consultas(/^INSERT INTO historial_usuario/).length, 1);
  assert.equal(commits, 1);

  const [aviso] = notificaciones();
  assert.equal(aviso.usuario_id, 2);
  assert.equal(aviso.tipo, "FAMILIAR_CAMBIO_APROBADO");
  assert.equal(aviso.titulo, "Lucía Paz ya no figura en tu grupo");
  assert.match(aviso.mensaje, /aprobó tu pedido FC-9: dimos de baja a Lucía Paz\. Ya no aparece en Familiares y acompañantes\.$/);
});

test("rechazar la baja avisa al afiliado que la persona sigue en su lista", async () => {
  preparar(manejadoresResolucionBaja());
  const respuesta = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "RECHAZAR", motivo: "Viaja en una reserva aprobada", version: VERSION_BAJA },
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  const [aviso] = notificaciones();
  assert.equal(aviso.tipo, "FAMILIAR_CAMBIO_RECHAZADO");
  assert.equal(aviso.titulo, "No se aprobó la baja de Lucía Paz");
  assert.match(aviso.mensaje, /rechazó el pedido FC-9\. Motivo: Viaja en una reserva aprobada\. Lucía Paz sigue en tu lista\.$/);
});

// ---------------------------------------------------------------------------
// Alta (POST /familiares): mismas reglas que la edición
// ---------------------------------------------------------------------------
// La edición (services/usuarios-datos.js) sólo limita el largo: nombre y
// apellido hasta 45, teléfono hasta 15. El alta tiene que aceptar lo mismo
// (el formulario rechazaba «D'Onofrio», «Pérez-Gil» y teléfonos de ≠ 10 dígitos).
test("el alta acepta apellidos con apóstrofo y guion y teléfonos con formato (como la edición)", async () => {
  preparar([
    [/^SELECT id, departamental_id FROM usuario WHERE id = \? AND habilitado = 'Y' FOR UPDATE$/, [[{ id: 2, departamental_id: 1 }]]],
    [/^INSERT INTO usuario \(/, [{ affectedRows: 1, insertId: 50 }]],
    [/^INSERT INTO historial_usuario/, OK],
  ]);
  const respuesta = await pedir("/api/familiares", {
    usuario: 2,
    method: "POST",
    body: { nombre: "María José", apellido: "D'Onofrio Pérez-Gil", parentesco_id: 3, fecha_nacimiento: "2015-04-20", telefono: "(0221) 555-1234" },
  });
  assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
  const [alta] = consultas(/^INSERT INTO usuario \(/);
  assert.equal(alta.params[3], "María José");
  assert.equal(alta.params[4], "D'Onofrio Pérez-Gil");
  assert.equal(alta.params[7], "(0221) 555-1234");
});

test("el alta rechaza un teléfono de más de 15 caracteres (mismo tope que la edición)", async () => {
  preparar([]);
  const respuesta = await pedir("/api/familiares", {
    usuario: 2,
    method: "POST",
    body: { nombre: "Ana", apellido: "Paz", parentesco_id: 3, fecha_nacimiento: "2015-04-20", telefono: "0221 555 1234 5678" },
  });
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body.message, "El teléfono es inválido");
});
