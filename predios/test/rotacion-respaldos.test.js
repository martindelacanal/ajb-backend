"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { listarRespaldos, rotarRespaldos } = require("../lib/rotacion-respaldos");

test("las últimas 30 copias comparten un límite y no se eliminan archivos ajenos", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "predio-rotacion-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nombres = [];
  for (let i = 0; i < 33; i++) {
    const dia = String(1 + Math.floor(i / 3)).padStart(2, "0");
    const nombre = "predio-2026-08-" + dia + ["", "-09-30-00-manual", "-13-00-00-antes-de-importar"][i % 3] + ".db";
    const archivo = path.join(dir, nombre);
    fs.writeFileSync(archivo, "copia");
    fs.utimesSync(archivo, 1700000000 + i, 1700000000 + i);
    nombres.push(nombre);
  }
  fs.writeFileSync(path.join(dir, "otra-base.db"), "externa");
  rotarRespaldos(dir);
  assert.deepEqual(listarRespaldos(dir).map((c) => c.nombre), nombres.slice(3).reverse());
  assert.equal(fs.readFileSync(path.join(dir, "otra-base.db"), "utf8"), "externa");
});
