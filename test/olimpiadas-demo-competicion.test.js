"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
process.env.JWT_SECRET ||= "test-only-secret";
const { CHECKSUM, DEPARTAMENTALES, TORNEOS, armarResultados, aplicar } = require("../scripts/seed-olimpiadas-demo-competicion");
const { calcularPosiciones } = require("../api/services/olimpiadas-competicion");

const EDICION = { id: 1, nombre: "Olimpiadas 2026", edicion: "Demo", fecha_inicio: "2026-09-23", fecha_fin: "2026-09-26",
  habilitado: "Y", eliminado: 0, publicada_publico: 1, puntos_oro: 10, puntos_plata: 5, puntos_bronce: 4 };
const AJEDREZ = { id: 1, olimpiada_id: 1, disciplina_id: 2, participante1: "Avellaneda-Lanús", participante2: "Bahía Blanca",
  departamental1_id: 13, departamental2_id: 7, resultado1: "2", resultado2: "1", ganador: 1, estado: "FINALIZADO", fecha: "2026-10-09" };

function basePrueba() {
  const estado = { edicion: { ...EDICION }, registro: null, consultas: [], respaldos: [],
    olimpiada_disciplina_config: [1, 2, 3].map(id => ({ id, olimpiada_id: 1, disciplina_id: id })),
    olimpiada_partido: [{ ...AJEDREZ }], olimpiada_torneo: [], olimpiada_torneo_instancia: [], olimpiada_medalla: [], olimpiada_historial: [] };
  let snapshot;
  const db = {
    async beginTransaction() { snapshot = structuredClone(estado); },
    async commit() { snapshot = null; },
    async rollback() { Object.assign(estado, snapshot); snapshot = null; estado.rollback = true; },
    async query(sql, params = []) {
      estado.consultas.push(sql);
      if (/GET_LOCK/.test(sql)) return [[{ tomado: 1 }]];
      if (/RELEASE_LOCK/.test(sql)) return [[{ liberado: 1 }]];
      if (/FROM olimpiada WHERE/.test(sql)) return [[{ ...estado.edicion }]];
      if (/SELECT estado, checksum/.test(sql)) return [estado.registro ? [estado.registro] : []];
      if (/FROM olimpiada_disciplina WHERE/.test(sql)) return [TORNEOS.map(t => ({ id: t.disciplina_id, nombre: t.disciplina }))];
      if (/FROM departamental WHERE/.test(sql)) return [Object.entries(DEPARTAMENTALES).map(([id, nombre]) => ({ id: Number(id), nombre }))];
      if (/FROM olimpiada_instancia WHERE/.test(sql)) return [[{ id: 5, nombre: "Semifinal" }, { id: 6, nombre: "Tercer puesto" }, { id: 7, nombre: "Final" }]];
      if (/FROM olimpiada_sede WHERE/.test(sql)) return [[{ id: 1, olimpiada_id: 1, nombre: "Camping AJB", tipo: "DEPORTIVA", eliminado: 0 }]];
      const lectura = /SELECT \* FROM (\w+) WHERE olimpiada_id = 1/.exec(sql);
      if (lectura) return [structuredClone(estado[lectura[1]])];
      if (/INSERT INTO ajb_schema_migration/.test(sql)) {
        estado.registro = { estado: "APLICADA", checksum: params[1] }; return [{ affectedRows: 1 }];
      }
      const insercion = /INSERT INTO (\w+) \(([^)]+)\)/.exec(sql);
      if (insercion) {
        assert.equal(estado.respaldos.length, 1, "Debe existir un respaldo previo");
        const dato = Object.fromEntries(insercion[2].split(", ").map((c, i) => [c, params[i]]));
        if (insercion[1] === "olimpiada_medalla" && estado.fallar) throw new Error("Error simulado");
        const rows = estado[insercion[1]];
        assert.ok(rows, "Sólo se pueden insertar las tablas permitidas");
        dato.id = rows.length + 100;
        rows.push(dato);
        return [{ insertId: dato.id }];
      }
      assert.fail(`Consulta no prevista: ${sql}`);
    },
  };
  return { db, estado, respaldar: async datos => { estado.respaldos.push(structuredClone(datos)); return "/respaldo.json"; } };
}

test("competición demo: final usa ganadores, bronce usa perdedores y las medallas derivan de los partidos", () => {
  const podios = [];
  for (const torneo of TORNEOS) {
    const { partidos: [s1, s2, bronce, final], medallas } = armarResultados(torneo);
    const ganador = p => p[`departamental${p.ganador}_id`], perdedor = p => p[`departamental${p.ganador === 1 ? 2 : 1}_id`];
    assert.deepEqual([final.departamental1_id, final.departamental2_id], [ganador(s1), ganador(s2)]);
    assert.deepEqual([bronce.departamental1_id, bronce.departamental2_id], [perdedor(s1), perdedor(s2)]);
    assert.deepEqual(medallas.map(m => m.departamental_id), [ganador(final), perdedor(final), ganador(bronce)]);
    assert.deepEqual(final.origenes, [0, 1]); assert.deepEqual(bronce.origenes, [0, 1]);
    podios.push(medallas.map(m => m.departamental_id));
    for (const p of [s1, s2, bronce, final]) {
      assert.ok(p.fecha >= EDICION.fecha_inicio && p.fecha <= EDICION.fecha_fin);
      assert.ok(p.hora_fin > p.hora_inicio);
      assert.equal(p.ganador, Number(p.resultado1) > Number(p.resultado2) ? 1 : 2);
    }
    assert.ok(s1.hora_fin <= s2.hora_inicio);
    assert.ok(bronce.hora_fin <= final.hora_inicio);
  }
  assert.deepEqual(podios, [[1, 5, 12], [14, 1, 12], [12, 14, 8]]);
  assert.equal(armarResultados(TORNEOS[2]).partidos[0].resultado2, "0");
  assert.equal(armarResultados(TORNEOS[2]).partidos[2].resultado1, "0");
});

