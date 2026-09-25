"use strict";

// Edición completa de usuarios por el staff (services/usuarios-datos.js):
// autorización por rol, lista blanca de campos, DNI único, historial estricto y
// propagación a otros módulos. Las consultas se simulan con una conexión falsa
// que responde por patrón y registra todo lo que se ejecuta.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "usuarios-datos-test-secret";
process.env.BUCKET_REGION ||= "us-east-1";
process.env.ACCESS_KEY ||= "test-access-key";
process.env.SECRET_ACCESS_KEY ||= "test-secret-key";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  ESTADOS_COSEGURO_EDICION_POR_ROL,
  actualizarDatosUsuario,
  camposEditables,
  puedeEditarSolicitudCoseguro,
  puedeGestionarUsuario,
} = require("../api/services/usuarios-datos");

// ---------------------------------------------------------------------------
// Conexión falsa
// ---------------------------------------------------------------------------
function crearConexion(manejadores) {
  const estado = { consultas: [] };
  return {
    estado,
    async query(sql, params = []) {
      const texto = String(sql).replace(/\s+/g, " ").trim();
      estado.consultas.push({ sql: texto, params });
      for (const [patron, respuesta] of manejadores) {
        if (patron.test(texto)) {
          return typeof respuesta === "function" ? respuesta(texto, params, estado) : respuesta;
        }
      }
      throw new Error(`Consulta inesperada: ${texto}`);
    },
  };
}

const OK = [{ affectedRows: 1, insertId: 1 }];
const CARGA_OBJETIVO = /^SELECT u\.\*, r\.nombre AS rol_nombre FROM usuario u LEFT JOIN rol r/;

function consultas(conexion, patron) {
  return conexion.estado.consultas.filter(({ sql }) => patron.test(sql));
}

function titular(extra = {}) {
  return {
    id: 2,
    rol_id: 2,
    rol_nombre: "afiliado",
    nombre: "Nahuel",
    apellido: "Staffa",
    documento: 30111222,
    fecha_nacimiento: "1990-01-01",
    tipo_persona_id: 1,
    parentesco_id: 1,
    es_familiar: null,
    usuario_familiar_id: null,
    departamental_id: 1,
    email: "afiliado@test.com",
    telefono: "2213649349",
    direccion: null,
    dependencia_judicial: null,
    legajo: "222",
    cuil: "20301112220",
    cbu: "0140999861000000123452",
    habilitado: "Y",
    password: "$2a$08$hash",
    foto_archivo: null,
    area_turismo: 1,
    area_coseguro: 1,
    modulo_turismo: 1,
    modulo_coseguro: 1,
    modulo_olimpiadas: 1,
    ...extra,
  };
}

function familiar(extra = {}) {
  return titular({
    id: 8,
    rol_id: 4,
    rol_nombre: "invitado",
    nombre: "Carla",
    apellido: "Ortega",
    documento: 40756125,
    fecha_nacimiento: "1972-01-03",
    tipo_persona_id: 2,
    parentesco_id: 4,
    es_familiar: "S",
    usuario_familiar_id: 2,
    departamental_id: 1,
    email: null,
    legajo: null,
    cuil: null,
    cbu: null,
    password: null,
    ...extra,
  });
}

const ADMIN = { id: 1, rol: "admin", departamental_id: null };
const ADMIN_CENTRAL = { id: 11, rol: "admin-central", departamental_id: null };
const DEPARTAMENTAL_1 = { id: 3, rol: "departamental", departamental_id: 1 };

async function rechazaCon(promesa, { statusCode, codigo, campo }) {
  await assert.rejects(promesa, (error) => {
    assert.equal(error.statusCode, statusCode, error.message);
    if (codigo) assert.equal(error.codigo, codigo);
    if (campo) assert.equal(error.campo, campo);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Autorización
// ---------------------------------------------------------------------------
test("puedeGestionarUsuario: reglas por rol del actor y del objetivo", () => {
  const afiliadoSede1 = { id: 2, rol_nombre: "afiliado", departamental_id: 1 };
  const afiliadoSede4 = { id: 50, rol_nombre: "afiliado", departamental_id: 4 };
  const otroDepartamental = { id: 30, rol_nombre: "departamental", departamental_id: 1 };
  const familiarSinSede = { id: 60, rol_nombre: "invitado", departamental_id: null, departamental_efectiva_id: 1 };

  assert.equal(puedeGestionarUsuario(ADMIN, otroDepartamental), true);
  assert.equal(puedeGestionarUsuario(ADMIN_CENTRAL, afiliadoSede4), true);
  assert.equal(puedeGestionarUsuario(ADMIN_CENTRAL, otroDepartamental), false);
  assert.equal(puedeGestionarUsuario(DEPARTAMENTAL_1, afiliadoSede1), true);
  assert.equal(puedeGestionarUsuario(DEPARTAMENTAL_1, afiliadoSede4), false);
  assert.equal(puedeGestionarUsuario(DEPARTAMENTAL_1, otroDepartamental), false);
  assert.equal(puedeGestionarUsuario(DEPARTAMENTAL_1, familiarSinSede), true);
  assert.equal(puedeGestionarUsuario(DEPARTAMENTAL_1, { id: 3, rol_nombre: "departamental", departamental_id: 1 }), true);
  assert.equal(puedeGestionarUsuario({ id: 2, rol: "afiliado" }, { id: 8, rol_nombre: "invitado" }), false);

  // Campos: el propio perfil no incluye DNI ni habilitado; admin-central no toca rol ni módulos.
  const propios = camposEditables(DEPARTAMENTAL_1, { id: 3 });
  assert.equal(propios.has("documento"), false);
  assert.equal(propios.has("habilitado"), false);
  assert.equal(propios.has("telefono"), true);
  const central = camposEditables(ADMIN_CENTRAL, afiliadoSede4);
  assert.equal(central.has("departamental_id"), true);
  assert.equal(central.has("rol_id"), false);
  assert.equal(central.has("modulo_coseguro"), false);
  assert.equal(central.has("password"), false);
  assert.equal(camposEditables(DEPARTAMENTAL_1, afiliadoSede1).has("departamental_id"), false);
});

test("departamental no puede editar a otro departamental de su misma sede", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[{ ...titular({ id: 30, rol_id: 3, rol_nombre: "departamental" }) }]]],
  ]);
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: DEPARTAMENTAL_1, usuarioId: 30, cambios: { habilitado: "N" } }),
    { statusCode: 403, codigo: "SIN_PERMISO" }
  );
  assert.equal(consultas(conexion, /^UPDATE usuario/).length, 0);
});

test("departamental no puede editar afiliados de otra departamental", async () => {
  const conexion = crearConexion([[CARGA_OBJETIVO, [[titular({ departamental_id: 4 })]]]]);
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: DEPARTAMENTAL_1, usuarioId: 2, cambios: { telefono: "221555" } }),
    { statusCode: 403, codigo: "SIN_PERMISO" }
  );
  assert.equal(consultas(conexion, /^UPDATE usuario/).length, 0);
});

