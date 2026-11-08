"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const WINDOWS = process.platform === "win32";
const SCRIPTS = path.join(__dirname, "..", "windows");

function powershell(codigo, entorno = {}) {
  const script = "$ProgressPreference = 'SilentlyContinue'\n" + codigo;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", env: { ...process.env, AJB_HTTPS_SCRIPTS: SCRIPTS, ...entorno }, timeout: 30000,
  }).trim();
}

test("los scripts de red son compatibles con el parser de Windows PowerShell 5.1", { skip: !WINDOWS }, () => {
  const salida = powershell(`
    $ErrorActionPreference = 'Stop'
    foreach ($archivo in @('preparar-https.ps1', 'confiar-certificado.ps1', 'configurar-acceso-caja.ps1', 'instalar.ps1', 'configurar-coordinacion-lan.ps1')) {
      $tokens = $null; $errores = $null
      [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:AJB_HTTPS_SCRIPTS $archivo), [ref]$tokens, [ref]$errores) | Out-Null
      if ($errores.Count) { throw ($errores | Out-String) }
    }
    Write-Output 'AST_OK'
  `);
  assert.equal(salida, "AST_OK");
});

test("reinstalar conserva las reglas de respaldo y repara TCP y descubrimiento del grupo existente", { skip: !WINDOWS }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-reglas-lan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "herramientas"));
  fs.copyFileSync(path.join(SCRIPTS, "configurar-coordinacion-lan.ps1"), path.join(dir, "herramientas", "configurar-coordinacion-lan.ps1"));
  fs.writeFileSync(path.join(dir, "predio-ha.json"), JSON.stringify({ habilitado: true, quorum: { puerto: 39878 } }));
  const salida = powershell(`
    $ErrorActionPreference = 'Stop'
    $Destino = $env:AJB_REGLAS_FIXTURE
    $Puerto = 8080
    function Paso($texto) {}
    function Ok($texto) {}
    $reglas = @{
      respaldo = @{ Name = 'respaldo'; DisplayName = 'AJB Predio Respaldo 39878 (grupo)' }
      webVieja = @{ Name = 'webVieja'; DisplayName = 'AJB Predio (puerto 8081)' }
      'AJB-Predio-Ubicacion-Quorum' = @{ Name = 'AJB-Predio-Ubicacion-Quorum'; DisplayName = 'AJB Predio Ubicacion LAN'; Enabled = 'False' }
    }
    function Get-NetFirewallRule($Name, $DisplayName, $ErrorAction) {
      if ($Name) { return $reglas[$Name] }
      foreach ($r in $reglas.Values) {
        if (@($DisplayName | Where-Object { $r.DisplayName -like $_ }).Count) { $r }
      }
    }
    function Remove-NetFirewallRule {
      begin { $bajas = @() }
      process { $bajas += $_.Name }
      end { foreach ($baja in $bajas) { $reglas.Remove($baja) } }
    }
    function New-NetFirewallRule($Name, $DisplayName, $Direction, $Protocol, $LocalPort, $RemoteAddress, $Action, $Profile, $Enabled) {
      if (-not $Name) { $Name = $DisplayName }
      if ($reglas.ContainsKey($Name)) { throw "Regla duplicada: $Name" }
      $reglas[$Name] = $PSBoundParameters + @{ NombreInterno = $Name }
      $reglas[$Name]['Name'] = $Name
    }
    function Set-NetFirewallRule($Name, $Direction, $Protocol, $LocalPort, $RemoteAddress, $Action, $Profile, $Enabled) {
      $etiqueta = $reglas[$Name].DisplayName
      $reglas.Remove($Name)
      New-NetFirewallRule @PSBoundParameters -DisplayName $etiqueta
    }
    $instalador = Get-Content -LiteralPath (Join-Path $env:AJB_HTTPS_SCRIPTS 'instalar.ps1') -Raw
    $fragmento = [regex]::Match($instalador, '(?ms)^# --- Firewall\r?\n(.*?)^# --- Energ').Groups[1].Value
    if (-not $fragmento) { throw 'No se encontro la preparacion de firewall' }
    $configurar = [ScriptBlock]::Create($fragmento)
    & $configurar
    & $configurar
    $reglas | ConvertTo-Json -Compress
  `, { AJB_REGLAS_FIXTURE: dir });
  const reglas = JSON.parse(salida);
  assert.ok(reglas.respaldo);
  assert.equal(reglas.webVieja, undefined);
  const tcp = reglas["AJB-Predio-Coordinacion-LAN"], udp = reglas["AJB-Predio-Ubicacion-Quorum"];
  assert.deepEqual([tcp.Protocol, tcp.LocalPort, tcp.RemoteAddress, tcp.Enabled], ["TCP", 39878, "LocalSubnet", "True"]);
  assert.deepEqual([udp.Protocol, udp.LocalPort, udp.RemoteAddress, udp.Enabled], ["UDP", 39879, "LocalSubnet", "True"]);
});

