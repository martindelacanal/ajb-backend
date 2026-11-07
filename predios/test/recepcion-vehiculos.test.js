"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const api = require("../lib/api");
const N = require("../lib/negocio");

test("Seguridad lee sólo vehículos y el saldo usa la cuenta sin duplicar los traspasos", async t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  t.after(() => db.cerrar());
  asegurarEsquema(db);
  const vehiculo = { id: 91, revision: 30, titular: "Nombre Apellido", vehiculo: { patente: "AB012CD" }, personas: [] };
  const seguridad = { id: 5, rol: "SEGURIDAD", nombre: "Guardia", gestionar_reservas: 1 };
  const ctx = {
    db, modo: "local", pid: 1, usuario: seguridad,
    servicios: { recepcion: async (accion) => accion === "vehiculos" ? { filas: [vehiculo] } : vehiculo }
  };
  await db.tx(async tx => {
    const persona = await N.insertar(tx, ctx, "predio_huesped", {
      reserva_id: 91, dni: "99112233", nombre: "Nombre Apellido", saldo: 20, ultima_revision: 30
    });
    for (const [concepto, importe, medio] of [
      ["DIFERENCIAL", 75, null], ["CARGA", 30, "TRANSFERENCIA"], ["COMPRA", -10, "SALDO"],
      ["TRASPASO_ALOJAMIENTO", -75, "CEDIDO"], ["TRASPASO_ALOJAMIENTO", 75, "RECIBIDO"],
      ["PAGO_SALIDA_CONSUMOS", 5, "TRANSFERENCIA"]
    ]) {
      await N.insertar(tx, ctx, "predio_estadia_mov", {
        reserva_id: 91, huesped_id: persona, fecha: "2026-11-07 12:00:00", concepto, importe, medio,
        detalle: "Observación interna de la cuenta"
      });
    }
    await N.insertar(tx, { ...ctx, pid: 2 }, "predio_estadia_mov", {
      reserva_id: 91, fecha: "2026-11-07 12:00:00", concepto: "DIFERENCIAL", importe: 900
    });
  });
  const ejecutar = (m, ruta, usuario = seguridad) => api.ejecutar({ ...ctx, usuario }, m, ruta);
  const { filas: [fila] } = await ejecutar("GET", "/recepcion/vehiculos");
  assert.equal(fila.deuda.total, 50);
  assert.equal(fila.deuda.reserva, 75);
  assert.equal(fila.deuda.consumos, -25);
  assert.equal(fila.deuda.desactualizada, false);
  assert.deepEqual(fila.deuda.detalle.map(m => m.importe), [-5, 10, -30, 75]);
  assert.equal(fila.deuda.detalle[0].concepto, "Pago de consumos en salida");
  assert.deepEqual(fila.deuda.traspasos.map(m => [m.concepto, m.importe]), [["Saldo de alojamiento trasladado", 75]]);
  assert.doesNotMatch(JSON.stringify(fila), /99112233|Observación interna/);
  assert.equal((await ejecutar("GET", "/recepcion/vehiculos/91")).id, 91);
  assert.deepEqual((await ejecutar("GET", "/recepcion/vehiculos/qr/ABCDEFGHIJKLMNOPQRSTUVWX01234567")).deuda, fila.deuda);
  await assert.rejects(ejecutar("GET", "/recepcion/vehiculos", { ...seguridad, rol: "CAJERO" }), { status: 403 });
  await assert.rejects(ejecutar("GET", "/recepcion/vehiculos", { ...seguridad, debe_cambiar_clave: 1 }), { status: 403 });
  await assert.rejects(ejecutar("GET", "/recepcion/detalle"), { status: 403 });
  await assert.rejects(ejecutar("POST", "/recepcion/vehiculos/91/salida"), { status: 403 });
  await assert.rejects(ejecutar("POST", "/recepcion/91/vehiculo/qr"), { status: 403 });

  vehiculo.revision = 31;
  assert.equal((await ejecutar("GET", "/recepcion/vehiculos/91")).deuda.desactualizada, true);
});
