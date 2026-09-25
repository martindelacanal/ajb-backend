"use strict";

// Pedidos de cambio de familiares, segunda vuelta (services/familiares-cambios.js):
//  1) versión del pedido: la resolución exige la que se revisó (409 SOLICITUD_MODIFICADA);
//  2) el vínculo ("Sumar / Quitar del grupo familiar") también pasa por pedido y
//     al aprobarse ata a la persona al grupo del solicitante;
//  3) la departamental sólo resuelve pedidos de su jurisdicción actual;
//  4) por reservas compartidas no entra quien integra el grupo de otro afiliado;
//  5) sin gap locks: ER_DUP_ENTRY del UNIQUE → un reintento;
//  6) el motivo de rechazo no duplica el punto final.
// Las consultas se simulan con una conexión falsa que responde por patrón.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "familiares-cambios-vinculo-test-secret";
process.env.BUCKET_REGION ||= "us-east-1";
process.env.ACCESS_KEY ||= "test-access-key";
process.env.SECRET_ACCESS_KEY ||= "test-secret-key";

const {
  cerrarFrase,
  notificarDepartamentalesCambioFamiliar,
  personaEnUniversoAfiliado,
  presentarCambioVinculo,
  reasignarSolicitudesPendientesDelTitular,
  validarReglasSolicitud,
  versionSolicitud,
} = require("../api/services/familiares-cambios");

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

const VERSION_9 = versionSolicitud(filaSolicitud().datos_propuestos);

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------
test("versión: estable ante el orden de claves y '3' vs 3; cambia con otros datos", () => {
  const a = versionSolicitud({ parentesco_id: 3, es_familiar: "S" });
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(versionSolicitud(JSON.stringify({ es_familiar: "S", parentesco_id: "3" })), a);
  assert.notEqual(versionSolicitud({ parentesco_id: 2, es_familiar: "S" }), a);
  assert.notEqual(versionSolicitud({ parentesco_id: 3 }), a);
});

test("cerrarFrase no duplica el punto final", () => {
  assert.equal(cerrarFrase("No coincide."), "No coincide.");
  assert.equal(cerrarFrase("No coincide.. "), "No coincide.");
  assert.equal(cerrarFrase("No coincide"), "No coincide.");
  assert.equal(cerrarFrase("¿Es correcto?"), "¿Es correcto?");
});

test("reglas del vínculo: sumar al grupo exige parentesco Pareja, Hijo o Familiar", () => {
  const acompaniante = persona({ tipo_persona_id: 3, parentesco_id: 5 });
  assert.throws(
    () => validarReglasSolicitud({ persona: acompaniante, propuestos: { es_familiar: "S" }, hoy: HOY }),
    (error) => error.codigo === "GRUPO_FAMILIAR_INVALIDO" && error.campo === "parentesco_id"
  );
  assert.doesNotThrow(() => validarReglasSolicitud({ persona: acompaniante, propuestos: { es_familiar: "S", parentesco_id: 3 }, hoy: HOY }));
  // Quitar del grupo no exige nada del parentesco.
  assert.doesNotThrow(() => validarReglasSolicitud({ persona: persona({ es_familiar: "S", parentesco_id: 3 }), propuestos: { es_familiar: "N" }, hoy: HOY }));
});

test("cambio de vínculo legible para quien decide", () => {
  const catalogos = { parentescos: new Map([[3, "Hijo"]]) };
  assert.deepEqual(presentarCambioVinculo({ es_familiar: "S", parentesco_id: 3 }, catalogos), {
    es_familiar: "S", parentesco_id: 3, parentesco_texto: "Hijo", descripcion: "Pasa a integrar el grupo familiar como Hijo",
  });
  assert.equal(
    presentarCambioVinculo({ es_familiar: "S" }, catalogos, { parentescoActual: "Pareja" }).descripcion,
    "Pasa a integrar el grupo familiar como Pareja"
  );
  assert.equal(presentarCambioVinculo({ es_familiar: "N" }).descripcion, "Deja el grupo familiar; queda como acompañante de viaje");
  assert.equal(presentarCambioVinculo({ telefono: "1" }), null);
});

