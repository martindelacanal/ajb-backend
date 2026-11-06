"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const tls = require("node:tls");
const { execFileSync } = require("node:child_process");
const { crearTestigo, LEASE_MS, USO_MS, CUARENTENA_MS } = require("../lib/testigo-lan");
const { firmarPeticion, crearVerificador, firmarAckReplica, verificarEstadoFirmado } = require("../lib/protocolo-lan");
const R0 = { indice: 0, sha256: "a".repeat(64) }, R1 = { indice: 1, sha256: "b".repeat(64) }, R2 = { indice: 2, sha256: "c".repeat(64) };
function configuracion() { return { grupoId: "grupo-fixture", revisionInicial: R0, miembros: [
  { id: "principal", nombre: "Notebook principal", url: "http://principal:8080", clave: "clave-fixture-principal-larga", preferido: true },
  { id: "respaldo", nombre: "Notebook respaldo", url: "http://respaldo:8080", clave: "clave-fixture-respaldo-larga" },
] }; }
function preparar(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-testigo-test-"));
  const config = configuracion();
  const reloj = { mono: 0, wall: 1800000000000 };
  const abiertos = [];
  const abrir = (extra = {}) => { const a = crearTestigo({ base, config, ahora: () => reloj.wall, monotono: () => reloj.mono, ...extra }); abiertos.push(a); return a; };
  const avanzar = (n) => { reloj.mono += n; reloj.wall += n; };
  t.after(() => { abiertos.forEach((a) => a.cerrar()); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, config, reloj, abrir, avanzar };
}
function copia(config, termino, revision, escritor = "principal", nodo = "respaldo") { return firmarAckReplica({ grupoId: config.grupoId, nodoId: nodo, escritorId: escritor, termino, ...revision }, config.miembros.find((m) => m.id === nodo).clave); }

test("cuarentena de inicio y leases dan un solo escritor; una partición no habilita al respaldo antes del vencimiento", (t) => {
  const { abrir, avanzar } = preparar(t); const a = abrir();
  assert.equal(a.solicitar({ nodoId: "principal", revision: R0 }).autorizado, false);
  avanzar(CUARENTENA_MS - 1); assert.equal(a.solicitar({ nodoId: "respaldo", revision: R0 }).autorizado, false);
  avanzar(1); const p = a.solicitar({ nodoId: "principal", revision: R0 });
  assert.equal(p.autorizado, true); assert.equal(p.vence_en_ms, LEASE_MS); assert.equal(p.uso_maximo_ms, USO_MS);
  assert.equal(a.solicitar({ nodoId: "respaldo", revision: R0 }).autorizado, false);
  avanzar(LEASE_MS - 1); assert.equal(a.solicitar({ nodoId: "respaldo", revision: R0 }).autorizado, false);
  avanzar(1); const b = a.solicitar({ nodoId: "respaldo", revision: R0 });
  assert.equal(b.autorizado, true); assert.equal(b.termino, p.termino + 1);
  assert.throws(() => a.renovar({ nodoId: "principal", termino: p.termino, revision: R0 }), /permiso vigente/);
});

test("confirmación ordenada exige copia durable auténtica de otro miembro y es idempotente", (t) => {
  const { config, abrir, avanzar } = preparar(t); const a = abrir(); avanzar(CUARENTENA_MS);
  const { termino } = a.solicitar({ nodoId: "principal", revision: R0 });
  const confirmar = (r, replicas = []) => a.confirmar({ nodoId: "principal", termino, ...r, replicas });
  assert.throws(() => confirmar(R1), /copia durable/);
  assert.throws(() => confirmar(R1, ["respaldo"]), /acuse durable/);
  const falso = copia(config, termino, R1); falso.ack.sha256 = R2.sha256;
  assert.throws(() => confirmar(R1, [falso]), /acuse durable/);
  const ack = copia(config, termino, R1);
  assert.equal(confirmar(R1, [ack]).confirmado, true);
  assert.equal(confirmar(R1).confirmado, true);
  assert.throws(() => confirmar({ indice: 3, sha256: R2.sha256 }, [ack]), /último índice/);
  assert.throws(() => confirmar({ indice: 1, sha256: R2.sha256 }, [ack]), /último índice/);
  assert.throws(() => confirmar(R0, [ack]), /último índice/);
  assert.equal(a.solicitar({ nodoId: "respaldo", revision: R0 }).autorizado, false);
  avanzar(LEASE_MS); assert.equal(a.solicitar({ nodoId: "respaldo", revision: R0 }).autorizado, false);
  assert.equal(a.solicitar({ nodoId: "respaldo", revision: R1 }).autorizado, true);
});

test("reinicio preserva término, revisión y clave pública y cumple otra cuarentena completa", (t) => {
  const { config, abrir, avanzar, reloj } = preparar(t); let a = abrir(); avanzar(CUARENTENA_MS);
  const { termino } = a.solicitar({ nodoId: "principal", revision: R0 });
  a.confirmar({ nodoId: "principal", termino, ...R1, replicas: [copia(config, termino, R1)] });
  const publica = a.estado().clave_publica; a.cerrar(); reloj.mono = 0; a = abrir();
  assert.equal(a.estado().clave_publica, publica);
  assert.deepEqual(a.estado().estado.ultimo, R1);
  assert.equal(a.solicitar({ nodoId: "respaldo", revision: R1 }).autorizado, false);
  avanzar(CUARENTENA_MS); const b = a.solicitar({ nodoId: "respaldo", revision: R1 });
  assert.equal(b.autorizado, true); assert.equal(b.termino, termino + 1);
  assert.throws(() => a.confirmar({ nodoId: "principal", termino, ...R2, replicas: [copia(config, termino, R2)] }), /permiso vigente/);
});

test("regreso del preferido drena sólo cuando está al día y transfiere tras liberar", (t) => {
  const { config, abrir, avanzar } = preparar(t); const a = abrir(); avanzar(CUARENTENA_MS);
  const b = a.solicitar({ nodoId: "respaldo", revision: R0 });
  a.confirmar({ nodoId: "respaldo", termino: b.termino, ...R1, replicas: [copia(config, b.termino, R1, "respaldo", "principal")] });
  assert.equal(a.solicitar({ nodoId: "principal", revision: R0 }).drenar, false);
  assert.equal(a.solicitar({ nodoId: "principal", revision: R1 }).drenar, true);
  assert.equal(a.renovar({ nodoId: "respaldo", termino: b.termino, revision: R1 }).drenar, true);
  a.confirmar({ nodoId: "respaldo", termino: b.termino, ...R2, replicas: [copia(config, b.termino, R2, "respaldo", "principal")] });
  assert.equal(a.estado().estado.drenar, false, "un commit nuevo invalida la acreditación anterior del preferido");
  a.solicitar({ nodoId: "principal", revision: R2 });
  a.liberar({ nodoId: "respaldo", termino: b.termino });
  assert.equal(a.solicitar({ nodoId: "respaldo", revision: R2 }).autorizado, false);
  const p = a.solicitar({ nodoId: "principal", revision: R2 });
  assert.equal(p.autorizado, true); assert.equal(p.termino, b.termino + 1);
});

test("lease usa reloj monotónico; retroceso de pared no lo extiende y retroceso monotónico bloquea", (t) => {
  const { abrir, avanzar, reloj } = preparar(t); const a = abrir(); avanzar(CUARENTENA_MS);
  a.solicitar({ nodoId: "principal", revision: R0 }); reloj.wall -= 3600000;
  avanzar(LEASE_MS); assert.equal(a.estado().estado.escritor, null);
  assert.equal(a.solicitar({ nodoId: "respaldo", revision: R0 }).autorizado, true);
  reloj.mono -= 1; assert.equal(a.estado().estado.bloqueado, true);
  avanzar(100000); assert.equal(a.solicitar({ nodoId: "principal", revision: R0 }).autorizado, false);
});

test("estado público exige clave anclada, desafío actual, integridad y plazo acotado", (t) => {
  const { config, abrir, avanzar, reloj } = preparar(t); const a = abrir(); avanzar(CUARENTENA_MS); a.solicitar({ nodoId: "principal", revision: R0 });
  const desafio = crypto.randomBytes(24).toString("hex"), sobre = a.estado({ desafio });
  const opciones = { clavePublica: sobre.clave_publica, grupoId: config.grupoId, desafio, ahora: () => reloj.wall };
  assert.equal(verificarEstadoFirmado(sobre, opciones).escritor.id, "principal");
  assert.throws(() => verificarEstadoFirmado(sobre, { ...opciones, desafio: "otra-consulta" }), /firma válida/);
  const alterado = JSON.parse(JSON.stringify(sobre)); alterado.estado.escritor.url = "http://otro:8080";
  assert.throws(() => verificarEstadoFirmado(alterado, opciones), /firma válida/);
  const otra = crypto.generateKeyPairSync("ed25519");
  assert.throws(() => verificarEstadoFirmado(sobre, { ...opciones, clavePublica: otra.publicKey }), /firma válida/);
  avanzar(5001); assert.throws(() => verificarEstadoFirmado(sobre, opciones), /venció/);
});

test("un solo proceso usa una base, recupera candado huérfano y no reemplaza identidad perdida", (t) => {
  const { base, config, abrir } = preparar(t); const a = abrir();
  assert.throws(() => abrir(), /Ya hay un proceso/); a.cerrar();
  const modulo = require.resolve("../lib/testigo-lan");
  execFileSync(process.execPath, ["-e", "require(process.argv[1]).crearTestigo({base:process.argv[2],config:JSON.parse(process.argv[3])});process.exit(0)", modulo, base, JSON.stringify(config)], { windowsHide: true, stdio: "ignore" });
  const b = abrir(); assert.ok(b.estado().estado.cuarentena_ms > 0); b.cerrar();
  fs.unlinkSync(path.join(base, "testigo-firma.json"));
  assert.throws(() => abrir(), /Falta la identidad/);
});

test("fallo de persistencia bloquea el proceso hasta reinicio con cuarentena", (t) => {
  const { abrir, avanzar } = preparar(t); const a = abrir(); avanzar(CUARENTENA_MS);
  const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (desde, hasta) => { if (String(hasta).endsWith("testigo-estado.json")) throw Object.assign(new Error("Disco no disponible"), { code: "EIO" }); return original(desde, hasta); });
  assert.throws(() => a.solicitar({ nodoId: "principal", revision: R0 }), /Disco no disponible/);
  assert.equal(a.estado().estado.escritor, null); assert.equal(a.estado().estado.termino, 0);
  t.mock.restoreAll(); assert.equal(a.solicitar({ nodoId: "principal", revision: R0 }).autorizado, false);
  assert.equal(a.estado().estado.bloqueado, true); a.cerrar();
  const nuevo = abrir(); assert.equal(nuevo.solicitar({ nodoId: "principal", revision: R0 }).autorizado, false);
  avanzar(CUARENTENA_MS); assert.equal(nuevo.solicitar({ nodoId: "principal", revision: R0 }).termino, 1);
});

