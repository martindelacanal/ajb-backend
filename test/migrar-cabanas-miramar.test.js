"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizarReserva } = require("../scripts/migrar-cabanas-miramar");
const { crearSqlite, asegurarEsquema } = require("../predios/lib/db-sqlite");
const { aplicarMaestros } = require("../predios/lib/maestros");
const { cuenta } = require("../predios/lib/api/recepcion");
const N = require("../predios/lib/negocio");

const origen = () => ({
  id: 52, servicio_id: 11, servicio: "Cabañas · Demostración", recurso_id: 86,
  titular_dni: "99067310", titular_nombre: "Arenas Demo, Mila", precio_total: 204200,
  automatico: 204200, manual: null, diferencia: 204200, tramos: [],
  observaciones: "Una huésped, dos cabañas y artículos con distintos días de uso.",
  personas: [{ dni: "99067310", nombre: "Mila", apellido: "Arenas Demo", precio: 190000, entrada: "2026-11-05", salida: null }],
  recursos: [{ id: 86, nombre: "Cabaña Los Aromos" }, { id: 87, nombre: "Cabaña El Pinar" }],
  tarifas_recursos: [{ dni: "99067310", noches: [86, 87].flatMap(recurso_id =>
    Array.from({ length: 5 }, (_, i) => ({ fecha: "2026-11-0" + (5 + i), recurso_id, precio: recurso_id === 86 ? 18000 : 20000 }))) }],
  adicionales: [{ adicional_id: 32, cantidad: 1, subtotal: 7000 }, { adicional_id: 33, cantidad: 2, subtotal: 7200 }],
  alquileres: [{ adicional_id: 32, fecha_desde: "2026-11-05", fecha_hasta: "2026-11-06" },
    { adicional_id: 33, fecha_desde: "2026-11-06", fecha_hasta: "2026-11-07" }]
});

test("T-52 conserva la cabaña principal, pasajeros y alquileres con un ajuste de cien mil", () => {
  const antes = origen(), copia = structuredClone(antes);
  const despues = normalizarReserva(antes, { id: 3 }, [87]);
  assert.deepEqual(antes, copia);
  assert.equal(despues.servicio_id, 3);
  assert.equal(despues.servicio, "Cabañas");
  assert.equal(despues.precio_total, 104200);
  assert.equal(despues.diferencia, -100000);
  assert.equal(despues.personas[0].precio, 90000);
  assert.equal(despues.personas[0].entrada, "2026-11-05");
  assert.deepEqual(despues.recursos, [antes.recursos[0]]);
  assert.deepEqual(despues.alquileres, antes.alquileres);
  assert.deepEqual(despues.adicionales, antes.adicionales);
});

test("la corrección se detiene si cambió el importe, el titular o las unidades de T-52", () => {
  for (const cambio of [{ precio_total: 220000 }, { titular_dni: "99067311" }, { id: 53 }, { manual: 190000 }]) {
    assert.throws(() => normalizarReserva({ ...origen(), ...cambio }, { id: 3 }, [87]));
  }
  assert.throws(() => normalizarReserva(origen(), { id: 3 }, [88]));
  const alterada = origen();
  alterada.tarifas_recursos[0].noches[9].precio = 1;
  assert.throws(() => normalizarReserva(alterada, { id: 3 }, [87]));
});

test("la entrega repetida de la corrección ajusta una sola vez la cuenta local", async t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, usuario: { id: null, nombre: "Sincronización" }, origen: "SISTEMA" };
  const antes = origen(), despues = normalizarReserva(antes, { id: 3 }, [87]);
  const entregar = (id, actual) => db.tx(tx => aplicarMaestros(tx, ctx, { recepcion_confirmada: [{
    id, operacion: `correccion-miramar-test-${id}`, empleado_id: null, actor: "Sistema", actual: JSON.stringify({ ...actual, huella_local: "test" })
  }] }));
  await entregar(20, antes);
  assert.equal((await cuenta(db, ctx, 52)).pendiente, 204200);
  await entregar(25, despues);
  await entregar(25, despues);
  assert.equal((await cuenta(db, ctx, 52)).pendiente, 104200);
  assert.deepEqual(await db.all("SELECT importe FROM predio_estadia_mov WHERE reserva_id=52 ORDER BY id"), [{ importe: 204200 }, { importe: -100000 }]);
  assert.deepEqual(await db.all("SELECT entrada,salida,ultima_revision FROM predio_huesped WHERE reserva_id=52"),
    [{ entrada: "2026-11-05", salida: null, ultima_revision: 25 }]);
});

test("el cambio de servicio conserva la estadía pagada y finalizada con saldo cero", async t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const ctx = { db, pid: 1, usuario: { id: null, nombre: "Sincronización" }, origen: "SISTEMA" };
  const antes = { ...origen(), id: 55, precio_total: 39500, diferencia: 39500, titular_dni: "99067313",
    personas: [{ dni: "99067313", nombre: "Vera", apellido: "Salinas Demo", precio: 36000, entrada: "2026-10-29", salida: "2026-10-31" }],
    recursos: [{ id: 86, nombre: "Cabaña Los Aromos" }] };
  const despues = normalizarReserva(antes, { id: 3 });
  assert.equal(despues.diferencia, 0);
  const eventos = [antes, despues].map((actual, i) => ({ id: 23 + i, operacion: `miramar-test-pago-${i}`, actor: "Sistema", actual: JSON.stringify({ ...actual, huella_local: "test" }) }));
  await db.tx(async tx => {
    await aplicarMaestros(tx, ctx, { recepcion_confirmada: eventos });
    await N.insertar(tx, ctx, "predio_estadia_mov", { reserva_id: 55, concepto: "PAGO_RESERVA", medio: "TRANSFERENCIA", importe: 39500, fecha: "2026-11-06 21:38:02" });
  });
  assert.equal((await cuenta(db, ctx, 55)).pendiente, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_estadia_mov WHERE reserva_id=55")).n, 2);
  assert.equal((await db.get("SELECT salida FROM predio_huesped WHERE reserva_id=55")).salida, "2026-10-31");
});
