# Quita el arranque automático y la regla de firewall. NO borra la carpeta ni la base de datos.
param([string]$Base = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = "Stop"
$Base = [IO.Path]::GetFullPath($Base).TrimEnd('\')
& (Join-Path $PSScriptRoot 'control-servidor.ps1') -Base $Base -Accion Detener
$NombreTarea = "AJB Predio"
Stop-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $NombreTarea -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'AJB Predio Control' -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName "AJB Predio*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -Name 'AJB-Predio-HTTPS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "Se quito el arranque automatico y la regla de firewall. La carpeta C:\AJB-Predio (con la base de datos y los respaldos) quedo intacta." -ForegroundColor Green
