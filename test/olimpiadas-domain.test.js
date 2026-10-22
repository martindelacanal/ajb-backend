const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

const router = require("../api/routes/olimpiadas");
const {
  decodificarFirmaBase64,
  estaVentanaInscripcionAbierta,
  idsPositivosIguales,
  nombreDepartamental,
  normalizarCupo,
  normalizarIds,
  obtenerDisciplinasOlimpiada,
  resolverAfiliadoDestino,
  validarCapacidadDisciplinas,
  validarConfiguracionContraInscripciones,
  validarContenidoArchivo,
  validarDatosOlimpiada,
  verifyToken,
} = router.__test;

function pngMinimo() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function datosOlimpiada(overrides = {}) {
  return {
    nombre: "Olimpiadas 2027",
    fecha_inicio: "2027-10-10",
    fecha_fin: "2027-10-12",
    fecha_inicio_inscripcion: "2027-08-01",
    fecha_fin_inscripcion: "2027-10-09",
    disciplinas: [{ disciplina_id: 1, max_por_departamental: 10 }],
    ...overrides,
  };
}

test("olimpiadas valida fechas civiles y cronología completa", () => {
  assert.equal(validarDatosOlimpiada(datosOlimpiada()).error, undefined);
  assert.match(validarDatosOlimpiada(datosOlimpiada({ fecha_inicio: "2027-10-10T00:00:00Z" })).error, /YYYY-MM-DD/);
  assert.match(validarDatosOlimpiada(datosOlimpiada({ fecha_fin: "2027-10-09" })).error, /fin/);
  assert.match(validarDatosOlimpiada(datosOlimpiada({ fecha_fin_inscripcion: "2027-10-11" })).error, /cerrar/);
  assert.match(validarDatosOlimpiada(datosOlimpiada({ fecha_inicio_inscripcion: "2027-09-01", fecha_fin_inscripcion: "2027-08-31" })).error, /cierre/);
});

test("olimpiadas exige cupos enteros y disciplinas únicas", () => {
  assert.ok(normalizarCupo("0").error);
  assert.deepEqual(normalizarCupo("25"), { value: 25 });
  assert.ok(normalizarCupo("1.5").error);
  assert.ok(normalizarCupo("-1").error);
  assert.ok(normalizarCupo([1]).error);
  assert.match(validarDatosOlimpiada(datosOlimpiada({ disciplinas: [{ disciplina_id: 1, max_por_departamental: 1.5 }] })).error, /Cupo inválido/);
  assert.match(validarDatosOlimpiada(datosOlimpiada({ disciplinas: [{ disciplina_id: 1 }, { disciplina_id: "1" }] })).error, /repetir/);
});

test("olimpiadas publica nuevas ediciones por defecto y respeta la decisión de ocultarlas", () => {
  assert.equal(validarDatosOlimpiada(datosOlimpiada(), { nueva: true }).value.opcionales.publicada_publico, 1);
  assert.equal(validarDatosOlimpiada(datosOlimpiada({ publicada_publico: 0 }), { nueva: true }).value.opcionales.publicada_publico, 0);
  assert.equal(validarDatosOlimpiada(datosOlimpiada({ publicada_publico: 1 }), { nueva: true }).value.opcionales.publicada_publico, 1);
  assert.equal(validarDatosOlimpiada(datosOlimpiada()).value.opcionales.publicada_publico, undefined);
  assert.equal(validarDatosOlimpiada(datosOlimpiada({ publicada_publico: 0 })).value.opcionales.publicada_publico, 0);
  assert.match(validarDatosOlimpiada(datosOlimpiada({ publicada_publico: 2 }), { nueva: true }).error, /1 o 0/);
});

test("olimpiadas normaliza listas de IDs sin aceptar decimales ni notación exponencial", () => {
  assert.deepEqual(normalizarIds(["1", 2, "1"]), [1, 2]);
  assert.equal(normalizarIds([1.5]), null);
  assert.equal(normalizarIds(["1e2"]), null);
  assert.equal(normalizarIds("no-json"), null);
});

test("olimpiadas nunca autoriza comparando IDs nulos o inválidos", () => {
  assert.equal(idsPositivosIguales("12", 12), true);
  assert.equal(idsPositivosIguales(null, null), false);
  assert.equal(idsPositivosIguales("1e2", 100), false);
});

test("olimpiadas evalúa la ventana con fechas civiles inclusivas", () => {
  const evento = { fecha_inicio_inscripcion: "2027-08-01", fecha_fin_inscripcion: "2027-08-31" };
  assert.equal(estaVentanaInscripcionAbierta(evento, "2027-08-01"), true);
  assert.equal(estaVentanaInscripcionAbierta(evento, "2027-08-31"), true);
  assert.equal(estaVentanaInscripcionAbierta(evento, "2027-09-01"), false);
});

