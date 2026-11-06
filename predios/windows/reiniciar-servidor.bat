@echo off
title Reiniciar el sistema del predio
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0control-servidor.ps1" -Accion Reiniciar
if errorlevel 1 (echo No se pudo reiniciar el servidor. & pause & exit /b 1)
echo Servidor iniciado. El arranque automatico vuelve a estar habilitado.
pause
