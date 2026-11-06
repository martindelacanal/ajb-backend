# Una raiz propia por instalacion. La huella SHA-256 debe coincidir con la que
# muestra la notebook servidor; nunca se instala un certificado por su nombre.
# Documentacion: https://learn.microsoft.com/powershell/module/pki/import-certificate
#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Certificado,
  [Parameter(Mandatory = $true)][string]$HuellaSha256,
  [switch]$SoloVerificar,
  [switch]$Quitar
)

$ErrorActionPreference = "Stop"

function Get-AjbHuellaSha256([byte[]]$Bytes) {
  $algoritmo = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algoritmo.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
  finally { $algoritmo.Dispose() }
}

$ruta = (Resolve-Path -LiteralPath $Certificado).Path
$esperada = $HuellaSha256.Replace(":", "").Replace(" ", "").ToLowerInvariant()
if ($esperada -notmatch '^[0-9a-f]{64}$') { throw "La huella SHA-256 debe tener 64 caracteres hexadecimales." }
$cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $ruta
try {
  $huella = Get-AjbHuellaSha256 $cert.RawData
  if ($huella -cne $esperada) { throw "La huella del certificado no coincide con la notebook servidor. No se modifico la confianza de esta PC." }
  $restricciones = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | Select-Object -First 1
  if (-not $restricciones) { throw "El archivo no tiene las restricciones de una autoridad certificadora." }
  $basicas = New-Object Security.Cryptography.X509Certificates.X509BasicConstraintsExtension
  $basicas.CopyFrom($restricciones)
  if (-not $basicas.CertificateAuthority -or $cert.Subject -cne $cert.Issuer -or $cert.Subject -notmatch '^CN=AJB Predio Raiz [a-f0-9]{32}$' -or $cert.HasPrivateKey) {
    throw "El archivo no es el certificado publico de una raiz propia del predio." 
  }
  if (-not $Quitar -and ($cert.NotBefore -gt (Get-Date) -or $cert.NotAfter -le (Get-Date))) { throw "El certificado del predio no esta vigente." }
  if ($SoloVerificar -and $Quitar) { throw "SoloVerificar y Quitar no se pueden combinar." }
  if ($SoloVerificar) {
    [pscustomobject]@{ valido = $true; huella_sha256 = $huella; sujeto = $cert.Subject; vence = $cert.NotAfter.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    return
  }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Ejecuta este archivo como administrador para configurar la confianza del predio en esta PC." }
  $almacen = New-Object Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
  try {
    $almacen.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $existentes = @($almacen.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $cert.Thumbprint, $false))
    if ($Quitar) {
      foreach ($existente in $existentes) {
        if ((Get-AjbHuellaSha256 $existente.RawData) -ceq $esperada) { $almacen.Remove($existente) }
      }
    } elseif ($existentes.Count -eq 0) { $almacen.Add($cert) }
  } finally { $almacen.Close() }
  [pscustomobject]@{ configurado = -not [bool]$Quitar; huella_sha256 = $huella; sujeto = $cert.Subject } | ConvertTo-Json -Compress
} finally { $cert.Dispose() }
