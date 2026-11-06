"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
function pantalla({ modo = "remoto", referrer = "https://miajbpruebas.com.ar/mi-predio" } = {}) {
  const datos = new Map(), mensajes = [], padre = { postMessage: (...args) => mensajes.push(args) }, listeners = {};
  const storage = { getItem: k => datos.get(k) || null, setItem: (k, v) => datos.set(k, v), removeItem: k => datos.delete(k) };
  const window = { parent: padre, addEventListener: (n, f) => { listeners[n] = f; } };
  const contexto = { window, document: { referrer, documentElement: { getAttribute: n => n === "data-modo" ? modo : n === "data-predio" ? "MIRAMAR" : null }, addEventListener() {} },
    location: { hash: "", pathname: "/predios-app/MIRAMAR/" }, history: { replaceState() {} }, URL, Blob, ArrayBuffer, localStorage: storage, sessionStorage: storage };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/nucleo.js"), "utf8"), contexto);
  const P = window.P; P.sesion.guardar("anterior", false);
  return { P, padre, mensajes, responder: fn => { contexto.fetch = fn; }, enviar: cambios => listeners.message?.({ source: padre, origin: "https://miajbpruebas.com.ar", data: { tipo: "AJB_PREDIO_SESION", codigo: "MIRAMAR", token: "renovado" }, ...cambios }) };
}
test("el padre renueva la credencial del mismo predio sin recargar la pantalla ni perder datos del formulario", () => {
  const s = pantalla(); let cambios = 0; s.P.alRenovarSesionRemota = () => cambios++;
  s.P.estado = { formulario: { nombre: "Edición pendiente" } }; s.enviar({});
  assert.equal(s.P.sesion.token(), "renovado"); assert.equal(cambios, 1); assert.equal(s.P.estado.formulario.nombre, "Edición pendiente");
});
test("otro origen, ventana, predio, tipo o credencial inválida no reemplazan la sesión", () => {
  for (const cambio of [{ source: {} }, { origin: "https://otro.example" }, { data: { tipo: "AJB_PREDIO_SESION", codigo: "OTRO", token: "ataque" } },
    { data: { tipo: "OTRO", codigo: "MIRAMAR", token: "ataque" } }, { data: { tipo: "AJB_PREDIO_SESION", codigo: "MIRAMAR", token: "x".repeat(17000) } }, { data: null }]) {
    const s = pantalla(); s.enviar(cambio); assert.equal(s.P.sesion.token(), "anterior");
  }
});
test("la pantalla local y un iframe sin origen conocido no aceptan mensajes de credenciales", () => {
  for (const opciones of [{ modo: "local" }, { referrer: "" }, { referrer: "file:///privado" }]) {
    const s = pantalla(opciones); s.enviar({}); assert.equal(s.P.sesion.token(), "anterior");
  }
});
test("cerrar dentro del iframe avisa únicamente al padre conocido y deja de aceptar renovaciones", () => {
  const s = pantalla(); s.P.notificarCierreRemoto();
  assert.equal(s.mensajes.length, 1); assert.equal(s.mensajes[0][0].tipo, "AJB_PREDIO_CERRAR");
  assert.equal(s.mensajes[0][0].codigo, "MIRAMAR"); assert.equal(s.mensajes[0][1], "https://miajbpruebas.com.ar");
  s.P.sesion.borrar(); s.enviar({}); assert.equal(s.P.sesion.token(), null);
});
test("un 401 antiguo no cierra la credencial que el padre ya renovó y sólo reintenta una vez", async () => {
  for (const metodo of ["GET", "POST"]) {
    const s = pantalla(); let llamadas = 0, cierres = 0; s.P.sesionVencida = () => cierres++;
    s.responder(async (_url, opciones) => {
      llamadas++;
      if (llamadas === 1) { assert.equal(opciones.headers.Authorization, "Bearer anterior"); s.enviar({}); return { status: 401 }; }
      assert.equal(opciones.headers.Authorization, "Bearer renovado"); return { status: 200, ok: true, text: async () => '{"id":99}' };
    });
    const resultado = await s.P.api(metodo, "/productos", metodo === "POST" ? { nombre: "Nuevo" } : null);
    assert.equal(resultado.id, 99); assert.equal(llamadas, 2); assert.equal(cierres, 0);
  }
});