test("competición demo: posiciones y puntos del medallero son coherentes con los resultados", () => {
  const partidos = TORNEOS.flatMap(t => armarResultados(t).partidos.map(p => ({ ...p, estado: "FINALIZADO",
    departamental1_nombre: DEPARTAMENTALES[p.departamental1_id], departamental2_nombre: DEPARTAMENTALES[p.departamental2_id] })));
  const tabla = calcularPosiciones(partidos);
  assert.equal(tabla.length, 6);
  assert.equal(tabla.reduce((sum, d) => sum + d.puntos, 0), 36);
  assert.equal(tabla.reduce((sum, d) => sum + d.jugados, 0), 24);
  assert.equal(tabla.reduce((sum, d) => sum + d.ganados, 0), 12);
  assert.equal(tabla.reduce((sum, d) => sum + d.diferencia, 0), 0);
  for (const torneo of TORNEOS) {
    const resultados = armarResultados(torneo);
    const posiciones = calcularPosiciones(resultados.partidos.map(p => ({ ...p, estado: "FINALIZADO" })));
    assert.deepEqual(posiciones.slice(0, 3).map(p => p.departamental_id), resultados.medallas.map(m => m.departamental_id));
  }
  const puntos = new Map();
  for (const torneo of TORNEOS) for (const m of armarResultados(torneo).medallas) puntos.set(m.departamental_id, (puntos.get(m.departamental_id) || 0) + [0, 10, 5, 4][m.puesto]);
  assert.deepEqual(Object.fromEntries(puntos), { 1: 15, 5: 5, 8: 4, 12: 18, 14: 15 });
});

test("competición demo: preserva Ajedrez, configura sólo tres deportes, crea cuadro/medallas y repetir no duplica", async () => {
  const { db, estado, respaldar } = basePrueba();
  const r = await aplicar(db, { respaldar });
  assert.deepEqual(r.agregados, { disciplinas: 3, torneos: 3, partidos: 12, medallas: 9 });
  assert.deepEqual(estado.olimpiada_partido[0], AJEDREZ);
  assert.deepEqual(estado.olimpiada_disciplina_config.slice(0, 3).map(c => c.disciplina_id), [1, 2, 3]);
  assert.ok(estado.olimpiada_disciplina_config.slice(3).every(c => c.sede_id === 1));
  assert.equal(estado.olimpiada_torneo_instancia.length, 9);
  for (const torneo of r.torneos) {
    const partidos = estado.olimpiada_partido.filter(p => p.torneo_id === torneo.id);
    assert.equal(partidos.length, 4);
    for (const p of partidos.slice(2)) assert.deepEqual([p.partido_origen1_id, p.partido_origen2_id], partidos.slice(0, 2).map(s => s.id));
    for (const p of partidos) {
      assert.equal(p.inscripcion1_id, null); assert.equal(p.inscripcion2_id, null);
      assert.equal(p.mostrar_nombres_publico, 0); assert.equal(p.estado, "FINALIZADO");
      assert.equal(p.sede_id, 1);
    }
  }
  assert.deepEqual(estado.registro, { estado: "APLICADA", checksum: CHECKSUM });
  assert.equal(estado.olimpiada_historial.length, 27);
  assert.ok(estado.consultas.every(sql => !/^\s*(?:UPDATE|DELETE)\b|\bINSERT INTO (?:notificacion|mensaje|correo)/.test(sql)));
  assert.deepEqual((await aplicar(db)).agregados, { disciplinas: 0, torneos: 0, partidos: 0, medallas: 0 });
  assert.equal(estado.olimpiada_partido.length, 13);
});

test("competición demo: fallo de medallas revierte torneos, partidos y nuevas configuraciones", async () => {
  const { db, estado, respaldar } = basePrueba();
  estado.fallar = true;
  await assert.rejects(aplicar(db, { respaldar }), /Error simulado/);
  assert.equal(estado.rollback, true);
  assert.deepEqual(estado.olimpiada_partido, [AJEDREZ]);
  assert.equal(estado.olimpiada_disciplina_config.length, 3);
  assert.equal(estado.olimpiada_torneo.length, 0);
  assert.equal(estado.olimpiada_medalla.length, 0);
  assert.equal(estado.registro, null);
});

test("competición demo: no pisa medallas existentes ni admite una edición oficial", async () => {
  const { db, estado, respaldar } = basePrueba();
  estado.olimpiada_medalla.push({ id: 1, disciplina_id: 6, puesto: 1, departamental_id: 4 });
  await assert.rejects(aplicar(db, { respaldar }), /no se sobrescriben/);
  estado.olimpiada_medalla = []; estado.edicion.edicion = "Oficial";
  await assert.rejects(aplicar(db, { respaldar }), /sólo admite/);
  assert.equal(estado.respaldos.length, 0);
});
