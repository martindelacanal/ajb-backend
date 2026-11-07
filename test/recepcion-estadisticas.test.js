"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { estadisticas } = require("../api/services/recepcion-estadisticas");

test("estadísticas de estadías: ingresos reales, traslados, alquileres por día y alcance del predio", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE servicio(id INTEGER, nombre TEXT, codigo TEXT);
      CREATE TABLE recurso(id INTEGER, nombre TEXT, servicio_id INTEGER);
      CREATE TABLE estado_reserva(id INTEGER, nombre TEXT);
      CREATE TABLE reserva(id INTEGER, servicio_id INTEGER, recurso_id INTEGER, estado_reserva_id INTEGER, fecha_inicio TEXT, fecha_fin TEXT);
      CREATE TABLE recepcion_reserva_recurso(reserva_id INTEGER, recurso_id INTEGER);
      CREATE TABLE recepcion_reserva_evento(id INTEGER, reserva_id INTEGER, predio_id INTEGER, actual TEXT);
      CREATE TABLE predio_huesped(predio_id INTEGER, reserva_id INTEGER, dni TEXT, entrada TEXT);
      CREATE TABLE adicional(id INTEGER, nombre TEXT);
      CREATE TABLE tarifa_adicional(adicional_id INTEGER, recurso_id INTEGER);
      CREATE TABLE reserva_adicional(id INTEGER, reserva_id INTEGER, adicional_id INTEGER, nombre_adicional TEXT, cantidad INTEGER, dias INTEGER, subtotal REAL);
      CREATE TABLE reserva_adicional_detalle(reserva_adicional_id INTEGER, fecha TEXT, cantidad INTEGER, subtotal REAL);

      INSERT INTO servicio VALUES (1,'Camping','MIR'), (2,'Otro predio','OTRO');
      INSERT INTO recurso VALUES (101,'Parcela A',1), (102,'Parcela B',1), (103,'Recurso de otro predio',2);
      INSERT INTO estado_reserva VALUES (1,'Aprobada'), (2,'Cancelada'), (3,'Pendiente de firma'), (4,'Utilizada');
      INSERT INTO reserva VALUES
        (10,1,102,1,'2026-01-18','2026-01-25'), (11,1,101,1,'2026-01-20','2026-01-20'),
        (12,1,101,2,'2026-01-20','2026-01-20'), (13,2,103,1,'2026-01-20','2026-01-20'),
        (14,1,101,4,'2026-01-20','2026-01-20'), (15,1,101,3,'2026-01-20','2026-01-20');
      INSERT INTO recepcion_reserva_evento VALUES
        (1,10,1,'{"personas":[{"dni":"1","entrada":"2026-01-20"},{"dni":"2","entrada":"2026-01-21"},{"dni":"9","entrada":null}],"tramos":[{"desde":"2026-01-18","recurso_id":101},{"desde":"2026-01-21","recurso_id":102}]}'),
        (2,11,1,'{"personas":[{"dni":"1","entrada":"2026-01-20"}]}'),
        (3,13,2,'{"personas":[{"dni":"4","entrada":"2026-01-20"}]}');
      INSERT INTO predio_huesped VALUES (1,14,'3','2026-01-20'), (2,14,'5','2026-01-20'), (1,10,'6','2026-01-20');
      INSERT INTO adicional VALUES (301,'Silla'), (302,'Sombrilla'), (303,'Fuera de alcance');
      INSERT INTO tarifa_adicional VALUES (303,103);
      INSERT INTO reserva_adicional VALUES
        (1010,10,301,'Silla',2,2,400), (1011,11,302,'Sombrilla',1,1,500),
        (1012,12,301,'Silla',5,1,500), (1013,13,301,'Silla',7,1,700),
        (1014,14,301,'Silla',1,1,100), (1015,15,301,'Silla',4,1,400);
      INSERT INTO reserva_adicional_detalle VALUES
        (1010,'2026-01-20',2,200), (1010,'2026-01-21',2,200), (1011,'2026-01-20',1,500),
        (1012,'2026-01-20',5,500), (1013,'2026-01-20',7,700), (1015,'2026-01-20',4,400);
    `);
    const c = {
      async query(sql, params) {
        let i = 0;
        const expandida = sql.replace(/\?/g, () => {
          const valor = params[i++];
          return Array.isArray(valor) ? valor.map(() => "?").join(",") : "?";
        });
        return [db.prepare(expandida).all(...params.flat())];
      }
    };
    const periodo = { desde: "2026-01-20", hasta: "2026-01-21" };
    const todas = await estadisticas(c, ["MIR"], 1, { ...periodo, opciones: "1" });
    assert.deepEqual(todas.ingresos, [{ dia: "2026-01-20", personas: 2 }, { dia: "2026-01-21", personas: 1 }]);
    assert.deepEqual(todas.adicionales, [
      { nombre: "Silla", unidades: 3, unidades_dia: 5, importe: 500 },
      { nombre: "Sombrilla", unidades: 1, unidades_dia: 1, importe: 500 },
    ]);
    assert.equal(todas.sin_detalle, true);
    assert.deepEqual(todas.opciones.servicios.map(s => s.id), [1]);
    assert.deepEqual(todas.opciones.recursos.map(r => r.id), [101, 102]);
    assert.deepEqual(todas.opciones.adicionales.map(a => a.id), [301, 302]);

    const filtradas = await estadisticas(c, ["MIR"], 1, { ...periodo, servicio_id: "1", recurso_id: "102", adicional_id: "301" });
    assert.deepEqual(filtradas.ingresos, [{ dia: "2026-01-21", personas: 1 }]);
    assert.deepEqual(filtradas.adicionales, [{ nombre: "Silla", unidades: 2, unidades_dia: 2, importe: 200 }]);
    assert.equal(filtradas.sin_detalle, false);
    const unDia = await estadisticas(c, ["MIR"], 1, { ...periodo, hasta: periodo.desde, recurso_id: "101", adicional_id: "302" });
    assert.deepEqual(unDia.ingresos, [{ dia: "2026-01-20", personas: 1 }]);
    assert.deepEqual(unDia.adicionales, [{ nombre: "Sombrilla", unidades: 1, unidades_dia: 1, importe: 500 }]);
    await assert.rejects(estadisticas(c, ["MIR"], 1, { desde: periodo.hasta, hasta: periodo.desde }), { status: 400 });
  } finally {
    db.close();
  }
});
