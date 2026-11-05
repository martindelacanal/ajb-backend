"use strict";

// Importación de un catálogo (proveedores y productos) desde otro sistema, por ejemplo el
// sistema anterior del camping (AJBGestion en Access). Corre igual sobre la base SQLite de
// la notebook y sobre la réplica MySQL del sistema general.
//
// Formato del archivo (JSON):
//   { proveedores: [{ codigo, razon_social, cuit, telefono, email, direccion, contacto, observaciones }],
//     productos: [{ nombre, codigo, precio_compra, margen, precio_venta, destino, perecedero,
//                   referencia: { fecha, precio_compra, precio_venta } }] }
//
// Lo que ya existe (mismo nombre, código o CUIT) se saltea: se puede correr más de una vez.
// Todo queda con creado_por = IMPORTADOR para poder filtrarlo y depurarlo después.

const U = require("./util");
const N = require("./negocio");
const { IMPORTADOR } = require("./listados");

const DESTINOS = ["VENTA_DIRECTA", "VENTA_COMPUESTA", "USO_INTERNO", "ALQUILER"];

const texto = (v, max) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const numero = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return U.redondear(Math.min(max, Math.max(min, n)), 2);
};
const clave = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

function limpiarProveedor(p) {
  const digitos = String(p.cuit || "").replace(/\D/g, "");
  const cuit = digitos.length === 11 && U.cuitValido(digitos) ? U.formatoCuit(digitos) : null;
  const email = texto(p.email, 120);
  const notas = [texto(p.observaciones, 1500)];
  if (!cuit && digitos && Number(digitos)) notas.push(`CUIT en el sistema anterior: ${digitos}`);
  return {
    codigo: texto(p.codigo, 30),
    razon_social: texto(p.razon_social, 160),
    cuit,
    telefono: texto(p.telefono, 40),
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    direccion: texto(p.direccion, 200),
    contacto: texto(p.contacto, 120),
    observaciones: notas.filter(Boolean).join("\n") || null,
  };
}

function limpiarProducto(p) {
  const compra = numero(p.precio_compra, 0, 99999999);
  const venta = numero(p.precio_venta, 0, 99999999);
  const ref = p.referencia && typeof p.referencia === "object" ? p.referencia : null;
  return {
    nombre: texto(p.nombre, 160),
    codigo: texto(p.codigo, 60),
    precio_compra: compra,
    margen: numero(p.margen, -100, 10000),
    precio_venta: venta,
    destino: DESTINOS.includes(p.destino) ? p.destino : "VENTA_DIRECTA",
    perecedero: p.perecedero ? 1 : 0,
    referencia: ref ? {
      fecha: /^\d{4}-\d{2}-\d{2}/.test(String(ref.fecha || "")) ? `${String(ref.fecha).slice(0, 10)} 00:00:00` : null,
      precio_compra: numero(ref.precio_compra, 0, 99999999),
      precio_venta: numero(ref.precio_venta, 0, 99999999),
    } : null,
  };
}

