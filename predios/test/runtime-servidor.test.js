"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dgram = require("node:dgram");
const { EventEmitter, once } = require("node:events");
const { spawn, execFileSync } = require("node:child_process");
const { crearSqlite, asegurarEsquema, escribirMeta } = require("../lib/db-sqlite");
const { identidadEquipo, crearControlEquipo } = require("../lib/control-equipo");
const { firmarMensaje, mensajeAutentico, destinosBroadcast, prioridad, crearDescubrimiento } = require("../lib/descubrimiento");
const { leerRuntime, escribirRuntime } = require("../lib/runtime");
const N = require("../lib/negocio");
const U = require("../lib/util");

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RAIZ = path.join(__dirname, "..");

test("la identidad de Windows usa MachineGuid y distingue una copia en otra PC aunque tenga el mismo nombre", () => {
  const base = { plataforma: "win32", nombre: "CAMPING", interfaces: {} };
  const equipo = identidadEquipo({ ...base, ejecutar: () => "MachineGuid    REG_SZ    aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  const renombrado = identidadEquipo({ ...base, nombre: "OTRO-NOMBRE", ejecutar: () => "MachineGuid    REG_SZ    aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  const copia = identidadEquipo({ ...base, ejecutar: () => "MachineGuid    REG_SZ    11111111-2222-3333-4444-555555555555" });
  assert.match(equipo, /^[a-f0-9]{64}$/);
  assert.equal(equipo, renombrado);
  assert.notEqual(equipo, copia);
});

test("la activación del equipo persiste sin internet y una carpeta copiada no puede escribir ni cambiar de dueño", (t) => {
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  const config = { servidor: "https://central.example/api", token: "clave-local" };
  const original = crearControlEquipo({ db, config, equipoId: "a".repeat(64) });
  original.redComprobada();
  assert.equal(original.puedeEscribir(), false, "primera instalación necesita confirmación central");
  assert.equal(original.confirmarCentral(), true);
  assert.equal(original.puedeEscribir(), true);
  const reinicio = crearControlEquipo({ db, config, equipoId: "a".repeat(64) }); reinicio.redComprobada();
  assert.equal(reinicio.puedeEscribir(), true, "un reinicio sin internet conserva autorización");
  const copia = crearControlEquipo({ db, config, equipoId: "b".repeat(64) }); copia.redComprobada();
  assert.equal(copia.puedeEscribir(), false);
  assert.equal(copia.confirmarCentral(), false);
  assert.throws(() => copia.comprobar(), (e) => e.codigo === "SERVIDOR_SOLO_LECTURA");
  original.rechazarCentral("La administración reasignó el predio");
  const posterior = crearControlEquipo({ db, config, equipoId: "a".repeat(64) }); posterior.redComprobada();
  assert.equal(posterior.puedeEscribir(), false, "un rechazo explícito no desaparece al cortar internet");
});

test("una instalación anterior ya dueña migra al control de equipo sin exigir internet", (t) => {
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  escribirMeta(db, "escritor", "LOCAL");
  const c = crearControlEquipo({ db, config: { servidor: "https://central.example/api", token: "clave" }, equipoId: "c".repeat(64) });
  assert.equal(c.puedeEscribir(), false, "primero comprueba la red local");
  c.redComprobada();
  assert.equal(c.puedeEscribir(), true);
});

test("un respaldo restaurado sigue en espera incluso en el equipo original y no lo activa una respuesta central", (t) => {
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  const equipoId = "d".repeat(64);
  escribirMeta(db, "escritor", "LOCAL");
  escribirMeta(db, "equipo_propietario_id", equipoId);
  escribirMeta(db, "control_confirmado", equipoId);
  escribirMeta(db, "restauracion_pendiente", JSON.stringify({ modo: "STANDBY" }));
  for (const id of [equipoId, "e".repeat(64)]) {
    const control = crearControlEquipo({ db, config: {}, equipoId: id });
    control.redComprobada();
    assert.equal(control.estado().restauracion_pendiente, true);
    assert.equal(control.puedeEscribir(), false);
    assert.equal(control.puedeAnunciarEscritor(), false);
    assert.equal(control.confirmarCentral(), false);
    assert.throws(() => control.comprobar(), (e) => e.codigo === "SERVIDOR_SOLO_LECTURA");
  }
});

test("los anuncios LAN requieren firma de este predio y una PC de consulta no desplaza al servidor", () => {
  const clave = "a".repeat(64);
  const datos = { tipo: "AJB_PREDIO_SERVIDOR", codigo: "MIRAMAR", iniciado: 100, fase: "ACTIVO" };
  const firmado = firmarMensaje(datos, clave);
  assert.equal(mensajeAutentico(firmado, clave), true);
  assert.equal(mensajeAutentico({ ...firmado, iniciado: 1 }, clave), false);
  assert.equal(mensajeAutentico(firmado, "b".repeat(64)), false);
  assert.equal(mensajeAutentico(firmado, null), false);
  assert.ok(!JSON.stringify(firmado).includes(clave));
  assert.ok(prioridad({ fase: "CONSULTA", iniciado: 1 }, { fase: "ACTIVO", iniciado: 100 }) > 0);
  assert.deepEqual(destinosBroadcast({ eth: [{ family: "IPv4", internal: false, address: "192.168.12.8", netmask: "255.255.255.0" }] }), ["255.255.255.255", "192.168.12.255"]);
});

test("descubrir un servidor exige respuesta firmada al desafío reciente y descarta anuncios falsos y reproducidos", async (t) => {
  const enviados = [];
  const socket = new EventEmitter();
  socket.bind = (_puerto, _host, fn) => queueMicrotask(fn);
  socket.setBroadcast = () => {};
  socket.unref = () => {};
  socket.close = () => {};
  socket.send = (buffer, _puerto, _ip, fn) => { enviados.push(JSON.parse(buffer)); if (fn) fn(); };
  t.mock.method(dgram, "createSocket", () => socket);
  const clave = "e".repeat(64);
  const otros = [];
  const detector = crearDescubrimiento({ codigo: "MIRAMAR", equipoId: "a".repeat(64), instanciaId: "original", puertoHttp: 8080,
    clave: () => clave, alOtro: (x) => otros.push(x), alListo: () => {}, esperaMs: 25 });
  t.after(() => detector.detener());
  await esperar(1);
  const pregunta = enviados.find((x) => x.tipo === "AJB_PREDIO_DESCUBRIR");
  assert.match(pregunta.pregunta_id, /^[a-f0-9]{32}$/);
  const anuncio = { tipo: "AJB_PREDIO_SERVIDOR", codigo: "MIRAMAR", proceso_id: "b".repeat(32), puerto: 8090, iniciado: 1, fase: "ACTIVO" };
  const recibir = (datos) => socket.emit("message", Buffer.from(JSON.stringify(datos)), { address: "192.168.1.10" });
  recibir(anuncio);
  recibir(firmarMensaje({ ...anuncio, respuesta_a: "0".repeat(32) }, clave));
  recibir(firmarMensaje({ ...anuncio, respuesta_a: pregunta.pregunta_id }, "f".repeat(64)));
  await esperar(35);
  assert.equal(otros.length, 0);
  recibir(firmarMensaje({ ...anuncio, respuesta_a: pregunta.pregunta_id }, clave));
  assert.equal(otros.length, 1);
  assert.equal(otros[0].url, "http://192.168.1.10:8090");
  assert.equal(detector.descriptor().fase, "CONSULTA");
});

function baseFixture(t, limpiar = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-runtime-fixture-"));
  if (limpiar) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "app", "versiones", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ predio_id: 99, predio_codigo: `FIXTURE-${path.basename(base)}` }));
  fs.writeFileSync(path.join(base, "app", "ACTUAL"), "fixture");
  fs.writeFileSync(path.join(base, "app", "versiones", "fixture", "servidor.js"), `
    const fs=require('node:fs'),path=require('node:path'); const base=process.argv[process.argv.indexOf('--base')+1];
    fs.appendFileSync(path.join(base,'inicios.txt'),'inicio\\n'); fs.writeFileSync(path.join(base,'app','SANO'),'fixture');
    setInterval(()=>{if(fs.existsSync(path.join(base,'app','CONTROL')))process.exit(0);},30);
  `);
  return base;
}

