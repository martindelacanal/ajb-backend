@echo off
title Detener el sistema del predio
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo Deteniendo el sistema del predio (vuelve a arrancar solo al reiniciar Windows o en 5 minutos)...
schtasks /End /TN "AJB Predio" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*AJB-Predio*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Detenido.
timeout /t 5
