"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { jsonCanonico } = require("../api/services/reserva-version-archivo");
const {
  canonicalizeCheck,
  canonicalizeSql,
  stableJson,
} = require("../scripts/integridad-financiera-common");

test("el JSON de archivo es canónico aunque cambie el orden de propiedades", () => {
  const first = {
    z: Buffer.from("AJB"),
    a: { fecha: new Date("2026-08-07T00:00:00.000Z"), importe: "10.20" },
  };
  const second = {
    a: { importe: "10.20", fecha: new Date("2026-08-07T00:00:00.000Z") },
    z: Buffer.from("AJB"),
  };
  assert.equal(jsonCanonico(first), jsonCanonico(second));
  assert.equal(
    crypto.createHash("sha256").update(jsonCanonico(first)).digest("hex"),
    crypto.createHash("sha256").update(jsonCanonico(second)).digest("hex")
  );
});

test("stableJson conserva el orden de arrays y ordena claves recursivamente", () => {
  assert.equal(
    stableJson({ b: [{ z: 1, a: 2 }], a: "x" }),
    '{"a":"x","b":[{"a":2,"z":1}]}'
  );
});

test("la canonicalización de CHECK conserva agrupación booleana y BETWEEN", () => {
  const expected = "precio >= 0 AND (edad IS NULL OR edad BETWEEN 0 AND 130)";
  const mysql =
    "((`precio` >= 0) AND ((`edad` IS NULL) OR (`edad` BETWEEN 0 AND 130)))";
  assert.equal(canonicalizeCheck(mysql), canonicalizeCheck(expected));
  assert.notEqual(
    canonicalizeCheck("(precio >= 0 AND edad IS NULL) OR edad BETWEEN 0 AND 130"),
    canonicalizeCheck(expected)
  );
});

test("la canonicalización acepta literales escapados por INFORMATION_SCHEMA", () => {
  const mysql = "(`operacion` in (_utf8mb4\\'EDICION\\',_utf8mb4\\'ELIMINACION\\',_utf8mb4\\'CORRECCION\\'))";
  const contrato = "operacion IN ('EDICION','ELIMINACION','CORRECCION')";
  assert.equal(canonicalizeCheck(mysql), canonicalizeCheck(contrato));
});

test("la expresión generada olímpica tolera los paréntesis de MySQL", () => {
  const mysql = "(case when ((`eliminado` = 0) and (`estado` = _utf8mb4\\'VALIDADO\\')) then `usuario_id` else NULL end)";
  const contrato = "CASE WHEN eliminado = 0 AND estado = 'VALIDADO' THEN usuario_id ELSE NULL END";
  const normalizar = (sql) => canonicalizeSql(sql).replace(/[()\s]/g, "");
  assert.equal(normalizar(mysql), normalizar(contrato));
});
