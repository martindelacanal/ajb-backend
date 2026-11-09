"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const { crearSqlite, asegurarEsquema, escribirMeta, leerMeta } = require("../lib/db-sqlite");
const { crearRespaldoLan, crearSnapshotDirecta, aplicarPendiente, MODELO_ACTUAL, modeloDeEsquema } = require("../lib/respaldo-lan");
const { crearTestigo } = require("../lib/testigo-lan");
const { firmarAckReplica } = require("../lib/protocolo-lan");

function copiaOtroModelo(s, escritorId) {
  const n = s.nodos[escritorId], archivo = path.join(n.base, "modelo-futuro.db"), d = new DatabaseSync(archivo);
  // Simula un esquema futuro que este ejecutable aún no entiende. Se puede
  // custodiar íntegro sin exigir las tablas de la versión que recibe la copia.
  d.exec("CREATE TABLE venta_futura(predio_id INTEGER, importe INTEGER); INSERT INTO venta_futura VALUES(1,202)"); d.close();
  const raw = fs.readFileSync(archivo), termino = s.witness().estado().estado.termino;
  const manifest = { ...s.inicial.manifest, modelo: "f".repeat(64), nodoId: escritorId, termino, indice: 1,
    bytes: raw.length, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
  const header = Buffer.from(JSON.stringify(manifest)), longitud = Buffer.alloc(4); longitud.writeUInt32BE(header.length);
  const aad = Buffer.concat([Buffer.from("AJBLAN01"), longitud, header]), iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv("aes-256-gcm", Buffer.from(n.config.respaldo_lan.claveDatos, "hex"), iv); cifrador.setAAD(aad);
  const cifrado = Buffer.concat([cifrador.update(zlib.gzipSync(raw)), cifrador.final()]);
  return { manifest, buffer: Buffer.concat([aad, iv, cifrador.getAuthTag(), cifrado]) };
}

async function escenario(t, { permitirDegradado = false, inicialCero = false, quorum = false } = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "predio-lan-"));
  const miembros = [
    { id: "equipoA", nombre: "Principal", url: "http://192.168.1.10:8080", clave: "a".repeat(64), preferido: true },
    { id: "equipoB", nombre: "Respaldo", url: "http://192.168.1.11:8080", clave: "b".repeat(64) },
  ];
  const grupoId = "grupo_camping", claveDatos = "c".repeat(64);
  let reloj = 0, witness, falloReplica = false, falloObtener = false, perderAck = false, demoraPermiso = 0, replicaExtra = null, demoraSnapshot = 0, falloTestigo = false;
  const nodos = {}, eventos = [], activaciones = [], consultasCopia = [];
  function config(id) { return { predio_id: 1, predio_codigo: "MIRAMAR", token: "credencial propia " + id, respaldo_lan: {
    habilitado: true, grupoId, nodoId: id, clave: miembros.find(m => m.id === id).clave, claveDatos, permitirDegradado,
    miembros: miembros.map(({ clave, ...m }) => m), ...(quorum ? { quorum: {} } : {}),
  } }; }
  function abrir(id) {
    const n = nodos[id], archivo = path.join(n.base, "datos", "predio.db");
    n.db = crearSqlite(archivo, { predioId: 1 }); asegurarEsquema(n.db);
    n.coordinador = crearRespaldoLan({ base: n.base, config: n.config, db: n.db, ahora: () => reloj, monotono: () => reloj,
      alCambio: e => eventos.push(e), alActivar: e => activaciones.push({ id, ...e }),
      snapshotDirecta: datos => {
        const p = crearSnapshotDirecta({ db: n.db, base: n.base, config: n.config, ...datos });
        if (datos.indice > 0) reloj += demoraSnapshot;
        return p;
      },
      transporte: {
        async testigo(accion, payload) {
          if (falloTestigo) throw new Error("Timeout del testigo");
          if (accion === "estado") {
            const r = witness.estado();
            if (quorum) r.estado.votantes = miembros.map(m => m.id);
            return r;
          }
          const r = witness[accion](payload);
          if (demoraPermiso && ["solicitar", "renovar"].includes(accion)) reloj += demoraPermiso;
          if (accion === "confirmar" && perderAck) { perderAck = false; throw new Error("Respuesta del commit perdida"); }
          return r;
        },
        async replicar(m, packet) {
          if (replicaExtra) { const r = await replicaExtra(m, packet, id); if (r !== undefined) return r; }
          if (falloReplica) throw new Error("Red de respaldo interrumpida");
          return nodos[m.id].coordinador.recibirSnapshot(packet, { remitenteId: id });
        },
        async obtenerSnapshot(m, rev) {
          consultasCopia.push(m.id);
          if (falloObtener) throw new Error("Copia no disponible");
          return nodos[m.id].coordinador.obtenerSnapshot(rev);
        },
        async drenar(m, opts) { return nodos[m.id].coordinador.drenar(opts); },
      },
    });
  }
  for (const m of miembros) {
    const base = path.join(raiz, m.id); fs.mkdirSync(path.join(base, "datos"), { recursive: true });
    nodos[m.id] = { base, config: config(m.id) };
    const d = crearSqlite(path.join(base, "datos", "predio.db"), { predioId: 1 }); asegurarEsquema(d);
    escribirMeta(d, "instancia_id", "linaje-logico");
    escribirMeta(d, "equipo_propietario_id", m.id);
    escribirMeta(d, "control_confirmado", m.id);
    if (m.id === "equipoA") d.conexion.prepare("INSERT INTO predio_sesion(token_hash,usuario_id,creada,recordar) VALUES('sesion-compartida',7,'2026-11-06',1)").run();
    d.cerrar();
    fs.writeFileSync(path.join(base, "config.json"), JSON.stringify(nodos[m.id].config));
  }
  abrir("equipoA"); abrir("equipoB");
  const inicial = crearSnapshotDirecta({ db: nodos.equipoA.db, base: nodos.equipoA.base, config: nodos.equipoA.config, indice: 0 });
  witness = crearTestigo({ base: path.join(raiz, "witness"), config: { grupoId, miembros, revisionInicial: inicialCero ? { indice: 0, sha256: "0".repeat(64) } : inicial.manifest, permitirDegradado }, ahora: () => reloj, monotono: () => reloj });
  for (const id of Object.keys(nodos)) {
    const n = nodos[id];
    if (inicialCero) {
      if (id === "equipoA") n.coordinador.registrarInicial(inicial);
      else await n.coordinador.recibirInicial(inicial, { remitenteId: "equipoA" });
      continue;
    }
    await n.coordinador.recibirSnapshot(inicial, { remitenteId: "equipoA" });
    n.coordinador.detener(); n.db.cerrar();
    aplicarPendiente({ base: n.base, config: n.config });
    abrir(id);
  }
  reloj = 20001;
  t.after(() => {
    for (const n of Object.values(nodos)) { n.coordinador.detener(); n.db.cerrar(); }
    witness.cerrar(); fs.rmSync(raiz, { recursive: true, force: true });
  });
  async function escribir(id, valor, antesCommit) {
    const n = nodos[id], c = n.coordinador;
    return n.db.exclusivo(async () => {
      await c.antesTransaccion();
      let commit = false;
      n.db.conexion.exec("BEGIN IMMEDIATE");
      try {
        n.db.conexion.prepare("INSERT INTO predio_config(predio_id,id,clave,valor) VALUES(1,1,'venta_confirmada',?) ON CONFLICT(predio_id,id) DO UPDATE SET valor=excluded.valor").run(String(valor));
        n.db.conexion.prepare("INSERT INTO predio_comando_ejecutado(comando_id,fecha,ok,status,respuesta) VALUES(1,'2026-11-06',1,200,?) ON CONFLICT(comando_id) DO UPDATE SET respuesta=excluded.respuesta").run(JSON.stringify({ valor }));
        n.db.conexion.prepare("INSERT INTO predio_peticion(operacion_id,usuario_id,peticion_sha256,fecha,status,respuesta) VALUES('peticion-1',7,?,'2026-11-06',200,?) ON CONFLICT(usuario_id,operacion_id) DO UPDATE SET respuesta=excluded.respuesta").run("e".repeat(64), JSON.stringify({ valor }));
        if (antesCommit) await antesCommit();
        await c.antesCommit();
        n.db.conexion.exec("COMMIT"); commit = true;
        await c.despuesTransaccion();
        return valor;
      } catch (e) {
        if (!commit) n.db.conexion.exec("ROLLBACK");
        c.abortarTransaccion(); throw e;
      }
    });
  }
  async function reiniciar(id) {
    const n = nodos[id]; n.coordinador.detener(); n.db.cerrar();
    const r = aplicarPendiente({ base: n.base, config: n.config });
    abrir(id); return r;
  }
  const valor = id => nodos[id].db.conexion.prepare("SELECT valor FROM predio_config WHERE clave='venta_confirmada'").get()?.valor;
  return { nodos, miembros, eventos, activaciones, consultasCopia, inicial, escribir, reiniciar, valor, replicaExtra: fn => { replicaExtra = fn; },
    avanzar: ms => { reloj += ms; }, witness: () => witness, setReplica: v => { falloReplica = v; }, setObtener: v => { falloObtener = v; }, perderAck: () => { perderAck = true; }, demorar: ms => { demoraPermiso = ms; },
    demorarSnapshot: ms => { demoraSnapshot = ms; }, setTestigo: v => { falloTestigo = v; } };
}

