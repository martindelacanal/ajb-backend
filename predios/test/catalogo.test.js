"use strict";

// Importación del catálogo del sistema anterior y eliminación de productos y proveedores
// (de a uno, varios elegidos o todos los de un filtro).

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");

const RAIZ = path.join(__dirname, "..");
const PUERTO = 19000 + Math.floor(Math.random() * 1000);
const URL_BASE = `http://127.0.0.1:${PUERTO}/api`;
let base;
let servidor;

const CATALOGO = {
  proveedores: [
    { codigo: "0012", razon_social: "Sancor", cuit: "20-40756125-3", telefono: "2291 400000", email: "ventas@sancor.example" },
    { codigo: "0085", razon_social: "Adyar", cuit: "0" },
    { codigo: "0099", razon_social: "Sancor" },
  ],
  productos: [
    { nombre: "COCA COLA 1 1/2", codigo: "779089500043", precio_compra: 3300, margen: 30, precio_venta: 4000, destino: "VENTA_DIRECTA", referencia: { fecha: "2026-10-12", precio_compra: 3300, precio_venta: 4000 } },
    { nombre: "MILANESA NAPOLITANA C/GUARNICION", codigo: null, precio_compra: 0, margen: 0, precio_venta: 0, destino: "VENTA_COMPUESTA", referencia: { fecha: "2025-02-15", precio_venta: 9000 } },
    { nombre: "DESAYUNO COMPLETO", codigo: "46733", precio_venta: 5000, destino: "VENTA_COMPUESTA" },
    { nombre: "LAVANDINA AYUDIN 1LT", codigo: "7790990000099", precio_compra: 900, margen: 0, precio_venta: 0, destino: "USO_INTERNO", perecedero: 0 },
    { nombre: "Agua mineral 500 ml", codigo: "999" },
    { nombre: "OTRA COCA", codigo: "779089500043", precio_venta: 1 },
  ],
};

async function api(metodo, ruta, { token, cuerpo } = {}) {
  const r = await fetch(`${URL_BASE}${ruta}`, {
    method: metodo,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  let json;
  try { json = JSON.parse(texto); } catch (_e) { json = texto; }
  return { status: r.status, json };
}

async function ok(metodo, ruta, opciones) {
  const r = await api(metodo, ruta, opciones);
  assert.ok(r.status < 300, `${metodo} ${ruta} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

function importar(aplicar) {
  const archivo = path.join(base, "catalogo.json");
  fs.writeFileSync(archivo, JSON.stringify(CATALOGO));
  const args = [path.join(RAIZ, "herramientas", "importar-catalogo.js"), "--base", base, "--archivo", archivo];
  if (aplicar) args.push("--aplicar");
  return execFileSync(process.execPath, args, { encoding: "utf8" });
}

test.before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "predio-catalogo-"));
  execFileSync(process.execPath, [path.join(RAIZ, "herramientas", "semilla-local.js"), "--base", base, "--productos"]);
  const simulacion = importar(false);
  assert.match(simulacion, /productos: 4/);
  assert.match(simulacion, /Simulación/);
  importar(true);
  servidor = spawn(process.execPath, [path.join(RAIZ, "servidor.js"), "--base", base, "--puerto", String(PUERTO)], { stdio: "pipe" });
  servidor.stderr.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${URL_BASE}/estado-publico`); return; } catch (_e) { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error("El servidor no arrancó");
});

test.after(() => {
  servidor.kill();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_e) { /* Windows */ }
});