test("el supervisor respeta inicio manual y detención persistente antes de arrancar un proceso", (t) => {
  const base = baseFixture(t);
  escribirRuntime(base, { autoarranque: false, detenido: false });
  execFileSync(process.execPath, [path.join(RAIZ, "lanzador.js"), "--base", base, "--automatico"], { timeout: 5000 });
  assert.equal(fs.existsSync(path.join(base, "inicios.txt")), false);
  escribirRuntime(base, { detenido: true });
  execFileSync(process.execPath, [path.join(RAIZ, "lanzador.js"), "--base", base], { timeout: 5000 });
  assert.deepEqual(leerRuntime(base), { autoarranque: false, detenido: true });
  assert.equal(fs.existsSync(path.join(base, "inicios.txt")), false);
});

test("el supervisor de fixture se detiene sin reabrir su hijo al recibir una detención intencional", async (t) => {
  const base = baseFixture(t);
  escribirRuntime(base, { autoarranque: false, detenido: false });
  const proceso = spawn(process.execPath, [path.join(RAIZ, "lanzador.js"), "--base", base], { stdio: "pipe", windowsHide: true });
  proceso.stdout.resume(); proceso.stderr.resume();
  const salida = once(proceso, "exit");
  t.after(() => { if (proceso.exitCode === null) proceso.kill(); });
  for (let i = 0; i < 80 && !fs.existsSync(path.join(base, "inicios.txt")); i++) await esperar(50);
  assert.equal(fs.readFileSync(path.join(base, "inicios.txt"), "utf8"), "inicio\n");
  escribirRuntime(base, { autoarranque: false, detenido: true });
  fs.writeFileSync(path.join(base, "app", "CONTROL"), JSON.stringify({ accion: "DETENER" }));
  const limite = setTimeout(() => proceso.kill(), 7000); limite.unref();
  await salida;
  clearTimeout(limite);
  assert.equal(proceso.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(base, "inicios.txt"), "utf8"), "inicio\n");
});

