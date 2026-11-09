"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { crearVerificador } = require("../lib/protocolo-lan");
const H = require("../lib/http-lan");

const opciones = { grupoId: "grupo_reloj", nodoId: "equipoA", clave: "a".repeat(64), cuerpo: { venta: 123 } };
async function servidor(t, { desfase = 0, alterar, perderRespuesta = false, antiguo = false } = {}) {
  const recibidas = [];
  let operaciones = 0;
  const verificar = crearVerificador({ grupoId: opciones.grupoId, miembros: [{ id: opciones.nodoId, clave: opciones.clave }],
    ahora: () => Date.now() + desfase });
  const s = http.createServer(async (req, res) => {
    const cuerpo = await H.leer(req);
    recibidas.push({ metodo: req.method, ruta: req.url, cuerpo, cabeceras: req.headers });
    try {
      verificar({ metodo: req.method, ruta: req.url, cuerpo, cabeceras: req.headers });
      operaciones++;
      if (perderRespuesta) return res.destroy();
      H.respuesta(res, 200, { operaciones });
    } catch (e) {
      if (alterar) alterar(e);
      if (antiguo) H.respuesta(res, 403, { mensaje: "La petición LAN no está autenticada o venció" });
      else H.respuestaError(res, e);
    }
  });
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(async () => { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); });
  return { url: "http://127.0.0.1:" + s.address().port, recibidas, operaciones: () => operaciones };
}

test("una petición con reloj adelantado o atrasado se ajusta con rechazo firmado y se ejecuta una sola vez", async t => {
  for (const desfase of [-39000, 39000, 86400000]) await t.test(String(desfase), async sub => {
    const s = await servidor(sub, { desfase });
    assert.deepEqual(await H.pedir(s.url, "/venta", opciones), { operaciones: 1 });
    assert.equal(s.recibidas.length, 2);
    assert.notEqual(s.recibidas[0].cabeceras["x-ajb-nonce"], s.recibidas[1].cabeceras["x-ajb-nonce"]);
    assert.equal(s.recibidas[0].cuerpo.toString(), s.recibidas[1].cuerpo.toString());
    const repetida = await fetch(s.url + "/venta", { method: "POST", headers: s.recibidas[1].cabeceras, body: s.recibidas[1].cuerpo });
    assert.equal(repetida.status, 403);
    assert.match((await repetida.json()).mensaje, /ya fue utilizada/);
    assert.equal(s.operaciones(), 1);
  });
});

test("una firma inválida, un rechazo adulterado o de otro nonce nunca habilitan el reintento", async t => {
  for (const tipo of ["clave", "firma", "nonce"]) await t.test(tipo, async sub => {
    const s = await servidor(sub, { desfase: 39000, alterar: e => {
      if (tipo === "firma" && e.relojLan) e.relojLan.firma = "0".repeat(64);
      if (tipo === "nonce" && e.relojLan) e.relojLan.datos.nonce = "1".repeat(48);
    } });
    await assert.rejects(H.pedir(s.url, "/venta", { ...opciones, ...(tipo === "clave" ? { clave: "b".repeat(64) } : {}) }));
    assert.equal(s.recibidas.length, 1);
    assert.equal(s.operaciones(), 0);
  });
});

test("un peer antiguo conserva el rechazo y una respuesta perdida jamás repite la venta", async t => {
  const antiguo = await servidor(t, { desfase: 39000, antiguo: true });
  await assert.rejects(H.pedir(antiguo.url, "/venta", opciones), /venció/);
  assert.equal(antiguo.recibidas.length, 1);
  for (const desfase of [0, 39000]) {
    const perdido = await servidor(t, { perderRespuesta: true, desfase });
    await assert.rejects(H.pedir(perdido.url, "/venta", opciones));
    assert.equal(perdido.recibidas.length, desfase ? 2 : 1);
    assert.equal(perdido.operaciones(), 1);
  }
});
