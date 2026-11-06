"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { validarAutorizacionHa } = require("../api/services/predios-ha");
const { exigirPropietario, conPropietarioBloqueado, saludarPredio, tomarControl } = require("../api/services/predios-propietario");
const A = "a".repeat(64), B = "b".repeat(64), TOKEN = "credencial-grupo-autenticada", INSTANCIA = "linaje-original";
const AHORA = 1793975585000;
function claves() {
  const p = crypto.generateKeyPairSync("ed25519");
  return { privada: p.privateKey, publica: p.publicKey.export({ type: "spki", format: "pem" }) };
}
function prueba(par, { equipo = A, termino = 1, estado = {}, datos = {}, token = TOKEN, compacto = false, responseKey } = {}) {
  const d = { formato: 1, grupoId: "grupo_camping", instanciaId: INSTANCIA, equipoOrigenId: A, clavePublicaTestigo: par.publica, ...datos };
  const e = { tipo: "AJB_TESTIGO_ESTADO", formato: 1, grupo_id: d.grupoId, termino, escritor: { id: equipo, nombre: "Servidor", url: "https://camping:8443" },
    ultimo: { indice: 7, sha256: "c".repeat(64) }, bloqueado: false, cuarentena_ms: 0, emitido_ms: AHORA, vence_ms: AHORA + 5000,
    ...(compacto ? { compacto: true, miembro_autorizado: true } : { miembros: [{ id: A }, { id: B }] }), ...estado };
  const o = { certificado: { datos: d, firma: crypto.createHmac("sha256", token).update(JSON.stringify(d)).digest("hex") },
    estadoFirmado: { estado: e, firma: crypto.sign(null, Buffer.from(JSON.stringify(e)), par.privada).toString("base64"), clave_publica: responseKey || par.publica } };
  return Buffer.from(JSON.stringify(o)).toString("base64");
}
function escenario(t, extra = {}) {
  const db = new DatabaseSync(":memory:");
  db.function("JSON_UNQUOTE", v => v);
  t.after(() => db.close());
  db.exec(`CREATE TABLE predio(id INTEGER PRIMARY KEY, escritor TEXT, instancia_id TEXT, equipo_id TEXT, equipo TEXT,
    ultima_conexion TEXT, version_local TEXT, pendientes_local INTEGER, ultima_escritura_central TEXT);
    CREATE TABLE predio_evento(id INTEGER PRIMARY KEY, predio_id INTEGER, tipo TEXT, detalle TEXT);
    CREATE TABLE operacion(id INTEGER PRIMARY KEY, valor TEXT);`);
  db.prepare("INSERT INTO predio(id,escritor,instancia_id,equipo_id,equipo) VALUES (1,?,?,?,'Original')").run(extra.escritor || "LOCAL", extra.instancia ?? INSTANCIA, extra.equipo === null ? null : extra.equipo || A);
  db.prepare("INSERT INTO predio(id,escritor,instancia_id,equipo_id,equipo) VALUES (2,'LOCAL','otro-linaje',?,'Otro predio')").run(B);
  let cola = Promise.resolve();
  const pool = { async getConnection() {
    let liberar;
    const anterior = cola;
    cola = new Promise(resolve => { liberar = resolve; });
    return {
      async beginTransaction() { await anterior; db.exec("BEGIN IMMEDIATE"); },
      async query(sql, params = []) {
        let q = sql.replace(/ FOR UPDATE$/, "").replace(/NOW\(\) - INTERVAL 60 SECOND/g, "datetime('now','-60 seconds')").replace(/NOW\(\)/g, "datetime('now')");
        if (params.some(Array.isArray)) {
          q = q.replace("IN (?)", "IN (" + params.find(Array.isArray).map(() => "?").join(",") + ")");
          params = params.flat();
        }
        const statement = db.prepare(q);
        return /^SELECT/i.test(sql) ? [statement.all(...params)] : [statement.run(...params)];
      },
      async commit() { db.exec("COMMIT"); }, async rollback() { db.exec("ROLLBACK"); }, release() { liberar(); },
    };
  } };
  const auth = (cabecera, { equipo = A, instancia = INSTANCIA, predioId = 1, token = TOKEN, despues, ahora = () => AHORA } = {}) => conPropietarioBloqueado(pool, predioId, async (c, p) => {
    const r = await validarAutorizacionHa(c, p, { token, cabecera, instanciaId: instancia, equipoId: equipo, ahora });
    if (despues) await despues(c, p, r);
    return r;
  });
  const eventos = tipo => db.prepare("SELECT * FROM predio_evento WHERE tipo=? ORDER BY id").all(tipo).map(r => JSON.parse(r.detalle));
  return { db, pool, auth, eventos, fila: () => ({ ...db.prepare("SELECT * FROM predio WHERE id=1").get() }) };
}

