"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const api = require("../lib/api");

const resolver = () => new Promise(resolve => setImmediate(resolve));

// Se ejecuta el formulario real; sólo se reemplaza el DOM. Los guardados pasan
// por la API y SQLite para detectar también cambios involuntarios de precios.
async function pantalla(t, { nuevo = false, producto = {}, fechas } = {}) {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, modo: "local", origen: "LOCAL", usuario: { id: 1, nombre: "Administración", rol: "ADMIN", bocas: [] }, sesion: {} };
  await db.tx(tx => sembrarPredio(tx, ctx, "MIRAMAR"));
  const llamar = (metodo, ruta, body = {}) => api.ejecutar({ ...ctx, body, query: {} }, metodo, ruta);
  let id;
  if (!nuevo) {
    ({ id } = await llamar("POST", "/productos", {
      nombre: "Producto con precio guardado", codigo: "INTERNO-1", precio_compra: 100, margen: 40,
      precio_venta_manual: 999, destino: "VENTA_DIRECTA", cantidad_almacen: 4, ...producto,
    }));
    await db.run("UPDATE predio_producto SET fecha_revision_precio = '2026-01-01 10:00:00' WHERE id = ?", [id]);
    if (fechas) await db.run("UPDATE predio_producto SET fecha_creacion = ?, fecha_modificacion = ?, creado_por = ?, modificado_por = ? WHERE id = ?",
      [fechas.creacion, fechas.modificacion, "Sistema anterior (importación)", "Sistema actual", id]);
  }

  const campos = new Map(), checks = new Map(), escritos = [], errores = [], guardados = [];
  let modal, enfocado;
  class Nodo {
    constructor(tag, clases = []) {
      this.tag = tag; this.clases = clases; this.hijos = []; this.events = {}; this.style = {};
      this.value = ""; this.checked = false; this.readOnly = false;
      this.classList = {
        add: (...nombres) => this.clases.push(...nombres),
        toggle: (nombre, activo) => {
          this.clases = this.clases.filter(c => c !== nombre);
          if (activo) this.clases.push(nombre);
        },
      };
    }
    appendChild(n) { this.hijos.push(n); return n; }
    addEventListener(tipo, fn) { (this.events[tipo] ||= []).push(fn); }
    disparar(tipo, datos = {}) {
      for (const fn of this.events[tipo] || []) fn({ currentTarget: this, preventDefault() {}, ...datos });
    }
    focus() { enfocado = this; }
    get textContent() { return this.hijos.map(n => n instanceof Nodo ? n.textContent : String(n)).join(""); }
    set textContent(texto) { this.hijos = [texto]; }
    querySelector(tag) {
      for (const n of this.hijos) if (n instanceof Nodo) {
        if (n.tag === tag) return n;
        const encontrado = n.querySelector(tag);
        if (encontrado) return encontrado;
      }
      return null;
    }
  }
  function h(nombre, attrs, ...hijos) {
    const [tag, ...clases] = nombre.split(".");
    const n = new Nodo(tag, clases);
    if (attrs instanceof Nodo || Array.isArray(attrs) || typeof attrs !== "object" || attrs === null) {
      hijos.unshift(attrs); attrs = {};
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "style") Object.assign(n.style, v);
      else n[k] = v;
    }
    for (const hijo of hijos.flat(Infinity)) if (hijo !== null && hijo !== undefined && hijo !== false) n.appendChild(hijo);
    return n;
  }
  const numero = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 });
  const P = {
    h,
    ruta: { registrar() {} },
    f: {
      numero: v => numero.format(Number(v) || 0), cantidad: (v, unidad) => numero.format(Number(v) || 0) + (unidad === "KG" ? " kg" : ""), pesos: v => "$ " + numero.format(Number(v) || 0), pct: v => numero.format(v) + " %",
      fechaHora(v) {
        if (!v) return "";
        const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v));
        return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : String(v);
      },
    },
    numeroDe(v) {
      let texto = String(v ?? "").trim();
      if (!texto) return NaN;
      if (texto.includes(",")) texto = texto.replace(/\./g, "").replace(",", ".");
      return Number(texto);
    },
    redondear: v => Math.round((Number(v) + Number.EPSILON) * 100) / 100,
    precioDeVenta: require("../public/js/precio-venta"),
    importeDe(v) { return P.numeroDe(v); },
    input: (op = {}) => h("input", { value: op.valor ?? "", readOnly: !!op.soloLectura, type: op.tipo || "text" }),
    dinero: op => P.input(op),
    select: (_opciones, valor) => h("select", { value: valor }),
    campo(etiqueta, control, opciones = {}) {
      const campo = h("label", etiqueta, control, opciones.ayuda || null);
      campos.set(etiqueta, campo);
      return campo;
    },
    check(texto, marcado, ayuda, alCambiar) {
      const input = h("input", { type: "checkbox", checked: !!marcado });
      if (alCambiar) input.addEventListener("change", () => alCambiar(input.checked));
      checks.set(texto, input);
      const label = h("label", input, texto, ayuda);
      label.input = input;
      return label;
    },
    segmentado: (_opciones, valor) => {
      const el = h("nav");
      el.valor = () => valor;
      el.fijar = (v) => { valor = v; };
      return el;
    },
    balanza: require("../public/js/balanza"),
    btn: (texto, op) => h("button", { onclick: op.onclick }, texto),
    modal(op) { modal = op; return { cerrar() {} }; },
    get: ruta => llamar("GET", ruta),
    opciones: tipo => llamar("GET", "/opciones/" + tipo),
    async put(ruta, body) { escritos.push({ metodo: "PUT", ruta, body }); return llamar("PUT", ruta, body); },
    async post(ruta, body) { escritos.push({ metodo: "POST", ruta, body }); return llamar("POST", ruta, body); },
    ejecutar: (_boton, fn) => Promise.resolve().then(fn).catch(e => { errores.push(e); throw e; }),
    aviso() {}, olvidarOpciones() {}, error: e => errores.push(e),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/pantallas/gestion.js"), "utf8"), { window: { P } });
  P.formProducto(nuevo ? {} : { id }, resultado => guardados.push(resultado));
  await resolver();
  assert.deepEqual(errores, []);
  assert.ok(modal, "el formulario abre sin errores");
  const control = etiqueta => {
    const input = campos.get(etiqueta)?.querySelector("input");
    assert.ok(input, etiqueta);
    return input;
  };
  return {
    P, db, id, control, checks, escritos, modal,
    escribir(etiqueta, valor) { const input = control(etiqueta); input.value = valor; input.disparar("input"); },
    manual(marcado) { const input = checks.get("Fijar el precio de venta a mano"); input.checked = marcado; input.disparar("change"); },
    get enfocado() { return enfocado; },
    async guardar() {
      modal.acciones.find(b => b && /^(Guardar cambios|Crear producto)$/.test(b.textContent)).disparar("click");
      await resolver();
      assert.deepEqual(errores, []);
      assert.equal(guardados.length, 1, "termina el guardado por la API");
      return escritos.at(-1).body;
    },
    ficha: () => db.get("SELECT * FROM predio_producto WHERE id = ?", [id]),
  };
}

