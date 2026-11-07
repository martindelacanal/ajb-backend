"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mesAnterior, avisosGenerales } = require("../api/services/predios-inventario");

test("el resumen usa el mes calendario anterior completo en los cambios de año", () => {
  assert.deepEqual(mesAnterior("2027-01-01"), { periodo: "2026-12", desde: "2026-12-01", hasta: "2027-01-01" });
});

// Sólo tablas temporales de esta conexión local: se puede correr contra una base de desarrollo con datos.
test("MySQL entrega una vez por admin y período, separa ajustes de ventas y respeta meses cortos", { skip: !process.env.PREDIOS_TEST_MYSQL_ENV }, async t => {
  const fs = require("node:fs");
  const { parsearBloquesEnv, crearOpcionesConexion } = require("../scripts/migrar-webauthn-v1");
  const config = parsearBloquesEnv(fs.readFileSync(process.env.PREDIOS_TEST_MYSQL_ENV, "utf8")).develop;
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(config.DB_HOST));
  const c = await require("mysql2/promise").createConnection(crearOpcionesConexion(config));
  t.after(() => c.end());
  const tablas = {
    rol: "id INT, nombre VARCHAR(30)", usuario: "id INT, rol_id INT, habilitado VARCHAR(5)",
    predio: "id INT PRIMARY KEY, codigo TEXT, nombre TEXT, escritor TEXT, ultimo_push DATETIME, activo INT, fecha_creacion DATETIME",
    predio_producto: "predio_id INT, id INT, activo INT, perecedero INT, fecha_caducidad DATE, nombre TEXT",
    predio_movimiento: "predio_id INT, fecha DATETIME, tipo TEXT, referencia_tipo TEXT, cantidad INT",
    predio_stock: "predio_id INT, producto_id INT, cantidad INT",
    notificacion: "usuario_id INT, tipo TEXT, titulo TEXT, mensaje TEXT, payload JSON",
    predio_inventario_envio: "clave VARCHAR(100), usuario_id INT, PRIMARY KEY(clave,usuario_id)",
  };
  for (const [tabla, columnas] of Object.entries(tablas)) await c.query(`CREATE TEMPORARY TABLE ${tabla} (${columnas}) ENGINE=InnoDB`);
  await c.query("INSERT INTO rol VALUES (1,'admin'),(2,'otro')");
  await c.query("INSERT INTO usuario VALUES (1,1,'S'),(2,1,'N'),(3,2,'S'),(4,1,'S')");
  await c.query("INSERT INTO predio VALUES (1,'A','Predio A','CENTRAL',NULL,1,'2026-01-01'),(2,'B','Predio B','LOCAL',NULL,1,'2026-01-01')");
  await c.query("INSERT INTO predio_producto VALUES (1,7,1,1,'2027-03-31','Leche')");
  await c.query("INSERT INTO predio_stock VALUES (1,7,3)");
  await c.query(`INSERT INTO predio_movimiento VALUES (1,'2027-01-01','ALTA','producto',10),(1,'2027-01-15','BAJA','baja',-4),
    (1,'2027-01-15','AJUSTE','producto',-1),(1,'2027-01-15','VENTA','venta',-2),(1,'2027-02-01','BAJA','baja',-3)`);
  await avisosGenerales(c, "2027-02-27");
  let [filas] = await c.query("SELECT * FROM notificacion ORDER BY usuario_id");
  assert.deepEqual(filas.map(f => f.usuario_id), [1,4]);
  assert.match(filas[0].mensaje, /Predio A: 1 alta y 2 bajas/);
  assert.match(filas[0].mensaje, /Predio B: 0 altas y 0 bajas/);
  await avisosGenerales(c, "2027-02-28");
  await avisosGenerales(c, "2027-02-28");
  [filas] = await c.query("SELECT usuario_id FROM notificacion WHERE tipo='PREDIO_VENCIMIENTO' ORDER BY usuario_id");
  assert.deepEqual(filas.map(f => f.usuario_id), [1,4]);
  await avisosGenerales(c, "2027-03-01");
  const [[tot]] = await c.query("SELECT COUNT(*) AS n FROM notificacion");
  assert.equal(tot.n, 6);
});