test("universo del afiliado: por reservas compartidas sólo entra quien no integra el grupo de otro", async () => {
  preparar([[UNIVERSO, [[]]]]);
  const conexion = { query: consultar };
  assert.equal(await personaEnUniversoAfiliado(conexion, 2, 33), false);
  const [consulta] = consultas(UNIVERSO);
  assert.match(consulta.sql, /\(u\.usuario_familiar_id IS NULL OR u\.usuario_familiar_id = \?\) AND u\.id IN \( SELECT rf5\.usuario_id/);
  assert.deepEqual(consulta.params, [33, 2, 2, 2, 2, 2]);
});

// ---------------------------------------------------------------------------
// 1) Versión del pedido
// ---------------------------------------------------------------------------
function manejadoresResolucion({ solicitud = filaSolicitud(), personaInicial = persona(), bloqueada = null, reservas = [] } = {}) {
  let fichaActual = personaInicial;
  return [
    [LEER_SOLICITUD, [[solicitud]]],
    // La ficha se relee dentro de actualizarDatosUsuario: refleja el vínculo ya escrito.
    [CARGA_OBJETIVO, () => [[fichaActual]]],
    [BLOQUEAR_SOLICITUD, [[bloqueada || solicitud]]],
    [/^UPDATE usuario SET usuario_familiar_id = \?/, (_sql, params) => {
      fichaActual = { ...fichaActual, usuario_familiar_id: params[0], ...(params.length === 3 ? { departamental_id: params[1] } : {}) };
      return OK;
    }],
    [/^UPDATE usuario SET departamental_id = \? WHERE id = \?$/, (_sql, params) => {
      fichaActual = { ...fichaActual, departamental_id: params[0] };
      return OK;
    }],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [PROPAGAR_PARENTESCO, [reservas]],
    [/^SELECT id, nombre FROM parentesco WHERE id IN \(\?\)/, [[{ id: 3, nombre: "Hijo" }, { id: 4, nombre: "Familiar" }]]],
    [/^UPDATE reserva_familiar SET parentesco_id = \? WHERE id = \?/, OK],
    [/^INSERT INTO historial_reserva/, OK],
    [/^UPDATE familiar_cambio_solicitud SET estado = 'APROBADA'/, OK],
    [/^UPDATE familiar_cambio_solicitud SET estado = 'RECHAZADA'/, OK],
  ];
}

test("GET detalle y listado devuelven la versión y el cambio de vínculo legible", async () => {
  preparar([
    [LEER_SOLICITUD, [[filaSolicitud({ persona_usuario_familiar_id: null })]]],
    [CARGA_OBJETIVO, [[persona({ usuario_familiar_id: null, departamental_id: 2 })]]],
  ]);
  const detalle = await pedir("/api/familiares/cambios/9", { usuario: 3 });
  assert.equal(detalle.status, 200, JSON.stringify(detalle.body));
  assert.equal(detalle.body.data.version, VERSION_9);
  assert.deepEqual(detalle.body.data.cambio_vinculo, {
    es_familiar: "S", parentesco_id: 3, parentesco_texto: "Hijo", descripcion: "Pasa a integrar el grupo familiar como Hijo",
  });
  assert.equal(detalle.body.data.ficha_actual.es_familiar, "N");
  const codigos = detalle.body.data.advertencias.map(({ codigo }) => codigo);
  assert.deepEqual(codigos, ["VINCULO_NUEVO"]);
  assert.equal(detalle.body.data.puede_resolver, true);

  preparar([
    [/^SELECT f\.id, f\.persona_usuario_id[\s\S]+LIMIT \? OFFSET \?$/, [[filaSolicitud()]]],
    [/^SELECT COUNT\(\*\) AS total FROM familiar_cambio_solicitud f/, [[{ total: 1 }]]],
    [/^SELECT f\.estado, COUNT\(\*\) AS cantidad/, [[{ estado: "PENDIENTE", cantidad: 1 }]]],
  ]);
  const listado = await pedir("/api/familiares/cambios?estado=PENDIENTE", { usuario: 3 });
  assert.equal(listado.status, 200);
  assert.equal(listado.body.results[0].version, VERSION_9);
  assert.equal(listado.body.results[0].cambio_vinculo.es_familiar, "S");
  assert.deepEqual(listado.body.results[0].cambios.map(({ campo, nuevo_texto }) => [campo, nuevo_texto]), [
    ["parentesco_id", "Hijo"],
    ["es_familiar", "Grupo familiar"],
  ]);
});

test("resolver sin versión → 400 VERSION_REQUERIDA sin tocar la base", async () => {
  preparar(manejadoresResolucion());
  const respuesta = await pedir("/api/familiares/cambios/9/resolucion", { usuario: 3, method: "POST", body: { accion: "APROBAR" } });
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body.codigo, "VERSION_REQUERIDA");
  assert.equal(consultas(LEER_SOLICITUD).length, 0);
});

