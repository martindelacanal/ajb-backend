"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function impresora() {
  const trabajos = [];
  let documento;
  class Nodo {
    constructor(nombre) { this.nombre = nombre; this.hijos = []; }
    appendChild(n) { this.hijos.push(n); return n; }
    remove() {}
    cloneNode(profundo) { const n = new Nodo(this.nombre); n.textContent = this.textContent; if (profundo) n.hijos = this.hijos.map(h => h instanceof Nodo ? h.cloneNode(true) : h); return n; }
  }
  function h(nombre, attrs, ...hijos) {
    const n = new Nodo(nombre);
    if (attrs instanceof Nodo || typeof attrs !== "object" || Array.isArray(attrs)) { hijos.unshift(attrs); attrs = {}; }
    for (const x of hijos.flat(Infinity)) if (x !== null && x !== undefined) n.appendChild(x);
    if (nombre === "iframe") {
      const doc = { open() {}, write() {}, close() {}, head: new Nodo("head"), body: new Nodo("body"), createElement: nombre => new Nodo(nombre), importNode: x => x.cloneNode(true) };
      n.contentWindow = { document: doc, focus() {}, print() { trabajos.push(doc); n.contentWindow.onafterprint(); } };
    }
    return n;
  }
  documento = { body: new Nodo("body") };
  const P = { h, f: { numero: String, pesos: String, fechaHora: String } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/impresion.js"), "utf8"), {
    window: { P, print() { throw new Error("No debe abrir un segundo diálogo"); } }, document: documento,
    setTimeout: fn => queueMicrotask(fn),
  });
  return { P, trabajos };
}
function texto(n) { return typeof n === "object" ? (n.textContent || "") + (n.hijos || []).map(texto).join(" ") : String(n); }
const ticket = {
  venta: { id: 42, fecha: "2026-11-05 16:00:00", boca: "Comedor", caja: "Caja 1", usuario_nombre: "Cajera", total: 2000, forma_pago: "QR", estado: "CONFIRMADA" },
  empresa: { nombre_predio: "Camping" }, ancho: 80,
  items: [{ descripcion: "Milanesa con guarnición", cantidad: 1, precio_unitario: 2000, subtotal: 2000 }],
};

test("comanda imprime cliente y preparación completos en un único trabajo", async () => {
  const s = impresora();
  await s.P.imprimirTicket({ ...ticket, imprimir_comanda: true });
  assert.equal(s.trabajos.length, 1);
  const contenido = texto(s.trabajos[0].body);
  assert.match(contenido, /CLIENTE/);
  assert.match(contenido, /COMANDA · PREPARACIÓN/);
  assert.equal(contenido.split("Milanesa con guarnición").length - 1, 2);
  assert.equal(contenido.split("Ticket N° 000042").length - 1, 2);
  assert.match(texto(s.trabajos[0].head), /page-break-before: always/);
});

test("con comanda apagada imprime una sola copia del ticket", async () => {
  const s = impresora();
  await s.P.imprimirTicket({ ...ticket, imprimir_comanda: false });
  assert.equal(s.trabajos.length, 1);
  const contenido = texto(s.trabajos[0].body);
  assert.doesNotMatch(contenido, /COMANDA/);
  assert.equal(contenido.split("Milanesa con guarnición").length - 1, 1);
});