test("editar sólo el nombre conserva el precio fijado, su revisión y el stock con manual desmarcado", async t => {
  const s = await pantalla(t);
  assert.equal(s.checks.get("Fijar el precio de venta a mano").checked, false);
  assert.equal(s.control("Precio de venta").readOnly, true);
  assert.equal(s.P.numeroDe(s.control("Precio de venta").value), 1000);
  s.escribir("Nombre", "Nombre corregido");
  const body = await s.guardar();
  for (const clave of ["precio_compra", "margen", "precio_venta_manual", "margenes_boca", "cantidad_almacen", "confirmar_revision_precio"]) assert.equal(Object.hasOwn(body, clave), false, clave);
  const p = await s.ficha();
  assert.equal(p.nombre, "Nombre corregido");
  assert.equal(p.precio_venta, 1000);
  assert.equal(p.fecha_revision_precio, "2026-01-01 10:00:00");
  assert.equal((await s.db.get("SELECT COUNT(*) AS n FROM predio_precio_historial WHERE producto_id = ?", [s.id])).n, 1);
  assert.equal((await s.db.get("SELECT cantidad FROM predio_stock WHERE producto_id = ?", [s.id])).cantidad, 4);
});

test("cambiar compra o margen recalcula la venta y persiste una revisión de precio", async t => {
  for (const [etiqueta, valor, esperado] of [["Precio de compra", "200,50", 300], ["Margen de utilidad (%)", "25", 200]]) {
    await t.test(etiqueta, async t => {
      const s = await pantalla(t);
      s.escribir(etiqueta, valor);
      assert.equal(s.P.numeroDe(s.control("Precio de venta").value), esperado);
      assert.equal(s.control("Precio de venta").readOnly, true);
      const body = await s.guardar();
      assert.equal(body.precio_venta_manual, null);
      assert.equal(Object.hasOwn(body, "precio_compra"), true);
      assert.equal(Object.hasOwn(body, "margen"), true);
      const p = await s.ficha();
      assert.equal(p.precio_venta, esperado);
      assert.notEqual(p.fecha_revision_precio, "2026-01-01 10:00:00");
      assert.equal((await s.db.get("SELECT COUNT(*) AS n FROM predio_precio_historial WHERE producto_id = ?", [s.id])).n, 2);
    });
  }
});

