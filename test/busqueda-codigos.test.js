"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { leerCodigoBuscado } = require("../api/services/busqueda-codigos");

test("lee el código con o sin guion, con espacios y en minúscula", () => {
  for (const texto of ["T-120", "t-120", "T120", "T 120", "T - 120", " t-120 "]) {
    assert.deepEqual(leerCodigoBuscado(texto, "T"), { prefijo: "T", id: 120 }, texto);
    assert.equal(leerCodigoBuscado(texto, "TR"), null, texto);
  }
});

test("el «#n» del staff es un código sin prefijo en cualquier listado", () => {
  assert.deepEqual(leerCodigoBuscado("#120", "T"), { prefijo: null, id: 120 });
  assert.deepEqual(leerCodigoBuscado("# 120", ["TR"]), { prefijo: null, id: 120 });
});

test("un prefijo de otro módulo no es un código del listado", () => {
  assert.equal(leerCodigoBuscado("TR-120", "T"), null);
  assert.deepEqual(leerCodigoBuscado("TR-120", "TR"), { prefijo: "TR", id: 120 });
  assert.deepEqual(leerCodigoBuscado("tr12", ["T", "C", "TR", "B", "K"]), { prefijo: "TR", id: 12 });
  assert.deepEqual(leerCodigoBuscado("c 22", ["T", "C"]), { prefijo: "C", id: 22 });
  assert.equal(leerCodigoBuscado("FC-12", ["T", "C"]), null);
});

test("el número solo y el texto libre no son códigos: siguen siendo búsqueda amplia", () => {
  for (const texto of ["120", "Torres 3", "T-", "#", "T#120", "T-12a", "40.759.125", "", "   ", null, undefined]) {
    assert.equal(leerCodigoBuscado(texto, "T"), null, String(texto));
  }
});

test("acepta los guiones tipográficos que llegan al copiar el ejemplo de la guía", () => {
  for (const guion of ["‐", "‑", "‒", "–", "—", "−"]) {
    assert.deepEqual(leerCodigoBuscado(`T${guion}120`, "T"), { prefijo: "T", id: 120 }, `U+${guion.charCodeAt(0).toString(16)}`);
  }
});

test("sólo devuelve ids enteros positivos", () => {
  assert.equal(leerCodigoBuscado("T-0", "T"), null);
  assert.equal(leerCodigoBuscado("T-12345678901", "T"), null);
  assert.deepEqual(leerCodigoBuscado("T-007", "T"), { prefijo: "T", id: 7 });
});
