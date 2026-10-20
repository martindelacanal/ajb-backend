"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CHECKSUM, FOTOS, NOVEDADES, EVENTOS, validarEdicion, aplicar } = require("../scripts/seed-olimpiadas-demo-contenido");

const EDICION = { id: 1, nombre: "Olimpiadas 2026", edicion: "Demo", fecha_inicio: "2026-09-23", fecha_fin: "2026-09-26", habilitado: "Y", eliminado: 0, publicada_publico: 1 };
function basePrueba() {
  const estado = { edicion: { ...EDICION }, registro: null, consultas: [], historial: [], respaldos: [],
    olimpiada_novedad: [{ id: 40, titulo: "Novedad existente", cuerpo: "Conservar" }], olimpiada_evento: [], olimpiada_foto: [] };
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
      const lectura = /SELECT \* FROM (olimpiada_novedad|olimpiada_evento|olimpiada_foto) WHERE olimpiada_id = 1/.exec(sql);
      if (lectura) return [structuredClone(estado[lectura[1]])];
      const insercion = /INSERT INTO (olimpiada_novedad|olimpiada_evento|olimpiada_foto) \(([^)]+)\)/.exec(sql);
      if (insercion) {
        assert.equal(params[0], 1);
        assert.equal(estado.respaldos.length, 1, "Debe existir un respaldo antes de insertar");
        const dato = Object.fromEntries(insercion[2].split(", ").map((c, i) => [c, params[i]]));
        dato.id = estado[insercion[1]].length + 100;
        estado[insercion[1]].push(dato);
        return [{ insertId: dato.id }];
      }
      if (/INSERT INTO olimpiada_historial/.test(sql)) {
        if (estado.fallar) throw new Error("Error simulado");
        estado.historial.push(params);
        return [{ insertId: estado.historial.length }];
      }
      if (/INSERT INTO ajb_schema_migration/.test(sql)) {
        estado.registro = { estado: "APLICADA", checksum: params[1] };
        return [{ affectedRows: 1 }];
      }
      assert.fail(`Consulta no prevista: ${sql}`);
    },
  };
  return { estado, db,
    preparar: async () => FOTOS.map(f => ({ ...f, ancho: 1200, alto: 1600, mime: "image/webp", sourceHash: "prueba" })),
    respaldar: async datos => { estado.respaldos.push(structuredClone(datos)); return "/respaldo.json"; } };
}

test("demo: sólo admite la edición exacta finalizada, habilitada y pública", () => {
  assert.doesNotThrow(() => validarEdicion(EDICION, "2026-10-20"));
  for (const cambios of [{ id: 2 }, { nombre: "Otra" }, { edicion: "Oficial" }, { fecha_inicio: "2026-09-22" },
    { fecha_fin: "2026-10-20" }, { habilitado: "N" }, { eliminado: 1 }, { publicada_publico: 0 }]) {
    assert.throws(() => validarEdicion({ ...EDICION, ...cambios }, "2026-10-20"), /sólo admite/);
  }
  assert.throws(() => validarEdicion(EDICION, "2026-09-26"), /finalizada/);
});

test("demo: el dataset aclara su carácter de ejemplo y separa las actividades", () => {
  assert.equal(NOVEDADES.length, 4);
  assert.equal(EVENTOS.length, 8);
  assert.equal(FOTOS.length, 6);
  assert.equal(EVENTOS.filter(e => e.tipo === "ACTIVIDAD").length, 2);
  assert.equal(NOVEDADES.filter(n => n.fijada === 1).length, 1);
  for (const dato of [...NOVEDADES, ...EVENTOS]) assert.match(dato.titulo, /^\[Ejemplo\] /);
  for (const evento of EVENTOS) {
    assert.ok(evento.fecha >= EDICION.fecha_inicio && evento.fecha <= EDICION.fecha_fin);
    assert.ok(evento.hora_fin > evento.hora_inicio);
    assert.match(evento.descripcion, /ejemplo/);
  }
  for (const foto of FOTOS) {
    assert.match(foto.url, /^https:\/\/ajb\.org\.ar\/wp-content\/uploads\/2025\/12\//);
    assert.match(foto.epigrafe, /Archivo AJB 2025.*ejemplo/);
    assert.match(foto.archivo, /^olimpiadas\/1\/demo-contenido-20261020\//);
  }
});

test("demo: agrega contenido sin modificar existentes, no notifica y repetir no duplica", async () => {
  const { db, estado, preparar, respaldar } = basePrueba();
  const resultado = await aplicar(db, { preparar, respaldar });
  assert.deepEqual(resultado.agregados, { novedades: 4, eventos: 8, fotos: 6 });
  assert.deepEqual(estado.olimpiada_novedad[0], { id: 40, titulo: "Novedad existente", cuerpo: "Conservar" });
  assert.ok(estado.olimpiada_novedad.slice(1).every(n => n.publicada === 1 && n.notificada === 0));
  assert.equal(estado.historial.length, 18);
  assert.deepEqual(estado.registro, { estado: "APLICADA", checksum: CHECKSUM });
  assert.ok(estado.consultas.every(sql => !/^\s*(?:UPDATE|DELETE)\b|\bINSERT INTO (?:notificacion|mensaje|correo)/.test(sql)));
  const otra = await aplicar(db, { preparar: () => assert.fail("No debe subir imágenes otra vez") });
  assert.deepEqual(otra.agregados, { novedades: 0, eventos: 0, fotos: 0 });
  assert.equal(estado.olimpiada_novedad.length, 5);
  assert.equal(estado.respaldos.length, 1);
});

test("demo: un fallo revierte todas las filas insertadas y el marcador de ejecución", async () => {
  const { db, estado, preparar, respaldar } = basePrueba();
  estado.fallar = true;
  await assert.rejects(aplicar(db, { preparar, respaldar }), /Error simulado/);
  assert.equal(estado.rollback, true);
  assert.equal(estado.olimpiada_novedad.length, 1);
  assert.equal(estado.olimpiada_evento.length, 0);
  assert.equal(estado.olimpiada_foto.length, 0);
  assert.equal(estado.registro, null);
});

test("demo: rechaza otra edición antes de subir imágenes o iniciar una escritura", async () => {
  const { db, estado } = basePrueba();
  estado.edicion.edicion = "Oficial";
  await assert.rejects(aplicar(db, { preparar: () => assert.fail("No subir"), respaldar: () => assert.fail("No escribir") }), /sólo admite/);
  assert.ok(estado.consultas.every(sql => sql.startsWith("SELECT")));
});