test("legacy conserva dueño único hasta registrar el grupo; después exige prueba incluso al dueño original", async t => {
  const s = escenario(t), p = claves();
  assert.equal((await s.auth(null)).haAutorizada, false);
  await saludarPredio(s.pool, 1, { instancia_id: INSTANCIA, equipo_id: A });
  await s.auth(prueba(p));
  assert.equal(s.eventos("HA_REGISTRO").length, 1);
  await assert.rejects(s.auth(null), { codigo: "HA_PRUEBA_REQUERIDA" });
  await assert.rejects(saludarPredio(s.pool, 1, { instancia_id: INSTANCIA, equipo_id: A }), { codigo: "HA_PRUEBA_REQUERIDA" });
});

test("el escritor promovido comparte linaje y conserva el hardware raíz en hola y tomar-control", async t => {
  const s = escenario(t), p = claves(), cabecera = prueba(p, { equipo: B, termino: 4 });
  const datos = { instancia_id: INSTANCIA, equipo_id: B, equipo: "PC respaldo", version: "nueva" };
  const opciones = { token: TOKEN, cabecera, ahora: () => AHORA };
  assert.equal((await saludarPredio(s.pool, 1, datos, opciones)).autoriza_escritura, true);
  assert.equal((await tomarControl(s.pool, 1, datos, opciones)).autoriza_escritura, true);
  assert.equal(s.fila().equipo_id, A);
  assert.equal(s.fila().equipo, "PC respaldo");
  assert.equal(s.fila().instancia_id, INSTANCIA);
  assert.equal(s.eventos("HA_TERMINO").length, 1);
});

test("sólo el objeto interno validado habilita otro hardware; los flags del cuerpo o booleanos no lo habilitan", async t => {
  const s = escenario(t), p = claves(), datos = { instancia_id: INSTANCIA, equipo_id: B, haAutorizada: true };
  assert.throws(() => exigirPropietario(s.fila(), datos), { codigo: "OTRO_EQUIPO" });
  assert.throws(() => exigirPropietario(s.fila(), datos, { haAutorizada: true }), { codigo: "OTRO_EQUIPO" });
  const validada = await s.auth(prueba(p, { equipo: B }), { equipo: B });
  assert.equal(exigirPropietario(s.fila(), datos, { haAutorizada: validada }).equipo_id, B);
  assert.throws(() => exigirPropietario({ ...s.fila(), id: 2 }, datos, { haAutorizada: validada }), { codigo: "OTRO_EQUIPO" });
});

test("certificados alterados, credenciales distintas y cabeceras malformadas no crean registros", async t => {
  const s = escenario(t), p = claves();
  for (const cabecera of ["no json", "====", Buffer.from("{}").toString("base64"), prueba(p, { token: "otra-credencial" }), prueba(p, { datos: { equipoOrigenId: B } })]) {
    await assert.rejects(s.auth(cabecera), { codigo: "HA_NO_AUTORIZADA" });
  }
  const alterada = JSON.parse(Buffer.from(prueba(p), "base64")); alterada.certificado.datos.grupoId = "grupo_modificado";
  await assert.rejects(s.auth(Buffer.from(JSON.stringify(alterada)).toString("base64")), { codigo: "HA_NO_AUTORIZADA" });
  assert.equal(s.eventos("HA_REGISTRO").length, 0);
});

test("el certificado no habilita otro predio o un origen sin vinculación física", async t => {
  const s = escenario(t), p = claves();
  await assert.rejects(s.auth(prueba(p), { predioId: 2, instancia: "otro-linaje", equipo: B }), { codigo: "HA_NO_AUTORIZADA" });
  const sinEquipo = escenario(t, { equipo: null });
  await assert.rejects(sinEquipo.auth(prueba(p)), { codigo: "HA_ORIGEN_NO_VINCULADO" });
  const central = escenario(t, { escritor: "CENTRAL" });
  await assert.rejects(central.auth(prueba(p)), { codigo: "HA_ORIGEN_NO_VINCULADO" });
});

