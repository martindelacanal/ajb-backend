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

test("un grupo retira un respaldo y los tres restantes relevan al servidor tras cambiar de IP sin perder la última escritura", {
  skip: !ejecutable, timeout: 120000,
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
      alReiniciar: () => { n.reiniciar = true; }, log: mensaje => { logs.push(mensaje); if (logs.length > 40) logs.shift(); } });
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
  async function lider() {
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
      if (activos.length === 1) return activos[0];
      await esperar(100);
    }
    throw new Error("El grupo no eligió un escritor: " + logs.join("\n"));
  }
  const escribir = (n, valor) => n.db.tx(t => t.run("INSERT INTO predio_config(predio_id,id,clave,valor) VALUES(1,1,'ultima_venta',?) ON CONFLICT(predio_id,id) DO UPDATE SET valor=excluded.valor", [String(valor)]));
  const leer = n => n.db.conexion.prepare("SELECT valor FROM predio_config WHERE clave='ultima_venta'").get()?.valor;
  const activo = await lider();
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
  const primero = await lider();
  assert.equal(leer(primero), "101");
  await escribir(primero, 102);
  primero.disponible = false; primero.servicio.detener();
  const segundo = await lider();
  assert.notEqual(segundo.id, primero.id);
  assert.equal(leer(segundo), "102");
  const caja = nodos.find(n => n !== primero && n !== segundo);
  assert.deepEqual(await (await fetch(caja.url + "/api/estado-publico")).json(), { equipo: segundo.id });
  await escribir(segundo, 202);
  caja.disponible = false; caja.servicio.detener();
  await assert.rejects(escribir(segundo, 303));
  assert.equal(segundo.servicio.estado().escritor, false);
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
