"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { crearAgente } = require("../lib/agente");
const { generarPar, firmar } = require("../lib/firma");
const { reiniciarUsuariosPredio } = require("../lib/reinicio-usuarios");
const N = require("../lib/negocio");
const api = require("../lib/api");

async function preparar(t) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", esLocalhost: true, usuario: { id: null, nombre: "Preparación" }, query: {}, body: {} };
  await db.tx(async tx => {
    await N.insertar(tx, ctx, "predio_usuario", { usuario: "admintest", nombre: "Admin test", rol: "ADMIN", activo: 1, es_admin_general: 0 });
    await N.insertar(tx, ctx, "predio_usuario", { usuario: "caja", nombre: "Caja de prueba", rol: "CAJERO", activo: 1, es_admin_general: 0 });
    await N.insertar(tx, ctx, "predio_usuario", { usuario: "dni111111", nombre: "Administrador general", rol: "ADMIN", activo: 1, es_admin_general: 1, general_usuario_id: 77, documento: "111111" });
    await N.insertar(tx, ctx, "predio_usuario_boca", { usuario_id: 2, boca_id: 10 });
    await N.insertar(tx, ctx, "predio_aviso_lectura", { usuario_id: 2, aviso_id: 1, fecha: "2026-11-09 10:00:00" });
    await N.insertar(tx, ctx, "predio_config", { clave: "nombre_predio", valor: "Camping" });
    await N.insertar(tx, ctx, "predio_producto", { nombre: "Producto conservado", destino: "VENTA_DIRECTA", activo: 1 });
  });
  await db.run("INSERT INTO predio_meta(clave,valor) VALUES('grupo_local','grupo-conservado')");
  await db.run("INSERT INTO predio_sesion(token_hash,usuario_id,creada,ultimo_uso) VALUES('sesion-prueba',1,'2026-11-09','2026-11-09')");
  await db.run("INSERT INTO predio_peticion(operacion_id,usuario_id,peticion_sha256,fecha,status,respuesta) VALUES('reintento',2,'hash','2026-11-09',200,'{}')");
  await db.run("INSERT INTO predio_admin_cache(documento,hash,general_id) VALUES('111111','hash-prueba',77)");
  await db.run("DELETE FROM predio_outbox");
  const cuerpo = { predio_id: 1, confirmacion: "ELIMINAR_TODOS_LOS_USUARIOS_DEL_PREDIO", usuarios: await db.all("SELECT id,usuario FROM predio_usuario WHERE predio_id=1 ORDER BY id") };
  return { db, ctx, cuerpo };
}

function prepararOrden(db, cuerpo) {
  const claves = generarPar();
  const agente = crearAgente({ db, config: { predio_id: 1, clave_publica: claves.publica }, base: "", version: "test", log() {}, api: {} });
  const contenido = JSON.stringify({ tipo: "predio-paquete", predio_id: 1, comandos: [{ id: 901, tipo: "SISTEMA", ruta: "REINICIAR_USUARIOS_PREDIO", cuerpo }] });
  const paquete = zlib.gzipSync(JSON.stringify({ tipo: "predio-paquete-firmado", contenido, firma: firmar(contenido, claves.privada) }));
  return { agente, paquete };
}

test("el reinicio firmado permite crear el admin definitivo y repetir la orden conserva esa cuenta", async t => {
  const { db, ctx, cuerpo } = await preparar(t);
  const { agente, paquete } = prepararOrden(db, cuerpo);
  assert.equal((await agente.importarPaquete(paquete)).errores, 0);
  for (const tabla of ["predio_usuario", "predio_usuario_boca", "predio_aviso_lectura", "predio_sesion", "predio_peticion", "predio_admin_cache"]) {
    assert.equal((await db.get(`SELECT COUNT(*) n FROM ${tabla}`)).n, 0, tabla);
  }
  assert.equal((await api.ejecutar(ctx, "GET", "/estado-publico")).configurado, false);
  assert.equal((await db.get("SELECT valor FROM predio_meta WHERE clave='grupo_local'")).valor, "grupo-conservado");
  assert.equal((await db.get("SELECT nombre FROM predio_producto WHERE id=1")).nombre, "Producto conservado");
  assert.equal((await db.get("SELECT ultimo FROM predio_secuencia WHERE tabla='predio_usuario'")).ultimo, 3);
  assert.equal((await db.get("SELECT COUNT(*) n FROM predio_outbox WHERE tabla='predio_usuario' AND op='D'")).n, 3);
  const alta = await api.ejecutar({ ...ctx, body: { usuario: "administracion", nombre: "Administrador definitivo", password: "ClaveDefinitiva2026!", recordar: true } }, "POST", "/primer-uso");
  assert.equal(alta.usuario.rol, "ADMIN");
  assert.equal(alta.usuario.id, 4);
  assert.equal((await agente.importarPaquete(paquete)).errores, 0);
  assert.equal((await api.ejecutar(ctx, "GET", "/estado-publico")).configurado, true);
  assert.deepEqual(await db.all("SELECT id,usuario FROM predio_usuario"), [{ id: 4, usuario: "administracion" }]);
  assert.equal((await db.get("SELECT COUNT(*) n FROM predio_auditoria WHERE accion='Reinicio de usuarios del predio'")).n, 1);
});

