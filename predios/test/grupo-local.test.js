"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const tls = require("node:tls");
const { crearSqlite, asegurarEsquema, escribirMeta } = require("../lib/db-sqlite");
const { crearGrupoLocal } = require("../lib/grupo-local");
const { crearTestigo } = require("../lib/testigo-lan");
const { crearSnapshotDirecta, crearRespaldoLan } = require("../lib/respaldo-lan");
const { firmarPeticion } = require("../lib/protocolo-lan");
const { descifrarJson } = require("../lib/http-lan");
const CA = tls.rootCertificates.find((c) => new crypto.X509Certificate(c).ca);
const PRINCIPAL = "a".repeat(64), TESTIGO = "b".repeat(64), RESPALDO = "c".repeat(64);
async function escenario(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-grupo-local-test-"));
  const db = crearSqlite(path.join(base, "datos", "predio.db"), { predioId: 1 }); asegurarEsquema(db); escribirMeta(db, "instancia_id", "instancia-original");
  const config = { predio_id: 1, predio_codigo: "MIRAMAR", token: "token-original-fixture", servidor: "https://central.example/api", puerto: 8080, clave_publica: "publica-central" };
  let witness = null, actual = null, congelado = false, reinicios = 0, snapshotCount = 0, ultimoPacket = null, fallo = null;
  const paquetes = [], orden = [], primarias = [];
  const deps = {
    ahora: () => 1800000000000, hostname: () => "principal", prepararTls: async () => {}, leerTls: () => ({ raiz: Buffer.from(CA), puerto: 8443 }),
    armarInstaladorApoyo: async (p) => { paquetes.push(p); return { buffer: Buffer.from("ZIP-fixture"), nombreArchivo: "equipo.zip" }; },
    estadoTestigo: async () => { if (!witness) throw new Error("Sin testigo"); const e = witness.estado().estado; return { ...e, escritor: e.escritor?.id || null }; },
    crearSnapshotDirecta: (p) => { snapshotCount++; orden.push("snapshot"); assert.equal(congelado, true); ultimoPacket = crearSnapshotDirecta(p); return ultimoPacket; },
    pedir: async (_url, ruta, opciones) => {
      if (fallo === ruta) throw new Error("Red interrumpida");
      if (ruta === "/lan/testigo/configurar") return witness.actualizarMiembros(descifrarJson(opciones.buffer, JSON.parse(db.conexion.prepare("SELECT valor FROM predio_meta WHERE clave='ha_admin_json'").get().valor).claveAdministracion).miembros);
      if (ruta === "/lan/testigo/inicializar") { orden.push("seed"); assert.equal(orden.includes("replica"), true); return witness.inicializarRevision(descifrarJson(opciones.buffer, JSON.parse(db.conexion.prepare("SELECT valor FROM predio_meta WHERE clave='ha_admin_json'").get().valor).claveAdministracion).revision); }
      if (ruta === "/lan/replica/inicial") { orden.push("replica"); assert.equal(opciones.ca, CA); assert.equal(Buffer.compare(opciones.buffer, ultimoPacket.buffer), 0); return { guardado: true, revision: { indice: 0, sha256: ultimoPacket.manifest.sha256 } }; }
      throw new Error("Ruta inesperada en prueba");
    },
  };
  function abrir(extra = {}) { return crearGrupoLocal({ base, dirApp: path.join(__dirname, ".."), version: "1.0+fixture", config, db, equipoId: PRINCIPAL, haActual: () => actual, bloquearEscritura: () => { orden.push("freeze"); congelado = true; fs.writeFileSync(path.join(base, "ha-activacion-pendiente.json"), "{}"); },
    activarLocal: async ({ ha, packet, autoridadIniciada }) => { orden.push("local"); assert.equal(congelado, true); actual = { habilitado: true, escritor: false }; primarias.push({ ha, packet, autoridadIniciada }); if (!autoridadIniciada) crearRespaldoLan({ base, config: { ...config, respaldo_lan: ha }, db }).registrarInicial(packet); }, reiniciar: () => { orden.push("reiniciar"); reinicios++; }, deps, ...extra }); }
  let grupo = abrir();
  t.after(() => { witness?.cerrar(); db.cerrar(); fs.rmSync(base, { recursive: true, force: true }); });
  async function incorporar(rol, nodo, extra = {}, paquete = paquetes[paquetes.length - 1]) {
    const i = paquete.configInicial;
    const datos = { rol, nodoId: nodo, nombre: rol.toLowerCase(), ...extra }, cuerpo = Buffer.from(JSON.stringify(datos));
    const cabeceras = { ...firmarPeticion({ grupoId: i.grupoId, nodoId: nodo, metodo: "POST", ruta: "/lan/incorporar", cuerpo, clave: i.incorporacion.clave, ahora: deps.ahora() }), "X-AJB-Incorporacion": i.incorporacion.id };
    const buffer = await grupo.incorporar({ metodo: "POST", ruta: "/lan/incorporar", cabeceras, cuerpo });
    return descifrarJson(buffer, i.incorporacion.clave);
  }
  async function prepararGrupo() {
    await grupo.instalador("Testigo");
    witness = crearTestigo({ base: path.join(base, "testigo-fixture"), config: paquetes[0].configInicial.configTestigo, monotono: () => 0 });
    await incorporar("Testigo", TESTIGO, { url: "http://testigo:39877", clavePublicaTestigo: witness.estado().clave_publica });
    await grupo.instalador("Respaldo");
    return incorporar("Respaldo", RESPALDO, { url: "https://respaldo:8443", caPublica: CA });
  }
  return { base, db, config, deps, paquetes, orden, primarias, abrir, incorporar, prepararGrupo, get grupo() { return grupo; }, set grupo(g) { grupo = g; }, get witness() { return witness; }, get reinicios() { return reinicios; }, get snapshots() { return snapshotCount; }, set fallo(ruta) { fallo = ruta; }, get packet() { return ultimoPacket; }, set packet(p) { ultimoPacket = p; } };
}

