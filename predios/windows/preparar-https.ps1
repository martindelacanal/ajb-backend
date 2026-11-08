# HTTPS de la LAN: una autoridad propia de la instalacion, y un certificado del
# servidor renovable con SAN para su nombre e IP. Las claves no salen de datos/tls.
# https://learn.microsoft.com/powershell/module/pki/new-selfsignedcertificate
# https://learn.microsoft.com/powershell/module/pki/export-pfxcertificate
#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Base,
  [ValidateRange(1, 65535)][int]$Puerto = 8443
)

$ErrorActionPreference = "Stop"

function New-AjbSecreto {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes); return [Convert]::ToBase64String($bytes) }
  finally { $rng.Dispose() }
}

function Get-AjbPuertoTls([int]$Solicitado, [bool]$Explicito, $Guardado) {
  if (-not $Explicito -and $null -ne $Guardado) {
    $valor = 0
    if (-not [int]::TryParse([string]$Guardado, [ref]$valor) -or $valor -lt 1 -or $valor -gt 65535) { throw 'El puerto HTTPS guardado no es valido.' }
    return $valor
  }
  return $Solicitado
}

function Get-AjbNombresCertificado([string]$NombreEquipo, [string[]]$DireccionesIP) {
  $nombre = $NombreEquipo.ToLowerInvariant()
  if ($nombre -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') { throw "El nombre de la notebook no es valido para HTTPS." }
  $nombres = @('localhost', $nombre, "$nombre.local", '127.0.0.1', '::1')
  foreach ($direccion in $DireccionesIP) {
    $ip = $null
    if ([Net.IPAddress]::TryParse($direccion, [ref]$ip) -and $direccion -notmatch '%' -and -not $ip.IsIPv6Multicast -and -not $ip.IsIPv6LinkLocal -and $direccion -notin @('0.0.0.0', '::')) {
      $nombres += $ip.ToString().ToLowerInvariant()
    }
  }
  return @($nombres | Sort-Object -Unique)
}

function Get-AjbExtensionesSan([string[]]$Nombres) {
  $partes = foreach ($nombre in $Nombres) {
    $ip = $null
    if ([Net.IPAddress]::TryParse($nombre, [ref]$ip)) { "IPAddress=$nombre" }
    elseif ($nombre -match '^[a-z0-9.-]+$') { "DNS=$nombre" }
    else { throw "Nombre de certificado no valido." }
  }
  return '2.5.29.17={text}' + ($partes -join '&')
}

function Protect-AjbCarpeta([string]$Ruta) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $identidad = New-Object Security.Principal.SecurityIdentifier($sid)
    $regla = New-Object Security.AccessControl.FileSystemAccessRule($identidad, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($regla)
  }
  Set-Acl -LiteralPath $Ruta -AclObject $acl
  foreach ($archivo in @(Get-ChildItem -LiteralPath $Ruta -File -Force)) {
    $archivoAcl = New-Object Security.AccessControl.FileSecurity
    $archivoAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
      $identidad = New-Object Security.Principal.SecurityIdentifier($sid)
      $archivoAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identidad, 'FullControl', 'Allow')))
    }
    Set-Acl -LiteralPath $archivo.FullName -AclObject $archivoAcl
  }
}

function Get-AjbHuellaSha256([byte[]]$Bytes) {
  $algoritmo = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algoritmo.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algoritmo.Dispose() }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'La preparacion de HTTPS se ejecuta como administrador o SYSTEM.' }
