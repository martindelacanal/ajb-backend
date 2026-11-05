"use strict";

// Prepara una base local de prueba (sin sistema general): bocas, cajas y algunos productos.
// Uso: node herramientas/semilla-local.js --base .local [--productos]

const path = require("node:path");
const fs = require("node:fs");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const U = require("../lib/util");

const i = process.argv.indexOf("--base");
const base = path.resolve(i >= 0 ? process.argv[i + 1] : ".local");
fs.mkdirSync(path.join(base, "datos"), { recursive: true });
const db = crearSqlite(path.join(base, "datos", "predio.db"), { predioId: 1 });
asegurarEsquema(db);
const ctx = { db, pid: 1, usuario: { id: null, nombre: "Semilla" }, origen: "SISTEMA" };

(async () => {
  const r = await db.tx((t) => sembrarPredio(t, { ...ctx, db: t }, "MIRAMAR"));
  console.log("Semilla:", r);
  if (process.argv.includes("--productos")) {
    await db.tx(async (t) => {
      const c = { ...ctx, db: t };
      const almacen = await N.bocaAlmacen(t, c);
      const ejemplos = [
        ["Agua mineral 500 ml", "7790315001234", 350, 60, "VENTA_DIRECTA", 0, 48],
        ["Gaseosa cola 1,5 L", "7790895000997", 1200, 50, "VENTA_DIRECTA", 0, 36],
        ["Alfajor triple", "7790040113508", 450, 70, "VENTA_DIRECTA", 1, 60],
        ["Café con leche", "CAFE01", 0, 0, "VENTA_COMPUESTA", 0, 0],
        ["Lavandina 1 L", "7790990000012", 600, 0, "USO_INTERNO", 0, 20],
        ["Sombrilla (alquiler por día)", "ALQ-SOMB", 0, 0, "ALQUILER", 0, 0],
      ];
      for (const [nombre, codigo, compra, margen, destino, perecedero, cantidad] of ejemplos) {
        const existe = await t.get("SELECT id FROM predio_producto WHERE predio_id = 1 AND codigo = ?", [codigo]);
        if (existe) continue;
        const venta = destino === "VENTA_COMPUESTA" ? 2500 : destino === "ALQUILER" ? 8000 : U.redondear(compra * (1 + margen / 100));
        const id = await N.insertar(t, c, "predio_producto", {
          nombre, codigo, precio_compra: compra, margen, precio_venta: venta, destino, perecedero,
          fecha_caducidad: perecedero ? U.sumarDias(U.hoy(), 20) : null, activo: 1,
        });
        if (cantidad) await N.moverStock(t, c, { bocaId: almacen.id, productoId: id, cantidad, tipo: "ALTA_INICIAL", detalle: "Semilla" });
      }
    });
    console.log("Productos de ejemplo cargados");
  }
  db.cerrar();
})().catch((e) => { console.error(e); process.exit(1); });
