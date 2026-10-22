"use strict";

// Cupo por departamental: GET /olimpiadas/:id/cupos decide en el servidor de qué departamental se
// descuentan los lugares (la de la persona inscripta), y /olimpiadas/:id y /actual usan la misma regla.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "cupos-olimpiadas-tests-only";

let contexto;
const pool = {
  query: (...args) => contexto.query(...args),
  getConnection: () => assert.fail("Consultar cupos nunca abre una transacción"),
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => pool } };

// Mismo orden de montaje que app.js: ningún router anterior puede capturar /olimpiadas/:id/cupos.
const routers = [
  require("../api/routes/olimpiadas-bonos"),
  require("../api/routes/olimpiadas-gafetes"),
  require("../api/routes/olimpiadas-voluntarios"),
  require("../api/routes/olimpiadas-publico"),
  require("../api/routes/olimpiadas-contenido"),
  require("../api/routes/olimpiadas"),
];

const DEPARTAMENTALES = { 1: "Azul", 5: "La Plata", 9: "Mercedes" };
const titular = { rol_nombre: "afiliado", habilitado: "Y", usuario_familiar_id: null, es_familiar: "N", modulo_olimpiadas: 1 };
const AFILIADOS = {
  20: { ...titular, id: 20, nombre: "Ana", apellido: "Pérez", departamental_id: 5 },
  21: { ...titular, id: 21, nombre: "Luis", apellido: "Gómez", departamental_id: null },
};
const INSCRIPCIONES = { 11: { id: 11, olimpiada_id: 7, usuario_id: 20, departamental_id: 5 } };
const DISCIPLINAS = [
  { id: 4, nombre: "Vóley", tipo_id: 1, tipo_nombre: "Atleta", icono_archivo: null, max_por_departamental: 10, sede_id: null, veedor: null },
  { id: 6, nombre: "Truco", tipo_id: 2, tipo_nombre: "Cultura", icono_archivo: null, max_por_departamental: null, sede_id: null, veedor: null },
];
const OLIMPIADA = { id: 7, nombre: "Olimpiadas 2027", fecha_inicio: "2027-10-10", fecha_fin: "2027-10-12",
  fecha_inicio_inscripcion: "2027-08-01", fecha_fin_inscripcion: "2027-10-09", valor_bono: 1000, bonos_afiliado: 6 };

async function servidor(t, actor) {
  contexto = {
    consultas: [],
    actor: {
      rol_id: actor.rol === "afiliado" ? 2 : 1, habilitado: "Y", modulo_olimpiadas: 1, modulo_turismo: 0, modulo_coseguro: 0,
      requiere_cambio_clave: 0, es_familiar: "N", usuario_familiar_id: null, departamental_id: null, ...actor,
    },
  };
  contexto.query = async (sql, params = []) => {
    contexto.consultas.push({ sql, params });
    if (/u\.\*, r\.nombre AS rol_nombre/.test(sql)) return [AFILIADOS[params[0]] ? [{ ...AFILIADOS[params[0]] }] : []];
    if (/FROM usuario u[\s\S]+INNER JOIN rol r/.test(sql)) return [[{ ...contexto.actor }]];
    if (/SELECT \* FROM olimpiada WHERE id = \?/.test(sql)) return [Number(params[0]) === 7 ? [{ ...OLIMPIADA }] : []];
    if (/FROM olimpiada o\s+WHERE o\.eliminado = 0 AND o\.habilitado = 'Y'\s+AND CURDATE\(\) BETWEEN/.test(sql)) return [[{ ...OLIMPIADA }]];
    if (/SELECT id, usuario_id, departamental_id FROM olimpiada_inscripcion WHERE id = \? AND olimpiada_id = \?/.test(sql)) {
      const inscripcion = INSCRIPCIONES[params[0]];
      return [inscripcion && inscripcion.olimpiada_id === Number(params[1]) ? [{ ...inscripcion }] : []];
    }
    if (/FROM olimpiada_disciplina_config c/.test(sql)) {
      const conOcupacion = /AS inscriptos_departamental/.test(sql);
      return [DISCIPLINAS.map((d) => (conOcupacion ? { ...d, inscriptos_departamental: 4 } : { ...d }))];
    }
    if (/SELECT nombre FROM departamental WHERE id = \?/.test(sql)) {
      return [DEPARTAMENTALES[params[0]] ? [{ nombre: DEPARTAMENTALES[params[0]] }] : []];
    }
    if (/FROM olimpiada_bono_tramo/.test(sql)) return [[]];
    if (/FROM olimpiada_disciplina_tipo WHERE habilitado = 'Y'/.test(sql)) return [[]];
    if (/FROM olimpiada_inscripcion i\s+WHERE i\.olimpiada_id = \? AND i\.usuario_id = \?/.test(sql)) return [[]];
    assert.fail(`Consulta no prevista: ${sql}`);
  };
  const app = express();
  app.use(express.json());
  for (const router of routers) app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const token = jwt.sign({ data: JSON.stringify({ id: contexto.actor.id, rol: contexto.actor.rol, departamental_id: contexto.actor.departamental_id }) }, process.env.JWT_SECRET);
  return {
    contexto,
    pedir: async (ruta) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() };
    },
  };
}

