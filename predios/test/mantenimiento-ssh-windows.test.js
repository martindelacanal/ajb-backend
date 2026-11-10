"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const windows = process.platform === "win32";
const instalador = path.resolve(__dirname, "../windows/configurar-mantenimiento-ssh.ps1");
const reconexion = path.resolve(__dirname, "../windows/mantener-tunel-ssh.ps1");
const literal = s => `'${s.replace(/'/g, "''")}'`;
function powershell(script) {
  const env = { ...process.env };
  // Si node se lanza desde pwsh 7, su PSModulePath puede cargar modulos
  // incompatibles en Windows PowerShell 5.1. Permitir que 5.1 use sus rutas.
  for (const k of Object.keys(env)) if (k.toLowerCase() === "psmodulepath") delete env[k];
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 15000, env }).trim();
}

test("scripts de mantenimiento conservan sintaxis de Windows PowerShell 5.1", { skip: !windows }, () => {
  const salida = powershell(`
    $ErrorActionPreference = 'Stop'
    foreach ($archivo in @(${literal(instalador)}, ${literal(reconexion)})) {
      $errores = $null
      [System.Management.Automation.Language.Parser]::ParseFile($archivo, [ref]$null, [ref]$errores) | Out-Null
      if ($errores.Count) { throw ($errores -join '; ') }
    }
    'OK'
  `);
  assert.equal(salida, "OK");
});

test("plan OpenSSH rechaza servicing activo y estados pendientes antes de instalar", { skip: !windows }, () => {
  // Se ejecuta exclusivamente la decision pura extraida del script real.
  // No se ejecutan el instalador, DISM, servicios, tareas ni cambios de cuentas.
  const salida = powershell(`
    $ErrorActionPreference = 'Stop'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(${literal(instalador)}, [ref]$null, [ref]$null)
    $funcion = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Plan-CapacidadesOpenSsh' }, $true)
    if (-not $funcion) { throw 'Falta la decision de capacidades' }
    Invoke-Expression $funcion.Extent.Text
    function Estado([string]$Tipo, [string]$Valor) { @{ Name = 'OpenSSH.' + $Tipo + '~~~~0.0.1.0'; State = $Valor } }
    function Rechazo($Estados, $Procesos, [int]$Codigo) {
      $recibido = $null
      try { Plan-CapacidadesOpenSsh $Estados $Procesos | Out-Null } catch { $recibido = $_.Exception.HResult }
      if ($recibido -ne $Codigo) { throw ('Rechazo incorrecto: ' + $recibido) }
    }
    $listas = @((Estado 'Client' 'Installed'), (Estado 'Server' 'Installed'))
    if (@(Plan-CapacidadesOpenSsh $listas).Count -ne 0) { throw 'Reinstala capacidades disponibles' }
    foreach ($estado in @('NotPresent', 'Staged')) {
      $plan = @(Plan-CapacidadesOpenSsh @((Estado 'Client' 'Installed'), (Estado 'Server' $estado)))
      if ($plan.Count -ne 1 -or $plan[0] -ne 'OpenSSH.Server~~~~0.0.1.0') { throw 'Plan incorrecto' }
    }
    foreach ($pendiente in @('InstallPending', 'UninstallPending', 'PartiallyInstalled')) {
      # Incluso si el cliente falta, no producir un plan parcial antes del rechazo.
      Rechazo @((Estado 'Client' 'NotPresent'), (Estado 'Server' $pendiente)) @() -2147021886
    }
    foreach ($proceso in @('TiWorker.exe', 'dism.exe', 'DISMHOST.EXE')) {
      Rechazo @() @($proceso) -2147023278
    }
    $rechazoDesconocido = $false
    try { Plan-CapacidadesOpenSsh @((Estado 'Client' 'EstadoDesconocido')) | Out-Null } catch { $rechazoDesconocido = $true }
    if (-not $rechazoDesconocido) { throw 'Acepta un estado desconocido' }
    'OK'
  `);
  assert.equal(salida, "OK");
});

test("alta de cuenta usa parametros aceptados por New-LocalUser en PowerShell 5.1", { skip: !windows }, () => {
  const salida = powershell(`
    $ErrorActionPreference = 'Stop'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(${literal(instalador)}, [ref]$null, [ref]$null)
    $comando = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'New-LocalUser' }, $true)
    if (-not $comando) { throw 'Falta el comando de alta de usuario' }
    $usuarioNombre = 'ajbmantenimiento'
    $password = ConvertTo-SecureString 'A9!a_ParametroSoloWhatIf_NoSeCreaCuenta' -AsPlainText -Force
    try {
      # WhatIf valida el comando real sin crear ni modificar ninguna cuenta.
      $WhatIfPreference = $true
      Invoke-Expression ($comando.Extent.Text + ' -WhatIf -ErrorAction Stop') | Out-Null
    } finally { $password.Dispose() }
    'PARAMETROS_VALIDOS'
  `);
  assert.match(salida, /PARAMETROS_VALIDOS$/);
});