test("el afiliado reemplazó el pedido mientras se revisaba → 409 SOLICITUD_MODIFICADA y no se aplica nada", async () => {
  const reemplazada = filaSolicitud({ datos_propuestos: { parentesco_id: 2, es_familiar: "S" } });
  preparar(manejadoresResolucion({ bloqueada: reemplazada }));
  const respuesta = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "APROBAR", version: VERSION_9 },
  });
  assert.equal(respuesta.status, 409, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.codigo, "SOLICITUD_MODIFICADA");
  assert.equal(respuesta.body.message, "El afiliado actualizó el pedido mientras lo revisabas; revisalo de nuevo.");
  assert.equal(respuesta.body.version, versionSolicitud(reemplazada.datos_propuestos));
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  assert.equal(consultas(/^UPDATE familiar_cambio_solicitud/).length, 0);
  assert.equal(notificaciones().length, 0);
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);

  // También para rechazar: no se rechaza algo que no se vio.
  preparar(manejadoresResolucion({ bloqueada: reemplazada }));
  const rechazo = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "RECHAZAR", motivo: "No corresponde", version: VERSION_9 },
  });
  assert.equal(rechazo.status, 409);
  assert.equal(rechazo.body.codigo, "SOLICITUD_MODIFICADA");
});

// ---------------------------------------------------------------------------
// 2) Aprobación de un cambio de vínculo
// ---------------------------------------------------------------------------
test("aprobar 'sumar al grupo' de alguien sin grupo: lo ata al solicitante con la departamental del titular y propaga el parentesco", async () => {
  const sinGrupo = persona({ usuario_familiar_id: null, departamental_id: 2 });
  preparar(manejadoresResolucion({
    solicitud: filaSolicitud({ persona_usuario_familiar_id: null }),
    personaInicial: sinGrupo,
    reservas: [{ id: 90, reserva_id: 50, parentesco_id: 4, estado_reserva_id: 2, fecha_inicio: "2026-12-01", fecha_fin: "2026-12-05" }],
  }));
  const respuesta = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "APROBAR", version: VERSION_9 },
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.estado, "APROBADA");
  assert.equal(respuesta.body.cambio_vinculo.descripcion, "Pasa a integrar el grupo familiar como Hijo");
  assert.equal(commits, 1);

  const actualizaciones = consultas(/^UPDATE usuario SET/);
  assert.equal(actualizaciones[0].sql, "UPDATE usuario SET usuario_familiar_id = ?, departamental_id = ? WHERE id = ?");
  assert.deepEqual(actualizaciones[0].params, [2, 1, 33]);
  assert.equal(actualizaciones[1].sql, "UPDATE usuario SET parentesco_id = ?, es_familiar = ? WHERE id = ?");
  assert.deepEqual(actualizaciones[1].params, [3, "S", 33]);

  // Historial estricto de todo, con el aprobador como modificador.
  const historial = consultas(/^INSERT INTO historial_usuario/).map(({ params }) => [params[2], params[3], params[4], params[6]]);
  assert.deepEqual(historial, [
    ["usuario_familiar_id", null, 2, 3],
    ["departamental_id", 2, 1, 3],
    ["parentesco_id", 4, 3, 3],
    ["es_familiar", "N", "S", 3],
  ]);
  assert.match(consultas(/^INSERT INTO historial_usuario/)[0].params[9], /^Solicitado por Nahuel Staffa \(FC-9\), aprobado por Departamental Departamental/);
  assert.deepEqual(respuesta.body.cambios.map(({ campo }) => campo), ["usuario_familiar_id", "departamental_id", "parentesco_id", "es_familiar"]);

  // Parentesco propagado a la reserva abierta (sin tocar el precio).
  assert.deepEqual(consultas(/^UPDATE reserva_familiar SET parentesco_id/)[0].params, [3, 90]);
  assert.equal(consultas(/^INSERT INTO historial_reserva/).length, 1);
  assert.equal(respuesta.body.propagaciones[0].reserva_id, 50);

  const [aviso] = notificaciones();
  assert.equal(aviso.usuario_id, 2);
  assert.equal(aviso.tipo, "FAMILIAR_CAMBIO_APROBADO");
  assert.equal(aviso.titulo, "Lucía Paz ya integra tu grupo familiar");
  assert.match(aviso.mensaje, /aprobó tu pedido FC-9: Lucía Paz pasa a integrar tu grupo familiar como Hijo\./);
});

