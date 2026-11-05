# Instalador del sistema del predio (AJB) para la notebook servidor del camping.
# Lo ejecuta INSTALAR.bat como administrador. Se puede volver a correr para actualizar
# o reparar: nunca borra la base de datos (datos\predio.db).
#
# Qué hace:
#   1. Copia el sistema a C:\AJB-Predio (o a la carpeta indicada con -Destino).
#   2. Deja Node.js portable en C:\AJB-Predio\node (no instala nada en Windows).
#   3. Abre el puerto en el firewall para que entren las PCs de la red del camping.
#   4. Configura la energía para que la notebook no se suspenda.
#   5. Crea la tarea "AJB Predio": arranca sola al encender Windows (sin iniciar sesión),
#      se reinicia si se cae y se revisa cada 5 minutos.
#   6. Inicia el sistema, crea los accesos directos y abre la pantalla de ingreso.

param(
  [string]$Destino = "C:\AJB-Predio",
  [int]$Puerto = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Paso($texto) { Write-Host ""; Write-Host "==> $texto" -ForegroundColor Cyan }
function Ok($texto) { Write-Host "    $texto" -ForegroundColor Green }
function Aviso($texto) { Write-Host "    $texto" -ForegroundColor Yellow }

$Origen = Split-Path -Parent $PSScriptRoot
$NombreTarea = "AJB Predio"

Write-Host ""
Write-Host "  Sistema del predio - AJB" -ForegroundColor White
Write-Host "  Instalacion en la notebook servidor" -ForegroundColor Gray
Write-Host ""

# --- Permisos de administrador
$identidad = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identidad)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Hay que ejecutar INSTALAR.bat con clic derecho > Ejecutar como administrador." -ForegroundColor Red
  exit 1
}

# --- Archivos del paquete
if (-not (Test-Path (Join-Path $Origen "config.json")) -or -not (Test-Path (Join-Path $Origen "arranque.js"))) {
  Write-Host "No encuentro config.json y arranque.js junto a INSTALAR.bat. Descomprimi el .zip completo y volve a intentar." -ForegroundColor Red
  exit 1
}
Get-ChildItem -Path $Origen -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

$configNueva = Get-Content (Join-Path $Origen "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Puerto -gt 0) { $configNueva.puerto = $Puerto }
$Puerto = [int]$configNueva.puerto
if ($Puerto -le 0) { $Puerto = 8080; $configNueva.puerto = 8080 }

# --- Si ya estaba instalado, se detiene antes de copiar
Paso "Preparando la carpeta $Destino"
$tareaExistente = Get-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
if ($tareaExistente) {
  Stop-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Destino*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Force -Path $Destino | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Destino "datos\respaldos") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Destino "logs") | Out-Null

$base = Join-Path $Destino "datos\predio.db"
if (Test-Path $base) {
  $copia = Join-Path $Destino ("datos\respaldos\predio-antes-de-instalar-{0}.db" -f (Get-Date -Format "yyyy-MM-dd-HHmm"))
  Copy-Item $base $copia -Force
  Ok "Base de datos existente respaldada en $copia"
}

# --- Copia de la aplicación
Paso "Copiando el sistema"
Copy-Item (Join-Path $Origen "arranque.js") (Join-Path $Destino "arranque.js") -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Destino "app\versiones") | Out-Null
Get-ChildItem (Join-Path $Origen "app\versiones") -Directory | ForEach-Object {
  $dest = Join-Path $Destino ("app\versiones\" + $_.Name)
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Copy-Item $_.FullName $dest -Recurse -Force
}
Copy-Item (Join-Path $Origen "app\ACTUAL") (Join-Path $Destino "app\ACTUAL") -Force
foreach ($marca in @("PENDIENTE", "EN_PRUEBA", "SANO", "lanzador.pid")) {
  $f = Join-Path $Destino "app\$marca"
  if (Test-Path $f) { Remove-Item $f -Force }
}
if (-not (Test-Path $base) -and (Test-Path (Join-Path $Origen "datos-iniciales.json.gz"))) {
  Copy-Item (Join-Path $Origen "datos-iniciales.json.gz") (Join-Path $Destino "datos-iniciales.json.gz") -Force
}
$configNueva | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Destino "config.json") -Encoding UTF8
New-Item -ItemType Directory -Force -Path (Join-Path $Destino "herramientas") | Out-Null
Get-ChildItem (Join-Path $Origen "instalador") -File | Copy-Item -Destination (Join-Path $Destino "herramientas") -Force
if (Test-Path (Join-Path $Origen "LEEME.txt")) { Copy-Item (Join-Path $Origen "LEEME.txt") (Join-Path $Destino "LEEME.txt") -Force }
Ok "Sistema copiado en $Destino"

