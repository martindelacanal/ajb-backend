"use strict";

// Integración de procesos/HTTP. Los ZIP se inspeccionan sin ejecutar instaladores,
// tareas, reglas de firewall ni operaciones sobre almacenes de certificados.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { crearSqlite, asegurarEsquema } = require("../lib/db-sqlite");
const N = require("../lib/negocio");
const U = require("../lib/util");
const { crearTestigo } = require("../lib/testigo-lan");
const { crearServidorTestigo } = require("../lib/servidor-testigo");
const { crearServicioLan } = require("../lib/servicio-lan");
const { firmarPeticion } = require("../lib/protocolo-lan");
const { descifrarJson, pedir: pedirLan } = require("../lib/http-lan");
const { conectarMiembro } = require("../lib/ubicacion-lan");
const RAIZ = path.join(__dirname, "..");
const ipLan = Object.values(os.networkInterfaces()).flat().find(i => i.family === "IPv4" && !i.internal)?.address;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function puertoLibre() { const s = net.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function cerrar(s) { if (!s?.listening) return; await new Promise((r) => { s.close(r); s.closeAllConnections?.(); }); }
function pedir(origen, ruta, { metodo = "GET", token, cuerpo, headers = {}, ca, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const b = Buffer.isBuffer(cuerpo) ? cuerpo : cuerpo === undefined ? null : Buffer.from(JSON.stringify(cuerpo));
    const req = (origen.startsWith("https:") ? https : http).request(new URL(ruta, origen), { method: metodo, agent: false, ca, rejectUnauthorized: true, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(b ? { "Content-Type": "application/json", "Content-Length": b.length } : {}), ...headers } }, (res) => {
      const partes = []; res.on("data", (p) => partes.push(p)); res.on("error", reject); res.on("end", () => { clearTimeout(timer); const buffer = Buffer.concat(partes); let json; try { json = JSON.parse(buffer); } catch (_e) {} resolve({ status: res.statusCode, headers: res.headers, buffer, json }); });
    });
    const timer = setTimeout(() => req.destroy(new Error("Timeout de la prueba HTTP")), timeout); req.on("error", (e) => { clearTimeout(timer); reject(e); }); req.end(b);
  });
}
async function preparar(t, conTls, equipoId) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-grupo-servidor-"));
  const puerto = await puertoLibre(), seguro = await puertoLibre();
  const config = { predio_id: 1, predio_codigo: "MIRAMAR", predio_nombre: "Predio fixture", puerto };
  fs.writeFileSync(path.join(base, "config.json"), JSON.stringify(config));
  const db = crearSqlite(path.join(base, "datos", "predio.db"), { predioId: 1 }); asegurarEsquema(db);
  await db.tx(async (tr) => {
    const ctx = { pid: 1, usuario: { nombre: "Fixture" } };
    await N.insertar(tr, ctx, "predio_usuario", { usuario: "admin", nombre: "Admin", rol: "ADMIN", activo: 1, password_hash: U.hashPassword("fixture-admin") });
    await N.insertar(tr, ctx, "predio_usuario", { usuario: "caja", nombre: "Caja", rol: "CAJERO", activo: 1, password_hash: U.hashPassword("fixture-caja") });
    const boca = await N.insertar(tr, ctx, "predio_boca", { nombre: "Boca fixture", activo: 1 });
    await N.insertar(tr, ctx, "predio_usuario_boca", { boca_id: boca, usuario_id: 2 });
  }); db.cerrar();
  let tlsConfig = null, raiz = null;
  if (conTls) {
    const dir = path.join(base, "datos", "tls"); fs.mkdirSync(dir);
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
      $k=[Security.Cryptography.RSA]::Create(2048); $l=[Security.Cryptography.RSA]::Create(2048)
      $h=[Security.Cryptography.HashAlgorithmName]::SHA256; $p=[Security.Cryptography.RSASignaturePadding]::Pkcs1
      $r=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=AJB Grupo Fixture CA',$k,$h,$p)
      $r.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
      $r.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign,$true))
      $root=$r.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5),[DateTimeOffset]::Now.AddDays(2))
      $r2=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$l,$h,$p)
      $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new(); $san.AddDnsName('localhost'); $san.AddDnsName($env:COMPUTERNAME.ToLower()); $san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'))
      if ($env:AJB_FIXTURE_IP_LAN) { $san.AddIpAddress([Net.IPAddress]::Parse($env:AJB_FIXTURE_IP_LAN)) }
      $r2.CertificateExtensions.Add($san.Build())
      $r2.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
      $leaf=$r2.Create($root,[DateTimeOffset]::Now.AddMinutes(-1),[DateTimeOffset]::Now.AddDays(1),[byte[]]@(1,2,3,4,5,6,7,8))
      $leaf2=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($leaf,$l)
      [IO.File]::WriteAllBytes((Join-Path $env:AJB_GRUPO_FIXTURE 'servidor.pfx'),$leaf2.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,'fixture-passphrase'))
      [IO.File]::WriteAllBytes((Join-Path $env:AJB_GRUPO_FIXTURE 'autoridad.cer'),$root.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
      foreach($o in @($leaf2,$leaf,$root,$l,$k)){ $o.Dispose() }`;
    execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 30000, env: { ...process.env, AJB_GRUPO_FIXTURE: dir, AJB_FIXTURE_IP_LAN: ipLan || "" }, stdio: "pipe" });
    raiz = new crypto.X509Certificate(fs.readFileSync(path.join(dir, "autoridad.cer"))).toString();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ puerto: seguro, certificado: "servidor.pfx", raiz: "autoridad.cer", passphrase: "fixture-passphrase", huella_sha256: new crypto.X509Certificate(raiz).fingerprint256.replace(/:/g, "").toLowerCase() }));
    tlsConfig = { pfx: fs.readFileSync(path.join(dir, "servidor.pfx")), passphrase: "fixture-passphrase" };
  }
  let hijo = null, salida = "";
  const args = [];
  if (equipoId) {
    const preload = path.join(base, "equipo-fixture.cjs");
    fs.writeFileSync(preload, `const c = require(${JSON.stringify(require.resolve("../lib/control-equipo"))});
const crear = c.crearControlEquipo;
c.identidadEquipo = () => ${JSON.stringify(equipoId)};
c.crearControlEquipo = opciones => crear({ ...opciones, equipoId: c.identidadEquipo() });`);
    args.push("--require", preload);
  }
  const limpiezas = [];
  async function iniciar() {
    hijo = spawn(process.execPath, [...args, path.join(RAIZ, "servidor.js"), "--base", base], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    hijo.stdout.on("data", (p) => { salida = (salida + p.toString()).slice(-64000); }); hijo.stderr.on("data", (p) => { salida = (salida + p.toString()).slice(-64000); });
    for (let n = 0; n < 80; n++) { if (hijo.exitCode !== null) throw new Error("El servidor fixture no inició: " + salida); try { const r = await pedir(`http://127.0.0.1:${puerto}`, "/api/estado-publico", { timeout: 1000 }); if (r.status === 200 || r.status === 503) return; } catch (_e) {} await esperar(100); }
    throw new Error("El servidor fixture no abrió HTTP");
  }
  async function detener() { if (!hijo || hijo.exitCode !== null) return; const terminado = once(hijo, "exit"); hijo.kill("SIGTERM"); await Promise.race([terminado, esperar(5000).then(() => { if (hijo.exitCode === null) hijo.kill("SIGKILL"); })]); }
  t.after(async () => { await detener(); for (const limpiar of limpiezas) await limpiar(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, puerto, seguro, config, raiz, tlsConfig, iniciar, detener, limpiezas, get hijo() { return hijo; }, get salida() { return salida; }, http: `http://127.0.0.1:${puerto}`, https: `https://127.0.0.1:${seguro}` };
}
function leerZip(archivo) {
  const script = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead($env:AJB_GRUPO_ZIP);try{$r=[IO.StreamReader]::new($z.GetEntry('predio-ha.json').Open());$h=$r.ReadToEnd();$r.Dispose();@{ha=$h;nombres=@($z.Entries|ForEach-Object{$_.FullName})}|ConvertTo-Json -Compress -Depth 5}finally{$z.Dispose()}";
  const r = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8", timeout: 30000, env: { ...process.env, AJB_GRUPO_ZIP: archivo } }));
  return { ha: JSON.parse(r.ha), nombres: r.nombres.map((n) => n.replace(/\\/g, "/")) };
}

test("un administrador descarga desde HTTP el paquete unificado para la misma PC", {
  skip: process.platform !== "win32" || !ipLan || !fs.existsSync(path.join(RAIZ, "windows", "ajb-quorum.exe")), timeout: 120000,
}, async t => {
  const s = await preparar(t, true);
  await s.iniciar();
  const origen = `http://${ipLan}:${s.puerto}`;
  const alta = "/api/sistema/grupo-local/incorporar-equipo";
  const login = await pedir(origen, "/api/login", { metodo: "POST", cuerpo: { usuario: "admin", password: "fixture-admin" } });
  assert.equal(login.status, 200, login.json?.mensaje);
  assert.equal((await pedir(origen, alta, { metodo: "POST", cuerpo: {} })).status, 401);
  assert.equal((await pedir(s.http, alta, { metodo: "POST", token: login.json.token, cuerpo: {} })).status, 409);
  const r = await pedir(origen, alta, { metodo: "POST", token: login.json.token, cuerpo: {} });
  assert.equal(r.status, 200, r.json?.mensaje);
  assert.match(r.headers["content-disposition"], /AJB-Incorporar-esta-PC\.zip/);
  const archivo = path.join(s.base, "equipo.zip");
  fs.writeFileSync(archivo, r.buffer);
  const { ha, nombres } = leerZip(archivo);
  assert.equal(ha.quorumPendiente, true);
  assert.equal(ha.rolInstalacion, "Respaldo");
  assert.equal(ha.incorporacion.principalUrl, `https://${ipLan}:${s.seguro}`);
  assert.ok(nombres.some(x => x.endsWith("/windows/ajb-quorum.exe")));
  assert.ok(!nombres.some(x => /datos[\/]|\.pfx$|\.env$/.test(x)));
  const inc = ha.incorporacion;
  const ruta = "/lan/incorporar";
  const cuerpo = Buffer.from(JSON.stringify({ rol: "Respaldo", nodoId: "d".repeat(64), nombre: "pc-caja", url: "https://pc-caja:8443", caPublica: s.raiz }));
  const headers = { ...firmarPeticion({ grupoId: ha.grupoId, nodoId: "d".repeat(64), metodo: "POST", ruta, cuerpo, clave: inc.clave }), "X-AJB-Incorporacion": inc.id };
  const desdeOtraPc = await pedir(s.https, ruta, { metodo: "POST", headers, cuerpo, ca: s.raiz });
  assert.equal(desdeOtraPc.status, 403);
  assert.match(desdeOtraPc.json.mensaje, /misma PC/);
});

test("HTTP real protege roles y ZIP Windows; incorpora testigo/respaldo, congela, siembra y reinicia sin perder sesión", { skip: process.platform !== "win32", timeout: 120000 }, async (t) => {
  const s = await preparar(t, true); await s.iniciar();
  const login = async (usuario, password) => (await pedir(s.http, "/api/login", { metodo: "POST", cuerpo: { usuario, password } })).json.token;
  const admin = await login("admin", "fixture-admin"), caja = await login("caja", "fixture-caja");
  assert.equal((await pedir(s.http, "/api/sistema/grupo-local")).status, 401);
  assert.equal((await pedir(s.http, "/api/sistema/grupo-local", { token: caja })).status, 403);
  assert.equal((await pedir(s.http, "/api/sistema/grupo-local/instalador", { metodo: "POST", token: caja, cuerpo: { rol: "Testigo" } })).status, 403);
  assert.equal((await pedir(s.http, "/api/sistema/grupo-local/activar", { metodo: "POST", token: caja, cuerpo: {} })).status, 403);
  const zip = await pedir(s.http, "/api/sistema/grupo-local/instalador", { metodo: "POST", token: admin, cuerpo: { rol: "Testigo" } });
  assert.equal(zip.status, 200); assert.match(zip.headers["content-type"], /application\/zip/);
  const archivo = path.join(s.base, "testigo.zip"); fs.writeFileSync(archivo, zip.buffer); const inicial = leerZip(archivo);
  for (const n of ["node/node.exe", "app/ACTUAL", "INSTALAR-APOYO.bat", "instalador/configurar-apoyo.ps1", "instalador/crear-acceso-pc-caja.bat"]) assert.ok(inicial.nombres.includes(n), n);
  assert.ok(inicial.nombres.every((n) => !n.endsWith(".db") && !n.includes(".env")));
  const witnessBase = path.join(s.base, "witness-fixture"), core = crearTestigo({ base: path.join(witnessBase, "testigo"), config: inicial.ha.configTestigo });
  const witnessPort = await puertoLibre(), witnessId = "b".repeat(64), respaldoId = "c".repeat(64);
  let servidorW = null, peer = null, peerDb = null, servicioPeer = null;
  s.limpiezas.push(async () => { servicioPeer?.detener(); await cerrar(peer); peerDb?.cerrar(); if (servidorW) await servidorW.cerrar(); else core.cerrar(); });
  async function incorporar(bootstrap, datos) {
    const cuerpo = Buffer.from(JSON.stringify(datos)); const h = firmarPeticion({ grupoId: bootstrap.grupoId, nodoId: datos.nodoId, metodo: "POST", ruta: "/lan/incorporar", cuerpo, clave: bootstrap.incorporacion.clave });
    const r = await pedir(s.https, "/lan/incorporar", { metodo: "POST", cuerpo, ca: s.raiz, headers: { ...h, "X-AJB-Incorporacion": bootstrap.incorporacion.id } });
    assert.equal(r.status, 200, r.json?.mensaje || "Incorporación rechazada"); return descifrarJson(r.buffer, bootstrap.incorporacion.clave);
  }
  const w = await incorporar(inicial.ha, { rol: "Testigo", nodoId: witnessId, nombre: "testigo", url: `http://127.0.0.1:${witnessPort}`, clavePublicaTestigo: core.estado().clave_publica });
  servidorW = crearServidorTestigo({ base: witnessBase, config: { ...w.ha, equipoId: undefined }, testigo: core });
  await new Promise((r) => servidorW.servidor.listen(witnessPort, "127.0.0.1", r));
  const zipR = await pedir(s.http, "/api/sistema/grupo-local/instalador", { metodo: "POST", token: admin, cuerpo: { rol: "Respaldo" } });
  assert.equal(zipR.status, 200); const archivoR = path.join(s.base, "respaldo.zip"); fs.writeFileSync(archivoR, zipR.buffer); const inicialR = leerZip(archivoR);
  peer = https.createServer(s.tlsConfig, (req, res) => { if (servicioPeer) servicioPeer.manejar(req, res).catch(() => res.destroy()); else { res.writeHead(503); res.end(); } });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const respaldo = await incorporar(inicialR.ha, { rol: "Respaldo", nodoId: respaldoId, nombre: "respaldo", url: `https://127.0.0.1:${peer.address().port}`, caPublica: s.raiz });
  const peerBase = path.join(s.base, "peer-fixture"); peerDb = crearSqlite(path.join(peerBase, "datos", "predio.db"), { predioId: 1 }); asegurarEsquema(peerDb);
  servicioPeer = crearServicioLan({ base: peerBase, config: respaldo.configPredio, db: peerDb, ha: respaldo.ha });
  assert.equal((await pedir(s.http, "/api/sistema/grupo-local", { token: admin })).json.puedeActivar, true);
  const activo = await pedir(s.http, "/api/sistema/grupo-local/activar", { metodo: "POST", token: admin, cuerpo: {}, timeout: 90000 });
  assert.equal(activo.status, 200, activo.json?.mensaje || s.salida); assert.equal(activo.json.activado, true);
  if (s.hijo.exitCode === null) await Promise.race([once(s.hijo, "exit"), esperar(7000)]);
  assert.equal(s.hijo.exitCode, 75); assert.equal(fs.existsSync(path.join(s.base, "ha-activacion-pendiente.json")), false);
  await s.iniciar();
  let salud;
  for (let i = 0; i < 60; i++) { salud = await pedir(s.http, "/api/estado-publico", { timeout: 4000 }); if (salud.status === 200 && salud.json.escritura?.autorizado) break; await esperar(300); }
  assert.equal(salud.status, 200, s.salida); assert.equal(salud.json.escritura.autorizado, true, s.salida);
  const sesion = await pedir(s.http, "/api/sesion", { token: admin }); assert.equal(sesion.status, 200); assert.equal(sesion.json.usuario.usuario, "admin");
  const producto = await pedir(s.http, "/api/productos", { metodo: "POST", token: admin, headers: { "X-AJB-Operacion": crypto.randomUUID() }, cuerpo: { nombre: "Producto tras activar", precio_venta_manual: 100, destino: "VENTA_DIRECTA" } });
  assert.equal(producto.status, 200, producto.json?.mensaje || s.salida);
});

test("dos PCs confirman la copia, la caja espera autorización tras el corte y la principal vuelve con los datos del relevo", {
  skip: process.platform !== "win32" || !ipLan, timeout: 120000,
}, async t => {
  const respaldoId = "d".repeat(64);
  const s = await preparar(t, true), caja = await preparar(t, true, respaldoId);
  const origen = `http://${ipLan}:${s.puerto}`, cajaLan = `http://${ipLan}:${caja.puerto}`;
  const rutaGrupo = "/api/sistema/grupo-local", ruta = "/lan/incorporar";
  await s.iniciar();
  const login = await pedir(s.http, "/api/login", { metodo: "POST", cuerpo: { usuario: "admin", password: "fixture-admin" } });
  const token = login.json.token;
  const zip = await pedir(origen, rutaGrupo + "/incorporar-equipo", { metodo: "POST", token, cuerpo: {} });
  assert.equal(zip.status, 200, zip.json?.mensaje);
  const archivo = path.join(s.base, "caja.zip"); fs.writeFileSync(archivo, zip.buffer);
  const { ha } = leerZip(archivo), inc = ha.incorporacion;
  const cuerpo = Buffer.from(JSON.stringify({ rol: "Respaldo", nodoId: respaldoId, nombre: "caja-fixture", url: caja.https, caPublica: caja.raiz }));
  const h = firmarPeticion({ grupoId: ha.grupoId, nodoId: respaldoId, metodo: "POST", ruta, cuerpo, clave: inc.clave });
  const alta = await pedir(`https://${ipLan}:${s.seguro}`, ruta, { metodo: "POST", cuerpo, ca: s.raiz,
    headers: { ...h, "X-AJB-Incorporacion": inc.id } });
  assert.equal(alta.status, 200, alta.json?.mensaje);
  fs.writeFileSync(path.join(caja.base, "predio-ha.json"), JSON.stringify(descifrarJson(alta.buffer, inc.clave).ha));
  await caja.iniciar();
  assert.equal((await pedir(s.http, rutaGrupo, { token })).json.puedeConfigurarManual, true);
  const activo = await pedir(s.http, rutaGrupo + "/configurar-relevo-manual", { metodo: "POST", token, cuerpo: {} });
  assert.equal(activo.status, 200, activo.json?.mensaje || s.salida);
  assert.equal(activo.json.activado, true);
  async function reiniciar(n) {
    if (n.hijo.exitCode === null) await once(n.hijo, "exit");
    assert.equal(n.hijo.exitCode, 75, n.salida);
    await n.iniciar();
  }
  await Promise.all([reiniciar(s), reiniciar(caja)]);
  let respuestaReciente;
  async function esperarHasta(fn, tiempo = 29000) {
    for (let fin = Date.now() + tiempo; Date.now() < fin;) {
      try { const r = await fn(); if (r) return r; } catch (_e) { /* puede estar reiniciándose */ }
      await esperar(250);
    }
    assert.fail(JSON.stringify(respuestaReciente) + "\n" + s.salida + "\n" + caja.salida);
  }
  const grupo = n => pedir(n.http, rutaGrupo, { token, timeout: 9000 });
  const escritor = (n, id) => esperarHasta(async () => {
    const r = await pedir(n.http, "/api/estado-publico", { timeout: 4000 });
    respuestaReciente = { status: r.status, escritura: r.json?.escritura, mensaje: r.json?.mensaje };
    return r.json?.escritura?.equipo_id === id && r.json.escritura.autorizado === true;
  });
  const origenId = JSON.parse(fs.readFileSync(path.join(s.base, "predio-ha.json"))).nodoId;
  await escritor(s, origenId);
  assert.equal((await grupo(s)).json.modo, "manual");
  async function producto(n, nombre) {
    const r = await pedir(n.http, "/api/productos", { metodo: "POST", token, headers: { "X-AJB-Operacion": crypto.randomUUID() },
      cuerpo: { nombre, precio_venta_manual: 100, destino: "VENTA_DIRECTA" } });
    assert.equal(r.status, 200, r.json?.mensaje || n.salida);
  }
  await producto(s, "Último producto antes del corte");
  await s.detener();
  assert.equal((await pedir(cajaLan, "/relevo-manual")).status, 403);
  const pagina = () => pedir(caja.http, "/relevo-manual");
  await esperarHasta(async () => (await pagina()).buffer.toString().includes('name="principalApagada"'));
  assert.equal((await grupo(caja)).status, 503);
  assert.equal((await pedir(caja.http, "/")).status, 303);
  const activar = (usuario, password, origin = caja.http) => pedir(caja.http, "/relevo-manual", { metodo: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    cuerpo: Buffer.from(new URLSearchParams({ usuario, password, principalApagada: "si" }).toString()) });
  assert.equal((await activar("admin", "fixture-admin", s.http)).status, 403);
  assert.equal((await activar("caja", "fixture-caja")).status, 403);
  const registro = JSON.parse(fs.readFileSync(path.join(caja.base, "ha", "relevo-manual", "testigo-estado.json")));
  const ultimaCopia = path.join(caja.base, "ha", "copias", `${registro.ultimo.indice}-${registro.ultimo.sha256}.ajblan`);
  fs.renameSync(ultimaCopia, ultimaCopia + ".prueba");
  try { assert.equal((await activar("admin", "fixture-admin")).status, 503); }
  finally { fs.renameSync(ultimaCopia + ".prueba", ultimaCopia); }
  const autorizado = await activar("admin", "fixture-admin");
  assert.equal(autorizado.status, 200, autorizado.buffer.toString());
  assert.match(autorizado.buffer.toString(), /Relevo autorizado con la revisión [1-9]/);
  await reiniciar(caja);
  await escritor(caja, respaldoId);
  const buscar = (n, nombre) => {
    const db = crearSqlite(path.join(n.base, "datos", "predio.db"), { predioId: 1 });
    try { return db.conexion.prepare("SELECT nombre FROM predio_producto WHERE nombre=?").get(nombre)?.nombre; }
    finally { db.cerrar(); }
  };
  assert.equal(buscar(caja, "Último producto antes del corte"), "Último producto antes del corte");
  await producto(caja, "Producto durante el relevo");
  await s.iniciar();
  await reiniciar(s);
  await escritor(s, origenId);
  assert.equal(buscar(s, "Producto durante el relevo"), "Producto durante el relevo");
  assert.equal((await grupo(s)).json.manualActivo, false);
});

test("la IP descubierta usa el certificado de la misma PC por su nombre", { skip: process.platform !== "win32", timeout: 30000 }, async t => {
  const s = await preparar(t, true);
  const peer = https.createServer(s.tlsConfig, (_req, res) => res.end('{"encontrado":true}'));
  s.limpiezas.push(() => cerrar(peer));
  await new Promise(resolve => peer.listen(0, "127.0.0.2", resolve));
  const miembro = { id: "a".repeat(64), url: s.https, caPublica: s.raiz };
  const nombreTls = os.hostname().toLowerCase();
  const ubicacion = { equipo: () => ({ ip: "127.0.0.2", https: peer.address().port, nombreTls }) };
  const { url, ca, servername } = conectarMiembro(miembro, ubicacion);
  await assert.rejects(pedirLan(url, "/", { metodo: "GET", ca }), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  assert.deepEqual(await pedirLan(url, "/", { metodo: "GET", ca, servername }), { encontrado: true });
});

test("freeze persistente al reiniciar no vuelve a legacy aunque no pueda reanudar automáticamente", { timeout: 30000 }, async (t) => {
  const s = await preparar(t, false); fs.writeFileSync(path.join(s.base, "ha-activacion-pendiente.json"), "{}");
  for (let n = 0; n < 2; n++) {
    await s.iniciar();
    const salud = await pedir(s.http, "/api/estado-publico"); assert.equal(salud.status, 200); assert.equal(salud.json.escritura.autorizado, false);
    const login = await pedir(s.http, "/api/login", { metodo: "POST", cuerpo: { usuario: "admin", password: "fixture-admin" } }); assert.equal(login.status, 200);
    const r = await pedir(s.http, "/api/productos", { metodo: "POST", token: login.json.token, cuerpo: { nombre: "No debe crearse" } });
    assert.equal(r.status, 409); assert.equal(r.json.codigo, "SERVIDOR_SOLO_LECTURA");
    assert.equal(fs.existsSync(path.join(s.base, "ha-activacion-pendiente.json")), true); await s.detener();
  }
});
