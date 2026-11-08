"use strict";

// Conteo de stock a ciegas al cerrar la caja, etiquetas de balanza en la caja, paso de los
// productos de balanza a venta por kilo y traspaso de compuestos en porciones.

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const U = require("../lib/util");
const api = require("../lib/api");
const Balanza = require("../public/js/balanza");
const { elegir } = require("../lib/api/conteo");

async function escenario(t) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  t.after(() => db.cerrar());
  asegurarEsquema(db);
  const admin = { db, pid: 1, modo: "local", origen: "LOCAL", ip: "10.0.0.1", usuario: { id: 1, rol: "ADMIN", nombre: "Admin" }, sesion: {} };
  await db.tx(async (tx) => {
    await sembrarPredio(tx, admin, "MIRAMAR");
    await N.insertar(tx, admin, "predio_usuario", { usuario: "admin", nombre: "Admin", rol: "ADMIN", activo: 1 });
    await N.insertar(tx, admin, "predio_usuario", { usuario: "ana", nombre: "Ana", rol: "CAJERO", activo: 1 });
    await N.insertar(tx, admin, "predio_usuario", { usuario: "beto", nombre: "Beto", rol: "CAJERO", activo: 1 });
    await N.insertar(tx, admin, "predio_usuario", { usuario: "sup", nombre: "Supervisión", rol: "SUPERVISOR", activo: 1 });
    await N.insertar(tx, admin, "predio_usuario", { usuario: "sup2", nombre: "Otra supervisión", rol: "SUPERVISOR", activo: 1 });
  });
  const [caja] = await db.all("SELECT * FROM predio_caja ORDER BY id LIMIT 1");
  const otraBoca = (await db.get("SELECT id FROM predio_boca WHERE id <> ? AND es_almacen = 0 ORDER BY id LIMIT 1", [caja.boca_id])).id;
  await db.tx(async (tx) => {
    await N.insertar(tx, admin, "predio_usuario_boca", { usuario_id: 4, boca_id: caja.boca_id });
    await N.insertar(tx, admin, "predio_usuario_boca", { usuario_id: 5, boca_id: otraBoca });
  });
  const llamar = (actor, metodo, ruta, body = {}, query = {}) => api.ejecutar({ ...actor, body, query }, metodo, ruta);
  const post = (actor, ruta, body) => llamar(actor, "POST", ruta, body);
  const get = (actor, ruta, query) => llamar(actor, "GET", ruta, {}, query);
  async function turnoDe(id, nombre) {
    const turno = await N.insertar(db, admin, "predio_turno", { caja_id: caja.id, boca_id: caja.boca_id, usuario_id: id, usuario_nombre: nombre, inicio: U.fechaHora(), estado: "ABIERTO" });
    return { ...admin, ip: "10.0.0.2", usuario: { id, rol: "CAJERO", nombre, bocas: [caja.boca_id] }, sesion: { boca_id: caja.boca_id, caja_id: caja.id, turno_id: turno } };
  }
  const supervisor = { ...admin, usuario: { id: 4, rol: "SUPERVISOR", nombre: "Supervisión", bocas: [caja.boca_id] } };
  const supervisorOtra = { ...admin, usuario: { id: 5, rol: "SUPERVISOR", nombre: "Otra supervisión", bocas: [otraBoca] } };
  const producto = (body) => post(admin, "/productos", { destino: "VENTA_DIRECTA", ...body });
  const mover = (productoId, cantidad, bocaId = caja.boca_id) => db.tx((tx) => N.moverStock(tx, admin, { bocaId, productoId, cantidad, tipo: "AJUSTE" }));
  return { db, admin, caja, otraBoca, post, get, turnoDe, supervisor, supervisorOtra, producto, mover };
}