test("departamental edita su perfil, pero no su DNI", async () => {
  const propio = titular({ id: 3, rol_id: 3, rol_nombre: "departamental", documento: 222222, cuil: null, cbu: null });
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[propio]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
  ]);
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: DEPARTAMENTAL_1, usuarioId: 3, cambios: { documento: "22222299" } }),
    { statusCode: 403, codigo: "CAMPO_NO_PERMITIDO", campo: "documento" }
  );
  const resultado = await actualizarDatosUsuario(conexion, {
    actor: DEPARTAMENTAL_1,
    usuarioId: 3,
    cambios: { telefono: "2215551234", documento: "222222" },
  });
  assert.deepEqual(resultado.cambios.map(({ campo }) => campo), ["telefono"]);
});

test("admin-central edita afiliados de cualquier departamental con historial a su nombre", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[titular({ departamental_id: 9 })]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
  ]);
  const resultado = await actualizarDatosUsuario(conexion, {
    actor: ADMIN_CENTRAL,
    usuarioId: 2,
    cambios: { legajo: "L-9", telefono: "2215550000", habilitado: "Y" },
    contexto: { origen: "configuracion", ip: "10.0.0.1", userAgent: "test" },
  });
  assert.deepEqual(resultado.cambios.map(({ campo }) => campo), ["telefono", "legajo"]);
  const [update] = consultas(conexion, /^UPDATE usuario SET/);
  assert.equal(update.sql, "UPDATE usuario SET telefono = ?, legajo = ? WHERE id = ?");
  assert.deepEqual(update.params, ["2215550000", "L-9", 2]);
  const historial = consultas(conexion, /^INSERT INTO historial_usuario/);
  assert.equal(historial.length, 2);
  // Mismo orden de columnas que registrarHistorial de routes/user.js.
  assert.deepEqual(historial[1].params, [2, "UPDATE", "legajo", "222", "L-9", "usuario", 11, "10.0.0.1", "test", "Actualización de configuración de usuario"]);

  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN_CENTRAL, usuarioId: 2, cambios: { rol_id: 5 } }),
    { statusCode: 403, codigo: "CAMPO_NO_PERMITIDO", campo: "rol_id" }
  );
});

test("campos desconocidos y valores inválidos se rechazan con 400", async () => {
  const conexion = crearConexion([[CARGA_OBJETIVO, [[titular()]]]]);
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 2, cambios: { hash_credencial: "x" } }),
    { statusCode: 400, codigo: "CAMPO_DESCONOCIDO" }
  );
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 2, cambios: { documento: "123456789" } }),
    { statusCode: 400, codigo: "DATO_INVALIDO", campo: "documento" }
  );
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 2, cambios: { nombre: "x".repeat(46) } }),
    { statusCode: 400, campo: "nombre" }
  );
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 2, cambios: { cbu: "123" } }),
    { statusCode: 400, campo: "cbu" }
  );
});

// ---------------------------------------------------------------------------
// DNI único
// ---------------------------------------------------------------------------
test("DNI repetido responde 409 DNI_DUPLICADO sin escribir nada", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[familiar()]]],
    [/^SELECT id FROM usuario WHERE documento = \? AND id <> \?/, [[{ id: 2 }]]],
  ]);
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: DEPARTAMENTAL_1, usuarioId: 8, cambios: { documento: "30.111.222" } }),
    { statusCode: 409, codigo: "DNI_DUPLICADO", campo: "documento" }
  );
  const [chequeo] = consultas(conexion, /WHERE documento = \?/);
  assert.deepEqual(chequeo.params, [30111222, 8]);
  // Sin FOR UPDATE: con un DNI inexistente el gap lock chocaba con otro cambio
  // de DNI concurrente; la unicidad la garantiza documento_UNIQUE (ER_DUP_ENTRY).
  assert.doesNotMatch(chequeo.sql, /FOR UPDATE/);
  assert.equal(consultas(conexion, /^UPDATE usuario/).length, 0);

  // El admin recibe además el id de la otra persona; la departamental no.
  await assert.rejects(
    actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 8, cambios: { documento: "30111222" } }),
    (error) => error.usuario_existente_id === 2
  );
  await assert.rejects(
    actualizarDatosUsuario(conexion, { actor: DEPARTAMENTAL_1, usuarioId: 8, cambios: { documento: "30111222" } }),
    (error) => error.usuario_existente_id === undefined && !/Staffa/.test(error.message)
  );
});

test("el email repetido se busca con una lectura que no bloquea la tabla usuario", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[familiar()]]],
    [/^SELECT id FROM usuario WHERE LOWER\(TRIM\(email\)\) = \?/, (_sql, params) => [params[0] === "usado@test.com" ? [{ id: 2 }] : []]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
  ]);
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 8, cambios: { email: " Usado@Test.com " } }),
    { statusCode: 409, codigo: "EMAIL_DUPLICADO", campo: "email" }
  );
  const [chequeo] = consultas(conexion, /LOWER\(TRIM\(email\)\)/);
  assert.deepEqual(chequeo.params, ["usado@test.com", 8]);
  assert.doesNotMatch(chequeo.sql, /FOR UPDATE/);
  assert.equal(consultas(conexion, /^UPDATE usuario/).length, 0);

  const resultado = await actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 8, cambios: { email: "libre@test.com" } });
  assert.deepEqual(resultado.cambios.map(({ campo }) => campo), ["email"]);
});

test("un ER_DUP_ENTRY del UPDATE (carrera) también se traduce a DNI_DUPLICADO", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[familiar()]]],
    [/^SELECT id FROM usuario WHERE documento/, [[]]],
    [/^UPDATE usuario SET/, () => {
      const error = new Error("Duplicate entry '30111223' for key 'usuario.documento_UNIQUE'");
      error.code = "ER_DUP_ENTRY";
      throw error;
    }],
  ]);
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 8, cambios: { documento: "30111223" } }),
    { statusCode: 409, codigo: "DNI_DUPLICADO" }
  );
});

// ---------------------------------------------------------------------------
// Historial estricto
// ---------------------------------------------------------------------------
test("si falla el historial, el error sube para que la transacción se revierta", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[familiar()]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, () => { throw new Error("historial caído"); }],
  ]);
  await assert.rejects(
    actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 8, cambios: { telefono: "2210000000" } }),
    /historial caído/
  );
});

// ---------------------------------------------------------------------------
// Email opcional para familiares / invitados
// ---------------------------------------------------------------------------
test("el email es opcional para familiares pero obligatorio para titulares con cuenta", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, (_sql, params) => [[params[0] === 8 ? familiar({ email: "carla@test.com" }) : titular()]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
  ]);
  const resultado = await actualizarDatosUsuario(conexion, { actor: DEPARTAMENTAL_1, usuarioId: 8, cambios: { email: "" } });
  assert.deepEqual(resultado.cambios, [{ campo: "email", valorAnterior: "carla@test.com", valorNuevo: null }]);

  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: DEPARTAMENTAL_1, usuarioId: 2, cambios: { email: "" } }),
    { statusCode: 400, codigo: "EMAIL_OBLIGATORIO" }
  );
});