test("HMAC de peticiones ata identidad, ruta y cuerpo, limita TTL y rechaza replay", () => {
  const config = configuracion(); let tiempo = 1800000000000;
  const verificar = crearVerificador({ grupoId: config.grupoId, miembros: config.miembros, ahora: () => tiempo });
  const datos = { grupoId: config.grupoId, nodoId: "principal", metodo: "POST", ruta: "/lan/testigo/solicitar", cuerpo: Buffer.from('{"revision":0}'), clave: config.miembros[0].clave, ahora: tiempo };
  const cabeceras = firmarPeticion(datos);
  assert.throws(() => verificar({ ...datos, cuerpo: Buffer.from("otro cuerpo"), cabeceras }), /firma LAN/);
  assert.deepEqual(verificar({ ...datos, cabeceras }), { nodoId: "principal" });
  assert.throws(() => verificar({ ...datos, cabeceras }), /ya fue utilizada/);
  tiempo += 30001; assert.throws(() => verificar({ ...datos, cabeceras }), /venció/);
  const falsos = firmarPeticion({ ...datos, nodoId: "respaldo", ahora: tiempo });
  assert.throws(() => verificar({ ...datos, cabeceras: falsos }), /firma LAN/);
});

test("un error después del rename no reutiliza el estado anterior y el reinicio recupera el commit durable", (t) => {
  const { config, abrir, avanzar } = preparar(t); const a = abrir(); avanzar(CUARENTENA_MS);
  const { termino } = a.solicitar({ nodoId: "principal", revision: R0 });
  const renombrar = fs.renameSync, sincronizar = fs.fsyncSync;
  let reemplazado = false;
  t.mock.method(fs, "renameSync", (desde, hasta) => { const r = renombrar(desde, hasta); if (String(hasta).endsWith("testigo-estado.json")) reemplazado = true; return r; });
  t.mock.method(fs, "fsyncSync", (fd) => { if (reemplazado) throw Object.assign(new Error("Confirmación de disco incierta"), { code: "EIO" }); return sincronizar(fd); });
  assert.throws(() => a.confirmar({ nodoId: "principal", termino, ...R1, replicas: [copia(config, termino, R1)] }), /disco incierta/);
  t.mock.restoreAll();
  assert.equal(a.solicitar({ nodoId: "respaldo", revision: R0 }).autorizado, false);
  assert.equal(a.estado().estado.bloqueado, true); a.cerrar();
  const nuevo = abrir(); assert.deepEqual(nuevo.estado().estado.ultimo, R1); avanzar(CUARENTENA_MS);
  assert.equal(nuevo.solicitar({ nodoId: "respaldo", revision: R0 }).autorizado, false);
  assert.equal(nuevo.solicitar({ nodoId: "respaldo", revision: R1 }).autorizado, true);
});

