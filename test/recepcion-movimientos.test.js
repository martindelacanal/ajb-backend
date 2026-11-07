"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listarMovimientos } = require("../api/services/recepcion-movimientos");

// Conexión falsa: guarda cada consulta y responde el conteo, las filas o el catálogo de filtros.
function conexion({ total = 0, filas = [] } = {}) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql, params });
      if (/SELECT COUNT\(\*\) AS total FROM listado$/.test(sql)) return [[{ total }]];
      if (/FROM servicio WHERE codigo IN/.test(sql)) return [[{ id: 1, nombre: "Cabañas" }]];
      if (/FROM recurso WHERE servicio_id IN/.test(sql)) return [[{ id: 7, nombre: "Cabaña 1", servicio_id: 1 }]];
      if (/FROM adicional a JOIN/.test(sql)) return [[{ id: 3, nombre: "Sombrilla" }]];
      return [filas];
    }
  };
}
const sinCambios = () => [];
const listar = (c, b, resumen = sinCambios) => listarMovimientos(c, ["MIR"], 1, b, resumen);
const pagina = c => c.consultas.find(x => /SELECT \* FROM listado l ORDER BY/.test(x.sql));
const ordenDe = c => /SELECT \* FROM listado l ORDER BY ([\s\S]*) LIMIT \? OFFSET \?$/.exec(pagina(c).sql)[1];
const ORDEN_POR_DEFECTO = "l.fecha DESC,l.origen ASC,l.id DESC";

test("movimientos: sin parámetros nuevos pagina de a 40 por fecha descendente e informa total y páginas", async () => {
  const c = conexion({ total: 95 });
  const r = await listar(c, {});
  assert.equal(ordenDe(c), ORDEN_POR_DEFECTO);
  assert.deepEqual(pagina(c).params.slice(-2), [40, 0]);
  assert.deepEqual({ pagina: r.pagina, tam: r.tam, total: r.total, paginas: r.paginas, siguiente: r.siguiente },
    { pagina: 1, tam: 40, total: 95, paginas: 3, siguiente: true });
  assert.equal("filtros" in r, false);
});

test("movimientos: el conteo usa el mismo CTE, las mismas condiciones y los mismos parámetros que la página", async () => {
  const c = conexion({ total: 60 });
  const r = await listar(c, { q: "T-52", desde: "2026-01-10", hasta: "2026-01-20", origen: "cuenta", servicio_id: "4",
    orden: "titular", dir: "asc", tam: "25", pagina: "2" });
  const [conteo, listado] = c.consultas;
  assert.match(conteo.sql, /SELECT COUNT\(\*\) AS total FROM listado$/);
  const cte = sql => sql.slice(0, sql.lastIndexOf("\n  SELECT "));
  assert.equal(cte(conteo.sql), cte(listado.sql));
  assert.match(cte(conteo.sql), /m\.fecha>=\? AND m\.fecha<\? AND m\.origen=\?/);
  assert.deepEqual(listado.params, [...conteo.params, 25, 25]);
  assert.ok(conteo.params.includes("CUENTA") && conteo.params.includes("2026-01-21") && conteo.params.includes(52));
  assert.match(ordenDe(c), /^\(CONVERT\(l\.titular USING utf8mb4\) COLLATE utf8mb4_0900_ai_ci\) IS NULL,CONVERT\(l\.titular USING utf8mb4\) COLLATE utf8mb4_0900_ai_ci ASC,l\.fecha DESC,l\.origen ASC,l\.id DESC$/);
  assert.deepEqual({ pagina: r.pagina, tam: r.tam, total: r.total, paginas: r.paginas, siguiente: r.siguiente },
    { pagina: 2, tam: 25, total: 60, paginas: 3, siguiente: true });
});

test("movimientos: sólo se ordena por columnas de la lista blanca", async () => {
  for (const orden of ["u.documento; DROP TABLE reserva", "constructor", "__proto__", "toString", "m.fecha", ["titular"]]) {
    const c = conexion({ total: 1 });
    await listar(c, { orden });
    assert.equal(ordenDe(c), ORDEN_POR_DEFECTO, String(orden));
    assert.doesNotMatch(pagina(c).sql, /DROP TABLE|u\.documento/);
  }
  // Cada columna de la pantalla tiene su orden, en los dos sentidos.
  for (const orden of ["reserva_id", "titular", "servicio", "recurso", "adicionales", "concepto", "origen", "actor", "importe"]) {
    for (const dir of ["asc", "desc"]) {
      const c = conexion({ total: 1 });
      await listar(c, { orden, dir });
      const sql = ordenDe(c);
      assert.notEqual(sql, ORDEN_POR_DEFECTO, orden);
      assert.match(sql, new RegExp(" " + dir.toUpperCase() + ",l\\.fecha DESC,l\\.origen ASC,l\\.id DESC$"), orden);
    }
  }
  const c = conexion({ total: 1 });
  await listar(c, { orden: "fecha", dir: "asc" });
  assert.equal(ordenDe(c), "l.fecha ASC,l.origen ASC,l.id ASC");
  const movimiento = conexion({ total: 1 });
  await listar(movimiento, { orden: "concepto" });
  for (const rotulo of ["'Alta de reserva'", "'Ingreso'", "'Salida'", "'Traslado'", "'Cambio de adicionales'", "'Vehículos'", "'Ubicación'", "'Carga de saldo'"]) {
    assert.ok(ordenDe(movimiento).includes(rotulo), rotulo);
  }
});

