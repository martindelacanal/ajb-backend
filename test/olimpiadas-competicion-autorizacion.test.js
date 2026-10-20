"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
process.env.JWT_SECRET = "competicion-authorization-test-only";

let contexto;
const pool = { query: (...args) => contexto.query(...args), getConnection: () => assert.fail("Una petición no autorizada nunca inicia una escritura") };
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => pool } };
const privado = require("../api/routes/olimpiadas-contenido");
const publico = require("../api/routes/olimpiadas-publico");
const { crearTokenVoluntario } = require("../api/security/olimpiadas-voluntarios");
const { fechaHoyBuenosAires } = require("../api/services/olimpiadas-comun");

const voluntario = { id: 12, nombre: "Ana Voluntaria", usuario: "ana.vol", email: "ana@example.org", habilitado: 1, sesion_version: 1 };
const partido = { id: 44, olimpiada_id: 7, disciplina_id: 4, estado: "PROGRAMADO", participante1: "Nombre privado uno", participante2: "Nombre privado dos",
  departamental1_id: 1, departamental2_id: 2, departamental1_nombre: "La Plata", departamental2_nombre: "Mercedes", mostrar_nombres_publico: 0,
  inscripcion1_id: 123, inscripcion2_id: 124, observacion: "Dato privado", datos_sanitarios: "No publicar", fecha: fechaHoyBuenosAires() };

