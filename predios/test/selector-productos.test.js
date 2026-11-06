"use strict";

// El lector termina con Enter: una sugerencia nunca puede convertirse en una venta
// ni modificar el catálogo sin una elección y una confirmación independientes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function pantalla() {
  const ventanas = [], elegidos = [], escritos = [], errores = [];
  let documento;
  class Elemento {
    constructor(tag, clases = []) {
      this.tag = tag; this.clases = clases; this.hijos = []; this.attrs = {}; this.events = {};
      this.style = {}; this.value = ""; this.offsetParent = {}; this.scrollHeight = 100;
    }
    appendChild(n) { if (n && typeof n === "object") n.padre = this; this.hijos.push(n); return n; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
    remove() { if (this.padre) this.padre.hijos.splice(this.padre.hijos.indexOf(this), 1); }
    contains(n) { return n === this || this.hijos.some(x => x instanceof Elemento && x.contains(n)); }
    querySelectorAll(s) {
      const r = [];
      for (const n of this.hijos) if (n instanceof Elemento) {
        if (n.clases.includes(s.slice(1))) r.push(n);
        r.push(...n.querySelectorAll(s));
      }
      return r;
    }
    getBoundingClientRect() { return { top: 20, bottom: 60, left: 20, width: 400 }; }
    scrollIntoView() {}
    focus() { documento.activeElement = this; }
    disparar(tipo, datos = {}) { for (const fn of this.events[tipo] || []) fn({ preventDefault() {}, stopPropagation() {}, ...datos }); }
  }
  documento = { body: new Elemento("body"), activeElement: null };
  function h(nombre, attrs, ...hijos) {
    const partes = nombre.split(".");
    const n = new Elemento(partes[0], partes.slice(1));
    if (attrs instanceof Elemento || Array.isArray(attrs) || typeof attrs !== "object" || attrs === null) {
      hijos.unshift(attrs); attrs = {};
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "value") n.value = v;
      else n.setAttribute(k, v);
    }
    for (const x of hijos.flat(Infinity)) if (x !== null && x !== undefined) n.appendChild(x);
    return n;
  }
  const P = {
    h, vaciar(n) { n.hijos = []; }, f: { pesos: String, numero: String },
    qs: obj => "?" + new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null)),
    get: async () => [], post: async (ruta, body) => { escritos.push({ ruta, body }); return { codigo: body.codigo_nuevo }; },
    error: e => errores.push(e), aviso() {}, icono: () => h("svg"),
    btn(texto, opts) { const b = h("button", { onclick: opts.onclick }, texto); b.texto = texto; return b; },
    dato: (a, b) => h("div", a, b), mensaje: (a) => h("div", a),
    modal(opts) { ventanas.push(opts); return { cerrar: valor => opts.alCerrar && opts.alCerrar(valor) }; },
    ejecutar: (_boton, fn) => Promise.resolve().then(fn),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/componentes.js"), "utf8"), {
    window: { P, innerHeight: 800, innerWidth: 1200, addEventListener() {}, removeEventListener() {} },
    document: documento, setTimeout, clearTimeout,
  });
  const crear = opciones => P.comboProducto({ abrirAlEnfocar: false, alElegir: o => elegidos.push(o), ...opciones });
  return { P, crear, ventanas, elegidos, escritos, errores, documento };
}
const resolver = () => new Promise(resolve => setImmediate(resolve));
async function enter(combo, texto) { combo.input.value = texto; combo.input.disparar("keydown", { key: "Enter" }); await resolver(); }
function opcion(s) { return s.documento.body.querySelectorAll(".combo-opcion")[0]; }

test("Enter agrega únicamente la coincidencia exacta del código completo", async () => {
  const s = pantalla();
  s.P.get = async () => [{ id: 1, nombre: "Coca Zero 1,5 L", codigo: "7790895000436", exacto: true }];
  await enter(s.crear(), "7790895000436");
  assert.equal(s.elegidos.length, 1);
  assert.equal(s.ventanas.length, 0);
  assert.equal(s.escritos.length, 0);
});

