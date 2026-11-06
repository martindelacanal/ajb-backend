@echo off
setlocal EnableExtensions DisableDelayedExpansion
title AJB Predio - Instalar equipo de apoyo
rem La ruta del paquete viaja como variable, nunca se inserta dentro de codigo PowerShell.
set "AJB_APOYO_INSTALADOR=%~dp0instalador\configurar-apoyo.ps1"
if not exist "%AJB_APOYO_INSTALADOR%" set "AJB_APOYO_INSTALADOR=%~dp0configurar-apoyo.ps1"
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell.exe -NoProfile -Command "$ruta=$env:AJB_APOYO_INSTALADOR; Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',([char]34+$ruta+[char]34)) -Verb RunAs -WindowStyle Hidden -Wait"
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%AJB_APOYO_INSTALADOR%" %*
echo.
pause