// ---------------------------------------------------------------------------
// Reglas de tipo de persona / edad / parentesco
// ---------------------------------------------------------------------------
test("tipo Menores de 2 años exige menos de 2 años y tipo familiar exige parentesco familiar", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[familiar()]]],
    [/^SELECT id FROM tipo_persona WHERE id = \?/, [[{ id: 5 }]]],
    [/^SELECT id FROM parentesco WHERE id = \?/, [[{ id: 5 }]]],
  ]);
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN_CENTRAL, usuarioId: 8, cambios: { tipo_persona_id: 5 } }),
    { statusCode: 422, codigo: "TIPO_PERSONA_EDAD_INCONSISTENTE" }
  );
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN_CENTRAL, usuarioId: 8, cambios: { parentesco_id: 5 } }),
    { statusCode: 422, codigo: "TIPO_PERSONA_PARENTESCO_INCONSISTENTE" }
  );
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN_CENTRAL, usuarioId: 8, cambios: { parentesco_id: 1 } }),
    { statusCode: 422 }
  );
});

// ---------------------------------------------------------------------------
// Propagación
// ---------------------------------------------------------------------------
const MIEMBROS_GRUPO_2 = [
  { id: 8, nombre: "Carla", apellido: "Ortega", departamental_id: 1 },
  { id: 9, nombre: "Walter", apellido: "Olmos", departamental_id: 1 },
];

function manejadoresDepartamental({
  traslados = [],
  solicitudes = [],
  inscripciones = [],
  miembros = MIEMBROS_GRUPO_2,
} = {}) {
  return [
    [CARGA_OBJETIVO, [[titular()]]],
    [/^SELECT id, nombre FROM departamental WHERE id = \? AND habilitado = 'Y'/, [[{ id: 4, nombre: "Mercedes" }]]],
    [/^SELECT id, nombre FROM departamental WHERE id IN/, [[
      { id: 1, nombre: "La Plata" }, { id: 4, nombre: "Mercedes" }, { id: 7, nombre: "Junín" },
    ]]],
    [/^UPDATE usuario SET departamental_id = \? WHERE id = \?/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/FROM usuario WHERE usuario_familiar_id IN \(\?\)/, (_sql, params) => (params[0].includes(2) ? [miembros] : [[]])],
    [/FROM traslado_solicitud/, [traslados]],
    [/^UPDATE traslado_solicitud/, OK],
    [/^INSERT INTO traslado_historial/, OK],
    [/FROM coseguro_solicitud/, [solicitudes]],
    [/^UPDATE coseguro_solicitud/, OK],
    [/^INSERT INTO coseguro_historial/, OK],
    [/FROM olimpiada_inscripcion i/, [inscripciones]],
    // reasignarSolicitudesPendientesDelTitular (familiares-cambios.js) real: sin pedidos pendientes.
    [/FROM familiar_cambio_solicitud/, [[]]],
  ];
}

test("cambiar la departamental del titular la propaga a su grupo, coseguro abierto y traslados", async () => {
  const conexion = crearConexion(manejadoresDepartamental({
    traslados: [{ id: 5, usuario_id: 2, departamental_origen_id: 1, departamental_destino_id: 7 }],
    solicitudes: [{ id: 4, usuario_id: 2, estado_id: 1, departamental_id: 1 }],
    inscripciones: [{ id: 1, usuario_id: 2, departamental_id: 1, olimpiada_nombre: "Olimpíadas 2026" }],
  }));
  const resultado = await actualizarDatosUsuario(conexion, {
    actor: ADMIN_CENTRAL,
    usuarioId: 2,
    cambios: { departamental_id: "4" },
  });

  assert.deepEqual(resultado.cambios, [{ campo: "departamental_id", valorAnterior: 1, valorNuevo: 4 }]);
  const updates = consultas(conexion, /^UPDATE usuario SET departamental_id/);
  assert.deepEqual(updates.map(({ params }) => params), [[4, 2], [4, 8], [4, 9]]);
  // Historial para el titular y para cada familiar.
  const historial = consultas(conexion, /^INSERT INTO historial_usuario/);
  assert.deepEqual(historial.map(({ params }) => params[0]), [2, 8, 9]);
  assert.ok(historial.every(({ params }) => params[2] === "departamental_id" && params[4] === 4 && params[6] === 11));

  // Coseguro: sólo estados 1-3, con historial del módulo.
  const [consultaCoseguro] = consultas(conexion, /FROM coseguro_solicitud/);
  assert.deepEqual(consultaCoseguro.params, [[2, 8, 9], [1, 2, 3], 4]);
  assert.deepEqual(consultas(conexion, /^UPDATE coseguro_solicitud/)[0].params, [4, 4]);
  const [histCoseguro] = consultas(conexion, /^INSERT INTO coseguro_historial/);
  assert.equal(histCoseguro.params[0], 4);
  assert.equal(histCoseguro.params[4], "La Plata");
  assert.equal(histCoseguro.params[5], "Mercedes");

  // Traslado iniciado: cambia el origen y deja historial.
  assert.deepEqual(consultas(conexion, /^UPDATE traslado_solicitud/)[0].params, [4, 5, 1]);
  assert.equal(consultas(conexion, /^INSERT INTO traslado_historial/).length, 1);

  assert.deepEqual(
    resultado.propagaciones.map(({ modulo, id }) => `${modulo}:${id}`),
    ["usuarios:8", "usuarios:9", "traslados:5", "coseguro:4"]
  );
  // Olimpiadas: no se mueve, se avisa.
  assert.ok(resultado.advertencias.some(({ codigo }) => codigo === "OLIMPIADA_DELEGACION_SIN_CAMBIO"));
});

test("no se puede pasar a la departamental destino de un traslado iniciado", async () => {
  const conexion = crearConexion(manejadoresDepartamental({
    traslados: [{ id: 5, usuario_id: 2, departamental_origen_id: 1, departamental_destino_id: 4 }],
  }));
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 2, cambios: { departamental_id: 4 } }),
    { statusCode: 409, codigo: "TRASLADO_DESTINO_IGUAL" }
  );
  assert.equal(consultas(conexion, /^UPDATE traslado_solicitud/).length, 0);
  assert.equal(consultas(conexion, /^UPDATE coseguro_solicitud/).length, 0);
});

test("el titular cambia de departamental: no arrastra a integrantes con sede propia y avisa", async () => {
  const conexion = crearConexion(manejadoresDepartamental({
    miembros: [
      { id: 8, nombre: "Carla", apellido: "Ortega", departamental_id: 1 },
      { id: 9, nombre: "Walter", apellido: "Olmos", departamental_id: null },
      // Afiliada con cuenta y sede propias: no depende de la del titular.
      { id: 10, nombre: "Martina", apellido: "Rodriguez", departamental_id: 7 },
      // Ya estaba en la sede nueva: no se toca ni se avisa.
      { id: 22, nombre: "Ana", apellido: "Paz", departamental_id: 4 },
    ],
    solicitudes: [{ id: 4, usuario_id: 9, estado_id: 1, departamental_id: 1 }],
  }));
  const resultado = await actualizarDatosUsuario(conexion, { actor: ADMIN_CENTRAL, usuarioId: 2, cambios: { departamental_id: 4 } });

  assert.deepEqual(consultas(conexion, /^UPDATE usuario SET departamental_id/).map(({ params }) => params), [[4, 2], [4, 8], [4, 9]]);
  const aviso = resultado.advertencias.find(({ codigo }) => codigo === "DEPARTAMENTAL_INTEGRANTE_NO_PROPAGADA");
  assert.ok(aviso, JSON.stringify(resultado.advertencias));
  assert.equal(aviso.usuario_id, 10);
  assert.match(aviso.mensaje, /Martina Rodriguez \(grupo familiar\) tiene su propia departamental \(Junín\) y no se pasó a Mercedes/);
  assert.equal(resultado.advertencias.filter(({ codigo }) => codigo === "DEPARTAMENTAL_INTEGRANTE_NO_PROPAGADA").length, 1);

  // Coseguro y traslados sólo de las personas que efectivamente cambiaron.
  assert.deepEqual(consultas(conexion, /FROM traslado_solicitud/)[0].params[0], [2, 8, 9]);
  assert.deepEqual(consultas(conexion, /FROM coseguro_solicitud/)[0].params[0], [2, 8, 9]);
  assert.deepEqual(resultado.propagaciones.map(({ modulo, id }) => `${modulo}:${id}`), ["usuarios:8", "usuarios:9", "coseguro:4"]);
});

