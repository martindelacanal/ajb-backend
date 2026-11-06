@echo off
title Detener el sistema del predio
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0control-servidor.ps1" -Accion Detener
if errorlevel 1 (echo No se pudo detener el servidor. & pause & exit /b 1)
echo Servidor detenido. El arranque automatico queda desactivado, incluso despues de reiniciar Windows.
echo Para volver a habilitarlo, usa reiniciar-servidor.bat.
pause
