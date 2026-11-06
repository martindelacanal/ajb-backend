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
      solicitudes.push(ruta); return { filas: [], total: 0, pagina: 1, tam: Number(new URL(ruta, "http://fixture").searchParams.get("tam")), paginas: 1 };
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
  for (const listado of Object.keys(listados.LISTADOS)) {
    const t = s.P.tabla({ listado }); await resolver();
    const barra = t.el.querySelector(".tabla-barra"), panel = t.el.querySelector(".tabla-filtros"), boton = t.el.querySelector(".tabla-boton-filtros");
    assert.equal(panel.hidden, true, listado);
    assert.equal(boton.getAttribute("aria-expanded"), "false", listado);
    assert.equal(boton.getAttribute("aria-controls"), panel.id, listado);
    const request = new URL(s.solicitudes.at(-1), "http://fixture");
    assert.equal(request.searchParams.get("tam"), "10", listado);
    assert.equal([...request.searchParams.keys()].some(k => k.startsWith("f_")), false, listado);
    assert.equal(t.el.querySelector(".tabla-filtros-numero").hidden, true, listado);
    if (listados.meta({ usuario: { rol: "ADMIN" } }, listado).buscador) {
      const campo = t.el.querySelector(".tabla-buscar");
      assert.ok(barra.contains(campo), listado);
      assert.equal(campo.querySelector(".campo-etiqueta"), null, listado);
      assert.match(campo.querySelector("input").getAttribute("aria-label"), /^Buscar en /);
    }
    assert.ok(barra.contains(t.el.querySelector(".tabla-exportar")), listado);
    assert.equal(panel.contains(t.el.querySelector(".tabla-exportar")), false, listado);
    assert.equal(ids.has(panel.id), false); ids.add(panel.id);
  }
});

test("cada rango de fechas es un grupo indivisible y conserva los dos extremos al consultar y exportar", async () => {
  const s = pantalla();
  for (const listado of Object.keys(listados.LISTADOS)) {
    const meta = listados.meta({ usuario: { rol: "ADMIN" } }, listado);
    const fechas = meta.filtros.filter(f => ["desde", "hasta", "personalizado"].includes(f.tipo));
    if (!fechas.length) continue;
    const t = s.P.tabla({ listado }); await resolver();
    const grupos = t.el.querySelectorAll(".filtro-rango-fechas");
    assert.equal(grupos.length, 1, listado);
    assert.equal(grupos[0].getAttribute("role"), "group", listado);
    const controles = grupos[0].querySelectorAll("input");
    assert.equal(controles.length, 2, listado);
    controles[0].value = "2026-11-01"; controles[0].disparar("change"); await resolver();
    controles[1].value = "2026-11-06"; controles[1].disparar("change"); await resolver();
    t.el.querySelector(".tabla-exportar").disparar("click"); s.menus.at(-1)[0].accion(); await resolver();
    for (const ruta of [s.solicitudes.at(-1), s.descargas.at(-1)]) {
      const params = new URL(ruta, "http://fixture").searchParams;
      assert.equal(params.get("f_" + fechas[0].clave), "2026-11-01", listado);
      assert.equal(params.get("f_" + fechas[1].clave), "2026-11-06", listado);
    }
  }
});

test("Origen ya no aparece ni se aplica desde preferencias antiguas en Productos y stock general", async () => {
  const s = pantalla();
  s.P.cache["tabla:productos"] = { filtros: { origen: "importado", destino: "VENTA_DIRECTA" } };
  const t = s.P.tabla({ listado: "productos" }); await resolver();
  const meta = listados.meta({ usuario: { rol: "ADMIN" } }, "productos");
  assert.equal(meta.filtros.some(f => f.clave === "origen"), false);
  assert.equal(meta.columnas.some(c => c.clave === "almacen"), false);
  assert.equal(listados.meta({ usuario: { rol: "ADMIN" } }, "bocas").columnas.find(c => c.clave === "es_almacen").titulo, "Proveeduría");
  assert.equal(t.el.querySelector(".tabla-filtros-numero").textContent, "1");
  t.el.querySelector(".tabla-exportar").disparar("click"); s.menus.at(-1)[0].accion(); await resolver();
  for (const ruta of [s.solicitudes.at(-1), s.descargas.at(-1)]) {
    const params = new URL(ruta, "http://fixture").searchParams;
    assert.equal(params.has("f_origen"), false);
    assert.equal(params.get("f_destino"), "VENTA_DIRECTA");
  }
});

