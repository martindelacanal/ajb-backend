# Asistente local: valida el archivo cifrado y recupera en una carpeta nueva,
# detenida. La clave sólo viaja al proceso Node por su entrada estandar.
#requires -Version 5.1
param([string]$Base)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

if (-not $Base) {
  $candidato = Split-Path -Parent $PSScriptRoot
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node\node.exe')) { $candidato = $PSScriptRoot }
  $Base = $candidato
}
$Base = [IO.Path]::GetFullPath($Base)
$node = Join-Path $Base 'node\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Abrí este asistente desde una instalación o un paquete completo del predio, que incluya Node portable.' }
$version = (Get-Content -LiteralPath (Join-Path $Base 'app\ACTUAL') -Raw -Encoding UTF8).Trim()
if ($version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,100}$' -or $version.Contains('..')) { throw 'La versión de la instalación no es válida.' }
$cli = Join-Path $Base ('app\versiones\' + $version + '\lib\recuperar-respaldo.js')
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Actualizá la instalación del predio para usar el asistente de recuperación.' }

function Pedir-Clave {
  $xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="Abrir respaldo completo" SizeToContent="WidthAndHeight" WindowStartupLocation="CenterScreen" ResizeMode="NoResize">
  <StackPanel Margin="24" Width="360">
    <TextBlock Text="Clave de recuperación" FontSize="18" FontWeight="SemiBold" Margin="0,0,0,12" />
    <PasswordBox Name="Clave" FontSize="16" Padding="8" MaxLength="1024" />
    <TextBlock Name="Error" Foreground="#a12d2d" TextWrapping="Wrap" Margin="0,8,0,0" />
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
      <Button Name="Cancelar" Content="Cancelar" Padding="14,7" Margin="0,0,8,0" IsCancel="True" />
      <Button Name="Continuar" Content="Continuar" Padding="14,7" IsDefault="True" />
    </StackPanel>
  </StackPanel>
</Window>
'@
  $ventana = [Windows.Markup.XamlReader]::Parse($xaml)
  $campo = $ventana.FindName('Clave')
  $ventana.FindName('Continuar').Add_Click({
    if ($campo.SecurePassword.Length -lt 12) { $ventana.FindName('Error').Text = 'Ingresá la clave de al menos 12 caracteres con la que creaste el respaldo.'; return }
    $ventana.DialogResult = $true
  })
  $ventana.Add_ContentRendered({ $campo.Focus() | Out-Null })
  if ($ventana.ShowDialog() -ne $true) { $campo.Clear(); return $null }
  $secreta = $campo.SecurePassword.Copy()
  $campo.Clear()
  return $secreta
}

function Invocar-Recuperacion([hashtable]$Datos, [Security.SecureString]$Clave) {
  $puntero = [IntPtr]::Zero
  $proceso = $null
  try {
    $puntero = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Clave)
    $plana = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($puntero)
    $Datos.clave = $plana
    $entrada = $Datos | ConvertTo-Json -Depth 4 -Compress
    $inicio = New-Object Diagnostics.ProcessStartInfo
    $inicio.FileName = $node
    $inicio.Arguments = '"' + $cli + '"'
    $inicio.WorkingDirectory = $Base
    $inicio.UseShellExecute = $false
    $inicio.CreateNoWindow = $true
    $inicio.RedirectStandardInput = $true
    $inicio.RedirectStandardOutput = $true
    $inicio.RedirectStandardError = $true
    $proceso = New-Object Diagnostics.Process
    $proceso.StartInfo = $inicio
    $proceso.Start() | Out-Null
    $proceso.StandardInput.Write($entrada)
    $proceso.StandardInput.Close()
    $salida = $proceso.StandardOutput.ReadToEnd()
    $fallo = $proceso.StandardError.ReadToEnd()
    $proceso.WaitForExit()
    if ($proceso.ExitCode -ne 0) {
      try { $detalle = ($fallo | ConvertFrom-Json).mensaje } catch { $detalle = 'No se pudo recuperar el respaldo.' }
      throw $detalle
    }
    return $salida | ConvertFrom-Json
  } finally {
    $Datos.Remove('clave')
    $plana = $null; $entrada = $null
    if ($puntero -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($puntero) }
    if ($proceso) { $proceso.Dispose() }
  }
}

$clave = $null
try {
  $archivo = New-Object Windows.Forms.OpenFileDialog
  $archivo.Title = 'Elegí el respaldo completo'
  $archivo.Filter = 'Respaldo completo AJB (*.ajbrespaldo)|*.ajbrespaldo'
  $archivo.CheckFileExists = $true
  if ($archivo.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { exit 0 }
  $clave = Pedir-Clave
  if (-not $clave) { exit 0 }
  Write-Host 'Validando el respaldo...'
  $validado = Invocar-Recuperacion @{ accion = 'validar'; archivo = $archivo.FileName } $clave
  $r = $validado.resumen
  $fecha = try { ([DateTimeOffset]::Parse($r.generado)).ToLocalTime().ToString('dd/MM/yyyy HH:mm') } catch { [string]$r.generado }
  $texto = "Predio: $($r.predio)`nCreado: $fecha`nCambios pendientes: $($r.pendientes)`nVersión: $($r.version)"
  if ([Windows.Forms.MessageBox]::Show($texto, 'Respaldo validado', 'OKCancel', 'Information') -ne [Windows.Forms.DialogResult]::OK) { exit 0 }
  $carpeta = New-Object Windows.Forms.FolderBrowserDialog
  $carpeta.Description = 'Elegí dónde crear la carpeta nueva de recuperación'
  $carpeta.ShowNewFolderButton = $false
  if ($carpeta.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { exit 0 }
  $destino = Join-Path $carpeta.SelectedPath ('AJB-Predio-Recuperado-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  if ([Windows.Forms.MessageBox]::Show("Se recuperará en:`n$destino`n`nEl sistema quedará en espera.", 'Recuperar respaldo', 'OKCancel', 'Information') -ne [Windows.Forms.DialogResult]::OK) { exit 0 }
  Write-Host 'Recuperando el respaldo en una carpeta nueva...'
  $resultado = Invocar-Recuperacion @{ accion = 'restaurar'; archivo = $archivo.FileName; destino = $destino; sha256Esperado = $validado.sha256 } $clave
  [Windows.Forms.MessageBox]::Show("$($resultado.mensaje)`n`nCarpeta: $($resultado.carpeta)", 'Recuperado en espera', 'OK', 'Information') | Out-Null
} catch {
  [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'No se pudo recuperar el respaldo', 'OK', 'Error') | Out-Null
  exit 1
} finally { if ($clave) { $clave.Dispose() } }