test("movimientos: valida tamaño, sentido y página antes de consultar; una página que ya no existe muestra la última", async () => {
  for (const b of [{ tam: "0" }, { tam: "201" }, { tam: "muchos" }, { dir: "arriba" }, { pagina: "0" }, { pagina: "1000000" }]) {
    const c = conexion({ total: 10 });
    await assert.rejects(listar(c, b), { status: 400 }, JSON.stringify(b));
    assert.equal(c.consultas.length, 0, JSON.stringify(b));
  }
  const ultima = conexion({ total: 45 });
  const r = await listar(ultima, { tam: "200", pagina: "1" });
  assert.equal(r.tam, 200);
  const c = conexion({ total: 45 });
  const lejos = await listar(c, { tam: "20", pagina: "9" });
  assert.deepEqual(pagina(c).params.slice(-2), [20, 40]);
  assert.deepEqual({ pagina: lejos.pagina, paginas: lejos.paginas, siguiente: lejos.siguiente }, { pagina: 3, paginas: 3, siguiente: false });
  const vacia = conexion({ total: 0 });
  const nada = await listar(vacia, { pagina: "4" });
  assert.equal(vacia.consultas.length, 1, "sin movimientos no se pide la página");
  assert.deepEqual({ filas: nada.filas, total: nada.total, pagina: nada.pagina, paginas: nada.paginas }, { filas: [], total: 0, pagina: 1, paginas: 1 });
});

test("movimientos: filtros del catálogo con la página o solos, sin consultar movimientos", async () => {
  const solos = conexion({ total: 5 });
  const r = await listar(solos, { filtros: "1", solo_filtros: "1" });
  assert.deepEqual(Object.keys(r), ["filtros"]);
  assert.deepEqual(r.filtros.recursos, [{ id: 7, nombre: "Cabaña 1", servicio_id: 1 }]);
  assert.equal(solos.consultas.some(x => /listado/.test(x.sql)), false);
  const conPagina = conexion({ total: 5 });
  const r2 = await listar(conPagina, { filtros: "1" });
  assert.equal(r2.total, 5);
  assert.deepEqual(r2.filtros.adicionales, [{ id: 3, nombre: "Sombrilla" }]);
});

test("movimientos: rótulos de recepción para vehículos y ubicación, junto con ingreso y salida", async () => {
  const persona = (entrada, salida) => ({ dni: "30111222", nombre: "Mila", entrada, salida });
  const evento = (id, antes, despues) => ({
    id, reserva_id: 52, fecha: new Date(), fecha_local: "2026-01-20 10:00:00", origen: "RECEPCION", concepto: null,
    actor: "Recepción", anterior: antes && JSON.stringify(antes), actual: JSON.stringify(despues), importe: null, medio: null,
    servicio: "Cabañas", recurso: "Cabaña 1", adicionales: null
  });
  const filas = [
    evento(1, { personas: [persona(null, null)] }, { personas: [persona("2026-01-20", null)] }),
    evento(2, { personas: [persona("2026-01-20", null)] }, { personas: [persona("2026-01-20", null)] }),
    evento(3, { personas: [persona("2026-01-20", null)] }, { personas: [persona("2026-01-20", "2026-01-22")] }),
    evento(4, null, { personas: [] }),
    { id: 9, reserva_id: 52, fecha: new Date(), fecha_local: "2026-01-20 09:00:00", origen: "TURISMO", concepto: "Estado",
      valor_anterior: "Iniciada", valor_nuevo: "Aprobada", importe: null }
  ];
  const cambios = {
    1: [["Vehículo", null, "Gol blanco"]],
    2: [["Ubicación", "Sector A", "Sector B"], ["Vehículo", "Gol", "Gol blanco"]],
    3: [["Pasajero", "Mila", "Mila"]]
  };
  let n = 0;
  const r = await listar(conexion({ total: filas.length, filas }), {}, () => cambios[++n] || []);
  assert.deepEqual(r.filas.map(f => f.concepto), ["Ingreso · Vehículos", "Vehículos · Ubicación", "Salida", "Alta de reserva", "Estado"]);
  assert.deepEqual(r.filas[4].cambios, [["Estado", "Iniciada", "Aprobada"]]);
  assert.equal(r.filas[0].fecha, "2026-01-20 10:00:00");
  assert.equal("actual" in r.filas[0] || "anterior" in r.filas[0], false);
});
