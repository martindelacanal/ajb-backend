"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { crearSqlite, asegurarEsquema, escribirMeta, leerMeta } = require("../lib/db-sqlite");
const { crearRespaldo } = require("../lib/respaldo-local");
const { crearControlEquipo } = require("../lib/control-equipo");
const api = require("../lib/api");

const CLI = path.join(__dirname, "../lib/recuperar-respaldo.js");
const CLAVE = "Recuperación segura 2026 con espacios";
function cli(datos) { return spawnSync(process.execPath, [CLI], { input: typeof datos === "string" ? datos : JSON.stringify(datos), encoding: "utf8", timeout: 15000, windowsHide: true }); }
async function preparar(t) {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-recuperar-")), origen = path.join(carpeta, "PC original á");
  fs.mkdirSync(origen); const archivoDb = path.join(origen, "datos", "predio.db");
  const db = crearSqlite(archivoDb, { predioId: 7 }); asegurarEsquema(db);
  t.after(() => { db.cerrar(); fs.rmSync(carpeta, { recursive: true, force: true }); });
  const config = { predio_id: 7, predio_codigo: "MIRAMAR", servidor: "https://central.invalid/api", token: "token-central-no-imprimir" };
  fs.writeFileSync(path.join(origen, "config.json"), JSON.stringify(config));
  escribirMeta(db, "instancia_id", "instancia-logica-original"); escribirMeta(db, "equipo_propietario_id", "pc-original"); escribirMeta(db, "escritor", "LOCAL");
  await api.ejecutar({ db, pid: 7, modo: "local", origen: "LOCAL", usuario: { id: 1, nombre: "Admin", rol: "ADMIN" }, body: { nombre: "Producto recuperable", precio_compra: 100 }, query: {}, sesion: {} }, "POST", "/productos");
  await db.run("INSERT INTO predio_peticion (operacion_id,usuario_id,peticion_sha256,fecha,status,respuesta) VALUES (?,?,?,?,?,?)",
    ["operacion-pendiente-0001", 1, "a".repeat(64), "2026-11-06 10:00:00", 200, '{"venta":42}']);
  const respaldo = await crearRespaldo({ db, base: origen, config, clave: CLAVE, version: "1.0.0-prueba" });
  const archivo = path.join(carpeta, "Mi respaldo á.ajbrespaldo"); fs.writeFileSync(archivo, respaldo.buffer);
  return { carpeta, origen, db, config, archivo, buffer: respaldo.buffer };
}

test("el CLI valida y recupera por stdin en una carpeta nueva detenida con SQL, outbox y deduplicación íntegros", async t => {
  const s = await preparar(t), destino = path.join(s.carpeta, "Copia nueva ñ");
  const validacion = cli({ accion: "validar", archivo: s.archivo, clave: CLAVE });
  assert.equal(validacion.status, 0, validacion.stderr);
  const v = JSON.parse(validacion.stdout);
  assert.equal(v.valido, true); assert.equal(v.resumen.predio, "MIRAMAR"); assert.equal(v.resumen.version, "1.0.0-prueba"); assert.ok(v.resumen.pendientes > 0);
  assert.equal(fs.existsSync(destino), false, "validar no restaura ni crea un destino");
  const recuperacion = cli({ accion: "restaurar", archivo: s.archivo, destino, clave: CLAVE, sha256Esperado: v.sha256 });
  assert.equal(recuperacion.status, 0, recuperacion.stderr);
  const r = JSON.parse(recuperacion.stdout); assert.equal(r.modo, "STANDBY"); assert.equal(r.activacionRequerida, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destino, "runtime.json"))), { autoarranque: false, detenido: true });
  const db = crearSqlite(path.join(destino, "datos", "predio.db"), { predioId: 7 });
  try {
    assert.equal((await db.get("SELECT nombre FROM predio_producto")).nombre, "Producto recuperable");
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_outbox")).n, v.resumen.pendientes);
    assert.equal((await db.get("SELECT respuesta FROM predio_peticion")).respuesta, '{"venta":42}');
    assert.ok(leerMeta(db, "restauracion_pendiente")); assert.equal(leerMeta(db, "equipo_propietario_id"), "pc-original");
    const control = crearControlEquipo({ db, config: s.config, equipoId: "pc-nueva" });
    assert.equal(control.puedeEscribir(), false); assert.equal(control.confirmarCentral(), false);
  } finally { db.cerrar(); }
  assert.equal(fs.existsSync(path.join(destino, "arranque.js")), false);
  assert.equal(fs.existsSync(path.join(destino, "predio-ha.json")), false);
  for (const texto of [validacion.stdout, validacion.stderr, recuperacion.stdout, recuperacion.stderr]) {
    assert.equal(texto.includes(CLAVE), false); assert.equal(texto.includes(s.config.token), false);
  }
});

