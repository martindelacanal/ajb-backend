"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { crearAccesoLan, origenPermitido, privada } = require("../lib/acceso-lan");

async function escuchar(handler) {
  const servidor = http.createServer(handler);
  await new Promise(resolve => servidor.listen(0, "127.0.0.1", resolve));
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}
async function cerrar(servidor) { await new Promise(resolve => { servidor.close(resolve); servidor.closeAllConnections(); }); }

async function escenario(t, opciones = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-acceso-lan-"));
  const claves = crypto.generateKeyPairSync("ed25519");
  const publica = claves.publicKey.export({ type: "spki", format: "pem" });
  const peticiones = [], consultas = [];
  const control = { termino: 1, escritor: "a", indice: 1, hash: "a".repeat(64), alterar: x => x };
  let acceso;
  const equipos = [];
  const miembro = id => async (req, res) => {
    let cuerpo = "";
    for await (const b of req) cuerpo += b;
    peticiones.push({ id, metodo: req.method, ruta: req.url, cuerpo, headers: req.headers });
    if (opciones.responder) return opciones.responder({ id, req, res, cuerpo, control });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id, cuerpo, authorization: req.headers.authorization || null }));
  };
  equipos.push(await escuchar(miembro("a")), await escuchar(miembro("b")), await escuchar(miembro("c")));
  const testigo = await escuchar((req, res) => {
    const desafio = new URL(req.url, "http://testigo").searchParams.get("desafio");
    consultas.push(desafio);
    if (opciones.alConsultar) opciones.alConsultar(control, consultas.length);
    const estado = control.alterar({ tipo: "AJB_TESTIGO_ESTADO", formato: 1, grupo_id: "camping", termino: control.termino,
      escritor: control.escritor ? { id: control.escritor, nombre: control.escritor, url: equipos[["a", "b", "c"].indexOf(control.escritor)].url } : null,
      ultimo: { indice: control.indice, sha256: control.hash }, preferido_id: "a", emitido_ms: Date.now(), vence_ms: Date.now() + 3000, desafio,
      ...(control.miembros ? { miembros: control.miembros, revision_miembros: control.revision } : {}) });
    const firma = crypto.sign(null, Buffer.from(JSON.stringify(estado)), opciones.claveFirma || claves.privateKey).toString("base64");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ estado, firma, clave_publica: publica }));
  });
  const config = { habilitado: true, grupoId: "camping", clavePublicaTestigo: publica, testigo: { url: testigo.url }, miembros: [{ id: "a", url: equipos[0].url }, { id: "b", url: equipos[1].url }] };
  const opcionesAcceso = { config, base, timeoutMs: 1000, timeoutEstadoMs: 500, ...opciones.acceso };
  t.after(async () => { if (acceso) await acceso.cerrar(); await cerrar(testigo.servidor); for (const e of equipos) await cerrar(e.servidor); fs.rmSync(base, { recursive: true, force: true }); });
  acceso = crearAccesoLan(opcionesAcceso);
  let url = await acceso.escuchar(0);
  return { base, config, control, peticiones, consultas, equipos, testigo,
    get acceso() { return acceso; }, get url() { return url; },
    async reiniciar() { await acceso.cerrar(); acceso = crearAccesoLan(opcionesAcceso); url = await acceso.escuchar(0); },
  };
}

function pedir(url, { metodo = "GET", headers = {}, cuerpo } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: metodo, headers, agent: false }, res => {
      let texto = ""; res.on("data", b => { texto += b; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, texto })); res.on("error", reject);
    });
    req.on("error", reject); req.end(cuerpo);
  });
}

test("el acceso sólo escucha loopback y deriva Authorization al escritor firmado permitido", async t => {
  const s = await escenario(t);
  assert.equal(s.acceso.servidor.address().address, "127.0.0.1");
  const r = await pedir(s.url + "/api/sesion", { headers: { Authorization: "Bearer cajero", Connection: "x-interno", "x-interno": "quitar", "proxy-authorization": "secreto-proxy" } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.texto).authorization, "Bearer cajero");
  assert.equal(s.peticiones[0].id, "a");
  assert.equal(s.peticiones[0].headers["x-interno"], undefined);
  assert.equal(s.peticiones[0].headers["proxy-authorization"], undefined);
  assert.notEqual(s.peticiones[0].headers.host, new URL(s.url).host);
  assert.match(s.consultas[0], /^[a-f0-9]{48}$/);
});