// La reasignación de pedidos la hace services/familiares-cambios.js (dueño de
// la tabla y de sus avisos); acá se simula para probar la llamada y el informe.
const familiaresCambios = require("../api/services/familiares-cambios");

async function conReasignacionSimulada(respuesta, prueba) {
  const original = familiaresCambios.reasignarSolicitudesPendientesDelTitular;
  const llamadas = [];
  familiaresCambios.reasignarSolicitudesPendientesDelTitular = async (conexion, argumentos) => {
    llamadas.push({ conexion, argumentos });
    return respuesta;
  };
  try {
    await prueba(llamadas);
  } finally {
    familiaresCambios.reasignarSolicitudesPendientesDelTitular = original;
  }
}

test("los pedidos pendientes de cambios de familiares se reasignan a la departamental nueva del titular", async () => {
  assert.equal(typeof familiaresCambios.reasignarSolicitudesPendientesDelTitular, "function");
  const reasignadas = [
    { solicitud_id: 31, codigo: "FC-31", persona_id: 8, departamental_anterior_id: 1, departamental_nueva_id: 4, notificados: 2 },
    { solicitud_id: 32, codigo: "FC-32", persona_id: 22, departamental_anterior_id: 1, departamental_nueva_id: 4, notificados: 0 },
  ];
  await conReasignacionSimulada(reasignadas, async (llamadas) => {
    const conexion = crearConexion(manejadoresDepartamental());
    const resultado = await actualizarDatosUsuario(conexion, { actor: ADMIN_CENTRAL, usuarioId: 2, cambios: { departamental_id: 4 } });
    assert.equal(llamadas.length, 1);
    // Dentro de la misma transacción, sin avisarle a quien hizo el cambio.
    assert.equal(llamadas[0].conexion, conexion);
    assert.deepEqual(llamadas[0].argumentos, { titularId: 2, departamentalId: 4, excluirUsuarioId: 11 });
    const pedidos = resultado.propagaciones.filter(({ modulo }) => modulo === "familiares");
    assert.deepEqual(
      pedidos.map(({ tabla, id, campo, valorAnterior, valorNuevo }) => [tabla, id, campo, valorAnterior, valorNuevo]),
      [["familiar_cambio_solicitud", 31, "departamental_id", 1, 4], ["familiar_cambio_solicitud", 32, "departamental_id", 1, 4]]
    );
    assert.equal(pedidos[0].descripcion, "El pedido de cambio de datos FC-31 pasa a la departamental Mercedes y se avisó a 2 usuarios de esa sede");
    assert.equal(pedidos[1].descripcion, "El pedido de cambio de datos FC-32 pasa a la departamental Mercedes");
  });
});

test("un integrante (no titular) que cambia de departamental no mueve pedidos de familiares", async () => {
  await conReasignacionSimulada([], async (llamadas) => {
    const manejadores = manejadoresDepartamental();
    manejadores[0] = [CARGA_OBJETIVO, [[familiar()]]];
    const conexion = crearConexion(manejadores);
    const resultado = await actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 8, cambios: { departamental_id: 4 } });
    assert.ok(resultado.advertencias.some(({ codigo }) => codigo === "DEPARTAMENTAL_DISTINTA_TITULAR"));
    assert.equal(llamadas.length, 0);
    assert.equal(consultas(conexion, /FROM usuario WHERE usuario_familiar_id IN/).length, 0);
  });
});

test("CUIL/CBU nuevos se copian a las solicitudes de coseguro abiertas con historial", async () => {
  const cbuNuevo = "2850590940090418135201";
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[titular()]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/FROM coseguro_solicitud/, [[
      { id: 4, estado_id: 1, cuil_afiliado: "20301112220", cbu: "0140999861000000123452" },
      { id: 6, estado_id: 4, cuil_afiliado: "20301112220", cbu: cbuNuevo },
    ]]],
    [/^UPDATE coseguro_solicitud/, OK],
    [/^INSERT INTO coseguro_historial/, OK],
  ]);
  const resultado = await actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 2, cambios: { cbu: cbuNuevo } });
  const [consulta] = consultas(conexion, /FROM coseguro_solicitud/);
  assert.deepEqual(consulta.params, [2, [1, 2, 3, 4, 7]]);
  const updates = consultas(conexion, /^UPDATE coseguro_solicitud/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sql, "UPDATE coseguro_solicitud SET cbu = ? WHERE id = ? AND eliminado = 0");
  assert.deepEqual(updates[0].params, [cbuNuevo, 4]);
  assert.equal(consultas(conexion, /^INSERT INTO coseguro_historial/).length, 1);
  assert.equal(resultado.propagaciones.length, 1);
  assert.equal(resultado.advertencias.some(({ codigo }) => codigo === "COSEGURO_DATO_BANCARIO_NO_PROPAGADO"), false);
});

test("la matriz de estados de CUIL/CBU es la misma ESTADOS_EDICION_POR_ROL de routes/coseguro.js", () => {
  const fuente = fs.readFileSync(path.join(__dirname, "..", "api", "routes", "coseguro.js"), "utf8");
  const bloque = (nombre) => {
    const inicio = fuente.indexOf(`const ${nombre} = {`);
    assert.ok(inicio >= 0, `No encontré ${nombre} en routes/coseguro.js`);
    return fuente.slice(inicio, fuente.indexOf("};", inicio) + 2);
  };
  const matrizRouter = vm.runInNewContext(
    `${bloque("ESTADO")}\n${bloque("ESTADOS_EDICION_POR_ROL")}\nESTADOS_EDICION_POR_ROL`
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ESTADOS_COSEGURO_EDICION_POR_ROL)),
    JSON.parse(JSON.stringify(matrizRouter))
  );
});