test("aprobar 'quitar del grupo': sólo cambia es_familiar (sigue vinculada al afiliado)", async () => {
  const familiar = persona({ es_familiar: "S", parentesco_id: 3 });
  const solicitud = filaSolicitud({
    datos_anteriores: { es_familiar: "S" },
    datos_propuestos: { es_familiar: "N" },
    persona_es_familiar: "S",
  });
  preparar(manejadoresResolucion({ solicitud, personaInicial: familiar }));
  const respuesta = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 11,
    method: "POST",
    body: { accion: "APROBAR", version: versionSolicitud(solicitud.datos_propuestos) },
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  const actualizaciones = consultas(/^UPDATE usuario SET/);
  assert.equal(actualizaciones.length, 1);
  assert.equal(actualizaciones[0].sql, "UPDATE usuario SET es_familiar = ? WHERE id = ?");
  assert.deepEqual(actualizaciones[0].params, ["N", 33]);
  assert.equal(consultas(/^UPDATE reserva_familiar/).length, 0);
  const [aviso] = notificaciones();
  assert.equal(aviso.titulo, "Lucía Paz quedó como acompañante de viaje");
});

test("aprobar el vínculo de alguien que ahora integra el grupo de otro afiliado → 409 VINCULO_INVALIDO", async () => {
  const deOtro = persona({ usuario_familiar_id: 77 });
  preparar(manejadoresResolucion({ personaInicial: deOtro }));
  const respuesta = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "APROBAR", version: VERSION_9 },
  });
  assert.equal(respuesta.status, 409, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.codigo, "VINCULO_INVALIDO");
  assert.equal(consultas(/^UPDATE usuario/).length, 0);
  assert.equal(rollbacks, 1);
});

test("rechazar un vínculo avisa en una frase y no duplica el punto del motivo", async () => {
  preparar(manejadoresResolucion());
  const respuesta = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "RECHAZAR", motivo: "Presentá la partida de nacimiento.", version: VERSION_9 },
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  const [aviso] = notificaciones();
  assert.equal(aviso.tipo, "FAMILIAR_CAMBIO_RECHAZADO");
  assert.equal(aviso.titulo, "No se aprobó sumar a Lucía Paz a tu grupo familiar");
  assert.match(aviso.mensaje, /Motivo: Presentá la partida de nacimiento\. Lucía Paz sigue como estaba\.$/);
  assert.doesNotMatch(aviso.mensaje, /\.\./);
});

// ---------------------------------------------------------------------------
// 3) Jurisdicción
// ---------------------------------------------------------------------------
test("la departamental no resuelve si el titular ya pasó a otra departamental (403); AJB central sí", async () => {
  const solicitud = filaSolicitud({ datos_anteriores: { telefono: null }, datos_propuestos: { telefono: "2215550000" } });
  const version = versionSolicitud(solicitud.datos_propuestos);
  const mudado = [/^SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = \?$/, (_sql, [id]) => [[
    id === 2 ? { id: 2, usuario_familiar_id: null, departamental_id: 2 } : usuarios[id],
  ].filter(Boolean)]];

  preparar([mudado, ...manejadoresResolucion({ solicitud, personaInicial: persona({ es_familiar: "S" }) })]);
  const departamental = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 3,
    method: "POST",
    body: { accion: "APROBAR", version },
  });
  assert.equal(departamental.status, 403, JSON.stringify(departamental.body));
  assert.equal(departamental.body.codigo, "FUERA_DE_JURISDICCION");
  assert.match(departamental.body.message, /el titular pasó a la departamental Azul/);
  assert.equal(consultas(/^UPDATE usuario/).length, 0);

  preparar([mudado, ...manejadoresResolucion({ solicitud, personaInicial: persona({ es_familiar: "S" }) })]);
  const central = await pedir("/api/familiares/cambios/9/resolucion", {
    usuario: 11,
    method: "POST",
    body: { accion: "APROBAR", version },
  });
  assert.equal(central.status, 200, JSON.stringify(central.body));

  // En el detalle, la departamental ve por qué no puede resolver.
  preparar([
    mudado,
    [LEER_SOLICITUD, [[solicitud]]],
    [CARGA_OBJETIVO, [[persona({ es_familiar: "S" })]]],
  ]);
  const detalle = await pedir("/api/familiares/cambios/9", { usuario: 3 });
  assert.equal(detalle.status, 200);
  assert.equal(detalle.body.data.puede_resolver, false);
  assert.equal(detalle.body.data.advertencias[0].codigo, "FUERA_DE_JURISDICCION");
});

