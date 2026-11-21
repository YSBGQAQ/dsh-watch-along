@echo off
REM OCR loop without DSH: grab one frame with ffmpeg, ask the OCR service, print the lines.
REM   usage: ocr-loop.cmd "window title fragment" [seconds between frames]
REM   needs: OCR service on 8765, ffmpeg on PATH
setlocal enabledelayedexpansion
set TITLE=%~1
set GAP=%~2
if "%TITLE%"=="" (
  echo usage: ocr-loop.cmd "window title fragment" [seconds]
  exit /b 1
)
if "%GAP%"=="" set GAP=5

set ROOT=%~dp0..
set OUT=%ROOT%/.scratch/run/ocr-loop.png
if not exist "%ROOT%\.scratch\run" mkdir "%ROOT%\.scratch\run"

set N=0
:loop
set /a N+=1
ffmpeg -hide_banner -loglevel error -f gdigrab -framerate 1 -i title="%TITLE%" -frames:v 1 -y "%OUT%" >nul 2>&1
if not exist "%OUT%" (
  echo [%N%] ffmpeg failed - window not found?
  timeout /t %GAP% >nul
  goto loop
)
echo [%N%] ---------------------------------------------
curl -s -X POST -H "Content-Type: application/json" -d "{\"path\":\"%OUT:\=/%\"}" http://127.0.0.1:8765/
echo.
timeout /t %GAP% >nul
goto loop