test("cerrar filtros conserva valores, aplicación, contador y exportación CSV; volver a la tabla conserva filtros pero empieza plegada", async () => {
  const s = pantalla();
  const t = s.P.tabla({ listado: "usuarios" }); await resolver();
  const panel = t.el.querySelector(".tabla-filtros"), boton = t.el.querySelector(".tabla-boton-filtros");
  assert.equal(t.el.querySelector(".tabla-filtros-numero").textContent, "0");
  const consultas = s.solicitudes.length;
  boton.disparar("click");
  assert.equal(panel.hidden, false);
  assert.equal(boton.getAttribute("aria-expanded"), "true");
  const rol = panel.querySelector("select"); rol.value = "ADMIN"; rol.disparar("change"); await resolver();
  assert.equal(t.el.querySelector(".tabla-filtros-numero").textContent, "1");
  boton.disparar("click");
  assert.equal(panel.hidden, true);
  assert.equal(s.solicitudes.length, consultas + 1, "plegar no dispara consultas ni modifica la búsqueda");
  t.el.querySelector(".tabla-exportar").disparar("click");
  s.menus.at(-1)[0].accion(); await resolver();
  const csv = new URL(s.descargas[0], "http://fixture");
  assert.equal(csv.searchParams.get("f_rol"), "ADMIN");
  assert.equal(csv.searchParams.has("f_activo"), false);
  assert.equal(csv.searchParams.get("formato"), "csv");
  const otra = s.P.tabla({ listado: "usuarios" }); await resolver();
  assert.equal(otra.el.querySelector(".tabla-filtros").hidden, true);
  assert.equal(otra.el.querySelector(".tabla-filtros").querySelector("select").value, "ADMIN");
  assert.equal(otra.parametros().f_rol, "ADMIN");
});

test("la cantidad de filas que se elige se conserva para ese listado al volver", async () => {
  const s = pantalla();
  const tabla = s.P.tabla({ listado: "usuarios" }); await resolver();
  const tam = tabla.el.querySelector(".paginador").querySelector("select");
  tam.value = "25"; tam.disparar("change"); await resolver();
  s.P.tabla({ listado: "usuarios" }); await resolver();
  assert.equal(new URL(s.solicitudes.at(-1), "http://fixture").searchParams.get("tam"), "25");
  s.P.tabla({ listado: "stock" }); await resolver();
  assert.equal(new URL(s.solicitudes.at(-1), "http://fixture").searchParams.get("tam"), "10");
});

test("los filtros recordados no cambian la caja fija ni introducen un cajero oculto al consultar o exportar", async () => {
  const s = pantalla();
  s.P.cache["tabla:ventas-caja-7"] = { filtros: { caja: "9", usuario: "2", estado: "ANULADA" } };
  const t = s.P.tabla({ listado: "ventas", claveEstado: "ventas-caja-7", filtrosFijos: { f_caja: "7" }, filtrosOcultos: ["caja", "usuario"] });
  await resolver();
  t.el.querySelector(".tabla-exportar").disparar("click"); s.menus.at(-1)[0].accion(); await resolver();
  for (const ruta of [s.solicitudes.at(-1), s.descargas.at(-1)]) {
    const params = new URL(ruta, "http://fixture").searchParams;
    assert.equal(params.get("f_caja"), "7");
    assert.equal(params.get("f_estado"), "ANULADA");
    assert.equal(params.has("f_usuario"), false);
  }
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
