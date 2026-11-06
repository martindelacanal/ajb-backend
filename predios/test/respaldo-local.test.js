"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { crearSqlite, asegurarEsquema, escribirMeta, leerMeta } = require("../lib/db-sqlite");
const N = require("../lib/negocio");
const { crearRespaldo, validarRespaldo, restaurarRespaldo } = require("../lib/respaldo-local");

const CLAVE = "Cuatro palabras de recuperación 2026";

async function preparar(t) {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-test-respaldo-"));
  const base = path.join(carpeta, "original");
  fs.mkdirSync(base);
  const config = { predio_id: 7, predio_codigo: "MIRAMAR", servidor: "https://api.example.test/api", token: "token-secreto-que-no-debe-estar-en-texto", clave_lan: "clave-LAN-secreta-de-la-instalación", clave_publica: "clave-de-verificacion", puerto: 8080 };
  fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ ...config, opcion_local: "conservar" }));
  fs.mkdirSync(path.join(base, "datos", "tls"), { recursive: true });
  fs.writeFileSync(path.join(base, "datos", "tls", "config.json"), JSON.stringify({ passphrase: "passphrase-del-PFX", puerto: 8443 }));
  fs.writeFileSync(path.join(base, "datos", "tls", "servidor.pfx"), Buffer.from([1, 2, 3, 4]));
  fs.mkdirSync(path.join(base, "datos", "galeria"), { recursive: true });
  fs.writeFileSync(path.join(base, "datos", "galeria", "foto.webp"), "imagen-local");
  fs.mkdirSync(path.join(base, "app", "versiones", "vieja"), { recursive: true });
  fs.writeFileSync(path.join(base, "app", "versiones", "vieja", "servidor.js"), "NO RESTAURAR CÓDIGO VIEJO");
  const db = crearSqlite(path.join(base, "datos", "predio.db"), { predioId: 7 });
  const conexiones = [db];
  t.after(() => { conexiones.forEach((c) => c.cerrar()); fs.rmSync(carpeta, { recursive: true, force: true }); });
  asegurarEsquema(db);
  const ctx = { db, pid: 7, usuario: { id: 1, nombre: "Admin", rol: "ADMIN" }, origen: "LOCAL" };
  await db.tx(async (tr) => {
    await N.insertar(tr, ctx, "predio_usuario", { usuario: "admin", nombre: "Admin", rol: "ADMIN", password_hash: "hash-privado", activo: 1 });
    await N.insertar(tr, ctx, "predio_boca", { nombre: "Proveeduría", activo: 1 });
    await N.insertar(tr, ctx, "predio_producto", { nombre: "Producto sin sincronizar", destino: "VENTA_DIRECTA", stock_minimo: 0, activo: 1 });
    await tr.run("INSERT INTO predio_sesion (token_hash, usuario_id, creada, boca_id, caja_id) VALUES (?, 1, '2026-11-06 12:00:00', 1, 2)", ["sesion-local"]);
    await tr.run("INSERT INTO predio_admin_cache (documento, hash, nombre, general_id) VALUES ('30111222', 'hash-offline', 'Admin general', 99)");
    await tr.run("INSERT INTO predio_comando_ejecutado (comando_id, fecha, ok, status, respuesta) VALUES (81, '2026-11-06 12:00:00', 1, 200, '{}')");
  });
  for (const [k, v] of Object.entries({ instancia_id: "instancia-original", equipo_propietario_id: "equipo-original", control_confirmado: "equipo-original", control_conflicto: "", escritor: "LOCAL", outbox_cursor: "1", ultima_subida: "2026-11-06 09:00:00" })) escribirMeta(db, k, v);
  const crear = (extra = {}) => crearRespaldo({ db, base, config, clave: CLAVE, version: "1.0+actual", ...extra });
  return { carpeta, base, config, db, ctx, crear, registrar: (c) => { conexiones.push(c); return c; } };
}

// Genera un archivo autenticado pero malformado, como podría hacerlo alguien que
// conoce la clave. La autenticidad no debe permitir rutas arbitrarias ni omitir DB.
function modificarRespaldo(buffer, cambiar) {
  const sal = buffer.subarray(8, 24), iv = buffer.subarray(24, 36);
  const llave = crypto.scryptSync(CLAVE, sal, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = crypto.createDecipheriv("aes-256-gcm", llave, iv);
  d.setAAD(buffer.subarray(0, 36)); d.setAuthTag(buffer.subarray(36, 52));
  const datos = JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buffer.subarray(52)), d.final()])).toString());
  cambiar(datos);
  const c = crypto.createCipheriv("aes-256-gcm", llave, iv);
  c.setAAD(buffer.subarray(0, 36));
  const texto = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(datos)))), c.final()]);
  return Buffer.concat([buffer.subarray(0, 36), c.getAuthTag(), texto]);
}

