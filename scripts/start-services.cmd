@echo off
REM Start both python services, each in its own window.
REM
REM Everything machine-specific comes from env vars, so this file never needs editing:
REM   WATCH_ALONG_PY            venv python.exe        (required)
REM   WATCH_ALONG_WHISPER_DIR   whisper model folder   (required by asr_service)
REM   WATCH_ALONG_PORT_OCR      default 8765
REM   WATCH_ALONG_PORT_ASR      default 8766
setlocal
set ROOT=%~dp0..

if "%WATCH_ALONG_PY%"=="" (
  echo [error] WATCH_ALONG_PY is not set.
  echo         example: set WATCH_ALONG_PY=C:\path\to\venv\Scripts\python.exe
  exit /b 1
)
if "%WATCH_ALONG_WHISPER_DIR%"=="" (
  echo [warn] WATCH_ALONG_WHISPER_DIR is not set - asr_service will look in %ROOT%\models\whisper-turbo
)
if "%WATCH_ALONG_PORT_OCR%"=="" set WATCH_ALONG_PORT_OCR=8765
if "%WATCH_ALONG_PORT_ASR%"=="" set WATCH_ALONG_PORT_ASR=8766

echo [ocr] port %WATCH_ALONG_PORT_OCR%
start "watch-along ocr" "%WATCH_ALONG_PY%" "%ROOT%\python\ocr_service.py" --port %WATCH_ALONG_PORT_OCR%

echo [asr] port %WATCH_ALONG_PORT_ASR%
start "watch-along asr" "%WATCH_ALONG_PY%" "%ROOT%\python\asr_service.py" --port %WATCH_ALONG_PORT_ASR%

echo Both launched. Close those windows to stop the services.
endlocal