test("Host ajeno y solicitudes de una web externa se rechazan sin tocar miembros", async t => {
  const s = await escenario(t);
  assert.equal((await pedir(s.url, { headers: { Host: "atacante.example" } })).status, 403);
  assert.equal((await pedir(s.url + "/api/ventas", { metodo: "POST", headers: { Origin: "https://atacante.example" }, cuerpo: "{}" })).status, 403);
  assert.equal(s.peticiones.length, 0);
  assert.equal(s.consultas.length, 0);
});

test("una clave devuelta por el servidor no sustituye la clave pública fijada", async t => {
  const s = await escenario(t, { claveFirma: crypto.generateKeyPairSync("ed25519").privateKey });
  assert.equal((await pedir(s.url + "/api/ventas", { metodo: "POST", headers: { Authorization: "Bearer cajero" }, cuerpo: "{}" })).status, 503);
  assert.equal(s.peticiones.length, 0);
});

test("desafío ajeno o estado vencido nunca habilitan el reenvío", async t => {
  const s = await escenario(t);
  s.control.alterar = estado => ({ ...estado, desafio: "repetido" });
  assert.equal((await pedir(s.url)).status, 503);
  s.control.alterar = estado => ({ ...estado, emitido_ms: Date.now() - 5000, vence_ms: Date.now() - 1000 });
  assert.equal((await pedir(s.url)).status, 503);
  assert.equal(s.peticiones.length, 0);
});

test("los términos avanzan al cambiar el escritor y los anteriores se rechazan aun tras reiniciar", async t => {
  const s = await escenario(t);
  assert.equal(JSON.parse((await pedir(s.url)).texto).id, "a");
  s.control.termino = 2; s.control.escritor = "b";
  assert.equal(JSON.parse((await pedir(s.url)).texto).id, "b");
  await s.reiniciar();
  s.control.termino = 1; s.control.escritor = "a";
  assert.equal((await pedir(s.url)).status, 503);
  assert.equal(s.peticiones.length, 2);
  assert.equal(s.acceso.estado().termino, 2);
});

test("el mismo término no puede reasignarse y una copia confirmada no retrocede", async t => {
  const s = await escenario(t);
  await pedir(s.url);
  s.control.escritor = "b";
  assert.equal((await pedir(s.url)).status, 503);
  s.control.termino = 2; s.control.indice = 0;
  assert.equal((await pedir(s.url)).status, 503);
  s.control.indice = 1; s.control.hash = "b".repeat(64);
  assert.equal((await pedir(s.url)).status, 503);
  assert.equal(s.peticiones.length, 1);
});

test("un escritor firmado fuera de allowlist no recibe ninguna credencial", async t => {
  const s = await escenario(t);
  s.control.alterar = estado => ({ ...estado, escritor: { id: "a", url: "http://192.168.1.99:8080" } });
  assert.equal((await pedir(s.url, { headers: { Authorization: "Bearer privado" } })).status, 503);
  assert.equal(s.peticiones.length, 0);
});

test("una falla de persistencia impide reenviar y queda bloqueada hasta reparar", async t => {
  const s = await escenario(t, { acceso: { guardarEstado: () => { throw new Error("disco lleno"); } } });
  assert.equal((await pedir(s.url)).status, 503);
  assert.equal(s.acceso.estado().error_disco, true);
  assert.equal((await pedir(s.url)).status, 503);
  assert.equal(s.consultas.length, 1);
  assert.equal(s.peticiones.length, 0);
});

test("una consulta puede redescubrir el reemplazo tras un fallo antes de recibir respuesta", async t => {
  const s = await escenario(t, {
    alConsultar(control, n) { if (n > 1) { control.termino = 2; control.escritor = "b"; } },
    responder({ id, req, res }) { if (id === "a") req.socket.destroy(); else res.end("reemplazo"); },
  });
  const r = await pedir(s.url);
  assert.equal(r.status, 200); assert.equal(r.texto, "reemplazo");
  assert.deepEqual(s.peticiones.map(p => p.id), ["a", "b"]);
});