# --- Node.js portable
Paso "Preparando Node.js (portable, sin instalar nada en Windows)"
$nodeDir = Join-Path $Destino "node"
$nodeExe = Join-Path $nodeDir "node.exe"
$arquitectura = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$zipNode = Get-ChildItem (Join-Path $Origen "runtime") -Filter "node-*-win-$arquitectura.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($zipNode -or -not (Test-Path $nodeExe)) {
  if (-not $zipNode) {
    $version = "v22.23.4"
    $url = "https://nodejs.org/dist/$version/node-$version-win-$arquitectura.zip"
    $temporal = Join-Path $env:TEMP "node-$version-win-$arquitectura.zip"
    Aviso "Descargando Node.js $version desde nodejs.org (hace falta internet esta unica vez)..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $temporal -UseBasicParsing
    $zipNode = Get-Item $temporal
  }
  $extraer = Join-Path $env:TEMP ("node-extraer-" + [Guid]::NewGuid().ToString("N"))
  Expand-Archive -Path $zipNode.FullName -DestinationPath $extraer -Force
  $interna = Get-ChildItem $extraer -Directory | Select-Object -First 1
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item $interna.FullName $nodeDir
  Remove-Item $extraer -Recurse -Force -ErrorAction SilentlyContinue
}
$versionNode = & $nodeExe --version
Ok "Node.js $versionNode listo en $nodeDir"

# --- Firewall
Paso "Abriendo el puerto $Puerto para las PCs del camping"
Get-NetFirewallRule -DisplayName "AJB Predio*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "AJB Predio (puerto $Puerto)" -Direction Inbound -Protocol TCP -LocalPort $Puerto -Action Allow -Profile Any | Out-Null
Ok "Regla de firewall creada"

# --- Energía: la notebook no se suspende ni se apaga al cerrar la tapa
Paso "Configurando la energia para que el servidor no se duerma"
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change standby-timeout-dc 0 | Out-Null
powercfg /change hibernate-timeout-dc 0 | Out-Null
powercfg /change monitor-timeout-ac 15 | Out-Null
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
powercfg /setactive SCHEME_CURRENT | Out-Null
Ok "Sin suspension ni hibernacion; cerrar la tapa no apaga el servidor"

# --- Tarea programada (arranca con Windows, sin iniciar sesión)
Paso "Creando la tarea '$NombreTarea' (arranque automatico)"
if ($tareaExistente) { Unregister-ScheduledTask -TaskName $NombreTarea -Confirm:$false }
$accion = New-ScheduledTaskAction -Execute $nodeExe -Argument ('"' + (Join-Path $Destino "arranque.js") + '"') -WorkingDirectory $Destino
$alEncender = New-ScheduledTaskTrigger -AtStartup
$revision = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$quien = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$opciones = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $NombreTarea -Action $accion -Trigger @($alEncender, $revision) -Principal $quien -Settings $opciones `
  -Description "Servidor local del sistema del predio (AJB). Se inicia al encender y se revisa cada 5 minutos." | Out-Null
Start-ScheduledTask -TaskName $NombreTarea
Ok "Tarea creada e iniciada"

# --- Espera a que responda
Paso "Esperando que el sistema arranque"
$url = "http://localhost:$Puerto"
$listo = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "$url/api/estado-publico" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $listo = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if ($listo) { Ok "El sistema responde en $url" } else { Aviso "Todavia no responde. Revisa la carpeta $Destino\logs si no abre en un minuto." }

# --- Direcciones para las PCs de las bocas
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Select-Object -ExpandProperty IPAddress
$sufijoPuerto = if ($Puerto -eq 80) { "" } else { ":$Puerto" }
$direcciones = @()
foreach ($ip in $ips) { $direcciones += "http://$ip$sufijoPuerto" }
$direcciones += "http://$($env:COMPUTERNAME)$sufijoPuerto"

$escritorio = [Environment]::GetFolderPath("CommonDesktopDirectory")
$texto = @(
  "SISTEMA DEL PREDIO - DIRECCION PARA LAS PCS DEL CAMPING",
  "",
  "En cada PC de las bocas, abri el navegador (Chrome, Edge o Firefox) y entra a:",
  ""
) + ($direcciones | ForEach-Object { "   $_" }) + @(
  "",
  "Conviene usar la primera direccion. Si la notebook cambia de IP, usa la del nombre del equipo.",
  "Para crear el acceso directo de caja en cada PC, copia y ejecuta herramientas\crear-acceso-pc-caja.bat.",
  "En esta notebook tambien funciona: $url"
)
$texto | Set-Content (Join-Path $Destino "DIRECCIONES-PARA-LAS-PCS.txt") -Encoding UTF8
Copy-Item (Join-Path $Destino "DIRECCIONES-PARA-LAS-PCS.txt") (Join-Path $escritorio "Sistema del Camping - direcciones.txt") -Force -ErrorAction SilentlyContinue
Set-Content (Join-Path $escritorio "Sistema del Camping.url") -Value "[InternetShortcut]`r`nURL=$url/`r`n" -Encoding ASCII -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  Listo. El sistema queda funcionando y arranca solo." -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  En las PCs del camping entra a:" -ForegroundColor White
foreach ($d in $direcciones) { Write-Host "     $d" -ForegroundColor White }
Write-Host ""
Write-Host "  (Quedo anotado en el escritorio: 'Sistema del Camping - direcciones.txt')" -ForegroundColor Gray
Write-Host ""
Start-Process "$url/"
