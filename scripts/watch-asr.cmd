@echo off
REM 实时看 ASR 听写结果。用法：双击，或在终端里跑 scripts\watch-asr.cmd
REM
REM 它会不断调 ASR 服务的交付接口（插件每拍调的是同一个），把句子打到屏幕上。
REM 注意：和插件抢同一个交付游标 —— 观察时插件那边会少句子，这是有意的。
chcp 65001 >nul
setlocal
set ROOT=%~dp0..

where node >nul 2>nul
if errorlevel 1 (
  echo [error] 找不到 node。这个脚本用 node 跑，先装 Node 或者把它加进 PATH。
  pause
  exit /b 1
)

node "%ROOT%\scripts\watch-asr.mjs"
if errorlevel 1 pause
endlocal