const consultaOcupacion = (contexto) => contexto.consultas.find((c) => /FROM olimpiada_disciplina_config c/.test(c.sql));

test("cupos: sin persona ni inscripción pide elegir al afiliado", async (t) => {
  const { pedir, contexto } = await servidor(t, { id: 1, rol: "admin" });
  const respuesta = await pedir("/olimpiadas/7/cupos");
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body, "Elegí al afiliado para ver los cupos de su departamental");
  assert.equal(consultaOcupacion(contexto), undefined);
});

test("cupos: el admin ve el cupo de la departamental del afiliado, no el de la suya", async (t) => {
  // Como los admins de prueba de develop (58 y 60), que tienen departamental_id = 1
  const { pedir, contexto } = await servidor(t, { id: 58, rol: "admin", departamental_id: 1 });
  const respuesta = await pedir("/olimpiadas/7/cupos?usuario_id=20");
  assert.equal(respuesta.status, 200);
  const ocupacion = consultaOcupacion(contexto);
  assert.match(ocupacion.sql, /i\.departamental_id <=> \?/);
  assert.deepEqual(ocupacion.params, [5, null, null, 7]);
  assert.deepEqual(respuesta.body, {
    departamental: { id: 5, nombre: "La Plata" },
    disciplinas: [
      { id: 4, max_por_departamental: 10, inscriptos_departamental: 4, cupo_disponible: 6 },
      { id: 6, max_por_departamental: null, inscriptos_departamental: 4, cupo_disponible: null },
    ],
  });
});

test("cupos: la departamental no consulta afiliados de otra departamental", async (t) => {
  const { pedir, contexto } = await servidor(t, { id: 3, rol: "departamental", departamental_id: 9 });
  const respuesta = await pedir("/olimpiadas/7/cupos?usuario_id=20");
  assert.equal(respuesta.status, 403);
  assert.equal(respuesta.body, "Sólo podés inscribir afiliados de tu departamental");
  assert.equal(consultaOcupacion(contexto), undefined);
});

test("cupos: una persona sin departamental no se puede inscribir y se explica qué hacer", async (t) => {
  const { pedir, contexto } = await servidor(t, { id: 1, rol: "admin-central" });
  const respuesta = await pedir("/olimpiadas/7/cupos?usuario_id=21");
  assert.equal(respuesta.status, 422);
  assert.equal(respuesta.body, "Gómez, Luis no tiene una departamental asignada. Asignásela desde Usuarios y después cargá la inscripción.");
  assert.equal(consultaOcupacion(contexto), undefined);
});

