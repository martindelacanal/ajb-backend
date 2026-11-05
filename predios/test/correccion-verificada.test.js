"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const N = require("../lib/negocio");
const { corregirCodigosVerificados, crearAgente } = require("../lib/agente");
const { generarPar, firmar } = require("../lib/firma");

async function datos(t) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, usuario: { id: null, nombre: "Importación" } };
  const id = await db.tx((tx) => N.insertar(tx, ctx, "predio_producto", {
    nombre: "COCA ZERO 1 1/2", codigo: "779089506755", destino: "VENTA_DIRECTA", activo: 1, precio_venta: 1500,
  }));
  return { db, ctx, id, producto: { producto_id: id, nombre_esperado: "COCA ZERO 1 1/2", codigo_anterior: "779089506755", codigo_nuevo: "7790895067556" } };
}

test("la corrección verificada cambia sólo la ficha exacta y queda auditada como Sistema sin crear usuarios", async (t) => {
  const { db, id, producto } = await datos(t);
  const r = await corregirCodigosVerificados(db, 1, { productos: [producto] });
  assert.deepEqual(r.productos, [{ id, codigo: producto.codigo_nuevo, estado: "CORREGIDO" }]);
  const fila = await db.get("SELECT codigo, precio_venta FROM predio_producto WHERE predio_id = 1 AND id = ?", [id]);
  assert.equal(fila.codigo, producto.codigo_nuevo);
  assert.equal(fila.precio_venta, 1500);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_usuario")).n, 0);
  const auditoria = await db.get("SELECT * FROM predio_auditoria WHERE entidad_id = ?", [id]);
  assert.equal(auditoria.usuario_id, null);
  assert.equal(auditoria.usuario_nombre, "Corrección verificada del sistema general");
  assert.equal(auditoria.origen, "SISTEMA");
  const repetida = await corregirCodigosVerificados(db, 1, { productos: [producto] });
  assert.equal(repetida.productos[0].estado, "YA_CORREGIDO");
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_auditoria")).n, 1);
});

test("el manifiesto rechaza datos no verificados y revierte el lote si una ficha cambió", async (t) => {
  const { db, ctx, id, producto } = await datos(t);
  await assert.rejects(corregirCodigosVerificados(db, 1, { productos: [] }), { status: 400 });
  await assert.rejects(corregirCodigosVerificados(db, 1, { productos: Array(101).fill(producto) }), { status: 400 });
  await assert.rejects(corregirCodigosVerificados(db, 1, { productos: [producto, producto] }), { status: 400 });
  await assert.rejects(corregirCodigosVerificados(db, 1, { productos: [{ ...producto, codigo_nuevo: "7790895067550" }] }), { status: 400 });
  await assert.rejects(corregirCodigosVerificados(db, 1, { productos: [{ ...producto, nombre_esperado: "COCA REGULAR 1 1/2" }] }), { status: 409 });
  const id2 = await db.tx((tx) => N.insertar(tx, ctx, "predio_producto", { nombre: "Otra bebida", codigo: "779089500043", destino: "VENTA_DIRECTA", activo: 1 }));
  await assert.rejects(corregirCodigosVerificados(db, 1, { productos: [producto, { producto_id: id2, nombre_esperado: "Otra bebida", codigo_anterior: "779089500044", codigo_nuevo: "7790895000430" }] }), { status: 409, codigo: "CODIGO_MODIFICADO" });
  assert.equal((await db.get("SELECT codigo FROM predio_producto WHERE predio_id = 1 AND id = ?", [id])).codigo, producto.codigo_anterior);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_auditoria")).n, 0);
  await assert.rejects(corregirCodigosVerificados(db, 2, { productos: [producto] }), { status: 409 });
});

test("la orden de sistema firmada se ejecuta y queda registrada para no repetirla", async (t) => {
  const { db, id, producto } = await datos(t);
  const claves = generarPar();
  const agente = crearAgente({ db, config: { predio_id: 1, clave_publica: claves.publica }, base: "", version: "test", log: () => {}, api: { ejecutarRemoto() { throw new Error("No se debe crear ni impersonar un usuario"); } } });
  const contenido = JSON.stringify({ tipo: "predio-paquete", predio_id: 1, comandos: [
    { id: 90, tipo: "SISTEMA", ruta: "CORREGIR_CODIGOS_VERIFICADOS", cuerpo: { productos: [producto] } },
  ] });
  const paquete = zlib.gzipSync(Buffer.from(JSON.stringify({ tipo: "predio-paquete-firmado", contenido, firma: firmar(contenido, claves.privada) })));
  assert.equal((await agente.importarPaquete(paquete)).errores, 0);
  assert.equal((await db.get("SELECT codigo FROM predio_producto WHERE id = ?", [id])).codigo, producto.codigo_nuevo);
  const ejecutado = await db.get("SELECT * FROM predio_comando_ejecutado WHERE comando_id = 90");
  assert.equal(ejecutado.ok, 1);
  assert.equal(JSON.parse(ejecutado.respuesta).productos[0].estado, "CORREGIDO");
  assert.equal((await agente.importarPaquete(paquete)).errores, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_auditoria")).n, 1);
});
