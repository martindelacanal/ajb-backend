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
  [int]$Puerto = 0,
  [bool]$ArranqueAutomatico = $true,
  [bool]$Https = $true
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Paso($texto) { Write-Host ""; Write-Host "==> $texto" -ForegroundColor Cyan }
function Ok($texto) { Write-Host "    $texto" -ForegroundColor Green }
function Aviso($texto) { Write-Host "    $texto" -ForegroundColor Yellow }

$Origen = Split-Path -Parent $PSScriptRoot
$NombreTarea = "AJB Predio"
$Destino = [IO.Path]::GetFullPath($Destino).TrimEnd('\')
if ($Destino -eq [IO.Path]::GetPathRoot($Destino).TrimEnd('\') -or $Destino -eq [IO.Path]::GetFullPath($Origen).TrimEnd('\')) {
  throw 'Elegi una carpeta propia para la instalacion, distinta de la raiz del disco y del paquete de origen.'
}
function Confirmar-Subcarpeta([string]$Ruta, [string]$Raiz) {
  $resuelta = [IO.Path]::GetFullPath($Ruta)
  $limite = [IO.Path]::GetFullPath($Raiz).TrimEnd('\') + '\'
  if (-not $resuelta.StartsWith($limite, [StringComparison]::OrdinalIgnoreCase)) { throw "Ruta fuera de la instalacion: $resuelta" }
}

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
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq (Join-Path $Destino 'node\node.exe') -and $_.CommandLine -and ($_.CommandLine -match ('(?i)(?:"' + [regex]::Escape((Join-Path $Destino 'arranque.js')) + '"|--base\s+"?' + [regex]::Escape($Destino) + '(?:"|\s|$))')) } |
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
  Confirmar-Subcarpeta $dest (Join-Path $Destino 'app\versiones')
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
  Confirmar-Subcarpeta $nodeDir $Destino
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Confirmar-Subcarpeta $interna.FullName $extraer
  Move-Item $interna.FullName $nodeDir
  Confirmar-Subcarpeta $extraer $env:TEMP
  Remove-Item $extraer -Recurse -Force -ErrorAction SilentlyContinue
}
$versionNode = & $nodeExe --version
Ok "Node.js $versionNode listo en $nodeDir"

# --- Firewall
Paso "Abriendo el puerto $Puerto para las PCs del camping"
Get-NetFirewallRule -DisplayName 'AJB Predio (puerto *)', 'AJB Predio (nombre en la red)', 'AJB Predio (detectar servidor local)' -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "AJB Predio (puerto $Puerto)" -Direction Inbound -Protocol TCP -LocalPort $Puerto -Action Allow -Profile Any | Out-Null
# Para que las PCs encuentren la notebook por su nombre (http://nombre:puerto): NetBIOS, mDNS y LLMNR.
New-NetFirewallRule -DisplayName "AJB Predio (nombre en la red)" -Direction Inbound -Protocol UDP -LocalPort 137,5353,5355 -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName "AJB Predio (detectar servidor local)" -Direction Inbound -Protocol UDP -LocalPort 39876 -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
$archivoGrupo = Join-Path $Destino 'predio-ha.json'
if (Test-Path -LiteralPath $archivoGrupo -PathType Leaf) {
  $grupo = Get-Content -LiteralPath $archivoGrupo -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($grupo.habilitado -and $grupo.quorum) {
    & (Join-Path $Destino 'herramientas\configurar-coordinacion-lan.ps1') -Puerto ([int]$grupo.quorum.puerto)
  }
}
Ok "Reglas de firewall creadas"

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

# --- HTTPS local: certificado de esta instalacion, utilizable tambien sin internet.
if ($Https) {
  Paso 'Preparando HTTPS para las PCs del camping'
  try { & (Join-Path $Destino 'herramientas\preparar-https.ps1') -Base $Destino }
  catch { Aviso ('HTTPS todavia no esta listo: ' + $_.Exception.Message + '. HTTP sigue disponible.') }
}

# --- Tarea programada y eleccion de arranque (por defecto automatico).
Paso "Configurando la tarea '$NombreTarea'"
$runtimeArchivo = Join-Path $Destino 'runtime.json'
if ((Test-Path -LiteralPath $runtimeArchivo) -and -not $PSBoundParameters.ContainsKey('ArranqueAutomatico')) {
  $runtimePrevio = Get-Content -LiteralPath $runtimeArchivo -Raw -Encoding UTF8 | ConvertFrom-Json
  $ArranqueAutomatico = $runtimePrevio.autoarranque -ne $false
}
@{ autoarranque = $ArranqueAutomatico; detenido = $false } | ConvertTo-Json | Set-Content -LiteralPath $runtimeArchivo -Encoding UTF8
& (Join-Path $Destino 'herramientas\control-servidor.ps1') -Base $Destino -Accion Registrar
& (Join-Path $Destino 'herramientas\control-servidor.ps1') -Base $Destino -Accion Iniciar
Ok ('Servidor iniciado. Arranque automatico: ' + $ArranqueAutomatico)

# --- Espera a que responda
Paso "Esperando que el sistema arranque"
$url = "http://localhost:$Puerto"
$listo = $false
$esperandoGrupo = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "$url/api/estado-publico" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $listo = $true; break }
  } catch {
    $esperandoGrupo = $_.ErrorDetails.Message -match 'SERVIDOR_CAMBIANDO'
    Start-Sleep -Seconds 2
  }
}
if ($listo) { Ok "El sistema responde en $url" }
elseif ($esperandoGrupo) { Aviso 'El servidor arranco y espera al grupo. Deja encendidas las PCs de respaldo en la misma red.' }
else { Aviso "Todavia no responde. Revisa la carpeta $Destino\logs si no abre en un minuto." }