// ---------------------------------------------------------------------------
// 5) Alta del pedido sin gap locks
// ---------------------------------------------------------------------------
function manejadoresPedido({ ficha = persona(), pendienteReintento = null, duplicados = 1 } = {}) {
  let inserciones = 0;
  return [
    [UNIVERSO, [[{ id: ficha.id }]]],
    [CARGA_OBJETIVO, [[ficha]]],
    [PENDIENTE_SIN_BLOQUEO, [[]]],
    [PENDIENTE_POR_PERSONA_BLOQUEADO, [pendienteReintento ? [{ estado: "PENDIENTE", ...pendienteReintento }] : []]],
    [INSERT_SOLICITUD, () => {
      inserciones += 1;
      if (inserciones <= duplicados) {
        const error = new Error("Duplicate entry '33' for key 'uq_fcs_pendiente_persona'");
        error.code = "ER_DUP_ENTRY";
        throw error;
      }
      return [{ affectedRows: 1, insertId: 12 }];
    }],
    [/^UPDATE familiar_cambio_solicitud SET datos_anteriores/, OK],
  ];
}

test("pedido nuevo: no bloquea por pendiente_persona inexistente (sin gap locks)", async () => {
  preparar(manejadoresPedido({ duplicados: 0 }));
  const respuesta = await pedir("/api/familiares/33/vinculo", {
    usuario: 2,
    method: "PUT",
    body: { es_familiar: "S", parentesco_id: 3 },
  });
  assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.solicitud_id, 12);
  assert.equal(respuesta.body.version, VERSION_9);
  assert.equal(consultas(PENDIENTE_POR_PERSONA_BLOQUEADO).length, 0);
  assert.equal(consultas(PENDIENTE_SIN_BLOQUEO).length, 1);
  const [aviso] = notificaciones();
  assert.equal(aviso.titulo, "Nahuel Staffa pidió sumar a Lucía Paz a su grupo familiar");
  assert.match(aviso.mensaje, /^FC-12 · Pasa a integrar el grupo familiar como Hijo\. Los datos no cambian/);
});

test("ER_DUP_ENTRY al insertar: relee una vez (bloqueando la fila que ya existe) y reemplaza el pedido propio", async () => {
  preparar(manejadoresPedido({
    pendienteReintento: { id: 5, solicitante_usuario_id: 2, datos_propuestos: JSON.stringify({ telefono: "2215550000" }) },
  }));
  const respuesta = await pedir("/api/familiares/33/vinculo", {
    usuario: 2,
    method: "PUT",
    body: { es_familiar: "S", parentesco_id: 3 },
  });
  assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.solicitud_id, 5);
  assert.equal(respuesta.body.reemplazada, true);
  assert.equal(consultas(PENDIENTE_POR_PERSONA_BLOQUEADO).length, 1);
  const [actualizacion] = consultas(/^UPDATE familiar_cambio_solicitud SET datos_anteriores/);
  assert.deepEqual(JSON.parse(actualizacion.params[1]), { telefono: "2215550000", parentesco_id: 3, es_familiar: "S" });
  assert.equal(commits, 1);
});

