const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CATALOGOS_HISTORIAL_RESERVA,
  CATALOGOS_HISTORIAL_USUARIO,
  crearEnriquecimientoHistorial,
} = require("../api/services/historial-legible");

test("historial de reservas resuelve todos los campos relacionales requeridos", () => {
  assert.deepEqual(
    CATALOGOS_HISTORIAL_RESERVA.map(({ campo }) => campo),
    ["estado_reserva_id", "recurso_id", "regimen_id"]
  );

  const sql = crearEnriquecimientoHistorial(CATALOGOS_HISTORIAL_RESERVA);

  assert.match(sql.joins, /LEFT JOIN estado_reserva hr_estado_reserva_anterior/);
  assert.match(sql.joins, /LEFT JOIN recurso hr_recurso_nuevo/);
  assert.match(sql.joins, /LEFT JOIN regimen hr_regimen_anterior/);
  assert.match(sql.valorAnteriorSql, /COALESCE\(hr_estado_reserva_anterior\.nombre, h\.valor_anterior\)/);
  assert.match(sql.valorNuevoSql, /COALESCE\(hr_recurso_nuevo\.nombre, h\.valor_nuevo\)/);
  assert.match(sql.valorNuevoSql, /ELSE h\.valor_nuevo/);
});

test("historial de usuarios resuelve todos los campos relacionales requeridos", () => {
  assert.deepEqual(
    CATALOGOS_HISTORIAL_USUARIO.map(({ campo }) => campo),
    ["parentesco_id", "tipo_persona_id", "rol_id", "departamental_id"]
  );

  const sql = crearEnriquecimientoHistorial(CATALOGOS_HISTORIAL_USUARIO);

  for (const { campo, tabla, alias } of CATALOGOS_HISTORIAL_USUARIO) {
    assert.match(sql.joins, new RegExp(`LEFT JOIN ${tabla} ${alias}_anterior`));
    assert.match(sql.joins, new RegExp(`LEFT JOIN ${tabla} ${alias}_nuevo`));
    assert.match(sql.valorAnteriorSql, new RegExp(`WHEN '${campo}'`));
  }
  assert.match(sql.valorAnteriorSql, /ELSE h\.valor_anterior/);
});

test("el constructor de SQL rechaza identificadores de catalogo inseguros", () => {
  assert.throws(
    () => crearEnriquecimientoHistorial([
      { campo: "rol_id", tabla: "rol; DROP TABLE rol", alias: "rol" },
    ]),
    /identificador SQL valido/
  );
});