# --- Direcciones para las PCs de las bocas
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Select-Object -ExpandProperty IPAddress
$sufijoPuerto = if ($Puerto -eq 80) { "" } else { ":$Puerto" }
$direcciones = @("http://$($env:COMPUTERNAME.ToLower())$sufijoPuerto")
foreach ($ip in $ips) { $direcciones += "http://$ip$sufijoPuerto" }
$tlsArchivo = Join-Path $Destino 'datos\tls\config.json'
if (Test-Path -LiteralPath $tlsArchivo) {
  $tlsConfig = Get-Content -LiteralPath $tlsArchivo -Raw -Encoding UTF8 | ConvertFrom-Json
  $puertoSeguro = [int]$tlsConfig.puerto
  $direcciones = @("https://$($env:COMPUTERNAME.ToLower()):$puertoSeguro") + $direcciones
  $url = "https://localhost:$puertoSeguro"
}

$escritorio = [Environment]::GetFolderPath("CommonDesktopDirectory")
$texto = @(
  "SISTEMA DEL PREDIO - DIRECCION PARA LAS PCS DEL CAMPING",
  "",
  "En cada PC de las bocas, abri el navegador (Chrome, Edge o Firefox) y entra a:",
  ""
) + ($direcciones | ForEach-Object { "   $_" }) + @(
  "",
  "La primera es con el nombre de la notebook: no cambia aunque cambie la IP. Si en alguna PC no abre, usa la de numeros.",
  "El nombre se puede cambiar desde el sistema: Sistema > Direcciones para las PCs > Cambiar el nombre en la red.",
  "En esta notebook, la instalacion crea Sistema del Camping - Caja en el escritorio. En cada PC de la red, la preparacion con certificados-PCs tambien crea ese acceso. La tiquetera debe ser la predeterminada de Windows.",
  "Para HTTPS sin avisos del navegador, copia certificados-PCs a cada PC y ejecuta la herramienta de confianza una vez. Nunca copies datos\tls: contiene claves privadas.",
  "Detener-servidor.bat desactiva el arranque automatico. Reiniciar-servidor.bat vuelve a habilitarlo. Configurar-arranque.bat permite elegir el inicio manual.",
  "Una instalacion nueva debe conectarse una vez a Mi AJB para registrar el equipo; despues funciona sin internet. Si hay otro servidor activo, usa su direccion.",
  "En esta notebook tambien funciona: $url"
)
$texto | Set-Content (Join-Path $Destino "DIRECCIONES-PARA-LAS-PCS.txt") -Encoding UTF8
Copy-Item (Join-Path $Destino "DIRECCIONES-PARA-LAS-PCS.txt") (Join-Path $escritorio "Sistema del Camping - direcciones.txt") -Force -ErrorAction SilentlyContinue
Set-Content (Join-Path $escritorio "Sistema del Camping.url") -Value "[InternetShortcut]`r`nURL=$url/`r`n" -Encoding ASCII -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
if ($listo) { Ok ('El sistema esta funcionando. Arranque automatico: ' + $ArranqueAutomatico) }
else { Aviso ('La instalacion termino. El sistema todavia no esta disponible. Arranque automatico: ' + $ArranqueAutomatico) }
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  En las PCs del camping entra a:" -ForegroundColor White
foreach ($d in $direcciones) { Write-Host "     $d" -ForegroundColor White }
Write-Host ""
Write-Host "  (Quedo anotado en el escritorio: 'Sistema del Camping - direcciones.txt')" -ForegroundColor Gray
Write-Host ""
& (Join-Path $Destino 'herramientas\configurar-acceso-caja.ps1') -Direccion $url
if ($listo) { Start-Process "$url/" }
