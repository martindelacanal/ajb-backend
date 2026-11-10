# El agente verifica antes la firma del manifiesto. Esta capa vuelve a comprobar
# la identidad fisica y utiliza solamente ubicaciones/acciones fijas.
# Para detener el acceso: deshabilitar la tarea AJB Mantenimiento SSH Tunel y
# detener sshd. DESHABILITADO impide que el supervisor vuelva a abrir el tunel.
param([Parameter(Mandatory = $true)][string]$PolicyFile)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$fase = 'VALIDACION'
$instalacionMutex = $null
$bloqueoAdquirido = $false
try {
$identidad = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identidad)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'El instalador de mantenimiento requiere una sesion administrativa.'
}
if (-not [Environment]::Is64BitProcess) { throw 'El instalador requiere PowerShell de 64 bits.' }
$policy = Get-Content -LiteralPath $PolicyFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($policy.version -ne 1 -or $policy.accion -ne 'PREPARAR_ACCESO_SSH' -or
    $policy.equipoId -notmatch '^[a-f0-9]{64}$' -or $policy.usuarioWindows -ne 'ajbmantenimiento' -or
    $policy.relayUser -ne 'ajb-miramar-tunnel' -or [int]$policy.relayPort -ne 22222 -or
    [int]$policy.reversePort -ne 22099 -or [int]$policy.sshPort -ne 2222 -or
    $policy.relayHost -ne '52.67.192.228') { throw 'Manifiesto de mantenimiento invalido.' }