test("la clave pública de la respuesta no reemplaza el PIN certificado ni permite cambiarlo tras registrar", async t => {
  const s = escenario(t), p = claves(), otra = claves();
  await s.auth(prueba(p));
  await assert.rejects(s.auth(prueba(otra)), { codigo: "HA_GRUPO_DISTINTO" });
  await assert.rejects(s.auth(prueba(p, { datos: { grupoId: "otro_grupo" } })), { codigo: "HA_GRUPO_DISTINTO" });
  const falsa = JSON.parse(Buffer.from(prueba(p), "base64"));
  falsa.estadoFirmado.clave_publica = otra.publica;
  falsa.estadoFirmado.firma = crypto.sign(null, Buffer.from(JSON.stringify(falsa.estadoFirmado.estado)), otra.privada).toString("base64");
  await assert.rejects(s.auth(Buffer.from(JSON.stringify(falsa)).toString("base64")), { codigo: "HA_NO_AUTORIZADA" });
  assert.equal((await s.auth(prueba(p, { responseKey: otra.publica }))).haAutorizada, true, "se verifica sólo contra el PIN, no contra la clave de respuesta");
});

test("se rechazan vencimiento, desvío de reloj, leases largos, cuarentena y escritor ajeno al roster", async t => {
  const s = escenario(t), p = claves();
  for (const estado of [
    { emitido_ms: AHORA - 8000, vence_ms: AHORA - 3000 },
    { emitido_ms: AHORA + 30001, vence_ms: AHORA + 35001 },
    { vence_ms: AHORA + 5001 },
  ]) await assert.rejects(s.auth(prueba(p, { estado })), { codigo: "HA_PRUEBA_VENCIDA" });
  for (const estado of [{ bloqueado: true }, { cuarentena_ms: 1 }, { miembros: [{ id: B }] }, { miembros: [{ id: A }, { id: A }] }, { escritor: { id: B } }]) {
    await assert.rejects(s.auth(prueba(p, { estado })), { codigo: "HA_NO_AUTORIZADA" });
  }
});

test("prueba compacta firmada acredita membresía sin enviar CAs ni roster en la cabecera", async t => {
  const s = escenario(t), p = claves();
  const cabecera = prueba(p, { compacto: true });
  assert.ok(cabecera.length < 4096);
  assert.equal((await s.auth(cabecera)).haAutorizada, true);
  await assert.rejects(s.auth(prueba(p, { compacto: true, estado: { miembro_autorizado: false } })), { codigo: "HA_NO_AUTORIZADA" });
});

test("un término posterior cerca al servidor previo, también si su prueba pasó el middleware antes", async t => {
  const s = escenario(t), p = claves(), viejo = prueba(p), nuevo = prueba(p, { equipo: B, termino: 2 });
  await s.auth(viejo); // validación del middleware de un push que todavía no tomó su transacción.
  await s.auth(nuevo, { equipo: B });
  await assert.rejects(s.auth(viejo, { despues: c => c.query("INSERT INTO operacion(id,valor) VALUES(1,'no debe aplicarse')") }), { codigo: "HA_TERMINO_ANTERIOR" });
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM operacion").get().n, 0);
  assert.equal(s.eventos("HA_TERMINO").at(-1).termino, 2);
  await assert.rejects(s.auth(prueba(p, { termino: 2 })), { codigo: "HA_TERMINO_ANTERIOR" });
});

test("el lock de predio serializa términos concurrentes y sólo conserva la mayor autoridad", async t => {
  const s = escenario(t), p = claves();
  const r = await Promise.allSettled([s.auth(prueba(p, { equipo: B, termino: 5 }), { equipo: B }), s.auth(prueba(p, { termino: 4 }))]);
  assert.equal(r[0].status, "fulfilled");
  assert.equal(r[1].status, "rejected");
  assert.equal(r[1].reason.codigo, "HA_TERMINO_ANTERIOR");
  assert.equal(s.eventos("HA_REGISTRO").length, 1);
  assert.equal(s.eventos("HA_TERMINO").length, 1);
});

