# Diagnostico fijo de solo lectura. El agente valida antes firma, destino y vigencia.
# No invoca DISM/Get-WindowsCapability: pueden esperar al servicing de Windows.
# No devuelve configuraciones, comandos de procesos, claves privadas ni logs libres.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$raiz = Join-Path $env:ProgramData 'AJB\Mantenimiento'
$openSsh = Join-Path $env:WINDIR 'System32\OpenSSH'
$errores = [Collections.Generic.List[string]]::new()
$eventos = [Collections.Generic.List[object]]::new()
$r = [ordered]@{ estado = 'DIAGNOSTICO'; fecha = [DateTime]::UtcNow.ToString('o'); hostname = $env:COMPUTERNAME;
  usuarioExiste = $false; reinicioPendiente = $null; marca = 'AUSENTE'; archivos = @(); servicios = @(); tareas = @(); procesos = @(); capacidades = @(); eventos = @(); erroresLectura = @() }
try { $r.usuarioExiste = [bool](Get-LocalUser -Name 'ajbmantenimiento' -ErrorAction SilentlyContinue) } catch { $errores.Add('USUARIO') }
$sistemaUpdate = $null
try {
  # Propiedad de solo lectura; no busca, instala ni modifica actualizaciones.
  # https://learn.microsoft.com/en-us/windows/win32/api/wuapi/nf-wuapi-isysteminformation-get_rebootrequired
  $sistemaUpdate = New-Object -ComObject Microsoft.Update.SystemInfo
  $r.reinicioPendiente = [bool]$sistemaUpdate.RebootRequired
} catch { $errores.Add('REINICIO') }
finally { if ($null -ne $sistemaUpdate) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($sistemaUpdate) } }
try {
  $archivoMarca = Join-Path $raiz 'instalacion.json'
  if (Test-Path -LiteralPath $archivoMarca) {
    $marca = Get-Content -LiteralPath $archivoMarca -Raw -Encoding UTF8 | ConvertFrom-Json
    $r.marca = if ($marca.estado -in @('INSTALANDO', 'ACTIVO')) { [string]$marca.estado } else { 'DESCONOCIDO' }
  }
} catch { $r.marca = 'DESCONOCIDO'; $errores.Add('MARCA') }
try {
  $archivos = [ordered]@{ DIRECTORIO = $raiz; MARCA = (Join-Path $raiz 'instalacion.json'); INSTALACION_LOG = (Join-Path $raiz 'instalacion.log');
    SSHD = (Join-Path $openSsh 'sshd.exe'); SSH = (Join-Path $openSsh 'ssh.exe'); SSH_KEYGEN = (Join-Path $openSsh 'ssh-keygen.exe');
    CONFIG_SSH = (Join-Path $env:ProgramData 'ssh\sshd_config'); TUNEL_PUBLICA = (Join-Path $raiz 'tunel_ed25519.pub');
    HOST_PUBLICA = (Join-Path $raiz 'ssh_host_ed25519_key.pub'); DESHABILITADO = (Join-Path $raiz 'DESHABILITADO') }
  $r.archivos = @(foreach ($nombre in $archivos.Keys) {
    $f = Get-Item -LiteralPath $archivos[$nombre] -Force -ErrorAction SilentlyContinue
    [ordered]@{ nombre = $nombre; existe = [bool]$f; tamano = if ($f -and -not $f.PSIsContainer) { [long]$f.Length } else { 0 } }
  })
} catch { $errores.Add('ARCHIVOS') }
try {
  $r.servicios = @(foreach ($nombre in @('sshd', 'TrustedInstaller', 'wuauserv')) {
    $s = Get-Service -Name $nombre -ErrorAction SilentlyContinue
    [ordered]@{ nombre = $nombre; estado = if ($s) { [string]$s.Status } else { 'AUSENTE' }; inicio = if ($s) { [string]$s.StartType } else { 'AUSENTE' } }
  })
} catch { $errores.Add('SERVICIOS') }
try {
  $r.tareas = @(foreach ($nombre in @('AJB Predio', 'AJB Mantenimiento SSH Tunel')) {
    $t = Get-ScheduledTask -TaskName $nombre -ErrorAction SilentlyContinue
    [ordered]@{ nombre = $nombre; estado = if ($t) { [string]$t.State } else { 'AUSENTE' } }
  })
} catch { $errores.Add('TAREAS') }
try {
  $r.procesos = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='dism.exe' OR Name='dismhost.exe' OR Name='TiWorker.exe' OR Name='TrustedInstaller.exe' OR Name='MsMpEng.exe' OR Name='ssh.exe' OR Name='sshd.exe'" |
    Select-Object -First 64 | ForEach-Object { [ordered]@{ nombre = $_.Name.ToLowerInvariant(); pid = [long]$_.ProcessId; padre = [long]$_.ParentProcessId } })
} catch { $errores.Add('PROCESOS') }
try {
  # Estados CBS numericos, sin inferir que un paquete parcial equivale a capacidad instalada.
  $cbs = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\Packages\*OpenSSH*'
  $r.capacidades = @(Get-Item -Path $cbs -ErrorAction SilentlyContinue | Select-Object -First 32 | ForEach-Object {
    [ordered]@{ paquete = $_.PSChildName; codigoEstado = $_.GetValue('CurrentState', $null) }
  })
} catch { $errores.Add('CAPACIDADES') }
function Evento-Seguro([string]$Linea, [string]$Origen) {
  $evento = $null
  if ($Origen -eq 'DISM') {
    # HRESULT de exito (0/S_FALSE) no es un error: un fallo tiene el bit alto.
    if ($Linea -match '(?i)\b(error|failed)\b' -or $Linea -match '(?i)HRESULT\s*[=:]?\s*0x[89a-f][0-9a-f]{7}\b') { $evento = 'ERROR_DISM' }
  }
  elseif ($Linea -match 'Preparando OpenSSH') { $evento = 'INICIO' }
  elseif ($Linea -match 'Instalando capacidad de Windows: OpenSSH.Client') { $evento = 'INSTALANDO_CLIENTE' }
  elseif ($Linea -match 'Instalando capacidad de Windows: OpenSSH.Server') { $evento = 'INSTALANDO_SERVIDOR' }
  elseif ($Linea -match 'Servidor SSH local iniciado') { $evento = 'PREPARADO' }
  elseif ($Linea -match 'ERROR:') {
    $evento = 'ERROR_OTRO'
    if ($Linea -match 'requiere reiniciar') { $evento = 'ERROR_REINICIO' }
    elseif ($Linea -match 'rechazo la configuracion|configuracion SSH|127.0.0.1:2222') { $evento = 'ERROR_CONFIG_SSH' }
    elseif ($Linea -match 'generar la clave|clave publica') { $evento = 'ERROR_CLAVES' }
    elseif ($Linea -match 'instalar OpenSSH|WindowsCapability|capacidad de Windows') { $evento = 'ERROR_CAPACIDAD' }
    elseif ($Linea -match '(?i)access is denied|acceso denegado|UnauthorizedAccess|permission') { $evento = 'ERROR_PERMISOS' }
  }
  if (-not $evento) { return }
  $fecha = if ($Linea -match '^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,7})?Z?)') { $Matches[1] } else { $null }
  $codigo = if ($Linea -match '(?i)\b(0x[0-9a-f]{8})\b') { $Matches[1] } else { $null }
  return [ordered]@{ origen = $Origen; evento = $evento; fecha = $fecha; codigo = $codigo }
}
foreach ($origen in @('INSTALACION', 'DISM')) {
  try {
    $archivo = if ($origen -eq 'INSTALACION') { Join-Path $raiz 'instalacion.log' } else { Join-Path $env:WINDIR 'Logs\DISM\dism.log' }
    if (Test-Path -LiteralPath $archivo) {
      $ultimos = @(Get-Content -LiteralPath $archivo -Tail 100 -Encoding UTF8 | ForEach-Object { Evento-Seguro ([string]$_) $origen } | Select-Object -Last 20)
      foreach ($evento in $ultimos) { $eventos.Add($evento) }
    }
  } catch { $errores.Add('LOG_' + $origen) }
}
$r.eventos = @($eventos.ToArray())
try {
  foreach ($par in @(@('tunnelPublicKey', 'tunel_ed25519.pub'), @('sshHostPublicKey', 'ssh_host_ed25519_key.pub'))) {
    $archivo = Join-Path $raiz $par[1]
    if ((Test-Path -LiteralPath $archivo) -and (Get-Item -LiteralPath $archivo).Length -le 512) {
      $clave = [IO.File]::ReadAllText($archivo).Trim()
      if ($clave -match '^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$') { $r[$par[0]] = 'ssh-ed25519 ' + $Matches[1] }
    }
  }
} catch { $errores.Add('CLAVES') }
$r.erroresLectura = @($errores.ToArray())
$r | ConvertTo-Json -Depth 6 -Compress
