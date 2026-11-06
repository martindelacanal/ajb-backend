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
      numero: v => numero.format(Number(v) || 0), pesos: v => "$ " + numero.format(Number(v) || 0), pct: v => numero.format(v) + " %",
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
    segmentado: () => h("nav"),
    btn: (texto, op) => h("button", { onclick: op.onclick }, texto),
    modal(op) { modal = op; return { cerrar() {} }; },
    get: ruta => llamar("GET", ruta),
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
  assert.equal(s.P.numeroDe(s.control("Precio de venta").value), 999);
  s.escribir("Nombre", "Nombre corregido");
  const body = await s.guardar();
  for (const clave of ["precio_compra", "margen", "precio_venta_manual", "cantidad_almacen", "confirmar_revision_precio"]) assert.equal(Object.hasOwn(body, clave), false, clave);
  const p = await s.ficha();
  assert.equal(p.nombre, "Nombre corregido");
  assert.equal(p.precio_venta, 999);
  assert.equal(p.fecha_revision_precio, "2026-01-01 10:00:00");
  assert.equal((await s.db.get("SELECT COUNT(*) AS n FROM predio_precio_historial WHERE producto_id = ?", [s.id])).n, 1);
  assert.equal((await s.db.get("SELECT cantidad FROM predio_stock WHERE producto_id = ?", [s.id])).cantidad, 4);
});

test("cambiar compra o margen recalcula la venta y persiste una revisión de precio", async t => {
  for (const [etiqueta, valor, esperado] of [["Precio de compra", "200,50", 280.7], ["Margen de utilidad (%)", "25", 125]]) {
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
  assert.equal(body.precio_venta_manual, 175.25);
  assert.equal((await s.ficha()).precio_venta, 175.25);
});

test("desactivar manual vuelve al cálculo automático antes de guardar", async t => {
  const s = await pantalla(t);
  s.manual(true);
  s.escribir("Precio de venta", "500");
  s.escribir("Precio de compra", "200");
  s.manual(false);
  assert.equal(s.control("Precio de venta").readOnly, true);
  assert.equal(s.P.numeroDe(s.control("Precio de venta").value), 280);
  const body = await s.guardar();
  assert.equal(body.precio_venta_manual, null);
  assert.equal((await s.ficha()).precio_venta, 280);
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
  assert.equal(body.precio_venta_manual, null);
  assert.equal((await s.db.get("SELECT precio_venta FROM predio_producto WHERE nombre = ?", ["Producto nuevo"])).precio_venta, 300);
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
