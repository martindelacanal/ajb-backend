@echo off
setlocal EnableDelayedExpansion
title Acceso directo al sistema del camping
rem Ejecutar en cada PC de las bocas. Crea en el escritorio un acceso que abre el sistema
rem en una ventana propia y, en Chrome o Edge, imprime los tickets sin mostrar el cuadro de impresion.
echo.
echo  Acceso directo al Sistema del Camping
echo  -------------------------------------
echo  Escribi la direccion que figura en la notebook servidor
echo  (por ejemplo http://192.168.0.10:8080):
echo.
set /p URL=  Direccion: 
if "%URL%"=="" (
  echo No se escribio ninguna direccion.
  pause
  exit /b
)
if /i not "%URL:~0,4%"=="http" set URL=http://%URL%
set NAV=
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe") do (
  if not defined NAV if exist %%P set NAV=%%~P
)
set ESCRITORIO=%USERPROFILE%\Desktop
if defined NAV (
  powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%ESCRITORIO%\Sistema del Camping.lnk'); $s.TargetPath='!NAV!'; $s.Arguments='--app=%URL% --kiosk-printing'; $s.Description='Sistema del Camping (AJB)'; $s.Save()"
  echo.
  echo  Listo: en el escritorio quedo "Sistema del Camping".
  echo  Usa ese acceso para que los tickets salgan directo por la tiquetera.
  echo  Importante: la tiquetera tiene que ser la impresora predeterminada de Windows.
) else (
  (echo [InternetShortcut]& echo URL=%URL%/) > "%ESCRITORIO%\Sistema del Camping.url"
  echo.
  echo  Listo: en el escritorio quedo "Sistema del Camping" (se abre con el navegador de la PC).
)
echo.
start "" "%URL%"
pause
