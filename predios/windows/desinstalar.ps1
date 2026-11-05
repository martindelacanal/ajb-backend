# Quita el arranque automático y la regla de firewall. NO borra la carpeta ni la base de datos.
$ErrorActionPreference = "Continue"
$NombreTarea = "AJB Predio"
Stop-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $NombreTarea -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*AJB-Predio*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-NetFirewallRule -DisplayName "AJB Predio*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "Se quito el arranque automatico y la regla de firewall. La carpeta C:\AJB-Predio (con la base de datos y los respaldos) quedo intacta." -ForegroundColor Green