async function cerrarTemporal(post, get, actor) {
  const previa = await get(actor, "/caja/cierre/previa");
  return post(actor, "/caja/cierre/temporal", {
    efectivo_ventas: previa.resumen.efectivo.esperado_ventas, efectivo_cambio: previa.resumen.efectivo.esperado_cambio,
    revision: previa.revision, turno_id: previa.turno.id, ultimo_cierre_id: previa.resumen.ultimo_cierre?.id ?? null,
  });
}

test("la etiqueta de la balanza trae el código del producto (2 + PLU + 0) y los gramos", () => {
  assert.deepEqual(Balanza.leer("2000140004850"), { etiqueta: "2000140004850", codigo: "2000140", gramos: 485, kg: 0.485, plu: 14 });
  assert.equal(Balanza.leer("2000140010653").kg, 1.065);
  assert.equal(Balanza.leer("2000140010654"), null, "dígito verificador incorrecto");
  assert.equal(Balanza.leer("7790310985830"), null, "un EAN común no es etiqueta");
  assert.equal(Balanza.leer("2000140004850", { balanza_activa: "0" }), null);
  assert.equal(Balanza.codigoDePlu(14), "2000140");
  assert.equal(Balanza.pluDeCodigo("2000107"), null);
});

test("la selección recorre todo el stock de la boca antes de repetir y abre la ronda siguiente", () => {
  const todos = [1, 2, 3, 4, 5].map((id) => ({ id }));
  const primera = elegir(todos, { ronda: 1, contados: new Set() }, 40);
  assert.equal(primera.length, 2);
  assert.ok(primera.every((p) => p.ronda === 1));
  const segunda = elegir(todos, { ronda: 1, contados: new Set(primera.map((p) => p.id)) }, 40);
  assert.ok(segunda.every((p) => !primera.some((x) => x.id === p.id)), "no repite en la misma ronda");
  const contados = new Set([...primera, ...segunda].map((p) => p.id));
  const tercera = elegir(todos, { ronda: 1, contados }, 40);
  assert.equal(tercera.length, 2);
  assert.equal(tercera.filter((p) => p.ronda === 1).length, 1, "el último de la ronda");
  assert.equal(tercera.filter((p) => p.ronda === 2).length, 1, "y uno de la ronda siguiente, sin repetir en la lista");
  assert.notEqual(tercera[0].id, tercera[1].id);
  assert.equal(elegir([{ id: 9 }], { ronda: 3, contados: new Set() }, 1).length, 1, "al menos un producto");
});

