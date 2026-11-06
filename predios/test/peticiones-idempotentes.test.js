"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { ejecutarPeticion } = require("../lib/peticiones-idempotentes");
const api = require("../lib/api");
const U = require("../lib/util");

const peticion = { id: "operacion_test_00000001", metodo: "POST", ruta: "/productos" };
function contexto(db, cambios = {}) {
  return { db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, nombre: "Administración", rol: "ADMIN", bocas: [] },
    sesion: {}, body: { nombre: "Producto de prueba", precio_compra: 100, margen: 20 }, query: {}, ...cambios };
}
function base(t) { const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar()); return db; }
const crear = c => api.ejecutar(c, "POST", "/productos");
const cuenta = async (db, tabla) => (await db.get(`SELECT COUNT(*) AS n FROM ${tabla}`)).n;

test("perder la respuesta y repetir el mismo identificador no vuelve a ejecutar el negocio", async t => {
  const db = base(t), c = contexto(db); let llamadas = 0;
  const ejecutar = c => { llamadas++; return crear(c); };
  const primera = await ejecutarPeticion(c, peticion, ejecutar);
  const segunda = await ejecutarPeticion(c, peticion, ejecutar);
  assert.equal(llamadas, 1); assert.equal(primera.repetida, false); assert.equal(segunda.repetida, true);
  assert.deepEqual(segunda.respuesta, primera.respuesta); assert.equal(segunda.status, 200);
  assert.equal(await cuenta(db, "predio_producto"), 1); assert.equal(await cuenta(db, "predio_peticion"), 1);
});

test("la huella normaliza propiedades JSON pero rechaza colisiones de cuerpo, ruta y consulta", async t => {
  const db = base(t), c = contexto(db, { body: { nombre: "Producto", margen: 20, precio_compra: 100, extra: { b: 2, a: 1 } }, query: { b: "2", a: "1" } });
  await ejecutarPeticion(c, peticion, crear);
  const reordenada = contexto(db, { body: { precio_compra: 100, extra: { a: 1, b: 2 }, nombre: "Producto", margen: 20 }, query: { a: "1", b: "2" } });
  assert.equal((await ejecutarPeticion(reordenada, peticion, () => assert.fail("no debe ejecutar"))).repetida, true);
  for (const [otroCtx, otraPeticion] of [
    [{ ...c, body: { ...c.body, margen: 21 } }, peticion], [c, { ...peticion, ruta: "/compras" }],
    [{ ...c, query: { a: "3" } }, peticion], [c, { ...peticion, metodo: "PUT" }],
  ]) await assert.rejects(ejecutarPeticion(otroCtx, otraPeticion, crear), e => e.status === 409 && e.codigo === "OPERACION_DIFERENTE");
  assert.equal(await cuenta(db, "predio_producto"), 1);
});

test("identificadores de usuarios diferentes están aislados y entregas concurrentes se serializan", async t => {
  const db = base(t), c = contexto(db); let llamadas = 0;
  const ejecutar = async c => { llamadas++; await new Promise(resolve => setImmediate(resolve)); return crear(c); };
  const resultados = await Promise.all([ejecutarPeticion(c, peticion, ejecutar), ejecutarPeticion(c, peticion, ejecutar)]);
  assert.equal(llamadas, 1); assert.equal(resultados.filter(r => r.repetida).length, 1);
  const otro = contexto(db, { usuario: { ...c.usuario, id: 2 }, body: { ...c.body, nombre: "Producto de otro usuario" } });
  assert.equal((await ejecutarPeticion(otro, peticion, crear)).repetida, false);
  assert.equal(await cuenta(db, "predio_producto"), 2); assert.equal(await cuenta(db, "predio_peticion"), 2);
});

test("fallar al almacenar el resultado revierte negocio, auditoría, secuencia y outbox", async t => {
  const db = base(t), original = db.tx.bind(db); let falla = true;
  db.tx = trabajo => original(async tx => {
    const envuelto = { ...tx, run: (sql, params) => {
      if (falla && /^INSERT INTO predio_peticion/.test(sql)) throw new Error("disco lleno al guardar deduplicación");
      return tx.run(sql, params);
    }, tx: otro => otro(envuelto) };
    return trabajo(envuelto);
  });
  await assert.rejects(ejecutarPeticion(contexto(db), peticion, crear), /disco lleno/);
  for (const tabla of ["predio_producto", "predio_auditoria", "predio_outbox", "predio_secuencia", "predio_peticion"]) assert.equal(await cuenta(db, tabla), 0, tabla);
  falla = false;
  await ejecutarPeticion(contexto(db), peticion, crear); await ejecutarPeticion(contexto(db), peticion, crear);
  assert.equal(await cuenta(db, "predio_producto"), 1); assert.equal(await cuenta(db, "predio_peticion"), 1);
});