test("onboarding mantiene legacy hasta activación, registros privados y respuesta idempotente para mismo hardware", async (t) => {
  const s = await escenario(t);
  const inicial = await s.grupo.estado();
  assert.equal(inicial.estado, "SIN_CONFIGURAR"); assert.equal(inicial.principal.id, PRINCIPAL); assert.equal(inicial.escritor.id, PRINCIPAL);
  const respuesta = await s.prepararGrupo();
  assert.equal(respuesta.ha.equipoId, RESPALDO); assert.equal(respuesta.configPredio.token, s.config.token);
  assert.equal(respuesta.ha.miembros.some((m) => m.clave), false);
  const paquete = s.paquetes[1], repetida = await s.incorporar("Respaldo", RESPALDO, { url: "https://respaldo:8443", caPublica: CA }, paquete);
  assert.deepEqual(repetida, respuesta);
  await assert.rejects(s.incorporar("Respaldo", "d".repeat(64), { url: "https://otra:8443", caPublica: CA }, paquete), /usado|autenticada/);
  const estado = await s.grupo.estado(); assert.equal(estado.puedeActivar, true); assert.equal(estado.habilitado, false);
  assert.equal(JSON.stringify(estado).includes(s.config.token), false); assert.equal(JSON.stringify(estado).includes(respuesta.ha.claveDatos), false);
  assert.equal(fs.existsSync(path.join(s.base, "predio-ha.json")), false);
});

test("el acceso del grupo automático lleva sólo datos públicos y la baja se replica antes de retirar el voto", async t => {
  const s = await escenario(t);
  const grupoId = "quorum_fixture";
  const miembros = [
    { id: PRINCIPAL, nombre: "principal", url: "https://principal:8443", preferido: true, caPublica: CA, clave: "a".repeat(64) },
    { id: RESPALDO, nombre: "caja", url: "https://caja:8443", caPublica: CA, clave: "b".repeat(64) },
  ];
  const leerRegistro = () => JSON.parse(s.db.conexion.prepare("SELECT valor FROM predio_meta WHERE clave='ha_admin_json'").get().valor);
  escribirMeta(s.db, "ha_admin_json", JSON.stringify({ formato: 1, grupoId, principalId: PRINCIPAL, claveDatos: "c".repeat(64),
    miembros, quorum: { publica: "firma-publica" }, pendientes: [{ usadoPor: RESPALDO }] }));
  let completar = false;
  const grupo = s.abrir({ haActual: () => ({ habilitado: true, escritor: true }),
    consultarQuorum: async () => ({ escritor: PRINCIPAL, miembros: miembros.map(({ clave, ...m }) => m) }),
    revisarRetiro: async id => { assert.equal(id, RESPALDO); assert.equal(leerRegistro().miembros.length, 2); },
    retirarQuorum: async id => {
      assert.equal(id, RESPALDO);
      const r = leerRegistro();
      assert.equal(r.miembros.some(m => m.id === id), false);
      assert.deepEqual(r.quorum.retiros, [id]);
      if (!completar) throw new Error("Red interrumpida");
    },
  });
  await grupo.instaladorAcceso();
  const c = s.paquetes.at(-1).configInicial;
  assert.deepEqual(Object.keys(c).sort(), ["accesoQuorum", "clavePublicaTestigo", "grupoId", "habilitado", "miembros", "rolInstalacion"]);
  assert.ok(c.miembros.every(m => m.caPublica && !m.clave));
  assert.equal(leerRegistro().miembros.length, 2);
  await assert.rejects(grupo.quitarRespaldo(PRINCIPAL), /PC de origen/);
  assert.deepEqual(await grupo.quitarRespaldo(RESPALDO), { retirado: false, pendiente: true });
  assert.equal(leerRegistro().pendientes.length, 0);
  completar = true;
  assert.deepEqual(await grupo.quitarRespaldo(RESPALDO), { retirado: true });
});

