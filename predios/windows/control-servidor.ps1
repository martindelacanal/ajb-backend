param(
  [string]$Base = (Split-Path -Parent $PSScriptRoot),
  [ValidateSet('Registrar','Iniciar','Detener','Reiniciar','Configurar')][string]$Accion = 'Registrar',
  [ValidateSet('Activar','Desactivar')][string]$Automatico,
  [switch]$Despachar
)
$ErrorActionPreference = 'Stop'
$Base = [IO.Path]::GetFullPath($Base).TrimEnd('\')
$configArchivo = Join-Path $Base 'config.json'
$arranqueArchivo = Join-Path $Base 'arranque.js'
$nodeArchivo = Join-Path $Base 'node\node.exe'
if (-not (Test-Path -LiteralPath $configArchivo) -or -not (Test-Path -LiteralPath $arranqueArchivo) -or -not (Test-Path -LiteralPath $nodeArchivo)) {
  throw 'La carpeta indicada no contiene una instalacion portable completa del predio.'
}
$identidad = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identidad)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argumentos = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-Base',('"' + $Base + '"'),'-Accion',$Accion)
  if ($Automatico) { $argumentos += @('-Automatico',$Automatico) }
  if ($Despachar) { $argumentos += '-Despachar' }
  $elevado = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentos -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $elevado.ExitCode
}
if ($Despachar) {
  if ($Accion -notin @('Detener','Reiniciar')) { throw 'Solo se despachan acciones de detener o reiniciar.' }
  # Corre fuera del JobObject de la tarea del servidor: detener esa tarea no debe
  # matar al controlador antes de volver a iniciarla.
  $argumentosControl = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Base "' + $Base + '" -Accion ' + $Accion
  $accionControl = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argumentosControl -WorkingDirectory $Base
  $principalControl = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $opcionesControl = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName 'AJB Predio Control' -Action $accionControl -Principal $principalControl -Settings $opcionesControl -Description 'Control manual del servidor AJB Predio; se ejecuta solo a pedido.' -Force | Out-Null
  Start-ScheduledTask -TaskName 'AJB Predio Control'
  Write-Output 'Control del servidor iniciado en una tarea independiente.'
  exit 0
}
$nombreTarea = 'AJB Predio'
$runtimeArchivo = Join-Path $Base 'runtime.json'
$estado = @{ autoarranque = $true; detenido = $false }
if (Test-Path -LiteralPath $runtimeArchivo) {
  $previo = Get-Content -LiteralPath $runtimeArchivo -Raw -Encoding UTF8 | ConvertFrom-Json
  $estado.autoarranque = $previo.autoarranque -ne $false
  $estado.detenido = $previo.detenido -eq $true
}
function Guardar-Estado {
  $temporal = $runtimeArchivo + '.' + $PID + '.tmp'
  $estado | ConvertTo-Json | Set-Content -LiteralPath $temporal -Encoding UTF8
  Move-Item -LiteralPath $temporal -Destination $runtimeArchivo -Force
}
function Registrar-Tarea {
  $accionTarea = New-ScheduledTaskAction -Execute $nodeArchivo -Argument ('"' + $arranqueArchivo + '" --automatico') -WorkingDirectory $Base
  $encender = New-ScheduledTaskTrigger -AtStartup
  $revision = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $quien = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $opciones = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $nombreTarea -Action $accionTarea -Trigger @($encender,$revision) -Principal $quien -Settings $opciones -Description 'AJB Predio: servidor local y recuperacion automatica. Detener deshabilita el arranque hasta que se vuelva a iniciar.' -Force | Out-Null
  if ($estado.autoarranque -and -not $estado.detenido) { Enable-ScheduledTask -TaskName $nombreTarea | Out-Null }
  else { Disable-ScheduledTask -TaskName $nombreTarea | Out-Null }
}
function Procesos-Propios {
  $arranqueRegex = [regex]::Escape($arranqueArchivo)
  $baseRegex = [regex]::Escape($Base)
  $patron = '(?i)(?:"' + $arranqueRegex + '"|' + $arranqueRegex + '(?=\s|$))|--base\s+(?:"' + $baseRegex + '"|' + $baseRegex + '(?=\s|$))'
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $nodeArchivo -and $_.CommandLine -match $patron }
}
function Detener-Propio {
  # La marca permite al servidor cerrar SQLite y al lanzador salir por voluntad propia.
  $estado.detenido = $true
  Guardar-Estado
  $appDir = Join-Path $Base 'app'
  New-Item -ItemType Directory -Path $appDir -Force | Out-Null
  @{ accion = 'DETENER'; fecha = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appDir 'CONTROL') -Encoding UTF8
  for ($i = 0; $i -lt 14; $i++) {
    if (-not @(Procesos-Propios).Count) { break }
    Start-Sleep -Milliseconds 500
  }
  Stop-ScheduledTask -TaskName $nombreTarea -ErrorAction SilentlyContinue
  # Compatibilidad con lanzadores anteriores: nunca se matan procesos por un nombre
  # parcial de carpeta; se valida ejecutable y argumentos de esta instalacion exacta.
  foreach ($proceso in @(Procesos-Propios)) { Stop-Process -Id $proceso.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath (Join-Path $appDir 'CONTROL') -Force -ErrorAction SilentlyContinue
}
switch ($Accion) {
  'Registrar' { Guardar-Estado; Registrar-Tarea }
  'Configurar' {
    if (-not $Automatico) { throw 'Indica -Automatico Activar o Desactivar.' }
    $estado.autoarranque = $Automatico -eq 'Activar'
    Guardar-Estado; Registrar-Tarea
  }
  'Detener' {
    $estado.autoarranque = $false
    Detener-Propio
    Disable-ScheduledTask -TaskName $nombreTarea -ErrorAction SilentlyContinue | Out-Null
  }
  'Reiniciar' {
    Detener-Propio
    $estado.autoarranque = $true; $estado.detenido = $false
    Guardar-Estado; Registrar-Tarea
    Start-ScheduledTask -TaskName $nombreTarea
  }
  'Iniciar' {
    $estado.detenido = $false
    Guardar-Estado; Registrar-Tarea
    if ($estado.autoarranque) { Start-ScheduledTask -TaskName $nombreTarea }
    else { Start-Process -FilePath $nodeArchivo -ArgumentList @('"' + $arranqueArchivo + '"') -WorkingDirectory $Base -WindowStyle Hidden }
  }
}
Write-Output ('Listo: ' + $Accion + '. Arranque automatico: ' + $estado.autoarranque + '. Detenido: ' + $estado.detenido + '.')