test("importa el catálogo y elimina de a uno, varios o por filtro", async () => {
  const admin = (await ok("POST", "/primer-uso", { cuerpo: { usuario: "admin", nombre: "Admin", password: "secreto1" } })).token;

  // Lo importado: 4 productos (el agua ya existía y la otra coca repite el código), 2 proveedores.
  const importados = await ok("GET", "/listados/productos?f_origen=importado", { token: admin });
  assert.equal(importados.total, 4);
  const porNombre = (n) => importados.filas.find((f) => f.nombre === n);
  const coca = porNombre("COCA COLA 1 1/2");
  const milanesa = porNombre("MILANESA NAPOLITANA C/GUARNICION");
  const desayuno = porNombre("DESAYUNO COMPLETO");
  assert.equal(coca.precio_venta, 4000);
  assert.equal(coca.precio_compra, 3300);
  const sinPrecio = await ok("GET", "/listados/productos?f_origen=importado&f_precio=sin", { token: admin });
  assert.equal(sinPrecio.total, 2);
  const ficha = await ok("GET", `/productos/${milanesa.id}`, { token: admin });
  assert.equal(ficha.precios[0].origen, "IMPORTACION");
  assert.equal(ficha.precios[0].precio_venta, 9000);
  assert.equal(ficha.producto.creado_por, "Sistema anterior (importación)");
  const provs = await ok("GET", "/listados/proveedores?f_origen=importado", { token: admin });
  assert.equal(provs.total, 2);
  const sancor = provs.filas.find((p) => p.razon_social === "Sancor");
  assert.equal(sancor.cuit, "20-40756125-3");

  // Volver a importar no duplica nada.
  assert.match(importar(true), /productos: 0/);

  // La caja no vende productos sin precio.
  const opBocas = await ok("GET", "/opciones/bocas", { token: admin });
  const proveeduria = opBocas.find((b) => b.texto === "Proveeduría").valor;
  const cajaProv = (await ok("GET", "/opciones/cajas", { token: admin })).find((c) => c.boca_id === proveeduria).valor;
  await ok("POST", "/usuarios", { token: admin, cuerpo: { usuario: "caja.prov", nombre: "Cajera", rol: "CAJERO", password: "clave12", bocas: [proveeduria] } });
  const cajero = (await ok("POST", "/login", { cuerpo: { usuario: "caja.prov", password: "clave12" } })).token;
  await ok("POST", "/sesion/clave", { token: cajero, cuerpo: { actual: "clave12", nueva: "Venta-fixture" } });
  await ok("POST", "/sesion/puesto", { token: cajero, cuerpo: { boca_id: proveeduria, caja_id: cajaProv } });
  const apertura = await ok("POST", "/caja/apertura", { token: admin, cuerpo: { caja_id: cajaProv, importe: 1000 } });
  await ok("POST", `/caja/apertura/${apertura.id}/verificar`, { token: cajero, cuerpo: { correcto: 1 } });
  const sinPrecioVenta = await api("POST", "/ventas", { token: cajero, cuerpo: { items: [{ producto_id: milanesa.id, cantidad: 1 }], forma_pago: "QR" } });
  assert.equal(sinPrecioVenta.status, 409);
  assert.equal(sinPrecioVenta.json.codigo, "SIN_PRECIO");
  await ok("PUT", `/productos/${desayuno.id}`, { token: admin, cuerpo: { cantidad_almacen: 1 } });
  const almacen = opBocas.find(b => b.es_almacen).valor;
  if (almacen !== proveeduria) await ok("POST", "/traspasos", { token: admin, cuerpo: {
    boca_origen_id: almacen, boca_destino_id: proveeduria, producto_id: desayuno.id, cantidad: 1,
  } });
  await ok("POST", "/ventas", { token: cajero, cuerpo: { items: [{ producto_id: desayuno.id, cantidad: 1 }], forma_pago: "QR" } });

  // Un cajero no puede eliminar.
  assert.equal((await api("POST", "/productos/eliminar", { token: cajero, cuerpo: { ids: [coca.id] } })).status, 403);

  // De a varios: el que se vendió se da de baja, el que nunca se usó se borra.
  const previa = await ok("POST", "/productos/eliminar/previa", { token: admin, cuerpo: { ids: [desayuno.id, milanesa.id] } });
  assert.equal(previa.cantidad, 2);
  assert.equal(previa.se_borran, 1);
  assert.equal(previa.se_dan_de_baja, 1);
  assert.deepEqual(previa.muestra_baja[0].usos, almacen === proveeduria ? ["ventas", "movimientos"] : ["ventas", "solicitudes", "movimientos"]);
  const r1 = await ok("POST", "/productos/eliminar", { token: admin, cuerpo: { ids: [desayuno.id, milanesa.id] } });
  assert.equal(r1.eliminados, 1);
  assert.equal(r1.dados_de_baja, 1);
  assert.equal((await api("GET", `/productos/${milanesa.id}`, { token: admin })).status, 404);
  assert.equal((await ok("GET", `/productos/${desayuno.id}`, { token: admin })).producto.activo, 0);

  // Por filtro: todos los importados que nunca se usaron (queda la coca, que tiene stock cargado a mano).
  await ok("PUT", `/productos/${coca.id}`, { token: admin, cuerpo: { cantidad_almacen: 12 } });
  const consulta = { f_origen: "importado", f_uso: "nunca", f_activo: "1" };
  const previaFiltro = await ok("POST", "/productos/eliminar/previa", { token: admin, cuerpo: { consulta } });
  assert.equal(previaFiltro.cantidad, 2);
  assert.equal(previaFiltro.se_borran, 2);
  await ok("POST", "/productos/eliminar", { token: admin, cuerpo: { consulta } });
  const quedan = await ok("GET", "/listados/productos?f_origen=importado&f_activo=todos", { token: admin });
  assert.deepEqual(quedan.filas.map((f) => f.nombre), ["DESAYUNO COMPLETO"]);
  const stock = await ok("GET", "/listados/stock?f_estado=todos", { token: admin });
  assert.ok(!stock.filas.some((f) => f.producto === "COCA COLA 1 1/2"));

  // Proveedores: el que tiene una compra se da de baja, el otro se borra.
  const agua = (await ok("GET", "/listados/productos?q=agua", { token: admin })).filas[0];
  await ok("POST", "/compras", { token: admin, cuerpo: { proveedor_id: sancor.id, factura: "B-1", fecha_factura: "2026-11-01", total_factura: 3500, items: [{ producto_id: agua.id, cantidad: 10, precio_unitario: 350 }] } });
  const ids = provs.filas.map((p) => p.id);
  const r2 = await ok("POST", "/proveedores/eliminar", { token: admin, cuerpo: { ids } });
  assert.equal(r2.eliminados, 1);
  assert.equal(r2.dados_de_baja, 1);
  const provsDespues = await ok("GET", "/listados/proveedores?f_activo=todos&f_origen=importado", { token: admin });
  assert.deepEqual(provsDespues.filas.map((p) => [p.razon_social, p.activo]), [["Sancor", 0]]);

  // La auditoría registra cada eliminación.
  const auditoria = await ok("GET", "/listados/auditoria?q=Eliminación", { token: admin });
  assert.ok(auditoria.total >= 4);
});

