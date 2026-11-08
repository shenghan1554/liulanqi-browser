# 开发启动脚本：以当前仓库代码启动浏览器
# 运行时会从 -RuntimeDir（默认 electron43-wv）加载，日志写到 logs/
param(
  # Electron 运行时目录（含 electron.exe）。默认为仓库内 electron43-wv
  [string]$RuntimeDir = '',

  # 额外传给 Electron 的参数
  [string[]]$AppArgs = @('--disable-breakpad', '--no-sandbox', '--disable-gpu')
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeDir) { $RuntimeDir = Join-Path $root 'electron43-wv' }
$runtime = [System.IO.Path]::GetFullPath($RuntimeDir)
$el = Join-Path $runtime 'electron.exe'
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

if (-not (Test-Path $el)) {
  Write-Host "找不到 Electron 运行时：$el"
  Write-Host "请按 docs/BUILD.md 准备运行时，或传 -RuntimeDir。"
  exit 1
}

# 关闭旧实例（只针对本仓库运行时的进程，避免误杀其他 Electron 应用）
Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "$runtime\*" } |
  Stop-Process -Force

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$out = Join-Path $logs 'dev.out'
$log = Join-Path $logs 'dev.log'
$argList = @(
  "`"$el`"",
  "`"$root`""
) + $AppArgs + @('--enable-logging', "--log-file=`"$log`"")
$argString = $argList -join ' '

$cmd = "/c $argString > `"$out`" 2>&1"
Start-Process -FilePath 'cmd.exe' -ArgumentList $cmd -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 4
Write-Output "started"
Write-Output "  runtime : $runtime"
Write-Output "  data    : $runtime\data"
Write-Output "  stdout  : $out"
Write-Output "  log     : $log"
Get-Content $out -Raw -ErrorAction SilentlyContinue | Select-Object -First 1