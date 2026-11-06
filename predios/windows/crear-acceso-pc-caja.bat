@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Impresion directa - Sistema del Camping
rem La preparacion de Windows completa la direccion del servidor de esta caja.
set "AJB_DIRECCION="
if /i "%~1"=="--abrir" if not defined AJB_DIRECCION exit /b 1
if not defined AJB_DIRECCION (
  echo Escribi la direccion del sistema del camping, por ejemplo https://camping:8443
  set /p "AJB_DIRECCION=Direccion: "
)
if not defined AJB_DIRECCION exit /b 1

set "AJB_NAVEGADOR="
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" "%LocalAppData%\Microsoft\Edge\Application\msedge.exe") do (
  if not defined AJB_NAVEGADOR if exist "%%~P" set "AJB_NAVEGADOR=%%~P"
)
if /i "%~1"=="--abrir" goto abrir
if not defined AJB_NAVEGADOR (
  echo Para imprimir directo, instala Chrome o Edge y volve a ejecutar este archivo.
  echo Mientras tanto podes imprimir desde el navegador eligiendo la tiquetera.
  pause
  exit /b 1
)

rem Un perfil de caja independiente conserva los flags incluso con el navegador habitual abierto.
rem Nunca insertar la direccion ingresada en el codigo de PowerShell ni en una orden de cmd.
powershell.exe -NoProfile -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$entrada = $env:AJB_DIRECCION.Trim(); if ($entrada -notmatch '^https?://') { $entrada = 'http://' + $entrada };" ^
  "$url = [uri]$entrada; if (!$url.IsAbsoluteUri -or !$url.Host -or $url.UserInfo -or @('http','https') -notcontains $url.Scheme) { throw 'Direccion del camping invalida' };" ^
  "$origen = $url.GetLeftPart([UriPartial]::Authority) + '/';" ^
  "$perfil = Join-Path $env:LOCALAPPDATA ('AJB-Predio\Caja\' + [IO.Path]::GetFileNameWithoutExtension($env:AJB_NAVEGADOR));" ^
  "$escritorio = [Environment]::GetFolderPath('DesktopDirectory');" ^
  "$archivo = Join-Path $escritorio 'Sistema del Camping - Caja.lnk';" ^
  "$acceso = (New-Object -ComObject WScript.Shell).CreateShortcut($archivo);" ^
  "$acceso.TargetPath = $env:AJB_NAVEGADOR;" ^
  "$acceso.Arguments = '--no-first-run --kiosk-printing --use-system-default-printer --user-data-dir=' + [char]34 + $perfil + [char]34 + ' --app=' + $origen;" ^
  "$acceso.Description = 'Caja del camping con impresion directa'; $acceso.Save();" ^
  "Write-Host 'Acceso creado: Sistema del Camping - Caja. Los tickets iran a la impresora predeterminada de Windows.';" ^
  "Start-Process -FilePath $archivo"
if errorlevel 1 (
  echo No se pudo preparar el acceso. Revisa la direccion y volve a intentarlo.
  pause
  exit /b 1
)
exit /b 0

:abrir
rem Usar el perfil del cajero que abre el acceso, nunca el del instalador o SYSTEM.
if not defined AJB_NAVEGADOR (
  start "" "%AJB_DIRECCION%"
  exit /b
)
for %%N in ("%AJB_NAVEGADOR%") do start "" "%%~N" --no-first-run --kiosk-printing --use-system-default-printer "--user-data-dir=%LOCALAPPDATA%\AJB-Predio\Caja\%%~nN" "--app=%AJB_DIRECCION%"
