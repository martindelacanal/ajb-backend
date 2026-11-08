"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const cp = require("node:child_process");
const { once } = require("node:events");
const { crearSqlite, asegurarEsquema, escribirMeta, leerMeta } = require("../lib/db-sqlite");
const { crearSnapshotDirecta, aplicarPendiente } = require("../lib/respaldo-lan");
const { crearServicioLan } = require("../lib/servicio-lan");
const { crearTestigo } = require("../lib/testigo-lan");
const { crearServidorTestigo } = require("../lib/servidor-testigo");
const { verificarEstadoFirmado } = require("../lib/protocolo-lan");
const { listarAvisos } = require("../lib/avisos");
const { bloquearInstalacion } = require("../lib/bloqueo-local");
const H = require("../lib/http-lan");

async function escuchar(servidor) {
  servidor.listen(0, "127.0.0.1"); await once(servidor, "listening");
  return `http://127.0.0.1:${servidor.address().port}`;
}
async function cerrar(servidor) {
  servidor.closeAllConnections?.();
  if (servidor.listening) await new Promise(resolve => servidor.close(resolve));
}
async function turno() { await new Promise(resolve => setImmediate(resolve)); }
async function esperar(fn, mensaje) {
  const hasta = Date.now() + 7000;
  while (!await fn()) { if (Date.now() > hasta) throw new Error(mensaje); await new Promise(resolve => setTimeout(resolve, 10)); }
}

