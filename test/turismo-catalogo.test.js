"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  construirVisibilidadServicioSql,
  cumpleFiltroTipado,
  normalizarValorFiltro,
  puedeAprobarTurismo,
  puedeGestionarTurismo,
  registrarHistorialTurismo,
  servicioVisibleParaActor,
} = require("../api/services/turismo-catalogo");

test("los permisos de gestión separan carga departamental de aprobación central", () => {
  assert.equal(puedeGestionarTurismo({ rol: "departamental", departamental_id: 7, area_turismo: 1 }), true);
  assert.equal(puedeAprobarTurismo({ rol: "departamental", departamental_id: 7, area_turismo: 1 }), false);
  assert.equal(puedeAprobarTurismo({ rol: "admin-central", area_turismo: 1 }), true);
  assert.equal(puedeGestionarTurismo({ rol: "afiliado", modulo_turismo: 1 }), false);
});

test("la visibilidad pública exige publicación y parametriza la departamental", () => {
  const afiliado = construirVisibilidadServicioSql({ rol: "afiliado", departamental_id: 9 }, "srv");
  assert.match(afiliado.sql, /srv\.activo = 1/);
  assert.match(afiliado.sql, /srv\.estado_aprobacion = 'APROBADO'/);
  assert.match(afiliado.sql, /servicio_departamental_visible/);
  assert.deepEqual(afiliado.params, [9, 9]);

  const administrador = construirVisibilidadServicioSql({ rol: "admin" }, "srv");
  assert.doesNotMatch(administrador.sql, /servicio_departamental_visible/);
  assert.deepEqual(administrador.params, []);
});

test("los filtros tipados comparan mínimo numérico, booleano exacto y opción exacta", () => {
  assert.equal(cumpleFiltroTipado({ tipo_valor: "NUMERO", valor_numero: 6 }, { minimo: 4 }), true);
  assert.equal(cumpleFiltroTipado({ tipo_valor: "NUMERO", valor_numero: 2 }, { minimo: 4 }), false);
  assert.equal(cumpleFiltroTipado({ tipo_valor: "BOOLEANO", valor_booleano: 1 }, false), false);
  assert.equal(cumpleFiltroTipado({ tipo_valor: "OPCION", valor_texto: "Frente al cuerpo" }, "frente al cuerpo"), true);
});

test("las características validan opciones administrables y guardan una sola columna tipada", () => {
  const valida = normalizarValorFiltro(
    { tipo_valor: "OPCION", opciones: JSON.stringify(["Frente", "Detrás"]) },
    { valor_opcion: "Frente" }
  );
  assert.deepEqual(valida, {
    value: { valor_numero: null, valor_booleano: null, valor_texto: "Frente" },
  });
  assert.match(
    normalizarValorFiltro(
      { tipo_valor: "OPCION", opciones: ["Frente", "Detrás"] },
      { valor_texto: "Otra" }
    ).error,
    /opción/i
  );
});

test("servicioVisibleParaActor integra recurso activo y alcance sin interpolar IDs", async () => {
  let consulta = null;
  const connection = {
    async query(sql, params) {
      consulta = { sql, params };
      return [[{
        id: 12,
        modelo_tarifa: "PRECIO_UNICO",
        tipo_codigo: "ALOJAMIENTO_RECURSO",
      }]];
    },
  };
  const servicio = await servicioVisibleParaActor(
    connection,
    { rol: "afiliado", departamental_id: 4 },
    12,
    { recursoId: 33 }
  );

  assert.equal(servicio.id, 12);
  assert.match(consulta.sql, /r\.id = \? AND r\.activo = 1/);
  assert.match(consulta.sql, /s\.estado_aprobacion = 'APROBADO'/);
  assert.deepEqual(consulta.params, [33, 12, 4, 4]);
});

test("el historial serializa antes/después y conserva el actor", async () => {
  let insercion = null;
  const connection = {
    async query(sql, params) {
      insercion = { sql, params };
      return [{ insertId: 1 }];
    },
  };
  await registrarHistorialTurismo(connection, {
    servicioId: 5,
    recursoId: 8,
    entidadTipo: "RECURSO",
    entidadId: 8,
    operacion: "UPDATE",
    resumen: "Recurso actualizado",
    anterior: { activo: 0 },
    nuevo: { activo: 1 },
    usuarioId: 21,
    req: { ip: "127.0.0.1", get: () => "test-agent" },
  });

  assert.match(insercion.sql, /INSERT INTO turismo_historial/);
  assert.equal(insercion.params[0], 5);
  assert.equal(insercion.params[1], 8);
  assert.equal(insercion.params[8], 21);
  assert.deepEqual(JSON.parse(insercion.params[6]), { activo: 0 });
  assert.deepEqual(JSON.parse(insercion.params[7]), { activo: 1 });
});