test("las claves iniciales y restablecidas exigen rotación y los permisos se configuran por separado", async () => {
  const admin = (await ok("POST", "/login", { cuerpo: { usuario: "admin", password: "secreto1" } })).token;
  const boca = (await ok("GET", "/opciones/bocas", { token: admin }))[0].valor;
  const base = { usuario: "prueba", nombre: "Usuario de prueba", rol: "CAJERO", bocas: [boca] };
  for (const password of ["1234", "111111", "123456", "121212", "password", "prueba"]) {
    assert.equal((await api("POST", "/usuarios", { token: admin, cuerpo: { ...base, password } })).status, 400, password);
  }
  const { id } = await ok("POST", "/usuarios", { token: admin, cuerpo: { ...base, password: "Inicial-z9", puede_anular_ticket: true } });
  const login = await ok("POST", "/login", { cuerpo: { usuario: base.usuario, password: "Inicial-z9" } });
  assert.equal(login.usuario.debe_cambiar_clave, true);
  assert.equal((await ok("GET", "/estado-publico", { token: login.token })).configurado, true);
  for (const ruta of ["/listados/ventas", "/sistema/estado"]) {
    assert.equal((await api("GET", ruta, { token: login.token })).json.codigo, "CAMBIO_CLAVE_OBLIGATORIO");
  }
  assert.equal((await api("POST", "/sesion/puesto", { token: login.token, cuerpo: { boca_id: boca } })).status, 403);
  for (const nueva of ["111111", "Inicial-z9"]) {
    assert.equal((await api("POST", "/sesion/clave", { token: login.token, cuerpo: { actual: "Inicial-z9", nueva } })).status, 400);
  }
  await ok("POST", "/sesion/clave", { token: login.token, cuerpo: { actual: "Inicial-z9", nueva: "Personal-z2" } });
  assert.equal((await ok("GET", "/sesion", { token: login.token })).usuario.debe_cambiar_clave, false);
  for (const [cierre, anular] of [[false, true], [true, false], [true, true], [false, false]]) {
    await ok("PUT", "/usuarios/" + id, { token: admin, cuerpo: { ...base, puede_cerrar_caja: cierre, puede_anular_ticket: anular } });
    const sesion = await ok("GET", "/sesion", { token: login.token });
    assert.equal(sesion.usuario.puede_cerrar_caja, cierre);
    assert.equal(sesion.usuario.puede_anular_ticket, anular);
  }
  await ok("PUT", "/usuarios/" + id, { token: admin, cuerpo: { ...base, password: "Reset-z3" } });
  assert.equal((await api("GET", "/sesion", { token: login.token })).status, 401);
  const nuevo = await ok("POST", "/login", { cuerpo: { usuario: base.usuario, password: "Reset-z3" } });
  assert.equal(nuevo.usuario.debe_cambiar_clave, true);
});

test("galería del ingreso y dirección por nombre", async () => {
  const admin = (await ok("POST", "/login", { cuerpo: { usuario: "admin", password: "secreto1" } })).token;

  // Sin sistema general configurado no hay fotos: el ingreso muestra el logo.
  const galeria = await ok("GET", "/login/imagenes");
  assert.deepEqual(galeria.imagenes, []);
  assert.equal((await api("GET", "/login/imagen/0123456789abcdef.png")).status, 404);
  assert.equal((await api("GET", "/login/imagen/..%2Fconfig.json")).status, 404);

  // La dirección con el nombre de la notebook aparece en el estado del sistema.
  const estado = await ok("GET", "/sistema/estado", { token: admin });
  assert.match(estado.red.por_nombre, /^http:\/\/[a-z0-9-]+:\d+$/);
  const malNombre = await api("POST", "/sistema/red", { token: admin, cuerpo: { nombre: "camping; shutdown" } });
  assert.equal(malNombre.status, 400);
});