test("conteo a ciego al cerrar: no muestra el stock, avisa diferencias a Supervisión y Administración y no repite productos", async (t) => {
  const { db, admin, caja, post, get, turnoDe, supervisor, supervisorOtra, producto, mover } = await escenario(t);
  const agua = await producto({ nombre: "Agua", precio_venta_manual: 1000 });
  const gaseosa = await producto({ nombre: "Gaseosa", precio_venta_manual: 2000 });
  const jamon = await producto({ nombre: "Jamón cocido", codigo: "2000140", unidad: "KG", precio_venta_manual: 22000 });
  const queso = await producto({ nombre: "Queso", precio_venta_manual: 5000 });
  for (const [p, n] of [[agua, 10], [gaseosa, 6], [jamon, 2.5], [queso, 3]]) await mover(p.id, n);

  // Apagado: no se pide nada.
  const ana = await turnoDe(2, "Ana");
  assert.deepEqual(await post(ana, "/conteos/cierre", { caja_id: caja.id }), { requerido: false });
  await api.ejecutar({ ...admin, body: { conteo_cierre_activo: "1", conteo_cierre_porcentaje: "50", conteo_tolerancia_peso: "2" }, query: {} }, "PUT", "/config");

  const pedido = await post(ana, "/conteos/cierre", { caja_id: caja.id });
  assert.equal(pedido.requerido, true);
  assert.equal(pedido.conteo.items.length, 2, "50 % de 4 productos");
  const texto = JSON.stringify(pedido);
  assert.ok(!/sistema|cantidad|stock/i.test(texto), "la lista no trae lo que dice el sistema");
  const repetido = await post(ana, "/conteos/cierre", { caja_id: caja.id });
  assert.equal(repetido.conteo.id, pedido.conteo.id, "volver a abrir el cierre trae la misma lista");

  // Mientras cuenta no puede ver el stock.
  await assert.rejects(get(ana, "/listados/stock"), { status: 423, codigo: "CONTEO_EN_CURSO" });
  await assert.rejects(get(ana, "/stock/disponible", { boca_id: caja.boca_id, producto_id: agua.id }), { codigo: "CONTEO_EN_CURSO" });
  const busqueda = await get(ana, "/productos/buscar", { q: "Agua", venta: "1" });
  assert.equal(busqueda[0].stock_boca, null);
  assert.equal(busqueda[0].stock_oculto, true);
  await assert.rejects(cerrarTemporal(post, get, ana), { codigo: "CONTEO_PENDIENTE" });

  // Cuenta: uno con diferencia y, si salió el jamón, dentro de la tolerancia (2,48 kg ≈ 2,5 kg).
  const reales = { [agua.id]: 10, [gaseosa.id]: 6, [jamon.id]: 2.5, [queso.id]: 3 };
  const items = pedido.conteo.items.map((it, i) => ({
    id: it.id, cantidad: i === 0 ? reales[it.producto_id] - (it.unidad === "KG" ? 0.5 : 2) : (it.unidad === "KG" ? 2.48 : reales[it.producto_id]),
    ingreso: "a mano",
  }));
  await assert.rejects(post(ana, `/conteos/${pedido.conteo.id}/enviar`, { items: items.slice(1) }), { codigo: "CONTEO_INCOMPLETO" });
  const enviado = await post(ana, `/conteos/${pedido.conteo.id}/enviar`, { items });
  assert.equal(enviado.diferencias, 1);
  assert.ok(!/\d+ kg|sistema tenía/.test(enviado.mensaje), "al cajero no se le dice cuánto había");
  await assert.rejects(post(ana, `/conteos/${pedido.conteo.id}/enviar`, { items }), { codigo: "CONTEO_ENVIADO" });
  const avisos = await db.all("SELECT * FROM predio_aviso WHERE tipo = 'CONTEO_DIFERENCIA' ORDER BY id");
  assert.deepEqual(avisos.map((a) => a.usuario_id), [null, 4], "Administración y la supervisión de la boca (no la de otra boca)");
  assert.equal(JSON.parse(avisos[0].detalle).conteo_id, pedido.conteo.id);
  assert.ok((await get(ana, "/listados/stock")).filas.length > 0, "con el conteo enviado vuelve a ver el stock");

  const cierre = await cerrarTemporal(post, get, ana);
  assert.equal((await db.get("SELECT cierre_id FROM predio_conteo WHERE id = ?", [pedido.conteo.id])).cierre_id, cierre.id);
  assert.equal((await get(admin, "/avisos")).conteos_diferencia, 1);

  // El siguiente cajero recibe los dos que faltaban de la vuelta.
  const beto = await turnoDe(3, "Beto");
  const segundo = await post(beto, "/conteos/cierre", { caja_id: caja.id });
  const primeros = new Set(pedido.conteo.items.map((i) => i.producto_id));
  assert.ok(segundo.conteo.items.every((i) => !primeros.has(i.producto_id)), "no repite hasta completar la vuelta");

  // Supervisión de otra boca no lo ve; la de la boca ajusta la diferencia.
  await assert.rejects(get(supervisorOtra, `/conteos/${pedido.conteo.id}`), { status: 403 });
  const detalle = await get(supervisor, `/conteos/${pedido.conteo.id}`);
  const dif = detalle.items.find((i) => i.estado === "DIFERENCIA");
  assert.equal(dif.diferencia, dif.contado - dif.sistema);
  assert.equal(dif.valor, undefined, "el costo lo ve sólo Administración");
  const antes = await N.stockActual(db, admin, caja.boca_id, dif.producto_id);
  await assert.rejects(post(supervisor, `/conteos/${pedido.conteo.id}/resolver`, { items: [{ id: dif.id, accion: "MANTENER" }] }), /por qué/);
  const r = await post(supervisor, `/conteos/${pedido.conteo.id}/resolver`, { items: [{ id: dif.id, accion: "AJUSTAR" }], motivo: "Se contó de nuevo" });
  assert.equal(r.quedan, 0);
  assert.equal(await N.stockActual(db, admin, caja.boca_id, dif.producto_id), U.redondear(antes + dif.diferencia, 3));
  const mov = await db.get("SELECT * FROM predio_movimiento WHERE tipo = 'AJUSTE_CONTEO' AND referencia_id = ?", [pedido.conteo.id]);
  assert.match(mov.detalle, /Conteo N° \d+: Ana contó/);
  assert.equal((await db.get("SELECT estado FROM predio_conteo WHERE id = ?", [pedido.conteo.id])).estado, "REVISADO");
  assert.ok((await db.all("SELECT resuelto_fecha FROM predio_aviso WHERE tipo = 'CONTEO_DIFERENCIA'")).every((a) => a.resuelto_fecha));
  const auditoria = (await db.all("SELECT accion FROM predio_auditoria WHERE entidad = 'conteo' ORDER BY id")).map((a) => a.accion);
  assert.deepEqual(auditoria.slice(0, 3), ["Conteo de stock pedido al cerrar", "Conteo de stock al cierre", "Conteo de stock pedido al cerrar"]);
  assert.ok(auditoria.includes("Revisión de conteo de stock"));

  // El turno que se cierra sin contar anula su conteo (y se puede volver a pedir esos productos).
  await post(admin, "/caja/cierre", { caja_id: caja.id, efectivo_contado: 0, queda_en_caja: 0 });
  assert.equal((await db.get("SELECT estado FROM predio_conteo WHERE id = ?", [segundo.conteo.id])).estado, "ANULADO");
  assert.equal((await get(supervisor, "/conteos/progreso")).bocas.find((b) => b.boca_id === caja.boca_id).contados_ronda, 2);
});