test("una clave incorrecta o un archivo cambiado no crean carpeta ni alteran la instalación", async t => {
  const s = await preparar(t), destino = path.join(s.carpeta, "Nunca creada");
  const incorrecta = cli({ accion: "validar", archivo: s.archivo, clave: "La clave incorrecta secreta" });
  assert.equal(incorrecta.status, 1); assert.equal(incorrecta.stderr.includes("La clave incorrecta secreta"), false);
  const v = JSON.parse(cli({ accion: "validar", archivo: s.archivo, clave: CLAVE }).stdout);
  const alterado = Buffer.from(s.buffer); alterado[alterado.length - 1] ^= 1; fs.writeFileSync(s.archivo, alterado);
  const cambiado = cli({ accion: "restaurar", archivo: s.archivo, destino, clave: CLAVE, sha256Esperado: v.sha256 });
  assert.equal(cambiado.status, 1); assert.match(cambiado.stderr, /cambió después de validarlo/);
  assert.equal(fs.existsSync(destino), false); assert.equal(leerMeta(s.db, "restauracion_pendiente"), null);
});

test("no reemplaza un destino existente y exige validar antes de recuperar", async t => {
  const s = await preparar(t), destino = path.join(s.carpeta, "Existente"); fs.mkdirSync(destino); fs.writeFileSync(path.join(destino, "conservar.txt"), "intacto");
  const v = JSON.parse(cli({ accion: "validar", archivo: s.archivo, clave: CLAVE }).stdout);
  assert.equal(cli({ accion: "restaurar", archivo: s.archivo, destino, clave: CLAVE }).status, 1);
  const r = cli({ accion: "restaurar", archivo: s.archivo, destino, clave: CLAVE, sha256Esperado: v.sha256 });
  assert.equal(r.status, 1); assert.match(r.stderr, /ya existe/); assert.equal(fs.readFileSync(path.join(destino, "conservar.txt"), "utf8"), "intacto");
});

test("stdin inválido no expone fragmentos con la clave", () => {
  const r = cli('{"clave":"secreto-que-no-debe-aparecer",JSON roto');
  assert.equal(r.status, 1); assert.match(r.stderr, /No se pudieron leer/); assert.equal(r.stderr.includes("secreto-que-no-debe-aparecer"), false);
});

test("un respaldo actual requiere la tabla local de idempotencia", async t => {
  const s = await preparar(t); s.db.exec("DROP TABLE predio_peticion");
  await assert.rejects(crearRespaldo({ db: s.db, base: s.origen, config: s.config, clave: CLAVE }), /tabla local predio_peticion/);
});

test("el asistente se analiza en Windows PowerShell 5.1 sin ejecutar instalación", { skip: process.platform !== "win32" }, () => {
  const codigo = `$ProgressPreference='SilentlyContinue';$tokens=$null;$errores=$null;[Management.Automation.Language.Parser]::ParseFile($env:AJB_RECUPERAR_PS,[ref]$tokens,[ref]$errores)|Out-Null;if($errores.Count){throw($errores|Out-String)};Write-Output 'AST_OK'`;
  const salida = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(codigo, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, AJB_RECUPERAR_PS: path.join(__dirname, "../windows/recuperar-respaldo.ps1") },
  });
  assert.equal(salida.trim(), "AST_OK");
});