test("un predio o roster diferente aborta y conserva usuarios, sesiones y cola", async t => {
  const { db, cuerpo } = await preparar(t);
  const malos = [
    { ...cuerpo, predio_id: 2 },
    { ...cuerpo, confirmacion: undefined },
    { ...cuerpo, usuarios: [] },
    { ...cuerpo, usuarios: cuerpo.usuarios.slice(1) },
    { ...cuerpo, usuarios: [...cuerpo.usuarios, cuerpo.usuarios[0]] },
    { ...cuerpo, usuarios: cuerpo.usuarios.map(u => ({ ...u, usuario: u.usuario + "-viejo" })) },
  ];
  for (const malo of malos) {
    await assert.rejects(reiniciarUsuariosPredio(db, 1, malo));
    assert.equal((await db.get("SELECT COUNT(*) n FROM predio_usuario")).n, 3);
    assert.equal((await db.get("SELECT COUNT(*) n FROM predio_sesion")).n, 1);
    assert.equal((await db.get("SELECT COUNT(*) n FROM predio_outbox")).n, 0);
  }
});

test("un fallo al registrar el resultado revierte la eliminación completa y permite reintentar", async t => {
  const { db, cuerpo } = await preparar(t);
  const { agente, paquete } = prepararOrden(db, cuerpo);
  const txOriginal = db.tx.bind(db);
  db.tx = trabajo => txOriginal(async tx => {
    const envuelto = { ...tx, async run(sql, params) {
      if (sql.startsWith("INSERT INTO predio_comando_ejecutado")) throw new Error("Fallo simulado al registrar la orden");
      return tx.run(sql, params);
    }, tx: otro => otro(envuelto) };
    return trabajo(envuelto);
  });
  await assert.rejects(agente.importarPaquete(paquete), /Fallo simulado/);
  assert.equal((await db.get("SELECT COUNT(*) n FROM predio_usuario")).n, 3);
  assert.equal((await db.get("SELECT COUNT(*) n FROM predio_sesion")).n, 1);
  assert.equal((await db.get("SELECT COUNT(*) n FROM predio_admin_cache")).n, 1);
  assert.equal((await db.get("SELECT COUNT(*) n FROM predio_outbox")).n, 0);
  assert.equal((await db.get("SELECT COUNT(*) n FROM predio_auditoria")).n, 0);
  db.tx = txOriginal;
  assert.equal((await agente.importarPaquete(paquete)).errores, 0);
});

test("el reinicio se acota al predio y conserva cuentas y caché de otro predio", async t => {
  const { db, cuerpo } = await preparar(t);
  await db.run("INSERT INTO predio_usuario(predio_id,id,usuario,nombre,rol,activo,es_admin_general,general_usuario_id,documento) VALUES(2,51,'otro','Otro predio','ADMIN',1,1,88,'222222')");
  await db.run("INSERT INTO predio_usuario_boca(predio_id,id,usuario_id,boca_id) VALUES(2,51,51,10)");
  await db.run("INSERT INTO predio_sesion(token_hash,usuario_id,creada,ultimo_uso) VALUES('sesion-ajena',51,'2026-11-09','2026-11-09')");
  await db.run("INSERT INTO predio_admin_cache(documento,hash,general_id) VALUES('222222','hash-ajeno',88)");
  await reiniciarUsuariosPredio(db, 1, cuerpo);
  assert.deepEqual(await db.all("SELECT id,usuario FROM predio_usuario"), [{ id: 51, usuario: "otro" }]);
  assert.deepEqual(await db.all("SELECT usuario_id FROM predio_usuario_boca"), [{ usuario_id: 51 }]);
  assert.deepEqual(await db.all("SELECT usuario_id FROM predio_sesion"), [{ usuario_id: 51 }]);
  assert.deepEqual(await db.all("SELECT documento FROM predio_admin_cache"), [{ documento: "222222" }]);
});
