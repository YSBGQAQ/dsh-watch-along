@echo off
setlocal
set N=12
set URL=http://127.0.0.1:8766/listen
for /L %%i in (1,1,%N%) do (
  echo [%%i]
  curl -s -X POST -H "Content-Type: application/json" -d "{\"seconds\":3}" %URL%
  echo.
  timeout /t 1 >nul
)
echo ---- done ----
endlocal
