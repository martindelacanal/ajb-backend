"use strict";

// Alta y edición de inscripciones con archivos: multer real, S3 y base de datos simulados.
// Cubre el formato de la foto (sin HEIC), los objetos huérfanos en S3, el nombre del certificado,
// el historial legible, que guardar sin cambios reales no reescriba nada ni deje historial ni avisos,
// que sólo un cambio real del afiliado devuelva a revisión una inscripción aprobada y que un formulario
// abierto con datos viejos (versión distinta) no pise lo que otro cambió.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
process.env.JWT_SECRET = "guardado-inscripcion-olimpiadas-tests-only";

let contexto;
const pool = {
  query: (...args) => contexto.query(...args),
  getConnection: async () => {
    contexto.transaccion.push("getConnection");
    return {
      query: (...args) => contexto.query(...args),
      beginTransaction: async () => { contexto.transaccion.push("begin"); },
      commit: async () => { contexto.transaccion.push("commit"); },
      rollback: async () => { contexto.transaccion.push("rollback"); },
      release: () => { contexto.transaccion.push("release"); },
    };
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => pool } };
const comun = require("../api/services/olimpiadas-comun");
const router = require("../api/routes/olimpiadas");
const { MENSAJE_FORMATO_FOTO } = router.__test;

comun.s3.send = async (comando) => {
  if (comando instanceof PutObjectCommand) contexto.s3.subidos.push(comando.input.Key);
  else if (comando instanceof DeleteObjectCommand) contexto.s3.borrados.push(comando.input.Key);
  else assert.fail(`Comando de S3 no previsto: ${comando.constructor.name}`);
  return {};
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "ascii"), Buffer.alloc(8)]);
const PDF = Buffer.from("%PDF-1.7\n%prueba\n");
const CERTIFICADO_VIEJO = "olimpiadas/inscripciones/certificado_1_viejo.pdf";

const OLIMPIADA = {
  id: 7, nombre: "Olimpiadas 2027", eliminado: 0, habilitado: "Y", fecha_inicio: "2027-10-10", fecha_fin: "2027-10-12",
  fecha_inicio_inscripcion: "2020-01-01", fecha_fin_inscripcion: "2099-12-31", bonos_afiliado: 6, valor_bono: 1000,
  requiere_aprobacion: 1, exigir_bonos_para_validar: 1,
};
const ACOMPANIANTE = { nombre: "Juan", apellido: "Pérez", documento: "40123456", fecha_nacimiento: "1990-01-01", vinculo: "Esposo/a", es_afiliado: 0 };
const ACOMPANIANTE_GUARDADO = { ...ACOMPANIANTE, bonos: 6, bonos_manual: 0, observacion: null };
// Disciplinas de la edición (categoría Atleta). La inscripción guardada tiene Vóley.
const DISCIPLINAS = { 4: "Vóley", 5: "Truco" };
const AFILIADO = {
  id: 20, nombre: "Ana", apellido: "Pérez", rol_nombre: "afiliado", habilitado: "Y", usuario_familiar_id: null,
  es_familiar: "N", modulo_olimpiadas: 1, departamental_id: 5,
};

function inscripcionGuardada(cambios = {}) {
  return {
    id: 11, olimpiada_id: 7, usuario_id: 20, departamental_id: 5, estado: "VALIDADO", categoria_tipo_id: 1,
    tension_arterial: "12/8", grupo_sanguineo_id: 2, detalle_medico: null, detalle_alimentario: null,
    observaciones: null, lugar_trabajo: null, firma_archivo: null, foto_archivo: null,
    // El nombre se guarda ya reparado (nombreArchivoOriginal en el alta y en la edición)
    certificado_archivo: CERTIFICADO_VIEJO, certificado_nombre_original: "apto_médico_viejo.pdf", certificado_mime: "application/pdf",
    fecha_inicio_inscripcion: OLIMPIADA.fecha_inicio_inscripcion, fecha_fin_inscripcion: OLIMPIADA.fecha_fin_inscripcion,
    ...cambios,
  };
}

function leerJson(texto) {
  try { return JSON.parse(texto); } catch { return texto; }
}