test("una operación sólo se confirma con snapshot íntegro durable en otro nodo y testigo, y la promoción conserva outbox/sesión/dedupe", async t => {
  const s = await escenario(t), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear();
  assert.equal(a.coordinador.estado().escritor, true);
  assert.equal(await s.escribir("equipoA", 100), 100);
  const rev = a.coordinador.estado().confirmada;
  assert.equal(rev.indice, 1);
  const packet = b.coordinador.obtenerSnapshot(rev);
  assert.equal(packet.buffer.includes(Buffer.from("venta_confirmada")), false, "la copia almacenada está cifrada");
  assert.equal(s.valor("equipoB"), undefined, "recibir no reemplaza la base abierta");
  a.coordinador.detener(); s.avanzar(15001);
  await b.coordinador.sondear();
  assert.equal(s.activaciones.at(-1).id, "equipoB");
  await s.reiniciar("equipoB");
  await b.coordinador.sondear();
  assert.equal(b.coordinador.estado().escritor, true);
  assert.equal(s.valor("equipoB"), "100");
  assert.ok((await b.db.get("SELECT COUNT(*) n FROM predio_outbox")).n > 0);
  assert.equal((await b.db.get("SELECT usuario_id FROM predio_sesion WHERE token_hash='sesion-compartida'")).usuario_id, 7);
  assert.deepEqual(JSON.parse((await b.db.get("SELECT respuesta FROM predio_comando_ejecutado WHERE comando_id=1")).respuesta), { valor: 100 });
  assert.deepEqual(JSON.parse((await b.db.get("SELECT respuesta FROM predio_peticion WHERE usuario_id=7 AND operacion_id='peticion-1'")).respuesta), { valor: 100 });
  assert.equal(leerMeta(b.db, "instancia_id"), "linaje-logico");
  assert.equal(leerMeta(b.db, "equipo_propietario_id"), "equipoB");
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.base, "config.json"))).token, "credencial propia equipoB");
});

