"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
async function hasta(fn, limite = 5000) {
  const inicio = Date.now();
  while (!fn()) { if (Date.now() - inicio > limite) throw new Error("El lanzador ficticio no respondió a tiempo"); await esperar(20); }
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-lanzador-ha-"));
  fs.mkdirSync(path.join(base, "app", "versiones"), { recursive: true });
  fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ predio_id: 99, predio_codigo: path.basename(base) }));
  fs.copyFileSync(path.join(__dirname, "../lanzador.js"), path.join(base, "arranque.js"));
  let hijo;
  t.after(async () => {
    if (hijo && hijo.exitCode === null) {
      fs.writeFileSync(path.join(base, "runtime.json"), '{"detenido":true}');
      const cerrado = once(hijo, "exit");
      const timer = setTimeout(() => hijo.kill("SIGKILL"), 2000);
      try { await cerrado; } finally { clearTimeout(timer); }
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  function version(nombre, { ha = false, falla = false, raiz = false } = {}) {
    const carpeta = raiz ? base : path.join(base, "app", "versiones", nombre);
    fs.mkdirSync(carpeta, { recursive: true });
    if (ha) { fs.mkdirSync(path.join(carpeta, "lib"), { recursive: true }); fs.writeFileSync(path.join(carpeta, "lib", "servicio-lan.js"), "// fixture compatible"); }
    fs.writeFileSync(path.join(carpeta, "servidor.js"), `const fs=require('node:fs'),path=require('node:path');const base=process.argv[process.argv.indexOf('--base')+1];fs.appendFileSync(path.join(base,${JSON.stringify(nombre + ".txt")}),"inicio\\n");process.exit(${falla ? 1 : 0});`);
  }
  return { base, version,
    marca(nombre, valor) { fs.writeFileSync(path.join(base, nombre), valor); },
    inicios(nombre) { try { return fs.readFileSync(path.join(base, nombre + ".txt"), "utf8").split("inicio").length - 1; } catch (_e) { return 0; } },
    iniciar() { hijo = spawn(process.execPath, [path.join(base, "arranque.js"), "--base", base], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); hijo.stdout.resume(); hijo.stderr.resume(); },
    logs() { const carpeta = path.join(base, "logs"); return fs.existsSync(carpeta) ? fs.readdirSync(carpeta).map(n => fs.readFileSync(path.join(carpeta, n), "utf8")).join("") : ""; },
  };
}

test("con configuración HA incluso ilegible no inicia versiones legacy ni el fallback de la carpeta raíz", async t => {
  const s = fixture(t);
  s.version("vieja"); s.version("fallback", { raiz: true });
  s.marca("app/ACTUAL", "vieja"); s.marca("app/PENDIENTE", "vieja"); s.marca("predio-ha.json", "JSON incompleto");
  s.iniciar(); await hasta(() => /requiere una versión compatible/.test(s.logs()));
  assert.equal(s.inicios("vieja"), 0); assert.equal(s.inicios("fallback"), 0);
});

test("una activación pendiente sin archivo HA también bloquea servidores anteriores", async t => {
  const s = fixture(t); s.version("vieja"); s.marca("app/ACTUAL", "vieja"); s.marca("ha-activacion-pendiente.json", "{}");
  s.iniciar(); await hasta(() => /requiere una versión compatible/.test(s.logs()));
  assert.equal(s.inicios("vieja"), 0);
});

test("una versión compatible arranca en HA y una actualización legacy pendiente se descarta", async t => {
  const s = fixture(t); s.version("actual", { ha: true }); s.version("vieja");
  s.marca("app/ACTUAL", "actual"); s.marca("app/PENDIENTE", "vieja"); s.marca("predio-ha.json", '{"habilitado":false}');
  s.iniciar(); await hasta(() => s.inicios("actual") === 1);
  assert.equal(s.inicios("vieja"), 0); assert.equal(fs.readFileSync(path.join(s.base, "app", "ACTUAL"), "utf8"), "actual");
});

test("dos fallos de la versión en prueba no vuelven al anterior sin control LAN", async t => {
  const s = fixture(t); s.version("actual", { ha: true, falla: true }); s.version("vieja");
  s.marca("app/ACTUAL", "actual"); s.marca("app/EN_PRUEBA", "actual"); s.marca("app/ANTERIOR", "vieja"); s.marca("predio-ha.json", "{}");
  s.iniciar(); await hasta(() => s.inicios("actual") >= 2);
  assert.equal(s.inicios("vieja"), 0); assert.equal(fs.readFileSync(path.join(s.base, "app", "ACTUAL"), "utf8"), "actual");
});

test("el fallback raíz sólo puede ejecutarse en HA cuando también incluye el servicio LAN", async t => {
  const s = fixture(t); s.version("fallback", { raiz: true, ha: true }); s.marca("predio-ha.json", "{}");
  s.iniciar(); await hasta(() => s.inicios("fallback") === 1);
});

test("una instalación normal sin grupo conserva el arranque de su versión anterior", async t => {
  const s = fixture(t); s.version("vieja"); s.marca("app/ACTUAL", "vieja");
  s.iniciar(); await hasta(() => s.inicios("vieja") === 1);
});
