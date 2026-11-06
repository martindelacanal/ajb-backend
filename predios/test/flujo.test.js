"use strict";

// Recorrido completo de la API local: alta de usuarios, catálogo, compras, solicitudes,
// ventas, caja, afiliados, liquidaciones y todos los listados (JSON y CSV).
// Uso: node --test test/

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { claveDelDia } = require("../lib/util");

const RAIZ = path.join(__dirname, "..");
const PUERTO = 18000 + Math.floor(Math.random() * 1000);
const URL_BASE = `http://127.0.0.1:${PUERTO}/api`;
let base;
let servidor;

async function api(metodo, ruta, { token, cuerpo, crudo } = {}) {
  const r = await fetch(`${URL_BASE}${ruta}`, {
    method: metodo,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  if (crudo) return r;
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

test.before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "predio-test-"));
  execFileSync(process.execPath, [path.join(RAIZ, "herramientas", "semilla-local.js"), "--base", base, "--productos"]);
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

test("el acceso descargable usa la dirección de esta PC y un perfil de impresión separado", async () => {
  const url = new URL("/crear-acceso-pc-caja.bat", URL_BASE);
  const r = await fetch(url);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="crear-acceso-pc-caja\.bat"/);
  const bat = await r.text();
  assert.ok(bat.includes('set "AJB_DIRECCION=' + url.origin + '"'));
  assert.match(bat, /--kiosk-printing --use-system-default-printer --user-data-dir=/);
  assert.ok(bat.includes("Start-Process -FilePath $archivo"));
  assert.doesNotMatch(bat, /(?<!\r)\n/);
});

