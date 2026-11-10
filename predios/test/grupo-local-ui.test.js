"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const resolver = () => new Promise(resolve => setImmediate(resolve));

function pantalla({ remoto = false } = {}) {
  const solicitudes = [], descargas = [], escrituras = [], salidas = [], intervalos = [], confirmaciones = [], errores = [], tiempos = new Map();
  let reemplazos = 0, siguienteTimer = 0, acepto = false, enfocado;
  let datos = { habilitado: false, estado: "SIN_CONFIGURAR", principal: { id: "a", nombre: "Recepción" }, testigo: null,
    miembros: [{ id: "a", nombre: "Recepción", preferido: true }], escritor: { id: "a", nombre: "Recepción" },
    degradado: false, puedeActivar: false, puedePrepararTestigo: true, puedePrepararRespaldo: false };
  let fallaGet = null, fallaPost = null;
  class Nodo {
    constructor(tag) { this.tag = tag; this.hijos = []; this.events = {}; this.style = {}; this.attrs = {}; this.hidden = false; this.disabled = false; }
    appendChild(n) { this.hijos.push(n); return n; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(tipo, fn) { (this.events[tipo] ||= []).push(fn); }
    focus() { enfocado = this; }
    click() { if (!this.disabled) for (const fn of this.events.click || []) fn({ currentTarget: this }); }
    get textContent() { return this.hijos.map(n => n instanceof Nodo ? n.textContent : String(n)).join(""); }
    set textContent(texto) { this.hijos = [texto]; }
  }
  function h(nombre, attrs, ...hijos) {
    const n = new Nodo(nombre.split(".")[0]);
    if (!attrs || attrs instanceof Nodo || Array.isArray(attrs) || typeof attrs !== "object") { hijos.unshift(attrs); attrs = {}; }
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n[k] = v;
    }
    n.hijos = hijos.flat(Infinity).filter(x => x !== undefined && x !== null && x !== false);
    return n;
  }
  const P = {
    h, modo: remoto ? "remoto" : "local", chip: texto => h("span", texto), mensaje: texto => h("div", texto),
    btn: (texto, opciones) => h("button", { onclick: opciones.onclick, disabled: !!opciones.deshabilitado }, texto),
    reemplazar(n, ...hijos) { reemplazos++; n.hijos = hijos.flat(Infinity); },
    alSalir: fn => salidas.push(fn),
    intervalo(fn, ms) { intervalos.push({ fn, ms }); },
    get: async (ruta, opciones) => { solicitudes.push({ ruta, opciones }); if (fallaGet) throw fallaGet; return datos; },
    post: async (ruta, body) => { escrituras.push({ ruta, body }); if (fallaPost) throw fallaPost; return { reiniciando: true }; },
    descargarPost: async (ruta, body, nombre) => { descargas.push({ ruta, body, nombre }); },
    confirmar: async (texto, opciones) => { confirmaciones.push({ texto, opciones }); return acepto; },
    ejecutar(boton, fn) { boton.disabled = true; return Promise.resolve().then(fn).catch(e => { errores.push(e); throw e; }).finally(() => { boton.disabled = false; }); },
    error: e => errores.push(e), aviso() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/pantallas/grupo-local.js"), "utf8"), {
    window: { P }, setTimeout: fn => { const id = ++siguienteTimer; tiempos.set(id, fn); return id; }, clearTimeout: id => tiempos.delete(id),
  });
  const panel = P.panelGrupoLocal();
  function nodos(n = panel) { return [n].concat(n.hijos.filter(x => x instanceof Nodo).flatMap(x => nodos(x))); }
  const boton = texto => nodos().find(n => n.tag === "button" && n.textContent === texto);
  return {
    panel, boton, solicitudes, descargas, escrituras, confirmaciones, intervalos, errores, tiempos,
    get datos() { return datos; },
    cambiar(cambios) { datos = { ...datos, ...cambios }; },
    aceptar(valor) { acepto = valor; },
    fallarGet(error) { fallaGet = error; }, fallarPost(error) { fallaPost = error; },
    get reemplazos() { return reemplazos; }, get enfocado() { return enfocado; },
    actualizar: () => intervalos[0].fn(),
    salir: () => salidas.forEach(fn => fn()),
    async reinicio() { const [id, fn] = tiempos.entries().next().value; tiempos.delete(id); fn(); await resolver(); },
  };
}

