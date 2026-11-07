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

test("ubicación y vehículos sin cotizar: la revisión nueva actualiza los huéspedes una sola vez y sin dinero", async t => {
  const U = require("../lib/util");
  const db = crearSqlite(":memory:", { predioId: 1 });
  t.after(() => db.cerrar());
  asegurarEsquema(db);
  const llamadas = [];
  let sinCambios = false;
  const admin = { id: 1, rol: "ADMIN", nombre: "Recepción" };
  const ctx = {
    db, modo: "local", pid: 1, usuario: admin, sesion: {},
    servicios: { recepcion: async (accion, datos) => {
      llamadas.push([accion, datos]);
      assert.equal(accion, "ajustarEstadia");
      if (sinCambios) return { id: 40, sin_cambios: true };
      return { id: 40, titular_dni: "30111222", afiliado: 0, precio_total: 500, diferencia: 0, diferenciales: [], evento_id: 77,
        personas: [{ dni: "30111222", nombre: "Ana", apellido: "Paz", entrada: U.hoy(), salida: null }],
        cambios: [["Ubicación", null, "Bajo los pinos"]] };
    } }
  };
  const ejecutar = (m, ruta, body = {}, usuario = admin) => api.ejecutar({ ...ctx, usuario, body }, m, ruta);
  const cuerpo = { operacion: "ubicacion-0000000001", ubicacion: "Bajo los pinos", version: "v1" };
  const primera = await ejecutar("POST", "/recepcion/40/estadia", cuerpo);
  const segunda = await ejecutar("POST", "/recepcion/40/estadia", cuerpo);
  assert.deepEqual(segunda, primera);
  assert.equal(llamadas.length, 1, "el reintento no vuelve a Turismo");
  assert.deepEqual(llamadas[0][1], { id: "40", operacion: cuerpo.operacion, version: "v1", motivo: undefined, ubicacion: "Bajo los pinos" });
  const huesped = await db.get("SELECT * FROM predio_huesped WHERE reserva_id=40");
  assert.equal(Number(huesped.ultima_revision), 77);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_estadia_mov")).n, 0);
  await assert.rejects(ejecutar("POST", "/recepcion/40/estadia", { ...cuerpo, ubicacion: "Otra" }), { status: 409 });
  await assert.rejects(ejecutar("POST", "/recepcion/40/estadia", cuerpo, { id: 5, rol: "SEGURIDAD", nombre: "Guardia" }), { status: 403 });
  await assert.rejects(ejecutar("POST", "/recepcion/40/estadia", cuerpo, { id: 6, rol: "CAJERO", nombre: "Caja", gestionar_reservas: 0 }), { status: 403 });
  sinCambios = true;
  const nada = await ejecutar("POST", "/recepcion/40/estadia", { operacion: "ubicacion-0000000002", ubicacion: "Bajo los pinos" });
  assert.equal(nada.sin_cambios, true);
  assert.equal(await db.get("SELECT 1 AS hay FROM predio_recepcion_recibo WHERE clave='ubicacion-0000000002'"), undefined);
});
