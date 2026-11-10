"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { crearAutoridadQuorum } = require("../lib/quorum-lan");

function escenario({ temporal = false } = {}) {
  const ids = ["a", "b", "c"].map(letra => letra.repeat(64));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const config = { grupoId: "grupo_fixture", nodoId: ids[0],
    clavePublicaTestigo: publicKey.export({ type: "spki", format: "pem" }),
    quorum: { puerto: 39878, clavePrivada: privateKey.export({ type: "pkcs8", format: "pem" }) } };
  let lectura = { term: 4, leader: ids[0], configuration: 8,
    members: ids.map((id, i) => ({ ID: id, Suffrage: temporal && i ? 1 : 0 })),
    register: { version: 10, data: { grupoId: config.grupoId, termino: 4, preferidoId: ids[0],
      ultimo: { indice: 19, sha256: "f".repeat(64) },
      miembros: ids.map((id, i) => ({ id, nombre: `PC ${i}`, clave: String(i + 1).repeat(64) })),
      ...(temporal ? { soloPrincipal: ids.slice(1), arranquesSoloPrincipal: Object.fromEntries(ids.slice(1).map(id => [id, "d".repeat(32)])) } : {}) } } };
  const operaciones = [];
  const consenso = { async pedir(ruta, cuerpo) {
    if (!cuerpo) { assert.equal(ruta, "/state"); return structuredClone(lectura); }
    assert.equal(cuerpo.expected, lectura.register.version);
    assert.equal(cuerpo.term, lectura.term);
    assert.equal(cuerpo.configuration, lectura.configuration);
    operaciones.push({ ruta, cuerpo: structuredClone(cuerpo) });
    if (ruta === "/state") {
      lectura.register = { version: lectura.register.version + 1, data: structuredClone(cuerpo.data) };
      return structuredClone(lectura.register);
    }
    assert.equal(ruta, "/member");
    assert.equal(cuerpo.demote, true);
    assert.ok(lectura.register.data.soloPrincipal.includes(cuerpo.id), "la intención se conserva antes de quitar votos");
    lectura.members.find(m => m.ID === cuerpo.id).Suffrage = 1;
    lectura.configuration++;
    return true;
  } };
  return { ids, operaciones, abrir: () => crearAutoridadQuorum({ config, consenso }),
    get lectura() { return structuredClone(lectura); }, avanzar() { lectura.register.version++; } };
}

test("el modo notebook conserva un único voto y su pausa sobrevive al abrir nuevamente la autoridad", async () => {
  const s = escenario(), autoridad = s.abrir();
  const plan = await autoridad.prepararModoPrincipal();
  assert.equal(plan.miembros.length, 2);
  assert.deepEqual(await autoridad.dejarSoloPrincipal(plan.version), { soloPrincipal: true });
  assert.deepEqual(s.lectura.members.filter(m => m.Suffrage === 0).map(m => m.ID), [s.ids[0]]);
  assert.deepEqual(s.lectura.register.data.soloPrincipal, s.ids.slice(1));
  assert.equal(Object.hasOwn(s.lectura.register.data, "arranquesSoloPrincipal"), false);
  const reabierta = s.abrir();
  assert.equal(await reabierta.prepararModoPrincipal(), null, "repetir la solicitud no cambia votos ni requiere respaldos");
  const reactivacion = await reabierta.prepararReactivacion();
  assert.equal(reactivacion.arranques, undefined, "el sondeo automático no puede reactivar el grupo");
  assert.equal(reactivacion.miembros.length, 2, "se conserva la posibilidad de reactivar manualmente");
});

test("convertir un modo temporal anterior elimina el regreso automático sin volver a necesitar las PCs apagadas", async () => {
  const s = escenario({ temporal: true }), autoridad = s.abrir();
  assert.ok((await autoridad.prepararReactivacion()).arranques);
  const plan = await autoridad.prepararModoPrincipal();
  assert.deepEqual(plan.miembros, []);
  await autoridad.dejarSoloPrincipal(plan.version);
  assert.equal((await s.abrir().prepararReactivacion()).arranques, undefined);
  assert.equal(s.operaciones.filter(o => o.ruta === "/member").length, 0, "los respaldos ya no tenían voto");
  assert.deepEqual(s.lectura.register.data.ultimo, { indice: 19, sha256: "f".repeat(64) });
  assert.equal(await autoridad.prepararModoPrincipal(), null);
});

test("un cambio concurrente del registro impide fijar un modo preparado con otra revisión", async () => {
  const s = escenario({ temporal: true }), autoridad = s.abrir();
  const plan = await autoridad.prepararModoPrincipal();
  s.avanzar();
  await assert.rejects(autoridad.dejarSoloPrincipal(plan.version), /Cambió el grupo/);
  assert.equal(s.operaciones.length, 0);
  assert.ok(s.lectura.register.data.arranquesSoloPrincipal);
});