test("si falla la copia no hay ack ni avance del testigo; el arranque restaura el último estado confirmado", async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  await a.coordinador.sondear(); s.setReplica(true);
  await assert.rejects(s.escribir("equipoA", 200), /no se confirmó/);
  assert.equal(a.coordinador.estado().bloqueado, true);
  assert.equal(s.witness().estado().estado.ultimo.indice, 0);
  assert.equal(s.valor("equipoA"), "200", "el COMMIT local aún no es una confirmación comercial");
  await s.reiniciar("equipoA");
  assert.equal(s.valor("equipoA"), undefined, "un commit no confirmado no sobrevive como escritor tras reiniciar");
});

test("si se pierde la última respuesta del testigo, el reemplazo recupera exactamente el commit durable", async t => {
  const s = await escenario(t), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear(); s.perderAck();
  await assert.rejects(s.escribir("equipoA", 300), /no se confirmó/);
  assert.equal(s.witness().estado().estado.ultimo.indice, 1);
  assert.equal(a.coordinador.estado().escritor, false);
  a.coordinador.detener(); s.avanzar(15001);
  await b.coordinador.sondear(); await s.reiniciar("equipoB"); await b.coordinador.sondear();
  assert.equal(s.valor("equipoB"), "300");
  assert.equal(b.coordinador.estado().confirmada.indice, 1);
});