test("respaldo completo protege secretos y restaura exactamente identidad, datos locales y outbox pendiente en standby", async (t) => {
  const { crear, carpeta, db, base, config, registrar } = await preparar(t);
  const cola = await db.all("SELECT * FROM predio_outbox ORDER BY seq");
  const secuencias = await db.all("SELECT * FROM predio_secuencia ORDER BY tabla");
  const { buffer, nombre, manifest } = await crear();
  assert.ok(nombre.endsWith(".ajbrespaldo"));
  assert.equal(buffer.includes(Buffer.from(config.token)), false);
  assert.equal(buffer.includes(Buffer.from("hash-offline")), false);
  assert.equal(manifest.pendientes.cantidad, 2);
  const resumen = validarRespaldo(buffer, { clave: CLAVE, predioId: 7 });
  assert.equal(resumen.identidad.instancia_id, "instancia-original");
  assert.equal(resumen.modo_recuperacion, "STANDBY");
  const destino = path.join(carpeta, "recuperada");
  const recuperacion = restaurarRespaldo(buffer, { destino, clave: CLAVE, predioId: 7 });
  assert.equal(recuperacion.activacion_requerida, true);
  const nueva = registrar(crearSqlite(recuperacion.archivo_base, { predioId: 7 }));
  assert.deepEqual(await nueva.all("SELECT * FROM predio_outbox ORDER BY seq"), cola);
  assert.deepEqual(await nueva.all("SELECT * FROM predio_secuencia ORDER BY tabla"), secuencias);
  for (const [clave, valor] of Object.entries(manifest.identidad)) assert.equal(leerMeta(nueva, clave), valor);
  assert.equal((await nueva.get("SELECT nombre FROM predio_producto WHERE id = 1")).nombre, "Producto sin sincronizar");
  assert.equal((await nueva.get("SELECT hash FROM predio_admin_cache")).hash, "hash-offline");
  assert.equal((await nueva.get("SELECT token_hash FROM predio_sesion")).token_hash, "sesion-local");
  assert.equal((await nueva.get("SELECT comando_id FROM predio_comando_ejecutado")).comando_id, 81);
  const marca = JSON.parse(leerMeta(nueva, "restauracion_pendiente"));
  assert.equal(marca.modo, "STANDBY");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destino, "runtime.json"))), { autoarranque: false, detenido: true });
  const restauradaConfig = JSON.parse(fs.readFileSync(path.join(destino, "config.json")));
  assert.equal(restauradaConfig.token, config.token);
  assert.equal(restauradaConfig.opcion_local, "conservar");
  assert.equal(fs.readFileSync(path.join(destino, "datos", "galeria", "foto.webp"), "utf8"), "imagen-local");
  assert.equal(fs.existsSync(path.join(destino, "app")), false);
  assert.equal(leerMeta(db, "restauracion_pendiente"), null, "no se marca ni modifica la instalación viva");
  assert.equal(fs.existsSync(path.join(base, "runtime.json")), false);
});