test("un fallo de la operación revierte el nuevo término y el registro adoptados en esa misma transacción", async t => {
  const s = escenario(t), p = claves();
  await assert.rejects(s.auth(prueba(p, { equipo: B, termino: 8 }), { equipo: B, despues: () => { throw new Error("Fallo de almacenamiento"); } }), /Fallo de almacenamiento/);
  assert.equal(s.eventos("HA_REGISTRO").length, 0);
  assert.equal(s.eventos("HA_TERMINO").length, 0);
  assert.equal((await s.auth(null)).haAutorizada, false);
});

test("la importación por archivo rechaza un grupo HA registrado incluso con forzar, antes de borrar filas o cambiar su raíz", async t => {
  const { importarExportacion } = require("../api/services/predios-central");
  const s = escenario(t), p = claves();
  s.db.exec("CREATE TABLE predio_producto(id INTEGER PRIMARY KEY, predio_id INTEGER, nombre TEXT); INSERT INTO predio_producto VALUES(1,1,'Última venta intacta')");
  await s.auth(prueba(p));
  const datos = { tipo: "predio-exportacion", predio_id: 1, instancia_id: INSTANCIA, equipo_id: B,
    tablas: { predio_producto: [{ id: 1, nombre: "Archivo atrasado" }] } };
  for (const forzar of [false, true]) {
    await assert.rejects(importarExportacion(s.pool, s.fila(), datos, { forzar }), { status: 409, codigo: "HA_IMPORTACION_NO_PERMITIDA" });
    assert.equal(s.db.prepare("SELECT nombre FROM predio_producto WHERE id=1").get().nombre, "Última venta intacta");
    assert.equal(s.fila().equipo_id, A);
    assert.equal(s.eventos("HA_REGISTRO").length, 1);
  }
});

let poolRutas;
function routerSync() {
  const archivo = require.resolve("../api/connection/connection");
  require.cache[archivo] = { id: archivo, filename: archivo, loaded: true, exports: { promise: () => poolRutas } };
  return require("../api/routes/predios").crearRouterSync();
}
async function httpComandos(t, s, antesRuta) {
  const express = require("express");
  s.db.exec(`ALTER TABLE predio ADD COLUMN activo INTEGER DEFAULT 1;
    ALTER TABLE predio ADD COLUMN codigo TEXT DEFAULT 'CAMPING';
    CREATE TABLE predio_instalacion(id INTEGER PRIMARY KEY, predio_id INTEGER, token_hash TEXT, revocado_en TEXT, ultimo_uso TEXT, ultima_ip TEXT, instancia_id TEXT);
    CREATE TABLE predio_comando(id INTEGER PRIMARY KEY, predio_id INTEGER, estado TEXT, status INTEGER, resultado TEXT, resuelto_en TEXT, entregado_en TEXT, intentos INTEGER DEFAULT 0,
      tipo TEXT, metodo TEXT, ruta TEXT, cuerpo TEXT, query TEXT, actor TEXT);
    INSERT INTO predio_comando(id,predio_id,estado,tipo,metodo,ruta) VALUES(77,1,'PENDIENTE','API','POST','/productos');`);
  s.db.prepare("INSERT INTO predio_instalacion(id,predio_id,token_hash) VALUES(1,1,?)").run(crypto.createHash("sha256").update(TOKEN).digest("hex"));
  poolRutas = { ...s.pool, async query(sql, params) {
    const statement = s.db.prepare(sql.replace(/NOW\(\)/g, "datetime('now')"));
    const resultado = /^SELECT/i.test(sql) ? [statement.all(...params)] : [statement.run(...params)];
    if (sql.startsWith("UPDATE predio_instalacion") && antesRuta) await antesRuta();
    return resultado;
  } };
  const app = express(); app.use("/sync", routerSync());
  const servidor = app.listen(0, "127.0.0.1"); await new Promise(resolve => servidor.once("listening", resolve));
  t.after(async () => { servidor.closeAllConnections?.(); await new Promise(resolve => servidor.close(resolve)); });
  return `http://127.0.0.1:${servidor.address().port}/sync`;
}