test("copia inicial se toma tras congelar y tras ventas posteriores a preparar instaladores, antes de sembrar testigo", async (t) => {
  const s = await escenario(t); await s.prepararGrupo();
  await s.db.run("INSERT INTO predio_producto(predio_id,id,nombre,destino,activo) VALUES(1,1,'Venta posterior a preparar PCs','VENTA_DIRECTA',1)");
  const r = await s.grupo.activar();
  assert.equal(r.activado, true); assert.equal(s.snapshots, 1); assert.equal(s.reinicios, 1);
  assert.deepEqual(s.orden.slice(-6), ["freeze", "snapshot", "local", "replica", "seed", "reiniciar"]);
  assert.equal(s.witness.estado().estado.ultimo.sha256, r.revision.sha256);
  assert.equal(s.primarias[0].ha.certificado.datos.instanciaId, "instancia-original");
  const esperado = crypto.createHmac("sha256", s.config.token).update(JSON.stringify(s.primarias[0].ha.certificado.datos)).digest("hex");
  assert.equal(s.primarias[0].ha.certificado.firma, esperado);
});

test("una falla entre copia y seed conserva freeze y reanudación usa snapshot inmutable aunque cambien metadatos startup", async (t) => {
  const s = await escenario(t); await s.prepararGrupo(); s.fallo = "/lan/testigo/inicializar";
  await assert.rejects(s.grupo.activar(), /Red interrumpida/);
  assert.equal(s.reinicios, 0); assert.equal(s.snapshots, 1);
  const packet = s.packet;
  escribirMeta(s.db, "ultimo_contacto", "cambió durante reinicio");
  s.grupo = s.abrir(); s.fallo = null; s.packet = packet;
  const r = await s.grupo.reanudarActivacion();
  assert.equal(r.activado, true); assert.equal(s.snapshots, 1, "reanudar nunca vuelve a crear la copia inicial");
  assert.equal(r.revision.sha256, packet.manifest.sha256);
});

test("reanudar tras grant conserva la autoridad y no reenvía seed ni copia cero", async (t) => {
  const s = await escenario(t); await s.prepararGrupo(); await s.grupo.activar();
  const packet = s.packet;
  // El testigo de fixture tiene reloj inmóvil: un segundo árbitro ficticio sólo
  // representa la lectura firmada de una autoridad que ya empezó a operar.
  s.deps.estadoTestigo = async () => ({ termino: 3, escritor: RESPALDO, ultimo: { indice: 4, sha256: "f".repeat(64) } });
  s.grupo = s.abrir(); s.packet = packet; const previos = s.orden.length;
  const r = await s.grupo.reanudarActivacion();
  assert.equal(r.reanudado, true); assert.equal(r.revision.indice, 4); assert.equal(s.snapshots, 1);
  assert.equal(s.primarias[s.primarias.length - 1].autoridadIniciada, true);
  assert.deepEqual(s.orden.slice(previos), ["freeze", "local", "reiniciar"]);
});

test("acceso recibe sólo configuración pública; permisos vencidos y reanudación sin intención se rechazan", async (t) => {
  const s = await escenario(t); await s.prepararGrupo();
  await s.grupo.instalador("Acceso"); const r = await s.incorporar("Acceso", "d".repeat(64));
  assert.equal(r.ha.clave, undefined); assert.equal(r.ha.claveDatos, undefined); assert.equal(r.configPredio, undefined);
  await assert.rejects(s.grupo.reanudarActivacion(), /autorizada pendiente/);
  // Un permiso sin consumir sigue venciendo; la respuesta de un permiso ya usado
  // se puede recuperar después, únicamente con la misma solicitud y hardware.
  await s.grupo.instalador("Acceso");
  const paquete = s.paquetes[s.paquetes.length - 1]; s.deps.ahora = () => paquete.configInicial.incorporacion.vence + 1;
  s.grupo = s.abrir(); await assert.rejects(s.incorporar("Acceso", "d".repeat(64)), /venció/);
});

