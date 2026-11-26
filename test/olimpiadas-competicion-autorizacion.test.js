"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "competicion-authorization-test-only";

let contexto;
const pool = { query: (...args) => contexto.query(...args), getConnection: () => contexto.conexion ?? assert.fail("Una petición no autorizada nunca inicia una escritura") };
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
    if (/r\.nombre AS rol/.test(sql) && opciones.actor) return [[opciones.actor]];
    if (/FROM olimpiada_puntos_puesto WHERE/.test(sql)) return [[]];
    if (/SELECT a\.disciplina_id, TRIM\(CASE/.test(sql)) return [(opciones.veedores || [])
      .filter(v => !sql.includes("v.visible_publico = 1") || v.visible_publico === 1)];
    if (/FROM olimpiada_voluntario v .*JOIN usuario/.test(sql) && sql.includes("v.visible_publico = 0")) return [(opciones.veedores || [])
      .filter(v => v.visible_publico === 0)];
    if (/^SELECT id, grupo, nombre/.test(sql) && /FROM olimpiada_contacto WHERE/.test(sql)) return [opciones.contactos || []];
    if (/FROM olimpiada_voluntario WHERE/.test(sql)) return [[contexto.cuenta]];
    if (/FROM olimpiada_voluntario_disciplina a/.test(sql)) return [Number(params[1]) === 7 ? contexto.asignadas.map((disciplina_id) => ({ ...contexto.edicion, disciplina_id })) : []];
    if (/FROM olimpiada WHERE ruta_publica/.test(sql)) {
      assert.match(sql, /eliminado = 0 AND habilitado = 'Y' AND publicada_publico = 1/);
      const e = contexto.edicion;
      return [params[0] === e.ruta_publica && !e.eliminado && e.habilitado === "Y" && e.publicada_publico === 1 ? [e] : []];
    }
    if (/FROM olimpiada WHERE/.test(sql)) return [contexto.edicion.eliminado ? [] : [{ ...contexto.edicion, id: Number(params[0]) }]];
    if (/FROM olimpiada o WHERE/.test(sql)) {
      assert.match(sql, /o\.eliminado = 0 AND o\.habilitado = 'Y' AND o\.publicada_publico = 1/);
      assert.doesNotMatch(sql.slice(sql.indexOf("FROM olimpiada o WHERE")), /(?:fecha_fin|fecha_inicio)\s*[<>=]/);
      return [!contexto.edicion.eliminado && contexto.edicion.habilitado === "Y" && contexto.edicion.publicada_publico === 1 ? [contexto.edicion] : []];
    }
    if (/SELECT \(SELECT COUNT/.test(sql)) return [[{}]];
    if (/FROM olimpiada_enlace WHERE/.test(sql)) return [[]];
    if (/SELECT \* FROM olimpiada_partido WHERE/.test(sql)) return [[{ ...(contexto.partidos.find(p => p.id === Number(params[0])) || partido), id: Number(params[0]), disciplina_id: Number(params[0]) === 55 ? 5 : 4 }]];
    if (/SELECT \* FROM olimpiada_torneo WHERE/.test(sql)) return [[{ id: Number(params[0]), olimpiada_id: 7, disciplina_id: Number(params[0]) === 55 ? 5 : 4, nombre: "Torneo", formato: "LIGA" }]];
    if (/FROM olimpiada_partido p/.test(sql) && /SELECT p\.id/.test(sql)) {
      const asignadas = params.find((p) => Array.isArray(p));
      if (asignadas) assert.match(sql, /p\.disciplina_id IN \(\?\)/);
      return [contexto.partidos.filter((p) => !asignadas || asignadas.includes(p.disciplina_id))];
    }
    if (/FROM olimpiada_disciplina_config c/.test(sql)) return [opciones.disciplinas || [{ id: 4, olimpiada_id: 7, nombre: "Vóley", tipo_id: 1 }, { id: 5, olimpiada_id: 7, nombre: "Fútbol", tipo_id: 1 }]];
    if (/FROM olimpiada_torneo t/.test(sql)) return [[]];
    if (/FROM olimpiada_medalla m/.test(sql)) return [opciones.medallas || []];
    if (/SELECT id, nombre FROM departamental WHERE id IN/.test(sql)) return [opciones.departamentales || []];
    if (/SELECT id, logo_archivo FROM departamental/.test(sql)) return [[]];
    // Equipos interdepartamentales y escudos que acompañan al fixture.
    if (/FROM olimpiada_equipo e/.test(sql)) return [[]];
    if (/SELECT id, nombre, logo_archivo FROM departamental/.test(sql)) return [[]];
    if (/FROM olimpiada_config WHERE id = 1/.test(sql)) return [[]];
    assert.fail(`Consulta no prevista: ${sql}`);
  };
  const app = express(); app.use(express.json()); app.use(publico); app.use(privado);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const token = opciones.actor ? jwt.sign({ data: JSON.stringify(opciones.actor) }, process.env.JWT_SECRET) : crearTokenVoluntario(voluntario);
  return { contexto, pedir: (ruta, { method = "GET", body, anonimo = false } = {}) => fetch(`http://127.0.0.1:${server.address().port}${ruta}`, {
    method, headers: { ...(anonimo ? {} : { authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) };
}

test("veedores: el portal público y el afiliado filtran nombres asignados y manuales, y gestión los conserva", async t => {
  const veedores = [{ disciplina_id: 4, nombre: "Ana López", visible_publico: 0 },
    { disciplina_id: 4, nombre: "Pedro Díaz", visible_publico: 1 }];
  const veedor = "LÓPEZ, ANA / Pedro Díaz";
  for (const rol of ["admin", "afiliado"]) {
    const actor = { id: 5, rol, rol_id: rol === "admin" ? 1 : 2, habilitado: "Y", modulo_olimpiadas: 1, requiere_cambio_clave: 0 };
    const { pedir } = await servidor(t, { actor, veedores, disciplinas: [{ id: 4, nombre: "Vóley", veedor }],
      contactos: [{ nombre: "López Ana", grupo: "Veedores" }, { nombre: "Pedro Díaz", cargo: "Veedor" }] });
    for (const anonimo of [false, true]) {
      const prefijo = anonimo ? "/olimpiadas/publico/7/" : "/olimpiadas/7/";
      const [fixture, contactos] = await Promise.all(["fixture", "contactos"].map(async ruta => {
        const respuesta = await pedir(prefijo + ruta, { anonimo });
        const cuerpo = await respuesta.json();
        assert.equal(respuesta.status, 200, `${rol} ${prefijo}${ruta}: ${JSON.stringify(cuerpo)}`);
        return cuerpo;
      }));
      const gestion = !anonimo && rol === "admin";
      assert.deepEqual(fixture.disciplinas[0].veedores, gestion ? ["Ana López", "Pedro Díaz"] : ["Pedro Díaz"]);
      assert.equal(fixture.disciplinas[0].veedor, gestion ? veedor : "Pedro Díaz");
      assert.deepEqual(contactos.map(c => c.nombre), gestion ? ["López Ana", "Pedro Díaz"] : ["Pedro Díaz"]);
    }
  }
});

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

test("veedor: la estructura de su propia disciplina también queda reservada a la administración", async (t) => {
  const { pedir } = await servidor(t, { partidos: [{ ...partido, partido_origen2_id: 32 }] });
  const ruta = "/olimpiadas/partidos/44";
  for (const [method, url, body] of [
    ["POST", "/olimpiadas/7/partidos", { disciplina_id: 4, participante1: "A", participante2: "B" }],
    ["POST", "/olimpiadas/7/partidos/importar", { disciplina_id: 4, texto: "A | B" }],
    ["DELETE", ruta],
    ["PUT", ruta, { fase: "Final", fecha: fechaHoyBuenosAires() }],
    ["PUT", ruta, { instancia_id: 2 }], ["PUT", ruta, { torneo_id: 4 }], ["PUT", ruta, { zona: "B" }],
    ["PUT", ruta, { partido_origen2_id: null }], ["PUT", ruta, { equipo2_id: 8 }],
    ["PUT", ruta, { participante2: "Otro" }], ["PUT", ruta, { estado: "EN_JUEGO" }],
    ["PUT", ruta + "/resultado", { estado: "EN_JUEGO", origen1_tipo: "PERDEDOR" }],
    ["POST", "/olimpiadas/7/torneos", { disciplina_id: 4, nombre: "Nuevo" }],
    ["PUT", "/olimpiadas/torneos/44", { formato: "LIGA", instancia_ids: [1, 2] }],
    ["DELETE", "/olimpiadas/torneos/44"],
  ]) assert.equal((await pedir(url, { method, body })).status, 403, `${method} ${url} ${JSON.stringify(body)}`);
});

function simularEscrituraResultado(contexto, encuentro) {
  contexto.conexion = {
    beginTransaction() {}, commit() {}, rollback() {}, release() {},
    async query(sql, params) {
      if (sql.includes("UPDATE olimpiada_partido SET estado = ?")) {
        [encuentro.estado, encuentro.resultado1, encuentro.resultado2, encuentro.ganador, encuentro.sets] = params;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE olimpiada_partido SET ? WHERE id = ?")) {
        Object.assign(contexto.partidos.find(p => p.id === params[1]), params[0]);
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("INSERT INTO olimpiada_historial")) return [{ insertId: 1 }];
      if (sql.includes("FROM olimpiada_medalla m")) return [[]];
      return contexto.query(sql, params);
    },
  };
}

test("veedor: un partido sólo sale en vivo al iniciar, conserva los sets al suspender y permite reanudar", async (t) => {
  const encuentro = { ...partido, hora_inicio: "00:00:00", hora_fin: "23:59:00" };
  const { pedir, contexto } = await servidor(t, { partidos: [encuentro] });
  simularEscrituraResultado(contexto, encuentro);
  const guardar = body => pedir("/olimpiadas/partidos/44/resultado", { method: "PUT", body });
  const enJuego = async () => (await (await pedir("/olimpiadas/publico/7/en-vivo", { anonimo: true })).json()).en_juego.map(p => p.id);
  assert.deepEqual(await enJuego(), []);
  assert.equal((await guardar({ estado: "EN_JUEGO", sets: [[25, 19]] })).status, 409);
  assert.equal((await guardar({ estado: "EN_JUEGO" })).status, 200);
  assert.deepEqual(await enJuego(), [44]);
  assert.equal((await guardar({ estado: "EN_JUEGO", sets: [[25, 19]] })).status, 200);
  assert.equal((await guardar({ estado: "SUSPENDIDO" })).status, 200);
  assert.deepEqual(await enJuego(), []);
  assert.deepEqual([encuentro.resultado1, encuentro.resultado2, encuentro.sets], ["1", "0", "[[25,19]]"]);
  assert.equal((await guardar({ estado: "EN_JUEGO" })).status, 200);
  assert.deepEqual(await enJuego(), [44]);
  assert.equal(encuentro.sets, "[[25,19]]");
});

test("básquet: el veedor carga parciales, corrige el resultado y el fixture público muestra los totales", async t => {
  const disciplina = { id: 4, nombre: "Basquet Masculino", tipo_marcador: "TANTOS" };
  const encuentro = { ...partido, estado: "EN_JUEGO", disciplina_nombre: disciplina.nombre, tipo_marcador: "TANTOS" };
  const { pedir, contexto } = await servidor(t, { partidos: [encuentro], disciplinas: [disciplina] });
  simularEscrituraResultado(contexto, encuentro);
  const guardar = body => pedir("/olimpiadas/partidos/44/resultado", { method: "PUT", body });
  const parciales = [[0, 16], [20, 15], [19, 14], [18, 14]];

  assert.equal((await guardar({ estado: "EN_JUEGO", cuartos: parciales.slice(0, 1) })).status, 200);
  assert.deepEqual([encuentro.resultado1, encuentro.resultado2], ["0", "16"]);
  assert.equal((await guardar({ estado: "SUSPENDIDO" })).status, 200);
  assert.equal((await guardar({ estado: "FINALIZADO" })).status, 400);
  assert.equal((await guardar({ estado: "FINALIZADO", cuartos: parciales, resultado1: "99", ganador: 1 })).status, 200);
  assert.deepEqual([encuentro.resultado1, encuentro.resultado2, encuentro.ganador], ["57", "59", 1]);
  assert.equal((await guardar({ estado: "FINALIZADO" })).status, 200);
  assert.equal(encuentro.ganador, 1);
  assert.equal((await guardar({ estado: "FINALIZADO", cuartos: parciales })).status, 200);
  assert.equal(encuentro.ganador, 2);
  parciales[0] = [5, 16];
  assert.equal((await guardar({ estado: "FINALIZADO", cuartos: parciales })).status, 200);
  const fixture = await (await pedir("/olimpiadas/publico/7/fixture", { anonimo: true })).json();
  assert.equal(fixture.disciplinas[0].tipo_marcador, "CUARTOS");
  const p = fixture.partidos[0];
  assert.deepEqual([p.tipo_marcador, p.cuartos, p.sets, p.resultado1, p.resultado2, p.ganador], ["CUARTOS", parciales, null, "62", "59", 1]);
  assert.equal((await guardar({ estado: "PROGRAMADO", resultado1: null, resultado2: null })).status, 200);
  assert.deepEqual([encuentro.resultado1, encuentro.resultado2, encuentro.sets, encuentro.ganador], [null, null, null, null]);
});

test("fútbol: la tanda desempata el partido, clasifica al ganador y conserva los goles en el fixture público", async t => {
  const disciplina = { id: 4, nombre: "Fútbol 5 Super Senior Masculino + 50 años", tipo_marcador: "TANTOS" };
  const encuentro = { ...partido, estado: "EN_JUEGO", disciplina_nombre: disciplina.nombre, tipo_marcador: "TANTOS", etiqueta: "A" };
  const cruce = { id: 45, disciplina_id: 4, estado: "PROGRAMADO", origen1_tipo: "GANADOR", partido_origen1_id: 44, participante1: "Ganador de A" };
  const { pedir, contexto } = await servidor(t, { partidos: [encuentro, cruce], disciplinas: [disciplina] });
  simularEscrituraResultado(contexto, encuentro);
  const guardar = body => pedir("/olimpiadas/partidos/44/resultado", { method: "PUT", body });
  const igualado = { resultado1: "0", resultado2: "0" };
  assert.equal((await guardar({ ...igualado, estado: "EN_JUEGO", penales: [2, 2] })).status, 200);
  assert.equal((await guardar({ estado: "FINALIZADO" })).status, 400);
  assert.equal((await guardar({ estado: "FINALIZADO", penales: [3, 4], ganador: 1 })).status, 400);
  assert.equal((await guardar({ estado: "FINALIZADO", penales: [3, 4] })).status, 200);
  assert.equal(cruce.departamental1_id, encuentro.departamental2_id);
  const fixture = await (await pedir("/olimpiadas/publico/7/fixture", { anonimo: true })).json();
  const p = fixture.partidos.find(p => p.id === encuentro.id);
  assert.deepEqual([p.permite_penales, p.resultado1, p.resultado2, p.penales, p.ganador, p.sets], [true, "0", "0", [3, 4], 2, null]);
  assert.equal((await guardar({ estado: "FINALIZADO", penales: [5, 4] })).status, 200);
  assert.equal(cruce.departamental1_id, encuentro.departamental1_id);
  assert.equal((await guardar({ estado: "FINALIZADO", penales: null })).status, 200);
  assert.deepEqual([encuentro.ganador, encuentro.sets, cruce.departamental1_id], [0, null, null]);
  assert.equal((await guardar({ estado: "FINALIZADO", penales: [5, 4] })).status, 200);
  assert.equal((await guardar({ estado: "FINALIZADO", resultado2: "1" })).status, 200);
  assert.deepEqual([encuentro.ganador, encuentro.sets], [2, null]);
  assert.equal((await guardar({ ...igualado, estado: "FINALIZADO", penales: [0, 1] })).status, 200);
  assert.equal((await guardar({ estado: "PROGRAMADO", resultado1: null, resultado2: null })).status, 200);
  assert.deepEqual([encuentro.resultado1, encuentro.resultado2, encuentro.ganador, encuentro.sets], [null, null, null, null]);
});

test("fútbol: acepta únicamente una tanda válida en un marcador empatado de fútbol", async t => {
  const disciplina = { id: 4, nombre: "Futsal", tipo_marcador: "TANTOS" };
  const { pedir } = await servidor(t, { disciplinas: [disciplina] });
  const guardar = datos => pedir("/olimpiadas/partidos/44/resultado", { method: "PUT",
    body: { estado: "FINALIZADO", resultado1: "2", resultado2: "2", penales: [2, 1], ...datos } });
  for (const penales of [[1, 1], [-1, 0], [2.5, 0], [1], [1, "0"], [1, null], [1000, 0]]) {
    assert.equal((await guardar({ penales })).status, 400);
  }
  for (const datos of [{ resultado2: "1" }, { resultado1: null }, { resultado1: "W.O.", resultado2: "W.O." },
    { resultado1: "1.5", resultado2: "1.5" }, { sets: [[1, 0]] }, { cuartos: [[1, 0]] }]) {
    assert.equal((await guardar(datos)).status, 400);
  }
  for (const nombre of ["Fútbol tenis", "Futboltenis", "Hándbol"]) {
    disciplina.nombre = nombre;
    assert.equal((await guardar({})).status, 400);
  }
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

test("fixture público: muestra el podio manual y equipos compartidos con el medallero y las posiciones reservados", async t => {
  const medalla = { disciplina_id: 4, origen: "MANUAL", puntos_manual: 100 };
  const { pedir } = await servidor(t, { edicion: { medallero_publicado: 0, posiciones_publicas: 0 }, medallas: [
    { ...medalla, puesto: 1, equipo_id: 9, equipo_nombre: "Equipo del Sur", departamental_id: 1, nombre: "Azul" },
    { ...medalla, puesto: 1, equipo_id: 9, equipo_nombre: "Equipo del Sur", departamental_id: 2, nombre: "Dolores" },
    { ...medalla, puesto: 2, departamental_id: 1, nombre: "Azul" },
    { ...medalla, puesto: 3, departamental_id: 3, nombre: "Mercedes" },
    { ...medalla, puesto: 4, departamental_id: 4, nombre: "Cuarta" },
  ] });
  const fixture = await (await pedir("/olimpiadas/publico/7/fixture", { anonimo: true })).json();
  const podio = fixture.disciplinas[0].podio;
  assert.deepEqual(podio.map(p => [p.puesto, p.nombre, p.ganadores.map(g => g.nombre)]),
    [[1, "Oro", ["Equipo del Sur"]], [2, "Plata", ["Azul"]], [3, "Bronce", ["Mercedes"]]]);
  assert.deepEqual(podio[0].ganadores[0].departamentales, [{ id: 1, nombre: "Azul" }, { id: 2, nombre: "Dolores" }]);
  assert.doesNotMatch(JSON.stringify(podio), /puntos|Cuarta|inscripcion|medalla_id|MANUAL/);
  assert.deepEqual(fixture.disciplinas[1].podio, []);
  assert.deepEqual(fixture.posiciones, []);
  const general = await (await pedir("/olimpiadas/publico/7/medallero", { anonimo: true })).json();
  assert.equal(general.reservado, true);
  assert.deepEqual(general.tabla, []);
});

test("medallero: una carga manual sin ganadores conserva la adjudicación previa", async t => {
  const medallas = [{ disciplina_id: 4, origen: "MANUAL", puesto: 1, departamental_id: 1, nombre: "Azul" }];
  const actor = { id: 5, rol: "admin", rol_id: 1, habilitado: "Y", requiere_cambio_clave: 0 };
  const { pedir } = await servidor(t, { medallas, actor });
  for (const puestos of [[], [{ puesto: 1, departamental_ids: [], equipo_ids: [] }, { puesto: 2, ganadores: [] }]]) {
    const respuesta = await pedir("/olimpiadas/7/medallero/4", { method: "PUT", body: { puestos } });
    assert.equal(respuesta.status, 400);
    assert.match(await respuesta.json(), /al menos un ganador.*Volver al cálculo automático/);
  }
  const fixture = await (await pedir("/olimpiadas/publico/7/fixture", { anonimo: true })).json();
  assert.equal(fixture.disciplinas[0].podio[0].ganadores[0].nombre, "Azul");
});

test("fixture público: lee un cuadro antiguo sin final sin recargar resultados ni adivinar nombres", async t => {
  const semifinal = { ...partido, torneo_id: 8, instancia_nombre: "Semifinal", estado: "FINALIZADO", ganador: 1 };
  const partidos = [
    { ...semifinal, id: 101, inscripcion1_id: 201, departamental1_id: 19, departamental2_id: 17 },
    { ...semifinal, id: 102, inscripcion1_id: 202, departamental1_id: 19, departamental2_id: 14 },
    { ...semifinal, id: 103, instancia_nombre: "Tercer puesto", departamental1_id: 17, departamental2_id: 14, ganador: 2,
      partido_origen1_id: 101, partido_origen2_id: 102, origen1_tipo: "PERDEDOR", origen2_tipo: "PERDEDOR" },
  ];
  const { pedir, contexto } = await servidor(t, { partidos, departamentales: [
    { id: 19, nombre: "Moreno" }, { id: 17, nombre: "San Martín" }, { id: 14, nombre: "Lomas" },
  ] });
  const fixture = await (await pedir("/olimpiadas/publico/7/fixture?torneo_id=8", { anonimo: true })).json();
  assert.deepEqual(fixture.disciplinas[0].podio.map(p => [p.nombre, p.ganadores[0].nombre]),
    [["Oro", "Moreno"], ["Plata", "Moreno"], ["Bronce", "Lomas"]]);
  assert.ok(contexto.consultas.every(c => !/^\s*(?:UPDATE|DELETE|INSERT)/i.test(c.sql)));
});

test("fixture público: un triangular terminado publica las tres departamentales y conserva reservado el medallero", async t => {
  const base = { ...partido, estado: "FINALIZADO", torneo_id: 24, torneo_formato: "LIGA", fase: "Triangular", inscripcion1_id: null, inscripcion2_id: null };
  const partidos = [
    { ...base, id: 90, departamental1_id: 19, departamental2_id: 17, ganador: 1 },
    { ...base, id: 94, departamental1_id: 19, departamental2_id: 14, ganador: 1 },
    { ...base, id: 220, departamental1_id: 17, departamental2_id: 14, ganador: 2 },
  ];
  const { pedir } = await servidor(t, { partidos, edicion: { medallero_publicado: 0, posiciones_publicas: 0 },
    departamentales: [{ id: 19, nombre: "Moreno" }, { id: 14, nombre: "Lomas" }, { id: 17, nombre: "San Martín" }] });
  const fixture = await (await pedir("/olimpiadas/publico/7/fixture", { anonimo: true })).json();
  assert.deepEqual(fixture.disciplinas[0].podio.map(p => [p.nombre, p.ganadores[0].nombre]),
    [["Oro", "Moreno"], ["Plata", "Lomas"], ["Bronce", "San Martín"]]);
  assert.deepEqual(fixture.posiciones, []);
  assert.doesNotMatch(JSON.stringify(fixture.disciplinas[0].podio), /puntos|inscripcion/);
});

test("resultados: finalizar el tercer puesto sin final guarda el bronce, y corregirlo actualiza el podio público", async t => {
  const encuentro = { ...partido, instancia_nombre: "Tercer puesto", estado: "EN_JUEGO" };
  const medallas = [];
  const departamentales = [{ id: 1, nombre: "La Plata" }, { id: 2, nombre: "Mercedes" }];
  const { pedir, contexto } = await servidor(t, { partidos: [encuentro], medallas, departamentales });
  simularEscrituraResultado(contexto, encuentro);
  const query = contexto.conexion.query;
  let siguienteId = 0;
  contexto.conexion.query = (sql, params) => {
    if (sql.includes("FROM olimpiada_medalla m")) return [medallas.slice()];
    if (sql.includes("INSERT INTO olimpiada_medalla")) {
      const [, disciplina_id, puesto, departamental_id, equipo_id] = params;
      medallas.push({ id: ++siguienteId, disciplina_id, puesto, departamental_id, equipo_id,
        origen: "AUTO", nombre: departamentales.find(d => d.id === departamental_id).nombre });
      return [{ insertId: siguienteId }];
    }
    if (sql.includes("DELETE FROM olimpiada_medalla")) {
      for (const id of params[0]) medallas.splice(medallas.findIndex(m => m.id === id), 1);
      return [{ affectedRows: params[0].length }];
    }
    if (sql.includes("SELECT nombre FROM olimpiada_disciplina")) return [[{ nombre: "Tenis" }]];
    return query(sql, params);
  };
  const guardar = resultado => pedir("/olimpiadas/partidos/44/resultado", {
    method: "PUT", body: { estado: "FINALIZADO", resultado1: resultado, resultado2: "1" },
  });
  assert.equal((await guardar("3")).status, 200);
  assert.deepEqual(medallas.map(m => [m.puesto, m.departamental_id]), [[3, 1], [4, 2]]);
  assert.equal((await guardar("0")).status, 200);
  assert.deepEqual(medallas.map(m => [m.puesto, m.departamental_id]), [[3, 2], [4, 1]]);
  const fixture = await (await pedir("/olimpiadas/publico/7/fixture", { anonimo: true })).json();
  assert.deepEqual(fixture.disciplinas[0].podio.map(p => [p.nombre, p.ganadores[0].nombre]), [["Bronce", "Mercedes"]]);
  medallas[0].origen = "MANUAL";
  assert.equal((await guardar("3")).status, 200);
  assert.deepEqual(medallas.map(m => [m.puesto, m.departamental_id]), [[3, 2], [4, 1]]);
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
  // el banner dibuja los deportes de la edición: viajan sólo los nombres
  assert.deepEqual(ediciones[0].disciplinas, ["Vóley", "Fútbol"]);
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
      assert.deepEqual(body.olimpiada.disciplinas, ["Vóley", "Fútbol"]);
      assert.equal(body.mi_inscripcion, null);
      assert.deepEqual(body.hoteles_mi_departamental, []);
      assert.equal(body.departamental_id, null);
    }
  }
  assert.doesNotMatch(JSON.stringify(ediciones), /documento privado|certificado privado|teléfono privado/);
});

test("público: ocultar, deshabilitar o eliminar una edición pasada bloquea índice y enlace compartido", async (t) => {
  const { pedir, contexto } = await servidor(t, { edicion: { fecha_inicio: "2020-09-23", fecha_fin: "2020-09-26", ruta_publica: "miramar" } });
  const enlace = () => pedir("/olimpiadas/publico/ruta/miramar", { anonimo: true });
  const encontrada = await enlace();
  assert.equal(encontrada.status, 200);
  assert.equal(encontrada.headers.get("cache-control"), "no-store");
  assert.deepEqual(await encontrada.json(), { id: 7 });
  assert.equal((await pedir("/olimpiadas/publico/ruta/otra", { anonimo: true })).status, 404);
  for (const estado of [
    { publicada_publico: 0, habilitado: "Y", eliminado: 0 },
    { publicada_publico: 1, habilitado: "N", eliminado: 0 },
    { publicada_publico: 1, habilitado: "Y", eliminado: 1 },
  ]) {
    Object.assign(contexto.edicion, estado);
    assert.equal((await enlace()).status, 404);
    assert.deepEqual(await (await pedir("/olimpiadas/publico/ediciones", { anonimo: true })).json(), []);
    assert.equal((await pedir("/olimpiadas/publico/7/portal", { anonimo: true })).status, 404);
    assert.equal((await pedir("/olimpiadas/publico/7/fixture", { anonimo: true })).status, 404);
  }
});
