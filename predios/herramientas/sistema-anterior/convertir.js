"use strict";

// Convierte lo exportado del sistema anterior (exportar-access.ps1) al formato de importación
// de catálogo (lib/importacion.js). Elige:
//   - productos: los usados (vendidos, comprados o pedidos) desde --desde, o con precio de venta
//     vigente en el sistema anterior; nunca los que el sistema anterior marcó «VIEJO - …».
//   - proveedores: los que tienen compras desde --desde.
// Uso: node convertir.js --entrada C:\temp\access --salida catalogo.json [--desde 2024-12-01]

const fs = require("node:fs");
const path = require("node:path");

function arg(nombre, defecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : defecto;
}

const entrada = path.resolve(arg("entrada", "."));
const salida = path.resolve(arg("salida", "catalogo.json"));
const desde = arg("desde", "2024-12-01");

// Algunos textos del sistema anterior quedaron con la codificación rota («CAÃ‘UELAS»).
function arreglar(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (!/Ã|Â/.test(s) || /[^\x00-\xff]/.test(s)) return s;
  const r = Buffer.from(s, "latin1").toString("utf8");
  return r.includes("\uFFFD") ? s : r;
}

function tsv(archivo) {
  const ruta = path.join(entrada, archivo);
  if (!fs.existsSync(ruta)) return [];
  const [cabecera, ...lineas] = fs.readFileSync(ruta, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = cabecera.split("\t");
  return lineas.map((l) => {
    const v = l.split("\t");
    const o = {};
    cols.forEach((c, i) => { o[c] = v[i] === undefined ? "" : v[i]; });
    return o;
  });
}

const clave = (s) => arreglar(s).toUpperCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const dia = (f) => (f ? String(f).slice(0, 10) : null);
const red = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- actividad reciente
const uso = new Map(); // nombre -> { fecha, venta: { fecha, precio }, compra: { fecha, precio } }
function registrar(nombre, fecha, tipo, precio) {
  const d = dia(fecha);
  if (!nombre || !d || d < desde) return;
  const k = clave(nombre);
  const u = uso.get(k) || { fecha: null };
  if (!u.fecha || d > u.fecha) u.fecha = d;
  if (tipo && precio > 0 && (!u[tipo] || d >= u[tipo].fecha)) u[tipo] = { fecha: d, precio };
  uso.set(k, u);
}
for (const archivo of fs.readdirSync(entrada).filter((a) => /^ventas-.*\.tsv$/.test(a))) {
  for (const r of tsv(archivo)) registrar(r.DESCRIPCION, r.FECHA, "venta", num(r.PRECIO));
}
const ultimaCompraProveedor = new Map();
for (const r of tsv("compras.tsv")) {
  const fecha = r.FACTURA_FECHA || r.FECHA_CARGA;
  registrar(r.PRODUCTO, fecha, "compra", num(r.PRECIO_UNITARIO));
  const p = clave(r.PROVEEDOR);
  const d = dia(fecha);
  if (p && d && (!ultimaCompraProveedor.has(p) || d > ultimaCompraProveedor.get(p))) ultimaCompraProveedor.set(p, d);
}
for (const r of tsv("solicitudes.tsv")) registrar(r.PRODUCTO, r.ULTIMA, null, 0);

// ---------------------------------------------------------------- productos
const DESTINOS = { "VENTA DIRECTA": "VENTA_DIRECTA", "VENTA COMPUESTA": "VENTA_COMPUESTA", "USO INTERNO": "USO_INTERNO", ALQUILER: "ALQUILER" };
const descartados = { viejos: 0, sin_uso: 0 };
let elegidos = [];
for (const r of tsv("productos.tsv")) {
  const nombre = arreglar(r.DESC_PRODUCTO);
  if (!nombre) continue;
  if (/^VIEJO\b/i.test(nombre)) { descartados.viejos++; continue; }
  const u = uso.get(clave(nombre));
  const venta = red(num(r.VALOR_VENTA));
  if (!u && !(venta > 0)) { descartados.sin_uso++; continue; }
  // El costo de la ficha del sistema anterior no se actualizaba con cada compra: si hay una
  // compra reciente se usa ese precio, salvo que sea muy distinto (bulto contra unidad).
  const compraAbm = num(r.VALOR_COMPRA) > 1 ? num(r.VALOR_COMPRA) : 0;
  const ultimaCompra = u?.compra ? u.compra.precio : 0;
  const parecida = compraAbm > 0 && ultimaCompra > 0 && ultimaCompra / compraAbm >= 0.5 && ultimaCompra / compraAbm <= 3;
  const compra = red(parecida || (!compraAbm && ultimaCompra > 0) ? ultimaCompra : compraAbm);
  elegidos.push({
    id_anterior: Number(r.ID_PRODUCTO),
    nombre,
    codigo: String(r.CODIGO || "").trim() || null,
    precio_compra: compra,
    margen: compra > 0 ? red(num(r.MARGEN)) : 0,
    precio_venta: venta,
    destino: DESTINOS[String(r.TIPO_DESTINO || "").trim().toUpperCase()] || "VENTA_DIRECTA",
    perecedero: String(r.PERECEDERO || "").trim().toUpperCase() === "SI" ? 1 : 0,
    ultimo_uso: u ? u.fecha : null,
    referencia: {
      fecha: (u && (u.venta?.fecha || u.compra?.fecha || u.fecha)) || null,
      precio_compra: u?.compra ? red(u.compra.precio) : compra,
      precio_venta: u?.venta ? red(u.venta.precio) : venta,
    },
  });
}
// El más usado últimamente primero: se queda con el código y el nombre si hay repetidos.
elegidos.sort((a, b) => String(b.ultimo_uso || "").localeCompare(String(a.ultimo_uso || "")) || b.id_anterior - a.id_anterior);
const codigos = new Set();
const nombres = new Set();
let codigosRepetidos = 0;
let nombresRepetidos = 0;
for (const p of elegidos) {
  if (p.codigo && codigos.has(p.codigo)) { p.codigo = null; codigosRepetidos++; }
  if (p.codigo) codigos.add(p.codigo);
  if (nombres.has(clave(p.nombre))) { p.nombre = `${p.nombre} (${p.id_anterior})`; nombresRepetidos++; }
  nombres.add(clave(p.nombre));
}
elegidos.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

// ---------------------------------------------------------------- proveedores
const proveedores = [];
let proveedoresSinCompras = 0;
for (const r of tsv("proveedores.tsv")) {
  const razon = arreglar(r.RAZON_SOCIAL);
  if (!razon) continue;
  const ultima = ultimaCompraProveedor.get(clave(razon));
  if (!ultima) { proveedoresSinCompras++; continue; }
  const [a, m, d] = ultima.split("-");
  proveedores.push({
    codigo: String(r.ID_RAZON_SOCIAL || "").padStart(4, "0"),
    razon_social: razon,
    cuit: String(r.CUIT || "").replace(/\D/g, "") || null,
    telefono: [arreglar(r.TELEFONO), r.FAX ? `Fax ${arreglar(r.FAX)}` : ""].filter(Boolean).join(" / ") || null,
    email: arreglar(r.MAIL).toLowerCase() || null,
    direccion: [arreglar(r.DIRECCION), arreglar(r.LOCALIDAD), arreglar(r.PROVINCIA), r.COD_POSTAL ? `CP ${arreglar(r.COD_POSTAL)}` : ""].filter(Boolean).join(", ") || null,
    contacto: arreglar(r.CONTACTO) || null,
    observaciones: [
      `Código en el sistema anterior: ${r.ID_RAZON_SOCIAL}`,
      r.CAT_IVA ? `Condición frente al IVA: ${arreglar(r.CAT_IVA)}` : "",
      `Última compra en el sistema anterior: ${d}/${m}/${a}`,
    ].filter(Boolean).join("\n"),
  });
}
proveedores.sort((a, b) => a.razon_social.localeCompare(b.razon_social, "es"));

const resultado = {
  origen: "AJBGestion (sistema anterior del camping)",
  generado: new Date().toISOString(),
  criterio: `Productos usados desde ${desde} o con precio vigente; proveedores con compras desde ${desde}`,
  resumen: {
    productos: elegidos.length,
    productos_sin_precio: elegidos.filter((p) => !(p.precio_venta > 0)).length,
    descartados_viejos: descartados.viejos,
    descartados_sin_uso: descartados.sin_uso,
    codigos_repetidos_quitados: codigosRepetidos,
    nombres_repetidos_renombrados: nombresRepetidos,
    proveedores: proveedores.length,
    proveedores_sin_compras_recientes: proveedoresSinCompras,
  },
  proveedores,
  productos: elegidos,
};
fs.writeFileSync(salida, JSON.stringify(resultado, null, 1));
console.log(resultado.resumen);
console.log(`Archivo: ${salida}`);
