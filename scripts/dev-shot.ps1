# 截取浏览器窗口（开发验证用）
# 需要浏览器已经通过 scripts\dev-run.ps1 启动
param(
  # 截图输出路径（相对仓库根目录）
  [string]$Out = 'screenshots/dev.png',

  # Electron 运行时目录，用于精确定位属于本仓库的进程
  [string]$RuntimeDir = ''
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeDir) { $RuntimeDir = Join-Path $root 'electron43-wv' }
$runtime = [System.IO.Path]::GetFullPath($RuntimeDir)
$outPath = Join-Path $root $Out
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BrowserWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -AssemblyName System.Drawing

# 先按运行时路径精确匹配；找不到再退回按进程名/窗口标题模糊匹配
$proc = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "$runtime\*" -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if (-not $proc) {
  $proc = Get-Process -Name '浏览器' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
}
if (-not $proc) {
  Write-Output 'NO_WINDOW'
  exit 1
}

[BrowserWin32]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
[BrowserWin32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500

$rect = New-Object BrowserWin32+RECT
[BrowserWin32]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Output "BAD_RECT $w x $h"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "SAVED $outPath ($w x $h)"