test("agrega miembros sin invalidar lease ni término, protege escritor/preferido y conserva altas tras reiniciar", (t) => {
  const { config, abrir, avanzar, reloj } = preparar(t); const a = abrir(); avanzar(CUARENTENA_MS);
  const p = a.solicitar({ nodoId: "principal", revision: R0 });
  const tercero = { id: "respaldo2", nombre: "Tercer equipo", url: "http://respaldo2:8080", clave: "credencial-propia-del-tercer-equipo" };
  const datos = { grupoId: config.grupoId, nodoId: tercero.id, metodo: "POST", ruta: "/lan/testigo/solicitar", cuerpo: "{}", clave: tercero.clave, ahora: reloj.wall };
  const cabeceras = firmarPeticion(datos);
  assert.throws(() => a.autenticarPeticion({ ...datos, cabeceras }), /no está autenticada/);
  const publica = a.actualizarMiembros([...config.miembros, tercero]);
  assert.equal(publica.miembros.length, 3); assert.equal(JSON.stringify(publica).includes(tercero.clave), false);
  assert.equal(publica.revisionMiembros, 2); assert.equal(a.estado().estado.revision_miembros, 2);
  assert.deepEqual(a.autenticarPeticion({ ...datos, cabeceras }), { nodoId: tercero.id });
  const nuevoAck = firmarAckReplica({ grupoId: config.grupoId, nodoId: tercero.id, escritorId: "principal", termino: p.termino, ...R1 }, tercero.clave);
  assert.equal(a.confirmar({ nodoId: "principal", termino: p.termino, ...R1, replicas: [nuevoAck] }).confirmado, true);
  assert.equal(a.renovar({ nodoId: "principal", termino: p.termino, revision: R1 }).autorizado, true);
  assert.throws(() => a.actualizarMiembros([config.miembros[1], tercero]), /escritor actual ni al equipo preferido/);
  assert.throws(() => a.actualizarMiembros(config.miembros.map((m) => ({ ...m, clave: m.clave + "rotada" }))), /No se rotan/);
  a.cerrar(); const reiniciado = abrir();
  assert.equal(reiniciado.configuracionPublica().miembros.length, 3, "la config inicial antigua no borra el alta durable");
  assert.equal(reiniciado.estado().estado.revision_miembros, 2);
  assert.equal(reiniciado.estado().estado.termino, p.termino);
  assert.deepEqual(reiniciado.estado().estado.ultimo, R1);
});