test("habilitar manual permite fijar la venta y mantiene su importe al modificar el costo", async t => {
  const s = await pantalla(t);
  s.manual(true);
  assert.equal(s.control("Precio de venta").readOnly, false);
  assert.equal(s.enfocado, s.control("Precio de venta"));
  s.escribir("Precio de venta", "175,25");
  s.escribir("Precio de compra", "120");
  assert.equal(s.control("Precio de venta").value, "175,25");
  const body = await s.guardar();
  assert.equal(body.precio_venta_manual, 200);
  assert.equal((await s.ficha()).precio_venta, 200);
});

test("desactivar manual vuelve al cálculo automático antes de guardar", async t => {
  const s = await pantalla(t);
  s.manual(true);
  s.escribir("Precio de venta", "500");
  s.escribir("Precio de compra", "200");
  s.manual(false);
  assert.equal(s.control("Precio de venta").readOnly, true);
  assert.equal(s.P.numeroDe(s.control("Precio de venta").value), 300);
  const body = await s.guardar();
  assert.equal(body.precio_venta_manual, null);
  assert.equal((await s.ficha()).precio_venta, 300);
});

test("cambiar el margen especial desde la ficha conserva el precio general y deja historial en esa boca", async t => {
  const s = await pantalla(t);
  s.escribir("Comedor", "55");
  const body = await s.guardar();
  assert.equal(body.margenes_boca.length, 1);
  assert.equal(body.margenes_boca[0].margen, 55);
  assert.equal(Object.hasOwn(body, "precio_venta_manual"), false);
  const detalle = await s.P.get("/productos/" + s.id);
  assert.equal(detalle.producto.precio_venta, 1000);
  assert.equal(detalle.margenes_boca.find(b => b.boca === "Comedor").precio_venta, 200);
  assert.ok(detalle.precios.some(f => f.boca === "Comedor" && f.origen === "MARGEN_PRODUCTO" && f.precio_venta === 200));
});

test("un producto nuevo empieza en automático y calcula su venta con los importes ingresados", async t => {
  const s = await pantalla(t, { nuevo: true });
  assert.equal(s.checks.get("Fijar el precio de venta a mano").checked, false);
  assert.equal(s.control("Precio de venta").readOnly, true);
  s.escribir("Nombre", "Producto nuevo");
  s.escribir("Precio de compra", "250");
  s.escribir("Margen de utilidad (%)", "20");
  assert.equal(s.P.numeroDe(s.control("Precio de venta").value), 300);
  const body = await s.guardar();
  assert.equal(s.escritos[0].metodo, "POST");
  assert.equal(body.codigo, null);
  assert.equal(body.precio_venta_manual, null);
  assert.deepEqual(await s.db.get("SELECT codigo, precio_venta FROM predio_producto WHERE nombre = ?", ["Producto nuevo"]), { codigo: null, precio_venta: 300 });
});

