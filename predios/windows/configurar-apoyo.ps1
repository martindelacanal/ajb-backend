# Instala un paquete de apoyo en una carpeta nueva. Nunca reemplaza una
# instalación, importa una base ni asigna autoridad al equipo por haberlo copiado.
#requires -Version 5.1
param(
  [ValidateSet('Testigo','Acceso','Respaldo')][string]$Rol,
  [string]$Destino,
  [switch]$Continuar
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Ejecuta INSTALAR-APOYO.bat como administrador.' }
if ($Continuar) {
  if (-not $Destino) { throw 'Indica -Destino para continuar la misma instalacion.' }
  $continuarScript = Join-Path ([IO.Path]::GetFullPath($Destino)) 'herramientas\continuar-apoyo.ps1'
  if (-not (Test-Path -LiteralPath $continuarScript -PathType Leaf)) { throw 'La carpeta no contiene una instalacion de apoyo recuperable.' }
  & $continuarScript -Base $Destino
  return
}

function Dentro([string]$Ruta, [string]$Raiz) {
  return [IO.Path]::GetFullPath($Ruta).StartsWith(([IO.Path]::GetFullPath($Raiz).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)
}
function Proteger([string]$Ruta) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
    $identidad = New-Object Security.Principal.SecurityIdentifier($sid)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identidad,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  }
  Set-Acl -LiteralPath $Ruta -AclObject $acl
}