async function servidor(t, actor, opciones = {}) {
  contexto = {
    transaccion: [], consultas: [], historial: [], notificaciones: [], s3: { subidos: [], borrados: [] },
    // Lo que se escribió en la inscripción y sus tablas hijas (guardar sin cambios no escribe nada)
    escrituras: [], acompaniantesInsertados: [],
    actualizacion: null, alta: null,
    inscripcion: inscripcionGuardada(opciones.inscripcion),
    acompaniantes: opciones.acompaniantes || [{ ...ACOMPANIANTE_GUARDADO }],
    disciplinas: [...(opciones.disciplinas || [4])],
    datosSanitarios: [...(opciones.datosSanitarios || [1])],
    // Nombres de los antecedentes antes y después de reemplazarlos (GROUP_CONCAT)
    sanitarios: opciones.sanitarios || ["Asma", "Asma"],
    tramoBonos: opciones.tramoBonos ?? 6,
    persona: opciones.persona === undefined ? { apellido: "Pérez", nombre: "Ana" } : opciones.persona,
    ocupados: opciones.ocupados || 0,
    filasActualizadas: opciones.filasActualizadas ?? 1,
    falloAlta: opciones.falloAlta || false,
    actor: {
      rol_id: actor.rol === "afiliado" ? 2 : 1, habilitado: "Y", modulo_olimpiadas: 1, modulo_turismo: 0, modulo_coseguro: 0,
      requiere_cambio_clave: 0, es_familiar: "N", usuario_familiar_id: null, departamental_id: null, ...actor,
    },
  };
  contexto.query = async (sql, params = []) => {
    contexto.consultas.push({ sql, params });
    if (/u\.\*, r\.nombre AS rol_nombre/.test(sql)) return [[{ ...AFILIADO }]];
    if (/AND \(r\.nombre IN \('admin', 'admin-central'\)/.test(sql)) return [[{ id: 1 }, { id: 3 }]];
    if (/FROM usuario u[\s\S]+INNER JOIN rol r/.test(sql)) return [[{ ...contexto.actor }]];
    if (/SELECT apellido, nombre FROM usuario WHERE id = \?/.test(sql)) return [contexto.persona ? [{ ...contexto.persona }] : []];
    if (/SELECT \* FROM olimpiada\s+WHERE id = \? AND eliminado = 0/.test(sql)) return [[{ ...OLIMPIADA }]];
    if (/SELECT i\.\*, o\.fecha_inicio_inscripcion, o\.fecha_fin_inscripcion/.test(sql)) return [[{ ...contexto.inscripcion }]];
    if (/SELECT id FROM olimpiada_inscripcion\s+WHERE olimpiada_id = \? AND usuario_id = \? AND eliminado = 0/.test(sql)) return [[]];
    if (/SELECT id, nombre FROM olimpiada_disciplina_tipo WHERE id = \?/.test(sql)) return [[{ id: 1, nombre: "Atleta" }]];
    if (/SELECT id, nombre, tipo_id FROM olimpiada_disciplina WHERE id IN/.test(sql)) return [params[0].map((id) => ({ id, nombre: DISCIPLINAS[id], tipo_id: 1 }))];
    if (/FROM olimpiada_grupo_sanguineo WHERE id = \?/.test(sql)) return [[{ id: params[0] }]];
    if (/FROM olimpiada_dato_sanitario WHERE id IN/.test(sql)) return [params[0].map((id) => ({ id }))];
    if (/FROM olimpiada_disciplina_config c[\s\S]+FOR UPDATE/.test(sql)) {
      return [Object.entries(DISCIPLINAS).map(([id, nombre]) => ({ disciplina_id: Number(id), max_por_departamental: 10, nombre }))];
    }
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: contexto.ocupados }]];
    if (/FROM olimpiada_bono_tramo/.test(sql)) return [[{ id: 1, edad_desde: 0, edad_hasta: null, bonos: contexto.tramoBonos, etiqueta: "Adultos" }]];
    if (/UPDATE olimpiada_inscripcion\s+SET tension_arterial/.test(sql)) {
      contexto.escrituras.push("UPDATE inscripción");
      contexto.actualizacion = params;
      return [{ affectedRows: contexto.filasActualizadas }];
    }
    if (/UPDATE olimpiada_inscripcion SET estado='PENDIENTE'/.test(sql)) {
      contexto.escrituras.push("UPDATE estado");
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO olimpiada_inscripcion\s+\(olimpiada_id/.test(sql)) {
      if (contexto.falloAlta) throw new Error("Falla simulada de la base");
      contexto.alta = params;
      return [{ insertId: 30 }];
    }
    // Disciplinas guardadas: ids, nombres para el historial y reemplazo
    if (/SELECT disciplina_id FROM olimpiada_inscripcion_disciplina WHERE inscripcion_id = \?/.test(sql)) {
      return [contexto.disciplinas.map((id) => ({ disciplina_id: id }))];
    }
    if (/GROUP_CONCAT\(d\.nombre[\s\S]+FROM olimpiada_inscripcion_disciplina/.test(sql)) {
      return [[{ lista: contexto.disciplinas.map((id) => DISCIPLINAS[id]).sort().join(", ") || null }]];
    }
    if (/DELETE FROM olimpiada_inscripcion_disciplina/.test(sql)) {
      contexto.escrituras.push("DELETE disciplinas");
      contexto.disciplinas = [];
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO olimpiada_inscripcion_disciplina/.test(sql)) {
      contexto.escrituras.push("INSERT disciplina");
      contexto.disciplinas.push(params[1]);
      return [{ affectedRows: 1 }];
    }
    // Antecedentes de salud guardados
    if (/SELECT dato_sanitario_id FROM olimpiada_inscripcion_dato_sanitario WHERE inscripcion_id = \?/.test(sql)) {
      return [contexto.datosSanitarios.map((id) => ({ dato_sanitario_id: id }))];
    }
    if (/GROUP_CONCAT\(ds\.nombre/.test(sql)) return [[{ lista: contexto.sanitarios.shift() ?? null }]];
    if (/DELETE FROM olimpiada_inscripcion_dato_sanitario/.test(sql)) {
      contexto.escrituras.push("DELETE antecedentes");
      contexto.datosSanitarios = [];
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO olimpiada_inscripcion_dato_sanitario/.test(sql)) {
      contexto.escrituras.push("INSERT antecedente");
      contexto.datosSanitarios.push(params[1]);
      return [{ affectedRows: 1 }];
    }
    // Acompañantes guardados
    if (/FROM olimpiada_inscripcion_acompaniante WHERE inscripcion_id = \? ORDER BY id/.test(sql)) return [contexto.acompaniantes.map((a) => ({ ...a }))];
    if (/DELETE FROM olimpiada_inscripcion_acompaniante/.test(sql)) {
      contexto.escrituras.push("DELETE acompañantes");
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO olimpiada_inscripcion_acompaniante/.test(sql)) {
      contexto.escrituras.push("INSERT acompañante");
      // (inscripcion_id, nombre, apellido, documento, fecha_nacimiento, vinculo, es_afiliado, bonos, bonos_manual, observacion)
      const [, nombre, apellido, documento, , vinculo, , bonos, bonosManual] = params;
      contexto.acompaniantesInsertados.push({ nombre, apellido, documento, vinculo, bonos, bonos_manual: bonosManual });
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO olimpiada_historial/.test(sql)) {
      const [entidad, , , , , , tipo, campo, anterior, nuevo, observacion] = params;
      contexto.historial.push({ entidad, tipo, campo, anterior, nuevo, observacion });
      return [{ insertId: contexto.historial.length }];
    }
    if (/INSERT INTO notificacion/.test(sql)) {
      contexto.notificaciones.push({ usuario: params[0], titulo: params[2], mensaje: params[3], payload: leerJson(params[4]) });
      return [{ insertId: contexto.notificaciones.length, affectedRows: 1 }];
    }
    if (/SELECT nombre FROM departamental WHERE id = \?/.test(sql)) return [[{ nombre: "La Plata" }]];
    // Detalle (GET): la ficha que carga el formulario, con su versión
    if (/SELECT i\.\*, o\.nombre AS olimpiada_nombre/.test(sql)) {
      return [[{
        ...contexto.inscripcion, olimpiada_nombre: OLIMPIADA.nombre, olimpiada_fecha_inicio: OLIMPIADA.fecha_inicio,
        olimpiada_fecha_inicio_inscripcion: OLIMPIADA.fecha_inicio_inscripcion, olimpiada_fecha_fin_inscripcion: OLIMPIADA.fecha_fin_inscripcion,
        olimpiada_valor_bono: OLIMPIADA.valor_bono, olimpiada_bonos_afiliado: OLIMPIADA.bonos_afiliado, olimpiada_exigir_bonos: 1,
        afiliado_nombre: AFILIADO.nombre, afiliado_apellido: AFILIADO.apellido,
      }]];
    }
    if (/SELECT d\.id, d\.nombre, d\.tipo_id, t\.nombre AS tipo_nombre/.test(sql)) {
      return [contexto.disciplinas.map((id) => ({ id, nombre: DISCIPLINAS[id], tipo_id: 1, tipo_nombre: "Atleta", icono_archivo: null }))];
    }
    if (/SELECT ds\.id, ds\.nombre\s+FROM olimpiada_inscripcion_dato_sanitario/.test(sql)) {
      return [contexto.datosSanitarios.map((id) => ({ id, nombre: `Antecedente ${id}` }))];
    }
    if (/FROM olimpiada_inscripcion_observacion o/.test(sql)) return [[]];
    if (/FROM olimpiada_bono b LEFT JOIN departamental d/.test(sql)) return [[]];
    assert.fail(`Consulta no prevista: ${sql}`);
  };
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const token = jwt.sign({ data: JSON.stringify({ id: contexto.actor.id, rol: contexto.actor.rol, departamental_id: contexto.actor.departamental_id }) }, process.env.JWT_SECRET);
  return {
    contexto,
    enviar: async (method, ruta, { campos = {}, archivos = [] } = {}) => {
      const form = new FormData();
      for (const [nombre, valor] of Object.entries(campos)) form.append(nombre, typeof valor === "string" ? valor : JSON.stringify(valor));
      for (const { campo, contenido, tipo, nombre } of archivos) form.append(campo, new Blob([contenido], { type: tipo }), nombre);
      const response = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`, {
        method, body: form, headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
    },
    leer: async (ruta) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() };
    },
  };
}

// Lo que reenvía el formulario al editar aunque nadie toque nada
const formularioSinCambios = {
  acompaniantes: [ACOMPANIANTE],
  datos_sanitarios: [1],
  tension_arterial: "12/8",
  grupo_sanguineo_id: "2",
  detalle_medico: "",
  detalle_alimentario: "",
  observaciones: "",
  lugar_trabajo: "",
};
// Todo lo que manda «Guardar cambios» (enviarAhora del front), también la categoría y las disciplinas
const formularioDelFront = { ...formularioSinCambios, categoria_tipo_id: "1", disciplinas: [4] };
const foto = (contenido = PNG, tipo = "image/png") => ({ campo: "FOTO", contenido, tipo, nombre: "foto.png" });
const certificado = (nombre = "apto.pdf") => ({ campo: "CERTIFICADO", contenido: PDF, tipo: "application/pdf", nombre });

// ---------------------------------------------------------------------------
// Edición
// ---------------------------------------------------------------------------
test("edición: una foto HEIC se rechaza antes de abrir la transacción y sin subir nada", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: formularioSinCambios, archivos: [foto(HEIC, "image/heic")],
  });
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body, MENSAJE_FORMATO_FOTO);
  assert.deepEqual(contexto.transaccion, []);
  assert.deepEqual(contexto.s3.subidos, []);
});

test("edición: si el guardado falla después de subir, se borran sólo los archivos nuevos", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" }, { filasActualizadas: 0 });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: formularioSinCambios, archivos: [foto(), certificado()],
  });
  assert.equal(respuesta.status, 409);
  assert.equal(contexto.s3.subidos.length, 2);
  assert.deepEqual(contexto.s3.borrados, contexto.s3.subidos);
  assert.equal(contexto.s3.borrados.includes(CERTIFICADO_VIEJO), false);
  assert.ok(contexto.transaccion.includes("rollback"));
  assert.equal(contexto.transaccion.includes("commit"), false);
});

test("edición: el certificado nuevo guarda el nombre reparado y el historial lo cuenta sin keys", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: formularioSinCambios, archivos: [certificado("apto_médico_nuevo.pdf")],
  });
  assert.equal(respuesta.status, 200);
  assert.ok(contexto.transaccion.includes("commit"));
  assert.deepEqual(contexto.s3.borrados, []); // el certificado anterior se conserva
  const [nuevaKey] = contexto.s3.subidos;
  assert.match(nuevaKey, /^olimpiadas\/inscripciones\/certificado_\d+_[0-9a-f]{12}\.pdf$/);
  // SET ... firma_archivo, certificado_archivo, certificado_nombre_original, certificado_mime, foto_archivo
  assert.deepEqual(contexto.actualizacion.slice(7, 11), [nuevaKey, "apto_médico_nuevo.pdf", "application/pdf", null]);
  assert.deepEqual(contexto.historial, [{
    entidad: "INSCRIPCION", tipo: "UPDATE", campo: "certificado_archivo", anterior: CERTIFICADO_VIEJO, nuevo: nuevaKey,
    observacion: "Se reemplazó el certificado médico «apto_médico_viejo.pdf» por «apto_médico_nuevo.pdf». El anterior queda guardado.",
  }]);
  assert.equal(contexto.notificaciones.length, 1);
  assert.equal(contexto.notificaciones[0].usuario, 20);
});

test("edición: el nombre del certificado anterior va al historial tal como se guardó, sin repararlo otra vez", async (t) => {
  // «NÓº1.pdf» es válido y entra en latin1: una segunda reparación lo dejaría «NӺ1.pdf»
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" }, { inscripcion: { certificado_nombre_original: "NÓº1.pdf" } });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: formularioSinCambios, archivos: [certificado("apto.pdf")],
  });
  assert.equal(respuesta.status, 200);
  assert.equal(contexto.historial.length, 1);
  assert.equal(contexto.historial[0].observacion, "Se reemplazó el certificado médico «NÓº1.pdf» por «apto.pdf». El anterior queda guardado.");
});

test("edición: la primera foto queda en el historial como «Se cargó»", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 3, rol: "departamental", departamental_id: 5 });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: formularioSinCambios, archivos: [foto()] });
  assert.equal(respuesta.status, 200);
  assert.equal(contexto.historial.length, 1);
  assert.equal(contexto.historial[0].campo, "foto_archivo");
  assert.equal(contexto.historial[0].anterior, null);
  assert.equal(contexto.historial[0].observacion, "Se cargó la foto del afiliado.");
});

test("edición: guardar sin cambios reales no reescribe nada, no deja historial ni avisa", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: formularioDelFront });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.body, {
    success: true, message: "No había cambios para guardar.", hubo_cambios: false, volvio_a_revision: false, estado: "VALIDADO",
  });
  assert.deepEqual(contexto.escrituras, []);
  assert.deepEqual(contexto.historial, []);
  assert.deepEqual(contexto.notificaciones, []);
  assert.ok(contexto.transaccion.includes("commit"));
});

test("edición: el staff que cambia una inscripción aprobada no la devuelve a revisión", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 3, rol: "departamental", departamental_id: 5 });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: { ...formularioDelFront, tension_arterial: "13/8" } });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.body, {
    success: true, message: "Inscripción actualizada", hubo_cambios: true, volvio_a_revision: false, estado: "VALIDADO",
  });
  assert.deepEqual(contexto.escrituras, ["UPDATE inscripción"]);
  assert.deepEqual(contexto.historial.map((h) => [h.campo, h.anterior, h.nuevo]), [["tension_arterial", "12/8", "13/8"]]);
  assert.deepEqual(contexto.notificaciones.map((n) => n.usuario), [20]); // aviso al afiliado
});

test("edición: el staff que reenvía los bonos fijados a mano no cambia nada; si los modifica, sí", async (t) => {
  const conManual = { ...ACOMPANIANTE_GUARDADO, bonos: 3, bonos_manual: 1 };
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" }, { acompaniantes: [conManual] });
  // El staff reenvía el ajuste tal cual: no es un cambio
  const igual = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: { ...formularioDelFront, acompaniantes: [{ ...ACOMPANIANTE, bonos_manual: 1, bonos: 3 }] },
  });
  assert.equal(igual.body.hubo_cambios, false);
  assert.deepEqual(contexto.escrituras, []);

  const otro = await servidor(t, { id: 1, rol: "admin" }, { acompaniantes: [conManual] });
  const respuesta = await otro.enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: { ...formularioDelFront, acompaniantes: [{ ...ACOMPANIANTE, bonos_manual: 1, bonos: 5 }] },
  });
  assert.equal(respuesta.body.hubo_cambios, true);
  assert.deepEqual(otro.contexto.acompaniantesInsertados.map((a) => [a.bonos, a.bonos_manual]), [[5, 1]]);
  assert.deepEqual(otro.contexto.historial.map((h) => [h.campo, h.anterior, h.nuevo]), [["acompaniantes", "1 acompañante (3 bonos)", "1 acompañante (5 bonos)"]]);
});

test("edición: un acompañante distinto queda en el historial y se avisa al afiliado", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: { ...formularioSinCambios, acompaniantes: [{ ...ACOMPANIANTE, nombre: "Juan Carlos" }] },
  });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(contexto.historial, [{
    entidad: "ACOMPANIANTE", tipo: "UPDATE", campo: "acompaniantes",
    anterior: "1 acompañante (6 bonos)", nuevo: "1 acompañante (6 bonos)",
    observacion: "Cambiaron los datos de algún acompañante.",
  }]);
  assert.equal(contexto.notificaciones.length, 1);
  assert.match(contexto.notificaciones[0].titulo, /Actualizamos tu inscripción/);
});

test("edición: un cambio en los datos sanitarios queda en el historial y se avisa", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" }, { sanitarios: ["Asma", "Asma, Celiaquía"] });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: { ...formularioSinCambios, datos_sanitarios: [1, 2] } });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(contexto.historial.map((h) => [h.campo, h.anterior, h.nuevo]), [["datos_sanitarios", "Asma", "Asma, Celiaquía"]]);
  assert.equal(contexto.notificaciones.length, 1);
});

// ---------------------------------------------------------------------------
// Edición del afiliado: sólo un cambio real devuelve a revisión una inscripción aprobada
// ---------------------------------------------------------------------------
const AFILIADO_ACTOR = { id: 20, rol: "afiliado", departamental_id: 5 };

test("edición: el afiliado que guarda sin cambios su inscripción aprobada la deja aprobada", async (t) => {
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR);
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: formularioDelFront });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.body, {
    success: true,
    message: "No había cambios para guardar: tu inscripción sigue aprobada.",
    hubo_cambios: false, volvio_a_revision: false, estado: "VALIDADO",
  });
  assert.equal(contexto.consultas.some((c) => /UPDATE olimpiada_inscripcion SET estado='PENDIENTE'/.test(c.sql)), false);
  assert.deepEqual(contexto.escrituras, []); // ni la fila ni disciplinas, antecedentes o acompañantes
  assert.equal(contexto.consultas.some((c) => /COUNT\(\*\) AS total/.test(c.sql)), false); // mismas disciplinas: no se recontrola el cupo
  assert.deepEqual(contexto.historial, []);
  assert.deepEqual(contexto.notificaciones, []);
  assert.ok(contexto.transaccion.includes("commit"));
});

test("edición: el afiliado que cambia la presión de su inscripción aprobada la devuelve a revisión", async (t) => {
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR);
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: { ...formularioDelFront, tension_arterial: "13/8" } });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.body, {
    success: true,
    message: "Guardamos los cambios. Tu inscripción volvió a «En revisión»: vas a poder descargar el gafete cuando tu departamental la apruebe de nuevo.",
    hubo_cambios: true, volvio_a_revision: true, estado: "PENDIENTE",
  });
  assert.deepEqual(contexto.escrituras, ["UPDATE inscripción", "UPDATE estado"]);
  assert.deepEqual(contexto.historial.map((h) => [h.campo, h.anterior, h.nuevo]), [["tension_arterial", "12/8", "13/8"], ["estado", "VALIDADO", "PENDIENTE"]]);
  assert.equal(contexto.historial[1].observacion, "Volvió a revisión porque el afiliado cambió la presión arterial.");
  // Aviso a la administración y a la departamental de la inscripción, con quién y qué cambió
  assert.deepEqual(contexto.notificaciones.map((n) => n.usuario), [1, 3]);
  for (const aviso of contexto.notificaciones) {
    assert.equal(aviso.titulo, "Inscripción #11 actualizada y de vuelta en revisión");
    assert.equal(aviso.mensaje, "Pérez, Ana cambió la presión arterial de su inscripción aprobada. Volvió a «En revisión»: revisá los cambios y aprobala de nuevo para que pueda descargar el gafete.");
    assert.deepEqual(aviso.payload, { inscripcion_id: 11, olimpiada_id: 7, estado: "PENDIENTE" });
  }
});

test("edición: el afiliado que cambia disciplinas y foto vuelve a revisión y el aviso los nombra en el orden del formulario", async (t) => {
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR);
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: { ...formularioDelFront, disciplinas: [4, 5] }, archivos: [foto()],
  });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.volvio_a_revision, true);
  assert.deepEqual(contexto.escrituras, ["UPDATE inscripción", "DELETE disciplinas", "INSERT disciplina", "INSERT disciplina", "UPDATE estado"]);
  assert.deepEqual(contexto.historial.map((h) => h.campo), ["foto_archivo", "disciplinas", "estado"]);
  assert.deepEqual(contexto.historial[1], {
    entidad: "INSCRIPCION", tipo: "UPDATE", campo: "disciplinas", anterior: "Vóley", nuevo: "Truco, Vóley", observacion: null,
  });
  assert.equal(contexto.historial[2].observacion, "Volvió a revisión porque el afiliado cambió las disciplinas y la foto.");
  assert.match(contexto.notificaciones[0].mensaje, /^Pérez, Ana cambió las disciplinas y la foto de su inscripción aprobada\./);
});

test("edición: el afiliado reenvía un acompañante con bonos fijados por el staff: se conservan y no vuelve a revisión", async (t) => {
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR, { acompaniantes: [{ ...ACOMPANIANTE_GUARDADO, bonos: 3, bonos_manual: 1 }] });
  // El formulario del afiliado no manda bonos (bonos_manual: 0)
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: { ...formularioDelFront, acompaniantes: [{ ...ACOMPANIANTE, bonos_manual: 0, observacion: null }] },
  });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.estado, "VALIDADO");
  assert.equal(respuesta.body.hubo_cambios, false);
  assert.deepEqual(contexto.escrituras, []); // sin DELETE/INSERT: el ajuste del staff queda como estaba
  assert.deepEqual(contexto.historial, []);
});

test("edición: el afiliado que cambia otro acompañante conserva los bonos fijados del que no tocó", async (t) => {
  const conManual = { ...ACOMPANIANTE_GUARDADO, bonos: 3, bonos_manual: 1 };
  const hija = { nombre: "Sol", apellido: "Pérez", documento: "50111222", fecha_nacimiento: "2015-05-05", vinculo: "Hijo/a", es_afiliado: 0 };
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR, { acompaniantes: [conManual] });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: { ...formularioDelFront, acompaniantes: [ACOMPANIANTE, hija] },
  });
  assert.equal(respuesta.body.volvio_a_revision, true);
  assert.deepEqual(contexto.acompaniantesInsertados.map((a) => [a.nombre, a.bonos, a.bonos_manual]), [["Juan", 3, 1], ["Sol", 6, 0]]);
  assert.deepEqual(contexto.historial.map((h) => [h.campo, h.anterior, h.nuevo]), [
    ["acompaniantes", "1 acompañante (3 bonos)", "2 acompañantes (9 bonos)"],
    ["estado", "VALIDADO", "PENDIENTE"],
  ]);
  assert.equal(contexto.historial[1].observacion, "Volvió a revisión porque el afiliado cambió los acompañantes.");
});

test("edición: si el afiliado cambia los datos del acompañante con bonos fijados, vuelve al cálculo por edad", async (t) => {
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR, { acompaniantes: [{ ...ACOMPANIANTE_GUARDADO, bonos: 3, bonos_manual: 1 }] });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: { ...formularioDelFront, acompaniantes: [{ ...ACOMPANIANTE, fecha_nacimiento: "1990-02-01" }] },
  });
  assert.equal(respuesta.body.volvio_a_revision, true);
  assert.deepEqual(contexto.acompaniantesInsertados.map((a) => [a.bonos, a.bonos_manual]), [[6, 0]]);
  assert.match(contexto.notificaciones[0].mensaje, /^Pérez, Ana cambió los acompañantes de su inscripción aprobada\./);
});

test("edición: con los tramos cambiados después, reenviar el mismo acompañante no es un cambio", async (t) => {
  // Se guardó con 4 bonos; hoy el tramo da 6. Los bonos calculados se recalculan al leer: no se reescriben.
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR, { acompaniantes: [{ ...ACOMPANIANTE_GUARDADO, bonos: 4 }], tramoBonos: 6 });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: formularioDelFront });
  assert.equal(respuesta.body.hubo_cambios, false);
  assert.equal(respuesta.body.estado, "VALIDADO");
  assert.deepEqual(contexto.escrituras, []);
});

test("edición: datos cargados por otra vía (documento con puntos, vínculo vacío, texto con LF) no cuentan como cambio", async (t) => {
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR, {
    inscripcion: { observaciones: "Llego el sábado\nSin auto" },
    acompaniantes: [{ ...ACOMPANIANTE_GUARDADO, documento: "40.123.456", vinculo: null }],
    datosSanitarios: [2, 1],
  });
  // Como lo reenvía el formulario: documento sólo dígitos, vínculo «Otro», antecedentes en otro orden y la
  // observación con los saltos de línea que pone FormData (CRLF)
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: {
      ...formularioDelFront,
      acompaniantes: [{ ...ACOMPANIANTE, documento: "40123456", vinculo: "Otro" }],
      datos_sanitarios: [1, 2],
      observaciones: "Llego el sábado\r\nSin auto",
    },
  });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.hubo_cambios, false);
  assert.equal(respuesta.body.estado, "VALIDADO");
  assert.deepEqual(contexto.escrituras, []); // la observación queda tal como estaba guardada
  assert.deepEqual(contexto.historial, []);
});

test("edición: con la inscripción en revisión, un cambio del afiliado la deja en revisión y el aviso no dice «de vuelta»", async (t) => {
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR, { inscripcion: { estado: "PENDIENTE" } });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: { ...formularioDelFront, detalle_medico: "Asma leve" } });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.body, {
    success: true,
    message: "Guardamos los cambios. Tu inscripción sigue en revisión: te avisamos cuando tu departamental la apruebe.",
    hubo_cambios: true, volvio_a_revision: false, estado: "PENDIENTE",
  });
  assert.deepEqual(contexto.escrituras, ["UPDATE inscripción"]);
  assert.deepEqual(contexto.historial.map((h) => [h.campo, h.anterior, h.nuevo]), [["detalle_medico", null, "Asma leve"]]);
  assert.equal(contexto.notificaciones[0].titulo, "Inscripción #11 actualizada");
  assert.equal(contexto.notificaciones[0].mensaje, "Pérez, Ana cambió el detalle médico de su inscripción.");
  assert.deepEqual(contexto.notificaciones[0].payload, { inscripcion_id: 11, olimpiada_id: 7 });
});

test("edición: con la inscripción en revisión y sin cambios, la respuesta lo dice y no avisa", async (t) => {
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR, { inscripcion: { estado: "PENDIENTE" } });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: formularioDelFront });
  assert.equal(respuesta.body.message, "No había cambios para guardar: tu inscripción sigue en revisión.");
  assert.equal(respuesta.body.estado, "PENDIENTE");
  assert.deepEqual(contexto.notificaciones, []);
});

test("edición: si no se encuentra el nombre de la persona, el aviso dice «El afiliado»", async (t) => {
  const { enviar, contexto } = await servidor(t, AFILIADO_ACTOR, { persona: null });
  await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: { ...formularioDelFront, lugar_trabajo: "Juzgado Civil N°4" } });
  assert.match(contexto.notificaciones[0].mensaje, /^El afiliado cambió el lugar de trabajo de su inscripción aprobada\./);
});

test("edición: la presión en blanco se rechaza como en el alta, sin conservar la anterior en silencio", async (t) => {
  for (const [actor, mensaje] of [
    [AFILIADO_ACTOR, "Indicá tu presión arterial habitual"],
    [{ id: 3, rol: "departamental", departamental_id: 5 }, "Indicá la presión arterial habitual del afiliado"],
  ]) {
    const { enviar, contexto } = await servidor(t, actor);
    // Sólo espacios: antes quedaba la guardada y la respuesta decía «No había cambios para guardar»
    const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: { ...formularioDelFront, tension_arterial: "   " } });
    assert.equal(respuesta.status, 400, actor.rol);
    assert.equal(respuesta.body, mensaje, actor.rol);
    assert.deepEqual(contexto.transaccion, [], actor.rol); // ni abre la transacción
  }
});

// ---------------------------------------------------------------------------
// Formulario abierto con datos viejos: el detalle da la versión y el PUT la controla
// ---------------------------------------------------------------------------
test("edición: con la versión del detalle y sin cambios guarda como siempre (el GET y el PUT la calculan igual)", async (t) => {
  // Con lo que antes «cambiaba» solo: bonos fijados a mano, vínculo vacío, documento con puntos y antecedentes en otro orden
  const { enviar, leer, contexto } = await servidor(t, AFILIADO_ACTOR, {
    acompaniantes: [{ ...ACOMPANIANTE_GUARDADO, documento: "40.123.456", vinculo: null, bonos: 3, bonos_manual: 1 }],
    datosSanitarios: [2, 1],
  });
  const detalle = await leer("/olimpiadas/inscripciones/11");
  assert.equal(detalle.status, 200);
  assert.match(detalle.body.version, /^[0-9a-f]{16}$/);
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", {
    campos: {
      ...formularioDelFront, acompaniantes: [{ ...ACOMPANIANTE, vinculo: "Otro" }], datos_sanitarios: [1, 2],
      version: detalle.body.version,
    },
  });
  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.body.hubo_cambios, false);
  assert.equal(respuesta.body.estado, "VALIDADO");
  assert.deepEqual(contexto.escrituras, []);
});

test("edición: si alguien cambió la inscripción mientras el formulario estaba abierto, 409 y no se guarda nada", async (t) => {
  const { enviar, leer, contexto } = await servidor(t, AFILIADO_ACTOR);
  const { body: { version } } = await leer("/olimpiadas/inscripciones/11");
  // Mientras tanto la departamental corrigió la presión; el afiliado guarda sin tocar nada (reenvía la vieja)
  contexto.inscripcion = { ...contexto.inscripcion, tension_arterial: "13/8" };
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: { ...formularioDelFront, version } });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body, "La inscripción cambió mientras se editaba. Recargá e intentá nuevamente.");
  // Ni pisa la presión que cargó la departamental ni devuelve la inscripción a revisión
  assert.deepEqual(contexto.escrituras, []);
  assert.deepEqual(contexto.historial, []);
  assert.deepEqual(contexto.notificaciones, []);
  assert.ok(contexto.transaccion.includes("rollback"));
  assert.equal(contexto.transaccion.includes("commit"), false);
});

test("edición: si la aprobaron mientras el afiliado editaba, 409 en vez de devolverla a revisión sin preguntar", async (t) => {
  const { enviar, leer, contexto } = await servidor(t, AFILIADO_ACTOR, { inscripcion: { estado: "PENDIENTE" } });
  const { body: { version } } = await leer("/olimpiadas/inscripciones/11");
  contexto.inscripcion = { ...contexto.inscripcion, estado: "VALIDADO" };
  const campos = { ...formularioDelFront, lugar_trabajo: "Juzgado Civil N°4" };
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: { ...campos, version } });
  assert.equal(respuesta.status, 409);
  assert.deepEqual(contexto.escrituras, []);
  // Recargó (el formulario ya la ve aprobada y pregunta antes): ahora el cambio sí la devuelve a revisión
  const recargada = await leer("/olimpiadas/inscripciones/11");
  const otra = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: { ...campos, version: recargada.body.version } });
  assert.equal(otra.status, 200);
  assert.equal(otra.body.volvio_a_revision, true);
});

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------
const formularioAlta = {
  usuario_id: "20",
  categoria_tipo_id: "1",
  disciplinas: [4],
  acompaniantes: [],
  datos_sanitarios: [],
  tension_arterial: "12/8",
  grupo_sanguineo_id: "2",
};

test("alta: el staff ve de qué cupo se descontó el lugar y el afiliado, quién lo inscribió", async (t) => {
  const admin = await servidor(t, { id: 1, rol: "admin", departamental_id: 1 });
  const respuesta = await admin.enviar("POST", "/olimpiadas/7/inscripciones", { campos: formularioAlta });
  assert.equal(respuesta.status, 201);
  assert.equal(respuesta.body.message, "Inscripción cargada en el cupo de La Plata. Asigná los bonos para aprobarla");
  assert.deepEqual(respuesta.body.departamental, { id: 5, nombre: "La Plata" });
  assert.equal(respuesta.body.estado, "PENDIENTE");
  assert.equal(admin.contexto.alta[2], 5); // departamental_id de la persona inscripta, no la del admin
  assert.equal(admin.contexto.notificaciones.length, 1);
  assert.match(admin.contexto.notificaciones[0].mensaje, /^La AJB cargó tu inscripción a Olimpiadas 2027\./);

  const departamental = await servidor(t, { id: 3, rol: "departamental", departamental_id: 5 });
  const propia = await departamental.enviar("POST", "/olimpiadas/7/inscripciones", { campos: formularioAlta });
  assert.equal(propia.status, 201);
  assert.match(departamental.contexto.notificaciones[0].mensaje, /^Tu departamental cargó tu inscripción/);
});

test("alta: sin lugar en el cupo, el 409 nombra la departamental y no sube archivos", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" }, { ocupados: 10 });
  const respuesta = await enviar("POST", "/olimpiadas/7/inscripciones", { campos: formularioAlta, archivos: [foto(), certificado()] });
  assert.equal(respuesta.status, 409);
  assert.equal(respuesta.body, 'Ya no quedan lugares de "Vóley" en el cupo de La Plata');
  assert.deepEqual(contexto.s3.subidos, []);
});

test("alta: una foto HEIC se rechaza antes de abrir la transacción", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 20, rol: "afiliado", departamental_id: 5 });
  const respuesta = await enviar("POST", "/olimpiadas/7/inscripciones", {
    campos: formularioAlta, archivos: [foto(HEIC, "image/heic"), certificado()],
  });
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body, MENSAJE_FORMATO_FOTO);
  assert.deepEqual(contexto.transaccion, []);
  assert.deepEqual(contexto.s3.subidos, []);
});

test("alta: el certificado guarda el nombre reparado y, si el guardado falla, se borra lo subido", async (t) => {
  const ok = await servidor(t, { id: 1, rol: "admin" });
  const respuesta = await ok.enviar("POST", "/olimpiadas/7/inscripciones", { campos: formularioAlta, archivos: [certificado("apto_médico.pdf")] });
  assert.equal(respuesta.status, 201);
  assert.ok(ok.contexto.alta.includes("apto_médico.pdf"));
  assert.deepEqual(ok.contexto.s3.borrados, []);

  t.mock.method(console, "error", () => {});
  const falla = await servidor(t, { id: 1, rol: "admin" }, { falloAlta: true });
  const error = await falla.enviar("POST", "/olimpiadas/7/inscripciones", { campos: formularioAlta, archivos: [foto(), certificado()] });
  assert.equal(error.status, 500);
  assert.equal(falla.contexto.s3.subidos.length, 2);
  assert.deepEqual(falla.contexto.s3.borrados, falla.contexto.s3.subidos);
  assert.ok(falla.contexto.transaccion.includes("rollback"));
});