test("HTTP: una prueba que pasó middleware no entrega ni resuelve órdenes después de que otro escritor registra un término mayor", async t => {
  for (const ruta of ["/comandos", "/comandos/77/resultado"]) await t.test(ruta, async sub => {
    const s = escenario(sub), p = claves(), fecha = Date.now();
    const vieja = prueba(p, { estado: { emitido_ms: fecha, vence_ms: fecha + 5000 } });
    const nueva = prueba(p, { equipo: B, termino: 2, estado: { emitido_ms: fecha, vence_ms: fecha + 5000 } });
    const url = await httpComandos(sub, s, () => s.auth(nueva, { equipo: B, ahora: Date.now }));
    const r = await fetch(url + ruta, { method: ruta === "/comandos" ? "GET" : "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Predio-Instancia": INSTANCIA, "X-Predio-Equipo": A, "X-Predio-HA": vieja, "Content-Type": "application/json" },
      ...(ruta === "/comandos" ? {} : { body: JSON.stringify({ ok: true, status: 200, respuesta: { aplicada: true } }) }) });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).codigo, "HA_TERMINO_ANTERIOR");
    const fila = s.db.prepare("SELECT estado,intentos,resultado FROM predio_comando WHERE id=77").get();
    assert.equal(fila.estado, "PENDIENTE"); assert.equal(fila.intentos, 0); assert.equal(fila.resultado, null);
    assert.equal(s.eventos("HA_TERMINO").at(-1).termino, 2);
  });
});

test("HTTP: entrega y resultado del escritor HA vigente conservan la identidad raíz original", async t => {
  const s = escenario(t), p = claves(), fecha = Date.now();
  const cabecera = prueba(p, { equipo: B, termino: 3, estado: { emitido_ms: fecha, vence_ms: fecha + 5000 } });
  const url = await httpComandos(t, s);
  const entrega = await fetch(url + "/comandos", { headers: { Authorization: `Bearer ${TOKEN}`, "X-Predio-Instancia": INSTANCIA, "X-Predio-Equipo": B, "X-Predio-HA": cabecera } });
  assert.equal(entrega.status, 200);
  assert.equal((await entrega.json()).comandos[0].id, 77);
  assert.equal(s.db.prepare("SELECT estado FROM predio_comando WHERE id=77").get().estado, "ENTREGADO");
  const r = await fetch(url + "/comandos/77/resultado", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "X-Predio-Instancia": INSTANCIA, "X-Predio-Equipo": B, "X-Predio-HA": cabecera, "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, status: 201, respuesta: { aplicada: true } }) });
  assert.equal(r.status, 200);
  const fila = s.db.prepare("SELECT estado,status,resultado FROM predio_comando WHERE id=77").get();
  assert.equal(fila.estado, "OK"); assert.equal(fila.status, 201); assert.deepEqual(JSON.parse(fila.resultado), { aplicada: true });
  assert.equal(s.fila().equipo_id, A);
});

test("HTTP: sólo nodos con capacidad exacta reciben actores PREDIO; el filtro previo al límite no bloquea órdenes generales", async t => {
  const s = escenario(t), p = claves(), fecha = Date.now();
  const cabecera = prueba(p, { equipo: B, termino: 3, estado: { emitido_ms: fecha, vence_ms: fecha + 5000 } });
  const url = await httpComandos(t, s);
  const insertar = s.db.prepare("INSERT INTO predio_comando(id,predio_id,estado,tipo,metodo,ruta,actor) VALUES(?,1,'PENDIENTE','API','POST','/proveedores',?)");
  for (let id = 1; id <= 21; id++) insertar.run(id, JSON.stringify({ tipo: "PREDIO", predio_id: 1, predio_usuario_id: 7 }));
  const headers = { Authorization: `Bearer ${TOKEN}`, "X-Predio-Instancia": INSTANCIA, "X-Predio-Equipo": B, "X-Predio-HA": cabecera, "X-Predio-Capacidades": "cuentas-predio-v10" };
  const viejo = await fetch(url + "/comandos", { headers }); assert.equal(viejo.status, 200);
  assert.deepEqual((await viejo.json()).comandos.map(c => c.id), [77]);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM predio_comando WHERE id<=21 AND estado='PENDIENTE'").get().n, 21);
  const nuevo = await fetch(url + "/comandos", { headers: { ...headers, "X-Predio-Capacidades": "otra-capacidad, cuentas-predio-v1" } }); assert.equal(nuevo.status, 200);
  const entregadas = (await nuevo.json()).comandos;
  assert.equal(entregadas.length, 20); assert.ok(entregadas.every(c => c.actor.tipo === "PREDIO"));
});
