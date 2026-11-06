"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const tls = require("node:tls");

function leerTls(base) {
  const dir = path.join(base, "datos", "tls");
  const datos = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8").replace(/^\uFEFF/, ""));
  if (datos.certificado !== "servidor.pfx" || datos.raiz !== "autoridad.cer" || !Number.isSafeInteger(datos.puerto) || datos.puerto < 1 || datos.puerto > 65535) throw new Error("Configuración de HTTPS local no válida");
  const opciones = { pfx: fs.readFileSync(path.join(dir, datos.certificado)), passphrase: String(datos.passphrase || ""), minVersion: "TLSv1.2" };
  tls.createSecureContext(opciones); // valida el PFX antes de abrir o reemplazar un listener
  const raiz = fs.readFileSync(path.join(dir, datos.raiz));
  const certificadoRaiz = new crypto.X509Certificate(raiz);
  const huella = certificadoRaiz.fingerprint256.replace(/:/g, "").toLowerCase();
  if (huella !== String(datos.huella_sha256 || "").replace(/:/g, "").toLowerCase()) throw new Error("La huella del certificado local no coincide");
  return { opciones, raiz, puerto: datos.puerto, hash: crypto.createHash("sha256").update(opciones.pfx).digest("hex"),
    publico: { preparado: true, puerto: datos.puerto, huella_sha256: huella, nombres: datos.nombres || [], raiz_vence: certificadoRaiz.validTo } };
}

async function prepararTls(base) {
  if (process.platform !== "win32" || !fs.existsSync(path.join(base, "arranque.js"))) return;
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(base, "herramientas", "preparar-https.ps1"), "-Base", base],
      { windowsHide: true, timeout: 90000 }, (e, salida, errores) => {
        if (e) reject(new Error(String(errores || e.message).trim().slice(0, 240)));
        else resolve(salida);
      });
  });
}

module.exports = { leerTls, prepararTls };
