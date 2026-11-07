"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const U = require("../lib/util");
const N = require("../lib/negocio");
const api = require("../lib/api");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { sembrarPredio } = require("../lib/semilla");
const { resumirCuenta } = require("../lib/cuenta-estadia");

test("la deuda pasa a quienes quedan, los cobros se imputan una vez y el último cierra la estadía", async t => {
  const db = crearSqlite(":memory:", { predioId: 1 });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const personas = ["99111001", "99111002", "99111003"].map((dni, i) => ({
    dni, nombre: "Pasajero " + i, apellido: "Prueba", entrada: U.hoy(), salida: null
  }));
  const [a, b, c] = personas.map(p => p.dni);
  const r = { id: 17, titular_dni: a, precio_total: 300, diferencia: 300, personas,
    diferenciales: personas.map(p => ({ dni: p.dni, importe: 100 })) };
  let evento = 1;
  let vehiculo = true;
  let cortarRespuesta = false;
  const confirmaciones = new Map();
  const ctx = { db, pid: 1, modo: "local", origen: "LOCAL", sesion: {},
    usuario: { id: 1, rol: "ADMIN", nombre: "Recepción" },
    servicios: { recepcion: async (accion, datos) => {
      if (accion === "confirmacion") return confirmaciones.get(datos.operacion) || null;
      if (accion === "detalle") return { reserva: r };
      const seleccion = new Set(datos.seleccion || []);
      if (accion === "cotizar") {
        const elegibles = personas.filter(p => !p.salida);
        return { cotizacion_esperada: "tarifa", diferencia: datos.extra || 0,
          diferenciales: datos.extra ? [{ dni: a, importe: datos.extra }] : [],
          salida: { personas: elegibles.filter(p => seleccion.has(p.dni)),
            presentes: elegibles.filter(p => !seleccion.has(p.dni)), elegibles, vehiculo_pendiente: vehiculo } };
      }
      assert.equal(accion, "guardar");
      if (!datos.id) return { ...r, evento_id: evento };
      personas.filter(p => seleccion.has(p.dni)).forEach(p => { p.salida = U.hoy(); });
      if (datos._salida_plan.vehiculo === "SALE") vehiculo = false;
      const cambio = { ...r, evento_id: ++evento, diferencia: datos.extra || 0,
        diferenciales: datos.extra ? [{ dni: a, importe: datos.extra }] : [], plan_salida: datos._salida_plan };
      confirmaciones.set(datos.operacion, cambio);
      if (cortarRespuesta) throw U.error("Sin conexión", 503);
      return cambio;
    } }
  };
  const call = (m, p, body = {}, query = {}) => api.ejecutar({ ...ctx, body, query }, m, p);
  const guardar = body => call("POST", "/recepcion/guardar", body);
  const cuenta = () => call("GET", "/recepcion/detalle", {}, { id: r.id }).then(d => d.cuenta);
  const revisar = async (seleccion, extra) => {
    const body = { id: r.id, operacion: U.uuid(), seleccion, extra };
    const previa = await call("POST", "/recepcion/cotizar", body);
    return { ...previa, body: { ...body, cuenta_esperada: previa.cuenta, cotizacion_esperada: previa.cotizacion_esperada } };
  };
  await db.tx(t => sembrarPredio(t, ctx, "MIRAMAR"));
  const caja = await db.get("SELECT id FROM predio_caja LIMIT 1");
  await guardar({ operacion: U.uuid() });
  const huesped = (await cuenta()).personas[0];
  await db.tx(t => N.insertar(t, ctx, "predio_estadia_mov", { reserva_id: r.id, huesped_id: huesped.id,
    fecha: U.fechaHora(), concepto: "COMPRA", medio: "SALDO", importe: -30 }));
  const primera = await revisar([a], 10);
  assert.deepEqual([primera.salida.alojamiento, primera.salida.consumos, primera.salida.total], [110, 30, 140]);
  await assert.rejects(guardar({ ...primera.body, salida: { accion: "TRASLADAR" } }), /vehículo/);
  const traspaso = { ...primera.body, salida: { accion: "TRASLADAR", vehiculo: "SALE" } };
  cortarRespuesta = true;
  await assert.rejects(guardar(traspaso), /Sin conexión/);
  cortarRespuesta = false;
  await guardar(traspaso);
  await guardar(traspaso);
  assert.equal((await cuenta()).pendiente, 310);
  assert.equal((await cuenta()).neto_consumos, 30);
  const segunda = await revisar([b]);
  assert.equal(segunda.salida.vehiculo_pendiente, false);
  assert.deepEqual([segunda.salida.alojamiento, segunda.salida.consumos, segunda.salida.personas[0].trasladado], [155, 15, 70]);
  const cobro = { ...segunda.body, salida: { accion: "COBRAR", medio: "EFECTIVO", caja_id: caja.id } };
  cortarRespuesta = true;
  await assert.rejects(guardar(cobro), /Sin conexión/);
  cortarRespuesta = false;
  await guardar(cobro);
  await guardar(cobro);
  const cajaSalida = await db.all("SELECT importe,tipo FROM predio_caja_movimiento WHERE concepto='LIQUIDACION_SALIDA'");
  assert.deepEqual(cajaSalida.map(m => [m.importe, m.tipo]), [[170, "INGRESO"]]);
  const ultima = await revisar([c]);
  assert.deepEqual([ultima.salida.alojamiento, ultima.salida.consumos, ultima.salida.total], [155, 15, 170]);
  await assert.rejects(guardar({ ...ultima.body, salida: { accion: "TRASLADAR" } }), /liquidación/);
  await guardar({ ...ultima.body, salida: { accion: "COBRAR", medio: "TRANSFERENCIA" } });
  const cerrada = await cuenta();
  assert.deepEqual([cerrada.pendiente, cerrada.neto_consumos, cerrada.saldo, cerrada.cierre_pendiente], [0, 0, 0, false]);
});

test("el reparto acredita el anticipo pagado y conserva el consumo que quedó sin pagar", () => {
  const personas = [{ id: 1, dni: "A", saldo: 50 }, { id: 2, dni: "B", saldo: 0 }];
  const movimientos = [
    { id: 5, huesped_id: 2, concepto: "COMPRA", importe: -60 },
    { id: 4, huesped_id: 1, concepto: "REPARTO", importe: -60 },
    { id: 3, huesped_id: 2, concepto: "REPARTO", importe: 60 },
    { id: 2, huesped_id: 1, concepto: "CARGA", medio: "AL_SALIR", importe: 70 },
    { id: 1, huesped_id: 1, concepto: "CARGA", medio: "TRANSFERENCIA", importe: 40 }
  ];
  const cuenta = resumirCuenta(personas, movimientos);
  assert.equal(cuenta.neto_consumos, 20);
  assert.equal(cuenta.saldos_individuales.A.consumos, 0);
  assert.equal(cuenta.saldos_individuales.B.consumos, 20);
});