$Origen = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'predio-ha.json')) { $PSScriptRoot } else { Split-Path -Parent $PSScriptRoot }
$Origen = [IO.Path]::GetFullPath($Origen).TrimEnd('\')
$archivoHa = Join-Path $Origen 'predio-ha.json'
if (-not (Test-Path -LiteralPath $archivoHa -PathType Leaf)) { throw 'Descomprime el paquete completo antes de ejecutar el instalador.' }
$ha = Get-Content -LiteralPath $archivoHa -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Rol) { $Rol = [string]$ha.rolInstalacion }
if ($Rol -notin @('Testigo','Acceso','Respaldo') -or $ha.habilitado -ne $true -or -not $ha.grupoId) { throw 'El paquete no indica un rol de apoyo y un grupo validos.' }
$roles = if ($Rol -eq 'Testigo') { @('Testigo','Acceso') } elseif ($Rol -eq 'Acceso') { @('Acceso') } else { @() }
$tareas = if ($Rol -eq 'Respaldo') { @('AJB Predio') } else { @($roles | ForEach-Object { 'AJB Predio ' + $_ }) }
foreach ($nombre in $tareas) {
  if (Get-ScheduledTask -TaskName $nombre -ErrorAction SilentlyContinue) { throw "Ya existe la tarea $nombre; no se modifico. Revisa la instalacion existente." }
}
if (-not $Destino) { $Destino = 'C:\AJB-Predio-' + $Rol }
$Destino = [IO.Path]::GetFullPath($Destino).TrimEnd('\')
if ($Destino -eq [IO.Path]::GetPathRoot($Destino).TrimEnd('\') -or $Destino -eq $Origen -or (Dentro $Destino $Origen) -or (Dentro $Origen $Destino)) { throw 'Elige una carpeta nueva separada del paquete descargado.' }
if (Test-Path -LiteralPath $Destino) { throw "La carpeta ya existe: $Destino. No se reemplazo ningun archivo. Elige otra carpeta con -Destino." }
foreach ($n in @('node\node.exe','app\ACTUAL')) { if (-not (Test-Path -LiteralPath (Join-Path $Origen $n) -PathType Leaf)) { throw "El paquete esta incompleto: falta $n." } }
$version = (Get-Content -LiteralPath (Join-Path $Origen 'app\ACTUAL') -Raw -Encoding UTF8).Trim()
if ($version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,100}$' -or $version.Contains('..')) { throw 'La version del paquete no es valida.' }
$versionOrigen = Join-Path $Origen ('app\versiones\' + $version)
if (-not (Dentro $versionOrigen (Join-Path $Origen 'app\versiones')) -or -not (Test-Path -LiteralPath $versionOrigen -PathType Container)) { throw 'Falta la version del sistema en el paquete.' }
if (@(Get-ChildItem -LiteralPath $Origen -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count) { throw 'El paquete contiene enlaces de archivos no permitidos.' }
if (@(Get-ChildItem -LiteralPath $Origen -Recurse -Force -File -Filter '.env').Count) { throw 'El paquete no debe contener archivos .env.' }
if ($Rol -eq 'Acceso') {
  if ($ha.clave -or $ha.claveDatos -or $ha.claveAdministracion -or $ha.clavePrivadaTestigo -or @($ha.miembros | Where-Object { $_.clave }).Count) { throw 'El paquete de acceso debe contener solo configuracion publica.' }
}
if ($Rol -eq 'Respaldo' -and (-not (Test-Path -LiteralPath (Join-Path $Origen 'config.json')) -or -not (Test-Path -LiteralPath (Join-Path $Origen 'arranque.js')))) { throw 'El paquete de respaldo no incluye su configuracion y supervisor.' }
if (-not (Test-Path -LiteralPath (Join-Path $versionOrigen 'lib\incorporar-apoyo.js') -PathType Leaf)) { throw 'El paquete no incluye el proceso de incorporacion del equipo.' }

New-Item -ItemType Directory -Path $Destino | Out-Null
Proteger $Destino
Copy-Item -LiteralPath (Join-Path $Origen 'node') -Destination (Join-Path $Destino 'node') -Recurse
New-Item -ItemType Directory -Path (Join-Path $Destino 'app\versiones') -Force | Out-Null
Copy-Item -LiteralPath $versionOrigen -Destination (Join-Path $Destino ('app\versiones\' + $version)) -Recurse
Copy-Item -LiteralPath (Join-Path $Origen 'app\ACTUAL') -Destination (Join-Path $Destino 'app\ACTUAL')
Copy-Item -LiteralPath $archivoHa -Destination (Join-Path $Destino 'predio-ha.json')
New-Item -ItemType Directory -Path (Join-Path $Destino 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Destino 'herramientas') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $versionOrigen 'windows') -File | Copy-Item -Destination (Join-Path $Destino 'herramientas')
if ($Rol -eq 'Respaldo') {
  Copy-Item -LiteralPath (Join-Path $Origen 'arranque.js') -Destination (Join-Path $Destino 'arranque.js')
  Copy-Item -LiteralPath (Join-Path $Origen 'config.json') -Destination (Join-Path $Destino 'config.json')
}
Copy-Item -LiteralPath (Join-Path $Destino 'herramientas\arranque-apoyo.js') -Destination (Join-Path $Destino 'arranque-apoyo.js')

# Cada paquete queda ligado a esta PC. Una copia portable que ya identifica otro
# hardware no puede habilitarse por ejecutar nuevamente el instalador.
$node = Join-Path $Destino 'node\node.exe'
$versionDestino = Join-Path $Destino ('app\versiones\' + $version)
$equipo = (& $node -e 'process.stdout.write(require(process.argv[1]).identidadEquipo())' (Join-Path $versionDestino 'lib\control-equipo.js') | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $equipo -notmatch '^[a-f0-9]{64}$') { throw 'No se pudo identificar esta PC; no se inicio ningun servicio.' }
if ($ha.equipoId -and $ha.equipoId -cne $equipo) { throw 'El paquete ya esta vinculado a otra PC. Solicita un nuevo paquete de incorporacion.' }
$ha | Add-Member -MemberType NoteProperty -Name equipoId -Value $equipo -Force
$ha | Add-Member -MemberType NoteProperty -Name rolInstalacion -Value $Rol -Force
$ha | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $Destino 'predio-ha.json') -Encoding UTF8
# Estos archivos se crean ANTES de contactar al principal. Un corte de red o una
# respuesta perdida no obliga a borrar la carpeta ni a regenerar firma y TLS.
@{ formato = 1; grupoId = [string]$ha.grupoId; rol = $Rol; version = $version; equipoId = $equipo; incorporacionId = [string]$ha.incorporacion.id; completada = $false } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $Destino 'instalacion-apoyo.json') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $Destino 'herramientas\CONTINUAR-INSTALACION.bat') -Destination (Join-Path $Destino 'CONTINUAR-INSTALACION.bat')
& (Join-Path $Destino 'herramientas\continuar-apoyo.ps1') -Base $Destino -Inicial
