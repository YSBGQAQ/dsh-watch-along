@echo off
setlocal enabledelayedexpansion
REM Keep polling /listen until Ctrl+C. Each round prints only the NEW lines.
REM ASCII only: PS/cmd code pages mangle Chinese inside .cmd files.
set URL=http://127.0.0.1:8766/listen
set N=0

:loop
set /a N+=1
echo [%N%]
curl -s -X POST -H "Content-Type: application/json" -d "{\"seconds\":3}" %URL%
echo.
timeout /t 2 >nul
goto loop