test("flujo completo del camping", async () => {
  const inicial = await ok("POST", "/primer-uso", { cuerpo: { usuario: "admin", nombre: "Admin", password: "secreto1" } });
  const admin = inicial.token;
  const opBocas = await ok("GET", "/opciones/bocas", { token: admin });
  const bocaPorNombre = (n) => opBocas.find((b) => b.texto === n).valor;
  const almacen = bocaPorNombre("Almacén");
  const proveeduria = bocaPorNombre("Proveeduría");
  const limpieza = bocaPorNombre("Limpieza");
  const cajas = await ok("GET", "/opciones/cajas", { token: admin });
  const cajaProv = cajas.find((c) => c.boca_id === proveeduria).valor;

  // Catálogo
  const prov = await ok("POST", "/proveedores", { token: admin, cuerpo: { razon_social: "Distribuidora del Mar", cuit: "20-40756125-3" } });
  const malCuit = await api("POST", "/proveedores", { token: admin, cuerpo: { razon_social: "X", cuit: "20-11111111-1" } });
  assert.equal(malCuit.status, 400);
  const prod = await ok("POST", "/productos", { token: admin, cuerpo: { nombre: "Galletitas de agua", codigo: "7790001", precio_compra: 500, margen: 40, destino: "VENTA_DIRECTA", perecedero: 1, fecha_caducidad: "2027-01-10", cantidad_almacen: 10 } });
  const ficha = await ok("GET", `/productos/${prod.id}`, { token: admin });
  assert.equal(ficha.producto.precio_venta, 700);

  // Compra con error de cuentas y luego correcta
  const mal = await api("POST", "/compras", { token: admin, cuerpo: { proveedor_id: prov.id, factura: "A-0001-1", fecha_factura: "2026-11-01", total_factura: 9999, items: [{ producto_id: prod.id, cantidad: 20, precio_unitario: 550 }] } });
  assert.equal(mal.status, 422);
  assert.match(mal.json.mensaje, /faltan|sobran/);
  const compra = await ok("POST", "/compras", { token: admin, cuerpo: { proveedor_id: prov.id, factura: "A-0001-1", fecha_factura: "2026-11-01", remito: "R-1", fecha_remito: "2026-11-01", total_factura: 11000, items: [{ producto_id: prod.id, cantidad: 20, precio_unitario: 550, actualizar_precio: true }] } });
  const detCompra = await ok("GET", `/compras/${compra.id}`, { token: admin });
  assert.equal(detCompra.items[0].precio_anterior, 500);
  const ficha2 = await ok("GET", `/productos/${prod.id}`, { token: admin });
  assert.equal(ficha2.producto.precio_venta, 800);
  const dup = await api("POST", "/compras", { token: admin, cuerpo: { proveedor_id: prov.id, factura: "A-0001-1", fecha_factura: "2026-11-01", total_factura: 550, items: [{ producto_id: prod.id, cantidad: 1, precio_unitario: 550 }] } });
  assert.equal(dup.status, 409);

  // Usuario de boca
  await ok("POST", "/usuarios", { token: admin, cuerpo: { usuario: "caja.prov", nombre: "Cajera Proveeduría", rol: "CAJERO", password: "clave12", bocas: [proveeduria] } });
  const cajero = (await ok("POST", "/login", { cuerpo: { usuario: "caja.prov", password: "clave12", recordar: 1 } })).token;
  await ok("POST", "/sesion/puesto", { token: cajero, cuerpo: { boca_id: proveeduria, caja_id: cajaProv } });

  // Solicitud: sin autorización -> 403; con clave del día -> ok
  const sinAut = await api("POST", "/solicitudes", { token: cajero, cuerpo: { boca_origen_id: almacen, boca_destino_id: proveeduria, lineas: [{ producto_id: prod.id, cantidad: 5 }] } });
  assert.equal(sinAut.status, 403);
  assert.equal(sinAut.json.codigo, "SIN_AUTORIZACION");
  const mucho = await api("POST", "/solicitudes", { token: cajero, cuerpo: { boca_origen_id: almacen, boca_destino_id: proveeduria, lineas: [{ producto_id: prod.id, cantidad: 500 }], clave: claveDelDia() } });
  assert.equal(mucho.status, 409);
  assert.equal(mucho.json.codigo, "STOCK_INSUFICIENTE");
  const sol = await ok("POST", "/solicitudes", { token: cajero, cuerpo: { boca_origen_id: almacen, boca_destino_id: proveeduria, lineas: [{ producto_id: prod.id, cantidad: 5 }], clave: claveDelDia() } });
  assert.equal((await api("POST", `/solicitudes/${sol.ids[0]}/despachar`, { token: cajero, cuerpo: {} })).status, 403);
  await ok("POST", `/solicitudes/${sol.ids[0]}/despachar`, { token: admin, cuerpo: {} });
  await ok("POST", `/solicitudes/${sol.ids[0]}/recibir`, { token: cajero, cuerpo: {} });
  const disp = await ok("GET", `/stock/disponible?boca_id=${proveeduria}&producto_id=${prod.id}`, { token: cajero });
  assert.equal(disp.cantidad, 5);

  // Permiso remoto
  const pedido = await ok("POST", "/permisos", { token: cajero, cuerpo: { tipo: "SOLICITUD_PRODUCTO" } });
  await ok("POST", `/permisos/${pedido.id}/resolver`, { token: admin, cuerpo: { aprobar: 1 } });
  await ok("POST", "/solicitudes", { token: cajero, cuerpo: { boca_origen_id: almacen, boca_destino_id: proveeduria, lineas: [{ producto_id: prod.id, cantidad: 1 }], permiso_id: pedido.id } });

  // Traspaso directo con baja automática a Limpieza
  const lavandina = (await ok("GET", "/productos/buscar?q=lavandina", { token: admin }))[0];
  await ok("POST", "/traspasos", { token: admin, cuerpo: { boca_origen_id: almacen, boca_destino_id: limpieza, lineas: [{ producto_id: lavandina.id, cantidad: 4 }], baja_automatica: 1 } });
  const dispLimp = await ok("GET", `/stock/disponible?boca_id=${limpieza}&producto_id=${lavandina.id}`, { token: admin });
  assert.equal(dispLimp.cantidad, 0);

  // Baja por vencimiento
  await ok("POST", "/bajas", { token: admin, cuerpo: { boca_id: almacen, producto_id: prod.id, cantidad: 1, motivo: "VENCIMIENTO" } });

  // Caja: apertura, verificación, venta en efectivo con vuelto, escáner por código
  const apertura = await ok("POST", "/caja/apertura", { token: admin, cuerpo: { caja_id: cajaProv, importe: 5000 } });
  await ok("POST", `/caja/apertura/${apertura.id}/verificar`, { token: cajero, cuerpo: { correcto: 1 } });
  const escaneado = await ok("GET", `/productos/buscar?q=7790001&boca_id=${proveeduria}&venta=1`, { token: cajero });
  assert.equal(escaneado[0].exacto, true);
  // Un cajero que no es del almacén no ve costos ni márgenes.
  assert.equal(escaneado[0].precio_compra, undefined);
  const metaStock = await ok("GET", "/listados/stock/meta", { token: cajero });
  assert.ok(!metaStock.columnas.some((c) => c.clave === "valor"));
  assert.equal((await api("GET", "/listados/productos", { token: cajero })).status, 403);
  const venta = await ok("POST", "/ventas", { token: cajero, cuerpo: { items: [{ producto_id: prod.id, cantidad: 2 }], forma_pago: "EFECTIVO", recibido: 2000 } });
  assert.equal(venta.total, 1600);
  assert.equal(venta.vuelto, 400);
  const estado = await ok("GET", "/caja/estado", { token: cajero });
  assert.equal(estado.resumen.saldo_esperado, 6600);

  // Los tickets anteriores se siguen liquidando e imprimiendo. La caja nueva
  // sólo acepta saldo autorizado en la estadía.
  const af = await ok("POST", "/afiliados", { token: admin, cuerpo: { dni: "30111222", legajo: "4455", nombre: "Pérez, Ana", limite: 2000 } });
  const busq = await ok("GET", "/afiliados/buscar?q=4455", { token: cajero });
  assert.equal(busq.resultados[0].disponible, 2000);
  const autorizacionFirmada = "Autorización del Camping Miramar.\nSUMA: SETECIENTOS SETENTA PESOS ($ 770,00)";
  const historica = require("../lib/db-sqlite").crearSqlite(path.join(base, "datos", "predio.db"), { predioId: 1 });
  let ventaAnteriorId;
  try {
    ventaAnteriorId = await historica.tx(tx => require("../lib/negocio").insertar(tx, { pid: 1 }, "predio_venta", {
      fecha: "2025-01-10 10:00:00", boca_id: proveeduria, caja_id: cajaProv, estado: "CONFIRMADA", forma_pago: "DESCUENTO",
      afiliado_id: af.id, afiliado_legajo: "4455", afiliado_nombre: "Pérez, Ana", afiliado_dni: "30111222",
      total: 770, importe_haberes: 770, saldo_disponible: 1230, autorizacion_descuento: autorizacionFirmada,
    }));
  } finally { historica.cerrar(); }
  for (const medioAnterior of [{ devolucion: 1 }, { forma_pago: "DESCUENTO" }]) {
    const rechazada = await api("POST", "/ventas", { token: cajero, cuerpo: {
      items: [{ producto_id: prod.id, cantidad: 1 }], afiliado_id: af.id, ...medioAnterior,
    } });
    assert.equal(rechazada.status, 400);
    assert.match(rechazada.json.mensaje, /Elegí Saldo/);
  }
  const qr = await ok("POST", "/ventas", { token: cajero, cuerpo: { items: [{ producto_id: prod.id, cantidad: 1 }], forma_pago: "QR", codigo_pago: "MP-123" } });

  // Anulación con clave
  const sinClave = await api("POST", `/ventas/${qr.id}/anular`, { token: cajero, cuerpo: { motivo: "Error" } });
  assert.equal(sinClave.status, 403);
  await ok("POST", `/ventas/${qr.id}/anular`, { token: cajero, cuerpo: { motivo: "Error de carga", clave: claveDelDia() } });
  await ok("POST", `/ventas/${venta.id}/impresion`, { token: cajero, cuerpo: {} });

  // Ajuste y cierre
  await ok("POST", "/caja/ajuste", { token: admin, cuerpo: { caja_id: cajaProv, concepto: "RETIRO_DINERO", tipo: "EGRESO", importe: 1000, recibo: "R-9" } });
  const previa = await ok("GET", "/caja/cierre/previa", { token: cajero });
  assert.equal(previa.resumen.saldo_esperado, 5600);
  const cierre = await ok("POST", "/caja/cierre", { token: cajero, cuerpo: { efectivo_contado: 5500, queda_en_caja: 500 } });
  assert.equal(cierre.diferencia, -100);
  const { caja } = await ok("GET", `/cajas/${cajaProv}`, { token: admin });
  await ok("PUT", `/cajas/${cajaProv}`, { token: admin, cuerpo: { ...caja, ancho_ticket: 58 } });
  const ticketCierre = await ok("GET", `/caja/cierres/${cierre.id}`, { token: cajero });
  assert.equal(ticketCierre.ancho, 58);
  const estado2 = await ok("GET", "/caja/estado", { token: cajero });
  assert.equal(estado2.resumen.saldo_esperado, 500);

  // Liquidación y modificación masiva
  const liq = await ok("POST", `/afiliados/${af.id}/liquidaciones`, { token: admin, cuerpo: { forma_pago: "DESCUENTO_HABERES", porcentaje_descuento: 10, cuotas: 3 } });
  assert.equal(liq.total, 693);
  assert.equal(liq.valor_cuota, 231);
  const prev = await ok("POST", "/afiliados/limites/previa", { token: admin, cuerpo: { filtros: { limite: "gte:1000" } } });
  assert.equal(prev.cantidad, 1);
  await ok("POST", "/afiliados/limites/masivo", { token: admin, cuerpo: { filtros: { limite: "gte:1000" }, nuevo_limite: 50000 } });
  await ok("PUT", `/afiliados/${af.id}`, { token: admin, cuerpo: { nombre: "Ana Pérez", legajo: "4455-B" } });
  await ok("PUT", "/config", { token: admin, cuerpo: { texto_autorizacion: "", razon_social: "Asociación del Camping" } });
  const reimpresa = await ok("POST", `/ventas/${ventaAnteriorId}/impresion`, { token: cajero, cuerpo: {} });
  assert.equal(reimpresa.afiliado.nombre, "Pérez, Ana");
  assert.equal(reimpresa.afiliado.legajo, "4455");
  assert.equal(reimpresa.afiliado.disponible, 1230);
  assert.equal(reimpresa.empresa.texto_autorizacion, autorizacionFirmada);

  // Todos los listados en JSON, CSV completo y CSV resumido
  const nombres = ["productos", "stock", "proveedores", "compras", "compras_productos", "solicitudes", "bajas", "movimientos", "ventas",
    "ventas_productos", "caja", "cierres", "afiliados", "liquidaciones", "usuarios", "bocas", "cajas", "auditoria", "permisos", "limites"];
  for (const n of nombres) {
    const meta = await ok("GET", `/listados/${n}/meta`, { token: admin });
    assert.ok(meta.columnas.length, n);
    const pagina = await ok("GET", `/listados/${n}?q=a&orden=${meta.columnas[0].clave}&dir=desc`, { token: admin });
    assert.ok(Array.isArray(pagina.filas), n);
    assert.equal(pagina.tam, 10, n);
    const csv = await api("GET", `/listados/${n}?formato=csv`, { token: admin, crudo: true });
    assert.equal(csv.status, 200, n);
    for (const g of meta.resumen) {
      const r = await api("GET", `/listados/${n}?formato=csv&modo=resumen&grupo=${g.clave}`, { token: admin, crudo: true });
      assert.equal(r.status, 200, `${n} resumen ${g.clave}: ${await r.text()}`);
    }
  }
  await ok("GET", `/listados/afiliado_consumos?f_afiliado=${af.id}`, { token: admin });
  const ventasCajero = await ok("GET", "/listados/ventas", { token: cajero });
  assert.ok(ventasCajero.total >= 2);
  assert.ok(ventasCajero.filas.some(v => v.estado === "ANULADA" && v.id === qr.id));
  assert.equal((await api("GET", "/listados/ventas?ambito=caja", { token: cajero })).status, 403);
  const otroTurno = await ok("GET", "/listados/ventas?ambito=turno", { token: admin });
  assert.equal(otroTurno.total, 0, "el administrador no atendió ninguna venta en ese turno");
  const unaCaja = await ok("GET", `/listados/ventas?f_caja=${cajaProv}&tam=25`, { token: admin });
  assert.equal(unaCaja.tam, 25);
  assert.ok(unaCaja.filas.some(v => v.id === qr.id));
  await ok("POST", `/compras/${compra.id}/anular`, { token: admin, cuerpo: { motivo: "Factura anulada" } });
  for (const lista of ["compras", "compras_productos"]) {
    const todo = await ok("GET", "/listados/" + lista, { token: admin });
    assert.ok(todo.filas.some(f => f.estado === "ANULADA"), lista);
    const cargadas = await ok("GET", "/listados/" + lista + "?f_estado=CARGADA", { token: admin });
    assert.equal(cargadas.filas.some(f => f.estado === "ANULADA"), false, lista);
  }
  const est = await ok("GET", "/estadisticas", { token: admin });
  assert.equal(est.kpi.ventas, 1); // Sólo la venta en efectivo sigue confirmada dentro del período.
  await ok("GET", "/inicio", { token: admin });
  await ok("GET", "/avisos", { token: admin });
  await ok("GET", "/avisos", { token: cajero });
  const sistema = await ok("GET", "/sistema/estado", { token: admin });
  assert.ok(sistema.servidor.version);
  const exp = await api("GET", "/sistema/exportar", { token: admin, crudo: true });
  assert.equal(exp.status, 200);
  assert.equal((await api("GET", "/sistema/estado", { token: cajero })).status, 403);
});
