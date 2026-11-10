# Tarea independiente del servidor del camping. No copia claves privadas fuera de esta PC.
param([string]$Root = (Join-Path $env:ProgramData 'AJB\Mantenimiento'))

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$esperada = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'AJB\Mantenimiento')).TrimEnd('\')
if ($Root -ne $esperada) { throw 'Carpeta de mantenimiento inesperada.' }
$conexionArchivo = Join-Path $Root 'conexion.json'
$deshabilitado = Join-Path $Root 'DESHABILITADO'
$sshExe = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$logArchivo = Join-Path $Root 'tunel.log'
$sshLog = Join-Path $Root 'ssh-cliente.log'
$mutex = New-Object Threading.Mutex($false, 'Global\AJB-Mantenimiento-SSH-Tunel')
$adquirido = $false

function Escribir-Log([string]$Texto) {
  if ((Test-Path -LiteralPath $logArchivo) -and (Get-Item -LiteralPath $logArchivo).Length -gt 2097152) {
    Move-Item -LiteralPath $logArchivo -Destination ($logArchivo + '.anterior') -Force
  }
  [IO.File]::AppendAllText($logArchivo, ([DateTime]::UtcNow.ToString('o') + ' ' + $Texto + [Environment]::NewLine))
}

try {
  try { $adquirido = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $adquirido = $true }
  if (-not $adquirido) { exit 0 }
  while (-not (Test-Path -LiteralPath $deshabilitado)) {
    try {
      $c = Get-Content -LiteralPath $conexionArchivo -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($c.version -ne 1 -or $c.relayHost -ne '52.67.192.228' -or
          $c.relayUser -ne 'ajb-miramar-tunnel' -or [int]$c.relayPort -ne 22222 -or
          [int]$c.reversePort -ne 22099 -or [int]$c.sshPort -ne 2222) { throw 'Configuracion del tunel invalida.' }
      if (-not (Test-Path -LiteralPath $sshExe)) { throw 'Falta el cliente OpenSSH de Windows.' }
      if ((Test-Path -LiteralPath $sshLog) -and (Get-Item -LiteralPath $sshLog).Length -gt 2097152) {
        Move-Item -LiteralPath $sshLog -Destination ($sshLog + '.anterior') -Force
      }
      $argumentosSsh = @('-F', (Join-Path $Root 'ssh_config'), '-N', '-T',
        '-i', (Join-Path $Root 'tunel_ed25519'), '-E', $sshLog,
        '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', ('UserKnownHostsFile=' + (Join-Path $Root 'known_hosts')),
        '-o', 'GlobalKnownHostsFile=NUL', '-o', 'HostKeyAlgorithms=ssh-ed25519',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR',
        '-R', ('127.0.0.1:' + $c.reversePort + ':127.0.0.1:' + $c.sshPort),
        '-p', [string]$c.relayPort, ($c.relayUser + '@' + $c.relayHost))
      Escribir-Log 'Conectando el tunel de mantenimiento.'
      & $sshExe @argumentosSsh
      Escribir-Log ('El tunel termino. Codigo: ' + $LASTEXITCODE + '. Se reintentara en 10 segundos.')
    } catch {
      Escribir-Log ('No se pudo mantener el tunel: ' + $_.Exception.Message)
    }
    if (-not (Test-Path -LiteralPath $deshabilitado)) { Start-Sleep -Seconds 10 }
  }
  Escribir-Log 'Tunel deshabilitado por el administrador.'
} finally {
  if ($adquirido) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