test("cupos: al editar, la inscripción usa su departamental y no se cuenta a sí misma", async (t) => {
  for (const actor of [{ id: 3, rol: "departamental", departamental_id: 5 }, { id: 20, rol: "afiliado", departamental_id: 5 }]) {
    const { pedir, contexto } = await servidor(t, actor);
    const respuesta = await pedir("/olimpiadas/7/cupos?inscripcion_id=11");
    assert.equal(respuesta.status, 200, actor.rol);
    assert.deepEqual(consultaOcupacion(contexto).params, [5, 11, 11, 7], actor.rol);
    assert.deepEqual(respuesta.body.departamental, { id: 5, nombre: "La Plata" });
  }
});

test("cupos: el afiliado no ve inscripciones ajenas ni consulta cupos de otra persona", async (t) => {
  const { pedir, contexto } = await servidor(t, { id: 22, rol: "afiliado", departamental_id: 5 });
  assert.equal((await pedir("/olimpiadas/7/cupos?inscripcion_id=11")).status, 401);
  assert.equal((await pedir("/olimpiadas/7/cupos?usuario_id=20")).status, 401);
  assert.equal(consultaOcupacion(contexto), undefined);
});

test("cupos: la departamental no ve inscripciones de otra departamental", async (t) => {
  const { pedir, contexto } = await servidor(t, { id: 3, rol: "departamental", departamental_id: 9 });
  assert.equal((await pedir("/olimpiadas/7/cupos?inscripcion_id=11")).status, 401);
  assert.equal(consultaOcupacion(contexto), undefined);
});

test("cupos: inscripción de otra edición, olimpiada inexistente o parámetros inválidos", async (t) => {
  const { pedir, contexto } = await servidor(t, { id: 1, rol: "admin" });
  assert.equal((await pedir("/olimpiadas/8/cupos?usuario_id=20")).status, 404);
  assert.equal((await pedir("/olimpiadas/7/cupos?inscripcion_id=99")).status, 404);
  assert.equal((await pedir("/olimpiadas/7/cupos?inscripcion_id=1e2")).status, 400);
  assert.equal((await pedir("/olimpiadas/7/cupos?usuario_id=-3")).status, 400);
  assert.equal(consultaOcupacion(contexto), undefined);
});

test("detalle de la edición: la administración provincial recibe topes; la departamental, su ocupación", async (t) => {
  const admin = await servidor(t, { id: 1, rol: "admin", departamental_id: 1 });
  const provincial = await admin.pedir("/olimpiadas/7");
  assert.equal(provincial.status, 200);
  assert.deepEqual(consultaOcupacion(admin.contexto).params, [7]);
  for (const disciplina of provincial.body.disciplinas) {
    assert.equal("cupo_disponible" in disciplina, false);
    assert.equal("inscriptos_departamental" in disciplina, false);
  }
  assert.equal(provincial.body.disciplinas[0].max_por_departamental, 10);

  const departamental = await servidor(t, { id: 3, rol: "departamental", departamental_id: 9 });
  const propia = await departamental.pedir("/olimpiadas/7");
  assert.equal(propia.status, 200);
  assert.deepEqual(consultaOcupacion(departamental.contexto).params, [9, null, null, 7]);
  assert.equal(propia.body.disciplinas[0].cupo_disponible, 6);
});

test("portal del afiliado: ve la ocupación del cupo de su departamental", async (t) => {
  const { pedir, contexto } = await servidor(t, { id: 20, rol: "afiliado", departamental_id: 5 });
  const respuesta = await pedir("/olimpiadas/actual");
  assert.equal(respuesta.status, 200);
  assert.deepEqual(consultaOcupacion(contexto).params, [5, null, null, 7]);
  assert.equal(respuesta.body.disciplinas[0].cupo_disponible, 6);
  assert.equal(respuesta.body.sin_departamental, false);
});

test("portal del afiliado: sin departamental se le avisa al entrar, no al enviar el formulario", async (t) => {
  const sinDepartamental = await servidor(t, { id: 21, rol: "afiliado", departamental_id: null });
  const respuesta = await sinDepartamental.pedir("/olimpiadas/actual");
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.sin_departamental, true);
  // El staff no se inscribe desde el portal: nunca se lo marca
  const admin = await servidor(t, { id: 1, rol: "admin" });
  assert.equal((await admin.pedir("/olimpiadas/actual")).body.sin_departamental, false);
});
