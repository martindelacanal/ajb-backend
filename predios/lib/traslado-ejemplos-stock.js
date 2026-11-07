"use strict";

const { ejecutar } = require("./api");
const { error } = require("./util");

const proveedor = { codigo: "DEMO-01", razon_social: "Cooperativa del Faro · Demo" };
const factura = "DEMO-0001";
const articulos = [
  { codigo: "DEMO1001", nombre: "Agua mineral", cantidad: 24, precio: 800 },
  { codigo: "DEMO1002", nombre: "Alfajor de chocolate", cantidad: 24, precio: 1000 },
  { codigo: "DEMO1003", nombre: "Yerba mate", cantidad: 10, precio: 3200 },
];

// El llamador incluye esta operación y su comprobante en una transacción de la instalación.
async function importarStockDemo(t, ctx) {
  if (t.dialecto !== "sqlite" || Number(ctx.pid) !== 1 || Number(t.predioId) !== 1) {
    throw error("Este traslado corresponde a la instalación de Camping Miramar.", 409);
  }
  const almacenes = await t.all(
    "SELECT id,nombre,es_origen FROM predio_boca WHERE predio_id=? AND activo=1 AND es_almacen=1", [ctx.pid]);
  const destinos = await t.all(
    "SELECT id,es_destino FROM predio_boca WHERE predio_id=? AND activo=1 AND nombre=?", [ctx.pid,"Proveeduría"]);
  const almacen = almacenes[0], destino = destinos[0];
  if (almacenes.length !== 1 || almacen.nombre !== "Almacén" || !Number(almacen.es_origen) ||
      destinos.length !== 1 || !Number(destino.es_destino) || Number(almacen.id) === Number(destino.id)) {
    throw error("El traslado requiere el Almacén de origen y la Proveeduría de destino activos en Miramar.", 409);
  }
  const proveedorPrevio = await t.get(
    "SELECT id FROM predio_proveedor WHERE predio_id=? AND (UPPER(codigo)=UPPER(?) OR LOWER(razon_social)=LOWER(?))",
    [ctx.pid, proveedor.codigo, proveedor.razon_social]);
  const facturaPrevia = await t.get("SELECT id FROM predio_compra WHERE predio_id=? AND UPPER(factura)=UPPER(?)", [ctx.pid, factura]);
  if (proveedorPrevio || facturaPrevia) throw error("El proveedor o la factura de muestra ya están en Miramar.", 409);

  for (const articulo of articulos) {
    const previo = await t.get("SELECT id FROM predio_producto WHERE predio_id=? AND (UPPER(codigo)=UPPER(?) OR LOWER(nombre)=LOWER(?))",
      [ctx.pid, articulo.codigo, articulo.nombre]);
    if (previo) throw error(`Ya existe un producto con el código o el nombre de «${articulo.nombre}».`, 409);
  }

  const post = (ruta, body) => ejecutar({ ...ctx, db: t, body, query: {} }, "POST", ruta);
  const altaProveedor = await post("/proveedores", proveedor);
  const items = [];
  for (const articulo of articulos) {
    const producto = await post("/productos", {
      codigo: articulo.codigo, nombre: articulo.nombre, precio_compra: articulo.precio,
      margen: 50, destino: "VENTA_DIRECTA", cantidad_almacen: 0,
    });
    items.push({ producto_id: producto.id, cantidad: articulo.cantidad, precio_unitario: articulo.precio });
  }
  const compra = await post("/compras", {
    proveedor_id: altaProveedor.id, boca_id: almacen.id, factura, fecha_factura: "2026-11-06",
    total_factura: 75200, items,
  });
  const traspaso = await post("/traspasos", {
    boca_origen_id: almacen.id, boca_destino_id: destino.id,
    lineas: items.map(item => ({ producto_id: item.producto_id, cantidad: 5 })),
  });
  return { proveedor_id: altaProveedor.id, producto_ids: items.map(item => item.producto_id),
    compra_id: compra.id, lote_traspaso: traspaso.lote, traspaso_ids: traspaso.ids };
}

module.exports = { importarStockDemo };
