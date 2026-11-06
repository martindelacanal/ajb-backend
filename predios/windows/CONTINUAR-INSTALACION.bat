@echo off
setlocal EnableExtensions DisableDelayedExpansion
title AJB Predio - Continuar instalacion
set "AJB_APOYO_CONTINUAR=%~dp0herramientas\continuar-apoyo.ps1"
if not exist "%AJB_APOYO_CONTINUAR%" (
  echo No se encontro la instalacion de apoyo. No se modifico ningun archivo.
  pause
  exit /b 1
)
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell.exe -NoProfile -Command "$ruta=$env:AJB_APOYO_CONTINUAR; $p=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',([char]34+$ruta+[char]34)) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode"
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%AJB_APOYO_CONTINUAR%"
echo.
pause
