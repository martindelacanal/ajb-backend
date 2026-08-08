const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aplicarDescuentoEnPuntosBase,
  calcularEdadEnFecha,
  centavosADecimal,
  decimalACentavos,
  decimalAPuntosBase,
  diferenciaDiasCivil,
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
  obtenerNochesReserva,
  MAX_DINERO_CENTAVOS,
  revertirDescuentoEnPuntosBase,
  sumarCentavos,
  sumarDiasFechaCivil,
  validarCbu,
  validarCuitCuil,
  validarRangoReservaTemporal,
} = require("../api/services/valores-dominio");

test("las fechas civiles son estrictas y no dependen de la zona horaria", () => {
  assert.equal(normalizarFechaCivil("2024-02-29"), "2024-02-29");
  assert.equal(normalizarFechaCivil("2025-02-29"), null);
  assert.equal(normalizarFechaCivil("2025-13-01"), null);
  assert.equal(normalizarFechaCivil("01/03/2025"), null);
  assert.equal(sumarDiasFechaCivil("2024-02-28", 1), "2024-02-29");
  assert.equal(sumarDiasFechaCivil("2024-02-29", 1), "2024-03-01");
});

test("las noches excluyen siempre el checkout", () => {
  assert.equal(diferenciaDiasCivil("2025-07-16", "2025-07-18"), 2);
  assert.deepEqual(obtenerNochesReserva("2025-07-16", "2025-07-18"), [
    "2025-07-16",
    "2025-07-17",
  ]);
  assert.deepEqual(obtenerNochesReserva("2025-07-18", "2025-07-18"), []);
  assert.deepEqual(obtenerNochesReserva("2025-01-01", "2027-01-01"), []);
});

test("hoy Argentina es inyectable y respeta el cambio de día en UTC-3", () => {
  assert.equal(obtenerFechaCivilArgentina(new Date("2035-06-01T02:59:59.000Z")), "2035-05-31");
  assert.equal(obtenerFechaCivilArgentina(new Date("2035-06-01T03:00:00.000Z")), "2035-06-01");
  assert.equal(obtenerFechaCivilArgentina("fecha-invalida"), null);
});

test("las reservas no comienzan en el pasado salvo que una edición conserve el rango exacto", () => {
  const hoy = "2040-05-10";
  assert.equal(validarRangoReservaTemporal("2040-05-10", "2040-05-11", { hoy }).valido, true);
  assert.equal(validarRangoReservaTemporal("2040-05-11", "2040-05-12", { hoy }).valido, true);
  assert.deepEqual(
    validarRangoReservaTemporal("2040-05-09", "2040-05-10", { hoy }),
    { valido: false, codigo: "FECHA_INICIO_PASADA" }
  );
  assert.deepEqual(
    validarRangoReservaTemporal("2040-05-09", "2040-05-10", {
      hoy,
      rangoExistente: { fecha_inicio: "2040-05-09", fecha_fin: "2040-05-10" },
    }),
    { valido: true, conservaRangoPasado: true }
  );
  assert.equal(validarRangoReservaTemporal("2040-05-09", "2040-05-11", {
    hoy,
    rangoExistente: { fecha_inicio: "2040-05-09", fecha_fin: "2040-05-10" },
  }).valido, false);
});

test("la edad se calcula a la fecha de ingreso", () => {
  assert.equal(calcularEdadEnFecha("2010-08-08", "2026-08-07"), 15);
  assert.equal(calcularEdadEnFecha("2010-08-08", "2026-08-08"), 16);
  assert.equal(calcularEdadEnFecha("2027-01-01", "2026-08-08"), null);
});

test("los importes se validan y representan en centavos enteros", () => {
  assert.equal(decimalACentavos("1234.56"), 123456);
  assert.equal(decimalACentavos("1234,5"), 123450);
  assert.equal(decimalACentavos(0.1), 10);
  assert.equal(decimalACentavos("12.345"), null);
  assert.equal(decimalACentavos("NaN"), null);
  assert.equal(decimalACentavos(Infinity), null);
  assert.equal(decimalACentavos("-1"), null);
  assert.equal(decimalACentavos("9999999999.99"), MAX_DINERO_CENTAVOS);
  assert.equal(decimalACentavos("10000000000.00"), null);
  assert.equal(centavosADecimal(123456), "1234.56");
  assert.equal(sumarCentavos(MAX_DINERO_CENTAVOS, 1), null);
});

test("los descuentos redondean una sola vez al centavo", () => {
  const porcentaje = decimalAPuntosBase("12.50");
  assert.equal(porcentaje, 1250);
  assert.equal(aplicarDescuentoEnPuntosBase(999, porcentaje), 874);
  assert.equal(revertirDescuentoEnPuntosBase(874, porcentaje), 999);
  assert.equal(aplicarDescuentoEnPuntosBase(999, 10000), 0);
  assert.equal(revertirDescuentoEnPuntosBase(0, 10000), null);
  assert.equal(decimalAPuntosBase("100.01"), null);
});

test("CUIL y CBU se validan como cadenas exactas con dígito verificador", () => {
  assert.equal(validarCuitCuil("20123456786"), true);
  assert.equal(validarCuitCuil("20123456780"), false);
  assert.equal(validarCuitCuil("20-12345678-6"), false);
  assert.equal(validarCbu("2850590940090418130015"), true);
  assert.equal(validarCbu("2850590940090418130010"), false);
  assert.equal(validarCbu(2850590940090418130015), false);
});
