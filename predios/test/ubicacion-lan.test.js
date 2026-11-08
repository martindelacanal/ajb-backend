"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const { EventEmitter, once } = require("node:events");
const { firmarMensaje } = require("../lib/descubrimiento");
const { crearUbicacionLan, buscarAccesoLan, conectarMiembro } = require("../lib/ubicacion-lan");

test("el descubrimiento acepta la nueva IP sólo con respuesta autenticada y desafío reciente", async t => {
  const socket = new EventEmitter();
  socket.bind = (_puerto, _host, listo) => listo();
  socket.unref = socket.setBroadcast = socket.close = () => {};
  socket.send = (buffer, puerto, ip) => socket.emit("salida", JSON.parse(buffer), puerto, ip);
  t.mock.method(dgram, "createSocket", () => socket);
  const grupoId = "camping", claveDatos = "a".repeat(64), nodoId = "b".repeat(64), remotoId = "c".repeat(64);
  const clave = crypto.createHmac("sha256", Buffer.from(claveDatos, "hex")).update("ajb-quorum-ubicacion-v1").digest("hex");
  let tiempo = 0;
  const salida = once(socket, "salida");
  const ubicacion = crearUbicacionLan({ grupoId, claveDatos, nodoId, ahora: () => tiempo,
    puertos: () => ({ https: 8443, raft: 39878 }), intervaloMs: 20 });
  t.after(() => ubicacion.detener());
  const [{ nonce }] = await salida;
  const responder = (ip, campos = {}) => {
    const dato = firmarMensaje({ tipo: "AJB_QUORUM_UBICACION", grupoId, nodoId: remotoId, nonce,
      ips: [ip], nombreTls: "caja-2", https: 8443, raft: 39878, ...campos }, clave);
    socket.emit("message", Buffer.from(JSON.stringify(dato)), { address: ip, port: 39879 });
  };
  responder("192.168.4.5", { ips: ["192.168.4.4"] });
  responder("192.168.4.5", { nonce: "0".repeat(32) });
  responder("192.168.4.5", { grupoId: "otro" });
  assert.equal(ubicacion.equipo(remotoId), null);
  responder("192.168.4.5");
  assert.deepEqual(ubicacion.direccionesRaft(), { [remotoId]: "192.168.4.5:39878" });
  tiempo += 20;
  const reloj = setTimeout(() => {}, 500);
  t.after(() => clearTimeout(reloj));
  const [nueva] = await once(socket, "salida");
  responder("192.168.8.5", { nonce: nueva.nonce });
  responder("192.168.4.5");
  const miembro = { id: remotoId, url: "https://192.168.4.5:8443", caPublica: "CA del equipo" };
  assert.deepEqual(conectarMiembro(miembro, ubicacion), { url: "https://192.168.8.5:8443", ca: "CA del equipo", servername: "caja-2" });
  tiempo += 13000;
  assert.deepEqual(ubicacion.direccionesRaft(), {});
});

test("la caja descubre un servidor con la clave pública sin recibir claves de réplica", async t => {
  const grupoId = "camping", nodoId = "b".repeat(64), ip = "192.168.1.21";
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const sockets = [];
  t.mock.method(dgram, "createSocket", () => {
    const s = new EventEmitter();
    s.bind = (_puerto, _host, listo) => listo();
    s.unref = s.setBroadcast = s.close = () => {};
    s.send = sockets.length ? buffer => sockets[0].emit("message", buffer, { address: "192.168.1.25", port: 48000 }) : () => {};
    sockets.push(s);
    return s;
  });
  const red = () => ({ lan: [{ family: "IPv4", address: ip, netmask: "255.255.255.0", internal: false }] });
  const servidor = crearUbicacionLan({ grupoId, nodoId, claveDatos: "a".repeat(64), red,
    nombre: () => "servidor", firmaAcceso: () => privateKey, puertos: () => ({ http: 8080, https: 8443 }) });
  t.after(servidor.detener);
  sockets[0].send = (buffer, puerto) => {
    const firmado = JSON.parse(buffer);
    if (!firmado.ubicacion) return;
    assert.equal(puerto, 48000);
    assert.equal(firmado.ubicacion.nonce.length, 32);
    sockets[1].emit("message", buffer, { address: ip, port: 39879 });
  };
  const ubicaciones = await buscarAccesoLan({ grupoId, clavePublica: publicKey, red, esperaMs: 20 });
  assert.deepEqual(ubicaciones.get(nodoId), { ip, http: 8080, https: 8443, nombreTls: "servidor" });
});
