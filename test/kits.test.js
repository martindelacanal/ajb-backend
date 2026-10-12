"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const kits = require("../api/services/kits");
const { DDL, migrar } = require("../scripts/migrar-kits-departamentales");
const afiliado = { id: 19, rol: "afiliado", departamental_id: 4, documento: "30111222" };
const staff = { id: 2, rol: "departamental", departamental_id: 4 };
const cuerpo = { titulo: "Kits 2027", departamental_id: 4, publicado: true, inscripcion_desde: "2026-10-01", inscripcion_hasta: "2026-11-30",
  entrega_desde: "2027-02-01", entrega_hasta: "2027-02-20", opciones: [{ nombre: "Primaria", destinatario: "HIJO" }] };
const hoy = kits.hoyArgentina();
const campania = { id: 1, departamental_id: 4, publicado: 1, inscripcion_desde: hoy, inscripcion_hasta: hoy, titulo: "Kits 2027" };
function dbCon(respuestas) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); const response = respuestas.shift();
    if (response instanceof Error) throw response;
    assert.notEqual(response, undefined, `Consulta no esperada: ${sql}`);
    return [response];
  } };
}
const media = { async guardar() { throw new Error("No debe subir archivos"); }, async firmar() { throw new Error("No debe firmar documentos"); } };

test("campañas: una departamental sólo puede crear y editar las propias", () => {
  assert.equal(kits.normalizarCampania(cuerpo, staff).departamental_id, 4);
  assert.throws(() => kits.normalizarCampania({ ...cuerpo, departamental_id: 9 }, staff), { statusCode: 403 });
  assert.throws(() => kits.exigirPropietario(staff, { departamental_id: 9 }), { statusCode: 403 });
  assert.throws(() => kits.normalizarCampania(cuerpo, afiliado), { statusCode: 403 });
  assert.equal(kits.normalizarCampania({ ...cuerpo, departamental_id: 9 }, { rol: "admin" }).departamental_id, 9);
});

test("fechas civiles reales y período de inscripción inclusive en Argentina", () => {
  assert.throws(() => kits.fecha("2026-02-30"));
  assert.throws(() => kits.fecha("2026-13-01"));
  assert.equal(kits.fecha("2028-02-29"), "2028-02-29");
  assert.equal(kits.hoyArgentina(new Date("2026-10-13T01:30:00Z")), "2026-10-12");
  assert.equal(kits.periodoCampania(cuerpo, "2026-10-01"), "ABIERTA");
  assert.equal(kits.periodoCampania(cuerpo, "2026-11-30"), "ABIERTA");
  assert.equal(kits.periodoCampania(cuerpo, "2026-12-01"), "CERRADA");
  assert.equal(kits.periodoCampania(cuerpo, "2026-09-30"), "PROXIMAMENTE");
  assert.equal(kits.periodoCampania({ ...cuerpo, publicado: 0 }, "2026-10-12"), "BORRADOR");
  assert.throws(() => kits.normalizarCampania({ ...cuerpo, inscripcion_hasta: "2026-09-01" }, staff));
  assert.throws(() => kits.normalizarCampania({ ...cuerpo, entrega_hasta: "2027-01-01" }, staff));
});

test("opciones publicadas necesitan al menos una activa y destinatario explícito", () => {
  assert.throws(() => kits.normalizarCampania({ ...cuerpo, opciones: [] }, staff));
  assert.throws(() => kits.normalizarCampania({ ...cuerpo, opciones: [{ nombre: "Kit", destinatario: "OTRO" }] }, staff));
  assert.throws(() => kits.normalizarCampania({ ...cuerpo, opciones: [{ ...cuerpo.opciones[0], activo: false }] }, staff));
  const result = kits.normalizarCampania({ ...cuerpo, opciones: JSON.stringify(cuerpo.opciones) }, staff);
  assert.equal(result.opciones[0].nombre, "Primaria");
});

test("el kit universitario utiliza identidad real del titular y no admite otra persona", () => {
  const usuario = { nombre: "Ana", apellido: "Pérez", documento: "30.111.222" };
  const result = kits.normalizarInscripcion({ nombre_beneficiario: "Otro", anio_cursada: "2° año" }, { destinatario: "TITULAR" }, usuario);
  assert.equal(result.nombre_beneficiario, "Ana Pérez");
  assert.equal(result.dni_beneficiario, "30111222");
  assert.throws(() => kits.normalizarInscripcion({ dni_beneficiario: "44111222", anio_cursada: "2" }, { destinatario: "TITULAR" }, usuario));
  assert.throws(() => kits.normalizarInscripcion({ nombre_beneficiario: "Ana", dni_beneficiario: "30111222", anio_cursada: "2" }, { destinatario: "HIJO" }, usuario));
  assert.throws(() => kits.normalizarInscripcion({ nombre_beneficiario: "Luz", dni_beneficiario: "55111222" }, { destinatario: "HIJO" }, usuario));
  assert.equal(kits.normalizarInscripcion({ nombre_beneficiario: "Luz", dni_beneficiario: "55.111.222", anio_cursada: "1°" }, { destinatario: "HIJO" }, usuario).dni_beneficiario, "55111222");
});

