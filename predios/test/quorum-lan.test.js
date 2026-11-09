"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { setTimeout: esperar } = require("node:timers/promises");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const { crearSnapshotDirecta, aplicarPendiente } = require("../lib/respaldo-lan");
const { crearServicioLan } = require("../lib/servicio-lan");
const { respuesta } = require("../lib/http-lan");
const { iniciarConsenso } = require("../lib/quorum-lan");

const dirApp = path.join(__dirname, "..");
const ejecutable = process.platform === "win32" && fs.existsSync(path.join(dirApp, "windows", "ajb-quorum.exe"));

async function escuchar(s, ip = "127.0.0.1", puerto = 0) {
  await new Promise(resolve => s.listen(puerto, ip, resolve));
  return s.address().port;
}
async function cerrar(s) {
  if (s.listening) await new Promise(resolve => { s.close(resolve); s.closeAllConnections(); });
}

test("el grupo recupera el apagado total, releva tras cambiar las IP y reactiva los respaldos actualizados", {
  skip: !ejecutable, timeout: 150000,
}, async t => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-quorum-"));
  const grupoId = "quorum_fixture", claveDatos = "f".repeat(64), secreto = "e".repeat(64);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const clavePrivada = privateKey.export({ type: "pkcs8", format: "pem" });
  const clavePublicaTestigo = publicKey.export({ type: "spki", format: "pem" });
  const nodos = [], logs = [];
  let redNueva = false;
  const ubicacion = {
    equipo(id) {
      const nodo = redNueva && nodos.find(n => n.id === id && n.disponible);
      return nodo && { ip: nodo.ip, https: nodo.http.address().port };
    },
    direccionesRaft() {
      return redNueva ? Object.fromEntries(nodos.filter(n => n.disponible).map(n => [n.id, `${n.ip}:${n.puerto}`])) : {};
    },
  };
  t.after(async () => {
    for (const n of nodos) n.servicio?.detener();
    for (const n of nodos) { await cerrar(n.http); n.db?.cerrar(); }
    await esperar(300);
    fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 5 });
  });
  const abrirDB = n => {
    n.db = crearSqlite(path.join(n.base, "datos", "predio.db"), { predioId: 1 });
    asegurarEsquema(n.db);
  };
  const puertosReservados = [];
  for (const letra of ["a", "b", "c", "d"]) {
    const base = path.join(raiz, letra);
    fs.mkdirSync(path.join(base, "datos"), { recursive: true });
    const n = { id: letra.repeat(64), base, disponible: true, ip: `127.0.0.${nodos.length + 2}` };
    n.http = http.createServer(async (req, res) => {
      // El protocolo Raft entre los ejecutables usa TLS real. Aquí se
      // sustituye sólo el certificado HTTP del servidor de prueba.
      req.socket.encrypted = true;
      if (!n.disponible) return respuesta(res, 503, { mensaje: "PC desconectada" });
      if (n.sinRetorno && req.url === "/lan/retorno") {
        n.intentoRetorno = true;
        return respuesta(res, 404, { mensaje: "El respaldo todavía no se actualizó" });
      }
      if (n.escribirDuranteRetorno && req.url === "/lan/retorno") {
        n.ventasDuranteRetorno = (n.ventasDuranteRetorno || 0) + 1;
        await escribir(n, 203 + n.ventasDuranteRetorno);
      }
      if (n.sinCopia && req.method === "POST" && req.url === "/lan/replica") {
        n.intentoCopia = true;
        return respuesta(res, 503, { mensaje: "Copia todavía no disponible" });
      }
      if (!await n.servicio.manejar(req, res)) {
        if (!n.servicio.estado().escritor) return n.servicio.reenviar(req, res);
        respuesta(res, 200, { equipo: n.id });
      }
    });
    n.url = `http://${n.ip}:${await escuchar(n.http, n.ip)}`;
    const reservado = http.createServer();
    n.puerto = await escuchar(reservado);
    puertosReservados.push(reservado);
    abrirDB(n);
    nodos.push(n);
  }
  await Promise.all(puertosReservados.map(cerrar));
  const miembros = nodos.map((n, i) => ({ id: n.id, nombre: `PC ${i + 1}`, url: n.url, clave: String(i + 1).repeat(64), preferido: i === 0 }));
  const bootstrap = nodos.map(n => ({ id: n.id, address: `${n.ip}:${n.puerto}` }));
  for (const [i, n] of nodos.entries()) {
    n.ha = { habilitado: true, grupoId, equipoId: n.id, nodoId: n.id, rolInstalacion: i ? "Respaldo" : "Principal",
      clave: miembros[i].clave, claveDatos, clavePublicaTestigo, permitirDegradado: false, miembros: miembros.map(({ clave, ...m }) => m),
      quorumPendiente: true };
    n.config = { predio_id: 1, respaldo_lan: n.ha };
  }
  const semilla = crearSnapshotDirecta({ db: nodos[0].db, base: nodos[0].base, config: nodos[0].config, indice: 0 });
  const ultimo = { indice: 0, sha256: semilla.manifest.sha256 };
  const inicial = { grupoId, termino: 0, miembros, ultimo, preferidoId: nodos[0].id };
  const abrir = n => {
    n.servicio = crearServicioLan({ base: n.base, dirApp, config: n.config, db: n.db, ha: n.ha, ubicarGrupo: () => ubicacion,
      alReiniciar: () => { n.reiniciar = true; n.reinicios = (n.reinicios || 0) + 1; },
      log: mensaje => { logs.push(mensaje); if (logs.length > 40) logs.shift(); } });
  };
  for (const [i, n] of nodos.entries()) {
    abrir(n);
    if (i === 0) n.servicio.registrarInicial(semilla);
    else await n.servicio.recibirInicial(semilla, { remitenteId: nodos[0].id });
    n.servicio.detener(); n.db.cerrar();
    delete n.ha.quorumPendiente;
    n.ha.quorum = { puerto: n.puerto, direccion: bootstrap[i].address, secreto, clavePrivada, bootstrap, inicial };
    aplicarPendiente({ base: n.base, config: n.config });
    abrirDB(n); abrir(n);
    n.db.configurarTransacciones(n.servicio);
    n.servicio.iniciar().catch(e => logs.push(e.message));
  }
  async function lider(esperado) {
    const limite = Date.now() + 32000;
    while (Date.now() < limite) {
      for (const n of nodos.filter(n => n.disponible && n.reiniciar)) {
        n.reiniciar = false;
        n.servicio.detener();
        await n.db.exclusivo(() => {});
        n.db.cerrar();
        aplicarPendiente({ base: n.base, config: n.config });
        abrirDB(n); abrir(n);
        n.db.configurarTransacciones(n.servicio);
        n.servicio.iniciar().catch(e => logs.push(e.message));
      }
      const activos = nodos.filter(n => n.disponible && n.servicio.estado().escritor);
      assert.ok(activos.length <= 1, "la mayoría habilita a un solo escritor");
      const activo = activos[0];
      if (activo && (!esperado || activo === esperado)) {
        // El servicio ya puede estar publicando su aviso de activación. Esperar
        // a que termine esa escritura antes de simular la siguiente venta.
        await new Promise(setImmediate);
        await activo.db.exclusivo(() => {});
        if (activo.servicio.estado().escritor) return activo;
      }
      await esperar(100);
    }
    throw new Error("El grupo no eligió un escritor: " + logs.join("\n"));
  }
  const escribir = (n, valor) => n.db.tx(t => t.run("INSERT INTO predio_config(predio_id,id,clave,valor) VALUES(1,1,'ultima_venta',?) ON CONFLICT(predio_id,id) DO UPDATE SET valor=excluded.valor", [String(valor)]))
    .catch(e => { e.message += "\n" + logs.slice(-12).join("\n"); throw e; });
  const leer = n => n.db.conexion.prepare("SELECT valor FROM predio_config WHERE clave='ultima_venta'").get()?.valor;
  async function comprobarAcceso(desde, escritor) {
    for (const limite = Date.now() + 10000; Date.now() < limite;) {
      const r = await fetch(desde.url + "/api/estado-publico", { signal: AbortSignal.timeout(5000) });
      const datos = await r.json();
      if (r.ok) { assert.deepEqual(datos, { equipo: escritor.id }); return; }
      // Un sondeo puede coincidir con la renovación del permiso tras la
      // elección. Debe esperar, nunca responder con otro servidor.
      assert.equal(r.status, 503);
      assert.equal(datos.codigo, "SERVIDOR_CAMBIANDO");
      await esperar(150);
    }
    assert.fail("El acceso de caja no encontró al escritor " + escritor.id);
  }
  const principal = nodos[0];
  const activo = await lider(principal);
  await escribir(activo, 101);
  const baja = nodos.find(n => n !== activo && n.id !== inicial.preferidoId);
  baja.disponible = false;
  baja.servicio.detener();
  await activo.servicio.retirarQuorum(baja.id);
  const registro = await activo.servicio.consultarQuorum();
  assert.ok(registro.retirados.includes(baja.id));
  assert.equal(registro.miembros.some(m => m.id === baja.id), false);
  const otro = nodos.find(n => n.disponible && n !== activo && n.id !== inicial.preferidoId);
  await assert.rejects(activo.servicio.revisarRetiro(otro.id), /tres votantes/);
  await cerrar(baja.http);
  baja.db.cerrar();
  nodos.splice(nodos.indexOf(baja), 1);
  const anteriores = nodos.map(n => ({ ip: n.ip, http: n.http.address().port, raft: n.puerto }));
  await Promise.all(nodos.map(async n => {
    n.servicio.detener();
    await cerrar(n.http);
    await n.db.exclusivo(() => {});
    n.db.cerrar();
  }));
  await esperar(500);
  for (const [i, n] of nodos.entries()) {
    // El router entrega las IP a otros miembros. Cada configuración
    // guardada conserva las direcciones y el diario de la primera elección.
    const asignada = anteriores[(i + 1) % nodos.length];
    n.ip = asignada.ip;
    n.url = `http://${n.ip}:${await escuchar(n.http, n.ip, asignada.http)}`;
    n.ha.quorum.puerto = n.puerto = asignada.raft;
    n.reiniciar = false;
    aplicarPendiente({ base: n.base, config: n.config });
    abrirDB(n); abrir(n);
    n.db.configurarTransacciones(n.servicio);
    n.servicio.iniciar().catch(e => logs.push(e.message));
  }
  await esperar(3000);
  assert.ok(nodos.every(n => !n.servicio.estado().escritor), "las IP anteriores en otras PCs no acreditan su identidad");
  redNueva = true;
  const primero = await lider(principal);
  assert.equal(leer(primero), "101");
  await escribir(primero, 102);
  primero.disponible = false; primero.servicio.detener();
  const segundo = await lider();
  assert.notEqual(segundo.id, primero.id);
  assert.equal(leer(segundo), "102");
  const caja = nodos.find(n => n !== primero && n !== segundo);
  await comprobarAcceso(caja, segundo);
  await escribir(segundo, 202);
  assert.equal(leer(principal), "102");
  const reiniciosPrevios = principal.reinicios;
  segundo.sinRetorno = true;
  await principal.db.exclusivo(() => {});
  principal.db.cerrar();
  aplicarPendiente({ base: principal.base, config: principal.config });
  abrirDB(principal); abrir(principal);
  principal.db.configurarTransacciones(principal.servicio);
  principal.disponible = true;
  principal.servicio.iniciar().catch(e => logs.push(e.message));
  for (const limite = Date.now() + 12000; !segundo.intentoRetorno && Date.now() < limite;) await esperar(100);
  assert.equal(segundo.intentoRetorno, true);
  assert.equal(segundo.servicio.estado().escritor, true, "un respaldo todavía sin actualizar sigue en servicio");
  await escribir(segundo, 203);
  segundo.escribirDuranteRetorno = true;
  segundo.sinRetorno = false;
  assert.equal(await lider(principal), principal);
  assert.equal(principal.reinicios, reiniciosPrevios, "recupera la copia sin perder su elección al reiniciar");
  assert.ok(segundo.ventasDuranteRetorno > 0);
  assert.equal(leer(principal), String(203 + segundo.ventasDuranteRetorno));
  segundo.escribirDuranteRetorno = false;
  await comprobarAcceso(segundo, principal);
  await escribir(principal, 204);
  async function configurarModo(activo) {
    let ultimoError;
    for (const limite = Date.now() + 10000; Date.now() < limite;) {
      try { return await principal.servicio.configurarSoloPrincipal(activo); }
      catch (e) { ultimoError = e; await esperar(200); }
    }
    throw ultimoError;
  }
  assert.deepEqual(await configurarModo(true), { soloPrincipal: true });
  const modoSolo = await principal.servicio.consultarQuorum();
  assert.equal(modoSolo.solo_principal, true);
  assert.equal(modoSolo.regreso_automatico, true);
  assert.deepEqual(modoSolo.votantes, [principal.id]);
  const sondearRegreso = () => principal.servicio.promoverQuorum({ quorum: {}, miembros }, async () => []);
  await sondearRegreso();
  assert.equal((await principal.servicio.consultarQuorum()).solo_principal, true, "no reactivar antes de apagar los respaldos");
  caja.disponible = false; caja.servicio.detener();
  segundo.disponible = false; segundo.servicio.detener();
  await escribir(principal, 205);
  await assert.rejects(principal.servicio.configurarSoloPrincipal(false), /Encendé/);
  // Incluso tras reiniciar la notebook sola, el grupo conserva su decisión y
  // la venta que se confirmó sin respaldos conectados.
  principal.servicio.detener();
  await principal.db.exclusivo(() => {});
  principal.db.cerrar();
  aplicarPendiente({ base: principal.base, config: principal.config });
  abrirDB(principal); abrir(principal);
  principal.db.configurarTransacciones(principal.servicio);
  principal.servicio.iniciar().catch(e => logs.push(e.message));
  await lider(principal);
  assert.equal(leer(principal), "205");
  await escribir(principal, 206);
  async function volver(n) {
    await n.db.exclusivo(() => {});
    n.db.cerrar();
    aplicarPendiente({ base: n.base, config: n.config });
    abrirDB(n); abrir(n);
    n.db.configurarTransacciones(n.servicio);
    n.disponible = true;
    n.servicio.iniciar().catch(e => logs.push(e.message));
  }
  await volver(caja);
  await sondearRegreso();
  assert.equal((await principal.servicio.consultarQuorum()).solo_principal, true, "un respaldo encendido todavía no basta");
  segundo.sinCopia = true;
  await volver(segundo);
  async function sondearHasta(condicion) {
    for (const limite = Date.now() + 12000; Date.now() < limite;) {
      await sondearRegreso();
      if (await condicion()) return;
      await esperar(250);
    }
    assert.fail("El relevo no avanzó: " + logs.join("\n"));
  }
  await sondearHasta(() => segundo.intentoCopia);
  assert.equal((await principal.servicio.consultarQuorum()).solo_principal, true, "sin la última copia no se reactiva");
  segundo.sinCopia = false;
  await sondearHasta(async () => !(await principal.servicio.consultarQuorum()).solo_principal);
  const modoNormal = await principal.servicio.consultarQuorum();
  assert.equal(modoNormal.solo_principal, false);
  assert.equal(modoNormal.votantes.length, 3);
  // Corte total: desaparecen los tres procesos y luego vuelven sólo los dos
  // respaldos. Deben elegir con el registro durable, sin necesitar que la
  // notebook esté encendida ni promover un respaldo que todavía está solo.
  for (const n of nodos) { n.disponible = false; n.servicio.detener(); }
  await esperar(500);
  await volver(principal);
  await esperar(6000);
  assert.equal(principal.servicio.estado().escritor, false, "en modo normal la notebook sola espera mayoría; sólo el modo preparado permite operar sola");
  await assert.rejects(escribir(principal, 998));
  principal.disponible = false; principal.servicio.detener();
  await esperar(500);
  await volver(caja);
  await esperar(6000);
  assert.equal(caja.servicio.estado().escritor, false, "un respaldo solo no se activa automáticamente después del apagón");
  await assert.rejects(escribir(caja, 999));
  await volver(segundo);
  const despuesDelApagon = await lider();
  assert.notEqual(despuesDelApagon, principal);
  assert.equal(leer(despuesDelApagon), "206", "el arranque en frío conserva la última venta confirmada");
  await escribir(despuesDelApagon, 207);
  await comprobarAcceso(despuesDelApagon === caja ? segundo : caja, despuesDelApagon);
  await volver(principal);
  assert.equal(await lider(principal), principal);
  assert.equal(leer(principal), "207", "la notebook recupera la venta posterior al apagón antes de volver al servicio");
  principal.disponible = false; principal.servicio.detener();
  const respaldoActivo = await lider();
  assert.notEqual(respaldoActivo, principal);
  assert.equal(leer(respaldoActivo), "207", "un nuevo relevo conserva la última venta tras el regreso de la notebook");
  const otroRespaldo = respaldoActivo === caja ? segundo : caja;
  otroRespaldo.disponible = false; otroRespaldo.servicio.detener();
  await assert.rejects(escribir(respaldoActivo, 303));
  assert.equal(respaldoActivo.servicio.estado().escritor, false);
});

