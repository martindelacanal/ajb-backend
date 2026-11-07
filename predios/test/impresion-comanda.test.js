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
  const P = { h, f: { numero: String, pesos: n => "$ " + Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2 }), fecha: () => "05/11/2026", hora: () => "16:00" } };
  const contexto = vm.createContext({
    window: { P, print() { throw new Error("No debe abrir un segundo diálogo"); } }, document: documento,
    setTimeout: fn => queueMicrotask(fn),
  });
  for (const archivo of ["impresion.js", "ticketera.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/js", archivo), "utf8"), contexto);
  }
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
  assert.match(contenido, /COMANDA - PREPARACION/);
  assert.equal(contenido.split("MILANESA CON GUARNICION").length - 1, 2);
  assert.equal(contenido.split("TICKET NRO: 000042").length - 1, 2);
  assert.match(texto(s.trabajos[0].head), /page-break-before: always/);
});

test("con comanda apagada imprime una sola copia del ticket", async () => {
  const s = impresora();
  await s.P.imprimirTicket({ ...ticket, imprimir_comanda: false });
  assert.equal(s.trabajos.length, 1);
  const contenido = texto(s.trabajos[0].body);
  assert.doesNotMatch(contenido, /COMANDA/);
  assert.equal(contenido.split("MILANESA CON GUARNICION").length - 1, 1);
});

function partes(doc) { return doc.body.hijos[0].hijos.map(texto); }
function verificarPapel(partes, columnas) {
  for (const copia of partes) {
    assert.doesNotMatch(copia, /[^\x20-\x7e\n]|[a-z]/);
    for (const renglon of copia.split("\n")) assert.ok(renglon.length <= columnas, renglon);
    assert.ok(copia.includes("-".repeat(columnas)));
    assert.ok(copia.endsWith("\n".repeat(7) + "-" + " ".repeat(columnas - 2) + "-"));
  }
}

for (const ancho of [58, 80]) {
  test("detalle, columnas y avance de corte en papel de " + ancho + " mm", async () => {
    const s = impresora();
    await s.P.imprimirTicket({ ...ticket, ancho, venta: { ...ticket.venta, forma_pago: "EFECTIVO", recibido: 10000, vuelto: 1600, total: 8400 },
      empresa: { nombre_predio: "Camping Miramar", razon_social: "Asociación Judicial Bonaerense", leyenda: "¡Gracias por tu visita!" },
      items: [{ descripcion: "Champú clásico niño × ½ l.", cantidad: 4, precio_unitario: 2100, subtotal: 8400 }],
    });
    const copias = partes(s.trabajos[0]);
    verificarPapel(copias, ancho === 58 ? 32 : 40);
    assert.equal(copias.length, 1);
    assert.match(copias[0], /FECHA: 05\/11\/2026 +HORA: 16:00/);
    assert.match(copias[0], /CHAMPU CLASICO NINO X 1\/2 L\.\n4 +2\.?100,00 +8\.?400,00/);
    assert.match(copias[0], /VUELTO +\$ 1\.?600,00/);
    assert.doesNotMatch(copias[0], /FIRMA|TALON/);
  });
}

test("descuento y comanda comparten trabajo con un único talón firmable y el saldo cero", async () => {
  const s = impresora();
  await s.P.imprimirTicket({ ...ticket, imprimir_comanda: true, reimpresion: true, venta: { ...ticket.venta, forma_pago: "DESCUENTO", total: 3021.25 },
    empresa: { ...ticket.empresa, texto_autorizacion: "Autorizo a retener de mi sueldo la suma de tres mil veintiún pesos con 25/100." },
    afiliado: { nombre: "Pérez, José", dni: "32111222", legajo: "10", departamental: "Mar del Plata", disponible: 0 } });
  assert.equal(s.trabajos.length, 1);
  const [cliente, talon, comanda] = partes(s.trabajos[0]);
  verificarPapel([cliente, talon, comanda], 40);
  for (const copia of [cliente, talon, comanda]) assert.match(copia, /REIMPRESION/);
  for (const copia of [cliente, comanda]) assert.doesNotMatch(copia, /RETENER|FIRMA:/);
  assert.match(talon, /SALDO DISPONIBLE +\$ 0,00/);
  assert.match(talon.replace(/\n/g, " "), /TRES MIL VEINTIUN PESOS CON 25\/100/);
  assert.match(talon, /PEREZ, JOSE\nLEGAJO: 10\nDNI: 32.111.222\nDEPARTAMENTAL: MAR DEL PLATA\n\n\n\nFIRMA: _/);
});

test("el talón conserva la autorización personalizada y omite un saldo histórico desconocido", async () => {
  const s = impresora();
  await s.P.imprimirTicket({ ...ticket, venta: { ...ticket.venta, forma_pago: "DESCUENTO_HABERES" },
    empresa: { texto_autorizacion: "Autorización del predio" }, afiliado: { nombre: "Ana", disponible: null } });
  const talon = partes(s.trabajos[0])[1];
  assert.match(talon, /AUTORIZACION DEL PREDIO/);
  assert.doesNotMatch(talon, /SALDO DISPONIBLE/);
});

test("reimprimir una venta anulada conserva su referencia sin volver a autorizar el descuento", async () => {
  const s = impresora();
  await s.P.imprimirTicket({ ...ticket, venta: { ...ticket.venta, estado: "ANULADA", forma_pago: "DESCUENTO" },
    reimpresion: true, afiliado: { nombre: "Ana", legajo: "10" }, empresa: { texto_autorizacion: "Autorizo a retener de mi sueldo" } });
  const [cliente, talon] = partes(s.trabajos[0]);
  for (const copia of [cliente, talon]) assert.match(copia, /VENTA ANULADA/);
  assert.match(talon, /DESCUENTO ANULADO/);
  assert.match(talon, /TICKET NRO: 000042/);
  assert.match(talon, /AFILIADO: ANA\nLEGAJO: 10/);
  assert.doesNotMatch(talon, /AUTORIZO|RETENER|FIRMA:/);
});