test("modo degradado requiere política explícita y una copia atrasada no puede volver; ack de recuperación restablece redundancia", (t) => {
  const { config, abrir, avanzar } = preparar(t);
  let a = abrir(); avanzar(CUARENTENA_MS); let p = a.solicitar({ nodoId: "principal", revision: R0 });
  assert.throws(() => a.confirmar({ nodoId: "principal", termino: p.termino, ...R1, replicas: [], modoDegradado: true }), /copia durable/);
  a.cerrar();
  // Una instalación distinta habilita la política explícitamente al crear grupo.
  const otroBase = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-testigo-degradado-"));
  t.after(() => { a.cerrar(); fs.rmSync(otroBase, { recursive: true, force: true }); });
  a = abrir({ base: otroBase, config: { ...config, permitirDegradado: true } }); avanzar(CUARENTENA_MS);
  p = a.solicitar({ nodoId: "respaldo", revision: R0 });
  const r = a.confirmar({ nodoId: "respaldo", termino: p.termino, ...R1, replicas: [], modoDegradado: true });
  assert.equal(r.degradado, true); assert.equal(a.estado().estado.degradado, true);
  assert.deepEqual(a.estado().estado.ultimo_commit.replicas, []);
  assert.equal(a.solicitar({ nodoId: "principal", revision: R0 }).drenar, false);
  const ack = copia(config, p.termino, R1, "respaldo", "principal");
  const recuperado = a.confirmar({ nodoId: "respaldo", termino: p.termino, ...R1, replicas: [ack] });
  assert.equal(recuperado.degradado, false); assert.equal(a.estado().estado.ultimo.indice, 1);
  assert.equal(a.solicitar({ nodoId: "principal", revision: R1 }).drenar, true);
  a.liberar({ nodoId: "respaldo", termino: p.termino });
  assert.equal(a.solicitar({ nodoId: "principal", revision: R1 }).autorizado, true);
});