$vence = [DateTimeOffset]::Parse([string]$policy.expiresAt)
if ($vence -le [DateTimeOffset]::UtcNow) { throw 'La autorizacion de mantenimiento vencio.' }
$guid = [string](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
if ($guid -notmatch '^[a-zA-Z0-9-]+$') { throw 'No se pudo verificar la identidad fisica de la PC.' }
$sha = [Security.Cryptography.SHA256]::Create()
try { $equipo = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('ajb-predio-equipo:' + $guid.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
if ($equipo -ne $policy.equipoId) { throw 'Esta autorizacion pertenece a otra PC.' }
$instalacionMutex = New-Object Threading.Mutex($false, 'Global\AJB-Mantenimiento-SSH-Instalacion')
try { $bloqueoAdquirido = $instalacionMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $bloqueoAdquirido = $true }
if (-not $bloqueoAdquirido) { throw [Runtime.InteropServices.COMException]::new('Ya hay una preparacion SSH de AJB en curso.', -2147023278) }

function Clave-Publica([string]$Valor) {
  if ($Valor -notmatch '^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$') { throw 'Se requiere una clave publica Ed25519.' }
  $b64 = $Matches[1]
  $bytes = [Convert]::FromBase64String($b64)
  if ($bytes.Length -ne 51 -or [Convert]::ToBase64String($bytes) -ne $b64 -or [BitConverter]::ToString($bytes[0..18]) -ne '00-00-00-0B-73-73-68-2D-65-64-32-35-35-31-39-00-00-00-20') { throw 'La clave publica Ed25519 no es valida.' }
  return 'ssh-ed25519 ' + $b64
}
$operadorPublica = Clave-Publica ([string]$policy.operadorPublicKey)
$relayPublica = Clave-Publica ([string]$policy.relayHostKey)
$Root = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'AJB\Mantenimiento')).TrimEnd('\')
if ($Root -match '["\r\n]') { throw 'La carpeta de mantenimiento no es valida.' }
$sshDirectorio = Join-Path $env:WINDIR 'System32\OpenSSH'
$sshData = Join-Path $env:ProgramData 'ssh'
$sshdConfig = Join-Path $sshData 'sshd_config'
$marcaArchivo = Join-Path $Root 'instalacion.json'
$logArchivo = Join-Path $Root 'instalacion.log'
$taskName = 'AJB Mantenimiento SSH Tunel'
$usuarioNombre = 'ajbmantenimiento'
$marcaConfig = '# AJB_MANTENIMIENTO_SSH_V1'
function Verificar-Ruta([string]$Ruta) {
  # No permitir que una union/enlace preexistente redirija escrituras de SYSTEM.
  $actual = [IO.Path]::GetFullPath($Ruta)
  while ($actual) {
    if (Test-Path -LiteralPath $actual) {
      if ((Get-Item -LiteralPath $actual -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('No se admite un enlace en la ruta: ' + $actual) }
    }
    $actual = [IO.Path]::GetDirectoryName($actual)
  }
}
Verificar-Ruta $Root
Verificar-Ruta $sshdConfig
if (Test-Path -LiteralPath $Root) {
  foreach ($archivo in @(Get-ChildItem -LiteralPath $Root -Force)) { Verificar-Ruta $archivo.FullName }
}
if (Test-Path -LiteralPath (Join-Path $Root 'DESHABILITADO')) { throw 'El acceso fue deshabilitado por el administrador. Retirar la marca es una accion explicita separada.' }
$marca = $null
if (Test-Path -LiteralPath $marcaArchivo) {
  $marca = Get-Content -LiteralPath $marcaArchivo -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marca.equipoId -ne $equipo -or $marca.version -ne 1) { throw 'La configuracion de mantenimiento existente pertenece a otra instalacion.' }
}
$servicioPrevio = Get-Service -Name sshd -ErrorAction SilentlyContinue
$usuarioPrevio = Get-LocalUser -Name $usuarioNombre -ErrorAction SilentlyContinue
if (-not $marca) {
  if ((Test-Path -LiteralPath $Root) -and @(Get-ChildItem -LiteralPath $Root -Force).Count) { throw 'La carpeta de mantenimiento contiene archivos sin una instalacion AJB registrada.' }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Ya existe una tarea de mantenimiento sin una instalacion AJB registrada.' }
  if ($usuarioPrevio) { throw 'Ya existe el usuario de mantenimiento y no tiene una instalacion AJB registrada.' }
  if ($servicioPrevio -and $servicioPrevio.Status -ne 'Stopped') { throw 'Hay un servidor SSH ajeno activo; no se modifica.' }
  if (Test-Path -LiteralPath $sshdConfig) {
    # Una configuracion original detenida puede adoptarse; cualquier diferencia se revisa manualmente.
    $plantilla = Join-Path $sshDirectorio 'sshd_config_default'
    if (-not (Test-Path -LiteralPath $plantilla)) { throw 'Ya existe una configuracion SSH y no se puede verificar que sea original.' }
    $actual = [IO.File]::ReadAllText($sshdConfig).Replace("`r`n", "`n").Trim()
    $original = [IO.File]::ReadAllText($plantilla).Replace("`r`n", "`n").Trim()
    if ($actual -ne $original) { throw 'Ya existe una configuracion SSH personalizada; no se modifica.' }
  }
} elseif (Test-Path -LiteralPath $sshdConfig) {
  $configAjb = [IO.File]::ReadAllText($sshdConfig).StartsWith($marcaConfig)
  $configOriginalPendiente = $marca.estado -eq 'INSTALANDO' -and $marca.configHashAnterior -and (Get-FileHash -LiteralPath $sshdConfig -Algorithm SHA256).Hash -eq $marca.configHashAnterior
  if ($marca.estado -eq 'INSTALANDO' -and -not $marca.configExistia -and -not $configAjb) {
    # Windows puede crear su config original durante una instalacion interrumpida.
    $plantilla = Join-Path $sshDirectorio 'sshd_config_default'
    if (Test-Path -LiteralPath $plantilla) {
      $actual = [IO.File]::ReadAllText($sshdConfig).Replace("`r`n", "`n").Trim()
      $original = [IO.File]::ReadAllText($plantilla).Replace("`r`n", "`n").Trim()
      $configOriginalPendiente = $actual -eq $original
    }
  }
  if (-not $configAjb -and -not $configOriginalPendiente) { throw 'La configuracion SSH fue sustituida fuera de AJB; requiere revision.' }
}

function Proteger([string]$Archivo, [switch]$Carpeta) {
  $acl = if ($Carpeta) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $acl.SetOwner($systemSid)
  foreach ($sid in @($systemSid, $adminSid)) {
    $regla = if ($Carpeta) {
      New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else { New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow') }
    $acl.AddAccessRule($regla)
  }
  Set-Acl -LiteralPath $Archivo -AclObject $acl
}
function Guardar-Texto([string]$Archivo, [string]$Texto) {
  $temporal = $Archivo + '.' + $PID + '.tmp'
  Verificar-Ruta $Archivo
  Verificar-Ruta $temporal
  [IO.File]::WriteAllText($temporal, $Texto, (New-Object Text.UTF8Encoding($false)))
  Proteger $temporal
  Move-Item -LiteralPath $temporal -Destination $Archivo -Force
}
function Escribir-Log([string]$Texto) {
  [IO.File]::AppendAllText($logArchivo, ([DateTime]::UtcNow.ToString('o') + ' ' + $Texto + [Environment]::NewLine))
}
function Crear-Clave([string]$Archivo, [string]$Comentario) {
  if (-not (Test-Path -LiteralPath $Archivo)) {
    # ProcessStartInfo conserva el argumento vacio de -N en Windows PowerShell 5.1.
    $pinfo = New-Object Diagnostics.ProcessStartInfo
    $pinfo.FileName = Join-Path $sshDirectorio 'ssh-keygen.exe'
    $pinfo.Arguments = '-q -t ed25519 -N "" -f "' + $Archivo + '" -C "' + $Comentario + '"'
    $pinfo.UseShellExecute = $false
    $pinfo.CreateNoWindow = $true
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $p = [Diagnostics.Process]::Start($pinfo)
    $salida = $p.StandardOutput.ReadToEnd()
    $fallo = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw ('No se pudo generar la clave de mantenimiento: ' + $fallo.Trim()) }
    $p.Dispose()
  }
  Proteger $Archivo
  if (-not (Test-Path -LiteralPath ($Archivo + '.pub'))) { throw 'La clave publica de mantenimiento no esta disponible.' }
  Proteger ($Archivo + '.pub')
  return Clave-Publica ([IO.File]::ReadAllText($Archivo + '.pub').Trim())
}
function Plan-CapacidadesOpenSsh([object[]]$Estados, [string[]]$ProcesosActivos = @()) {
  # HRESULT_FROM_WIN32(ERROR_INSTALL_ALREADY_RUNNING): no esperar otra instalacion.
  if (@($ProcesosActivos | Where-Object { $_ -match '^(?i:TiWorker|dism|dismhost)\.exe$' }).Count) {
    throw [Runtime.InteropServices.COMException]::new('Windows tiene una operacion de servicing activa; no se inicia otra instalacion.', -2147023278)
  }
  $instalar = [Collections.Generic.List[string]]::new()
  foreach ($estado in $Estados) {
    if ($estado.Name -notin @('OpenSSH.Client~~~~0.0.1.0', 'OpenSSH.Server~~~~0.0.1.0')) { throw 'Windows devolvio una capacidad no prevista.' }
    switch ([string]$estado.State) {
      'Installed' { }
      'NotPresent' { $instalar.Add([string]$estado.Name) }
      'Staged' { $instalar.Add([string]$estado.Name) }
      { $_ -match 'Pending$' -or $_ -eq 'PartiallyInstalled' } {
        # HRESULT_FROM_WIN32(ERROR_SUCCESS_REBOOT_REQUIRED). No repetir Add-Capability.
        throw [Runtime.InteropServices.COMException]::new('OpenSSH tiene una instalacion pendiente; completar el servicing/reinicio de Windows antes de repetir.', -2147021886)
      }
      default { throw 'Windows devolvio un estado de OpenSSH no admitido; se requiere diagnostico.' }
    }
  }
  return $instalar.ToArray()
}

New-Item -ItemType Directory -Path $Root -Force | Out-Null
Proteger $Root -Carpeta
if (-not $marca) {
  $marca = [ordered]@{ version = 1; equipoId = $equipo; estado = 'INSTALANDO'; creado = [DateTime]::UtcNow.ToString('o');
    sshdExistia = [bool]$servicioPrevio; sshdInicioAnterior = if ($servicioPrevio) { [string]$servicioPrevio.StartType } else { $null };
    configExistia = (Test-Path -LiteralPath $sshdConfig); usuarioCreadoPorAjb = $true;
    configHashAnterior = if (Test-Path -LiteralPath $sshdConfig) { (Get-FileHash -LiteralPath $sshdConfig -Algorithm SHA256).Hash } else { $null }; actualizado = $null }
  Guardar-Texto $marcaArchivo ($marca | ConvertTo-Json -Depth 5)
  if (Test-Path -LiteralPath $sshdConfig) { Guardar-Texto (Join-Path $Root 'sshd_config.anterior') ([IO.File]::ReadAllText($sshdConfig)) }
}

try {
  Escribir-Log 'Preparando OpenSSH para mantenimiento autorizado.'
  $fase = 'CAPACIDAD_OPENSSH'
  # Consulta liviana antes de cualquier llamada a DISM. TiWorker puede estar
  # ocioso: se prefiere pedir un reintento posterior a competir con Windows Update.
  $servicingActivo = @(Get-CimInstance Win32_Process -Filter "Name='TiWorker.exe' OR Name='dism.exe' OR Name='dismhost.exe'" | ForEach-Object { [string]$_.Name })
  Plan-CapacidadesOpenSsh @() $servicingActivo | Out-Null
  $firewallExistia = [bool](Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)
  # Evaluar ambas capacidades antes de modificar cualquiera: un servidor Pending
  # tampoco debe provocar una instalacion nueva del cliente.
  $estadosCapacidades = @(foreach ($capacidad in @('OpenSSH.Client~~~~0.0.1.0', 'OpenSSH.Server~~~~0.0.1.0')) {
    Get-WindowsCapability -Online -Name $capacidad
  })
  if ($estadosCapacidades.Count -ne 2) { throw 'Windows no devolvio el estado completo de OpenSSH.' }
  $capacidadesAInstalar = @(Plan-CapacidadesOpenSsh $estadosCapacidades)
  foreach ($capacidad in $capacidadesAInstalar) {
    Escribir-Log ('Instalando capacidad de Windows: ' + $capacidad)
    try {
      # Nunca iniciar otra busqueda/descarga en Windows Update desde el bootstrap.
      # Si falta el payload, se debe proporcionar FoD oficial de la misma version.
      $instalado = Add-WindowsCapability -Online -Name $capacidad -LimitAccess
      if (-not $instalado) { throw 'Windows no confirmo la instalacion desde la fuente local.' }
    } catch {
      Escribir-Log 'Fallo de instalacion con fuente local. Revisar la necesidad de FoD oficial de la misma version de Windows; no se consulto Windows Update.'
      throw
    }
    if ($instalado.RestartNeeded) { throw [Runtime.InteropServices.COMException]::new('Windows requiere reiniciar para completar OpenSSH; la instalacion puede repetirse despues.', -2147021886) }
  }
  # No se abre SSH a la LAN: el unico listener de mantenimiento es loopback.
  # Solo se deshabilita la regla que acaba de crear la instalacion de Windows.
  if (-not $firewallExistia -and (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    Disable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' | Out-Null
  }
  $sshdExe = Join-Path $sshDirectorio 'sshd.exe'
  $keygenExe = Join-Path $sshDirectorio 'ssh-keygen.exe'
  if (-not (Test-Path -LiteralPath $sshdExe) -or -not (Test-Path -LiteralPath $keygenExe)) { throw 'Windows no termino de instalar OpenSSH.' }
  $servicio = Get-CimInstance Win32_Service -Filter "Name='sshd'"
  if (-not $servicio -or $servicio.PathName.Trim('"') -ne $sshdExe) { throw 'El servicio sshd tiene un ejecutable o argumentos no previstos.' }
  $fase = 'CUENTA_WINDOWS'
  if (-not (Get-LocalUser -Name $usuarioNombre -ErrorAction SilentlyContinue)) {
    $aleatorio = New-Object byte[] 36
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($aleatorio) } finally { $rng.Dispose() }
    $password = ConvertTo-SecureString ('A9!a' + [Convert]::ToBase64String($aleatorio)) -AsPlainText -Force
    New-LocalUser -Name $usuarioNombre -Password $password -FullName 'Mantenimiento tecnico AJB' -Description 'Mantenimiento SSH AJB con clave publica' -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires | Out-Null
    $password.Dispose()
    [Array]::Clear($aleatorio, 0, $aleatorio.Length)
  }
  $grupoAdmin = Get-LocalGroup -SID 'S-1-5-32-544'
  $usuario = Get-LocalUser -Name $usuarioNombre
  if (-not @(Get-LocalGroupMember -Group $grupoAdmin.Name | Where-Object { $_.SID -eq $usuario.SID }).Count) {
    Add-LocalGroupMember -Group $grupoAdmin.Name -Member $usuario.SID.Value
  }
  Enable-LocalUser -Name $usuarioNombre
  $fase = 'CLAVES'
  $autorizadasArchivo = Join-Path $Root 'authorized_keys'
  $autorizadas = if (Test-Path -LiteralPath $autorizadasArchivo) { [IO.File]::ReadAllLines($autorizadasArchivo) } else { @() }
  if (-not @($autorizadas | Where-Object { $_.Trim() -eq $operadorPublica }).Count) { $autorizadas = @($autorizadas) + $operadorPublica }
  Guardar-Texto $autorizadasArchivo (($autorizadas -join "`n") + "`n")
  $tunnelPublicKey = Crear-Clave (Join-Path $Root 'tunel_ed25519') 'AJB-Miramar-Tunel'
  $hostPublicKey = Crear-Clave (Join-Path $Root 'ssh_host_ed25519_key') 'AJB-Miramar-Servidor'
  Guardar-Texto (Join-Path $Root 'known_hosts') ('[' + $policy.relayHost + ']:' + $policy.relayPort + ' ' + $relayPublica + "`n")
  Guardar-Texto (Join-Path $Root 'ssh_config') "# Configuracion privada del cliente de mantenimiento AJB.`n"
  $fase = 'CONFIGURACION_SSH'
  $rootSsh = $Root.Replace('\', '/')
  $directorioSsh = $sshDirectorio.Replace('\', '/')
  $textoConfig = @"
$marcaConfig
# Acceso autorizado: claves solamente y sin puerto accesible desde la LAN.
Port 2222
AddressFamily inet
ListenAddress 127.0.0.1
HostKey "$rootSsh/ssh_host_ed25519_key"
AuthorizedKeysFile "$rootSsh/authorized_keys"
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
AuthenticationMethods publickey
AllowUsers ajbmantenimiento
AllowTcpForwarding local
GatewayPorts no
AllowAgentForwarding no
LogLevel VERBOSE
Subsystem sftp "$directorioSsh/sftp-server.exe"
"@
  $configCandidata = Join-Path $Root 'sshd_config.validar'
  Guardar-Texto $configCandidata ($textoConfig + "`n")
  $validacion = & $sshdExe -t -f $configCandidata 2>&1
  if ($LASTEXITCODE -ne 0) { throw ('OpenSSH rechazo la configuracion: ' + ($validacion -join ' ')) }
  New-Item -ItemType Directory -Path $sshData -Force | Out-Null
  Guardar-Texto $sshdConfig ($textoConfig + "`n")
  $conexion = [ordered]@{ version = 1; relayHost = $policy.relayHost; relayPort = [int]$policy.relayPort; relayUser = $policy.relayUser;
    reversePort = [int]$policy.reversePort; sshPort = [int]$policy.sshPort; equipoId = $equipo }
  Guardar-Texto (Join-Path $Root 'conexion.json') ($conexion | ConvertTo-Json)
  $scriptOrigen = Join-Path $PSScriptRoot 'mantener-tunel-ssh.ps1'
  $scriptDestino = Join-Path $Root 'mantener-tunel-ssh.ps1'
  Guardar-Texto $scriptDestino ([IO.File]::ReadAllText($scriptOrigen))
  $fase = 'SERVICIO_SSH'
  Set-Service -Name sshd -StartupType Automatic
  if ((Get-Service sshd).Status -eq 'Running') { Restart-Service -Name sshd } else { Start-Service -Name sshd }
  $puertos = @()
  for ($intento = 0; $intento -lt 10 -and -not $puertos.Count; $intento++) {
    $sshdPid = (Get-CimInstance Win32_Service -Filter "Name='sshd'").ProcessId
    if ($sshdPid) { $puertos = @(Get-NetTCPConnection -State Listen -OwningProcess $sshdPid -ErrorAction SilentlyContinue) }
    if (-not $puertos.Count) { Start-Sleep -Seconds 1 }
  }
  if (-not $puertos.Count -or @($puertos | Where-Object { $_.LocalAddress -ne '127.0.0.1' -or $_.LocalPort -ne 2222 }).Count) {
    Stop-Service -Name sshd
    throw 'El servidor SSH no quedo limitado a 127.0.0.1:2222; se detuvo.'
  }
  $fase = 'TUNEL'
  $powershellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $accionTarea = New-ScheduledTaskAction -Execute $powershellExe -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptDestino + '"') -WorkingDirectory $Root
  $inicio = New-ScheduledTaskTrigger -AtStartup
  $revision = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $opciones = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $taskName -Action $accionTarea -Trigger @($inicio, $revision) -Principal $principal -Settings $opciones -Description 'Tunel SSH saliente autorizado para mantenimiento de AJB Miramar. Independiente del servidor del camping.' -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  $fase = 'VERIFICACION'
  $tareaActiva = $false
  for ($intento = 0; $intento -lt 10 -and -not $tareaActiva; $intento++) {
    $tareaActiva = (Get-ScheduledTask -TaskName $taskName).State -eq 'Running'
    if (-not $tareaActiva) { Start-Sleep -Seconds 1 }
  }
  if (-not $tareaActiva) { throw 'La tarea de reconexion no permanecio activa.' }
  $marca.estado = 'ACTIVO'
  $marca.actualizado = [DateTime]::UtcNow.ToString('o')
  Guardar-Texto $marcaArchivo ($marca | ConvertTo-Json -Depth 5)
  Escribir-Log 'Servidor SSH local iniciado y tarea de reconexion registrada. La autorizacion de la clave publica en AWS puede completarse ahora.'
  $tunnelFingerprint = (& $keygenExe -lf (Join-Path $Root 'tunel_ed25519.pub') -E sha256 | Out-String).Trim()
  $hostFingerprint = (& $keygenExe -lf (Join-Path $Root 'ssh_host_ed25519_key.pub') -E sha256 | Out-String).Trim()
  [ordered]@{ estado = 'PREPARADO'; usuarioWindows = $usuarioNombre; sshPort = 2222; reversePort = 22099;
    tunnelPublicKey = $tunnelPublicKey; sshHostPublicKey = $hostPublicKey; tunnelFingerprint = $tunnelFingerprint; sshHostFingerprint = $hostFingerprint;
    relayHost = $policy.relayHost; relayPort = [int]$policy.relayPort; carpeta = $Root; tarea = $taskName; servicio = 'sshd'; hostname = $env:COMPUTERNAME } | ConvertTo-Json -Compress
} catch {
  Escribir-Log ('ERROR: ' + $_.Exception.Message)
  throw
}
} catch {
  # El agente transmite solo estas etiquetas fijas. El detalle queda en el log
  # protegido de la notebook y nunca viaja en stdout ni en la respuesta remota.
  [ordered]@{ estado = 'ERROR'; fase = $fase; codigo = [int]$_.Exception.HResult } | ConvertTo-Json -Compress
} finally {
  if ($bloqueoAdquirido) { $instalacionMutex.ReleaseMutex() }
  if ($instalacionMutex) { $instalacionMutex.Dispose() }
}