test("archivos: limita tamaño y verifica contenido, no sólo extensión o MIME", () => {
  assert.doesNotThrow(() => kits.validarArchivo({ mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.7 prueba") }));
  assert.throws(() => kits.validarArchivo({ mimetype: "application/pdf", buffer: Buffer.from("<script>bad</script>") }));
  assert.throws(() => kits.validarArchivo({ mimetype: "image/jpeg", buffer: Buffer.from("%PDF-1.7 prueba") }));
  assert.throws(() => kits.validarArchivo({ mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.7 prueba") }, true));
  assert.throws(() => kits.validarArchivo({ mimetype: "application/pdf", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }));
  assert.doesNotThrow(() => kits.validarArchivo({ mimetype: "image/png", buffer: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]) }, true));
});

test("inscripción rechaza otra departamental, borradores y fecha cerrada antes de subir archivos", async () => {
  for (const modificada of [{ ...campania, departamental_id: 9 }, { ...campania, publicado: 0 }, { ...campania, inscripcion_hasta: "2000-01-01" }]) {
    const db = dbCon([[modificada]]);
    await assert.rejects(kits.inscribir(db, afiliado, 1, {}, null, media));
    assert.equal(db.calls.length, 1);
  }
  await assert.rejects(kits.inscribir(dbCon([]), { ...afiliado, acceso_familiar_turismo: true }, 1, {}, null, media), { statusCode: 403 });
  await assert.rejects(kits.inscribir(dbCon([]), { ...afiliado, bloqueo: { tipo: "modulos", modulos: ["beneficios"], mensaje: "Bloqueado" } }, 1, {}, null, media), { statusCode: 403 });
});

test("la inscripción impide duplicados por DNI incluso si otro afiliado los solicitó", async () => {
  const db = dbCon([[campania], [{ id: 3, destinatario: "HIJO" }], [{ nombre: "Ana", apellido: "Pérez", documento: "30111222" }], [{ id: 8 }]]);
  await assert.rejects(kits.inscribir(db, afiliado, 1, { opcion_id: 3, nombre_beneficiario: "Luz", dni_beneficiario: "55111222", anio_cursada: "2" }, null, media), { statusCode: 409 });
  assert.match(db.calls[0].sql, /FOR UPDATE/);
  assert.match(db.calls[3].sql, /estado NOT IN \('RECHAZADA', 'CANCELADA'\)/);
  assert.equal(db.calls[3].params[1], "55111222");
  assert.match(DDL.join("\n"), /UNIQUE KEY uq_kit_dni_campania \(campania_id, dni_activo\)/);
});

test("inscripción válida genera código y registro inicial de auditoría", async () => {
  const db = dbCon([[campania], [{ id: 3, destinatario: "HIJO" }], [{ nombre: "Ana", apellido: "Pérez", documento: "30111222" }], [], { insertId: 45 }, { insertId: 1 }]);
  const result = await kits.inscribir(db, afiliado, 1, { opcion_id: 3, nombre_beneficiario: "Luz", dni_beneficiario: "55111222", anio_cursada: "2" }, null, media);
  assert.deepEqual(result, { id: 45, codigo: "K-45" });
  assert.equal(db.calls[4].params[0].usuario_id, 19);
  assert.equal(db.calls[4].params[0].documento_archivo, null);
  assert.match(db.calls[5].sql, /kit_inscripcion_historial/);
});

test("documentos y detalle privado requieren dueño o personal de la misma departamental", async () => {
  const row = { id: 9, usuario_id: 19, departamental_id: 4, documento_archivo: "kits/documentos/privado.pdf" };
  assert.equal((await kits.buscarInscripcion(dbCon([[row]]), afiliado, 9)).documento_archivo, row.documento_archivo);
  await assert.rejects(kits.buscarInscripcion(dbCon([[row]]), { ...afiliado, id: 20 }, 9), { statusCode: 404 });
  await assert.rejects(kits.buscarInscripcion(dbCon([[row]]), { ...staff, departamental_id: 9 }, 9), { statusCode: 403 });
  await assert.rejects(kits.buscarInscripcion(dbCon([[row]]), { id: 1, rol: "beneficios" }, 9), { statusCode: 403 });
});

test("listados protegen pertenencia y no revelan claves privadas de archivos", async () => {
  const db = dbCon([[{ id: 9, usuario_id: 19, estado: "PENDIENTE", documento_archivo: "privado.pdf" }]]);
  const result = await kits.listarInscripciones(db, afiliado);
  assert.match(db.calls[0].sql, /i.usuario_id = \?/);
  assert.deepEqual(db.calls[0].params, [19]);
  assert.equal(result[0].documento_archivo, undefined);
  assert.equal(result[0].tiene_documento, true);
  assert.equal(result[0].estado_nombre, "En revisión");
  const dbStaff = dbCon([[]]);
  await kits.listarInscripciones(dbStaff, staff);
  assert.match(dbStaff.calls[0].sql, /k.departamental_id = \?/);
  assert.deepEqual(dbStaff.calls[0].params, [4]);
});

test("una campaña retirada sólo permite lectura al afiliado con inscripción propia", async () => {
  const archivada = { ...campania, publicado: 0, departamental_id: 8 };
  const db = dbCon([[archivada], [{ id: 6 }], [{ id: 3, nombre: "Universitario", destinatario: "TITULAR", activo: 1 }], [{ id: 6, usuario_id: 19, estado: "APROBADA" }]]);
  const resultado = await kits.detalleCampania(db, afiliado, 1, media);
  assert.equal(resultado.inscripcion_abierta, false);
  assert.equal(resultado.mis_inscripciones.length, 1);
  assert.deepEqual(db.calls[1].params, [1, 19]);
  await assert.rejects(kits.detalleCampania(dbCon([[archivada], []]), afiliado, 1, media), { statusCode: 404 });
});

test("después de un traslado puede leer su campaña publicada pero no inscribirse otra vez", async () => {
  const db = dbCon([[{ ...campania, departamental_id: 8 }], [{ id: 6 }], [{ id: 3, nombre: "Universitario", destinatario: "TITULAR", activo: 1 }], [{ id: 6, usuario_id: 19, estado: "APROBADA" }]]);
  const resultado = await kits.detalleCampania(db, afiliado, 1, media);
  assert.equal(resultado.estado_periodo, "ABIERTA");
  assert.equal(resultado.inscripcion_abierta, false);
  assert.equal(resultado.mis_inscripciones.length, 1);
});

test("estados: afiliado no aprueba ni entrega; rechazo requiere explicación; entregada final", () => {
  assert.throws(() => kits.validarTransicion(afiliado, "PENDIENTE", "APROBADA", ""), { statusCode: 403 });
  assert.doesNotThrow(() => kits.validarTransicion(afiliado, "PENDIENTE", "CANCELADA", ""));
  assert.throws(() => kits.validarTransicion(afiliado, "LISTA_RETIRO", "CANCELADA", ""), { statusCode: 403 });
  assert.throws(() => kits.validarTransicion(staff, "PENDIENTE", "RECHAZADA", null));
  assert.doesNotThrow(() => kits.validarTransicion(staff, "PENDIENTE", "RECHAZADA", "Falta acreditar escolaridad"));
  assert.throws(() => kits.validarTransicion(staff, "ENTREGADA", "PENDIENTE", null), { statusCode: 409 });
});

test("migración check no escribe; apply usa CREATE IF NOT EXISTS y grants precisos", async () => {
  const names = ["kit_campania", "kit_opcion", "kit_inscripcion", "kit_inscripcion_historial"].map((nombre) => ({ nombre }));
  const check = dbCon([names]);
  assert.deepEqual(await migrar(check, { log() {} }), { faltantes: [] });
  assert.equal(check.calls.length, 1);
  const apply = dbCon([{}, {}, {}, {}, [{ user: "miajb_runtime", host: "localhost" }], {}, {}, {}, {}, names]);
  await migrar(apply, { aplicar: true, database: "db_miajb", log() {} });
  assert.equal(apply.calls.filter((c) => /CREATE TABLE IF NOT EXISTS/.test(c.sql)).length, 4);
  assert.equal(apply.calls.filter((c) => /GRANT SELECT, INSERT, UPDATE ON/.test(c.sql)).length, 3);
  assert.equal(apply.calls.filter((c) => /GRANT SELECT, INSERT ON/.test(c.sql)).length, 1);
  assert.equal(apply.calls.some((c) => /GRANT.*DELETE/.test(c.sql)), false);
});
