"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { once } = require("node:events");
const { crearSqlite, asegurarEsquema, escribirMeta, leerMeta } = require("../lib/db-sqlite");
const { crearAgente } = require("../lib/agente");
const { generarPar, firmar } = require("../lib/firma");

async function preparar(t, { escritor = true, restauracion = false, pruebaHa, codigo, clavePublica, automaticas = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "predio-agente-ha-"));
  const db = crearSqlite(path.join(base, "predio.db"), { predioId: 1 }); asegurarEsquema(db);
  escribirMeta(db, "instancia_id", "linaje-del-principal-original");
  if (restauracion) escribirMeta(db, "restauracion_pendiente", "1");
  const recibidas = [], logs = [], grupo = { habilitado: true, escritor };
  let pruebas = 0;
  const servidor = http.createServer(async (req, res) => {
    const partes = []; for await (const p of req) partes.push(p);
    const buffer = Buffer.concat(partes), r = { ruta: req.url, metodo: req.method, cabeceras: req.headers, cuerpo: buffer.length ? JSON.parse(buffer.toString()) : null };
    recibidas.push(r);
    if (req.url === "/predios-sync/codigo" && codigo) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(codigo.buffer); }
    let respuesta = {};
    if (req.url === "/predios-sync/hola") respuesta = { escritor: "LOCAL", autoriza_escritura: true };
    else if (req.url === "/predios-sync/comandos") respuesta = { comandos: [] };
    else if (req.url === "/predios-sync/version") respuesta = codigo ? { version: codigo.version, sha256: crypto.createHash("sha256").update(codigo.buffer).digest("hex"), firma: codigo.firma } : { version: "test" };
    else if (req.url === "/predios-sync/push") respuesta = { aceptados: 1 };
    else if (req.url === "/predios-sync/maestros") respuesta = { departamentales: [], afiliados: [] };
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(respuesta));
  });
  servidor.listen(0, "127.0.0.1"); await once(servidor, "listening");
  const agente = crearAgente({ base, db, config: { predio_id: 1, predio_codigo: "CAMPING", servidor: `http://127.0.0.1:${servidor.address().port}`, token: "token-grupo", clave_publica: clavePublica, actualizaciones_automaticas: automaticas }, version: "test",
    log: m => logs.push(m), api: { ejecutarRemoto() { throw new Error("No hay órdenes de prueba"); } }, grupoLocal: () => grupo,
    controlEquipo: { equipoId: "b".repeat(64), confirmarCentral() {}, puedeEscribir: () => true },
    pruebaHa: async () => { pruebas++; return pruebaHa ? pruebaHa({ grupo, numero: pruebas }) : "prueba-nueva-" + pruebas; } });
  t.after(async () => { agente.detener(); servidor.closeAllConnections?.(); await new Promise(resolve => servidor.close(resolve)); db.cerrar(); fs.rmSync(base, { recursive: true, force: true }); });
  return { agente, db, base, grupo, recibidas, logs, pruebas: () => pruebas };
}

test("un respaldo en espera consulta versiones sin sincronizar negocio ni cargar datos iniciales del instalador", async t => {
  const s = await preparar(t, { escritor: false });
  fs.writeFileSync(path.join(s.base, "datos-iniciales.json.gz"), "contenido que no debe abrirse en un respaldo");
  const inicial = s.db.conexion.prepare("SELECT * FROM predio_meta ORDER BY clave").all();
  s.agente.iniciar();
  await assert.rejects(s.agente.sincronizarAhora(), /en espera/);
  assert.deepEqual(s.recibidas.map(r => r.ruta), ["/predios-sync/version"]);
  assert.equal(s.pruebas(), 0);
  assert.deepEqual(s.db.conexion.prepare("SELECT * FROM predio_meta ORDER BY clave").all(), inicial);
  assert.deepEqual(s.logs, []);
  assert.equal(leerMeta(s.db, "bootstrap"), null);
});

test("el escritor restaurado pendiente sólo puede consultar código aunque conserve token e instancia originales", async t => {
  const s = await preparar(t, { restauracion: true });
  await assert.rejects(s.agente.sincronizarAhora(), /en espera/);
  await assert.rejects(s.agente.verificarAdminGeneral("123", "clave"), /en espera/);
  assert.deepEqual(s.recibidas.map(r => r.ruta), ["/predios-sync/version"]);
  assert.equal(s.pruebas(), 0);
});

test("cada petición central del nuevo escritor lleva prueba fresca, instancia lógica original y equipo físico actual", async t => {
  const s = await preparar(t);
  await s.db.run("INSERT INTO predio_config(predio_id,id,clave,valor) VALUES(1,1,'venta_pendiente','202')");
  await s.agente.sincronizarAhora();
  const protegidas = s.recibidas.filter(r => r.ruta !== "/predios-sync/version");
  assert.ok(protegidas.length >= 4);
  assert.equal(s.pruebas(), protegidas.length);
  assert.equal(new Set(protegidas.map(r => r.cabeceras["x-predio-ha"])).size, protegidas.length);
  for (const r of protegidas) {
    assert.equal(r.cabeceras.authorization, "Bearer token-grupo");
    assert.equal(r.cabeceras["x-predio-instancia"], "linaje-del-principal-original");
    assert.equal(r.cabeceras["x-predio-equipo"], "b".repeat(64));
  }
  const push = protegidas.find(r => r.ruta === "/predios-sync/push");
  assert.ok(push.cuerpo.cambios.some(c => c.tabla === "predio_config" && c.datos.valor === "202"));
  assert.equal(push.cuerpo.instancia_id, "linaje-del-principal-original");
  assert.equal(push.cuerpo.equipo_id, "b".repeat(64));
  assert.equal((await s.db.get("SELECT COUNT(*) n FROM predio_outbox")).n, 0);
  assert.ok(Number(leerMeta(s.db, "outbox_cursor")) >= 1);
  assert.equal(s.recibidas.find(r => r.ruta === "/predios-sync/version").cabeceras["x-predio-ha"], undefined);
  assert.equal(s.recibidas.some(r => r.ruta.startsWith("/predios-sync/snapshot")), false);
});

