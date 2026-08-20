const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

const router = require("../api/routes/coseguro");
const {
  adquirirBloqueoDuplicados,
  buscarDuplicadosComprobante,
  calcularReintegroEstimado,
  decodificarFirmaBase64,
  normalizarFecha,
  normalizarImporte,
  puedeVerSubsidio,
  tieneAreaCoseguro,
  validarContenidoArchivo,
  verifyToken,
} = router.__test;

function pngMinimo() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

test("coseguro normaliza importes exactos y compatibles con DECIMAL(12,2)", () => {
  assert.equal(normalizarImporte("0"), 0);
  assert.equal(normalizarImporte("12,34"), 12.34);
  assert.equal(normalizarImporte("9999999999.99"), 9999999999.99);
  for (const invalido of ["-0.01", "1.001", "1e3", "Infinity", "9999999999.999", "10000000000.00"]) {
    assert.equal(normalizarImporte(invalido), null, invalido);
  }
});

test("coseguro calcula cobertura en centavos, redondea mitad hacia arriba y aplica tope", () => {
  assert.deepEqual(
    calcularReintegroEstimado({ modo_cobertura: "PORCENTAJE", porcentaje_cobertura: "33.33", tope_reintegro: null }, "100.00"),
    { porcentaje: 33.33, estimado: 33.33 }
  );
  assert.equal(
    calcularReintegroEstimado({ modo_cobertura: "PORCENTAJE", porcentaje_cobertura: "50", tope_reintegro: null }, "0.01").estimado,
    0.01
  );
  assert.equal(
    calcularReintegroEstimado({ modo_cobertura: "PORCENTAJE", porcentaje_cobertura: "80", tope_reintegro: "25.00" }, "100.00").estimado,
    25
  );
  assert.deepEqual(
    calcularReintegroEstimado({ modo_cobertura: "PORCENTAJE", porcentaje_cobertura: "80", tope_reintegro: "-1" }, "100.00"),
    { porcentaje: null, estimado: null }
  );
});

test("coseguro acepta sólo fechas civiles ISO estrictas", () => {
  assert.equal(normalizarFecha("2028-02-29"), "2028-02-29");
  for (const invalida of ["2027-02-29", "29/02/2028", "2028-02-29T00:00:00Z", "2028-13-01"]) {
    assert.equal(normalizarFecha(invalida), null, invalida);
  }
});

test("coseguro valida contenido real y rechaza SVG o MIME falso", () => {
  const png = { buffer: pngMinimo(), mimetype: "image/png", fieldname: "FACTURA" };
  assert.equal(validarContenidoArchivo(png, { permitePdf: true }).mime, "image/png");

  const falso = { buffer: pngMinimo(), mimetype: "image/svg+xml", fieldname: "FACTURA" };
  assert.match(validarContenidoArchivo(falso, { permitePdf: true }).error, /no coincide/i);

  const svg = { buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), mimetype: "image/svg+xml", fieldname: "FACTURA" };
  assert.match(validarContenidoArchivo(svg, { permitePdf: true }).error, /Formato no permitido/i);
});

test("coseguro restringe firmas base64 por formato real", () => {
  const firma = `data:image/png;base64,${pngMinimo().toString("base64")}`;
  assert.equal(decodificarFirmaBase64(firma).mime, "image/png");
  assert.equal(decodificarFirmaBase64("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), null);
  assert.equal(decodificarFirmaBase64("data:image/png;base64,PHN2Zz48L3N2Zz4="), null);
});

test("coseguro exige adquirir el bloqueo asesor antes de decidir duplicados", async () => {
  const llamadas = [];
  const connection = {
    async query(sql, params) {
      llamadas.push({ sql, params });
      return [[{ adquirido: 1 }]];
    },
  };
  assert.equal(await adquirirBloqueoDuplicados(connection), true);
  assert.match(llamadas[0].sql, /GET_LOCK/);

  const ocupada = { async query() { return [[{ adquirido: 0 }]]; } };
  await assert.rejects(() => adquirirBloqueoDuplicados(ocupada), (error) => error.statusCode === 409);
});

test("coseguro busca duplicados con la misma identidad canónica que los claims", async () => {
  let consulta;
  const db = {
    async query(sql, params) {
      consulta = { sql, params };
      return [[]];
    },
  };

  await buscarDuplicadosComprobante(db, {
    emisor_cuit: "20-12345678-6",
    comprobante_pto_venta: "00001",
    comprobante_numero: "00000123",
    usuario_id: 42,
    excluirId: 9,
  });

  assert.match(consulta.sql, /TRIM\(LEADING '0' FROM s\.comprobante_numero\)/);
  assert.match(consulta.sql, /REGEXP_REPLACE/);
  assert.match(consulta.sql, /LPAD/);
  assert.deepEqual(consulta.params, [5, 6, "123", "20123456786", 42, "00001", 9]);
});

test("coseguro aplica el modulo al afiliado y conserva el area del staff", () => {
  assert.equal(tieneAreaCoseguro({ rol: "afiliado", modulo_coseguro: 0 }), false);
  assert.equal(tieneAreaCoseguro({ rol: "afiliado", modulo_coseguro: 1 }), true);
  assert.equal(tieneAreaCoseguro({ rol: "departamental", area_coseguro: 0 }), false);
  assert.equal(tieneAreaCoseguro({ rol: "departamental", area_coseguro: 1 }), true);
  assert.equal(tieneAreaCoseguro({ rol: "admin" }), true);
});

test("un afiliado sin Coseguro no puede leer ni siquiera su subsidio propio", () => {
  const subsidio = { usuario_id: 17, afiliado_departamental_id: 8 };

  assert.equal(puedeVerSubsidio({ rol: "afiliado", id: 17, modulo_coseguro: 0 }, subsidio), false);
  assert.equal(puedeVerSubsidio({ rol: "afiliado", id: 17, modulo_coseguro: 1 }, subsidio), true);
  assert.equal(
    puedeVerSubsidio({ rol: "departamental", departamental_id: 8, area_coseguro: 1 }, subsidio),
    true
  );
  assert.equal(
    puedeVerSubsidio({ rol: "departamental", departamental_id: 8, area_coseguro: 0 }, subsidio),
    false
  );
});

test("coseguro requiere esquema Bearer estricto", () => {
  const respuesta = () => ({
    codigo: null,
    cuerpo: null,
    status(codigo) { this.codigo = codigo; return this; },
    json(cuerpo) { this.cuerpo = cuerpo; return this; },
  });

  for (const authorization of [undefined, "token", "bearer token", "Bearer  token", "Bearer token extra"]) {
    const res = respuesta();
    verifyToken({ headers: { authorization } }, res, () => assert.fail("no debe continuar"));
    assert.equal(res.codigo, 401, authorization);
  }
});
