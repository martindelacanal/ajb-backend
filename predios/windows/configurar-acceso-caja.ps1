# Se ejecuta durante el aprovisionamiento de Windows, nunca desde la sesion web.
param([Parameter(Mandatory = $true)][string]$Direccion)
$ErrorActionPreference = 'Stop'

function Get-AjbLanzadorCaja([string]$Entrada, [string]$Plantilla) {
  # La URL se guarda dentro de un BAT. Admitir exclusivamente un origen HTTP(S),
  # sin credenciales, ruta, zona IPv6, argumentos ni metacaracteres de cmd.
  if ($Entrada -notmatch '^https?://(?:[a-z0-9._-]+|\[[a-f0-9:]+\])(?::\d{1,5})?/?\z') { throw 'Direccion de caja invalida' }
  $url = [uri]$Entrada
  $origen = $url.GetLeftPart([UriPartial]::Authority) + '/'
  return $Plantilla.Replace('set "AJB_DIRECCION="', ('set "AJB_DIRECCION={0}"' -f $origen)) -replace '\r?\n', [Environment]::NewLine
}

function Set-AjbAccesoCaja([string]$Contenido, [string]$Carpeta, [string]$Escritorio) {
  New-Item -Path $Carpeta -ItemType Directory -Force | Out-Null
  $lanzador = Join-Path $Carpeta 'abrir-caja.bat'
  if (!(Test-Path -LiteralPath $lanzador) -or (Get-Content -LiteralPath $lanzador -Raw -Encoding ASCII) -cne $Contenido) {
    [IO.File]::WriteAllText($lanzador, $Contenido, [Text.Encoding]::ASCII)
  }
  $archivo = Join-Path $Escritorio 'Sistema del Camping - Caja.lnk'
  $acceso = (New-Object -ComObject WScript.Shell).CreateShortcut($archivo)
  if ($acceso.TargetPath -ne $lanzador -or $acceso.Arguments -ne '--abrir') {
    $acceso.TargetPath = $lanzador
    $acceso.Arguments = '--abrir'
    $acceso.WorkingDirectory = $Carpeta
    $acceso.WindowStyle = 7
    $acceso.Description = 'Caja del camping con impresion directa'
    $acceso.Save()
  }
}

# La carpeta del pendrive puede desaparecer. El lanzador comun queda protegido por
# los permisos de Archivos de programa; cada operador usa su propio LOCALAPPDATA.
$plantilla = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'crear-acceso-pc-caja.bat') -Raw -Encoding ASCII
$contenido = Get-AjbLanzadorCaja $Direccion $plantilla
$carpeta = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'AJB-Predio\Caja'
Set-AjbAccesoCaja $contenido $carpeta ([Environment]::GetFolderPath('CommonDesktopDirectory'))
