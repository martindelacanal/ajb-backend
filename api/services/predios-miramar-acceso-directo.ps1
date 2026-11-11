$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$direccion = 'http://ajbmiramar:8080'
$nombreAcceso = 'Sistema del Camping - Caja.lnk'

function Test-AjbRutaSinEnlaces([string]$Ruta) {
  if ($Ruta -notmatch '^[A-Za-z]:\\') { return $false }
  $actual = [IO.Path]::GetFullPath($Ruta)
  while ($actual) {
    if (Test-Path -LiteralPath $actual) {
      $item = Get-Item -LiteralPath $actual -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    }
    $actual = Split-Path -LiteralPath $actual
  }
  return $true
}

function Set-AjbDireccionLanzador([string]$Archivo, [string]$Direccion) {
  if (!(Test-Path -LiteralPath $Archivo -PathType Leaf) -or !(Test-AjbRutaSinEnlaces $Archivo)) { throw 'LANZADOR_NO_DISPONIBLE' }
  $texto = [Text.Encoding]::GetEncoding(28591)
  $original = $texto.GetString([IO.File]::ReadAllBytes($Archivo))
  $linea = [regex]'(?im)^set "AJB_DIRECCION=(?:https?://(?:[a-z0-9._-]+|\[[a-f0-9:]+\])(?::\d{1,5})?/?|)"(?=\r?$)'
  if ($linea.Matches($original).Count -ne 1 -or $original -notmatch '--kiosk-printing' -or
      $original -notmatch '--use-system-default-printer' -or $original -notmatch '--app=%AJB_DIRECCION%') { throw 'LANZADOR_INCOMPATIBLE' }
  $nuevo = $linea.Replace($original, ('set "AJB_DIRECCION={0}"' -f $Direccion), 1)
  if ($nuevo -ceq $original) { return $false }
  $temporal = Join-Path (Split-Path -LiteralPath $Archivo) ('.' + [Guid]::NewGuid() + '.bat')
  try {
    [IO.File]::WriteAllBytes($temporal, $texto.GetBytes($nuevo))
    [IO.File]::Replace($temporal, $Archivo, [NullString]::Value)
    if ($texto.GetString([IO.File]::ReadAllBytes($Archivo)) -cne $nuevo) { throw 'LANZADOR_NO_VERIFICADO' }
  } finally {
    if ([IO.File]::Exists($temporal)) { [IO.File]::Delete($temporal) }
  }
  return $true
}

function Get-AjbArgumentosCaja([string]$Argumentos, [string]$Direccion) {
  if ($Argumentos -notmatch '(?:^|\s)--kiosk-printing(?:\s|$)' -or
      $Argumentos -notmatch '(?:^|\s)--use-system-default-printer(?:\s|$)' -or
      $Argumentos -notmatch '(?:^|\s)"?--user-data-dir=') { throw 'ACCESO_INCOMPATIBLE' }
  $app = [regex]'(?i)(?<prefijo>(?<!\S)"?--app="?)(?:https?://(?:[a-z0-9._-]+|\[[a-f0-9:]+\])(?::\d{1,5})?/?)(?<sufijo>"?)(?=\s|$)'
  if ($app.Matches($Argumentos).Count -ne 1) { throw 'ACCESO_INCOMPATIBLE' }
  return $app.Replace($Argumentos, ('${prefijo}' + $Direccion + '${sufijo}'), 1)
}

