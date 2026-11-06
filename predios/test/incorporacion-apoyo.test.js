"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const tls = require("node:tls");
const { execFileSync } = require("node:child_process");
const { enrolarApoyo } = require("../lib/incorporar-apoyo");
const { armarInstaladorApoyo } = require("../lib/instalador-apoyo");
const { crearVerificador } = require("../lib/protocolo-lan");
const { cifrarJson } = require("../lib/http-lan");
const CA = tls.rootCertificates.find((c) => new crypto.X509Certificate(c).ca);
const EQUIPO = "a".repeat(64), CLAVE = "b".repeat(64), GRUPO = "grupo-incorporacion";
function preparar(t, rol = "Respaldo") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-incorporacion-test-")), ahora = 1800000000000;
  const ha = { habilitado: true, grupoId: GRUPO, rolInstalacion: rol, incorporacion: { id: "permiso-unico", clave: CLAVE, principalUrl: "https://principal:8443", caPublica: CA, vence: ahora + 3600000 } };
  fs.writeFileSync(path.join(base, "predio-ha.json"), JSON.stringify(ha));
  fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ predio_id: 1, predio_codigo: "MIRAMAR", puerto: 8080 }));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const final = { habilitado: true, grupoId: GRUPO, equipoId: EQUIPO, rolInstalacion: rol, clavePublicaTestigo: "publica-fixture", testigo: { url: "http://testigo:39877" }, miembros: [] };
  return { base, ahora, ha, final, dependencias: { identidadEquipo: () => EQUIPO, hostname: () => "respaldo", ahora: () => ahora, prepararTls: async () => {}, leerTls: () => ({ raiz: Buffer.from(CA), puerto: 8443 }) } };
}
test("incorpora respaldo por HTTPS/HMAC con CA pública y elimina bootstrap sólo tras respuesta cifrada válida", async (t) => {
  const s = preparar(t), verificador = crearVerificador({ grupoId: GRUPO, miembros: [{ id: EQUIPO, clave: CLAVE }], ahora: () => s.ahora });
  let preparo = false;
  const r = await enrolarApoyo({ base: s.base }, { ...s.dependencias,
    prepararTls: async () => { preparo = true; },
    solicitar: async (peticion) => {
      assert.equal(preparo, true); assert.equal(peticion.url, "https://principal:8443/lan/incorporar");
      assert.equal(peticion.cabeceras["X-AJB-Incorporacion"], "permiso-unico");
      assert.deepEqual(verificador({ metodo: "POST", ruta: "/lan/incorporar", cuerpo: peticion.cuerpo, cabeceras: peticion.cabeceras }), { nodoId: EQUIPO });
      const datos = JSON.parse(peticion.cuerpo);
      assert.equal(datos.url, "https://respaldo:8443"); assert.equal(new crypto.X509Certificate(datos.caPublica).ca, true);
      return cifrarJson({ ha: s.final, configPredio: { predio_id: 1, predio_codigo: "MIRAMAR", token: "cloud-fixture", puerto: 8080 } }, CLAVE);
    },
  });
  assert.equal(r.incorporado, true);
  const final = JSON.parse(fs.readFileSync(path.join(s.base, "predio-ha.json")));
  assert.equal(final.equipoId, EQUIPO); assert.equal(final.incorporacion, undefined);
  assert.equal(JSON.stringify(final).includes(CLAVE), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.base, "config.json"))).token, "cloud-fixture");
});
test("testigo conserva firma creada localmente, sin solicitar un grant durante la incorporación", async (t) => {
  const s = preparar(t, "Testigo"), acciones = [];
  s.ha.configTestigo = { grupoId: GRUPO, revisionInicial: { indice: 0, sha256: "0".repeat(64) }, miembros: [] };
  fs.writeFileSync(path.join(s.base, "predio-ha.json"), JSON.stringify(s.ha));
  const par = crypto.generateKeyPairSync("ed25519"), publica = par.publicKey.export({ type: "spki", format: "pem" });
  await enrolarApoyo({ base: s.base }, { ...s.dependencias,
    crearTestigo: ({ base, config }) => { acciones.push("crear"); assert.equal(base, path.join(s.base, "testigo")); assert.equal(config.revisionInicial.indice, 0); return { estado: () => { acciones.push("estado"); return { clave_publica: publica }; }, cerrar: () => acciones.push("cerrar") }; },
    solicitar: async ({ cuerpo }) => { const p = JSON.parse(cuerpo); assert.equal(p.clavePublicaTestigo, publica); assert.equal(p.url, "http://respaldo:39877"); return cifrarJson({ ha: { ...s.final, clavePublicaTestigo: publica } }, CLAVE); },
  });
  assert.deepEqual(acciones, ["crear", "estado", "cerrar"]);
});
test("rechaza otra PC y permisos vencidos antes de contactar al principal", async (t) => {
  const s = preparar(t); let consultas = 0;
  const dependencias = { ...s.dependencias, solicitar: async () => { consultas++; } };
  s.ha.equipoId = "c".repeat(64); fs.writeFileSync(path.join(s.base, "predio-ha.json"), JSON.stringify(s.ha));
  await assert.rejects(enrolarApoyo({ base: s.base }, dependencias), /otra PC/);
  delete s.ha.equipoId; s.ha.incorporacion.vence = s.ahora - 1; fs.writeFileSync(path.join(s.base, "predio-ha.json"), JSON.stringify(s.ha));
  await assert.rejects(enrolarApoyo({ base: s.base }, dependencias), /venció/);
  assert.equal(consultas, 0);
});
test("una respuesta alterada o para otro grupo nunca reemplaza el bootstrap ni config", async (t) => {
  const s = preparar(t), original = fs.readFileSync(path.join(s.base, "predio-ha.json"), "utf8");
  const roto = cifrarJson({ ha: s.final }, CLAVE); roto[roto.length - 1] ^= 1;
  await assert.rejects(enrolarApoyo({ base: s.base }, { ...s.dependencias, solicitar: async () => roto }), /autenticarse/);
  await assert.rejects(enrolarApoyo({ base: s.base }, { ...s.dependencias, solicitar: async () => cifrarJson({ ha: { ...s.final, grupoId: "otro-grupo" } }, CLAVE) }), /esta PC/);
  assert.equal(fs.readFileSync(path.join(s.base, "predio-ha.json"), "utf8"), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.base, "config.json"))).token, undefined);
});
test("el acceso de caja rechaza credenciales privadas y no inicia TLS ni una base comercial", async (t) => {
  const s = preparar(t, "Acceso");
  const deps = { ...s.dependencias, prepararTls: async () => { throw new Error("No se debe preparar TLS en acceso"); } };
  await assert.rejects(enrolarApoyo({ base: s.base }, { ...deps, solicitar: async () => cifrarJson({ ha: { ...s.final, claveDatos: CLAVE } }, CLAVE) }), /sólo datos públicos/);
  await enrolarApoyo({ base: s.base }, { ...deps, solicitar: async () => cifrarJson({ ha: s.final }, CLAVE) });
  assert.equal(fs.existsSync(path.join(s.base, "datos")), false);
});
test("continuar permite consultar una respuesta ya consumida tras vencer; el servidor sigue decidiendo si el permiso era usado", async (t) => {
  const s = preparar(t); s.ha.incorporacion.vence = s.ahora - 1;
  fs.writeFileSync(path.join(s.base, "predio-ha.json"), JSON.stringify(s.ha));
  let consultas = 0;
  await enrolarApoyo({ base: s.base, continuar: true }, { ...s.dependencias, solicitar: async () => { consultas++; return cifrarJson({ ha: s.final }, CLAVE); } });
  assert.equal(consultas, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(s.base, "predio-ha.json"))).incorporacion, undefined);
});
test("ZIP Windows incluye runtime y código actual pero no base ni credenciales centrales antes de incorporar", { skip: process.platform !== "win32", timeout: 240000 }, async (t) => {
  const s = preparar(t), app = path.join(s.base, "codigo"); fs.mkdirSync(app);
  for (const n of ["lib", "public", "windows"]) fs.mkdirSync(path.join(app, n));
  for (const n of ["package.json", "lanzador.js", "servidor.js", "lib/incorporar-apoyo.js", "lib/.env", "public/index.html", "windows/INSTALAR-APOYO.bat", "windows/configurar-apoyo.ps1", "windows/arranque-apoyo.js", "windows/configurar-acceso-caja.ps1", "windows/crear-acceso-pc-caja.bat", "windows/continuar-apoyo.ps1", "windows/CONTINUAR-INSTALACION.bat"]) fs.writeFileSync(path.join(app, n), "fixture-code");
  const zip = await armarInstaladorApoyo({ base: s.base, dirApp: app, version: "1.0.0+fixture", configInicial: s.ha, configPredio: { predio_id: 1, predio_codigo: "MIRAMAR", puerto: 8080, token: "NO-INCLUIR-CLOUD", servidor: "NO-INCLUIR-SERVIDOR", clave_lan: "NO-INCLUIR-LAN" } });
  const archivo = path.join(s.base, "paquete.zip"); fs.writeFileSync(archivo, zip.buffer);
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:AJB_APOYO_TEST_ZIP); try { $r=[IO.StreamReader]::new($z.GetEntry('config.json').Open()); $c=$r.ReadToEnd(); $r.Dispose(); @{ nombres=@($z.Entries|ForEach-Object{$_.FullName}); config=$c }|ConvertTo-Json -Compress -Depth 5 } finally { $z.Dispose() }";
  const listado = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 30000, env: { ...process.env, AJB_APOYO_TEST_ZIP: archivo } }));
  const nombres = listado.nombres.map((n) => n.replace(/\\/g, "/"));
  assert.ok(nombres.includes("node/node.exe")); assert.ok(nombres.includes("app/ACTUAL")); assert.ok(nombres.includes("app/versiones/1.0.0+fixture/lib/incorporar-apoyo.js"));
  assert.ok(nombres.includes("INSTALAR-APOYO.bat")); assert.ok(nombres.includes("instalador/configurar-apoyo.ps1"));
  assert.ok(nombres.includes("instalador/crear-acceso-pc-caja.bat"));
  assert.ok(nombres.includes("app/versiones/1.0.0+fixture/windows/continuar-apoyo.ps1"));
  assert.ok(nombres.includes("app/versiones/1.0.0+fixture/windows/CONTINUAR-INSTALACION.bat"));
  assert.ok(nombres.every((n) => !n.includes(".env") && !n.endsWith(".db")));
  assert.deepEqual(JSON.parse(listado.config), { predio_id: 1, predio_codigo: "MIRAMAR", puerto: 8080 });
  assert.equal(zip.nombreArchivo.endsWith(".zip"), true);
});
