"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");

Object.assign(process.env, { JWT_SECRET: "logo-prueba", BUCKET_REGION: "us-east-1",
  BUCKET_NAME: "logo-prueba", ACCESS_KEY: "test", SECRET_ACCESS_KEY: "test" });

test("imágenes públicas del banner de una edición", async t => {
  const admin = { id: 5, rol: "admin", rol_id: 1, habilitado: "Y", requiere_cambio_clave: 0 };
  const departamental = { ...admin, id: 6, rol: "departamental", rol_id: 3 };
  const ediciones = new Map([
    [2, { id: 2, nombre: "Olimpiadas Judiciales 2026", edicion: "XXVII", fecha_inicio: "2026-11-26", habilitado: "Y", publicada_publico: 1 }],
    [4, { id: 4, nombre: "Olimpiadas 2027", edicion: "XXVIII", fecha_inicio: "2027-11-18" }],
  ]);
  const db = { async query(sql, params) {
    if (sql.includes("r.nombre AS rol")) return [[Number(params[0]) === admin.id ? admin : departamental]];
    if (sql.includes("FROM olimpiada WHERE")) return [ediciones.has(Number(params[0])) ? [ediciones.get(Number(params[0]))] : []];
    if (sql.includes("FROM olimpiada o WHERE o.eliminado = 0")) return [[ediciones.get(2)]];
    if (sql.includes(" AS en_vivo")) return [[{}]];
    // El detalle de la edición también lee sus disciplinas y los tramos de bonos: acá no tiene
    if (/^\s*SELECT/i.test(sql)) return [[]];
    assert.match(sql, /INSERT INTO olimpiada_historial/);
    return [{}];
  } };
  const conexion = require.resolve("../api/connection/connection");
  require.cache[conexion] = { id: conexion, filename: conexion, loaded: true, exports: { promise: () => db } };
  const { s3, obtenerLogoPublico, obtenerMascotaPublica } = require("../api/services/olimpiadas-comun");
  const objetos = new Map();
  const pedidos = [];
  t.mock.method(s3, "send", async comando => {
    const { Key, Body, ContentType, CacheControl, Metadata, IfNoneMatch } = comando.input;
    pedidos.push(comando.constructor.name);
    if (comando.constructor.name === "PutObjectCommand") {
      // Una subida condicionada no pisa lo que ya hay en la clave, aunque sea el objeto vacío de «retirado»
      if (IfNoneMatch === "*" && objetos.has(Key)) throw Object.assign(new Error("Precondition Failed"), { $metadata: { httpStatusCode: 412 } });
      const ETag = '"' + crypto.createHash("md5").update(Body).digest("hex") + '"';
      objetos.set(Key, { Body, ContentType, CacheControl, Metadata, ContentLength: Body.length, ETag });
    }
    if (!objetos.has(Key)) throw Object.assign(new Error("Forbidden"), { $metadata: { httpStatusCode: 403 } });
    return objetos.get(Key);
  });
  // El reloj avanza a mano: las consultas a S3 se reparten cada medio minuto por edición
  let ahora = Date.parse("2026-11-25T12:00:00Z");
  t.mock.method(Date, "now", () => ahora);
  const pasan = segundos => { ahora += segundos * 1000; };

  const app = express();
  app.use(require("../api/routes/olimpiadas"));
  app.use(require("../api/routes/olimpiadas-publico"));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = "http://127.0.0.1:" + server.address().port + "/olimpiadas/";
  const sesion = usuario => ({ Authorization: "Bearer " + jwt.sign({ data: JSON.stringify(usuario) }, process.env.JWT_SECRET) });
  const headers = sesion(admin);
  const subir = async (ruta, imagen) => {
    const body = new FormData();
    body.append("IMAGEN", new Blob([imagen], { type: "image/png" }), "logo.png");
    return fetch(ruta, { method: "PUT", headers, body });
  };
  const clave = id => `olimpiadas/ediciones/${id}/logo-publico`;

  // Una edición sin logo: no se inventa nada y a S3 se le pregunta una sola vez por medio minuto
  assert.equal(await obtenerLogoPublico(ediciones.get(4)), null);
  assert.equal(await obtenerLogoPublico(ediciones.get(4)), null);
  assert.deepEqual(pedidos, ["HeadObjectCommand"]);
  assert.equal(objetos.size, 0);
  assert.equal(await obtenerLogoPublico(null), null);

  // Permisos y validaciones
  assert.equal((await fetch(base + "4/logo", { method: "DELETE", headers: sesion(departamental) })).status, 401);
  assert.equal((await fetch(base + "9/logo", { method: "DELETE", headers })).status, 404);
  assert.equal((await fetch(base + "4/logo", { method: "PUT", headers })).status, 400);
  assert.equal(objetos.size, 0);

  // Subir: se recortan los márgenes vacíos, queda en WebP con su transparencia y viaja con sus medidas
  // (dos bloques azules separados por un hueco transparente, con margen vacío alrededor)
  const bloque = await sharp({ create: { width: 100, height: 60, channels: 4, background: { r: 0, g: 26, b: 120, alpha: 1 } } }).png().toBuffer();
  const conMargen = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: bloque, left: 50, top: 70 }, { input: bloque, left: 250, top: 70 }])
    .png().toBuffer();
  const alta = await subir(base + "4/logo", conMargen);
  assert.equal(alta.status, 200);
  const { logo, message } = await alta.json();
  assert.equal(message, "Logo de la edición guardado");
  assert.deepEqual([logo.ancho, logo.alto], [300, 60]);
  assert.equal(new URL(logo.url).pathname, "/" + clave(4));
  const guardado = objetos.get(clave(4));
  const meta = await sharp(guardado.Body).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha], ["webp", 300, 60, true]);
  const pixeles = await sharp(guardado.Body).ensureAlpha().raw().toBuffer();
  const alfa = (x, y) => pixeles[(y * 300 + x) * 4 + 3];
  assert.deepEqual([alfa(50, 30), alfa(150, 30), alfa(250, 30)], [255, 0, 255]);
  assert.deepEqual(guardado.Metadata, { ancho: "300", alto: "60" });
  assert.match(guardado.CacheControl, /max-age=3600/);

  // Mientras no cambia se entrega la misma dirección (el navegador no lo vuelve a bajar); pasada
  // la mitad de su vigencia se firma otra, del mismo logo
  assert.deepEqual(await obtenerLogoPublico(ediciones.get(4)), logo);
  pasan(31);
  assert.deepEqual(await obtenerLogoPublico(ediciones.get(4)), logo);
  pasan(1800);
  // (la firma lleva la hora real al segundo: hay que dejar pasar uno para distinguirla)
  await new Promise(resolve => setTimeout(resolve, 1100));
  const renovado = await obtenerLogoPublico(ediciones.get(4));
  assert.notEqual(renovado.url, logo.url);
  assert.equal(renovado.version, logo.version);

  // Reemplazar: cambia la versión y la dirección
  const cuadrado = await sharp({ create: { width: 80, height: 80, channels: 3, background: "red" } }).png().toBuffer();
  const reemplazo = (await (await subir(base + "4/logo", cuadrado)).json()).logo;
  assert.notEqual(reemplazo.version, logo.version);
  assert.deepEqual([reemplazo.ancho, reemplazo.alto], [80, 80]);
  assert.deepEqual(await obtenerLogoPublico(ediciones.get(4)), reemplazo);

  // La XXVII edición de 2026 ya mostraba su logo: la primera consulta lo deja cargado
  const inicial = await obtenerLogoPublico(ediciones.get(2));
  assert.deepEqual([inicial.ancho, inicial.alto], [1200, 266]);
  assert.equal((await sharp(objetos.get(clave(2)).Body).metadata()).format, "webp");
  const detalle = await (await fetch(base + "2", { headers })).json();
  assert.deepEqual(detalle.logo, inicial);

  // Retirar: queda el objeto vacío, la respuesta ya no trae logo y la precarga no lo repone
  const baja = await fetch(base + "2/logo", { method: "DELETE", headers });
  assert.equal(baja.status, 200);
  assert.equal((await baja.json()).logo, null);
  assert.equal(objetos.get(clave(2)).ContentLength, 0);
  pasan(31);
  assert.equal(await obtenerLogoPublico(ediciones.get(2)), null);
  assert.equal(objetos.get(clave(2)).ContentLength, 0);

  await t.test("precarga la mascota para 2026 y conserva los cambios de la administración", async () => {
    const ruta = base + "2/mascota";
    const claveMascota = "olimpiadas/ediciones/2/mascota-publica";
    assert.equal(await obtenerMascotaPublica(ediciones.get(4)), null);
    assert.equal((await fetch(ruta, { method: "DELETE", headers: sesion(departamental) })).status, 401);
    assert.equal((await fetch(ruta, { method: "PUT", headers })).status, 400);
    assert.equal((await subir(ruta, Buffer.from("no es una imagen"))).status, 400);
    assert.equal((await fetch(base + "4/mascota", { method: "DELETE" })).status, 401);
    assert.equal((await fetch(base + "9/mascota", { method: "DELETE", headers })).status, 404);

    const [listado, portal] = await Promise.all([
      fetch(base + "publico/ediciones").then(r => r.json()),
      fetch(base + "publico/2/portal").then(r => r.json()),
    ]);
    const inicial = portal.olimpiada.mascota;
    assert.deepEqual(listado[0].mascota, inicial);
    assert.deepEqual([inicial.ancho, inicial.alto], [540, 582]);
    assert.equal(new URL(inicial.url).pathname, "/" + claveMascota);
    const metaMascota = await sharp(objetos.get(claveMascota).Body).metadata();
    assert.deepEqual([metaMascota.format, metaMascota.width, metaMascota.height, metaMascota.hasAlpha], ["webp", 540, 582, true]);
    assert.equal((await fetch(base + "publico/4/portal")).status, 404);
    assert.deepEqual((await (await fetch(base + "2", { headers })).json()).mascota, inicial);

    const alta = await subir(ruta, cuadrado);
    assert.equal(alta.status, 200);
    const { mascota } = await alta.json();
    assert.notEqual(mascota.version, inicial.version);
    assert.deepEqual([mascota.ancho, mascota.alto], [80, 80]);
    assert.deepEqual(await obtenerMascotaPublica(ediciones.get(2)), mascota);
    assert.equal(await obtenerLogoPublico(ediciones.get(2)), null);

    const retirada = await fetch(ruta, { method: "DELETE", headers });
    assert.equal(retirada.status, 200);
    assert.equal((await retirada.json()).mascota, null);
    pasan(31);
    assert.equal(await obtenerMascotaPublica(ediciones.get(2)), null);
    assert.equal(objetos.get(claveMascota).ContentLength, 0);
  });
});
