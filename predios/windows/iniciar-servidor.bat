@echo off
title Iniciar el sistema del predio
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0control-servidor.ps1" -Accion Iniciar
if errorlevel 1 (echo No se pudo iniciar el servidor. & pause & exit /b 1)
echo Servidor iniciado con la configuracion de arranque actual.
pause
