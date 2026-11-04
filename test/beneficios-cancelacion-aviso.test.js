"use strict";
// Aviso a la entidad cuando el afiliado cancela su inscripción (post-commit, nunca lanza).
// El correo se reemplaza ANTES de cargar el router (lo desestructura al cargarse): ninguna
// prueba puede mandar un correo de verdad.
const test = require("node:test");
const assert = require("node:assert/strict");
const correo = require("../api/services/correo");

const enviados = [];
let respuestaCorreo = { enviado: true };
correo.enviarCorreoPlantilla = async (opciones) => { enviados.push(opciones); return respuestaCorreo; };

const T = require("../api/routes/beneficios").__test;

const CBU = "2850590940090418135201";
function filaInscripcion(cambios = {}) {
  return {
    id: 12, beneficio_id: 8, usuario_id: 2, estado_id: 3, mensaje_afiliado: null,
    aviso_entidad_estado: "ENVIADO", aviso_entidad_error: null, aviso_entidad_fecha: null,
    beneficio_nombre: "Óptica Mirador", email_aviso_inscripcion: "convenios@optica.test", mensaje_inscripcion_html: null,
    fecha_vigencia_desde: null, fecha_vigencia_hasta: null, beneficio_departamental_id: 1, rubro_nombre: "Salud",
    nombre: "Rosa", apellido: "Benítez", documento: "23456781", cuil: "27234567816", cbu: CBU,
    telefono: "2235123456", email: "rbenitez@ejemplo.com", fecha_nacimiento: "1973-05-14", cantidad_familiares: 2,
    ...cambios,
  };
}
function baseFalsa(fila, { departamentales = [], superiores = [] } = {}) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql, params });
      if (/FROM beneficio_inscripcion bi/.test(sql) && /INNER JOIN usuario u/.test(sql)) return [[fila]];
      if (/r\.nombre = 'departamental'/.test(sql)) return [departamentales];
      if (/r\.nombre IN/.test(sql)) return [superiores];
      return [{ affectedRows: 1, insertId: 1 }];
    },
  };
}
const historial = (db) => db.consultas.filter(({ sql }) => /INSERT INTO beneficio_historial/.test(sql));
const notificaciones = (db) => db.consultas.filter(({ sql }) => /INSERT INTO notificacion/i.test(sql));

test.beforeEach(() => { enviados.length = 0; respuestaCorreo = { enviado: true }; });

test("avisa la baja a la entidad que se enteró del alta, sólo con nombre, apellido y DNI", async () => {
  const db = baseFalsa(filaInscripcion());
  await T.procesarAvisoCancelacionEntidad(db, 12);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].para, "convenios@optica.test");
  assert.match(enviados[0].asunto, /Inscripción cancelada al beneficio "Óptica Mirador"/);
  assert.deepEqual(enviados[0].datos.map((d) => d.etiqueta), ["Nombre", "Apellido", "DNI"]);
  assert.equal(JSON.stringify(enviados[0]).includes(CBU), false);
  assert.equal(JSON.stringify(enviados[0]).includes("rbenitez@ejemplo.com"), false);
  const [registro] = historial(db);
  assert.match(registro.params.at(-1), /Aviso de cancelación enviado a la entidad \(convenios@optica\.test\) por la inscripción B-12/);
  assert.equal(notificaciones(db).length, 0);
});

test("no avisa si la entidad nunca supo del alta o el beneficio no tiene casilla", async () => {
  for (const cambios of [{ aviso_entidad_estado: "ERROR" }, { aviso_entidad_estado: "NO_APLICA" }, { email_aviso_inscripcion: null }]) {
    const db = baseFalsa(filaInscripcion(cambios));
    await T.procesarAvisoCancelacionEntidad(db, 12);
    assert.equal(historial(db).length, 0);
  }
  assert.equal(enviados.length, 0);
});

test("si el correo falla, queda en el historial y el staff recibe una notificación", async () => {
  respuestaCorreo = { enviado: false, motivo: "error_smtp", codigo: "ETIMEDOUT" };
  const db = baseFalsa(filaInscripcion(), { departamentales: [{ id: 30 }], superiores: [{ id: 40 }] });
  await T.procesarAvisoCancelacionEntidad(db, 12);
  const [registro] = historial(db);
  assert.match(registro.params.at(-1), /No se pudo avisar a la entidad \(convenios@optica\.test\) la cancelación de la inscripción B-12: El servidor de correo no respondió a tiempo/);
  const avisos = notificaciones(db);
  assert.equal(avisos.length, 2);
  assert.ok(avisos.every(({ params }) => params.includes("BENEFICIO_AVISO_ERROR")));
});

test("nunca lanza aunque la base falle", async () => {
  const db = { async query() { throw new Error("se cayó la base"); } };
  await assert.doesNotReject(() => T.procesarAvisoCancelacionEntidad(db, 12));
});