test("un respaldo atrasado no toma control aunque el escritor haya desaparecido", async t => {
  const s = await escenario(t), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear(); await s.escribir("equipoA", 400);
  const rev = a.coordinador.estado().confirmada;
  fs.unlinkSync(path.join(b.base, "ha", "copias", `${rev.indice}-${rev.sha256}.ajblan`));
  a.coordinador.detener(); s.setObtener(true); s.avanzar(15001);
  await assert.rejects(b.coordinador.sondear(), /atrasado/);
  assert.equal(b.coordinador.estado().escritor, false);
  assert.equal(s.witness().estado().estado.escritor, null);
});

test("el escritor rechaza una transacción cuyo permiso venció antes de COMMIT", async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  await a.coordinador.sondear();
  await assert.rejects(s.escribir("equipoA", 500, () => s.avanzar(15001)), /permiso/);
  assert.equal(s.valor("equipoA"), undefined);
  assert.equal(s.witness().estado().estado.ultimo.indice, 0);
});

test("la recepción tardía de un lease no vuelve a empezar sus cinco segundos de uso", async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  s.demorar(5001);
  await assert.rejects(a.coordinador.sondear(), /no autorizó/);
  assert.equal(a.coordinador.estado().escritor, false);
  await assert.rejects(s.escribir("equipoA", 600));
  assert.equal(s.valor("equipoA"), undefined);
});

test("copias alteradas o de otro término no reciben acuse durable", async t => {
  const s = await escenario(t), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear();
  const p = crearSnapshotDirecta({ db: a.db, base: a.base, config: a.config, indice: 1, termino: 999 });
  await assert.rejects(b.coordinador.recibirSnapshot(p, { remitenteId: "equipoA" }), /testigo/);
  const roto = Buffer.from(s.inicial.buffer); roto[roto.length - 1] ^= 1;
  await assert.rejects(b.coordinador.recibirSnapshot({ manifest: s.inicial.manifest, buffer: roto }), /autenticar/);
});

test("el preferido vuelve sólo después de recibir la revisión actual y drenar al escritor", async t => {
  const s = await escenario(t), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear(); await s.escribir("equipoA", 700);
  a.coordinador.detener(); s.avanzar(15001);
  await b.coordinador.sondear(); await s.reiniciar("equipoB"); await b.coordinador.sondear();
  // La PC preferida vuelve como respaldo: primero recibe la revisión nueva.
  await s.reiniciar("equipoA");
  await s.escribir("equipoB", 701);
  await a.coordinador.sondear();
  assert.equal(b.coordinador.estado().escritor, false);
  assert.equal(s.witness().estado().estado.escritor, null);
  await a.coordinador.sondear();
  assert.equal(s.activaciones.at(-1).id, "equipoA");
  await s.reiniciar("equipoA"); await a.coordinador.sondear();
  assert.equal(a.coordinador.estado().escritor, true);
  assert.equal(s.valor("equipoA"), "701");
});

