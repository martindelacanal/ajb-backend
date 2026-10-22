"use strict";

// Alta y edición de inscripciones con archivos: multer real, S3 y base de datos simulados.
// Cubre el formato de la foto (sin HEIC), los objetos huérfanos en S3, el nombre del certificado,
// el historial legible y que guardar sin cambios reales no deje historial ni avisos.
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

async function servidor(t, actor, opciones = {}) {
  contexto = {
    transaccion: [], consultas: [], historial: [], notificaciones: [], s3: { subidos: [], borrados: [] },
    actualizacion: null, alta: null,
    inscripcion: inscripcionGuardada(opciones.inscripcion),
    acompaniantes: opciones.acompaniantes || [{ ...ACOMPANIANTE_GUARDADO }],
    sanitarios: opciones.sanitarios || ["Asma", "Asma"],
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
    if (/SELECT \* FROM olimpiada\s+WHERE id = \? AND eliminado = 0/.test(sql)) return [[{ ...OLIMPIADA }]];
    if (/SELECT i\.\*, o\.fecha_inicio_inscripcion, o\.fecha_fin_inscripcion/.test(sql)) return [[{ ...contexto.inscripcion }]];
    if (/SELECT id FROM olimpiada_inscripcion\s+WHERE olimpiada_id = \? AND usuario_id = \? AND eliminado = 0/.test(sql)) return [[]];
    if (/SELECT id, nombre FROM olimpiada_disciplina_tipo WHERE id = \?/.test(sql)) return [[{ id: 1, nombre: "Atleta" }]];
    if (/SELECT id, nombre, tipo_id FROM olimpiada_disciplina WHERE id IN/.test(sql)) return [[{ id: 4, nombre: "Vóley", tipo_id: 1 }]];
    if (/FROM olimpiada_grupo_sanguineo WHERE id = \?/.test(sql)) return [[{ id: params[0] }]];
    if (/FROM olimpiada_dato_sanitario WHERE id IN/.test(sql)) return [params[0].map((id) => ({ id }))];
    if (/FROM olimpiada_disciplina_config c[\s\S]+FOR UPDATE/.test(sql)) return [[{ disciplina_id: 4, max_por_departamental: 10, nombre: "Vóley" }]];
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: contexto.ocupados }]];
    if (/FROM olimpiada_bono_tramo/.test(sql)) return [[{ id: 1, edad_desde: 0, edad_hasta: null, bonos: 6, etiqueta: "Adultos" }]];
    if (/UPDATE olimpiada_inscripcion\s+SET tension_arterial/.test(sql)) {
      contexto.actualizacion = params;
      return [{ affectedRows: contexto.filasActualizadas }];
    }
    if (/UPDATE olimpiada_inscripcion SET estado='PENDIENTE'/.test(sql)) return [{ affectedRows: 1 }];
    if (/INSERT INTO olimpiada_inscripcion\s+\(olimpiada_id/.test(sql)) {
      if (contexto.falloAlta) throw new Error("Falla simulada de la base");
      contexto.alta = params;
      return [{ insertId: 30 }];
    }
    if (/GROUP_CONCAT\(ds\.nombre/.test(sql)) return [[{ lista: contexto.sanitarios.shift() ?? null }]];
    if (/olimpiada_inscripcion_disciplina|olimpiada_inscripcion_dato_sanitario/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM olimpiada_inscripcion_acompaniante WHERE inscripcion_id = \? ORDER BY id/.test(sql)) return [contexto.acompaniantes.map((a) => ({ ...a }))];
    if (/(DELETE FROM|INSERT INTO) olimpiada_inscripcion_acompaniante/.test(sql)) return [{ affectedRows: 1 }];
    if (/INSERT INTO olimpiada_historial/.test(sql)) {
      const [entidad, , , , , , tipo, campo, anterior, nuevo, observacion] = params;
      contexto.historial.push({ entidad, tipo, campo, anterior, nuevo, observacion });
      return [{ insertId: contexto.historial.length }];
    }
    if (/INSERT INTO notificacion/.test(sql)) {
      contexto.notificaciones.push({ usuario: params[0], titulo: params[2], mensaje: params[3] });
      return [{ insertId: contexto.notificaciones.length, affectedRows: 1 }];
    }
    if (/SELECT nombre FROM departamental WHERE id = \?/.test(sql)) return [[{ nombre: "La Plata" }]];
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

test("edición: guardar sin cambios reales no deja historial ni avisa", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 1, rol: "admin" });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: formularioSinCambios });
  assert.equal(respuesta.status, 200);
  assert.deepEqual(contexto.historial, []);
  assert.deepEqual(contexto.notificaciones, []);
  assert.ok(contexto.transaccion.includes("commit"));
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

test("edición: el afiliado que guarda su inscripción aprobada la sigue devolviendo a revisión", async (t) => {
  const { enviar, contexto } = await servidor(t, { id: 20, rol: "afiliado", departamental_id: 5 });
  const respuesta = await enviar("PUT", "/olimpiadas/inscripciones/11", { campos: formularioSinCambios });
  assert.equal(respuesta.status, 200);
  assert.ok(contexto.consultas.some((c) => /UPDATE olimpiada_inscripcion SET estado='PENDIENTE'/.test(c.sql)));
  assert.deepEqual(contexto.historial.map((h) => [h.campo, h.anterior, h.nuevo]), [["estado", "VALIDADO", "PENDIENTE"]]);
  assert.deepEqual(contexto.notificaciones.map((n) => n.usuario), [1, 3]); // aviso al staff
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