test("se puede quitar el código de un producto y buscarlo por nombre aunque haya otros sin código", async t => {
  const s = await pantalla(t);
  await s.P.post("/productos", { nombre: "Otro sin código" });
  s.escribir("Código de barras o interno (opcional)", "  ");
  await s.guardar();
  assert.equal((await s.ficha()).codigo, null);
  const encontrado = await api.ejecutar({ db: s.db, pid: 1, usuario: { rol: "ADMIN" }, query: { q: "guardado" } }, "GET", "/productos/buscar");
  assert.deepEqual(encontrado.map(p => p.id), [s.id]);
});

test("stock de un producto incluye bocas en cero y respeta el alcance del cajero", async t => {
  const s = await pantalla(t);
  const consultar = (rol, bocas, query = {}) => api.ejecutar({ db: s.db, pid: 1, usuario: { rol, bocas }, query }, "GET", "/listados/stock");
  const detalle = await s.P.get("/productos/" + s.id);
  const bocaCero = detalle.stock.find(b => b.boca === "Comedor");
  assert.equal(bocaCero.cantidad, 0);
  assert.ok(s.modal.contenido.querySelector("ul").textContent.includes("Comedor0"));
  const elegida = { f_producto: String(s.id) };
  const general = await consultar("ADMIN", [], elegida);
  assert.equal(general.total, detalle.stock.length);
  assert.equal(general.totales.cantidad, 4);
  assert.ok(general.filas.every(f => f.producto_id === s.id));
  const caja = await consultar("CAJERO", [bocaCero.boca_id], { ...elegida, f_estado: "sin" });
  assert.deepEqual(caja.filas.map(f => [f.boca, f.cantidad]), [["Comedor", 0]]);
  assert.equal((await consultar("CAJERO", [bocaCero.boca_id], { ...elegida, f_boca: detalle.stock.find(b => b.es_almacen).boca_id })).total, 0);
  assert.equal((await consultar("ADMIN", [])).total, 1);
  const taza = await s.P.post("/productos", { nombre: "Taza de café", destino: "VENTA_COMPUESTA", receta: { insumo_id: s.id, rendimiento: 20 } });
  const enAlmacen = detalle.stock.find(b => b.es_almacen).boca_id;
  const porBoca = await consultar("CAJERO", [enAlmacen], { f_producto: taza.id });
  assert.equal(porBoca.total, 1);
  assert.equal(porBoca.filas[0].cantidad, 0);
  assert.equal(porBoca.filas[0].porciones_disponibles, 80);
  assert.equal(porBoca.totales.cantidad, 0);
  const fichaTaza = await s.P.get("/productos/" + taza.id);
  assert.equal(fichaTaza.stock.find(b => b.es_almacen).porciones_disponibles, 80);
  assert.equal(fichaTaza.stock.find(b => b.boca_id === bocaCero.boca_id).porciones_disponibles, 0);
});

test("el pie evita fechas duplicadas al minuto y no expone actores heredados", async t => {
  const s = await pantalla(t, { fechas: { creacion: "2026-11-01 10:30:00", modificacion: "2026-11-01 10:30:59" } });
  const texto = s.modal.contenido.querySelector("p").textContent;
  assert.match(texto, /Creado el 01\/11\/2026 10:30/);
  assert.doesNotMatch(texto, /Modificado el|Sistema anterior|Sistema actual/i);
  assert.equal(texto.split("01/11/2026 10:30").length - 1, 1);
});

test("el pie muestra la modificación cuando cambia el minuto visible", async t => {
  const s = await pantalla(t, { fechas: { creacion: "2026-11-01 10:30:00", modificacion: "2026-11-02 11:31:00" } });
  const texto = s.modal.contenido.querySelector("p").textContent;
  assert.match(texto, /Creado el 01\/11\/2026 10:30 · Modificado el 02\/11\/2026 11:31/);
  assert.doesNotMatch(texto, /Sistema anterior|Sistema actual/i);
});