test("modo degradado explícito mantiene un escritor con testigo pero jamás promueve una copia anterior tras otra caída", async t => {
  const s = await escenario(t, { permitirDegradado: true }), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear(); await s.escribir("equipoA", 800);
  a.coordinador.detener(); s.avanzar(15001);
  await b.coordinador.sondear(); await s.reiniciar("equipoB"); await b.coordinador.sondear();
  s.setReplica(true);
  assert.equal(await s.escribir("equipoB", 801), 801);
  assert.equal(b.coordinador.estado().degradado, true);
  assert.equal(s.witness().estado().estado.degradado, true);
  assert.ok(s.eventos.some(e => e.tipo === "REDUNDANCIA_REDUCIDA" && e.nodoId === "equipoB"));
  b.coordinador.detener(); s.setObtener(true); s.avanzar(15001); await s.reiniciar("equipoA");
  await assert.rejects(a.coordinador.sondear(), /atrasado/);
  assert.equal(a.coordinador.estado().escritor, false);
  assert.equal(s.witness().estado().estado.ultimo.indice, 2);
});

test("el retorno del preferido recupera la última venta degradada antes de devolver el control", async t => {
  const s = await escenario(t, { permitirDegradado: true }), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear(); await s.escribir("equipoA", 900);
  a.coordinador.detener(); s.avanzar(15001);
  await b.coordinador.sondear(); await s.reiniciar("equipoB"); await b.coordinador.sondear();
  s.setReplica(true); await s.escribir("equipoB", 901); s.setReplica(false);
  await s.reiniciar("equipoA"); await a.coordinador.sondear();
  assert.equal(s.witness().estado().estado.degradado, false, "el testigo acredita la copia del preferido antes de liberar");
  await a.coordinador.sondear(); await s.reiniciar("equipoA"); await a.coordinador.sondear();
  assert.equal(a.coordinador.estado().escritor, true);
  assert.equal(s.valor("equipoA"), "901");
  assert.ok(s.eventos.some(e => e.tipo === "REDUNDANCIA_RESTABLECIDA"));
});

test("bootstrap registra la copia de la base congelada sin anidar exclusivo y no permite reinicializar después de operar", async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  const r = await a.db.exclusivo(() => a.coordinador.registrarInicial(s.inicial));
  assert.equal(r.registrado, true);
  assert.equal(a.coordinador.estado().instalada.sha256, s.inicial.manifest.sha256);
  await a.coordinador.sondear(); await s.escribir("equipoA", 1000);
  assert.throws(() => a.coordinador.registrarInicial(s.inicial), /reinicializar/);
});

test("la principal recupera la copia del escritor antes de intentar un respaldo apagado", async t => {
  const s = await escenario(t, { permitirDegradado: true }), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear();
  await s.escribir("equipoA", 101);
  a.coordinador.detener(); s.avanzar(15001);
  await b.coordinador.sondear(); await s.reiniciar("equipoB"); await b.coordinador.sondear();
  s.setReplica(true);
  await s.escribir("equipoB", 202);
  const tercero = { id: "equipoC", nombre: "Apagada", url: "http://192.168.1.12:8080", clave: "d".repeat(64) };
  s.witness().actualizarMiembros([s.miembros[0], tercero, s.miembros[1]]);
  await s.reiniciar("equipoA");
  s.consultasCopia.length = 0;
  s.setReplica(false);
  await a.coordinador.sondear();
  assert.deepEqual(s.consultasCopia, ["equipoB"]);
});

