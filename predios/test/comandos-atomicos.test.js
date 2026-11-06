"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const zlib = require("node:zlib");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { crearAgente } = require("../lib/agente");
const { generarPar, firmar } = require("../lib/firma");
const api = require("../lib/api");
const U = require("../lib/util");

const orden = { id: 801, tipo: "API", metodo: "POST", ruta: "/productos", cuerpo: { nombre: "Producto remoto", precio_compra: 100, margen: 50 } };
function paquete(claves, comandos = [orden]) {
  const contenido = JSON.stringify({ tipo: "predio-paquete", predio_id: 1, comandos });
  return zlib.gzipSync(Buffer.from(JSON.stringify({ tipo: "predio-paquete-firmado", contenido, firma: firmar(contenido, claves.privada) })));
}
function ctx(db) {
  return { db, pid: 1, modo: "local", origen: "REMOTO", usuario: { id: 1, nombre: "Admin remoto", rol: "ADMIN", bocas: [] }, sesion: {} };
}
async function aplicar(c) {
  return api.ejecutar({ ...ctx(c.db), body: c.cuerpo, query: c.query || {} }, c.metodo, c.ruta);
}
function agente(db, claves, ejecutarRemoto = aplicar) {
  return crearAgente({ db, config: { predio_id: 1, clave_publica: claves.publica }, base: "", version: "test", log: () => {}, api: { ejecutarRemoto } });
}
function base(t) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  return db;
}
async function cuenta(db, tabla) { return (await db.get(`SELECT COUNT(*) AS n FROM ${tabla}`)).n; }

test("un fallo al guardar la deduplicación revierte negocio, auditoría y outbox; reintentar aplica una sola vez", async t => {
  const db = base(t), claves = generarPar();
  let fallar = true, llamadas = 0;
  const txOriginal = db.tx.bind(db);
  db.tx = trabajo => txOriginal(async t => {
    const envuelto = {
      ...t,
      run: async (sql, params) => {
        if (fallar && /^INSERT INTO predio_comando_ejecutado/.test(sql)) throw new Error("Fallo simulado al guardar el resultado");
        return t.run(sql, params);
      },
      tx: otro => otro(envuelto),
    };
    return trabajo(envuelto);
  });
  const a = agente(db, claves, async c => { llamadas++; return aplicar(c); });
  const p = paquete(claves);
  await assert.rejects(a.importarPaquete(p), /Fallo simulado/);
  for (const tabla of ["predio_producto", "predio_auditoria", "predio_outbox", "predio_comando_ejecutado", "predio_secuencia"]) {
    assert.equal(await cuenta(db, tabla), 0, tabla);
  }
  fallar = false;
  assert.equal((await a.importarPaquete(p)).errores, 0);
  assert.equal((await a.importarPaquete(p)).errores, 0);
  assert.equal(llamadas, 2);
  assert.equal(await cuenta(db, "predio_producto"), 1);
  assert.equal(await cuenta(db, "predio_auditoria"), 1);
  assert.equal(await cuenta(db, "predio_comando_ejecutado"), 1);
});

test("el error de una API anidada revierte sus escrituras antes de conservar el resultado fallido", async t => {
  const db = base(t), claves = generarPar();
  let llamadas = 0;
  const a = agente(db, claves, async c => {
    llamadas++;
    await aplicar(c);
    throw U.error("La validación final rechazó la orden", 409);
  });
  const p = paquete(claves);
  assert.equal((await a.importarPaquete(p)).errores, 1);
  assert.equal((await a.importarPaquete(p)).errores, 1);
  assert.equal(llamadas, 1);
  for (const tabla of ["predio_producto", "predio_auditoria", "predio_outbox", "predio_secuencia"]) assert.equal(await cuenta(db, tabla), 0, tabla);
  const resultado = await db.get("SELECT * FROM predio_comando_ejecutado WHERE comando_id = ?", [orden.id]);
  assert.equal(resultado.ok, 0);
  assert.equal(resultado.status, 409);
  assert.equal(JSON.parse(resultado.respuesta).mensaje, "La validación final rechazó la orden");
});