test("un cobro con respuesta perdida se informa incierto y jamás se repite en otro servidor", async t => {
  const s = await escenario(t, { responder({ req, control }) { control.termino = 2; control.escritor = "b"; req.socket.destroy(); } });
  const r = await pedir(s.url + "/api/ventas", { metodo: "POST", headers: { Authorization: "Bearer cajero", "x-ajb-operacion": "persistente-1" }, cuerpo: '{"total":100}' });
  assert.equal(r.status, 502); assert.equal(JSON.parse(r.texto).codigo, "RESULTADO_INCIERTO");
  assert.equal(s.peticiones.length, 1); assert.equal(s.peticiones[0].id, "a");
  assert.equal(s.peticiones[0].cuerpo, '{"total":100}');
  assert.equal(s.peticiones[0].headers["x-ajb-operacion"], "persistente-1");
});

test("redirigir fuera del miembro autorizado no sigue la redirección ni reenvía un POST", async t => {
  const s = await escenario(t, { responder({ res }) { res.writeHead(307, { Location: "http://192.168.1.99/api/ventas" }); res.end(); } });
  const r = await pedir(s.url + "/api/ventas", { metodo: "POST", cuerpo: "venta" });
  assert.equal(r.status, 502); assert.equal(s.peticiones.length, 1);
});

test("el límite de solicitud se aplica antes de remitir y el de respuesta interrumpe descargas excesivas", async t => {
  const s = await escenario(t, { acceso: { maxSolicitud: 4, maxRespuesta: 4 }, responder({ res }) { res.writeHead(200, { "Content-Length": "5" }); res.end("12345"); } });
  assert.equal((await pedir(s.url, { metodo: "POST", headers: { "Content-Length": "5" }, cuerpo: "12345" })).status, 413);
  assert.equal(s.peticiones.length, 0);
  assert.equal((await pedir(s.url)).status, 502);
});

test("se excluyen destinos públicos, metadatos y resoluciones DNS mixtas", async t => {
  for (const url of ["https://8.8.8.8", "http://169.254.169.254", "http://0.0.0.0", "http://10.0.0.1/ruta", "http://usuario:clave@10.0.0.1", "file:///tmp/datos"]) assert.throws(() => origenPermitido(url), url);
  assert.equal(privada("10.2.3.4"), true); assert.equal(privada("192.168.0.1"), true); assert.equal(privada("fc00::123"), true); assert.equal(privada("2001:4860:4860::8888"), false);
  const s = await escenario(t);
  await s.acceso.cerrar();
  const config = { ...s.config, testigo: { url: "http://camping.local:8092" } };
  const acceso = crearAccesoLan({ config, base: s.base, resolver: async () => [{ address: "10.0.0.1", family: 4 }, { address: "8.8.8.8", family: 4 }] });
  t.after(() => acceso.cerrar());
  assert.equal((await pedir(await acceso.escuchar(0))).status, 503);
  assert.equal(s.peticiones.length, 0);
});

test("un roster firmado agrega respaldos sin reinstalar cajas y persiste su revisión separada del término", async t => {
  const s = await escenario(t);
  s.control.miembros = s.config.miembros; s.control.revision = 1;
  assert.equal((await pedir(s.url)).status, 200);
  s.control.miembros = [...s.config.miembros, { id: "c", nombre: "Nuevo respaldo", url: s.equipos[2].url }]; s.control.revision = 2;
  assert.equal((await pedir(s.url)).status, 200, "la membresía puede actualizarse sin cambiar el término ni interrumpir al escritor");
  s.control.termino = 2; s.control.escritor = "c";
  assert.equal(JSON.parse((await pedir(s.url, { headers: { Authorization: "Bearer cajero" } })).texto).id, "c");
  await s.reiniciar();
  assert.equal(s.acceso.estado().revision_miembros, 2);
  assert.equal(JSON.parse((await pedir(s.url)).texto).id, "c");
  assert.equal(s.peticiones.find(p => p.id === "c").headers.authorization, "Bearer cajero");
});

