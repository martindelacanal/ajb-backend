const test = require("node:test");
const assert = require("node:assert/strict");

const arca = require("../api/services/arca");

test("ARCA rechaza importes, fechas e identificadores inválidos antes de usar la red", async () => {
  await assert.rejects(
    () => arca.constatarComprobante({
      cuit_emisor: "20-12345678-9",
      pto_venta: "1e2",
      cbte_tipo: 11,
      numero: 1,
      fecha: "2026-02-30",
      importe: "12.345",
      cod_autorizacion: "abc",
    }),
    { name: "TypeError", message: /no son validos/ }
  );
});

test("ARCA rechaza tipos de comprobante fuera del catálogo soportado", async () => {
  await assert.rejects(
    () => arca.constatarComprobante({
      cuit_emisor: "20123456789",
      pto_venta: 1,
      cbte_tipo: 999,
      numero: 1,
      fecha: "2026-08-07",
      importe: "100.00",
      cod_autorizacion: "12345678901234",
    }),
    TypeError
  );
});
