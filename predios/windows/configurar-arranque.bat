@echo off
title Arranque automatico del sistema del predio
echo 1. Activar el arranque con Windows (predeterminado).
echo 2. Iniciar el servidor solamente de forma manual.
choice /c 12 /n /m "Elegi una opcion: "
if errorlevel 2 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0control-servidor.ps1" -Accion Configurar -Automatico Desactivar
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0control-servidor.ps1" -Accion Configurar -Automatico Activar
)
pause
