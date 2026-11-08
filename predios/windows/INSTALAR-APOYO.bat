@echo off
setlocal EnableExtensions DisableDelayedExpansion
title AJB Predio - Instalar equipo de apoyo
rem La ruta del paquete viaja como variable, nunca se inserta dentro de codigo PowerShell.
set "AJB_APOYO_INSTALADOR=%~dp0instalador\configurar-apoyo.ps1"
if not exist "%AJB_APOYO_INSTALADOR%" set "AJB_APOYO_INSTALADOR=%~dp0configurar-apoyo.ps1"
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $ruta=$env:AJB_APOYO_INSTALADOR; $p=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',([char]34+$ruta+[char]34)) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%AJB_APOYO_INSTALADOR%" %*
)
set "AJB_APOYO_RESULTADO=%errorlevel%"
echo.
if "%AJB_APOYO_RESULTADO%" equ "0" (
  rem Si este usuario tenia un acceso fijo anterior, apuntarlo al acceso de caja recien instalado.
  set "AJB_APOYO_ORIGEN=%~dp0"
  powershell.exe -NoProfile -Command "$p=Get-Content -LiteralPath (Join-Path $env:AJB_APOYO_ORIGEN 'predio-ha.json') -Raw -Encoding UTF8 | ConvertFrom-Json; if ($p.accesoQuorum -eq $true) { $n='Sistema del Camping - Caja.lnk'; $actual=Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) $n; $nuevo=Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) $n; if ($actual -ne $nuevo -and (Test-Path -LiteralPath $actual)) { Copy-Item -LiteralPath $nuevo -Destination $actual -Force } }"
  echo Instalacion completada. Revisa el estado de esta PC en Sistema.
) else (
  echo La instalacion no se completo. Si se creo una carpeta de instalacion, usa CONTINUAR-INSTALACION.bat dentro de ella.
)
pause
exit /b %AJB_APOYO_RESULTADO%
