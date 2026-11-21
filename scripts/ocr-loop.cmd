@echo off
REM OCR loop without DSH: grab the whole screen with ffmpeg, ask the OCR service, print the lines.
REM   usage: ocr-loop.cmd <x> <y> <w> <h> [seconds]    (rect from watch_start's region)
REM          ocr-loop.cmd screen [seconds]               (fallback: whole desktop)
REM   needs: OCR service on 8765, ffmpeg on PATH
REM
REM Why "desktop" instead of a window title: a Chinese title passed through cmd is GBK,
REM the window caption is UTF-16, so -i title=... never matches. Fullscreen video == desktop.
setlocal enabledelayedexpansion
if /i "%~1"=="screen" (
  set MODE=screen
  set GAP=%~2
) else (
  set MODE=rect
  set RX=%~1
  set RY=%~2
  set RW=%~3
  set RH=%~4
  set GAP=%~5
)
if "%GAP%"=="" set GAP=5
if /i "%MODE%"=="rect" if "%RH%"=="" (
  echo usage: ocr-loop.cmd ^<x^> ^<y^> ^<w^> ^<h^> [seconds]   ^|   ocr-loop.cmd screen [seconds]
  exit /b 1
)

set ROOT=%~dp0..
if not exist "%ROOT%\.scratch\run" mkdir "%ROOT%\.scratch\run"
set DIR=%ROOT%/.scratch/run/ocr
if not exist "%DIR%" mkdir "%DIR%"

set N=0
:loop
set /a N+=1
REM one file per frame: a single overwritten file tells you nothing about when things changed
set OUT=%DIR%/f%N%.png
if /i "%MODE%"=="rect" (
  ffmpeg -hide_banner -loglevel error -f gdigrab -framerate 1 -offset_x %RX% -offset_y %RY% -video_size %RW%x%RH% -i desktop -frames:v 1 -y "%OUT%" >nul 2>&1
) else (
  ffmpeg -hide_banner -loglevel error -f gdigrab -framerate 1 -i desktop -frames:v 1 -y "%OUT%" >nul 2>&1
)
if not exist "%OUT%" (
  echo [%N%] ffmpeg failed - is ffmpeg on PATH?
  timeout /t %GAP% >nul
  goto loop
)
echo [%N%] ---------------------------------------------
curl -s -X POST -H "Content-Type: application/json" -d "{\"path\":\"%OUT:\=/%\"}" http://127.0.0.1:8765/
echo.
timeout /t %GAP% >nul
goto loop