test("un error 4xx revierte el negocio y conserva sólo su respuesta estable sin repetirlo", async t => {
  const db = base(t); let llamadas = 0;
  const ejecutar = async c => { llamadas++; await crear(c); throw U.error("La validación final rechazó el cambio", 409, { codigo: "RECHAZADO", detalle: "sin cambios" }); };
  const r = await ejecutarPeticion(contexto(db), peticion, ejecutar);
  assert.equal(r.status, 409); assert.equal(r.respuesta.codigo, "RECHAZADO");
  const repetida = await ejecutarPeticion(contexto(db), peticion, ejecutar);
  assert.equal(repetida.repetida, true); assert.deepEqual(repetida.respuesta, r.respuesta); assert.equal(llamadas, 1);
  for (const tabla of ["predio_producto", "predio_auditoria", "predio_outbox", "predio_secuencia"]) assert.equal(await cuenta(db, tabla), 0, tabla);
  assert.equal(await cuenta(db, "predio_peticion"), 1);
});

test("un fallo 500 no conserva resultado y permite reintentar la transacción completa", async t => {
  const db = base(t);
  await assert.rejects(ejecutarPeticion(contexto(db), peticion, async c => { await crear(c); throw U.error("Fallo temporal", 500); }), e => e.status === 500);
  assert.equal(await cuenta(db, "predio_producto"), 0); assert.equal(await cuenta(db, "predio_peticion"), 0);
  const r = await ejecutarPeticion(contexto(db), peticion, crear);
  assert.equal(r.repetida, false); assert.equal(await cuenta(db, "predio_producto"), 1);
});

test("rechaza usuario o identificador inválido antes de ejecutar y no almacena el cuerpo sensible", async t => {
  const db = base(t), secreto = "clave-personal-no-guardar";
  await assert.rejects(ejecutarPeticion(contexto(db, { usuario: null }), peticion, crear), e => e.status === 401);
  await assert.rejects(ejecutarPeticion(contexto(db), { ...peticion, id: "corto" }, crear), e => e.status === 400);
  await ejecutarPeticion(contexto(db, { body: { nombre: "Producto", password: secreto, precio_compra: 1 } }), peticion, crear);
  const resultado = await db.get("SELECT * FROM predio_peticion");
  assert.doesNotMatch(JSON.stringify(resultado), new RegExp(secreto));
  assert.match(resultado.peticion_sha256, /^[a-f0-9]{64}$/);
});

test("un proceso interrumpido después del negocio y antes de guardar respuesta no deja un cobro sin deduplicación", async t => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-peticion-atomica-")); const archivo = path.join(carpeta, "predio.db"); let db;
  t.after(() => { db?.cerrar(); fs.rmSync(carpeta, { recursive: true, force: true }); });
  const script = `
    const {crearSqlite,asegurarEsquema}=require(${JSON.stringify(path.join(__dirname, "../lib/db-sqlite"))});
    const {ejecutarPeticion}=require(${JSON.stringify(path.join(__dirname, "../lib/peticiones-idempotentes"))});
    const api=require(${JSON.stringify(path.join(__dirname, "../lib/api"))});
    const db=crearSqlite(process.argv[1],{predioId:1}); asegurarEsquema(db);
    const ctx={db,pid:1,modo:'local',origen:'LOCAL',usuario:{id:1,rol:'ADMIN',nombre:'Admin'},sesion:{},query:{},body:{nombre:'Producto interrumpido',precio_compra:1}};
    ejecutarPeticion(ctx,${JSON.stringify(peticion)},async c=>{await api.ejecutar(c,'POST','/productos');process.exit(77)}).catch(e=>{console.error(e);process.exit(78)});
  `;
  const r = spawnSync(process.execPath, ["-e", script, archivo], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(r.status, 77, r.stderr);
  db = crearSqlite(archivo, { predioId: 1 }); asegurarEsquema(db);
  assert.equal(await cuenta(db, "predio_producto"), 0); assert.equal(await cuenta(db, "predio_peticion"), 0);
  const c = contexto(db, { body: { nombre: "Producto interrumpido", precio_compra: 1 } });
  await ejecutarPeticion(c, peticion, crear); await ejecutarPeticion(c, peticion, crear);
  assert.equal(await cuenta(db, "predio_producto"), 1); assert.equal(await cuenta(db, "predio_peticion"), 1);
});