test("la preparación instala y actualiza el acceso compartido sin abrir el navegador del instalador", { skip: !WINDOWS }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-acceso-caja-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const salida = powershell(`
    $ErrorActionPreference = 'Stop'
    $tokens=$null; $errores=$null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:AJB_HTTPS_SCRIPTS 'configurar-acceso-caja.ps1'), [ref]$tokens, [ref]$errores)
    foreach ($funcion in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
      . ([ScriptBlock]::Create($funcion.Extent.Text))
    }
    $plantilla = Get-Content (Join-Path $env:AJB_HTTPS_SCRIPTS 'crear-acceso-pc-caja.bat') -Raw
    $programa = Join-Path $env:AJB_ACCESO_FIXTURE 'programa'
    $escritorio = (New-Item -Path (Join-Path $env:AJB_ACCESO_FIXTURE 'escritorio') -ItemType Directory).FullName
    foreach ($direccion in @('http://localhost:8080','https://camping:8443','https://camping:8443')) {
      Set-AjbAccesoCaja (Get-AjbLanzadorCaja $direccion $plantilla) $programa $escritorio
    }
    $resultado = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $escritorio 'Sistema del Camping - Caja.lnk'))
    $rechazo = $false
    try { Get-AjbLanzadorCaja 'https://camping%PATH%' $plantilla | Out-Null } catch { $rechazo = $true }
    @{destino=$resultado.TargetPath; argumentos=$resultado.Arguments; rechazo=$rechazo} | ConvertTo-Json -Compress
  `, { AJB_ACCESO_FIXTURE: dir });
  const r = JSON.parse(salida);
  assert.equal(r.destino, path.join(dir, "programa", "abrir-caja.bat"));
  assert.equal(r.argumentos, "--abrir");
  assert.equal(r.rechazo, true);
  const bat = fs.readFileSync(r.destino, "ascii");
  assert.ok(bat.includes('set "AJB_DIRECCION=https://camping:8443/"'));
  assert.ok(bat.includes("--kiosk-printing --use-system-default-printer"));
  assert.ok(bat.includes('--user-data-dir=%LOCALAPPDATA%\\AJB-Predio\\Caja\\%%~nN'));
});

test("SAN incluye DNS e IP como tipos distintos, descarta direcciones invalidas y rechaza inyecciones", { skip: !WINDOWS }, () => {
  const salida = powershell(`
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errores = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:AJB_HTTPS_SCRIPTS 'preparar-https.ps1'), [ref]$tokens, [ref]$errores)
    foreach ($nombre in @('Get-AjbNombresCertificado', 'Get-AjbExtensionesSan', 'New-AjbSecreto', 'Get-AjbPuertoTls')) {
      $funcion = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $nombre }, $true)
      . ([scriptblock]::Create($funcion.Extent.Text))
    }
    $nombres = @(Get-AjbNombresCertificado 'CAMPING-01' @('192.168.1.15', '192.168.1.15', 'fe80::123%7', 'invalida', '::', '0.0.0.0'))
    $san = Get-AjbExtensionesSan $nombres
    $rechazado = $false
    try { Get-AjbNombresCertificado 'camping&IPAddress=1.1.1.1' @() | Out-Null } catch { $rechazado = $true }
    $secreto1 = New-AjbSecreto; $secreto2 = New-AjbSecreto
    $puertoGuardado = Get-AjbPuertoTls 8443 $false 9443
    $puertoExplicito = Get-AjbPuertoTls 8443 $true 9443
    @{ nombres = $nombres; san = $san; rechazado = $rechazado; aleatorios_distintos = ($secreto1 -cne $secreto2); bytes_secreto = [Convert]::FromBase64String($secreto1).Length; puerto_guardado = $puertoGuardado; puerto_explicito = $puertoExplicito } | ConvertTo-Json -Compress
  `);
  const r = JSON.parse(salida);
  assert.deepEqual(new Set(r.nombres), new Set(["localhost", "camping-01", "camping-01.local", "127.0.0.1", "::1", "192.168.1.15"]));
  assert.match(r.san, /DNS=camping-01/);
  assert.match(r.san, /IPAddress=192\.168\.1\.15/);
  assert.ok(!r.san.includes("DNS=192.168"));
  assert.equal(r.rechazado, true);
  assert.equal(r.aleatorios_distintos, true);
  assert.equal(r.bytes_secreto, 32);
  assert.equal(r.puerto_guardado, 9443);
  assert.equal(r.puerto_explicito, 8443);
});

test("la confianza verifica una CA fixture y su pin sin abrir ni modificar almacenes Windows", { skip: !WINDOWS }, () => {
  const salida = powershell(`
    $ErrorActionPreference = 'Stop'
    $rutaFixture = Join-Path ([IO.Path]::GetTempPath()) ('ajb-https-fixture-' + [Guid]::NewGuid().ToString('N') + '.cer')
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    $cert = $null
    try {
      $solicitud = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=AJB Predio Raiz 0123456789abcdef0123456789abcdef', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $solicitud.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
      $cert = $solicitud.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-1), [DateTimeOffset]::Now.AddDays(1))
      [IO.File]::WriteAllBytes($rutaFixture, $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $huella = ([BitConverter]::ToString($sha.ComputeHash($cert.RawData))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
      $script = Join-Path $env:AJB_HTTPS_SCRIPTS 'confiar-certificado.ps1'
      $verificado = & $script -Certificado $rutaFixture -HuellaSha256 $huella -SoloVerificar | ConvertFrom-Json
      $rechazado = $false
      try { & $script -Certificado $rutaFixture -HuellaSha256 ('0' * 64) -SoloVerificar | Out-Null } catch { $rechazado = $true }
      @{ valido = $verificado.valido; huella_coincide = ($verificado.huella_sha256 -ceq $huella); pin_incorrecto_rechazado = $rechazado } | ConvertTo-Json -Compress
    } finally {
      if ($cert) { $cert.Dispose() }
      $rsa.Dispose()
      if (Test-Path -LiteralPath $rutaFixture) { Remove-Item -LiteralPath $rutaFixture -Force }
    }
  `);
  assert.deepEqual(JSON.parse(salida), { valido: true, huella_coincide: true, pin_incorrecto_rechazado: true });
});