test("si falla la creación del ZIP no queda un permiso invisible que impida volver a preparar el testigo", async t => {
  const s = await escenario(t), armar = s.deps.armarInstaladorApoyo;
  s.deps.armarInstaladorApoyo = async () => { throw new Error("No se pudo generar el ZIP"); }; s.grupo = s.abrir();
  await assert.rejects(s.grupo.instalador("Testigo"), /No se pudo generar el ZIP/);
  const fallido = await s.grupo.estado();
  assert.equal(fallido.puedePrepararTestigo, true);
  assert.equal(fallido.pendientes.length, 0);
  s.deps.armarInstaladorApoyo = armar; s.grupo = s.abrir();
  await s.grupo.instalador("Testigo");
  const reintentado = await s.grupo.estado();
  assert.equal(reintentado.pendientes.length, 1);
  assert.equal(reintentado.pendientes[0].vence, s.deps.ahora() + 3600000, "reintenta inmediatamente, sin esperar una hora");
  assert.equal(s.paquetes.length, 1);
});

test("la respuesta consumida se recupera con firma nueva tras vencer y preparar otro instalador, sólo para el mismo hardware y cuerpo", async t => {
  const s = await escenario(t), respuesta = await s.prepararGrupo(), paquete = s.paquetes[1];
  await s.grupo.instalador("Acceso"); const sinUsar = s.paquetes[s.paquetes.length - 1];
  const futuro = Math.max(paquete.configInicial.incorporacion.vence, sinUsar.configInicial.incorporacion.vence) + 1;
  s.deps.ahora = () => futuro; s.grupo = s.abrir();
  await s.grupo.instalador("Acceso");
  const pendientes = (await s.grupo.estado()).pendientes;
  assert.ok(pendientes.some(p => p.id === paquete.configInicial.incorporacion.id && p.incorporado));
  assert.equal(pendientes.some(p => p.id === sinUsar.configInicial.incorporacion.id), false, "limpia permisos vencidos que nunca se usaron");
  // incorporar vuelve a firmar cada intento con la hora actual y nonce nuevo.
  assert.deepEqual(await s.incorporar("Respaldo", RESPALDO, { url: "https://respaldo:8443", caPublica: CA }, paquete), respuesta);
  assert.deepEqual(await s.incorporar("Respaldo", RESPALDO, { url: "https://respaldo:8443", caPublica: CA }, paquete), respuesta);
  await assert.rejects(s.incorporar("Respaldo", "d".repeat(64), { url: "https://respaldo:8443", caPublica: CA }, paquete), /usado|autenticada/);
  await assert.rejects(s.incorporar("Respaldo", RESPALDO, { url: "https://modificada:8443", caPublica: CA }, paquete), /usado/);
});

test("un respaldo promovido puede incorporar otro con registro replicado sin cambiar la identidad ni certificado originales", async (t) => {
  const s = await escenario(t); const b = await s.prepararGrupo();
  const grupoB = crearGrupoLocal({ base: s.base, dirApp: path.join(__dirname, ".."), version: "1.0+fixture", config: s.config, db: s.db, equipoId: RESPALDO, haActual: () => ({ habilitado: true, escritor: true }), deps: { ...s.deps, hostname: () => "respaldo" } });
  await grupoB.instalador("Respaldo");
  const inicial = s.paquetes[s.paquetes.length - 1].configInicial;
  assert.equal(inicial.incorporacion.principalUrl, "https://respaldo:8443"); assert.equal(inicial.grupoId, b.ha.grupoId);
  const nodo = "d".repeat(64), cuerpo = Buffer.from(JSON.stringify({ rol: "Respaldo", nodoId: nodo, nombre: "segundo", url: "https://segundo:8443", caPublica: CA }));
  const cabeceras = { ...firmarPeticion({ grupoId: inicial.grupoId, nodoId: nodo, metodo: "POST", ruta: "/lan/incorporar", cuerpo, clave: inicial.incorporacion.clave, ahora: s.deps.ahora() }), "X-AJB-Incorporacion": inicial.incorporacion.id };
  const c = descifrarJson(await grupoB.incorporar({ metodo: "POST", ruta: "/lan/incorporar", cuerpo, cabeceras }), inicial.incorporacion.clave);
  assert.equal(c.ha.certificado.datos.equipoOrigenId, PRINCIPAL); assert.equal(c.ha.certificado.datos.instanciaId, "instancia-original");
  assert.equal(c.configPredio.token, s.config.token); assert.equal(c.ha.miembros.find((m) => m.id === RESPALDO).clave, undefined);
  const registro = JSON.parse(s.db.conexion.prepare("SELECT valor FROM predio_meta WHERE clave='ha_admin_json'").get().valor);
  assert.equal(registro.miembros.find((m) => m.id === RESPALDO).clave, b.ha.clave);
});