test("los hooks del adaptador SQLite confirman réplica después de COMMIT sin volver a tomar el candado", { timeout: 5000 }, async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  await a.coordinador.sondear();
  a.db.configurarTransacciones(a.coordinador);
  await a.db.tx(tx => tx.run("INSERT INTO predio_config(predio_id,id,clave,valor) VALUES(1,9,'hooks','confirmado')"));
  assert.equal(s.witness().estado().estado.ultimo.indice, 1);
  assert.equal(a.coordinador.estado().confirmada.indice, 1);
});

test("el roster firmado incorpora otro respaldo sin reiniciar al escritor ni alterar el término", async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  await a.coordinador.sondear();
  const termino = a.coordinador.estado().termino;
  const tercero = { id: "equipoC", nombre: "Otro respaldo", url: "http://192.168.1.12:8080", clave: "d".repeat(64), caPublica: require("node:tls").rootCertificates[0] };
  s.witness().actualizarMiembros([...s.miembros, tercero]);
  await a.coordinador.sondear();
  assert.equal(a.coordinador.estado().termino, termino);
  assert.equal(a.coordinador.estado().miembros.length, 3);
  assert.match(a.coordinador.estado().miembros.find(m => m.id === tercero.id).caPublica, /BEGIN CERTIFICATE/);
  let usado = false;
  s.replicaExtra((m, packet, escritorId) => {
    if (m.id !== tercero.id) throw new Error("El respaldo anterior está fuera de línea");
    assert.match(m.caPublica, /BEGIN CERTIFICATE/);
    usado = true;
    return firmarAckReplica({ grupoId: packet.manifest.grupoId, nodoId: tercero.id, escritorId, termino: packet.manifest.termino, indice: packet.manifest.indice, sha256: packet.manifest.sha256 }, tercero.clave);
  });
  await s.escribir("equipoA", 1100);
  assert.equal(usado, true);
  assert.equal(s.witness().estado().estado.ultimo_commit.replicas[0], tercero.id);
});

test("un reemplazo interrumpido se puede repetir con la identidad propia fuera de una base anterior ilegible", async t => {
  const s = await escenario(t), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear(); await s.escribir("equipoA", 1200); await b.coordinador.sondear();
  b.coordinador.detener(); b.db.cerrar();
  fs.writeFileSync(path.join(b.base, "datos", "predio.db"), "reemplazo anterior interrumpido");
  assert.equal(aplicarPendiente({ base: b.base, config: b.config }).aplicado, true);
  b.db = crearSqlite(path.join(b.base, "datos", "predio.db"), { predioId: 1 });
  assert.equal((await b.db.get("SELECT valor FROM predio_config WHERE clave='venta_confirmada'")).valor, "1200");
  assert.equal(leerMeta(b.db, "equipo_propietario_id"), "equipoB");
});

test("el snapshot lento renueva sólo el permiso del mismo término antes de confirmar", async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  await a.coordinador.sondear(); const termino = a.coordinador.estado().termino;
  s.demorarSnapshot(6000);
  assert.equal(await s.escribir("equipoA", 1300), 1300);
  assert.equal(a.coordinador.estado().termino, termino);
  assert.equal(a.coordinador.estado().escritor, true);
  assert.equal(s.witness().estado().estado.ultimo.indice, 1);
});

test("una transacción larga renueva antes de COMMIT si el testigo aún conserva al mismo escritor", async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  await a.coordinador.sondear();
  assert.equal(await s.escribir("equipoA", 1400, () => s.avanzar(6000)), 1400);
  assert.equal(a.coordinador.estado().escritor, true);
});

test("snapshot que supera el lease del testigo no se confirma y prepara recuperación automática", async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  await a.coordinador.sondear(); s.demorarSnapshot(15001);
  await assert.rejects(s.escribir("equipoA", 1500), /no se confirmó/);
  assert.equal(s.witness().estado().estado.ultimo.indice, 0);
  s.demorarSnapshot(0); await a.coordinador.sondear();
  assert.equal(a.coordinador.estado().activando, true);
  assert.equal(s.activaciones.at(-1).revision.indice, 0);
  await s.reiniciar("equipoA"); await a.coordinador.sondear();
  assert.equal(s.valor("equipoA"), undefined);
  assert.equal(a.coordinador.estado().escritor, true);
});