test("olimpiadas permite PDF sólo en CERTIFICADO y rechaza SVG/MIME falso", () => {
  const pdf = Buffer.from("%PDF-1.7\n");
  assert.equal(validarContenidoArchivo({ buffer: pdf, mimetype: "application/pdf", fieldname: "CERTIFICADO" }).mime, "application/pdf");
  assert.match(validarContenidoArchivo({ buffer: pdf, mimetype: "application/pdf", fieldname: "FOTO" }).error, /JPEG/);
  assert.match(validarContenidoArchivo({ buffer: Buffer.from("<svg></svg>"), mimetype: "image/svg+xml", fieldname: "ICONO" }).error, /JPEG/);
  assert.match(validarContenidoArchivo({ buffer: pngMinimo(), mimetype: "image/jpeg", fieldname: "FOTO" }).error, /no coincide/);
});

test("olimpiadas restringe firmas base64 por formato real", () => {
  const firma = `data:image/png;base64,${pngMinimo().toString("base64")}`;
  assert.equal(decodificarFirmaBase64(firma).mime, "image/png");
  assert.equal(decodificarFirmaBase64("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), null);
});

test("olimpiadas rechaza reactivación o edición cuando el cupo quedó completo", async () => {
  const consultas = [];
  const connection = {
    async query(sql, params) {
      consultas.push({ sql, params });
      if (sql.includes("FROM olimpiada_disciplina_config")) {
        return [[{ disciplina_id: 7, max_por_departamental: 2, nombre: "Vóley" }]];
      }
      if (sql.includes("COUNT(*) AS total")) return [[{ total: 2 }]];
      if (sql.includes("SELECT nombre FROM departamental")) return [[{ nombre: "Azul" }]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  await assert.rejects(
    () => validarCapacidadDisciplinas(connection, {
      olimpiadaId: 3,
      departamentalId: 9,
      disciplinaIds: [7],
      excluirInscripcionId: 11,
    }),
    (error) => error.statusCode === 409 && error.message === 'Ya no quedan lugares de "Vóley" en el cupo de Azul'
  );
  assert.deepEqual(consultas[1].params, [7, 3, 9, 11]);
  assert.deepEqual(consultas[2].params, [9]);
});

test("olimpiadas nombra el cupo de las inscripciones viejas sin departamental sin consultar nombres", async () => {
  const connection = {
    async query(sql) {
      if (sql.includes("FROM olimpiada_disciplina_config")) return [[{ disciplina_id: 7, max_por_departamental: 1, nombre: "Vóley" }]];
      if (sql.includes("COUNT(*) AS total")) return [[{ total: 1 }]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  await assert.rejects(
    () => validarCapacidadDisciplinas(connection, { olimpiadaId: 3, departamentalId: null, disciplinaIds: [7] }),
    (error) => error.statusCode === 409 && /en el cupo de afiliados sin departamental$/.test(error.message)
  );
});

test("olimpiadas impide quitar disciplinas usadas o bajar cupos bajo la ocupación", async () => {
  const usada = {
    async query() {
      return [[{ disciplina_id: 4, departamental_id: 2, disciplina_nombre: "Vóley", departamental_nombre: "Azul", inscripciones: 3, activas: 2 }]];
    },
  };
  await assert.rejects(
    () => validarConfiguracionContraInscripciones(usada, 1, []),
    (error) => error.statusCode === 409 && error.message === 'No se puede quitar "Vóley": tiene inscripciones asociadas'
  );
  await assert.rejects(
    () => validarConfiguracionContraInscripciones(usada, 1, [{ disciplina_id: 4, max_por_departamental: 1 }]),
    (error) => error.statusCode === 409
      // «En revisión», como el staff ve el estado PENDIENTE (no «pendientes»)
      && error.message === 'El cupo de "Vóley" no puede bajar de 2: ya hay 2 inscripciones en revisión o aprobadas en el cupo de Azul'
  );
  await validarConfiguracionContraInscripciones(usada, 1, [{ disciplina_id: 4, max_por_departamental: 2 }]);

  const sinDepartamental = {
    async query(sql) {
      assert.match(sql, /LEFT JOIN departamental dep ON dep\.id = i\.departamental_id/);
      assert.match(sql, /GROUP BY idp\.disciplina_id, i\.departamental_id/);
      return [[{ disciplina_id: 4, departamental_id: null, disciplina_nombre: "Vóley", departamental_nombre: null, inscripciones: 3, activas: 3 }]];
    },
  };
  await assert.rejects(
    () => validarConfiguracionContraInscripciones(sinDepartamental, 1, [{ disciplina_id: 4, max_por_departamental: 2 }]),
    (error) => /no puede bajar de 3: .* en el cupo de afiliados sin departamental$/.test(error.message)
  );
});

test("olimpiadas muestra la ocupación con la misma regla con la que valida el cupo", async () => {
  const consultas = [];
  const db = {
    async query(sql, params) {
      consultas.push({ sql, params });
      return [[
        { id: 7, nombre: "Vóley", tipo_id: 1, tipo_nombre: "Atleta", icono_archivo: null, max_por_departamental: 10, inscriptos_departamental: 3 },
        { id: 8, nombre: "Truco", tipo_id: 1, tipo_nombre: "Atleta", icono_archivo: null, max_por_departamental: 2, inscriptos_departamental: 5 },
        { id: 9, nombre: "Ajedrez", tipo_id: 1, tipo_nombre: "Atleta", icono_archivo: null, max_por_departamental: null, inscriptos_departamental: 4 },
      ]];
    },
  };
  const disciplinas = await obtenerDisciplinasOlimpiada(db, 3, { departamentalId: null, excluirInscripcionId: 11 });
  assert.match(consultas[0].sql, /i\.departamental_id <=> \?/);
  assert.match(consultas[0].sql, /\? IS NULL OR i\.id <> \?/);
  assert.match(consultas[0].sql, /i\.estado IN \('PENDIENTE','VALIDADO'\)/);
  assert.doesNotMatch(consultas[0].sql, /\? IS NULL OR i\.departamental_id = \?/);
  assert.deepEqual(consultas[0].params, [null, 11, 11, 3]);
  assert.deepEqual(disciplinas.map((d) => [d.id, d.inscriptos_departamental, d.cupo_disponible]), [[7, 3, 7], [8, 5, 0], [9, 4, null]]);
  assert.equal(disciplinas[0].icono_url, null);

  await obtenerDisciplinasOlimpiada(db, 3, { departamentalId: 5 });
  assert.deepEqual(consultas[1].params, [5, null, null, 3]);
});

test("olimpiadas sin ocupación devuelve sólo los topes (administración provincial)", async () => {
  const consultas = [];
  const db = {
    async query(sql, params) {
      consultas.push({ sql, params });
      return [[{ id: 7, nombre: "Vóley", tipo_id: 1, tipo_nombre: "Atleta", icono_archivo: null, max_por_departamental: 10 }]];
    },
  };
  const [voley] = await obtenerDisciplinasOlimpiada(db, 3, { conOcupacion: false });
  assert.doesNotMatch(consultas[0].sql, /inscriptos_departamental/);
  assert.deepEqual(consultas[0].params, [3]);
  assert.equal(voley.max_por_departamental, 10);
  assert.equal("inscriptos_departamental" in voley, false);
  assert.equal("cupo_disponible" in voley, false);
});

test("olimpiadas no inscribe a personas sin departamental y lo explica según quién carga", async () => {
  const afiliado = {
    id: 20, nombre: "Ana", apellido: "Pérez", rol_nombre: "afiliado", habilitado: "Y",
    usuario_familiar_id: null, es_familiar: "N", modulo_olimpiadas: 1, departamental_id: null,
  };
  const db = (fila) => ({ async query() { return [[fila]]; } });
  await assert.rejects(
    () => resolverAfiliadoDestino(db(afiliado), 20, { rol: "afiliado", id: 20 }),
    (error) => error.statusCode === 422
      && error.message === "Tu usuario no tiene una departamental asignada. Comunicate con la AJB para que te la asignen y después inscribite."
  );
  for (const rol of ["admin", "admin-central"]) {
    await assert.rejects(
      () => resolverAfiliadoDestino(db(afiliado), 20, { rol, id: 1, departamental_id: 1 }),
      (error) => error.statusCode === 422
        && error.message === "Pérez, Ana no tiene una departamental asignada. Asignásela desde Usuarios y después cargá la inscripción.",
      rol
    );
  }
  // La departamental sigue recibiendo el 403 de siempre (sólo inscribe a los suyos)
  await assert.rejects(
    () => resolverAfiliadoDestino(db(afiliado), 20, { rol: "departamental", id: 3, departamental_id: 1 }),
    (error) => error.statusCode === 403
  );
  assert.equal((await resolverAfiliadoDestino(db({ ...afiliado, departamental_id: 5 }), 20, { rol: "admin", id: 1 })).departamental_id, 5);
});

test("olimpiadas nombra la departamental del cupo y no consulta si no hay departamental", async () => {
  const consultas = [];
  const db = (filas) => ({ async query(sql, params) { consultas.push(params); return [filas]; } });
  assert.equal(await nombreDepartamental(db([{ nombre: "La Plata" }]), 1), "La Plata");
  assert.equal(await nombreDepartamental(db([]), 4), "departamental #4");
  assert.equal(await nombreDepartamental(db([]), null), null);
  assert.deepEqual(consultas, [[1], [4]]);
});

test("olimpiadas requiere esquema Bearer estricto", () => {
  const respuesta = () => ({
    codigo: null,
    status(codigo) { this.codigo = codigo; return this; },
    json() { return this; },
  });
  for (const authorization of [undefined, "token", "bearer token", "Bearer  token", "Bearer token extra"]) {
    const res = respuesta();
    verifyToken({ headers: { authorization } }, res, () => assert.fail("no debe continuar"));
    assert.equal(res.codigo, 401, authorization);
  }
});