test("si se pierde el permiso mientras se obtiene la prueba no se envía la petición central", async t => {
  const s = await preparar(t, { pruebaHa: async ({ grupo }) => { grupo.escritor = false; return "prueba-obtenida-antes-del-relevo"; } });
  await assert.rejects(s.agente.verificarAdminGeneral("123", "clave"), { status: 503 });
  assert.equal(s.recibidas.length, 0);
});

test("una consulta al testigo fallida nunca continúa usando una prueba anterior", async t => {
  const s = await preparar(t, { pruebaHa: async ({ numero }) => { if (numero > 1) throw new Error("Testigo sin conexión"); return "prueba-única"; } });
  await s.agente.verificarAdminGeneral("123", "clave");
  await assert.rejects(s.agente.verificarAdminGeneral("123", "clave"), /Testigo sin conexión/);
  assert.equal(s.recibidas.length, 1);
});

function paqueteCodigo({ esquema = fs.readFileSync(require.resolve("../lib/esquema"), "utf8"), modelo = fs.readFileSync(require.resolve("../lib/respaldo-lan"), "utf8"), lan = true } = {}) {
  const archivos = [{ ruta: "servidor.js", contenido: Buffer.from("// servidor firmado de fixture").toString("base64") },
    { ruta: "lib/esquema.js", contenido: Buffer.from(esquema).toString("base64") }];
  if (lan) archivos.push({ ruta: "lib/servicio-lan.js", contenido: Buffer.from("// adaptador HA de fixture").toString("base64") });
  if (modelo) archivos.push({ ruta: "lib/respaldo-lan.js", contenido: Buffer.from(modelo).toString("base64") });
  return { version: "test-actualizado", buffer: zlib.gzipSync(JSON.stringify({ tipo: "predio-codigo", version: "test-actualizado", archivos })) };
}

test("un respaldo instala código firmado del mismo esquema sin anunciar control ni consumir órdenes", async t => {
  const claves = generarPar(), codigo = paqueteCodigo({ esquema: fs.readFileSync(require.resolve("../lib/esquema"), "utf8").replace(/\r?\n/g, "\r\n") });
  codigo.firma = firmar(codigo.buffer, claves.privada);
  const s = await preparar(t, { escritor: false, codigo, clavePublica: claves.publica });
  await assert.rejects(s.agente.sincronizarAhora(), { status: 503 });
  assert.deepEqual(s.recibidas.map(r => r.ruta), ["/predios-sync/version", "/predios-sync/codigo"]);
  assert.ok(s.recibidas.every(r => !r.cabeceras["x-predio-ha"]));
  assert.equal(s.pruebas(), 0);
  assert.equal(fs.readFileSync(path.join(s.base, "app", "PENDIENTE"), "utf8"), codigo.version);
  assert.equal(fs.existsSync(path.join(s.base, "app", "versiones", codigo.version, "lib", "servicio-lan.js")), true);
});

test("una actualización HA no acepta código previo, cambios de esquema o de formato de recuperación y conserva la versión actual", async t => {
  const s = await preparar(t);
  const modeloDistinto = fs.readFileSync(require.resolve("../lib/respaldo-lan"), "utf8").replace(/\bAJB_LAN_MODELO_\d+\b/g, "AJB_LAN_MODELO_999");
  for (const codigo of [paqueteCodigo({ lan: false }), paqueteCodigo({ esquema: "// otro esquema" }), paqueteCodigo({ modelo: null }), paqueteCodigo({ modelo: modeloDistinto })]) {
    assert.throws(() => s.agente.instalarActualizacion(codigo.buffer), { status: 409 });
    assert.equal(fs.existsSync(path.join(s.base, "app", "PENDIENTE")), false);
    assert.equal(fs.existsSync(path.join(s.base, "app", "versiones")), false, "no escribe una versión rechazada parcialmente");
  }
  assert.equal(s.agente.instalarActualizacion(paqueteCodigo().buffer).actualizado, true, "un cambio compatible de interfaz/API sí se instala");
});

test("desactivar actualizaciones automáticas en un respaldo no descarga código ni habilita sincronización", async t => {
  const claves = generarPar(), codigo = paqueteCodigo(); codigo.firma = firmar(codigo.buffer, claves.privada);
  const s = await preparar(t, { escritor: false, codigo, clavePublica: claves.publica, automaticas: false });
  await assert.rejects(s.agente.sincronizarAhora(), { status: 503 });
  assert.deepEqual(s.recibidas.map(r => r.ruta), ["/predios-sync/version"]);
  assert.equal(fs.existsSync(path.join(s.base, "app", "PENDIENTE")), false);
  assert.equal(s.grupo.escritor, false);
  assert.equal(s.pruebas(), 0);
});