test("tras fallo postCOMMIT sondear espera al testigo y reinicia con la revisión acreditada sin intervención manual", async t => {
  const s = await escenario(t), a = s.nodos.equipoA;
  await a.coordinador.sondear(); s.setReplica(true);
  await assert.rejects(s.escribir("equipoA", 1600), /no se confirmó/);
  s.setTestigo(true);
  for (let i = 0; i < 2; i++) await assert.rejects(a.coordinador.sondear(), /Timeout/);
  assert.equal(a.coordinador.estado().escritor, false);
  assert.equal(s.activaciones.length, 0);
  s.setTestigo(false); s.setReplica(false);
  await a.coordinador.sondear();
  assert.equal(s.activaciones.at(-1).revision.indice, 0);
  await s.reiniciar("equipoA"); await a.coordinador.sondear();
  assert.equal(s.valor("equipoA"), undefined);
  assert.equal(await s.escribir("equipoA", 1601), 1601);
});

test("la recuperación quorum abre la copia confirmada sin reiniciar la elección ni conservar el bloqueo", async t => {
  for (const confirmada of [false, true]) await t.test(confirmada ? "acuse perdido" : "copia fallida", async sub => {
    const s = await escenario(sub, { quorum: true }), a = s.nodos.equipoA;
    await a.coordinador.sondear();
    if (confirmada) s.perderAck(); else s.setReplica(true);
    await assert.rejects(s.escribir("equipoA", 1600), /no se confirmó/);
    assert.equal(a.coordinador.estado().bloqueado, true);
    s.setTestigo(true);
    await assert.rejects(a.coordinador.sondear(), /Timeout/);
    assert.equal(a.coordinador.estado().escritor, false);
    s.setTestigo(false); s.setReplica(false);
    await a.coordinador.sondear();
    assert.equal(s.activaciones.length, 0, "el coordinador conserva su elección durante la recuperación");
    assert.equal(a.coordinador.estado().bloqueado, false);
    assert.equal(a.coordinador.estado().activando, false);
    assert.equal(s.valor("equipoA"), confirmada ? "1600" : undefined);
    await a.coordinador.sondear();
    assert.equal(await s.escribir("equipoA", 1601), 1601);
  });
});

test("seed inicial sólo se admite antes del primer grant y no marca instalada una base abierta diferente", async t => {
  const s = await escenario(t, { inicialCero: true }), a = s.nodos.equipoA, b = s.nodos.equipoB;
  assert.equal(b.coordinador.estado().instalada, null);
  assert.equal((await b.coordinador.recibirInicial(s.inicial, { remitenteId: "equipoA" })).inicial, true);
  await assert.rejects(b.coordinador.recibirInicial(s.inicial, { remitenteId: "equipoB" }), /preparación inicial/);
  await assert.rejects(a.coordinador.sondear(), /atrasado/);
  assert.equal(s.witness().estado().estado.escritor, null);
  s.witness().inicializarRevision(s.inicial.manifest);
  await a.coordinador.sondear();
  await assert.rejects(b.coordinador.recibirInicial(s.inicial, { remitenteId: "equipoA" }), /preparación inicial/);
  await s.reiniciar("equipoB");
  assert.equal(b.coordinador.estado().instalada.sha256, s.inicial.manifest.sha256);
});

