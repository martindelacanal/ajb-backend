const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

const router = require("../api/routes/olimpiadas");
const {
  decodificarFirmaBase64,
  estaVentanaInscripcionAbierta,
  idsPositivosIguales,
  normalizarCupo,
  normalizarIds,
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
    (error) => error.statusCode === 409 && /Vóley/.test(error.message)
  );
  assert.deepEqual(consultas[1].params, [7, 3, 9, 11]);
});

test("olimpiadas impide quitar disciplinas usadas o bajar cupos bajo la ocupación", async () => {
  const usada = {
    async query() {
      return [[{ disciplina_id: 4, departamental_id: 2, inscripciones: 3, activas: 2 }]];
    },
  };
  await assert.rejects(
    () => validarConfiguracionContraInscripciones(usada, 1, []),
    (error) => error.statusCode === 409 && /quitar/.test(error.message)
  );
  await assert.rejects(
    () => validarConfiguracionContraInscripciones(usada, 1, [{ disciplina_id: 4, max_por_departamental: 1 }]),
    (error) => error.statusCode === 409 && /no puede bajar/.test(error.message)
  );
  await validarConfiguracionContraInscripciones(usada, 1, [{ disciplina_id: 4, max_por_departamental: 2 }]);
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