test("puedeEditarSolicitudCoseguro: mismos estados, sede y área que la edición en Coseguro", () => {
  const solicitud = (estado_id, extra = {}) => ({ id: 1, usuario_id: 2, departamental_id: 1, estado_id, ...extra });
  const afiliado = { id: 2, rol: "afiliado" };
  assert.deepEqual([1, 2, 3, 4, 7].filter((estado) => puedeEditarSolicitudCoseguro(afiliado, solicitud(estado))), [1, 2]);
  assert.equal(puedeEditarSolicitudCoseguro({ id: 5, rol: "afiliado" }, solicitud(1)), false);
  assert.equal(puedeEditarSolicitudCoseguro({ ...afiliado, modulo_coseguro: 0 }, solicitud(1)), false);
  assert.deepEqual([1, 2, 3, 4, 7].filter((estado) => puedeEditarSolicitudCoseguro(DEPARTAMENTAL_1, solicitud(estado))), [1, 2, 3, 4]);
  assert.equal(puedeEditarSolicitudCoseguro(DEPARTAMENTAL_1, solicitud(1, { departamental_id: 4 })), false);
  assert.equal(puedeEditarSolicitudCoseguro({ ...DEPARTAMENTAL_1, area_coseguro: 0 }, solicitud(1)), false);
  assert.deepEqual([1, 2, 3, 4, 7].filter((estado) => puedeEditarSolicitudCoseguro(ADMIN_CENTRAL, solicitud(estado))), [4, 7]);
  assert.deepEqual([1, 2, 3, 4, 7].filter((estado) => puedeEditarSolicitudCoseguro(ADMIN, solicitud(estado))), [1, 2, 3, 4, 7]);
  assert.equal(puedeEditarSolicitudCoseguro({ id: 12, rol: "auditor" }, solicitud(7)), false);
});

function manejadoresBancarios(solicitudes, objetivo = titular()) {
  return [
    [CARGA_OBJETIVO, [[objetivo]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/FROM coseguro_solicitud/, [solicitudes]],
    [/^UPDATE coseguro_solicitud/, OK],
    [/^INSERT INTO coseguro_historial/, OK],
  ];
}

const CBU_NUEVO = "2850590940090418135201";
const SOLICITUDES_ABIERTAS_2 = [
  { id: 4, usuario_id: 2, departamental_id: 1, estado_id: 1, cuil_afiliado: "20301112220", cbu: "0140999861000000123452" },
  { id: 5, usuario_id: 2, departamental_id: 1, estado_id: 3, cuil_afiliado: "20301112220", cbu: "0140999861000000123452" },
  { id: 6, usuario_id: 2, departamental_id: 1, estado_id: 4, cuil_afiliado: "20301112220", cbu: "0140999861000000123452" },
  { id: 7, usuario_id: 2, departamental_id: 4, estado_id: 2, cuil_afiliado: "20301112220", cbu: "0140999861000000123452" },
  { id: 8, usuario_id: 2, departamental_id: 1, estado_id: 7, cuil_afiliado: "20301112220", cbu: "0140999861000000123452" },
];

test("el afiliado que cambia su CBU no lo pasa a solicitudes ya aprobadas: se avisan con sus ids", async () => {
  const conexion = crearConexion(manejadoresBancarios(SOLICITUDES_ABIERTAS_2));
  const resultado = await actualizarDatosUsuario(conexion, {
    actor: { id: 2, rol: "afiliado", departamental_id: 1 },
    usuarioId: 2,
    cambios: { cbu: CBU_NUEVO },
  });
  // Sólo las Iniciadas / A revisar (las que el afiliado puede editar en Coseguro).
  assert.deepEqual(consultas(conexion, /^UPDATE coseguro_solicitud/).map(({ params }) => params), [
    [CBU_NUEVO, 4],
    [CBU_NUEVO, 7],
  ]);
  assert.deepEqual(consultas(conexion, /^INSERT INTO coseguro_historial/).map(({ params }) => params[0]), [4, 7]);
  const aviso = resultado.advertencias.find(({ codigo }) => codigo === "COSEGURO_DATO_BANCARIO_NO_PROPAGADO");
  assert.ok(aviso, JSON.stringify(resultado.advertencias));
  assert.deepEqual(aviso.solicitudes, [5, 6, 8]);
  assert.match(aviso.mensaje, /El CBU nuevo no se copió a las solicitudes de reintegro #5 \(revisada\), #6 \(aprobada por la departamental\) y #8 \(aprobada por Servicios Sociales\)/);
  assert.match(aviso.mensaje, /avisale a tu departamental/);
  assert.deepEqual(resultado.propagaciones.map(({ id }) => id), [4, 7]);
});

test("CUIL/CBU desde la ficha: departamental sólo 1-4 de su sede, admin-central sólo 4 y 7", async () => {
  const cuilNuevo = "20301112239";
  const departamental = crearConexion(manejadoresBancarios(SOLICITUDES_ABIERTAS_2));
  const porDepartamental = await actualizarDatosUsuario(departamental, {
    actor: DEPARTAMENTAL_1,
    usuarioId: 2,
    cambios: { cbu: CBU_NUEVO, cuil: cuilNuevo },
  });
  assert.deepEqual(consultas(departamental, /^UPDATE coseguro_solicitud/).map(({ params }) => params.at(-1)), [4, 5, 6]);
  assert.equal(
    consultas(departamental, /^UPDATE coseguro_solicitud/)[0].sql,
    "UPDATE coseguro_solicitud SET cuil_afiliado = ?, cbu = ? WHERE id = ? AND eliminado = 0"
  );
  const avisoDepartamental = porDepartamental.advertencias.find(({ codigo }) => codigo === "COSEGURO_DATO_BANCARIO_NO_PROPAGADO");
  assert.deepEqual(avisoDepartamental.solicitudes, [7, 8]);
  assert.match(avisoDepartamental.mensaje, /^El CUIL y el CBU nuevos no se copiaron/);
  assert.match(avisoDepartamental.mensaje, /corregilo desde Coseguro/);

  const central = crearConexion(manejadoresBancarios(SOLICITUDES_ABIERTAS_2));
  const porCentral = await actualizarDatosUsuario(central, { actor: ADMIN_CENTRAL, usuarioId: 2, cambios: { cbu: CBU_NUEVO } });
  assert.deepEqual(consultas(central, /^UPDATE coseguro_solicitud/).map(({ params }) => params.at(-1)), [6, 8]);
  assert.deepEqual(
    porCentral.advertencias.find(({ codigo }) => codigo === "COSEGURO_DATO_BANCARIO_NO_PROPAGADO").solicitudes,
    [4, 5, 7]
  );

  // Sin área Coseguro no toca ninguna solicitud (el perfil sí cambia).
  const sinArea = crearConexion(manejadoresBancarios(SOLICITUDES_ABIERTAS_2));
  const resultadoSinArea = await actualizarDatosUsuario(sinArea, {
    actor: { ...DEPARTAMENTAL_1, area_coseguro: 0 },
    usuarioId: 2,
    cambios: { cbu: CBU_NUEVO },
  });
  assert.equal(consultas(sinArea, /^UPDATE usuario SET cbu/).length, 1);
  assert.equal(consultas(sinArea, /^UPDATE coseguro_solicitud/).length, 0);
  assert.deepEqual(
    resultadoSinArea.advertencias.find(({ codigo }) => codigo === "COSEGURO_DATO_BANCARIO_NO_PROPAGADO").solicitudes,
    [4, 5, 6, 7, 8]
  );
});

test("con propagar:false (sincronización desde coseguro) sólo cambia el perfil", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[titular({ cbu: null })]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
  ]);
  const resultado = await actualizarDatosUsuario(conexion, {
    actor: { id: 2, rol: "afiliado" },
    usuarioId: 2,
    cambios: { cuil: "20301112220", cbu: "0140999861000000123452" },
    contexto: { origen: "coseguro", observaciones: "CUIL/CBU tomados de la solicitud de reintegro #9" },
    opciones: { propagar: false, autorizacionPrevia: true },
  });
  assert.deepEqual(resultado.cambios.map(({ campo }) => campo), ["cbu"]);
  assert.equal(consultas(conexion, /coseguro_solicitud/).length, 0);
  assert.equal(consultas(conexion, /^INSERT INTO historial_usuario/)[0].params[9], "CUIL/CBU tomados de la solicitud de reintegro #9");
});

