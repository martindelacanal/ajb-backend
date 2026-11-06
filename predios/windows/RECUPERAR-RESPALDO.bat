@echo off
setlocal EnableExtensions DisableDelayedExpansion
title AJB Predio - Recuperar respaldo completo
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0recuperar-respaldo.ps1"
if errorlevel 1 pause