test("el papel angosto corta por palabra y conserva los tres valores cuando exceden una fila", async () => {
  const s = impresora();
  await s.P.imprimirTicket({ ...ticket, ancho: 58, items: [{ descripcion: "Acondicionador Sedal Balance Sachet",
    cantidad: 88888.125, precio_unitario: 12345678.99, subtotal: 1097380353935.74 }] });
  const [cliente] = partes(s.trabajos[0]);
  verificarPapel([cliente], 32);
  assert.match(cliente, /ACONDICIONADOR SEDAL BALANCE\nSACHET\nCANTIDAD +88888\.125\nIMP\.UNIT\. +12\.345\.678,99\nIMP\.TOTAL +1\.097\.380\.353\.935,74/);
});

test("el cierre respeta el ancho de la caja y conserva importes, observaciones y firmas", async () => {
  const s = impresora();
  await s.P.imprimirCierre({ ancho: 58, empresa: ticket.empresa,
    cierre: { id: 1, boca: "Confitería", caja: "Caja 1", fecha: ticket.venta.fecha, usuario_nombre: "José García", saldo_inicial: 0,
      ingresos: 4, egresos: 0, saldo_esperado: 4, efectivo_contado: 4, diferencia: 0, retiro: 4, queda_en_caja: 0,
      ventas_cantidad: 1, ventas_total: 4, observaciones: "Reposición mañana" }, ventas_por_forma: [{ forma_pago: "EFECTIVO", cantidad: 1, total: 4 }] });
  const [cierre] = partes(s.trabajos[0]);
  verificarPapel([cierre], 32);
  assert.match(cierre, /EFECTIVO ESPERADO +\$ 4,00/);
  assert.match(cierre, /EFECTIVO \(1\) +\$ 4,00/);
  assert.match(cierre, /OBSERVACIONES: REPOSICION MANANA/);
  assert.match(cierre, /FIRMA DEL CAJERO: _/);
  assert.match(cierre, /FIRMA DE QUIEN RECIBE: _/);
});

test("el cierre temporal imprime el resumen marcado y un ticket por bolsa, en papeles separados", async () => {
  for (const ancho of [58, 80]) {
    const s = impresora();
    s.P.f.fechaHora = () => "05/11/2026 08:00";
    const datos = { ancho, empresa: ticket.empresa,
      cierre: { id: 7, tipo: "TEMPORAL", estado: "PENDIENTE", boca: "Proveeduria", caja: "Caja 1", fecha: ticket.venta.fecha, usuario_nombre: "Ana",
        turno_inicio: "2026-11-05 08:00:00", saldo_inicial: 1000, ingresos: 500, egresos: 50, saldo_esperado: 1450,
        efectivo_contado: 1440, diferencia: -10, retiro: 1440, queda_en_caja: 0, esperado_ventas: 250, esperado_cambio: 1200,
        efectivo_ventas: 240, efectivo_cambio: 1200, ventas_cantidad: 2, ventas_total: 400 },
      efectivo: { saldo_inicial: 1000, agregados: 200, cambio: 1200, ventas: 300, anulaciones: 0, otros_cobros: 0, cobros: 300, retiros: 50, esperado_ventas: 250, esperado_cambio: 1200 },
      ventas_por_forma: [{ forma_pago: "EFECTIVO", cantidad: 1, total: 300 }, { forma_pago: "QR", cantidad: 1, total: 100 }] };
    await s.P.imprimirCierre(datos, { bolsas: true });
    const [resumen, ventas, cambio] = partes(s.trabajos[0]);
    verificarPapel([resumen, ventas, cambio], ancho === 58 ? 32 : 40);
    assert.equal(s.trabajos[0].body.hijos[0].hijos.length, 3);
    assert.match(resumen, /\*\*\* CIERRE TEMPORAL \*\*\*/);
    assert.match(resumen, /FALTA EL CIERRE DEFINITIVO/);
    assert.match(resumen, /TOTAL CAMBIO +\$ 1\.200,00/);
    assert.match(resumen, /TOTAL VENTAS Y COBROS +\$ 300,00/);
    assert.match(resumen, /FALTANTE +\$ 10,00/);
    assert.match(ventas, /BOLSA 1 DE 2/);
    assert.match(ventas, /RECAUDACION/);
    assert.match(ventas, /CERRO: ANA/);
    assert.match(ventas, /TURNO DESDE: 05\/11\/2026 08:00/);
    assert.match(ventas, /ESPERADO EN LA BOLSA +\$ 250,00/);
    assert.match(ventas, /EN ESTA BOLSA\n +\$ 240,00/);
    assert.match(cambio, /BOLSA 2 DE 2/);
    assert.match(cambio, /SALDO INICIAL +\$ 1\.000,00/);
    assert.match(cambio, /SIN DIFERENCIA/);
    // Sólo las bolsas: el primer papel no fuerza un corte antes.
    const s2 = impresora();
    s2.P.f.fechaHora = () => "05/11/2026 08:00";
    await s2.P.imprimirCierre(datos, { resumen: false, bolsas: true });
    assert.equal(s2.trabajos[0].body.hijos[0].hijos.length, 2);
    assert.equal(s2.trabajos[0].body.hijos[0].hijos[0].nombre, "pre.cierre");
    assert.equal(s2.trabajos[0].body.hijos[0].hijos[1].nombre, "pre.cierre.corte");
  }
});
