"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function almacenamiento(mapa = new Map()) {
  return { mapa, fallarLectura: 0, fallarEscritura: false, perderEscritura: false, fallarBorrado: false, perderBorrado: false,
    fallarLecturaTrasBorrado: false, fallarRestauracion: false, borradoRealizado: false,
    getItem(k) {
      if (k.startsWith("predio.operaciones.") && ((this.borradoRealizado && this.fallarLecturaTrasBorrado) || this.fallarLectura-- > 0)) throw new Error("Lectura bloqueada");
      return mapa.get(k) || null;
    },
    setItem(k, v) {
      const borrando = k.startsWith("predio.operaciones.") && v === "{}";
      if (this.fallarEscritura || (borrando && this.fallarBorrado) || (this.borradoRealizado && this.fallarRestauracion && !borrando)) throw new Error("Sin almacenamiento");
      if (!this.perderEscritura && !(borrando && this.perderBorrado)) { mapa.set(k, String(v)); if (borrando) this.borradoRealizado = true; }
    },
    removeItem(k) { mapa.delete(k); },
  };
}
function respuesta(status = 200, body = { id: 1 }) {
  return { status, ok: status >= 200 && status < 300, text: async () => typeof body === "string" ? body : JSON.stringify(body) };
}
function pantalla({ local = almacenamiento(), sesion = almacenamiento(), navegacion = "navigate", ha = true, remoto = false } = {}) {
  const solicitudes = [];
  let token = "token-cajero-personal", siguiente = async () => respuesta();
  const entorno = {
    window: { crypto: webcrypto, performance: { getEntriesByType: () => [{ type: navegacion }] } },
    localStorage: local, sessionStorage: sesion, Blob, ArrayBuffer,
    location: { hash: "", pathname: "/predios" }, history: { replaceState() {} },
    document: { documentElement: { getAttribute: k => k === "data-ha" ? (ha ? "1" : "0") : k === "data-predio" ? "MIRAMAR" : k === "data-modo" ? (remoto ? "remoto" : "local") : null }, addEventListener() {} },
    fetch: async (url, opciones) => { solicitudes.push({ url, ...opciones }); return siguiente(); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/nucleo.js"), "utf8"), entorno);
  const P = entorno.window.P;
  P.sesion.token = () => token;
  P.sesionVencida = () => {};
  return { P, local, sesion, solicitudes, responder: fn => { siguiente = fn; }, usuario: nuevo => { token = nuevo; },
    id: () => solicitudes.at(-1)?.headers["X-AJB-Operacion"] };
}
const sinRed = async () => { throw new Error("Respuesta perdida"); };

test("una respuesta perdida conserva el identificador hasta completar el mismo intento", async () => {
  const s = pantalla(); s.responder(sinRed);
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 0);
  const id = s.id(); assert.match(id, /^[a-f0-9]{32}$/);
  s.responder(async () => respuesta()); await s.P.post("/ventas", { total: 100 }); assert.equal(s.id(), id);
  await s.P.post("/ventas", { total: 100 }); assert.notEqual(s.id(), id, "un intento nuevo confirmado puede repetir legítimamente el importe");
});

test("la misma petición con propiedades JSON reordenadas conserva el identificador pendiente", async () => {
  const s = pantalla(); s.responder(sinRed);
  await assert.rejects(s.P.post("/ventas", { total: 100, items: [{ producto: 1, cantidad: 2 }] })); const id = s.id();
  await assert.rejects(s.P.post("/ventas", { items: [{ cantidad: 2, producto: 1 }], total: 100 })); assert.equal(s.id(), id);
});

test("dos pestañas y una pestaña duplicada nunca comparten una operación", async () => {
  const local = almacenamiento(), primera = pantalla({ local }); primera.responder(sinRed);
  await assert.rejects(primera.P.post("/ventas", { total: 100 }));
  const segunda = pantalla({ local }); segunda.responder(sinRed); await assert.rejects(segunda.P.post("/ventas", { total: 100 }));
  const duplicada = pantalla({ local, sesion: almacenamiento(new Map(primera.sesion.mapa)), navegacion: "navigate" }); duplicada.responder(sinRed);
  await assert.rejects(duplicada.P.post("/ventas", { total: 100 }));
  assert.equal(new Set([primera.id(), segunda.id(), duplicada.id()]).size, 3);
});

test("recargar la misma pestaña recupera el intento pero otro usuario queda aislado", async () => {
  const primera = pantalla(); primera.responder(sinRed); await assert.rejects(primera.P.post("/ventas", { total: 100 }));
  const recarga = pantalla({ local: primera.local, sesion: primera.sesion, navegacion: "reload" }); recarga.responder(sinRed);
  await assert.rejects(recarga.P.post("/ventas", { total: 100 })); assert.equal(recarga.id(), primera.id());
  recarga.usuario("token-otro-cajero"); await assert.rejects(recarga.P.post("/ventas", { total: 100 })); assert.notEqual(recarga.id(), primera.id());
});

test("un error 500 conserva el identificador y un rechazo 4xx confirmado termina ese intento", async () => {
  const s = pantalla(); s.responder(async () => respuesta(500, { mensaje: "Fallo temporal" }));
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 500); const id = s.id();
  s.responder(async () => respuesta(409, { mensaje: "Validación rechazada" }));
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 409); assert.equal(s.id(), id);
  s.responder(async () => respuesta()); await s.P.post("/ventas", { total: 100 }); assert.notEqual(s.id(), id);
});