async function servidor(t, opciones = {}) {
  const hoy = fechaHoyBuenosAires();
  contexto = { consultas: [], cuenta: { ...voluntario, ...opciones.cuenta },
    edicion: { id: 7, nombre: "Olimpiadas", fecha_inicio: hoy, fecha_fin: hoy, habilitado: "Y", eliminado: 0, publicada_publico: 1, ...opciones.edicion },
    partidos: opciones.partidos || [partido], asignadas: opciones.asignadas || [4] };
  contexto.query = async (sql, params = []) => {
    contexto.consultas.push({ sql, params });
    if (/FROM olimpiada_voluntario WHERE/.test(sql)) return [[contexto.cuenta]];
    if (/FROM olimpiada_voluntario_disciplina a/.test(sql)) return [Number(params[1]) === 7 ? contexto.asignadas.map((disciplina_id) => ({ ...contexto.edicion, disciplina_id })) : []];
    if (/FROM olimpiada WHERE/.test(sql)) return [contexto.edicion.eliminado ? [] : [{ ...contexto.edicion, id: Number(params[0]) }]];
    if (/FROM olimpiada o WHERE/.test(sql)) {
      assert.match(sql, /o\.eliminado = 0 AND o\.habilitado = 'Y' AND o\.publicada_publico = 1/);
      assert.doesNotMatch(sql.slice(sql.indexOf("FROM olimpiada o WHERE")), /(?:fecha_fin|fecha_inicio)\s*[<>=]/);
      return [!contexto.edicion.eliminado && contexto.edicion.habilitado === "Y" && contexto.edicion.publicada_publico === 1 ? [contexto.edicion] : []];
    }
    if (/SELECT \(SELECT COUNT/.test(sql)) return [[{}]];
    if (/FROM olimpiada_enlace WHERE/.test(sql)) return [[]];
    if (/SELECT \* FROM olimpiada_partido WHERE/.test(sql)) return [[{ ...partido, id: Number(params[0]), disciplina_id: Number(params[0]) === 55 ? 5 : 4 }]];
    if (/SELECT \* FROM olimpiada_torneo WHERE/.test(sql)) return [[{ id: Number(params[0]), olimpiada_id: 7, disciplina_id: Number(params[0]) === 55 ? 5 : 4, nombre: "Torneo", formato: "LIGA" }]];
    if (/FROM olimpiada_partido p/.test(sql) && /SELECT p\.id/.test(sql)) {
      const asignadas = params.find((p) => Array.isArray(p));
      if (asignadas) assert.match(sql, /p\.disciplina_id IN \(\?\)/);
      return [contexto.partidos.filter((p) => !asignadas || asignadas.includes(p.disciplina_id))];
    }
    if (/FROM olimpiada_disciplina_config c/.test(sql)) return [[{ id: 4, nombre: "Vóley", tipo_id: 1 }, { id: 5, nombre: "Fútbol", tipo_id: 1 }]];
    if (/FROM olimpiada_torneo t/.test(sql)) return [[]];
    if (/SELECT id, logo_archivo FROM departamental/.test(sql)) return [[]];
    assert.fail(`Consulta no prevista: ${sql}`);
  };
  const app = express(); app.use(express.json()); app.use(publico); app.use(privado);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const token = crearTokenVoluntario(voluntario);
  return { contexto, pedir: (ruta, { method = "GET", body, anonimo = false } = {}) => fetch(`http://127.0.0.1:${server.address().port}${ruta}`, {
    method, headers: { ...(anonimo ? {} : { authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) };
}

test("competición: todos los listados restringidos rechazan otra edición y disciplina", async (t) => {
  const { pedir } = await servidor(t);
  for (const ruta of ["fixture", "en-vivo", "torneos", "posiciones", "competicion/catalogos", "competicion/historial"]) {
    assert.equal((await pedir(`/olimpiadas/8/${ruta}`)).status, 403, `otra edición: ${ruta}`);
    if (ruta !== "en-vivo") assert.equal((await pedir(`/olimpiadas/7/${ruta}?disciplina_id=5`)).status, 403, `otra disciplina: ${ruta}`);
  }
});

test("competición: fixture y en vivo nunca devuelven partidos de disciplinas no asignadas", async (t) => {
  const { pedir } = await servidor(t, { partidos: [partido, { ...partido, id: 55, disciplina_id: 5, participante1: "Otra disciplina privada" }] });
  const fixture = await pedir("/olimpiadas/7/fixture");
  assert.equal(fixture.status, 200);
  const body = await fixture.json();
  assert.deepEqual(body.disciplinas.map((d) => d.id), [4]);
  assert.deepEqual(body.partidos.map((p) => p.id), [44]);
  const vivo = await pedir("/olimpiadas/7/en-vivo");
  assert.equal(vivo.status, 200);
  const data = await vivo.json();
  for (const lista of [data.en_juego, data.recientes, data.proximos]) assert.ok(lista.every((p) => p.disciplina_id === 4));
});

test("competición: no puede crear, editar, trasladar, borrar ni cargar resultados de otra disciplina", async (t) => {
  const { pedir } = await servidor(t);
  const casos = [
    ["POST", "/olimpiadas/7/partidos", { disciplina_id: 5, participante1: "A", participante2: "B" }],
    ["PUT", "/olimpiadas/partidos/55", { participante1: "Manipulado" }],
    ["PUT", "/olimpiadas/partidos/44", { disciplina_id: 5 }],
    ["PUT", "/olimpiadas/partidos/55/resultado", { estado: "FINALIZADO", resultado1: "1", resultado2: "0" }],
    ["DELETE", "/olimpiadas/partidos/55"],
    ["POST", "/olimpiadas/7/torneos", { disciplina_id: 5, nombre: "Otro" }],
    ["PUT", "/olimpiadas/torneos/55", { nombre: "Manipulado" }],
    ["PUT", "/olimpiadas/torneos/44", { disciplina_id: 5 }],
    ["DELETE", "/olimpiadas/torneos/55"],
  ];
  for (const [method, ruta, body] of casos) assert.equal((await pedir(ruta, { method, body })).status, 403, `${method} ${ruta}`);
});

test("competición: al terminar el evento conserva fixture pero bloquea partidos y torneos", async (t) => {
  const { pedir } = await servidor(t, { edicion: { fecha_inicio: "2020-10-14", fecha_fin: "2020-10-16" } });
  const response = await pedir("/olimpiadas/7/fixture");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).puede_editar, false);
  for (const [method, ruta, body] of [
    ["POST", "/olimpiadas/7/partidos", { disciplina_id: 4, participante1: "A", participante2: "B" }],
    ["PUT", "/olimpiadas/partidos/44/resultado", { estado: "FINALIZADO", resultado1: "1", resultado2: "0" }],
    ["DELETE", "/olimpiadas/partidos/44"],
    ["POST", "/olimpiadas/7/torneos", { disciplina_id: 4, nombre: "Torneo" }],
    ["PUT", "/olimpiadas/torneos/44", { nombre: "Torneo editado" }],
    ["DELETE", "/olimpiadas/torneos/44"],
  ]) assert.equal((await pedir(ruta, { method, body })).status, 403, `${method} ${ruta}`);
});

test("competición: sólo administración puede publicar nombres, gestionar catálogos o leer el portal privado", async (t) => {
  const { pedir } = await servidor(t);
  assert.equal((await pedir("/olimpiadas/7/partidos", { method: "POST", body: { disciplina_id: 4, participante1: "A", participante2: "B", mostrar_nombres_publico: 1 } })).status, 403);
  assert.equal((await pedir("/olimpiadas/partidos/44", { method: "PUT", body: { mostrar_nombres_publico: 1 } })).status, 403);
  for (const ruta of ["lugares", "instancias"]) {
    assert.equal((await pedir(`/olimpiadas/competicion/${ruta}`)).status, 403);
    assert.equal((await pedir(`/olimpiadas/competicion/${ruta}`, { method: "POST", body: { nombre: "Cambio" } })).status, 403);
  }
  assert.equal((await pedir("/olimpiadas/7/portal")).status, 401);
});

test("competición: deshabilitar o revocar al colaborador impide reutilizar una sesión ya emitida", async (t) => {
  const { pedir, contexto } = await servidor(t);
  contexto.cuenta.habilitado = 0;
  assert.equal((await pedir("/olimpiadas/7/fixture")).status, 401);
  contexto.cuenta.habilitado = 1; contexto.cuenta.sesion_version++;
  assert.equal((await pedir("/olimpiadas/7/fixture")).status, 401);
});

test("público: fixture y cada grupo en vivo ocultan nombres y datos de inscripción por defecto", async (t) => {
  const hoy = fechaHoyBuenosAires();
  const { pedir } = await servidor(t, { partidos: [
    { ...partido, estado: "EN_JUEGO" },
    { ...partido, id: 45, estado: "FINALIZADO", fecha_modificacion: new Date() },
    { ...partido, id: 46, estado: "PROGRAMADO", fecha: hoy },
  ] });
  for (const ruta of ["fixture", "en-vivo"]) {
    const response = await pedir(`/olimpiadas/publico/7/${ruta}`, { anonimo: true });
    assert.equal(response.status, 200);
    const body = await response.json();
    const listas = ruta === "fixture" ? [body.partidos] : [body.en_juego, body.recientes, body.proximos];
    for (const lista of listas) {
      assert.ok(lista.length > 0);
      for (const p of lista) {
        assert.equal(p.participante1, "La Plata");
        assert.equal(p.participante2, "Mercedes");
        assert.equal(p.inscripcion1_id, undefined);
        assert.equal(p.inscripcion2_id, undefined);
        assert.equal(p.observacion, undefined);
        assert.equal(p.datos_sanitarios, undefined);
      }
    }
    assert.equal(JSON.stringify(body).includes("Nombre privado"), false);
  }
});

test("público: habilitar nombres sólo expone los nombres del partido autorizado", async (t) => {
  const { pedir } = await servidor(t, { partidos: [partido, { ...partido, id: 45, mostrar_nombres_publico: 1 }] });
  const response = await pedir("/olimpiadas/publico/7/fixture", { anonimo: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.partidos[0].participante1, "La Plata");
  assert.equal(body.partidos[1].participante1, partido.participante1);
  assert.equal(body.partidos[1].inscripcion1_id, undefined);
  assert.equal(body.partidos[1].observacion, undefined);
});

test("público: las ediciones pasadas figuran en el índice y se abren sin sesión ni datos privados", async (t) => {
  const { pedir } = await servidor(t, { edicion: {
    fecha_inicio: "2020-09-23", fecha_fin: "2020-09-26", edicion: "Demo",
    dni: "documento privado", certificado_archivo: "certificado privado", contacto_emergencia: "teléfono privado",
  } });
  const listado = await pedir("/olimpiadas/publico/ediciones", { anonimo: true });
  assert.equal(listado.status, 200);
  const ediciones = await listado.json();
  assert.deepEqual(ediciones.map(e => e.id), [7]);
  assert.equal(ediciones[0].estado, "FINALIZADA");
  for (const ruta of ["portal", "fixture"]) {
    const response = await pedir(`/olimpiadas/publico/7/${ruta}`, { anonimo: true });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.olimpiada.estado, "FINALIZADA");
    assert.doesNotMatch(JSON.stringify(body), /documento privado|certificado privado|teléfono privado|Nombre privado|Dato privado|No publicar/);
    assert.equal(body.olimpiada.dni, undefined);
    assert.equal(body.olimpiada.certificado_archivo, undefined);
    if (ruta === "portal") {
      assert.equal(body.mi_inscripcion, null);
      assert.deepEqual(body.hoteles_mi_departamental, []);
      assert.equal(body.departamental_id, null);
    }
  }
  assert.doesNotMatch(JSON.stringify(ediciones), /documento privado|certificado privado|teléfono privado/);
});

test("público: ocultar, deshabilitar o eliminar una edición pasada bloquea índice y enlace compartido", async (t) => {
  const { pedir, contexto } = await servidor(t, { edicion: { fecha_inicio: "2020-09-23", fecha_fin: "2020-09-26" } });
  for (const estado of [
    { publicada_publico: 0, habilitado: "Y", eliminado: 0 },
    { publicada_publico: 1, habilitado: "N", eliminado: 0 },
    { publicada_publico: 1, habilitado: "Y", eliminado: 1 },
  ]) {
    Object.assign(contexto.edicion, estado);
    assert.deepEqual(await (await pedir("/olimpiadas/publico/ediciones", { anonimo: true })).json(), []);
    assert.equal((await pedir("/olimpiadas/publico/7/portal", { anonimo: true })).status, 404);
    assert.equal((await pedir("/olimpiadas/publico/7/fixture", { anonimo: true })).status, 404);
  }
});
