"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const listados = require("../lib/listados");

function pantalla() {
  const solicitudes = [], descargas = [], menus = [];
  class Nodo {
    constructor(tag, clases = []) {
      this.tag = tag; this.clases = clases; this.hijos = []; this.attrs = {}; this.events = {}; this.style = {};
      this.value = ""; this.scrollWidth = 0; this.clientWidth = 800;
      this.classList = { add: (...nombres) => this.clases.push(...nombres) };
    }
    get childNodes() { return this.hijos; }
    get firstChild() { return this.hijos[0]; }
    appendChild(n) { if (n instanceof Nodo) n.parentNode = this; this.hijos.push(n); if (this.tag === "select" && n.selected) this.value = n.value; return n; }
    insertBefore(n, antes) { const i = this.hijos.indexOf(antes); n.parentNode = this; this.hijos.splice(i < 0 ? this.hijos.length : i, 0, n); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.clases = String(v).split(" "); }
    getAttribute(k) { return this.attrs[k] ?? this[k] ?? null; }
    addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
    removeEventListener() {}
    contains(n) { return n === this || this.hijos.some(x => x instanceof Nodo && x.contains(n)); }
    querySelectorAll(selector) {
      const coincide = n => selector[0] === "." ? n.clases.includes(selector.slice(1)) : n.tag === selector;
      return this.hijos.flatMap(n => n instanceof Nodo ? (coincide(n) ? [n] : []).concat(n.querySelectorAll(selector)) : []);
    }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    disparar(tipo) { for (const fn of this.events[tipo] || []) fn({ preventDefault() {}, key: tipo === "keydown" ? "Enter" : undefined }); }
  }
  function h(nombre, attrs, ...hijos) {
    const partes = nombre.split(/(?=[.#])/);
    const n = new Nodo(partes[0], partes.slice(1).filter(p => p[0] === ".").map(p => p.slice(1)));
    const id = partes.find(p => p[0] === "#"); if (id) n.id = id.slice(1);
    if (attrs instanceof Nodo || Array.isArray(attrs) || typeof attrs !== "object" || attrs === null) { hijos.unshift(attrs); attrs = {}; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null) continue;
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "style") Object.assign(n.style, v);
      else if (k === "value" || k === "hidden" || k === "id") n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const x of hijos.flat(Infinity)) if (x !== undefined && x !== null && x !== false) n.appendChild(x);
    return n;
  }
  const documento = { body: new Nodo("body") };
  const P = {
    h, cache: {}, f: { entero: String, numero: String }, numeroDe: Number,
    vaciar: n => { n.hijos = []; }, reemplazar(n, ...hijos) { n.hijos = []; hijos.forEach(x => n.appendChild(x)); },
    icono: () => h("svg"), btn(texto, opts) { return h("button", { onclick: opts.onclick }, h("svg"), texto); },
    qs: obj => "?" + new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null)),
    get: async ruta => {
      const meta = /^\/listados\/([^/?]+)\/meta$/.exec(ruta);
      if (meta) return listados.meta({ usuario: { rol: "ADMIN" } }, meta[1]);
      solicitudes.push(ruta); return { filas: [], total: 0, pagina: 1, tam: 25, paginas: 1 };
    },
    opciones: async () => [{ valor: "7", texto: "Opción de prueba" }],
    descargar: async ruta => { descargas.push(ruta); }, aviso() {}, error(e) { throw e; },
    menuFlotante: (_boton, items) => { menus.push(items); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/componentes.js"), "utf8"), {
    window: { P, addEventListener() {}, removeEventListener() {} }, document: documento, setTimeout, clearTimeout,
  });
  P.menuFlotante = (_boton, items) => { menus.push(items); };
  return { P, solicitudes, descargas, menus };
}
const resolver = () => new Promise(resolve => setImmediate(resolve));

test("todas las secciones comparten buscador y exportación fuera del panel cerrado con controles accesibles únicos", async () => {
  const s = pantalla();
  const ids = new Set();
  for (const listado of ["caja", "cierres", "compras", "productos", "proveedores", "usuarios", "afiliados", "ventas", "ventas_productos"]) {
    const t = s.P.tabla({ listado }); await resolver();
    const barra = t.el.querySelector(".tabla-barra"), panel = t.el.querySelector(".tabla-filtros"), boton = t.el.querySelector(".tabla-boton-filtros");
    assert.equal(panel.hidden, true, listado);
    assert.equal(boton.getAttribute("aria-expanded"), "false", listado);
    assert.equal(boton.getAttribute("aria-controls"), panel.id, listado);
    assert.ok(barra.contains(t.el.querySelector(".tabla-buscar")), listado);
    assert.ok(barra.contains(t.el.querySelector(".tabla-exportar")), listado);
    assert.equal(panel.contains(t.el.querySelector(".tabla-exportar")), false, listado);
    assert.equal(ids.has(panel.id), false); ids.add(panel.id);
  }
});

test("cerrar filtros conserva valores, aplicación, contador y exportación CSV; volver a la tabla conserva filtros pero empieza plegada", async () => {
  const s = pantalla();
  const t = s.P.tabla({ listado: "usuarios" }); await resolver();
  const panel = t.el.querySelector(".tabla-filtros"), boton = t.el.querySelector(".tabla-boton-filtros");
  assert.equal(t.el.querySelector(".tabla-filtros-numero").textContent, "1");
  const consultas = s.solicitudes.length;
  boton.disparar("click");
  assert.equal(panel.hidden, false);
  assert.equal(boton.getAttribute("aria-expanded"), "true");
  const rol = panel.querySelector("select"); rol.value = "ADMIN"; rol.disparar("change"); await resolver();
  assert.equal(t.el.querySelector(".tabla-filtros-numero").textContent, "2");
  boton.disparar("click");
  assert.equal(panel.hidden, true);
  assert.equal(s.solicitudes.length, consultas + 1, "plegar no dispara consultas ni modifica la búsqueda");
  t.el.querySelector(".tabla-exportar").disparar("click");
  s.menus.at(-1)[0].accion(); await resolver();
  const csv = new URL(s.descargas[0], "http://fixture");
  assert.equal(csv.searchParams.get("f_rol"), "ADMIN");
  assert.equal(csv.searchParams.get("f_activo"), "1");
  assert.equal(csv.searchParams.get("formato"), "csv");
  const otra = s.P.tabla({ listado: "usuarios" }); await resolver();
  assert.equal(otra.el.querySelector(".tabla-filtros").hidden, true);
  assert.equal(otra.el.querySelector(".tabla-filtros").querySelector("select").value, "ADMIN");
  assert.equal(otra.parametros().f_rol, "ADMIN");
});

test("los filtros programáticos se aplican plegados y Enter busca el texto actual sin perderlo al exportar", async () => {
  const s = pantalla();
  const t = s.P.tabla({ listado: "productos" }); await resolver();
  t.fijarFiltro("destino", "VENTA_DIRECTA"); await resolver();
  assert.equal(t.el.querySelector(".tabla-filtros").hidden, true);
  assert.equal(t.parametros().f_destino, "VENTA_DIRECTA");
  const buscar = t.el.querySelector(".tabla-buscar").querySelector("input");
  buscar.value = "Coca Zero"; buscar.disparar("input"); buscar.disparar("keydown"); await resolver();
  assert.equal(new URL(s.solicitudes.at(-1), "http://fixture").searchParams.get("q"), "Coca Zero");
  t.el.querySelector(".tabla-exportar").disparar("click"); s.menus.at(-1)[0].accion(); await resolver();
  assert.equal(new URL(s.descargas.at(-1), "http://fixture").searchParams.get("q"), "Coca Zero");
});