test("el coordinador incorpora un equipo como votante después de replicarle el registro", { skip: !ejecutable, timeout: 30000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-quorum-alta-"));
  const reservados = Array.from({ length: 4 }, () => http.createServer());
  const puertos = await Promise.all(reservados.map(s => escuchar(s)));
  await Promise.all(reservados.map(cerrar));
  const ids = ["a", "b", "c", "d"].map(s => s.repeat(64));
  const peers = ids.map((id, i) => ({ id, address: `127.0.0.1:${puertos[i]}` }));
  const nodos = peers.map((p, i) => iniciarConsenso({ base: path.join(base, p.id[0]), dirApp, log() {},
    config: { nodoId: p.id, quorum: { puerto: puertos[i], direccion: p.address, secreto: "e".repeat(64), bootstrap: i < 3 ? peers.slice(0, 3) : [] } } }));
  t.after(async () => {
    nodos.forEach(n => n.detener());
    await esperar(300);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  });
  let lider, estado;
  for (let i = 0; i < 50 && !lider; i++) {
    try {
      const elegido = await Promise.any(nodos.slice(0, 3).map(async n => ({ lider: n, estado: await n.pedir("/state") })));
      lider = elegido.lider;
      estado = elegido.estado;
    } catch (_e) { await esperar(100); }
  }
  assert.ok(lider);
  const escribir = e => ({ expected: e.register.version, term: e.term, configuration: e.configuration });
  const registro = await lider.pedir("/state", { ...escribir(estado), data: { revision: 42 } });
  estado = await lider.pedir("/state");
  await lider.pedir("/member", { ...escribir(estado), ...peers[3], voter: false });
  let local;
  for (let i = 0; i < 40; i++) {
    local = await nodos[3].pedir("/local");
    if (local.version === registro.version) break;
    await esperar(100);
  }
  assert.equal(local.version, registro.version);
  estado = await lider.pedir("/state");
  assert.notEqual(estado.members.find(m => m.ID === ids[3]).Suffrage, 0);
  await lider.pedir("/member", { ...escribir(estado), ...peers[3], voter: true });
  assert.equal((await lider.pedir("/state")).members.filter(m => m.Suffrage === 0).length, 4);
});
