@echo off
rem 以 --perf 模式启动，输出性能日志到 logs\perf-outside.*
rem 需要先按 docs\BUILD.md 准备 electron43-wv 运行时
setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
if not exist "electron43-wv\electron.exe" (
  echo 找不到 electron43-wv\electron.exe，请先准备 Electron 运行时（见 docs\BUILD.md）
  exit /b 1
)
"electron43-wv\electron.exe" "." --perf --no-sandbox > "logs\perf-outside.out" 2> "logs\perf-outside.err"
endlocal