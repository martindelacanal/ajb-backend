"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { esNavegacion, paginaRecuperacion } = require("../lib/pantalla-recuperacion-lan");

test("la espera del navegador no intercepta API, ventas ni archivos de la aplicación", () => {
  assert.equal(esNavegacion({ method: "GET", headers: {} }, "/"), true);
  assert.equal(esNavegacion({ method: "GET", headers: { accept: "text/html" } }, "/sistema"), true);
  for (const ruta of ["/", "/api", "/api/ventas"]) {
    assert.equal(esNavegacion({ method: "POST", headers: { accept: "text/html" } }, ruta), false);
  }
  for (const ruta of ["/api", "/api/estado-publico"]) {
    assert.equal(esNavegacion({ method: "GET", headers: { accept: "text/html" } }, ruta), false);
  }
  assert.equal(esNavegacion({ method: "GET", headers: { accept: "*/*" } }, "/js/app.js"), false);
});

test("el diagnóstico escapa el error y diferencia la copia local de una revisión acreditada por el grupo", () => {
  const html = paginaRecuperacion({ estado: { confirmada: { indice: 42 }, token: "secreto-de-prueba" }, mensaje: '<script>alert("x")</script>' });
  assert.match(html, /http-equiv="refresh" content="5"/);
  assert.match(html, /Reintentar ahora/);
  assert.match(html, /guarda la revisión 42/);
  assert.match(html, /debe verificar que sea la más reciente/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|secreto-de-prueba|Última copia confirmada/);
  assert.match(paginaRecuperacion({ estado: { testigo: { solo_principal: true } } }), /notebook como único servidor/);
  assert.match(paginaRecuperacion({ estado: { testigo: { votantes: ["a", "b", "c"] } } }), /al menos 2 PCs/);
  assert.match(paginaRecuperacion(), /todavía no pudo verificar qué copia/);
});