$baseAbsoluta = [IO.Path]::GetFullPath($Base)
if (-not (Test-Path -LiteralPath (Join-Path $baseAbsoluta 'config.json'))) { throw 'La carpeta no corresponde a una instalacion del predio (falta config.json).' }
$carpeta = Join-Path $baseAbsoluta 'datos\tls'
New-Item -ItemType Directory -Path $carpeta -Force | Out-Null
Protect-AjbCarpeta $carpeta
$archivoConfig = Join-Path $carpeta 'config.json'
$config = $null
if (Test-Path -LiteralPath $archivoConfig) { $config = Get-Content -LiteralPath $archivoConfig -Raw -Encoding UTF8 | ConvertFrom-Json }
$Puerto = Get-AjbPuertoTls $Puerto ($PSBoundParameters.ContainsKey('Puerto')) $(if ($config) { $config.puerto } else { $null })
$ips = @(Get-NetIPAddress -ErrorAction Stop | Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notmatch '^169\.254\.' } | ForEach-Object { $_.IPAddress })
$nombres = @(Get-AjbNombresCertificado $env:COMPUTERNAME $ips)
$ahora = Get-Date
$raiz = $null
if ($config -and $config.raiz_thumbprint) { $raiz = Get-Item -LiteralPath ('Cert:\LocalMachine\My\' + $config.raiz_thumbprint) -ErrorAction SilentlyContinue }
if (-not $raiz -and $config -and $config.raiz_passphrase -and (Test-Path -LiteralPath (Join-Path $carpeta 'autoridad.pfx'))) {
  $raices = @(Import-PfxCertificate -FilePath (Join-Path $carpeta 'autoridad.pfx') -Password (ConvertTo-SecureString $config.raiz_passphrase -AsPlainText -Force) -CertStoreLocation 'Cert:\LocalMachine\My' -Exportable)
  $raiz = $raices | Where-Object { $_.Thumbprint -eq $config.raiz_thumbprint -and $_.HasPrivateKey } | Select-Object -First 1
}
if ($config -and -not $raiz) { throw 'No se encontro la clave de la autoridad de esta instalacion. Restaura datos/tls/autoridad.pfx; no se reemplazara la raiz de las PCs.' }
if (-not $raiz) {
  $id = [Guid]::NewGuid().ToString('N')
  $raiz = New-SelfSignedCertificate -Type Custom -Subject "CN=AJB Predio Raiz $id" -FriendlyName "AJB Predio Raiz $id" -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage CertSign,CRLSign -CertStoreLocation 'Cert:\LocalMachine\My' -NotBefore $ahora.AddMinutes(-5) -NotAfter $ahora.AddYears(10) -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0')
  $config = [pscustomobject]@{ raiz_thumbprint = $raiz.Thumbprint; raiz_passphrase = (New-AjbSecreto); passphrase = (New-AjbSecreto); nombres = @(); servidor_thumbprint = $null }
  Export-PfxCertificate -Cert $raiz -FilePath (Join-Path $carpeta 'autoridad.pfx') -Password (ConvertTo-SecureString $config.raiz_passphrase -AsPlainText -Force) -ChainOption EndEntityCertOnly | Out-Null
}
if (-not $raiz.HasPrivateKey -or $raiz.NotAfter -le $ahora.AddDays(366)) { throw 'La autoridad de esta instalacion necesita renovacion coordinada con las PCs antes de emitir otro certificado.' }
$publica = Join-Path $carpeta 'autoridad.cer'
Export-Certificate -Cert $raiz -FilePath $publica -Force | Out-Null
$huella = Get-AjbHuellaSha256 $raiz.RawData
if ($config.huella_sha256 -and $config.huella_sha256 -cne $huella) { throw 'La autoridad guardada no coincide con la configuracion de esta instalacion.' }
$servidor = $null
if ($config.servidor_thumbprint) { $servidor = Get-Item -LiteralPath ('Cert:\LocalMachine\My\' + $config.servidor_thumbprint) -ErrorAction SilentlyContinue }
$cambioNombres = (($nombres -join '|') -cne ((@($config.nombres) | Sort-Object -Unique) -join '|'))
$renovado = -not $servidor -or $servidor.NotAfter -le $ahora.AddDays(30) -or $cambioNombres -or -not (Test-Path -LiteralPath (Join-Path $carpeta 'servidor.pfx'))
if ($renovado) {
  $extensiones = @('2.5.29.37={text}1.3.6.1.5.5.7.3.1', '2.5.29.19={critical}{text}ca=0', (Get-AjbExtensionesSan $nombres))
  $servidor = New-SelfSignedCertificate -Type Custom -Subject "CN=$($env:COMPUTERNAME.ToLowerInvariant())" -FriendlyName "AJB Predio HTTPS $($raiz.Thumbprint)" -Signer $raiz -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -CertStoreLocation 'Cert:\LocalMachine\My' -NotBefore $ahora.AddMinutes(-5) -NotAfter $ahora.AddDays(365) -TextExtension $extensiones
  $temporalPfx = Join-Path $carpeta 'servidor-nuevo.pfx'
  Export-PfxCertificate -Cert $servidor -FilePath $temporalPfx -Password (ConvertTo-SecureString $config.passphrase -AsPlainText -Force) -ChainOption BuildChain | Out-Null
  Move-Item -LiteralPath $temporalPfx -Destination (Join-Path $carpeta 'servidor.pfx') -Force
  $config.servidor_thumbprint = $servidor.Thumbprint
}
$salida = [ordered]@{
  puerto = $Puerto; passphrase = $config.passphrase; certificado = 'servidor.pfx'; raiz = 'autoridad.cer'; huella_sha256 = $huella; nombres = $nombres;
  raiz_thumbprint = $raiz.Thumbprint; raiz_passphrase = $config.raiz_passphrase; servidor_thumbprint = $servidor.Thumbprint
}
$tempConfig = Join-Path $carpeta 'config-nueva.json'
$salida | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tempConfig -Encoding UTF8
Move-Item -LiteralPath $tempConfig -Destination $archivoConfig -Force
Protect-AjbCarpeta $carpeta
$scriptConfianza = Join-Path $PSScriptRoot 'confiar-certificado.ps1'
if (-not (Test-Path -LiteralPath $scriptConfianza)) { throw 'Falta confiar-certificado.ps1 junto a preparar-https.ps1.' }
& $scriptConfianza -Certificado $publica -HuellaSha256 $huella | Out-Null
# Tambien las instalaciones que se actualizan solas necesitan permitir HTTPS en
# la LAN: no pasan otra vez por instalar.ps1. Se limita a la subred local.
Get-NetFirewallRule -Name 'AJB-Predio-HTTPS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
New-NetFirewallRule -Name 'AJB-Predio-HTTPS' -DisplayName 'AJB Predio HTTPS' -Direction Inbound -Protocol TCP -LocalPort $Puerto -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null

if (-not (Get-NetFirewallRule -Name 'AJB-Predio-Ubicacion-Quorum' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'AJB-Predio-Ubicacion-Quorum' -DisplayName 'AJB Predio Ubicacion LAN' -Direction Inbound -Protocol UDP -LocalPort 39879 -RemoteAddress LocalSubnet -Action Allow -Profile Any -ErrorAction Stop | Out-Null
}
$publicos = Join-Path $baseAbsoluta 'certificados-PCs'
New-Item -ItemType Directory -Path $publicos -Force | Out-Null
Copy-Item -LiteralPath $publica -Destination (Join-Path $publicos 'autoridad.cer') -Force
Copy-Item -LiteralPath $scriptConfianza -Destination (Join-Path $publicos 'confiar-certificado.ps1') -Force
foreach ($archivo in @('configurar-acceso-caja.ps1','crear-acceso-pc-caja.bat')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $archivo) -Destination (Join-Path $publicos $archivo) -Force
}
$accesoConfianza = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0confiar-certificado.ps1" -Certificado "%~dp0autoridad.cer" -HuellaSha256 __HUELLA__ -DireccionCaja "__ORIGEN__"
set "resultado=%ERRORLEVEL%"
if not "%resultado%"=="0" echo La preparacion de esta PC no termino. Ejecuta este archivo como administrador y revisa el mensaje anterior.
if "%resultado%"=="0" echo PC preparada. Para trabajar en la caja, abri Sistema del Camping - Caja en el escritorio.
pause
exit /b %resultado%
'@
$origenCaja = "https://$($env:COMPUTERNAME.ToLowerInvariant()):$Puerto/"
$accesoConfianza.Replace('__HUELLA__', $huella).Replace('__ORIGEN__', $origenCaja) -replace '\r?\n', [Environment]::NewLine | Set-Content -LiteralPath (Join-Path $publicos 'CONFIAR-EN-ESTA-PC.bat') -Encoding ASCII
$instrucciones = @"
HTTPS del predio - confianza en cada PC de la red

Copia esta carpeta completa a la PC de caja. Contiene la raiz publica y las herramientas de preparacion.
Verifica en la notebook servidor que la huella SHA-256 sea:
$huella

Clic derecho en CONFIAR-EN-ESTA-PC.bat > Ejecutar como administrador.
La herramienta comprobara la huella, instalara la confianza y dejara
"Sistema del Camping - Caja" en el escritorio de todos los usuarios.

Para vender, abri ese acceso con la tiquetera como impresora predeterminada de Windows.
Para documentos A4, usa $origenCaja desde el navegador habitual.
La notebook renueva su certificado sin cambiar esta raiz de confianza.
No copies datos\tls ni archivos PFX a otras PCs.
"@
$instrucciones | Set-Content -LiteralPath (Join-Path $publicos 'LEEME.txt') -Encoding UTF8
[pscustomobject]@{ configuracion = $archivoConfig; certificado = (Join-Path $carpeta 'servidor.pfx'); raiz = $publica; huella_sha256 = $huella; nombres = $nombres; renovado = [bool]$renovado; puerto = $Puerto } | ConvertTo-Json -Depth 4 -Compress