test("no se aceptan rosters públicos, duplicados ni cambios con una revisión anterior o idéntica", async t => {
  const s = await escenario(t);
  s.control.miembros = s.config.miembros; s.control.revision = 2;
  await pedir(s.url);
  s.control.revision = 3; s.control.miembros = [{ id: "a", url: "http://8.8.8.8:8080" }];
  assert.equal((await pedir(s.url)).status, 503);
  s.control.miembros = [s.config.miembros[0], s.config.miembros[0]];
  assert.equal((await pedir(s.url)).status, 503);
  s.control.revision = 1; s.control.miembros = s.config.miembros; s.control.termino = 2;
  assert.equal((await pedir(s.url)).status, 503, "avanzar el término no autoriza retroceder la membresía");
  s.control.revision = 2; s.control.miembros = [s.config.miembros[0]];
  assert.equal((await pedir(s.url)).status, 503, "una revisión no puede cambiar de contenido");
  assert.equal(s.peticiones.length, 1);
});

test("una falla de disco al incorporar un roster nuevo no habilita al nuevo destinatario", async t => {
  let escrituras = 0;
  const s = await escenario(t, { acceso: { guardarEstado: (archivo, datos) => {
    if (++escrituras > 1) throw new Error("disco lleno");
    fs.mkdirSync(path.dirname(archivo), { recursive: true }); fs.writeFileSync(archivo, JSON.stringify(datos));
  } } });
  s.control.miembros = s.config.miembros; s.control.revision = 1;
  await pedir(s.url);
  s.control.miembros = [...s.config.miembros, { id: "c", url: s.equipos[2].url }]; s.control.revision = 2;
  s.control.termino = 2; s.control.escritor = "c";
  assert.equal((await pedir(s.url, { headers: { Authorization: "Bearer privado" } })).status, 503);
  assert.equal(s.acceso.estado().error_disco, true);
  assert.equal(s.acceso.estado().revision_miembros, 1);
  assert.equal(s.peticiones.length, 1);
});

test("sin escritor acreditado se interrumpe el acceso aunque el anterior siga respondiendo", async t => {
  const s = await escenario(t);
  await pedir(s.url);
  s.control.escritor = null;
  assert.equal((await pedir(s.url + "/api/ventas", { metodo: "POST", cuerpo: "{}" })).status, 503);
  assert.equal(s.peticiones.length, 1);
});

const opensslDisponible = spawnSync("openssl", ["version"], { windowsHide: true, stdio: "ignore" }).status === 0;
test("HTTPS rechaza una raíz desconocida y usa únicamente la CA pública del roster firmado", { skip: !opensslDisponible }, async t => {
  const s = await escenario(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-acceso-tls-"));
  let tls;
  t.after(async () => { if (tls) await cerrar(tls); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, "openssl.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n");
  const openssl = args => execFileSync("openssl", args, { cwd: dir, windowsHide: true, stdio: "ignore", timeout: 30000,
    env: { ...process.env, OPENSSL_CONF: path.join(dir, "openssl.cnf") } });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=AJB Proxy Test CA", "-days", "1", "-addext", "basicConstraints=critical,CA:TRUE"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost"]);
  fs.writeFileSync(path.join(dir, "leaf.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n");
  openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "leaf.ext"]);
  let recibidos = 0;
  tls = https.createServer({ key: fs.readFileSync(path.join(dir, "leaf.key")), cert: fs.readFileSync(path.join(dir, "leaf.pem")) }, (req, res) => {
    recibidos++; assert.equal(req.headers.authorization, "Bearer caja"); res.end("TLS_VALIDADO");
  });
  tls.on("tlsClientError", () => {});
  await new Promise(resolve => tls.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${tls.address().port}`;
  s.control.miembros = [{ id: "a", url }]; s.control.revision = 1;
  s.control.alterar = estado => ({ ...estado, escritor: { id: "a", url } });
  assert.equal((await pedir(s.url, { headers: { Authorization: "Bearer caja" } })).status, 502);
  assert.equal(recibidos, 0, "la credencial no llega a un servidor con raíz desconocida");
  s.control.miembros = [{ id: "a", url, caPublica: fs.readFileSync(path.join(dir, "ca.pem"), "utf8") }]; s.control.revision = 2;
  const r = await pedir(s.url, { headers: { Authorization: "Bearer caja" } });
  assert.equal(r.status, 200); assert.equal(r.texto, "TLS_VALIDADO"); assert.equal(recibidos, 1);
  assert.equal(new crypto.X509Certificate(s.acceso.estado().miembros[0].caPublica).ca, true);
});
