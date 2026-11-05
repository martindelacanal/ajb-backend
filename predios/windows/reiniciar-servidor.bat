@echo off
title Reiniciar el sistema del predio
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo Reiniciando el sistema del predio...
schtasks /End /TN "AJB Predio" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*AJB-Predio*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 3 /nobreak >nul
schtasks /Run /TN "AJB Predio"
echo Listo. En unos segundos vuelve a estar disponible.
timeout /t 5
