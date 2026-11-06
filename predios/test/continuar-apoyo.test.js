"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const WINDOWS = process.platform === "win32", DIR = path.join(__dirname, "..", "windows");
function ps(texto, env = {}) { try { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';\n" + texto, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 30000, env: { ...process.env, AJB_CONTINUAR_SCRIPT: path.join(DIR, "continuar-apoyo.ps1"), ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { throw new Error("Prueba PowerShell: " + String(e.stderr || e.code)); } }
function preparar(t, rol = "Testigo") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-continuar-fixture-")), equipo = "a".repeat(64), version = "1.0+fixture";
  for (const n of ["node", "app/versiones/" + version + "/lib", "herramientas", "testigo", "datos/tls"]) fs.mkdirSync(path.join(base, n), { recursive: true });
  for (const n of ["node/node.exe", `app/versiones/${version}/lib/control-equipo.js`, `app/versiones/${version}/lib/incorporar-apoyo.js`, "arranque-apoyo.js", "arranque.js", "CONTINUAR-INSTALACION.bat", "herramientas/control-servidor.ps1"]) fs.writeFileSync(path.join(base, n), "fixture-code");
  fs.writeFileSync(path.join(base, "app/ACTUAL"), version);
  fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ puerto: 8080 }));
  fs.writeFileSync(path.join(base, "datos/tls/config.json"), JSON.stringify({ puerto: 8443, passphrase: "fixture-only" }));
  fs.writeFileSync(path.join(base, "testigo/testigo-firma.json"), "PIN-FIXTURE-CONSERVADO");
  fs.writeFileSync(path.join(base, "instalacion-apoyo.json"), JSON.stringify({ formato: 1, grupoId: "grupo-fixture", rol, version, equipoId: equipo, incorporacionId: "permiso-fixture" }));
  fs.writeFileSync(path.join(base, "predio-ha.json"), JSON.stringify({ habilitado: true, grupoId: "grupo-fixture", rolInstalacion: rol, equipoId: equipo, incorporacion: { id: "permiso-fixture", clave: "b".repeat(64) } }));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, equipo };
}
const MOCKS = `
  . $env:AJB_CONTINUAR_SCRIPT
  $global:AjbTareas=@{}; $global:AjbReglas=@{}; $global:AjbIntentos=0; $global:AjbInicios=0; $global:AjbAccesos=0
  function Test-AjbAdministrador { return $true }
  function Get-AjbIdentidadApoyo { return $env:AJB_CONTINUAR_EQUIPO }
  function Invoke-AjbIncorporacionApoyo([string]$Node,[string]$Version,[string]$Directorio) {
    $global:AjbIntentos++
    if ($global:AjbIntentos -eq 1 -and $env:AJB_CONTINUAR_MODO -eq 'red') { throw 'Red interrumpida' }
    $h=Get-Content -LiteralPath (Join-Path $Directorio 'predio-ha.json') -Raw | ConvertFrom-Json
    $h.PSObject.Properties.Remove('incorporacion'); $h|Add-Member -NotePropertyName clavePublicaTestigo -NotePropertyValue 'PUBLICA-FIXTURE'; $h|Add-Member -NotePropertyName testigo -NotePropertyValue @{url='http://testigo:39877'}
    $h|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $Directorio 'predio-ha.json') -Encoding UTF8
    if ($global:AjbIntentos -eq 1 -and $env:AJB_CONTINUAR_MODO -eq 'final') { throw 'Respuesta final ya guardada; proceso interrumpido' }
  }
  function Get-ScheduledTask { param($TaskName,$ErrorAction); return $global:AjbTareas[$TaskName] }
  function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory); return @{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
  function New-ScheduledTaskPrincipal { return @{UserId='SYSTEM'} }
  function New-ScheduledTaskTrigger { return 'fixture-trigger' }
  function New-ScheduledTaskSettingsSet { return 'fixture-settings' }
  function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description); $global:AjbTareas[$TaskName]=@{Actions=@($Action);Principal=@{UserId='SYSTEM'}} }
  function Start-ScheduledTask { param($TaskName); $global:AjbInicios++ }
  function Get-NetFirewallRule { param($Name,$ErrorAction); return $global:AjbReglas[$Name] }
  function New-NetFirewallRule { param($Name,$DisplayName,$Direction,$Protocol,$LocalPort,$RemoteAddress,$Action,$Profile); $global:AjbReglas[$Name]=@{Direction=$Direction;Action=$Action;LocalPort=$LocalPort;Protocol=$Protocol;RemoteAddress=$RemoteAddress} }
  function Get-NetFirewallPortFilter { param($AssociatedNetFirewallRule); return $AssociatedNetFirewallRule }
  function Get-NetFirewallAddressFilter { param($AssociatedNetFirewallRule); return $AssociatedNetFirewallRule }
  function Set-AjbAccesoApoyo { $global:AjbAccesos++ }
  function Invoke-AjbServidorApoyo { $global:AjbInicios++ }
`;
test("continuación y configurador parsean en Windows PowerShell5.1; el inicio crea acceso de continuación antes de enrolar", { skip: !WINDOWS }, () => {
  assert.equal(ps(`foreach($n in @('configurar-apoyo.ps1','continuar-apoyo.ps1')){ $t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path -Parent $env:AJB_CONTINUAR_SCRIPT) $n),[ref]$t,[ref]$e)|Out-Null;if($e.Count){throw($e|Out-String)} }; 'OK'`), "OK");
  const fuente = fs.readFileSync(path.join(DIR, "configurar-apoyo.ps1"), "utf8");
  assert.ok(fuente.includes("[switch]$Continuar")); assert.ok(fuente.indexOf("instalacion-apoyo.json") < fuente.lastIndexOf("& (Join-Path $Destino 'herramientas\\continuar-apoyo.ps1')"));
  assert.ok(fs.readFileSync(path.join(DIR, "CONTINUAR-INSTALACION.bat"), "utf8").includes("herramientas\\continuar-apoyo.ps1"));
});
for (const modo of ["red", "final"]) test(`reanuda tras ${modo} sin regenerar PIN/TLS/código y completa tareas propias idempotentemente`, { skip: !WINDOWS }, (t) => {
  const s = preparar(t);
  const conservados = ["testigo/testigo-firma.json", "datos/tls/config.json", "arranque-apoyo.js"].map((n) => ({ archivo: path.join(s.base, n), contenido: fs.readFileSync(path.join(s.base, n)) }));
  const salida = JSON.parse(ps(MOCKS + `
    $fallo=$false;try{Continuar-AjbApoyo $env:AJB_CONTINUAR_BASE|Out-Null}catch{$fallo=$true}
    if(-not $fallo -or $global:AjbTareas.Count){throw 'El primer fallo inicio tareas'}
    Continuar-AjbApoyo $env:AJB_CONTINUAR_BASE|Out-Null
    Continuar-AjbApoyo $env:AJB_CONTINUAR_BASE|Out-Null
    @{intentos=$global:AjbIntentos;tareas=$global:AjbTareas.Count;reglas=$global:AjbReglas.Count}|ConvertTo-Json -Compress
  `, { AJB_CONTINUAR_BASE: s.base, AJB_CONTINUAR_EQUIPO: s.equipo, AJB_CONTINUAR_MODO: modo }));
  assert.equal(salida.intentos, modo === "red" ? 2 : 1); assert.equal(salida.tareas, 2); assert.equal(salida.reglas, 1);
  conservados.forEach((c) => assert.deepEqual(fs.readFileSync(c.archivo), c.contenido));
});
test("rechaza tareas ajenas y carpetas de otra PC antes de contactar al principal", { skip: !WINDOWS }, (t) => {
  const s = preparar(t);
  const salida = JSON.parse(ps(MOCKS + `
    $global:AjbTareas['AJB Predio Testigo']=@{Actions=@(@{Execute='C:\\otro\\node.exe';Arguments='otra';WorkingDirectory='C:\\otro'});Principal=@{UserId='SYSTEM'}}
    $rechazo=$false;try{Continuar-AjbApoyo $env:AJB_CONTINUAR_BASE|Out-Null}catch{$rechazo=$true}
    $global:AjbTareas=@{};$h=Get-Content -LiteralPath (Join-Path $env:AJB_CONTINUAR_BASE 'predio-ha.json') -Raw|ConvertFrom-Json;$h.equipoId=('c'*64);$h|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $env:AJB_CONTINUAR_BASE 'predio-ha.json') -Encoding UTF8
    $copia=$false;try{Continuar-AjbApoyo $env:AJB_CONTINUAR_BASE|Out-Null}catch{$copia=$true}
    @{rechazo=$rechazo;copia=$copia;intentos=$global:AjbIntentos;inicios=$global:AjbInicios}|ConvertTo-Json -Compress
  `, { AJB_CONTINUAR_BASE: s.base, AJB_CONTINUAR_EQUIPO: s.equipo }));
  assert.deepEqual(salida, { rechazo: true, copia: true, intentos: 0, inicios: 0 });
});
test("respaldo reanudado conserva TLS y abre los dos puertos sin reglas duplicadas", { skip: !WINDOWS }, (t) => {
  const s = preparar(t, "Respaldo");
  const salida = JSON.parse(ps(MOCKS + `
    Continuar-AjbApoyo $env:AJB_CONTINUAR_BASE|Out-Null
    Continuar-AjbApoyo $env:AJB_CONTINUAR_BASE|Out-Null
    @{intentos=$global:AjbIntentos;puertos=@($global:AjbReglas.Values|ForEach-Object{[int]$_.LocalPort}|Sort-Object)}|ConvertTo-Json -Compress
  `, { AJB_CONTINUAR_BASE: s.base, AJB_CONTINUAR_EQUIPO: s.equipo }));
  assert.equal(salida.intentos, 1); assert.deepEqual(salida.puertos, [8080, 8443]);
});