test("la caja vende el jamón con la etiqueta de la balanza: producto, peso y precio por kilo, y queda registrada", async (t) => {
  const { db, caja, post, get, turnoDe, producto, mover } = await escenario(t);
  const jamon = await producto({ nombre: "Jamón cocido", codigo: "2000140", unidad: "KG", destino: "VENTA_COMPUESTA", precio_venta_manual: 22000 });
  await mover(jamon.id, 3);
  const ana = await turnoDe(2, "Ana");
  const [leido] = await get(ana, "/productos/buscar", { q: "2000140004850", venta: "1" });
  assert.equal(leido.id, jamon.id);
  assert.equal(leido.exacto, true);
  assert.equal(leido.sugerido, false, "no se ofrece «corregir» el código del jamón con la etiqueta");
  assert.equal(leido.peso, 0.485);
  assert.equal(leido.unidad, "KG");
  const consulta = await get(ana, "/productos/consultar-codigo", { codigo: "2000140010653" });
  assert.equal(consulta.estado, "DISPONIBLE");
  assert.equal(consulta.producto.peso, 1.065);

  await assert.rejects(post(ana, "/ventas", { items: [{ producto_id: jamon.id, cantidad: 0.5, etiqueta: "2000140004850" }], forma_pago: "EFECTIVO" }),
    { codigo: "ETIQUETA_INVALIDA" });
  const venta = await post(ana, "/ventas", {
    items: [
      { producto_id: jamon.id, cantidad: 0.485, precio_unitario: 22000, etiqueta: "2000140004850" },
      { producto_id: jamon.id, cantidad: 1.065, precio_unitario: 22000, etiqueta: "2000140010653" },
      { producto_id: jamon.id, cantidad: 0.2, precio_unitario: 22000 },
    ],
    forma_pago: "EFECTIVO",
  });
  assert.equal(venta.total, 38500, "1,750 kg × $22.000");
  const item = await db.get("SELECT * FROM predio_venta_item WHERE venta_id = ?", [venta.id]);
  assert.equal(item.unidad, "KG");
  assert.deepEqual(JSON.parse(item.etiquetas), [{ codigo: "2000140004850", kg: 0.485 }, { codigo: "2000140010653", kg: 1.065 }]);
  assert.equal(venta.ticket.items[0].unidad, "KG");
  assert.equal(await N.stockActual(db, { pid: 1 }, caja.boca_id, jamon.id), 1.25);
});

