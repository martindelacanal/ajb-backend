[CmdletBinding()]
param(
    [switch]$Estado,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Comando
)
$ErrorActionPreference = 'Stop'
$config = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\ajb_predio_config'
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    throw 'Falta .ssh\ajb_predio_config. Consultar ACCESO-PREDIO.md; las claves privadas no se guardan en el proyecto.'
}
if ($Estado) {
    if ($Comando.Count) { throw 'Usar -Estado o un comando, no ambos.' }
    $consulta = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$s = Get-Service sshd
$t = Get-ScheduledTask -TaskName 'AJB Mantenimiento SSH Tunel'
$app = Get-ScheduledTask -TaskName 'AJB Predio'
[ordered]@{equipo=$env:COMPUTERNAME;usuario=[Security.Principal.WindowsIdentity]::GetCurrent().Name;ssh=[string]$s.Status;tunel=[string]$t.State;predio=[string]$app.State;fecha=(Get-Date).ToString('o')} | ConvertTo-Json -Compress
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($consulta))
    & ssh.exe -F $config ajb-miramar powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded
} else {
    & ssh.exe -F $config ajb-miramar @Comando
}
if ($LASTEXITCODE -ne 0) { throw "SSH termino con codigo $LASTEXITCODE. Consultar ACCESO-PREDIO.md." }
