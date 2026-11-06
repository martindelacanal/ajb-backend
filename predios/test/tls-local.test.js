"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { execFileSync } = require("node:child_process");
const { leerTls } = require("../lib/tls-local");

test("HTTPS local valida PFX, SAN, confianza de CA y pin sin exponer contraseñas", { skip: process.platform !== "win32" }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-tls-fixture-"));
  const dir = path.join(base, "datos", "tls");
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const passphrase = "fixture-only-pfx-password";
  // CertificateRequest crea todo en memoria; no se abren almacenes Windows.
  const script = `
    $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
    $rootKey = [Security.Cryptography.RSA]::Create(2048)
    $leafKey = [Security.Cryptography.RSA]::Create(2048)
    $root = $null; $leaf = $null; $leafConClave = $null; $rootPublica = $null
    try {
      $hash = [Security.Cryptography.HashAlgorithmName]::SHA256
      $padding = [Security.Cryptography.RSASignaturePadding]::Pkcs1
      $rootReq = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=AJB TLS Test CA', $rootKey, $hash, $padding)
      $rootReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
      $rootReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign, $true))
      $root = $rootReq.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5), [DateTimeOffset]::Now.AddDays(2))
      $leafReq = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $leafKey, $hash, $padding)
      $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
      $san.AddDnsName('localhost'); $san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'))
      $leafReq.CertificateExtensions.Add($san.Build())
      $leafReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
      $eku = [Security.Cryptography.OidCollection]::new()
      $eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
      $leafReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true))
      $leaf = $leafReq.Create($root, [DateTimeOffset]::Now.AddMinutes(-1), [DateTimeOffset]::Now.AddDays(1), [byte[]]@(1,2,3,4,5,6,7,8))
      $leafConClave = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($leaf, $leafKey)
      $rootPublica = [Security.Cryptography.X509Certificates.X509Certificate2]::new($root.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
      $coleccion = [Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
      $coleccion.Add($leafConClave) | Out-Null; $coleccion.Add($rootPublica) | Out-Null
      [IO.File]::WriteAllBytes((Join-Path $env:AJB_TLS_FIXTURE_DIR 'servidor.pfx'), $coleccion.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:AJB_TLS_FIXTURE_PASSWORD))
      [IO.File]::WriteAllBytes((Join-Path $env:AJB_TLS_FIXTURE_DIR 'autoridad.cer'), $rootPublica.RawData)
    } finally {
      foreach ($objeto in @($rootPublica, $leafConClave, $leaf, $root, $leafKey, $rootKey)) { if ($objeto) { $objeto.Dispose() } }
    }
  `;
  execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 30000, env: { ...process.env, AJB_TLS_FIXTURE_DIR: dir, AJB_TLS_FIXTURE_PASSWORD: passphrase },
  });
  const raiz = fs.readFileSync(path.join(dir, "autoridad.cer"));
  const ca = new crypto.X509Certificate(raiz);
  const config = { puerto: 8443, certificado: "servidor.pfx", raiz: "autoridad.cer", passphrase, huella_sha256: ca.fingerprint256.replace(/:/g, "").toLowerCase(), nombres: ["localhost", "127.0.0.1"] };
  const archivoConfig = path.join(dir, "config.json");
  fs.writeFileSync(archivoConfig, JSON.stringify(config));
  const tls = leerTls(base);
  assert.equal(tls.publico.preparado, true);
  assert.equal(tls.publico.huella_sha256, config.huella_sha256);
  assert.ok(!JSON.stringify(tls.publico).includes(passphrase));
  assert.ok(!JSON.stringify(tls.publico).includes("passphrase"));
  const servidor = https.createServer(tls.opciones, (_req, res) => res.end("HTTPS_OK"));
  servidor.on("tlsClientError", () => {});
  await new Promise((resolve, reject) => { servidor.once("error", reject); servidor.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { servidor.closeAllConnections(); servidor.close(resolve); }));
  function consultar(confiar) {
    return new Promise((resolve, reject) => {
      const req = https.get({ hostname: "127.0.0.1", port: servidor.address().port, servername: "localhost", ca: confiar, rejectUnauthorized: true, agent: false }, (res) => {
        let body = ""; res.on("data", (d) => { body += d; }); res.on("end", () => resolve({ body, autorizado: res.socket.authorized }));
      });
      req.on("error", reject);
    });
  }
  assert.deepEqual(await consultar(ca.toString()), { body: "HTTPS_OK", autorizado: true });
  await assert.rejects(consultar([]), (e) => ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(e.code));
  fs.writeFileSync(archivoConfig, JSON.stringify({ ...config, huella_sha256: "0".repeat(64) }));
  assert.throws(() => leerTls(base), /huella/);
});