test("los productos de balanza del sistema anterior pasan a venta por kilo: precio × 1.000 y stock en kilos", async (t) => {
  const { db, caja, post, producto, mover, admin } = await escenario(t);
  // Así lo dejó la importación del sistema anterior: precio por gramo, sin redondear.
  const jamon = { id: await db.tx((tx) => N.insertar(tx, admin, "predio_producto", {
    nombre: "JAMON COCIDO", codigo: "2000140", destino: "VENTA_COMPUESTA", precio_compra: 9.91, margen: 122, precio_venta: 22, activo: 1,
    creado_por: "Sistema anterior (importación)",
  })) };
  const ya = await producto({ nombre: "Queso por kilo", codigo: "2000050", unidad: "KG", precio_venta_manual: 17000 });
  await mover(jamon.id, 4500);
  const previa = await post(admin, "/productos/peso/previa", { ids: [jamon.id, ya.id], precio_por: "GRAMO" });
  assert.equal(previa.cambian, 1);
  assert.equal(previa.sin_cambios, 1);
  assert.equal(previa.muestra[0].precio_venta_nuevo, 22000);
  const r = await post(admin, "/productos/peso", { consulta: { f_unidad: "balanza" }, precio_por: "GRAMO" });
  assert.equal(r.cambiados, 1);
  const p = await db.get("SELECT * FROM predio_producto WHERE id = ?", [jamon.id]);
  assert.equal(p.unidad, "KG");
  assert.equal(Number(p.precio_venta), 22000);
  assert.equal(Number(p.precio_compra), 9910);
  assert.equal(await N.stockActual(db, admin, caja.boca_id, jamon.id), 4.5);
  assert.ok(await db.get("SELECT id FROM predio_movimiento WHERE tipo = 'CONVERSION_UNIDAD' AND producto_id = ?", [jamon.id]));
  assert.ok(await db.get("SELECT id FROM predio_auditoria WHERE accion = 'Producto pasado a venta por peso' AND entidad_id = ?", [jamon.id]));
});

test("un compuesto que sale de un insumo se traspasa en porciones y se mueve el insumo", async (t) => {
  const { db, post, producto, mover, admin, caja } = await escenario(t);
  const almacen = await N.bocaAlmacen(db, admin);
  const paquete = await producto({ nombre: "Café en grano 1 kg", destino: "USO_INTERNO" });
  const cafe = await producto({ nombre: "Café", destino: "VENTA_COMPUESTA", precio_venta_manual: 3000, receta: { insumo_id: paquete.id, rendimiento: 60 } });
  await mover(paquete.id, 5, almacen.id);
  const r = await post(admin, "/traspasos", { boca_origen_id: almacen.id, boca_destino_id: caja.boca_id, lineas: [{ producto_id: cafe.id, cantidad: 90 }] });
  const s = await db.get("SELECT * FROM predio_solicitud WHERE id = ?", [r.ids[0]]);
  assert.equal(s.producto_id, paquete.id);
  assert.equal(Number(s.cantidad), 1.5);
  assert.match(s.observaciones, /90 porciones de Café = 1.5 de Café en grano/);
  assert.equal(await N.stockActual(db, admin, caja.boca_id, paquete.id), 1.5);
  assert.equal(await N.stockActual(db, admin, caja.boca_id, cafe.id), 0);
});
