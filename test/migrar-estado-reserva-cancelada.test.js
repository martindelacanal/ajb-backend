const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ESTADO_CANCELADA,
  SQL_CANCELACIONES_PASADAS,
  ejecutarMigracion,
  revisarCatalogo,
} = require("../scripts/migrar-estado-reserva-cancelada");

function conexionFalsa({ catalogo = [], candidatas = [], afectadas = 1 } = {}) {
  const consultas = [];
  return {
    consultas,
    async beginTransaction() { consultas.push({ sql: "BEGIN" }); },
    async commit() { consultas.push({ sql: "COMMIT" }); },
    async rollback() { consultas.push({ sql: "ROLLBACK" }); },
    async query(sql, params) {
      consultas.push({ sql, params });
      if (sql.startsWith("SELECT id, nombre FROM estado_reserva")) return [catalogo];
      if (sql.includes("FROM reserva r")) return [candidatas];
      if (sql.startsWith("UPDATE reserva")) return [{ affectedRows: afectadas }];
      return [{ affectedRows: 1 }];
    },
  };
}

test("el estado Cancelada usa el id fijo que espera el backend", () => {
  assert.deepEqual({ ...ESTADO_CANCELADA }, { id: 13, nombre: "Cancelada" });
});

test("el catálogo frena si Cancelada existe con otro id o si el 13 es otro estado", async () => {
  await assert.rejects(
    revisarCatalogo(conexionFalsa({ catalogo: [{ id: 20, nombre: "Cancelada" }] })),
    /ya existe con id 20/
  );
  await assert.rejects(
    revisarCatalogo(conexionFalsa({ catalogo: [{ id: 13, nombre: "Otra" }] })),
    /ya es 'Otra'/
  );
  assert.equal(await revisarCatalogo(conexionFalsa({ catalogo: [{ id: 13, nombre: "Cancelada" }] })), "EXISTE");
  assert.equal(await revisarCatalogo(conexionFalsa()), "FALTA");
});

test("sólo reclasifica bajas hechas por el propio afiliado sobre turismo regular", () => {
  assert.match(SQL_CANCELACIONES_PASADAS, /h\.usuario_modificador_id = r\.usuario_id/);
  assert.match(SQL_CANCELACIONES_PASADAS, /ro\.nombre = 'afiliado'/);
  assert.match(SQL_CANCELACIONES_PASADAS, /SELECT MAX\(h2\.id\)/);
  assert.match(SQL_CANCELACIONES_PASADAS, /r\.modalidad IN \('FECHA_LIBRE', 'BLOQUE'\)/);
});

test("aplicar da de alta el estado, reclasifica con historial y confirma", async () => {
  const conexion = conexionFalsa({ candidatas: [{ id: 36 }, { id: 37 }] });
  const resultado = await ejecutarMigracion(conexion, { log: () => {} });

  assert.equal(resultado.catalogo, "FALTA");
  assert.deepEqual(resultado.reclasificadas, [36, 37]);
  assert.ok(conexion.consultas.some(({ sql, params }) =>
    sql.startsWith("INSERT INTO estado_reserva") && params[0] === 13 && params[1] === "Cancelada"));
  const historial = conexion.consultas.filter(({ sql }) => sql.includes("INSERT INTO historial_reserva"));
  assert.equal(historial.length, 2);
  assert.deepEqual(historial[0].params.slice(0, 3), [36, "4", "13"]);
  assert.equal(conexion.consultas.at(-1).sql, "COMMIT");
});

test("--check no escribe nada y deshace la transacción", async () => {
  const conexion = conexionFalsa({ candidatas: [{ id: 36 }] });
  const resultado = await ejecutarMigracion(conexion, { checkOnly: true, log: () => {} });

  assert.deepEqual(resultado.candidatas, [36]);
  assert.deepEqual(resultado.reclasificadas, []);
  assert.ok(!conexion.consultas.some(({ sql }) => /^(INSERT|UPDATE)/.test(sql)));
  assert.equal(conexion.consultas.at(-1).sql, "ROLLBACK");
});

test("una reserva que cambió en el medio no se reclasifica ni deja historial", async () => {
  const conexion = conexionFalsa({ catalogo: [{ id: 13, nombre: "Cancelada" }], candidatas: [{ id: 36 }], afectadas: 0 });
  const resultado = await ejecutarMigracion(conexion, { log: () => {} });

  assert.deepEqual(resultado.reclasificadas, []);
  assert.ok(!conexion.consultas.some(({ sql }) => sql.includes("INSERT INTO historial_reserva")));
});