test("ER_DUP_ENTRY con el pedido de otro afiliado → 409 CAMBIO_PENDIENTE_DE_OTRO; dos veces → 409 claro", async () => {
  preparar(manejadoresPedido({
    pendienteReintento: { id: 5, solicitante_usuario_id: 10, datos_propuestos: "{}" },
  }));
  const deOtro = await pedir("/api/familiares/33/vinculo", { usuario: 2, method: "PUT", body: { es_familiar: "S", parentesco_id: 3 } });
  assert.equal(deOtro.status, 409);
  assert.equal(deOtro.body.codigo, "CAMBIO_PENDIENTE_DE_OTRO");

  preparar(manejadoresPedido({ duplicados: 2 }));
  const dosVeces = await pedir("/api/familiares/33/vinculo", { usuario: 2, method: "PUT", body: { es_familiar: "S", parentesco_id: 3 } });
  assert.equal(dosVeces.status, 409);
  assert.equal(dosVeces.body.codigo, "CAMBIO_PENDIENTE_EXISTENTE");
  assert.equal(consultas(INSERT_SOLICITUD).length, 2);
  assert.equal(rollbacks, 1);
});

test("quitar del grupo a alguien que ya es acompañante → 400 SIN_CAMBIOS con mensaje claro", async () => {
  preparar(manejadoresPedido({ duplicados: 0 }));
  const respuesta = await pedir("/api/familiares/33/vinculo", { usuario: 2, method: "PUT", body: { es_familiar: "N" } });
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body.codigo, "SIN_CAMBIOS");
  assert.equal(respuesta.body.message, "Lucía Paz ya figura como acompañante de viaje: no hay nada para cambiar.");
});

test("POST /familiares/:id/cambios nunca acepta es_familiar (el vínculo tiene su propio pedido)", async () => {
  preparar(manejadoresPedido({ duplicados: 0 }));
  const respuesta = await pedir("/api/familiares/33/cambios", {
    usuario: 2,
    method: "POST",
    body: { es_familiar: "S", telefono: "2215550000" },
  });
  assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
  const [insercion] = consultas(INSERT_SOLICITUD).slice(-1);
  assert.deepEqual(JSON.parse(insercion.params[4]), { telefono: "2215550000" });
});

// ---------------------------------------------------------------------------
// Reasignación al cambiar la departamental del titular (helper exportado)
// ---------------------------------------------------------------------------
test("reasignarSolicitudesPendientesDelTitular mueve los pedidos pendientes y avisa a la departamental nueva", async () => {
  preparar([
    [/^SELECT f\.id, f\.persona_usuario_id, f\.departamental_id FROM familiar_cambio_solicitud f WHERE f\.estado = 'PENDIENTE'/, [[
      { id: 9, persona_usuario_id: 33, departamental_id: 1 },
    ]]],
    [/^UPDATE familiar_cambio_solicitud SET departamental_id = \? WHERE id = \? AND estado = 'PENDIENTE'/, OK],
    [LEER_SOLICITUD, [[filaSolicitud({ departamental_id: 2 })]]],
  ]);
  const conexion = { query: consultar };
  const reasignadas = await reasignarSolicitudesPendientesDelTitular(conexion, { titularId: 2, departamentalId: 2 });
  assert.deepEqual(reasignadas, [{
    solicitud_id: 9, codigo: "FC-9", persona_id: 33, departamental_anterior_id: 1, departamental_nueva_id: 2, notificados: 1,
  }]);
  assert.deepEqual(consultas(/^UPDATE familiar_cambio_solicitud SET departamental_id/)[0].params, [2, 9]);
  const [aviso] = notificaciones();
  assert.equal(aviso.usuario_id, 13);
  assert.equal(aviso.tipo, "FAMILIAR_CAMBIO_SOLICITADO");
  assert.match(aviso.titulo, /^Te pasaron el pedido FC-9/);
  assert.match(aviso.mensaje, /El titular cambió de departamental \(antes La Plata\): ahora lo resolvés vos/);
  // Los avisos viejos del pedido quedan leídos (los de la departamental anterior).
  assert.deepEqual(consultas(/^UPDATE notificacion SET leida = 1/)[0].params, ["FAMILIAR_CAMBIO_SOLICITADO", 9]);

  // Una solicitud que ya no está pendiente no se notifica.
  preparar([[LEER_SOLICITUD, [[filaSolicitud({ estado: "APROBADA" })]]]]);
  assert.equal(await notificarDepartamentalesCambioFamiliar(conexion, { solicitudId: 9, departamentalId: 2 }), 0);
});