test("el modelo depende del esquema y formato HA, normaliza LF/CRLF y está autenticado en cada snapshot", async t => {
  assert.equal(modeloDeEsquema("tabla\r\ncolumna\r\n"), modeloDeEsquema("tabla\ncolumna\n"));
  assert.notEqual(modeloDeEsquema("tabla\ncolumna nueva\n"), modeloDeEsquema("tabla\ncolumna\n"));
  const s = await escenario(t);
  assert.equal(s.inicial.manifest.modelo, MODELO_ACTUAL);
  const alterada = { ...s.inicial.manifest, modelo: "f".repeat(64) };
  await assert.rejects(s.nodos.equipoB.coordinador.recibirSnapshot({ manifest: alterada, buffer: s.inicial.buffer }, { remitenteId: "equipoA" }), /autenticar/);
});

test("un respaldo custodia otro modelo pero no obtiene lease, escribe, drena ni sustituye su DB para promoverlo", async t => {
  const s = await escenario(t), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear();
  const packet = copiaOtroModelo(s, "equipoA");
  const ack = await b.coordinador.recibirSnapshot(packet, { remitenteId: "equipoA" });
  s.witness().confirmar({ nodoId: "equipoA", termino: packet.manifest.termino, ...packet.manifest, replicas: [ack] });
  a.coordinador.detener(); s.avanzar(15001);
  await assert.rejects(b.coordinador.sondear(), { codigo: "RESPALDO_LAN_MODELO_INCOMPATIBLE" });
  assert.equal(s.witness().estado().estado.termino, packet.manifest.termino, "no pide un nuevo grant incompatible");
  assert.equal(s.activaciones.length, 0);
  assert.equal(b.coordinador.estado().modeloCompatible, false);
  assert.equal(b.coordinador.estado().escritor, false);
  assert.match(b.coordinador.estado().error, /Actualizá esta PC/);
  assert.deepEqual(b.coordinador.obtenerSnapshot(packet.manifest).buffer, packet.buffer, "conserva los bytes cifrados sin convertirlos");
  await assert.rejects(b.coordinador.antesTransaccion(), { codigo: "RESPALDO_LAN_MODELO_INCOMPATIBLE" });
  await assert.rejects(b.coordinador.drenar({ haciaId: "equipoA" }), { codigo: "RESPALDO_LAN_MODELO_INCOMPATIBLE" });
  b.db.cerrar();
  const archivo = path.join(b.base, "datos", "predio.db"), anterior = fs.readFileSync(archivo), estado = fs.readFileSync(path.join(b.base, "ha", "estado.json"));
  const r = aplicarPendiente({ base: b.base, config: b.config });
  assert.equal(r.aplicado, false); assert.equal(r.incompatible, true);
  assert.deepEqual(fs.readFileSync(archivo), anterior, "no instala ni revierte una SQLite incompatible");
  assert.deepEqual(fs.readFileSync(path.join(b.base, "ha", "estado.json")), estado, "no finge una revisión instalada");
});

test("el preferido que vuelve con código incompatible no pide al escritor actual que drene", async t => {
  const s = await escenario(t), a = s.nodos.equipoA, b = s.nodos.equipoB;
  await a.coordinador.sondear(); a.coordinador.detener(); s.avanzar(15001);
  await b.coordinador.sondear();
  const packet = copiaOtroModelo(s, "equipoB"), ack = await a.coordinador.recibirSnapshot(packet, { remitenteId: "equipoB" });
  s.witness().confirmar({ nodoId: "equipoB", termino: packet.manifest.termino, ...packet.manifest, replicas: [ack] });
  let drenajes = 0; b.coordinador.drenar = async () => { drenajes++; throw new Error("No debe entregar el control"); };
  await s.reiniciar("equipoA");
  await assert.rejects(a.coordinador.sondear(), { codigo: "RESPALDO_LAN_MODELO_INCOMPATIBLE" });
  assert.equal(drenajes, 0);
  assert.equal(s.witness().estado().estado.escritor.id, "equipoB");
  assert.equal(a.coordinador.estado().escritor, false);
  assert.equal(s.activaciones.length, 0);
});
