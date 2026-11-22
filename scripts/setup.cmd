@echo off
REM One-shot installer. Safe to re-run: every step checks before acting.
REM
REM Needs:
REM   WATCH_ALONG_WHEELS       folder with the offline .whl files   (required)
REM   WATCH_ALONG_WHISPER_DIR  whisper model folder                 (checked only)
REM Optional:
REM   WATCH_ALONG_VENV         venv folder, default <repo>\venv
REM   WATCH_ALONG_PY           an existing python.exe to build the venv with
REM
REM Keep this file ASCII-only: code pages mangle non-ASCII inside .cmd.
setlocal enabledelayedexpansion
set ROOT=%~dp0..
if "%WATCH_ALONG_VENV%"=="" set WATCH_ALONG_VENV=%ROOT%\venv
set PY=%WATCH_ALONG_VENV%\Scripts\python.exe

echo == watch-along setup ==
echo repo   : %ROOT%
echo venv   : %WATCH_ALONG_VENV%

if "%WATCH_ALONG_WHEELS%"=="" (
  echo [error] WATCH_ALONG_WHEELS is not set.
  echo         example: set WATCH_ALONG_WHEELS=D:\deps\wheels
  exit /b 1
)
if not exist "%WATCH_ALONG_WHEELS%" (
  echo [error] wheel folder not found: %WATCH_ALONG_WHEELS%
  exit /b 1
)

REM --- 1. venv ---
if exist "%PY%" (
  echo [1/4] venv exists, skip
) else (
  echo [1/4] creating venv ...
  if "%WATCH_ALONG_PY%"=="" (
    python -m venv "%WATCH_ALONG_VENV%"
  ) else (
    "%WATCH_ALONG_PY%" -m venv "%WATCH_ALONG_VENV%"
  )
  if errorlevel 1 (
    echo [error] failed to create venv. Install Python 3.12 and retry.
    exit /b 1
  )
)

REM --- 2. packages (offline) ---
echo [2/4] installing packages from wheels ...
REM OCR 走 CPU 版 onnxruntime（GPU 版在常驻服务里显存泄漏，已回退）；
REM 下面三个 nvidia wheel 只给 faster-whisper 的 GPU 转写用。
"%PY%" -m pip install --no-index --find-links="%WATCH_ALONG_WHEELS%" ^
  rapidocr onnxruntime faster-whisper soundcard numpy pillow ^
  nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-nvrtc-cu12
if errorlevel 1 (
  echo [error] pip failed. Check that the wheel folder has all needed files.
  exit /b 1
)

REM --- 3. whisper model files ---
echo [3/4] checking whisper model ...
if "%WATCH_ALONG_WHISPER_DIR%"=="" (
  echo [warn] WATCH_ALONG_WHISPER_DIR not set - skipping model check.
  echo        asr_service will fall back to %ROOT%\models\whisper-turbo
) else (
  set MISS=0
  for %%f in (model.bin config.json tokenizer.json vocabulary.json preprocessor_config.json) do (
    if not exist "%WATCH_ALONG_WHISPER_DIR%\%%f" (
      echo   missing: %%f
      set MISS=1
    )
  )
  if !MISS!==1 (
    echo [error] whisper model is incomplete in %WATCH_ALONG_WHISPER_DIR%
    exit /b 1
  )
  echo   model files OK
)

REM --- 4. smoke ---
echo [4/4] smoke test ...
"%PY%" -c "import numpy, soundcard, faster_whisper, rapidocr; print('   imports OK')"
if errorlevel 1 (
  echo [error] import failed - GPU runtime may be missing; see README troubleshooting.
  exit /b 1
)

echo.
echo Done. Next:
echo   set WATCH_ALONG_PY=%PY%
echo   set WATCH_ALONG_WHISPER_DIR=^<model folder^>
echo   scripts\start-services.cmd
endlocal
