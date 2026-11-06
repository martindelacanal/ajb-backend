"use strict";

const test = require("node:test"),
  assert = require("node:assert/strict"),
  {
    crearSqlite,
    asegurarEsquema
  } = require("../lib/db-sqlite");
const {
    sembrarPredio
  } = require("../lib/semilla"),
  api = require("../lib/api"),
  N = require("../lib/negocio"),
  U = require("../lib/util");
test("saldo personal, reparto, venta mixta y reversión conservan stock, caja y pasivos", async t => {
  const db = crearSqlite(":memory:", {
    predioId: 1
  });
  asegurarEsquema(db);
  t.after(() => db.cerrar());
  const r = {
    id: 315,
    usuario_id: 135,
    afiliado: 0,
    titular_dni: "99911222",
    titular_nombre: "Demo",
    precio_total: 0,
    diferencia: 0,
    personas: [{
      dni: "99911222",
      nombre: "Uno",
      apellido: "Ejemplo",
      entrada: U.hoy()
    }, {
      dni: "99911223",
      nombre: "Dos",
      apellido: "Ejemplo",
      entrada: U.hoy()
    }]
  };
  const ctx = {
    db,
    pid: 1,
    modo: "local",
    origen: "LOCAL",
    usuario: {
      id: 1,
      rol: "ADMIN",
      nombre: "Empleada"
    },
    servicios: {
      recepcion: async k => k === "guardar" ? r : {
        reserva: r
      }
    },
    sesion: {}
  };
  await db.tx(tx => sembrarPredio(tx, ctx, "MIRAMAR"));
  const caja = await db.get("SELECT * FROM predio_caja LIMIT 1");
  ctx.sesion = {
    caja_id: caja.id,
    boca_id: caja.boca_id
  };
  const call = (m, p, b = {}, query = {}, usuario = ctx.usuario) => api.ejecutar({
    ...ctx,
    usuario,
    body: b,
    query
  }, m, p);
  await assert.rejects(call("GET", "/recepcion/detalle", {}, {}, {
    id: 2,
    rol: "CAJERO"
  }), e => e.status === 403);
  const alta = {
    operacion: U.uuid()
  };
  await call("POST", "/recepcion/guardar", alta);
  await call("POST", "/recepcion/guardar", alta);
  const cuenta = () => call("GET", "/recepcion/detalle", {}, {
    id: r.id
  }).then(x => x.cuenta);
  const [a, b] = (await cuenta()).personas;
  const mover = datos => call("POST", "/recepcion/315/cuenta", {
    operacion: U.uuid(),
    ...datos
  });
  await assert.rejects(mover({
    accion: "CARGA",
    medio: "AL_SALIR",
    huesped_id: a.id,
    importe: 100
  }), /particulares/);
  await mover({
    accion: "CARGA",
    medio: "EFECTIVO",
    huesped_id: a.id,
    importe: 100
  });
  await mover({
    accion: "REPARTIR",
    huesped_id: a.id,
    destino_id: b.id,
    importe: 40
  });
  const p = await call("POST", "/productos", {
    nombre: "Producto",
    destino: "VENTA_DIRECTA",
    precio_venta_manual: 50
  });
  await db.tx(tx => N.moverStock(tx, ctx, {
    bocaId: caja.boca_id,
    productoId: p.id,
    cantidad: 4,
    tipo: "AJUSTE"
  }));
  const venta = {
    items: [{
      producto_id: p.id,
      cantidad: 1
    }],
    forma_pago: "MIXTO",
    pagos: [{
      forma: "SALDO",
      huesped_id: b.id,
      importe: 30
    }, {
      forma: "EFECTIVO",
      importe: 20
    }],
    recibido: 25
  };
  const v = await call("POST", "/ventas", venta);
  assert.equal(v.vuelto, 5);
  assert.equal((await cuenta()).saldo, 70);
  assert.equal((await db.get("SELECT importe FROM predio_caja_movimiento WHERE venta_id=?", [v.id])).importe, 20);
  await assert.rejects(call("POST", "/ventas", venta), /saldo no alcanza/);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM predio_venta")).n, 1);
  await call("POST", "/ventas/" + v.id + "/anular", {
    motivo: "Duplicada"
  });
  assert.equal((await cuenta()).saldo, 100);
  assert.equal((await cuenta()).consumos, 0);
  r.personas[1].salida = U.hoy();
  await call("POST", "/recepcion/guardar", {
    operacion: U.uuid()
  });
  assert.deepEqual(await call("GET", "/saldos/presentes", {}, {
    q: r.personas[1].dni
  }), []);
  await assert.rejects(call("POST", "/ventas", venta), /presente/);
  await mover({
    accion: "LIQUIDAR",
    medio: "EFECTIVO",
    esperado: -100
  });
  assert.equal((await cuenta()).saldo, 0);
  assert.equal((await cuenta()).neto_consumos, 0);
  // La planilla no liquida la parte en efectivo de una venta combinada.
  r.afiliado = 1;
  r.personas[0].legajo = "L-23";
  await call("POST", "/recepcion/guardar", {
    operacion: U.uuid()
  });
  const afiliado = await db.tx(tx => N.insertar(tx, ctx, "predio_afiliado", {
    dni: r.titular_dni,
    nombre: "Prueba",
    usuario_general_id: r.usuario_id,
    limite: 30,
    habilitado_descuento: 1,
    origen: "SISTEMA"
  }));
  const mixta = await call("POST", "/ventas", {
    items: venta.items,
    forma_pago: "MIXTO",
    pagos: [{
      forma: "DESCUENTO",
      importe: 25,
      huesped_id: a.id
    }, {
      forma: "QR",
      importe: 25
    }]
  });
  assert.equal(mixta.ticket.venta.importe_haberes, 25);
  assert.equal(mixta.ticket.afiliado.id, afiliado);
  const liq = await call("POST", "/afiliados/" + afiliado + "/liquidaciones", {
    forma_pago: "DESCUENTO_HABERES"
  });
  assert.equal(liq.total, 25);
  const carga = {
    operacion: U.uuid(),
    accion: "CARGA",
    huesped_id: a.id,
    importe: 80,
    medio: "AL_SALIR"
  };
  await mover(carga);
  await mover(carga);
  assert.equal((await cuenta()).saldo, 80);
  await call("POST", "/ventas", {
    items: venta.items,
    forma_pago: "SALDO",
    huesped_id: a.id
  });
  const planilla = await mover({
    accion: "LIQUIDAR",
    medio: "HABERES",
    esperado: 50
  });
  assert.ok(planilla.liquidacion_id);
  assert.equal((await call("GET", "/recepcion/315/planilla/" + planilla.liquidacion_id)).liquidacion.total, 50);
  assert.equal((await cuenta()).neto_consumos, 0);
  assert.equal((await db.get("SELECT SUM(CASE WHEN tipo='INGRESO' THEN importe ELSE -importe END) AS n FROM predio_caja_movimiento")).n, 0);
});