// Arma el plan sin escribir nada: qué se carga y qué se saltea (y por qué).
async function planificar(t, ctx, datos) {
  const pid = ctx.pid;
  const provExistentes = await t.all("SELECT razon_social, codigo, cuit FROM predio_proveedor WHERE predio_id = ?", [pid]);
  const nombresProv = new Set(provExistentes.map((p) => clave(p.razon_social)));
  const codigosProv = new Set(provExistentes.map((p) => String(p.codigo || "")).filter(Boolean));
  const cuits = new Set(provExistentes.map((p) => p.cuit).filter(Boolean));
  const prodExistentes = await t.all("SELECT nombre, codigo, activo FROM predio_producto WHERE predio_id = ?", [pid]);
  const nombresProd = new Set(prodExistentes.map((p) => clave(p.nombre)));
  const codigosProd = new Set(prodExistentes.filter((p) => Number(p.activo)).map((p) => String(p.codigo || "")).filter(Boolean));

  const plan = { proveedores: [], productos: [], salteados: [] };
  for (const crudo of datos.proveedores || []) {
    const p = limpiarProveedor(crudo);
    if (!p.razon_social) { plan.salteados.push({ tipo: "proveedor", nombre: "(sin razón social)", motivo: "sin razón social" }); continue; }
    if (nombresProv.has(clave(p.razon_social))) { plan.salteados.push({ tipo: "proveedor", nombre: p.razon_social, motivo: "ya existe" }); continue; }
    if (p.cuit && cuits.has(p.cuit)) { plan.salteados.push({ tipo: "proveedor", nombre: p.razon_social, motivo: `el CUIT ${p.cuit} ya está cargado` }); continue; }
    if (p.codigo && codigosProv.has(p.codigo)) p.codigo = null;
    nombresProv.add(clave(p.razon_social));
    if (p.cuit) cuits.add(p.cuit);
    if (p.codigo) codigosProv.add(p.codigo);
    plan.proveedores.push(p);
  }
  for (const crudo of datos.productos || []) {
    const p = limpiarProducto(crudo);
    if (!p.nombre) { plan.salteados.push({ tipo: "producto", nombre: "(sin nombre)", motivo: "sin nombre" }); continue; }
    if (nombresProd.has(clave(p.nombre))) { plan.salteados.push({ tipo: "producto", nombre: p.nombre, motivo: "ya existe un producto con ese nombre" }); continue; }
    if (p.codigo && codigosProd.has(p.codigo)) { plan.salteados.push({ tipo: "producto", nombre: p.nombre, motivo: `el código ${p.codigo} ya lo tiene otro producto` }); continue; }
    nombresProd.add(clave(p.nombre));
    if (p.codigo) codigosProd.add(p.codigo);
    plan.productos.push(p);
  }
  return plan;
}

async function siguienteCodigo(t, pid) {
  const filas = await t.all("SELECT codigo FROM predio_proveedor WHERE predio_id = ?", [pid]);
  let max = 0;
  for (const f of filas) {
    const n = Number(String(f.codigo || "").replace(/\D/g, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(4, "0");
}

// ctx: { db, pid }. Con simular = true sólo devuelve el plan.
async function importarCatalogo(ctx, datos, { simular = false, origen = "el sistema anterior" } = {}) {
  if (!datos || typeof datos !== "object") throw U.error("El archivo no tiene el formato esperado");
  const ctxImp = { ...ctx, usuario: { id: null, nombre: IMPORTADOR, rol: "ADMIN" }, origen: "SISTEMA" };
  return ctx.db.tx(async (t) => {
    const c = { ...ctxImp, db: t };
    const plan = await planificar(t, c, datos);
    const resultado = {
      proveedores: plan.proveedores.length,
      productos: plan.productos.length,
      productos_sin_precio: plan.productos.filter((p) => !(p.precio_venta > 0)).length,
      salteados: plan.salteados.length,
      detalle_salteados: plan.salteados.slice(0, 50),
      simulado: simular,
    };
    if (simular) return resultado;
    const ahora = U.fechaHora();
    for (const p of plan.proveedores) {
      if (!p.codigo) p.codigo = await siguienteCodigo(t, c.pid);
      await N.insertar(t, c, "predio_proveedor", { ...p, activo: 1 });
    }
    for (const p of plan.productos) {
      const { referencia, ...fila } = p;
      const id = await N.insertar(t, c, "predio_producto", { ...fila, fecha_caducidad: null, stock_minimo: 0, activo: 1 });
      // El último precio conocido queda en el historial del producto como referencia.
      const ref = referencia || {};
      await N.insertar(t, c, "predio_precio_historial", {
        producto_id: id,
        fecha: ref.fecha || ahora,
        precio_compra: ref.precio_compra || fila.precio_compra,
        margen: fila.margen,
        precio_venta: ref.precio_venta || fila.precio_venta,
        origen: "IMPORTACION",
        usuario_nombre: "Sistema anterior",
      });
    }
    await N.auditar(t, c, `Importación del catálogo de ${origen}`, "sistema", null, {
      proveedores: resultado.proveedores, productos: resultado.productos,
      productos_sin_precio: resultado.productos_sin_precio, salteados: resultado.salteados,
    });
    return resultado;
  });
}

module.exports = { importarCatalogo, planificar, limpiarProducto, limpiarProveedor, IMPORTADOR };