test("espera la transacción activa y toma un snapshot consistente que incluye sus escrituras WAL confirmadas", async (t) => {
  const { crear, db, ctx, carpeta, registrar } = await preparar(t);
  let liberar, iniciada;
  const espera = new Promise((resolve) => { liberar = resolve; });
  const principio = new Promise((resolve) => { iniciada = resolve; });
  const transaccion = db.tx(async (tr) => {
    await N.insertar(tr, ctx, "predio_producto", { nombre: "Primero", destino: "VENTA_DIRECTA", activo: 1 });
    iniciada(); await espera;
    await N.insertar(tr, ctx, "predio_producto", { nombre: "Segundo", destino: "VENTA_DIRECTA", activo: 1 });
  });
  await principio;
  let terminado = false;
  const respaldo = crear().then((r) => { terminado = true; return r; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminado, false);
  liberar(); await transaccion;
  const { buffer } = await respaldo;
  const r = restaurarRespaldo(buffer, { destino: path.join(carpeta, "wal"), clave: CLAVE });
  const nueva = registrar(crearSqlite(r.archivo_base, { predioId: 7 }));
  assert.deepEqual((await nueva.all("SELECT nombre FROM predio_producto ORDER BY id")).map((p) => p.nombre), ["Producto sin sincronizar", "Primero", "Segundo"]);
});

test("rechaza clave incorrecta, corrupción, otro predio y límites sin crear destinos ni tocar la base viva", async (t) => {
  const { crear, carpeta, db } = await preparar(t);
  const { buffer } = await crear();
  assert.throws(() => validarRespaldo(buffer, { clave: "Esta clave es incorrecta" }), /clave es incorrecta/);
  const alterado = Buffer.from(buffer); alterado[alterado.length - 1] ^= 1;
  assert.throws(() => validarRespaldo(alterado, { clave: CLAVE }), /alterado/);
  assert.throws(() => validarRespaldo(buffer, { clave: CLAVE, predioId: 8 }), /otro predio/);
  assert.throws(() => validarRespaldo(buffer, { clave: CLAVE, maxBytes: 100 }), /límite/);
  assert.throws(() => validarRespaldo(buffer, { clave: CLAVE, maxDescomprimido: 100 }), /límite/);
  const destino = path.join(carpeta, "no-crear");
  assert.throws(() => restaurarRespaldo(alterado, { destino, clave: CLAVE }), /alterado/);
  assert.equal(fs.existsSync(destino), false);
  assert.equal(leerMeta(db, "equipo_propietario_id"), "equipo-original");
  assert.deepEqual(fs.readdirSync(carpeta), ["original"]);
});

test("la restauración nunca reemplaza una instalación ni una carpeta ya existente", async (t) => {
  const { crear, carpeta, base, db } = await preparar(t);
  const { buffer } = await crear();
  const vacia = path.join(carpeta, "existente"); fs.mkdirSync(vacia);
  for (const destino of [base, vacia]) assert.throws(() => restaurarRespaldo(buffer, { destino, clave: CLAVE }), /ya existe/);
  assert.equal(leerMeta(db, "restauracion_pendiente"), null);
  assert.deepEqual(fs.readdirSync(vacia), []);
});

test("validar autenticidad no habilita traversal, código ejecutable, rutas repetidas ni omisión de archivos esenciales", async (t) => {
  const { crear } = await preparar(t);
  const { buffer } = await crear();
  for (const ruta of ["../config.json", "datos/tls/../../fuera.txt", "C:/fuera.txt", "datos/tls/nombre:ads", "datos/tls/CON.txt", "app/versiones/vieja/servidor.js"]) {
    const mal = modificarRespaldo(buffer, (d) => { d.archivos[0].ruta = ruta; });
    assert.throws(() => validarRespaldo(mal, { clave: CLAVE }), /rutas no válidos/);
  }
  const duplicado = modificarRespaldo(buffer, (d) => { d.archivos.push({ ...d.archivos[0] }); d.manifest.archivos++; });
  assert.throws(() => validarRespaldo(duplicado, { clave: CLAVE }), /rutas no válidos/);
  const incompleto = modificarRespaldo(buffer, (d) => { d.archivos = d.archivos.filter((a) => a.ruta !== "datos/predio.db"); d.manifest.archivos--; });
  assert.throws(() => validarRespaldo(incompleto, { clave: CLAVE }), /incompleto/);
});

test("valida integridad SQLite y la identidad y cola declaradas por el manifiesto", async (t) => {
  const { crear } = await preparar(t);
  const { buffer } = await crear();
  const identidadFalsa = modificarRespaldo(buffer, (d) => { d.manifest.identidad.instancia_id = "otra-instancia"; });
  assert.throws(() => validarRespaldo(identidadFalsa, { clave: CLAVE }), /identidad o la cola/);
  const colaFalsa = modificarRespaldo(buffer, (d) => { d.manifest.pendientes.cantidad = 0; });
  assert.throws(() => validarRespaldo(colaFalsa, { clave: CLAVE }), /identidad o la cola/);
  const sqliteFalso = modificarRespaldo(buffer, (d) => {
    const a = d.archivos.find((f) => f.ruta === "datos/predio.db");
    const texto = Buffer.from("Esto no es SQLite");
    a.bytes = texto.length; a.contenido = texto.toString("base64"); a.sha256 = crypto.createHash("sha256").update(texto).digest("hex");
  });
  assert.throws(() => validarRespaldo(sqliteFalso, { clave: CLAVE }), /SQLite local válido/);
});

test("exige clave de recuperación y nunca empaqueta como respaldo una réplica central", async (t) => {
  const { crear, base, config } = await preparar(t);
  await assert.rejects(crear({ clave: "" }), /clave de recuperación/);
  await assert.rejects(crearRespaldo({ db: { dialecto: "mysql" }, base, config, clave: CLAVE }), /SQLite local/);
});