test("cambiar el parentesco recalcula es_familiar y corrige la etiqueta en reservas abiertas", async () => {
  const acompaniante = familiar({ id: 22, tipo_persona_id: 3, parentesco_id: 5, es_familiar: "N", nombre: "Ana", apellido: "Paz" });
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[acompaniante]]],
    [/^SELECT id FROM parentesco WHERE id = \?/, [[{ id: 2 }]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/FROM reserva_familiar rf INNER JOIN reserva r/, [[{ id: 90, reserva_id: 40, parentesco_id: 5, estado_reserva_id: 3 }]]],
    [/^SELECT id, nombre FROM parentesco WHERE id IN/, [[{ id: 2, nombre: "Pareja" }, { id: 5, nombre: "Otro" }]]],
    [/^UPDATE reserva_familiar SET parentesco_id/, OK],
    [/^INSERT INTO historial_reserva/, OK],
  ]);
  const resultado = await actualizarDatosUsuario(conexion, { actor: DEPARTAMENTAL_1, usuarioId: 22, cambios: { parentesco_id: 2 } });
  assert.deepEqual(resultado.cambios.map(({ campo, valorNuevo }) => [campo, valorNuevo]), [["parentesco_id", 2], ["es_familiar", "S"]]);
  const [consultaReservas] = consultas(conexion, /FROM reserva_familiar rf INNER JOIN reserva r/);
  assert.deepEqual(consultaReservas.params[1], [1, 2, 3, 6, 7, 9, 10, 11]);
  assert.match(consultaReservas.sql, /FOR UPDATE OF rf$/);
  assert.deepEqual(consultas(conexion, /^UPDATE reserva_familiar/)[0].params, [2, 90]);
  // Nunca toca el precio (lo protege el trigger ajb_rf_guard_bu).
  assert.doesNotMatch(consultas(conexion, /^UPDATE reserva_familiar/)[0].sql, /precio/);
  const [observacion] = consultas(conexion, /^INSERT INTO historial_reserva/);
  assert.match(observacion.sql, /'OBSERVACION'/);
  assert.deepEqual(observacion.params.slice(0, 4), [40, "parentesco", "Otro", "Pareja"]);
});

test("tipo de persona o nacimiento distintos a lo cotizado: observación y reservasAfectadas, sin tocar tarifas", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[familiar()]]],
    [/^SELECT id FROM tipo_persona WHERE id = \?/, [[{ id: 3 }]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/FROM reserva_familiar rf INNER JOIN reserva r/, [[
      { reserva_id: 40, tipo_persona_id: 2, edad: 58, fecha_inicio: "2030-03-01", fecha_fin: "2030-03-05", estado_reserva_id: 3, estado_nombre: "Aprobada" },
      { reserva_id: 41, tipo_persona_id: 3, edad: 57, fecha_inicio: "2029-06-10", fecha_fin: "2029-06-12", estado_reserva_id: 1, estado_nombre: "Iniciada" },
    ]]],
    [/^SELECT id, nombre FROM tipo_persona WHERE id IN/, [[{ id: 2, nombre: "Invitados familiares" }, { id: 3, nombre: "Invitados generales" }]]],
    [/^INSERT INTO historial_reserva/, OK],
  ]);
  const resultado = await actualizarDatosUsuario(conexion, {
    actor: ADMIN,
    usuarioId: 8,
    cambios: { tipo_persona_id: 3, fecha_nacimiento: "1972-06-01" },
  });
  // Reserva 40: cambia el tipo (2 → 3) y la edad al ingreso (58 → 57).
  // Reserva 41: tipo igual y edad 57 → 57: no se marca.
  assert.equal(resultado.reservasAfectadas.length, 1);
  assert.equal(resultado.reservasAfectadas[0].reserva_id, 40);
  assert.equal(resultado.reservasAfectadas[0].estado, "Aprobada");
  assert.match(resultado.reservasAfectadas[0].motivo, /conserva la tarifa cotizada/);
  assert.match(resultado.reservasAfectadas[0].motivo, /58/);
  assert.equal(consultas(conexion, /^INSERT INTO historial_reserva/).length, 1);
  assert.equal(consultas(conexion, /^UPDATE reserva/).length, 0);
});

test("cambiar el DNI actualiza bonos de olimpiadas sin sorteo y avisa login y CUIL", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[titular()]]],
    [/^SELECT id FROM usuario WHERE documento/, [[]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/FROM olimpiada_bono b/, [[{ id: 7, olimpiada_id: 1, inscripcion_id: 1, comprador_nombre: "Staffa, Nahuel", comprador_documento: "30.111.222" }]]],
    [/^UPDATE olimpiada_bono SET/, OK],
    [/^INSERT INTO olimpiada_historial/, OK],
    [/^SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = \?/, [[{ id: 2, usuario_familiar_id: null, departamental_id: 1 }]]],
    [/^SELECT id FROM usuario WHERE usuario_familiar_id = \?/, [[{ id: 8 }]]],
    [/FROM olimpiada_inscripcion_acompaniante a/, [[{ id: 4, inscripcion_id: 1, olimpiada_id: 1, nombre: "Nahuel", apellido: "Staffa", documento: "30111222" }]]],
    [/^UPDATE olimpiada_inscripcion_acompaniante SET/, OK],
  ]);
  const resultado = await actualizarDatosUsuario(conexion, { actor: ADMIN, usuarioId: 2, cambios: { documento: "30111223" } });

  const [bonos] = consultas(conexion, /FROM olimpiada_bono b/);
  assert.deepEqual(bonos.params, [2, "30111222"]);
  assert.match(bonos.sql, /COALESCE\(o\.sorteo_publicado, 0\) = 0/);
  assert.match(bonos.sql, /a_nombre_departamental = 0/);
  assert.deepEqual(consultas(conexion, /^UPDATE olimpiada_bono/)[0].params, ["30111223", 7]);
  const [acompaniantes] = consultas(conexion, /FROM olimpiada_inscripcion_acompaniante a/);
  assert.deepEqual(acompaniantes.params[0], [2, 8]);
  const [updateAcomp] = consultas(conexion, /^UPDATE olimpiada_inscripcion_acompaniante/);
  assert.equal(updateAcomp.sql, "UPDATE olimpiada_inscripcion_acompaniante SET documento = ? WHERE id = ?");
  assert.doesNotMatch(updateAcomp.sql, /fecha_nacimiento/);
  assert.equal(consultas(conexion, /^INSERT INTO olimpiada_historial/).length, 2);

  const codigos = resultado.advertencias.map(({ codigo }) => codigo);
  assert.ok(codigos.includes("LOGIN_CAMBIA_DNI"));
  assert.ok(codigos.includes("CUIL_CON_DNI_ANTERIOR"));
});

