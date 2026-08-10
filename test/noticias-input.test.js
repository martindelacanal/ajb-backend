"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const router = require("../api/routes/noticias");

const { normalizarIdsExcluidos } = router.__test;

test("exclude_ids admite hasta seis enteros positivos y elimina repetidos", () => {
  assert.deepEqual(normalizarIdsExcluidos(undefined), []);
  assert.deepEqual(normalizarIdsExcluidos("1, 2,2,900"), [1, 2, 900]);
  assert.deepEqual(normalizarIdsExcluidos("1,2,3,4,5,6"), [1, 2, 3, 4, 5, 6]);
});

test("exclude_ids rechaza exceso, valores parciales y formas ambiguas", () => {
  assert.equal(normalizarIdsExcluidos("1,2,3,4,5,6,7"), null);
  assert.equal(normalizarIdsExcluidos("1,2 OR 1=1"), null);
  assert.equal(normalizarIdsExcluidos("1,,2"), null);
  assert.equal(normalizarIdsExcluidos(["1", "2"]), null);
  assert.equal(normalizarIdsExcluidos(String(Number.MAX_SAFE_INTEGER + 1)), null);
});