test("consultar una instalación de una PC no configura ni activa nada y respeta los permisos", async () => {
  const s = pantalla(); await resolver();
  assert.equal(s.solicitudes[0].ruta, "/sistema/grupo-local");
  assert.equal(s.intervalos[0].ms, 30000);
  assert.equal(s.escrituras.length, 0); assert.equal(s.descargas.length, 0);
  assert.match(s.panel.textContent, /Una sola PC/); assert.match(s.panel.textContent, /Recepción/);
  assert.equal(s.boton("Instalar testigo en una PC de caja").disabled, false);
  assert.equal(s.boton("Agregar PC de respaldo").disabled, true);
  assert.equal(s.boton("Activar reemplazo automático").disabled, true);
});

test("los instaladores se descargan sólo por acción explícita con el rol correcto", async () => {
  const s = pantalla(); await resolver();
  s.boton("Instalar testigo en una PC de caja").click(); await resolver();
  s.cambiar({ estado: "PREPARANDO", testigo: { nombre: "Caja 1" }, puedePrepararRespaldo: true }); await s.actualizar();
  s.boton("Agregar PC de respaldo").click(); await resolver();
  s.boton("Preparar acceso de caja").click(); await resolver();
  assert.deepEqual(s.descargas.map(d => JSON.parse(JSON.stringify(d.body))), [{ rol: "Testigo" }, { rol: "Respaldo" }, { rol: "Acceso" }]);
  assert.equal(s.descargas.every(d => d.ruta === "/sistema/grupo-local/instalador" && d.nombre.endsWith(".zip")), true);
  assert.match(s.panel.textContent, /INSTALAR-APOYO\.bat/); assert.equal(s.escrituras.length, 0);
});

test("un grupo automático ofrece acceso de caja y permite quitar un respaldo con confirmación", async () => {
  const s = pantalla(); await resolver();
  s.cambiar({ modo: "quorum", habilitado: true, estado: "EN_MARCHA", puedePrepararAcceso: true,
    miembros: [{ id: "b", nombre: "Caja", puedeQuitar: true }] });
  await s.actualizar();
  s.boton("Descargar acceso de caja").click(); await resolver();
  assert.equal(s.descargas.at(-1).ruta, "/sistema/grupo-local/acceso-caja");
  s.boton("Quitar respaldo").click(); await resolver();
  assert.equal(s.escrituras.length, 0);
  s.aceptar(true); s.boton("Quitar respaldo").click(); await resolver();
  assert.equal(s.escrituras.at(-1).ruta, "/sistema/grupo-local/quitar-respaldo");
  assert.equal(s.escrituras.at(-1).body.equipoId, "b");
});

test("el sondeo sin cambios conserva los nodos y el foco y termina al salir", async () => {
  const s = pantalla(); await resolver();
  const boton = s.boton("Instalar testigo en una PC de caja"); boton.focus();
  const antes = s.reemplazos;
  await s.actualizar(); await s.actualizar();
  assert.equal(s.reemplazos, antes); assert.equal(s.boton("Instalar testigo en una PC de caja"), boton); assert.equal(s.enfocado, boton);
  s.salir(); const consultas = s.solicitudes.length; await s.actualizar(); assert.equal(s.solicitudes.length, consultas);
});

test("activar exige confirmación y espera al servidor sin repetir el POST", async () => {
  const s = pantalla(); await resolver();
  s.cambiar({ estado: "PREPARANDO", puedeActivar: true, testigo: { nombre: "Caja 1" } }); await s.actualizar();
  s.boton("Activar reemplazo automático").click(); await resolver(); assert.equal(s.escrituras.length, 0);
  s.aceptar(true); s.boton("Activar reemplazo automático").click(); await resolver();
  assert.equal(s.escrituras.length, 1); assert.equal(s.escrituras[0].ruta, "/sistema/grupo-local/activar");
  assert.match(s.confirmaciones[1].texto, /interrupción breve/); assert.match(s.confirmaciones[1].texto, /testigo/);
  assert.match(s.panel.textContent, /Esperando el reinicio/);
  s.fallarGet(new Error("Reiniciando")); await s.reinicio(); assert.equal(s.escrituras.length, 1);
  s.fallarGet(null); s.cambiar({ habilitado: true, estado: "EN_MARCHA", puedeActivar: false, escritor: { id: "b", nombre: "Administración" } }); await s.reinicio();
  assert.match(s.panel.textContent, /Administración/); assert.match(s.panel.textContent, /reemplazo automático está activo/);
  assert.equal(s.escrituras.length, 1); assert.equal(s.boton("Activar reemplazo automático").hidden, true);
});