test("dos entregas concurrentes de una orden comparten la deduplicación dentro de la transacción", async t => {
  const db = base(t), claves = generarPar();
  let llamadas = 0;
  const a = agente(db, claves, async c => {
    llamadas++;
    await new Promise(resolve => setImmediate(resolve));
    return aplicar(c);
  });
  const p = paquete(claves);
  const resultados = await Promise.all([a.importarPaquete(p), a.importarPaquete(p)]);
  assert.ok(resultados.every(r => r.errores === 0));
  assert.equal(llamadas, 1);
  assert.equal(await cuenta(db, "predio_producto"), 1);
  assert.equal(await cuenta(db, "predio_comando_ejecutado"), 1);
});

test("las respuestas grandes siguen siendo JSON válido al entregar de nuevo la orden", async t => {
  const db = base(t), claves = generarPar();
  let llamadas = 0;
  const texto = "registro ".repeat(30000);
  const a = agente(db, claves, async c => { llamadas++; return { ...await aplicar(c), texto }; });
  const p = paquete(claves);
  await a.importarPaquete(p);
  await a.importarPaquete(p);
  assert.equal(llamadas, 1);
  const resultado = await db.get("SELECT respuesta FROM predio_comando_ejecutado WHERE comando_id = ?", [orden.id]);
  assert.equal(JSON.parse(resultado.respuesta).texto, texto);
});

test("reenviar todos los datos y su marca de ejecución se confirman juntos y no duplican la cola al repetir", async t => {
  const db = base(t), claves = generarPar();
  await aplicar({ ...orden, db });
  await db.run("DELETE FROM predio_outbox");
  const a = agente(db, claves);
  const p = paquete(claves, [{ id: 802, tipo: "SISTEMA", ruta: "SINCRONIZAR_TODO" }]);
  await a.importarPaquete(p);
  const pendientes = await cuenta(db, "predio_outbox");
  assert.ok(pendientes > 0);
  await a.importarPaquete(p);
  assert.equal(await cuenta(db, "predio_outbox"), pendientes);
  assert.equal(await cuenta(db, "predio_comando_ejecutado"), 1);
});

test("un proceso cortado después del negocio y antes del resultado no deja una operación sin deduplicación", async t => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "predio-comando-atomico-"));
  const archivo = path.join(carpeta, "predio.db"), archivoPaquete = path.join(carpeta, "orden.gz");
  const claves = generarPar();
  fs.writeFileSync(archivoPaquete, paquete(claves));
  let db;
  t.after(() => { db?.cerrar(); fs.rmSync(carpeta, { recursive: true, force: true }); });
  const script = `
    const { crearSqlite, asegurarEsquema } = require(${JSON.stringify(path.join(__dirname, "../lib/db-sqlite"))});
    const { crearAgente } = require(${JSON.stringify(path.join(__dirname, "../lib/agente"))});
    const api = require(${JSON.stringify(path.join(__dirname, "../lib/api"))});
    const fs = require('node:fs');
    const datos = JSON.parse(process.argv[1]);
    const db = crearSqlite(datos.archivo, { predioId: 1 }); asegurarEsquema(db);
    const a = crearAgente({ db, config: { predio_id: 1, clave_publica: datos.publica }, base: '', version: 'test', log() {}, api: {
      async ejecutarRemoto(c) {
        await api.ejecutar({ db: c.db, pid: 1, modo: 'local', origen: 'REMOTO', usuario: { id: 1, rol: 'ADMIN', nombre: 'Admin' }, sesion: {}, body: c.cuerpo, query: {} }, c.metodo, c.ruta);
        process.exit(77);
      }
    } });
    a.importarPaquete(fs.readFileSync(datos.paquete)).catch(e => { console.error(e); process.exit(78); });
  `;
  const cortado = cp.spawnSync(process.execPath, ["-e", script, JSON.stringify({ archivo, paquete: archivoPaquete, publica: claves.publica })], { encoding: "utf8", timeout: 10000 });
  assert.equal(cortado.status, 77, cortado.stderr);
  db = crearSqlite(archivo, { predioId: 1 });
  asegurarEsquema(db);
  assert.equal(await cuenta(db, "predio_producto"), 0);
  assert.equal(await cuenta(db, "predio_comando_ejecutado"), 0);
  const a = agente(db, claves);
  await a.importarPaquete(fs.readFileSync(archivoPaquete));
  await a.importarPaquete(fs.readFileSync(archivoPaquete));
  assert.equal(await cuenta(db, "predio_producto"), 1);
  assert.equal(await cuenta(db, "predio_comando_ejecutado"), 1);
});