async function grupoHttp(t) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "predio-http-lan-")), nodos = {}, activaciones = [], logs = [];
  const grupoId = "camping_http", claveDatos = "c".repeat(64), ids = { A: "a".repeat(64), B: "b".repeat(64) };
  let reloj = 0, arbitro, servidorTestigo;
  t.after(async () => {
    for (const n of Object.values(nodos)) n.servicio?.detener();
    await turno();
    for (const n of Object.values(nodos)) { await cerrar(n.http); n.db?.cerrar(); }
    if (servidorTestigo) await servidorTestigo.cerrar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  for (const id of ["A", "B"]) {
    const base = path.join(raiz, id); fs.mkdirSync(path.join(base, "datos"), { recursive: true });
    const n = nodos[id] = { id, base, disponible: true, recibidas: [] };
    n.http = http.createServer(async (req, res) => {
      if (!n.disponible) return H.respuesta(res, 503, { mensaje: "PC apagada" });
      if (!await n.servicio.manejar(req, res)) {
        n.recibidas.push({ ruta: req.url, cabeceras: req.headers, cuerpo: (await H.leer(req)).toString() });
        if (n.perderRespuesta) return res.destroy();
        H.respuesta(res, 200, { desde: n.id });
      }
    });
    n.url = await escuchar(n.http);
    n.db = crearSqlite(path.join(base, "datos", "predio.db"), { predioId: 1 }); asegurarEsquema(n.db);
    escribirMeta(n.db, "instancia_id", "instancia-conservada");
    escribirMeta(n.db, "equipo_propietario_id", ids[id]);
  }
  const miembros = [
    { id: ids.A, nombre: "PC Recepción", url: nodos.A.url, clave: "1".repeat(64), preferido: true },
    { id: ids.B, nombre: "PC Administración", url: nodos.B.url, clave: "2".repeat(64) },
  ];
  for (const n of Object.values(nodos)) {
    n.config = { predio_id: 1, predio_codigo: "CAMPING", token: "token-original" };
    n.ha = { habilitado: true, grupoId, equipoId: ids[n.id], nodoId: ids[n.id], rolInstalacion: n.id === "A" ? "Principal" : "Respaldo",
      clave: miembros.find(m => m.id === ids[n.id]).clave, claveDatos, permitirDegradado: true, miembros: miembros.map(({ clave, ...m }) => m),
      certificado: { datos: { formato: 1, grupoId, instanciaId: "instancia-conservada" }, firma: "certificado-de-prueba" } };
    n.config.respaldo_lan = n.ha;
  }
  const inicial = crearSnapshotDirecta({ db: nodos.A.db, base: nodos.A.base, config: nodos.A.config, indice: 0 });
  arbitro = crearTestigo({ base: path.join(raiz, "witness"), config: { grupoId, miembros, revisionInicial: inicial.manifest, permitirDegradado: true }, monotono: () => reloj });
  servidorTestigo = crearServidorTestigo({ base: raiz, config: { grupoId, claveAdministracion: "d".repeat(64) }, testigo: arbitro });
  const urlTestigo = await escuchar(servidorTestigo.servidor), pin = arbitro.estado().clave_publica;
  function abrirServicio(n) {
    n.ha.testigo = { url: urlTestigo }; n.ha.clavePublicaTestigo = pin;
    n.servicio = crearServicioLan({ base: n.base, config: n.config, db: n.db, ha: n.ha,
      alReiniciar: e => activaciones.push({ id: n.id, ...e }), log: m => logs.push({ id: n.id, mensaje: m }) });
  }
  abrirServicio(nodos.A); abrirServicio(nodos.B);
  nodos.A.servicio.registrarInicial(inicial);
  await nodos.A.servicio.transporte.replicar(miembros[1], inicial);
  async function reiniciar(id) {
    const n = nodos[id]; n.servicio.detener(); await turno(); n.db.cerrar();
    aplicarPendiente({ base: n.base, config: n.config });
    n.db = crearSqlite(path.join(n.base, "datos", "predio.db"), { predioId: 1 }); asegurarEsquema(n.db);
    abrirServicio(n); n.db.configurarTransacciones(n.servicio);
  }
  await reiniciar("B"); nodos.A.db.configurarTransacciones(nodos.A.servicio);
  reloj = 20001;
  async function avisos(id) {
    const n = nodos[id]; await turno(); await n.servicio.publicarAvisos();
    // Una transacción puede emitir otro aviso al reducir/restablecer redundancia.
    await turno(); await n.servicio.publicarAvisos();
    await n.db.exclusivo(() => {});
  }
  const valor = id => nodos[id].db.conexion.prepare("SELECT valor FROM predio_config WHERE clave='ultima_venta'").get()?.valor;
  const escribir = (id, valor) => nodos[id].db.tx(t => t.run("INSERT INTO predio_config(predio_id,id,clave,valor) VALUES(1,1,'ultima_venta',?) ON CONFLICT(predio_id,id) DO UPDATE SET valor=excluded.valor", [String(valor)]));
  return { nodos, miembros, ids, grupoId, pin, activaciones, logs, reiniciar, valor, escribir, avisos, arbitro,
    avanzar: ms => { reloj += ms; } };
}

test("HTTP real: relevo sin internet, escritura degradada y retorno del preferido con la última venta y avisos sólo administrativos", { timeout: 25000 }, async t => {
  const s = await grupoHttp(t), a = s.nodos.A, b = s.nodos.B;
  await a.servicio.sondear(); await s.avisos("A");
  assert.equal(a.servicio.estado().escritor, true);
  await s.escribir("A", 101);
  a.disponible = false; a.servicio.detener(); s.avanzar(15001);
  await b.servicio.sondear();
  assert.equal(s.activaciones.at(-1).id, "B");
  await s.reiniciar("B"); await b.servicio.sondear(); await s.avisos("B");
  assert.equal(b.servicio.estado().escritor, true);
  assert.equal(s.valor("B"), "101");
  await s.escribir("B", 202); await s.avisos("B");
  assert.equal(s.arbitro.estado().estado.degradado, true);
  const administrativos = await listarAvisos({ db: b.db, pid: 1, usuario: { id: 99, rol: "ADMIN" } });
  assert.ok(administrativos.some(n => n.tipo === "SERVIDOR_CAMBIO" && n.mensaje.includes("PC Administración")));
  assert.ok(administrativos.some(n => n.tipo === "SERVIDOR_RESPALDO" && n.mensaje.includes("PC Administración")));
  assert.deepEqual(await listarAvisos({ db: b.db, pid: 1, usuario: { id: 98, rol: "CAJERO" } }), []);
  // Sondear(A) conserva su mutex mientras B drena y envía la copia a A por HTTP.
  // La recepción nunca toma ese mutex: este await detecta la regresión de deadlock.
  await s.reiniciar("A"); a.disponible = true;
  await a.servicio.sondear();
  assert.equal(b.servicio.estado().escritor, false);
  await a.servicio.sondear();
  assert.equal(s.activaciones.at(-1).id, "A");
  await s.reiniciar("A"); await a.servicio.sondear(); await s.avisos("A");
  assert.equal(a.servicio.estado().escritor, true);
  assert.equal(s.valor("A"), "202");
  assert.equal(leerMeta(a.db, "instancia_id"), "instancia-conservada");
  assert.equal(leerMeta(a.db, "equipo_propietario_id"), s.ids.A);
  assert.equal(s.arbitro.estado().estado.degradado, false);
  const final = await listarAvisos({ db: a.db, pid: 1, usuario: { id: 99, rol: "ADMIN" } });
  assert.ok(final.some(n => n.titulo === "Servidor principal activo" && n.mensaje.includes("PC Recepción")));
});

test("la prueba central usa estado compacto fresco firmado por el PIN y conserva el roster completo para LAN", { timeout: 15000 }, async t => {
  const s = await grupoHttp(t), a = s.nodos.A;
  await a.servicio.sondear(); await s.avisos("A");
  const tercero = { id: "e".repeat(64), nombre: "Nuevo respaldo", url: "http://127.0.0.1:9", clave: "3".repeat(64) };
  const opciones = { grupoId: s.grupoId, nodoId: tercero.id, clave: a.ha.claveDatos, metodo: "GET" };
  await assert.rejects(H.pedir(a.url, "/lan/estado", opciones), /no está autenticada/);
  s.arbitro.actualizarMiembros([...s.miembros, tercero]);
  assert.equal((await H.pedir(a.url, "/lan/estado", opciones)).nodoId, s.ids.A, "el alta firmada se acepta sin reiniciar el servicio");
  await a.servicio.sondear();
  assert.equal(a.servicio.estado().miembros.length, 3);
  a.config.token = "token-renovado";
  const cabecera = await a.servicio.pruebaCentral(), prueba = JSON.parse(Buffer.from(cabecera, "base64").toString());
  assert.ok(cabecera.length < 16 * 1024);
  assert.deepEqual(prueba.certificado.datos, a.ha.certificado.datos);
  assert.equal(prueba.certificado.firma, crypto.createHmac("sha256", "token-renovado").update(JSON.stringify(a.ha.certificado.datos)).digest("hex"));
  assert.equal(a.ha.certificado.firma, "certificado-de-prueba");
  assert.equal(prueba.estadoFirmado.estado.compacto, true);
  assert.equal(prueba.estadoFirmado.estado.miembros, undefined);
  const estado = verificarEstadoFirmado(prueba.estadoFirmado, { clavePublica: s.pin, grupoId: s.grupoId, desafio: prueba.estadoFirmado.estado.desafio });
  assert.equal(estado.escritor.id, s.ids.A);
  assert.equal(a.servicio.estadoTestigo().miembros.length, 3, "la prueba compacta no elimina el roster cacheado");
  a.servicio.detener();
  await assert.rejects(a.servicio.pruebaCentral(), /no tiene el control/);
});

test("el proxy sólo dirige al escritor firmado, limpia cabeceras y nunca reintenta un POST con respuesta perdida", { timeout: 15000 }, async t => {
  const s = await grupoHttp(t), a = s.nodos.A, b = s.nodos.B;
  await a.servicio.sondear(); await s.avisos("A");
  const proxy = http.createServer((req, res) => b.servicio.reenviar(req, res));
  const origen = await escuchar(proxy); t.after(() => cerrar(proxy));
  const r = await fetch(origen + "/api/ventas", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-Host": "ajeno", Authorization: "Bearer sesion" }, body: '{"total":7}' });
  assert.equal(r.status, 200);
  assert.equal(a.recibidas.length, 1);
  assert.equal(a.recibidas[0].ruta, "/api/ventas");
  assert.equal(a.recibidas[0].cabeceras["x-forwarded-host"], undefined);
  assert.equal(a.recibidas[0].cabeceras.authorization, "Bearer sesion");
  assert.equal(a.recibidas[0].cuerpo, '{"total":7}');
  a.perderRespuesta = true;
  assert.equal((await fetch(origen + "/api/ventas", { method: "POST", body: "venta sin ACK" })).status, 503);
  assert.equal(a.recibidas.length, 2, "un fallo de respuesta no reproduce una operación financiera");
  let externas = 0;
  const externo = http.createServer((_req, res) => { externas++; res.end("otro origen"); });
  const fuera = await escuchar(externo); t.after(() => cerrar(externo));
  const estado = await new Promise((resolve, reject) => {
    const req = http.request(origen, { path: fuera + "/api/ventas", method: "GET" }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end();
  });
  assert.equal(estado, 503);
  assert.equal(externas, 0, "un request-target absoluto no puede cambiar el destino firmado");
});

test("el candado de instalación excluye otro proceso y el sistema operativo lo libera tras una caída", { timeout: 12000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "predio-lock-"));
  const modulo = require.resolve("../lib/bloqueo-local");
  const hijo = cp.spawn(process.execPath, ["-e", "require(process.argv[1]).bloquearInstalacion(process.argv[2]); process.stdout.write('listo\\n'); setInterval(()=>{},1000)", modulo, base], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(async () => { if (hijo.exitCode === null && hijo.signalCode === null) { hijo.kill(); await once(hijo, "exit"); } fs.rmSync(base, { recursive: true, force: true }); });
  let salida = ""; hijo.stdout.on("data", d => { salida += d; });
  await esperar(() => salida.includes("listo"), "El proceso que conserva el candado no inició");
  assert.throws(() => bloquearInstalacion(base), /Ya hay un servidor/);
  const finalizo = once(hijo, "exit"); hijo.kill(); await finalizo;
  const liberar = bloquearInstalacion(base);
  assert.throws(() => bloquearInstalacion(base), /Ya hay un servidor/);
  liberar(); liberar();
  bloquearInstalacion(base)();
});