test("una respuesta perdida al activar se resuelve consultando y se cancela el sondeo al salir", async () => {
  const s = pantalla(); await resolver(); s.aceptar(true);
  s.cambiar({ estado: "PREPARANDO", puedeActivar: true, testigo: { nombre: "Caja" } }); await s.actualizar();
  s.fallarPost(Object.assign(new Error("Sin respuesta"), { status: 0 }));
  s.boton("Activar reemplazo automático").click(); await resolver();
  assert.equal(s.escrituras.length, 1); assert.equal(s.tiempos.size, 1);
  s.salir(); assert.equal(s.tiempos.size, 0);
});

test("protección reducida y pérdida del testigo son visibles sin exponer términos internos", async () => {
  const s = pantalla(); await resolver();
  s.cambiar({ habilitado: true, estado: "SIN_TESTIGO", testigo: { nombre: "Caja 1" }, degradado: true }); await s.actualizar();
  assert.match(s.panel.textContent, /Testigo sin conexión/); assert.match(s.panel.textContent, /Protección reducida/);
  assert.match(s.panel.textContent, /primero recibe los datos pendientes/);
  assert.doesNotMatch(s.panel.textContent, /quorum|lease|término/i);
});

test("el panel remoto sólo indica cómo abrirlo en la LAN y no consulta ni descarga", () => {
  const s = pantalla({ remoto: true });
  assert.match(s.panel.textContent, /red del predio/);
  assert.equal(s.solicitudes.length, 0); assert.equal(s.descargas.length, 0); assert.equal(s.intervalos.length, 0);
});

test("dejar solo la notebook explica la pausa persistente y permite convertir un modo temporal anterior", async () => {
  const s = pantalla(); await resolver();
  s.cambiar({ modo: "quorum", habilitado: true, estado: "EN_MARCHA", puedeConfigurarSoloPrincipal: true,
    soloPrincipal: true, soloPrincipalListo: true, regresoAutomatico: true });
  await s.actualizar();
  assert.equal(s.boton("Dejar solo la notebook").hidden, false, "el modo temporal anterior se puede fijar");
  s.aceptar(true); s.boton("Dejar solo la notebook").click(); await resolver();
  assert.equal(s.escrituras.at(-1).ruta, "/sistema/grupo-local/solo-principal");
  assert.equal(s.escrituras.at(-1).body.activo, true);
  assert.match(s.confirmaciones.at(-1).texto, /seguirán desactivados hasta que elijas reactivar/);
  assert.doesNotMatch(s.confirmaciones.at(-1).texto, /Dejá los respaldos encendidos/);
  s.cambiar({ regresoAutomatico: false }); await s.actualizar();
  assert.equal(s.boton("Dejar solo la notebook").hidden, true);
  assert.equal(s.boton("Reactivar relevo ahora").hidden, false);
  assert.match(s.panel.textContent, /seguirán desactivados aunque se reinicien/);
  assert.doesNotMatch(s.panel.textContent, /se reactivará solo/);
});

test("antes de activar muestra respaldos incorporados sin pedir una copia que todavía no se crea", async () => {
  const s = pantalla(); await resolver();
  s.cambiar({ estado: "PREPARANDO", miembros: [...s.datos.miembros, { id: "b", nombre: "Administración", actualizado: false }] });
  await s.actualizar();
  assert.match(s.panel.textContent, /completá su incorporación/);
  assert.match(s.panel.textContent, /Incorporada/);
  assert.doesNotMatch(s.panel.textContent, /Actualizando copia|esperá a que sus copias estén actualizadas/);
});