test("una copia de base sirve consultas pero bloquea ventas y apertura de puesto en la API HTTP", async (t) => {
  const base = baseFixture(t, false);
  const config = JSON.parse(fs.readFileSync(path.join(base, "config.json"), "utf8"));
  fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ ...config, servidor: "http://127.0.0.1:9/api", token: "fixture-sin-central" }));
  const db = crearSqlite(path.join(base, "datos", "predio.db"), { predioId: 99 }); asegurarEsquema(db);
  escribirMeta(db, "equipo_propietario_id", "f".repeat(64));
  escribirMeta(db, "control_confirmado", "f".repeat(64));
  await db.tx((tr) => N.insertar(tr, { pid: 99 }, "predio_usuario", { usuario: "admin", nombre: "Admin fixture", rol: "ADMIN", activo: 1, es_admin_general: 0, password_hash: U.hashPassword("fixture-clave") }));
  db.cerrar();
  const puerto = 26000 + Math.floor(Math.random() * 3000);
  const proceso = spawn(process.execPath, [path.join(RAIZ, "servidor.js"), "--base", base, "--puerto", String(puerto)], { stdio: "pipe", windowsHide: true });
  proceso.stdout.resume(); proceso.stderr.resume();
  const salida = once(proceso, "exit");
  t.after(async () => {
    fs.writeFileSync(path.join(base, "app", "CONTROL"), JSON.stringify({ accion: "DETENER" }));
    const limite = setTimeout(() => proceso.kill(), 5000); limite.unref();
    await salida; clearTimeout(limite);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${puerto}/api`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url + "/estado-publico")).ok) break; } catch (_e) { /* esperando el fixture */ }
    await esperar(50);
  }
  const login = await fetch(url + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: "admin", password: "fixture-clave" }) });
  assert.equal(login.status, 200);
  const token = (await login.json()).token;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const estado = await (await fetch(url + "/sistema/estado", { headers })).json();
  assert.equal(estado.escritura.autorizado, false);
  assert.match(estado.escritura.motivo, /otra PC/);
  assert.equal(estado.runtime.disponible, false, "el fixture no instala tareas ni toca confianza Windows");
  for (const ruta of ["/ventas", "/sesion/puesto", "/productos"]) {
    const r = await fetch(url + ruta, { method: "POST", headers, body: "{}" });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).codigo, "SERVIDOR_SOLO_LECTURA");
  }
});

test("control e instalador son válidos en Windows PowerShell 5.1 sin ejecutar tareas ni procesos del equipo", { skip: process.platform !== "win32" }, () => {
  const codigo = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; foreach($archivo in @('control-servidor.ps1','instalar.ps1')) { $tokens=$null; $errores=$null; [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:AJB_WINDOWS_SCRIPTS $archivo),[ref]$tokens,[ref]$errores)|Out-Null; if($errores.Count){throw($errores|Out-String)} }; Write-Output 'AST_OK'`;
  const resultado = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(codigo, "utf16le").toString("base64")], { encoding: "utf8", env: { ...process.env, AJB_WINDOWS_SCRIPTS: path.join(RAIZ, "windows") }, timeout: 10000 });
  assert.equal(resultado.trim(), "AST_OK");
});