test("una aproximada única no se elige con Enter ni con flechas y Enter", async () => {
  const s = pantalla();
  s.P.get = async () => [{ id: 1, nombre: "Coca Zero 1,5 L", codigo: "779089500043", sugerido: true }];
  const combo = s.crear();
  await enter(combo, "7790895000436");
  combo.input.disparar("keydown", { key: "ArrowDown" });
  combo.input.disparar("keydown", { key: "Enter" });
  await resolver();
  assert.equal(s.elegidos.length, 0);
  assert.equal(s.ventanas.length, 0);
  opcion(s).disparar("click");
  await resolver();
  assert.equal(s.ventanas.length, 1);
  assert.equal(s.elegidos.length, 0);
  assert.equal(s.escritos.length, 0);
  s.ventanas[0].acciones.find(x => x.texto === "Continuar sin modificar").disparar("click");
  await resolver();
  assert.equal(s.elegidos.length, 1);
  assert.equal(s.escritos.length, 0);
});

test("cancelar la verificación no agrega; corregir exige confirmación y usa el nuevo código", async () => {
  const s = pantalla();
  s.P.get = async () => [{ id: 8, nombre: "Producto", codigo: "779089500043", sugerido: true }];
  const combo = s.crear();
  await enter(combo, "7790895000436");
  opcion(s).disparar("click");
  await resolver();
  s.ventanas[0].alCerrar();
  await resolver();
  assert.equal(s.elegidos.length, 0);
  await enter(combo, "7790895000436");
  opcion(s).disparar("click");
  await resolver();
  s.ventanas[1].acciones.find(x => x.texto === "Corregir y usar producto").disparar("click");
  await resolver();
  assert.equal(s.escritos.length, 1);
  assert.equal(s.escritos[0].ruta, "/productos/8/codigo-barras");
  assert.equal(s.escritos[0].body.codigo_anterior, "779089500043");
  assert.equal(s.escritos[0].body.codigo_nuevo, "7790895000436");
  assert.equal(s.escritos[0].body.confirmar, true);
  assert.equal(s.elegidos[0].dato.codigo, "7790895000436");
});

test("una respuesta atrasada del lector no selecciona una búsqueda anterior", async () => {
  const s = pantalla();
  let resolverBusqueda;
  s.P.get = () => new Promise(resolve => { resolverBusqueda = resolve; });
  const combo = s.crear();
  combo.input.value = "11111";
  combo.input.disparar("keydown", { key: "Enter" });
  combo.input.value = "22222";
  resolverBusqueda([{ id: 1, nombre: "Anterior", codigo: "11111", exacto: true }]);
  await resolver();
  assert.equal(s.elegidos.length, 0);
});

test("escribir otro código retira inmediatamente los resultados anteriores", async () => {
  const s = pantalla();
  s.P.get = async () => [{ id: 1, nombre: "Anterior", codigo: "779089500043", sugerido: true }];
  const combo = s.crear();
  await enter(combo, "7790895000436");
  assert.ok(opcion(s));
  combo.input.value = "22222";
  combo.input.disparar("input");
  assert.equal(opcion(s), undefined);
  assert.equal(s.elegidos.length, 0);
});

test("volver del popup no deja un cierre de blur pendiente que quite la nueva lista", async () => {
  const s = pantalla();
  s.P.get = async () => [{ id: 1, nombre: "Producto", codigo: "779089500043", sugerido: true }];
  const combo = s.crear();
  combo.input.disparar("blur");
  combo.input.focus();
  await enter(combo, "7790895000436");
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.ok(opcion(s));
  assert.equal(s.elegidos.length, 0);
});

test("ventas excluye físicos sin stock y todo producto sin precio, incluso al escribir", async () => {
  const s = pantalla();
  s.P.get = async () => [
    { id: 1, nombre: "Sin precio", precio_venta: 0, destino: "VENTA_DIRECTA", stock_boca: 20 },
    { id: 2, nombre: "Sin stock", precio_venta: 100, destino: "VENTA_DIRECTA", stock_boca: 0 },
    { id: 3, nombre: "Stock negativo", precio_venta: 100, destino: "VENTA_DIRECTA", stock_boca: -1 },
    { id: 4, nombre: "Disponible", precio_venta: 100, destino: "VENTA_DIRECTA", stock_boca: 1 },
    { id: 5, nombre: "Servicio sin precio", precio_venta: 0, destino: "VENTA_COMPUESTA", stock_boca: 0 },
    { id: 6, nombre: "Servicio", precio_venta: 100, destino: "VENTA_COMPUESTA", stock_boca: 0 },
    { id: 7, nombre: "Interno", precio_venta: 100, destino: "USO_INTERNO", stock_boca: 1 },
  ];
  await enter(s.crear({ venta: true }), "producto");
  const opciones = s.documento.body.querySelectorAll(".combo-opcion");
  assert.equal(opciones.length, 2);
  assert.equal(s.elegidos.length, 0);
});