test("reenviar un dato viejo inválido sin cambiarlo no bloquea el guardado", async () => {
  const conexion = crearConexion([
    [CARGA_OBJETIVO, [[titular({ cuil: "20301112225" })]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
  ]);
  const resultado = await actualizarDatosUsuario(conexion, {
    actor: { id: 2, rol: "afiliado" },
    usuarioId: 2,
    cambios: { cuil: "20-30111222-5", telefono: "2215550001" },
  });
  assert.deepEqual(resultado.cambios.map(({ campo }) => campo), ["telefono"]);
  await rechazaCon(
    actualizarDatosUsuario(conexion, { actor: { id: 2, rol: "afiliado" }, usuarioId: 2, cambios: { cuil: "20301112226" } }),
    { statusCode: 400, campo: "cuil" }
  );
});

test("sin diferencias no se escribe nada", async () => {
  const conexion = crearConexion([[CARGA_OBJETIVO, [[familiar()]]]]);
  const resultado = await actualizarDatosUsuario(conexion, {
    actor: ADMIN,
    usuarioId: 8,
    cambios: { nombre: " Carla ", documento: "40756125", fecha_nacimiento: "1972-01-03", email: "", cuil: "" },
  });
  assert.deepEqual(resultado.cambios, []);
  assert.equal(conexion.estado.consultas.length, 1);
});

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
const sesiones = {
  1: { id: 1, rol_id: 1, rol: "admin", departamental_id: null },
  3: { id: 3, rol_id: 3, rol: "departamental", departamental_id: 1 },
  11: { id: 11, rol_id: 5, rol: "admin-central", departamental_id: null },
};
let manejadorRutas = async (sql) => { throw new Error(`Consulta inesperada: ${sql}`); };
const llamadasRutas = [];
let commits = 0;
let rollbacks = 0;

function esConsultaSesion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

async function consultarRuta(sql, params = []) {
  const texto = String(sql).replace(/\s+/g, " ").trim();
  llamadasRutas.push({ sql: texto, params });
  if (esConsultaSesion(texto)) {
    const sesion = sesiones[params[0]];
    return [[{ habilitado: "Y", area_turismo: 1, area_coseguro: 1, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1, ...sesion }]];
  }
  return manejadorRutas(texto, params);
}

const conexionTransaccional = {
  query: consultarRuta,
  execute: consultarRuta,
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
      return { query: consultarRuta, execute: consultarRuta, getConnection: async () => conexionTransaccional };
    },
  },
};

const app = express();
app.use(express.json());
app.use("/api", require("../api/routes/user"));
app.use("/api", require("../api/routes/coseguro"));

const consoleWarnOriginal = console.warn;
test.before(() => { console.warn = () => {}; });
test.after(() => { console.warn = consoleWarnOriginal; });

function prepararRutas(manejadores) {
  llamadasRutas.length = 0;
  commits = 0;
  rollbacks = 0;
  manejadorRutas = async (sql, params) => {
    for (const [patron, respuesta] of manejadores) {
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

test("PUT /configuracion/usuario/:id: admin-central cambia el DNI de un afiliado y recibe las advertencias", async () => {
  prepararRutas([
    [CARGA_OBJETIVO, [[titular({ departamental_id: 9 })]]],
    [/^SELECT id FROM usuario WHERE documento/, [[]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/FROM olimpiada_bono b/, [[]]],
    [/^SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = \?/, [[{ id: 2, usuario_familiar_id: null, departamental_id: 9 }]]],
    [/^SELECT id FROM usuario WHERE usuario_familiar_id = \?/, [[]]],
    [/FROM olimpiada_inscripcion_acompaniante a/, [[]]],
  ]);
  const respuesta = await pedir("/api/configuracion/usuario/2", {
    usuario: 11,
    method: "PUT",
    body: { documento: "30111223", nombre: "Nahuel", rol_id: "2" },
  });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.success, true);
  assert.equal(respuesta.body.message, "Usuario actualizado correctamente");
  assert.deepEqual(respuesta.body.cambios, [{ campo: "documento", valorAnterior: 30111222, valorNuevo: 30111223 }]);
  assert.ok(respuesta.body.advertencias.some(({ codigo }) => codigo === "LOGIN_CAMBIA_DNI"));
  assert.deepEqual(respuesta.body.propagaciones, []);
  assert.deepEqual(respuesta.body.reservasAfectadas, []);
  assert.equal(commits, 1);
});

test("PUT /configuracion/usuario/:id: DNI repetido devuelve 409 con código y campo", async () => {
  prepararRutas([
    [CARGA_OBJETIVO, [[familiar()]]],
    [/^SELECT id FROM usuario WHERE documento/, [[{ id: 2 }]]],
  ]);
  const respuesta = await pedir("/api/configuracion/usuario/8", {
    usuario: 3,
    method: "PUT",
    body: { documento: "30111222" },
  });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body.codigo, "DNI_DUPLICADO");
  assert.equal(respuesta.body.campo, "documento");
  assert.equal(respuesta.body.usuario_existente_id, undefined);
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
});

test("GET /configuracion/usuario/:id: admin-central ve el vínculo familiar, el titular y si tiene cuenta", async () => {
  prepararRutas([
    [CARGA_OBJETIVO, [[familiar()]]],
    [/LEFT JOIN tipo_persona tp[\s\S]+WHERE u\.id = \?/, [[{
      id: 8, rol_id: 4, rol_nombre: "invitado", nombre: "Carla", apellido: "Ortega", parentesco_id: 4,
      parentesco_nombre: "Familiar", es_familiar: "S", usuario_familiar_id: 2, titular_id: 2,
      titular_nombre: "Nahuel", titular_apellido: "Staffa", tiene_cuenta: 0, foto_archivo: null,
    }]]],
  ]);
  const respuesta = await pedir("/api/configuracion/usuario/8", { usuario: 11 });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.body.data.titular, { id: 2, nombre: "Nahuel", apellido: "Staffa" });
  assert.equal(respuesta.body.data.tiene_cuenta, false);
  assert.equal(respuesta.body.data.titular_id, undefined);
  assert.ok(respuesta.body.data.campos_editables.includes("departamental_id"));
});

test("PUT /coseguro/familiares/:id/documento: el staff respeta jurisdicción y la regla de 6 a 8 dígitos", async () => {
  prepararRutas([
    [/^SELECT id, usuario_familiar_id FROM usuario WHERE id = \? FOR UPDATE/, [[{ id: 8, usuario_familiar_id: 2 }]]],
    [CARGA_OBJETIVO, [[familiar({ departamental_id: 4 })]]],
  ]);
  const nueveDigitos = await pedir("/api/coseguro/familiares/8/documento", {
    usuario: 3,
    method: "PUT",
    body: { documento: "123456789" },
  });
  assert.equal(nueveDigitos.status, 400);
  assert.match(nueveDigitos.body, /entre 6 y 8 dígitos/);

  const otraSede = await pedir("/api/coseguro/familiares/8/documento", {
    usuario: 3,
    method: "PUT",
    body: { documento: "40756126" },
  });
  assert.equal(otraSede.status, 403);
  assert.equal(llamadasRutas.some(({ sql }) => /^UPDATE usuario/.test(sql)), false);

  prepararRutas([
    [/^SELECT id, usuario_familiar_id FROM usuario WHERE id = \? FOR UPDATE/, [[{ id: 8, usuario_familiar_id: 2 }]]],
    [CARGA_OBJETIVO, [[familiar()]]],
    [/^SELECT id FROM usuario WHERE documento/, [[]]],
    [/^UPDATE usuario SET documento = \? WHERE id = \?/, OK],
    [/^INSERT INTO historial_usuario/, OK],
    [/FROM olimpiada_bono b/, [[]]],
    [/^SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = \?/, (_sql, params) => [[
      params[0] === 8 ? { id: 8, usuario_familiar_id: 2, departamental_id: 1 } : { id: 2, usuario_familiar_id: null, departamental_id: 1 },
    ]]],
    [/^SELECT id FROM usuario WHERE usuario_familiar_id = \?/, [[{ id: 8 }]]],
    [/FROM olimpiada_inscripcion_acompaniante a/, [[]]],
  ]);
  const propia = await pedir("/api/coseguro/familiares/8/documento", {
    usuario: 3,
    method: "PUT",
    body: { documento: "40.756.126" },
  });
  assert.equal(propia.status, 200);
  assert.equal(propia.body.message, "DNI actualizado");
  const historial = llamadasRutas.find(({ sql }) => /^INSERT INTO historial_usuario/.test(sql));
  assert.deepEqual(historial.params.slice(0, 7), [8, "UPDATE", "documento", 40756125, 40756126, "usuario", 3]);
  assert.equal(historial.params[9], "DNI del familiar cargado desde Coseguro médico");
  assert.equal(commits, 1);
});

// ---------------------------------------------------------------------------
// PUT /acompaniantes masivo (sin id) — lo llama crear-reserva antes de seguir
// ---------------------------------------------------------------------------
const DEPARTAMENTAL_23 = titular({
  id: 23, rol_id: 3, rol_nombre: "departamental", nombre: "Otra", apellido: "Departamental",
  documento: 23232323, tipo_persona_id: null, parentesco_id: null, cuil: null, cbu: null,
});

function manejadoresMasivo() {
  return [
    // puedeAccederUsuarioRelacionado(3 → titular 2): misma sede.
    [/^SELECT id, departamental_id FROM usuario WHERE id IN \(\?, \?\)/, (_sql, params) => [
      params.map((id) => ({ id, departamental_id: 1 })),
    ]],
    [/^SELECT \* FROM usuario WHERE documento = \?/, (_sql, params) => [
      ({ 40756125: [familiar()], 23232323: [DEPARTAMENTAL_23] })[params[0]] || [],
    ]],
    [/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) acompaniante_\d+$/, OK],
    [CARGA_OBJETIVO, (_sql, params) => [[params[0] === 23 ? DEPARTAMENTAL_23 : familiar()]]],
    [/^UPDATE usuario SET/, OK],
    [/^INSERT INTO historial_usuario/, OK],
  ];
}

