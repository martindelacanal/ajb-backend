"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const N = require("../lib/negocio");
const { cuenta } = require("../lib/api/recepcion");
const { trasladarEjemplosMiramar } = require("../lib/traslado-ejemplos-miramar");

const config = { predio_codigo: "MIRAMAR", predio_id: 1 };
const cuerpo = {
  clave: "traslado-miramar-demo-20261106-v1",
  pago: { id: 5, predio_id: 7, reserva_id: 55, concepto: "PAGO_RESERVA", medio: "TRANSFERENCIA",
    importe: 39500, fecha: "2026-11-06 21:38:02", detalle: "Pago ficticio de la estadía finalizada.",
    usuario_nombre: "Recepción · Demostración" },
  recibo: { id: 5, predio_id: 7, clave: "edb6aa4a-8049-4dd7-9b71-05a0f6f00aa2",
    huella: "28d9dace3ebe109a4a29acc9e6428c4cb226959f95775c0ee46cc4d6646eb067",
    respuesta: '{"mensaje":"Movimiento registrado","liquidacion_id":null}' }
};

async function preparar(t) {
  const db = crearSqlite(":memory:", { predioId: config.predio_id });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: config.predio_id, usuario: { id: null, nombre: "Sincronización" } };
  const altas = [
    ["Mila Arenas Demo", "2026-11-05", null, 204200],
    ["Bruno Médano Demo", "2026-11-02", null, 69600],
    ["Luz Ribera Demo", null, null, 59500],
    ["Vera Salinas Demo", "2026-10-29", "2026-10-31", 39500],
    ["Felipe Faro Demo", "2026-11-06", null, 48000],
  ];
  await db.tx(async tx => {
    await sembrarPredio(tx, ctx, "MIRAMAR");
    for (const [i,[nombre,entrada,salida,importe]] of altas.entries()) {
      const reserva_id = 52 + i;
      await N.insertar(tx,ctx,"predio_huesped",{ reserva_id,dni:String(99067310+i),nombre,entrada,salida,titular:1,afiliado:0,saldo:0 });
      await N.insertar(tx,ctx,"predio_estadia_mov",{ reserva_id,concepto:"DIFERENCIAL",importe,fecha:"2026-11-06 21:38:02" });
    }
  });
  return { db, ctx, trasladar: () => db.tx(tx => trasladarEjemplosMiramar(tx,config,cuerpo)) };
}

test("el pago original salda T-55 y la compra abastece los dos depósitos una sola vez", async t => {
  const { db, ctx, trasladar } = await preparar(t);
  assert.equal((await cuenta(db,ctx,55)).pendiente,39500);
  await trasladar();
  await trasladar();
  assert.equal((await cuenta(db,ctx,55)).pendiente,0);
  assert.equal((await cuenta(db,ctx,53)).pendiente,69600);
  const pagos = await db.all("SELECT fecha,medio,importe FROM predio_estadia_mov WHERE concepto='PAGO_RESERVA'");
  assert.deepEqual(pagos,[{ fecha:cuerpo.pago.fecha, medio:"TRANSFERENCIA", importe:39500 }]);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_compra WHERE factura='DEMO-0001'")).n,1);
  const stock = await db.all(`SELECT p.codigo, SUM(s.cantidad) AS total,
    SUM(CASE WHEN b.es_almacen=1 THEN s.cantidad ELSE 0 END) AS almacen,
    SUM(CASE WHEN b.nombre='Proveeduría' THEN s.cantidad ELSE 0 END) AS proveeduria
    FROM predio_stock s JOIN predio_producto p ON p.predio_id=s.predio_id AND p.id=s.producto_id
    JOIN predio_boca b ON b.predio_id=s.predio_id AND b.id=s.boca_id
    GROUP BY p.codigo ORDER BY p.codigo`);
  assert.deepEqual(stock.map(s=>[s.total,s.almacen,s.proveeduria]),[[24,19,5],[24,19,5],[10,5,5]]);
});

test("un fallo al trasladar mercadería revierte también la compra, los productos y el pago", async t => {
  const { db, ctx, trasladar } = await preparar(t);
  db.conexion.exec(`CREATE TRIGGER bloquear_traspaso BEFORE INSERT ON predio_movimiento
    WHEN NEW.tipo='TRASPASO_SALIDA' BEGIN SELECT RAISE(ABORT,'Traslado en conflicto'); END`);
  await assert.rejects(trasladar,/Traslado en conflicto/);
  assert.equal((await cuenta(db,ctx,55)).pendiente,39500);
  for (const tabla of ["predio_proveedor","predio_producto","predio_compra","predio_stock","predio_solicitud"]) {
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM "+tabla)).n,0,tabla);
  }
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_recepcion_recibo WHERE clave=?",[cuerpo.recibo.clave])).n,0);
});