test("una respuesta 2xx que no contiene JSON conserva la operación como incierta", async () => {
  const s = pantalla(); s.responder(async () => respuesta(200, "<html>respuesta interrumpida</html>"));
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.codigo === "RESULTADO_INCIERTO"); const id = s.id();
  s.responder(async () => respuesta()); await s.P.post("/ventas", { total: 100 }); assert.equal(s.id(), id);
});

test("fallar o corromper la lectura de pendientes bloquea el envío en lugar de reemplazar su identificador", async () => {
  const s = pantalla(); s.responder(sinRed); await assert.rejects(s.P.post("/ventas", { total: 100 }));
  const cantidad = s.solicitudes.length;
  s.local.fallarLectura = 1;
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 409);
  assert.equal(s.solicitudes.length, cantidad);
  const clave = [...s.local.mapa.keys()].find(k => k.startsWith("predio.operaciones.")); s.local.mapa.set(clave, "JSON roto");
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 409); assert.equal(s.solicitudes.length, cantidad);
});

test("un fallo de sessionStorage no queda cacheado ni permite un segundo POST", async () => {
  const sesion = almacenamiento(); sesion.fallarEscritura = true;
  const s = pantalla({ sesion });
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 409);
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 409);
  assert.equal(s.solicitudes.length, 0);
});

test("si el navegador descarta silenciosamente el identificador de pestaña tampoco se envía el negocio", async () => {
  const sesion = almacenamiento(); sesion.perderEscritura = true;
  const s = pantalla({ sesion }); await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 409);
  assert.equal(s.solicitudes.length, 0);
});

test("sin persistencia local de la operación falla antes de fetch y sólo guarda huellas e IDs", async () => {
  const s = pantalla(); s.local.fallarEscritura = true;
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 409); assert.equal(s.solicitudes.length, 0);
  s.local.fallarEscritura = false; s.responder(sinRed);
  await assert.rejects(s.P.post("/sesion/clave", { actual: "clave-muy-privada", nueva: "otra-clave-privada", documento: "DNI-no-guardar" }));
  const persistido = JSON.stringify([...s.local.mapa, ...s.sesion.mapa]);
  for (const secreto of ["token-cajero-personal", "clave-muy-privada", "otra-clave-privada", "DNI-no-guardar"]) assert.equal(persistido.includes(secreto), false, secreto);
  assert.match(s.id(), /^[a-f0-9]{32}$/);
});

test("GET, operaciones de Sistema y modo de una PC conservan el contrato sin identificadores HA", async () => {
  const s = pantalla(); await s.P.get("/productos"); assert.equal(s.id(), undefined);
  await s.P.post("/sistema/grupo-local/activar", {}); assert.equal(s.id(), undefined);
  const simple = pantalla({ ha: false }); await simple.P.post("/ventas", { total: 100 }); assert.equal(simple.id(), undefined);
  const remoto = pantalla({ remoto: true }); await remoto.P.post("/ventas", { total: 100 }); assert.equal(remoto.id(), undefined);
});

test("si falla guardar la confirmación no da éxito normal y una recarga consulta el mismo resultado", async () => {
  for (const fallo of ["fallarBorrado", "perderBorrado"]) {
    const s = pantalla(); s.local[fallo] = true;
    await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.codigo === "RESULTADO_INCIERTO");
    const id = s.id();
    const clave = [...s.local.mapa.keys()].find(k => k.startsWith("predio.operaciones."));
    assert.equal(Object.values(JSON.parse(s.local.mapa.get(clave)))[0], id);
    s.local[fallo] = false;
    const recarga = pantalla({ local: s.local, sesion: s.sesion, navegacion: "reload" });
    await recarga.P.post("/ventas", { total: 100 }); assert.equal(recarga.id(), id);
    await recarga.P.post("/ventas", { total: 100 }); assert.notEqual(recarga.id(), id);
  }
});

test("si se borró el ID pero fallan la lectura y su restauración, la pestaña bloquea nuevos envíos aun si vuelve el almacenamiento", async () => {
  const s = pantalla(); s.local.fallarLecturaTrasBorrado = true; s.local.fallarRestauracion = true;
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.codigo === "RESULTADO_INCIERTO");
  const clave = [...s.local.mapa.keys()].find(k => k.startsWith("predio.operaciones."));
  assert.equal(s.local.mapa.get(clave), "{}", "el borrado llegó al almacenamiento y el identificador ya no pudo reinsertarse");
  s.local.fallarLecturaTrasBorrado = false; s.local.fallarRestauracion = false;
  const cantidad = s.solicitudes.length;
  await assert.rejects(s.P.post("/ventas", { total: 100 }), e => e.status === 409 && e.codigo === "CONFIRMACION_PENDIENTE_REVISION" && /verificá su resultado/.test(e.message));
  await assert.rejects(s.P.post("/ventas", { total: 200 }), e => e.codigo === "CONFIRMACION_PENDIENTE_REVISION");
  assert.equal(s.solicitudes.length, cantidad, "no se genera ni envía una intención nueva en esa pestaña");
  await s.P.get("/ventas"); assert.equal(s.solicitudes.length, cantidad + 1, "se permite consultar el resultado para revisarlo");
});