function Get-AjbNavegadores([string]$Perfil) {
  $rutas = @([Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86'))
  if ($Perfil) { $rutas += Join-Path $Perfil 'AppData\Local' }
  foreach ($raiz in $rutas) {
    if (!$raiz) { continue }
    Join-Path $raiz 'Google\Chrome\Application\chrome.exe'
    Join-Path $raiz 'Microsoft\Edge\Application\msedge.exe'
  }
}

function Set-AjbAccesoExistente($Shell, [string]$Archivo, [string]$Lanzador, [string]$Direccion, [string[]]$Navegadores) {
  if (!(Test-Path -LiteralPath $Archivo -PathType Leaf) -or !(Test-AjbRutaSinEnlaces $Archivo)) { throw 'ACCESO_NO_DISPONIBLE' }
  $actual = $Shell.CreateShortcut($Archivo)
  if ($actual.TargetPath -ieq $Lanzador -and $actual.Arguments -ceq '--abrir') { return Set-AjbDireccionLanzador $Lanzador $Direccion }
  if ($actual.TargetPath -notin $Navegadores -or !(Test-Path -LiteralPath $actual.TargetPath -PathType Leaf)) { throw 'ACCESO_INCOMPATIBLE' }
  $argumentos = Get-AjbArgumentosCaja $actual.Arguments $Direccion
  if ($argumentos -ceq $actual.Arguments) { return $false }
  $carpetaSegura = Split-Path -LiteralPath $Lanzador
  if (!(Test-AjbRutaSinEnlaces $carpetaSegura)) { throw 'LANZADOR_NO_DISPONIBLE' }
  New-Item -Path $carpetaSegura -ItemType Directory -Force | Out-Null
  $temporal = Join-Path $carpetaSegura ('.' + [Guid]::NewGuid() + '.lnk')
  try {
    [IO.File]::Copy($Archivo, $temporal)
    $editado = $Shell.CreateShortcut($temporal)
    $editado.Arguments = $argumentos
    $editado.Save()
    if (!(Test-AjbRutaSinEnlaces $Archivo)) { throw 'ACCESO_NO_DISPONIBLE' }
    [IO.File]::Replace($temporal, $Archivo, [NullString]::Value)
    $guardado = $Shell.CreateShortcut($Archivo)
    if ($guardado.TargetPath -ine $actual.TargetPath -or $guardado.Arguments -cne $argumentos -or
        $guardado.IconLocation -cne $actual.IconLocation -or $guardado.WorkingDirectory -cne $actual.WorkingDirectory -or
        $guardado.Description -cne $actual.Description -or $guardado.WindowStyle -ne $actual.WindowStyle -or
        $guardado.Hotkey -cne $actual.Hotkey) { throw 'ACCESO_NO_VERIFICADO' }
  } finally {
    if ([IO.File]::Exists($temporal)) { [IO.File]::Delete($temporal) }
  }
  return $true
}

function Get-AjbEscritoriosPersonales {
  $perfiles = Get-CimInstance Win32_UserProfile -Filter 'Special=FALSE' -OperationTimeoutSec 8
  $vistos = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($perfil in $perfiles) {
    $local = $perfil.LocalPath
    if (!$local -or !(Test-AjbRutaSinEnlaces $local)) {
      [pscustomobject]@{ Seguro = $false }
      continue
    }
    $local = [IO.Path]::GetFullPath($local).TrimEnd('\')
    $escritorios = @(Join-Path $local 'Desktop')
    if ($perfil.Loaded -and $perfil.SID -match '^S-\d+(?:-\d+)+$') {
      $usuario = "Registry::HKEY_USERS\$($perfil.SID)"
      $clave = Get-Item -LiteralPath "$usuario\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" -ErrorAction SilentlyContinue
      if ($clave) {
        $ruta = $clave.GetValue('Desktop', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($ruta -is [string] -and $ruta) {
          if ($ruta -match '^%USERPROFILE%(?=\\|$)') { $ruta = $local + $ruta.Substring($Matches[0].Length) }
          foreach ($variable in @('OneDrive','OneDriveCommercial','OneDriveConsumer')) {
            $valor = Get-ItemPropertyValue -LiteralPath "$usuario\Environment" -Name $variable -ErrorAction SilentlyContinue
            if ($valor -is [string] -and $valor -match '^[A-Za-z]:\\' -and $ruta -match ('^%' + $variable + '%(?=\\|$)')) {
              $ruta = $valor + $ruta.Substring($Matches[0].Length)
            }
          }
          if ($ruta -match '^[A-Za-z]:\\') { $escritorios += [IO.Path]::GetFullPath($ruta) }
          else { [pscustomobject]@{ Seguro = $false } }
        }
      }
    }
    foreach ($escritorio in $escritorios) {
      if (!$vistos.Add($escritorio)) { continue }
      if (!$escritorio.StartsWith($local + '\', [StringComparison]::OrdinalIgnoreCase) -or !(Test-AjbRutaSinEnlaces $escritorio)) {
        [pscustomobject]@{ Seguro = $false }
      } elseif (Test-Path -LiteralPath $escritorio -PathType Container) {
        [pscustomobject]@{ Seguro = $true; Ruta = $escritorio; Perfil = $local }
      }
    }
  }
}

$errores = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$informe = [ordered]@{ comun_verificado = $false; comunes_actualizados = 0; personales_encontrados = 0; personales_verificados = 0; personales_actualizados = 0; errores = @() }
try {
  $publico = [Environment]::GetFolderPath('CommonDesktopDirectory')
  $carpeta = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'AJB-Predio\Caja'
  if (!$publico -or !(Test-AjbRutaSinEnlaces $publico) -or !(Test-AjbRutaSinEnlaces $carpeta)) { throw 'CARPETAS_NO_DISPONIBLES' }
  $lanzador = Join-Path $carpeta 'abrir-caja.bat'
  $shell = New-Object -ComObject WScript.Shell
  $personales = @()
  try { $personales = @(Get-AjbEscritoriosPersonales) } catch { [void]$errores.Add('PERFILES_NO_ENUMERADOS') }
  $accesosPersonales = @(foreach ($escritorio in $personales) {
    if (!$escritorio.Seguro) { [void]$errores.Add('ESCRITORIO_PERSONAL_NO_VERIFICADO'); continue }
    if ($escritorio.Ruta -ieq $publico) { continue }
    $archivo = Join-Path $escritorio.Ruta $nombreAcceso
    if (!(Test-Path -LiteralPath $archivo)) { continue }
    [pscustomobject]@{ Archivo = $archivo; Perfil = $escritorio.Perfil }
  })
  $informe.personales_encontrados = $accesosPersonales.Count

  $comun = Join-Path $publico $nombreAcceso
  try {
    $creado = $false
    if (!(Test-Path -LiteralPath $comun) -and !$informe.personales_encontrados -and !$errores.Count) {
      if (Test-Path -LiteralPath $lanzador) {
        [void](Set-AjbDireccionLanzador $lanzador $direccion)
        $nuevo = $shell.CreateShortcut($comun)
        $nuevo.TargetPath = $lanzador
        $nuevo.Arguments = '--abrir'
        $nuevo.WorkingDirectory = $carpeta
        $nuevo.WindowStyle = 7
        $nuevo.Description = 'Caja del camping con impresion directa'
        $nuevo.Save()
      } else {
        & (Join-Path $PSScriptRoot 'configurar-acceso-caja.ps1') -Direccion $direccion
      }
      $creado = $true
    }
    if (Test-Path -LiteralPath $comun) {
      $cambiado = Set-AjbAccesoExistente $shell $comun $lanzador $direccion @(Get-AjbNavegadores '')
      $informe.comun_verificado = $true
      if ($creado -or $cambiado) { $informe.comunes_actualizados = 1 }
    }
  } catch { [void]$errores.Add('ACCESO_COMUN_NO_VERIFICADO') }
  foreach ($acceso in $accesosPersonales) {
    try {
      if (Set-AjbAccesoExistente $shell $acceso.Archivo $lanzador $direccion @(Get-AjbNavegadores $acceso.Perfil)) { $informe.personales_actualizados++ }
      $informe.personales_verificados++
    } catch { [void]$errores.Add('ACCESO_PERSONAL_NO_VERIFICADO') }
  }
} catch { [void]$errores.Add('PREPARACION_NO_DISPONIBLE') }
$informe.errores = @($errores | Sort-Object)
$informe | ConvertTo-Json -Compress -Depth 3
