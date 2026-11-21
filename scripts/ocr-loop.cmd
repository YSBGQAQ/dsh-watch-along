@echo off
REM OCR loop without DSH: grab the whole screen with ffmpeg, ask the OCR service, print the lines.
REM   usage: ocr-loop.cmd [seconds between frames]   (default 5)
REM   needs: OCR service on 8765, ffmpeg on PATH
REM
REM Why "desktop" instead of a window title: a Chinese title passed through cmd is GBK,
REM the window caption is UTF-16, so -i title=... never matches. Fullscreen video == desktop.
setlocal enabledelayedexpansion
set GAP=%~1
if "%GAP%"=="" set GAP=5

set ROOT=%~dp0..
if not exist "%ROOT%\.scratch\run" mkdir "%ROOT%\.scratch\run"
set DIR=%ROOT%/.scratch/run/ocr
if not exist "%DIR%" mkdir "%DIR%"

set N=0
:loop
set /a N+=1
REM one file per frame: a single overwritten file tells you nothing about when things changed
set OUT=%DIR%/f%N%.png
ffmpeg -hide_banner -loglevel error -f gdigrab -framerate 1 -i desktop -frames:v 1 -y "%OUT%" >nul 2>&1
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