test("PUT /acompaniantes masivo: la departamental 3 no puede editar a la departamental 23 de su sede", async () => {
  prepararRutas(manejadoresMasivo());
  const respuesta = await pedir("/api/acompaniantes", {
    usuario: 3,
    method: "PUT",
    body: {
      usuarioId: 2,
      personas: [
        // Persona del grupo: se actualiza por el servicio (sólo cambia el teléfono).
        {
          nombre: "Carla", apellido: "Ortega", dni: 40756125, fechaNacimiento: "1972-01-03",
          telefono: 2215550000, tipoPersonaId: 2, parentescoId: 4, edad: 54,
        },
        // Miembro del staff de la misma sede: 403 del servicio, no se toca.
        {
          nombre: "Hackeada", apellido: "Departamental", dni: 23232323, fechaNacimiento: "1990-01-01",
          telefono: 2210000000, tipoPersonaId: 1, parentescoId: 0,
        },
      ],
    },
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  // Misma forma que espera crear-reserva ({success, message}) + detalle.
  assert.equal(respuesta.body.success, true);
  assert.equal(respuesta.body.actualizadas, 1);
  assert.deepEqual(respuesta.body.ignoradas, []);
  assert.equal(respuesta.body.errores.length, 1);
  assert.match(respuesta.body.errores[0], /^Persona Hackeada Departamental: No tenés permisos para modificar este usuario$/);
  assert.match(respuesta.body.message, /^Se actualizaron 1 usuario\(s\) correctamente\. Errores: /);

  // Sólo se escribió a Carla (id 8), y con historial estricto del servicio.
  const updates = llamadasRutas.filter(({ sql }) => /^UPDATE usuario/.test(sql));
  assert.deepEqual(updates.map(({ sql, params }) => [sql, params]), [
    ["UPDATE usuario SET telefono = ? WHERE id = ?", ["2215550000", 8]],
  ]);
  const historial = llamadasRutas.filter(({ sql }) => /^INSERT INTO historial_usuario/.test(sql));
  assert.equal(historial.length, 1);
  assert.deepEqual(historial[0].params.slice(0, 7), [8, "UPDATE", "telefono", "2213649349", "2215550000", "usuario", 3]);
  assert.equal(historial[0].params[9], "Datos actualizados por el personal al cargar una reserva");

  // Cada persona en su SAVEPOINT; la rechazada se revierte sola.
  const savepoints = llamadasRutas.filter(({ sql }) => /SAVEPOINT/.test(sql)).map(({ sql }) => sql);
  assert.deepEqual(savepoints, [
    "SAVEPOINT acompaniante_0",
    "RELEASE SAVEPOINT acompaniante_0",
    "SAVEPOINT acompaniante_1",
    "ROLLBACK TO SAVEPOINT acompaniante_1",
  ]);
  // La departamental no carga al departamental 23 más allá del chequeo (sin UPDATE).
  assert.equal(llamadasRutas.some(({ sql, params }) => /^UPDATE usuario/.test(sql) && params.at(-1) === 23), false);
  assert.equal(commits, 1);
});

test("PUT /acompaniantes masivo: si la única persona es del staff no se escribe nada (success:false)", async () => {
  prepararRutas(manejadoresMasivo());
  const respuesta = await pedir("/api/acompaniantes", {
    usuario: 3,
    method: "PUT",
    body: {
      usuarioId: 2,
      personas: [{
        nombre: "Otra", apellido: "Departamental", dni: "23.232.323", fechaNacimiento: "1990-01-01",
        telefono: "2210000000", tipoPersonaId: 1,
      }],
    },
  });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.success, false);
  assert.equal(respuesta.body.actualizadas, 0);
  assert.match(respuesta.body.message, /No se pudo actualizar ningún usuario\. Errores: Persona Otra Departamental: No tenés permisos/);
  assert.equal(llamadasRutas.some(({ sql }) => /^UPDATE usuario/.test(sql)), false);
  assert.equal(llamadasRutas.some(({ sql }) => /^INSERT INTO historial_usuario/.test(sql)), false);
});
