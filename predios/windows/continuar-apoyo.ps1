# Completa exclusivamente una instalacion de apoyo creada en esta PC. No copia
# codigo ni reemplaza datos, configuracion, TLS o la firma durable del testigo.
#requires -Version 5.1
param([string]$Base = (Split-Path -Parent $PSScriptRoot), [switch]$Inicial)
$ErrorActionPreference = 'Stop'

function Test-AjbAdministrador {
  $actual = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $actual.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-AjbIdentidadApoyo([string]$Node, [string]$Version) {
  $equipo = (& $Node -e 'process.stdout.write(require(process.argv[1]).identidadEquipo())' (Join-Path $Version 'lib\control-equipo.js') | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $equipo -notmatch '^[a-f0-9]{64}$') { throw 'No se pudo identificar esta PC.' }
  return $equipo
}
function Invoke-AjbIncorporacionApoyo([string]$Node, [string]$Version, [string]$Directorio, [bool]$Reintento = $true) {
  if ($Reintento) { & $Node (Join-Path $Version 'lib\incorporar-apoyo.js') --base $Directorio --continuar }
  else { & $Node (Join-Path $Version 'lib\incorporar-apoyo.js') --base $Directorio }
  if ($LASTEXITCODE -ne 0) { throw 'La incorporacion no se completo. Conserva esta carpeta y usa CONTINUAR-INSTALACION.bat para reintentar con la misma identidad.' }
}
function Get-AjbAccionApoyo([string]$Directorio, [string]$Componente) {
  $node = Join-Path $Directorio 'node\node.exe'
  $argumentosApoyo = if ($Componente -eq 'Respaldo') { '"' + (Join-Path $Directorio 'arranque.js') + '" --automatico' } else { '"' + (Join-Path $Directorio 'arranque-apoyo.js') + '" --base "' + $Directorio + '" --rol ' + $Componente }
  return @{ Node = $node; Argumentos = $argumentosApoyo; Directorio = $Directorio; Nombre = $(if ($Componente -eq 'Respaldo') { 'AJB Predio' } else { 'AJB Predio ' + $Componente }) }
}
function Assert-AjbTareaPropia($Tarea, $Esperada) {
  if (-not $Tarea) { return }
  $acciones = @($Tarea.Actions)
  if ($acciones.Count -ne 1 -or -not $acciones[0].Execute -or -not $acciones[0].WorkingDirectory) { throw 'Ya existe una tarea ajena o no reconocida. No se reemplazo.' }
  if ([IO.Path]::GetFullPath([string]$acciones[0].Execute) -ine [IO.Path]::GetFullPath($Esperada.Node) -or [string]$acciones[0].Arguments -cne $Esperada.Argumentos -or [IO.Path]::GetFullPath([string]$acciones[0].WorkingDirectory) -ine $Esperada.Directorio -or [string]$Tarea.Principal.UserId -notin @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM')) { throw 'Ya existe una tarea de otra instalacion. No se reemplazo ni inicio.' }
}
function Set-AjbFirewallApoyo([string]$Grupo, [string]$Rol, [int]$Puerto) {
  $nombre = 'AJB-Predio-Apoyo-' + $Grupo + '-' + $Rol + '-' + $Puerto
  $regla = Get-NetFirewallRule -Name $nombre -ErrorAction SilentlyContinue
  if ($regla) {
    $port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $regla
    $address = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $regla
    if (@($regla).Count -ne 1 -or [string]$regla.Direction -ne 'Inbound' -or [string]$regla.Action -ne 'Allow' -or [string]$port.LocalPort -ne [string]$Puerto -or [string]$port.Protocol -notin @('TCP','6') -or [string]$address.RemoteAddress -ne 'LocalSubnet') { throw 'La regla de red existente no corresponde a este apoyo. No se modifico.' }
    return
  }
  New-NetFirewallRule -Name $nombre -DisplayName ('AJB Predio ' + $Rol + ' ' + $Puerto + ' (' + $Grupo + ')') -Direction Inbound -Protocol TCP -LocalPort $Puerto -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
}
function Set-AjbAccesoApoyo([string]$Directorio) { & (Join-Path $Directorio 'herramientas\configurar-acceso-caja.ps1') -Direccion 'http://127.0.0.1:8091' }
function Get-AjbInstalacionAnterior($Tarea, [string]$Directorio) {
  if (-not $Tarea) { return $null }
  $acciones = @($Tarea.Actions)
  if ($acciones.Count -ne 1) { return $null }
  $anterior = 'C:\AJB-Predio'
  if ([string]$acciones[0].WorkingDirectory -ine $anterior -or (Test-Path -LiteralPath (Join-Path $anterior 'predio-ha.json')) -or
      (Test-Path -LiteralPath (Join-Path $anterior 'ha-activacion-pendiente.json'))) { return $null }
  Assert-AjbTareaPropia $Tarea (Get-AjbAccionApoyo $anterior 'Respaldo')
  $viejo = Get-Content -LiteralPath (Join-Path $anterior 'config.json') -Raw | ConvertFrom-Json
  $nuevo = Get-Content -LiteralPath (Join-Path $Directorio 'config.json') -Raw | ConvertFrom-Json
  if (-not $viejo.predio_id -or $viejo.predio_id -ne $nuevo.predio_id) { return $null }
  return $anterior
}
function Invoke-AjbServidorApoyo([string]$Directorio) {
  @{ autoarranque = $true; detenido = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directorio 'runtime.json') -Encoding UTF8
  & (Join-Path $Directorio 'herramientas\control-servidor.ps1') -Base $Directorio -Accion Iniciar
}
function Continuar-AjbApoyo([string]$Directorio, [switch]$Inicial) {
  if (-not (Test-AjbAdministrador)) { throw 'Ejecuta CONTINUAR-INSTALACION.bat como administrador.' }
  $Directorio = [IO.Path]::GetFullPath($Directorio).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $Directorio -PathType Container) -or $Directorio -eq [IO.Path]::GetPathRoot($Directorio).TrimEnd('\')) { throw 'Falta una carpeta de instalacion de apoyo valida.' }
  foreach ($n in @('instalacion-apoyo.json','predio-ha.json','node\node.exe','app\ACTUAL','CONTINUAR-INSTALACION.bat')) { if (-not (Test-Path -LiteralPath (Join-Path $Directorio $n) -PathType Leaf)) { throw ('La carpeta no corresponde a una instalacion de apoyo: falta ' + $n) } }
  if (@(Get-ChildItem -LiteralPath $Directorio -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count) { throw 'La instalacion contiene enlaces no permitidos.' }
  $marca = Get-Content -LiteralPath (Join-Path $Directorio 'instalacion-apoyo.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $ha = Get-Content -LiteralPath (Join-Path $Directorio 'predio-ha.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $version = (Get-Content -LiteralPath (Join-Path $Directorio 'app\ACTUAL') -Raw -Encoding UTF8).Trim()
  if ($version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,100}$' -or $version.Contains('..')) { throw 'La version instalada no es valida.' }
  $carpetaVersion = Join-Path $Directorio ('app\versiones\' + $version)
  foreach ($n in @('lib\control-equipo.js','lib\incorporar-apoyo.js')) { if (-not (Test-Path -LiteralPath (Join-Path $carpetaVersion $n) -PathType Leaf)) { throw 'La aplicacion instalada esta incompleta.' } }
  $rol = [string]$ha.rolInstalacion
  if ($marca.formato -ne 1 -or $rol -notin @('Testigo','Acceso','Respaldo') -or $ha.habilitado -ne $true -or -not $ha.grupoId -or $marca.grupoId -cne $ha.grupoId -or $marca.rol -cne $rol -or $marca.version -cne $version) { throw 'La marca de instalacion no coincide con el grupo, rol y version de esta carpeta.' }
  $node = Join-Path $Directorio 'node\node.exe'
  $equipo = Get-AjbIdentidadApoyo $node $carpetaVersion
  if ($ha.equipoId -cne $equipo -or $marca.equipoId -cne $equipo) { throw 'Esta instalacion pertenece a otra PC. No se cambia su identidad ni se inicia.' }
  $roles = if ($rol -eq 'Testigo') { @('Testigo','Acceso') } elseif ($rol -eq 'Acceso') { @('Acceso') } else { @('Respaldo') }
  $unificado = $rol -eq 'Respaldo' -and ($ha.quorumPendiente -or $ha.quorum)
  $anterior = $null
  foreach ($componente in $roles) {
    $esperada = Get-AjbAccionApoyo $Directorio $componente
    $existente = Get-ScheduledTask -TaskName $esperada.Nombre -ErrorAction SilentlyContinue
    if ($unificado) { $anterior = Get-AjbInstalacionAnterior $existente $Directorio }
    if (-not $anterior) { Assert-AjbTareaPropia $existente $esperada }
  }
  if ($ha.incorporacion) {
    if ($ha.incorporacion.id -cne $marca.incorporacionId) { throw 'El permiso pendiente no coincide con esta instalacion.' }
    Invoke-AjbIncorporacionApoyo $node $carpetaVersion $Directorio (-not $Inicial)
    $ha = Get-Content -LiteralPath (Join-Path $Directorio 'predio-ha.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  if ($ha.incorporacion -or $ha.equipoId -cne $equipo -or $ha.grupoId -cne $marca.grupoId -or $ha.rolInstalacion -cne $rol -or -not $ha.clavePublicaTestigo) { throw 'La incorporacion no devolvio la configuracion final de esta PC.' }
  foreach ($componente in $roles) {
    $esperada = Get-AjbAccionApoyo $Directorio $componente
    $existente = Get-ScheduledTask -TaskName $esperada.Nombre -ErrorAction SilentlyContinue
    if ($anterior) {
      if ((Get-AjbInstalacionAnterior $existente $Directorio) -ne $anterior) { throw 'Cambio la instalacion anterior. Se conservaron sus archivos.' }
    } else { Assert-AjbTareaPropia $existente $esperada }
  }
  if ($rol -eq 'Acceso' -and ($ha.clave -or $ha.claveDatos -or $ha.claveAdministracion -or $ha.clavePrivadaTestigo -or @($ha.miembros | Where-Object { $_.clave }).Count)) { throw 'El acceso de caja debe contener solo configuracion publica.' }
  if ($rol -eq 'Respaldo') {
    foreach ($n in @('config.json','arranque.js','herramientas\control-servidor.ps1')) { if (-not (Test-Path -LiteralPath (Join-Path $Directorio $n) -PathType Leaf)) { throw 'La instalacion de respaldo esta incompleta.' } }
    $puertos = @([int]((Get-Content -LiteralPath (Join-Path $Directorio 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).puerto))
    $tls = Join-Path $Directorio 'datos\tls\config.json'
    if (-not (Test-Path -LiteralPath $tls -PathType Leaf)) { throw 'Falta HTTPS del respaldo. No se inicia sin completar TLS.' }
    $puertos += [int]((Get-Content -LiteralPath $tls -Raw -Encoding UTF8 | ConvertFrom-Json).puerto)
    if ($unificado) { $puertos += 39878 }
  } elseif ($rol -eq 'Testigo') { $puertos = @(([uri]$ha.testigo.url).Port) } else { $puertos = @() }
  foreach ($puerto in @($puertos | Select-Object -Unique)) { if ($puerto -lt 1 -or $puerto -gt 65535) { throw 'Un puerto del apoyo no es valido.' }; Set-AjbFirewallApoyo ([string]$ha.grupoId) $rol $puerto }
  if ($rol -eq 'Respaldo') {
    if ($anterior) { & (Join-Path $Directorio 'herramientas\control-servidor.ps1') -Base $anterior -Accion Detener }
    Invoke-AjbServidorApoyo $Directorio
  }
  else {
    if (-not (Test-Path -LiteralPath (Join-Path $Directorio 'arranque-apoyo.js') -PathType Leaf)) { throw 'Falta el supervisor de apoyo instalado.' }
    foreach ($componente in $roles) {
      $esperada = Get-AjbAccionApoyo $Directorio $componente
      $existente = Get-ScheduledTask -TaskName $esperada.Nombre -ErrorAction SilentlyContinue
      Assert-AjbTareaPropia $existente $esperada
      if (-not $existente) {
        $accion = New-ScheduledTaskAction -Execute $esperada.Node -Argument $esperada.Argumentos -WorkingDirectory $Directorio
        $quien = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $opciones = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $esperada.Nombre -Action $accion -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $quien -Settings $opciones -Description ('AJB Predio: ' + $componente + ' local.') | Out-Null
      }
      Start-ScheduledTask -TaskName $esperada.Nombre
    }
    Set-AjbAccesoApoyo $Directorio
  }
  $marca | Add-Member -MemberType NoteProperty -Name completada -Value $true -Force
  $marca | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $Directorio 'instalacion-apoyo.json') -Encoding UTF8
  Write-Output ('Instalacion de ' + $rol + ' completada. Se conservaron la identidad, certificados y datos de ' + $Directorio + '.')
}

if ($MyInvocation.InvocationName -ne '.') { Continuar-AjbApoyo $Base -Inicial:$Inicial }