test("bootstrap puede fijar la copia final de índice cero sólo antes del primer grant y lo conserva al reiniciar", (t) => {
  const { config, abrir, avanzar } = preparar(t);
  const inicial = { indice: 0, sha256: "0".repeat(64) }, final = { indice: 0, sha256: "f".repeat(64) };
  let a = abrir({ config: { ...config, revisionInicial: inicial } });
  assert.throws(() => a.inicializarRevision(R1), /índice cero/);
  assert.equal(a.inicializarRevision(final).inicializado, true);
  assert.equal(a.estado().estado.termino, 0); assert.equal(a.estado().estado.escritor, null);
  a.cerrar(); a = abrir({ config: { ...config, revisionInicial: inicial } });
  assert.deepEqual(a.estado().estado.ultimo, final);
  avanzar(CUARENTENA_MS);
  assert.equal(a.solicitar({ nodoId: "principal", revision: inicial }).autorizado, false);
  const p = a.solicitar({ nodoId: "principal", revision: final }); assert.equal(p.autorizado, true);
  assert.throws(() => a.inicializarRevision(inicial), /primer permiso/);
  a.liberar({ nodoId: "principal", termino: p.termino });
  assert.throws(() => a.inicializarRevision(inicial), /primer permiso/);
});

test("miembros preservan CA pública HTTPS firmada y no permiten rotarla silenciosamente", (t) => {
  const { config, abrir } = preparar(t);
  const ca = tls.rootCertificates.find((c) => new crypto.X509Certificate(c).ca);
  config.miembros[0] = { ...config.miembros[0], url: "https://principal:8443", caPublica: ca };
  const a = abrir();
  assert.equal(a.configuracionPublica().miembros[0].caPublica, ca);
  assert.equal(a.estado({ desafio: "consulta" }).estado.miembros[0].caPublica, ca);
  assert.throws(() => a.actualizarMiembros(config.miembros.map((m) => ({ ...m, caPublica: "no-certificado" }))), /autoridad HTTPS/);
  assert.throws(() => a.actualizarMiembros(config.miembros.map((m) => { const n = { ...m }; delete n.caPublica; return n; })), /autoridades HTTPS/);
});
