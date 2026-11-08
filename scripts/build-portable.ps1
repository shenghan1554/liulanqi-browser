<#
.SYNOPSIS
  把应用源码 + Electron 运行时组装成便携版目录。

.DESCRIPTION
  输出目录结构：
    浏览器.exe / *.dll / *.pak / locales/  ← 来自 Electron 运行时
    resources/app/                        ← 本仓库的 package.json + src/
    portable.txt                          ← 便携模式标记（数据存同目录 data/）
    README.md

  运行时目录需自行准备，见 docs/BUILD.md。

.EXAMPLE
  .\scripts\build-portable.ps1

.EXAMPLE
  .\scripts\build-portable.ps1 -ElectronDir D:\ecs\electron43-wv -OutDir D:\dist\浏览器
#>
param(
  # Electron 运行时目录（含 electron.exe）。默认为仓库内 electron43-wv
  [string]$ElectronDir = '',

  # 输出目录。默认为仓库内 dist\浏览器
  [string]$OutDir = '',

  # rcedit 路径（可选，用于替换图标与版本信息）。留空则自动查找
  [string]$RceditPath = '',

  # 跳过图标替换
  [switch]$NoIcon
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $ElectronDir) { $ElectronDir = Join-Path $root 'electron43-wv' }
if (-not $OutDir) { $OutDir = Join-Path $root 'dist\浏览器' }

if (-not (Test-Path $ElectronDir)) {
  throw "找不到 Electron 运行时：$ElectronDir`n请先按 docs/BUILD.md 准备运行时，或传 -ElectronDir。"
}

$electron = (Resolve-Path $ElectronDir).Path
$out = [System.IO.Path]::GetFullPath($OutDir)
$exeSrc = Join-Path $electron 'electron.exe'

if (-not (Test-Path $exeSrc)) { throw "找不到 Electron 运行时：$exeSrc" }
if (-not (Test-Path (Join-Path $root 'src\main\main.js'))) { throw "不是有效的项目目录：$root" }

Write-Host "项目目录 : $root"
Write-Host "Electron : $electron"
Write-Host "输出目录 : $out"

if (Test-Path $out) {
  Write-Host "清理旧输出…"
  Remove-Item $out -Recurse -Force
}
New-Item -ItemType Directory -Path $out | Out-Null

Write-Host "复制 Electron 运行时…"
Copy-Item (Join-Path $electron '*') $out -Recurse -Force

# 清掉开发运行时里的个人数据，交付包保持干净
if (Test-Path (Join-Path $out 'data')) { Remove-Item (Join-Path $out 'data') -Recurse -Force }
Get-ChildItem $out -Filter 'testbrowser.exe' -ErrorAction SilentlyContinue | Remove-Item -Force

# 文件名改成中文；同时保留 castlabs VMP 签名（<exe>.sig）
Rename-Item (Join-Path $out 'electron.exe') '浏览器.exe'
if (Test-Path (Join-Path $out 'electron.exe.sig')) {
  Rename-Item (Join-Path $out 'electron.exe.sig') '浏览器.exe.sig'
}

# ── 把程序图标与版本信息换成浏览器自己的 logo（网格球）──
# 不改这里的话，资源管理器 / 快捷方式 / 任务栏都会显示 Electron 默认图标。
function Resolve-Rcedit([string]$Hint) {
  if ($Hint) { if (Test-Path $Hint) { return $Hint } }
  foreach ($p in @(
      (Join-Path $root 'tools\rcedit\rcedit-x64.exe'),
      (Join-Path (Split-Path -Parent $root) 'tools\rcedit\rcedit-x64.exe')
    )) {
    if (Test-Path $p) { return $p }
  }
  $cmd = Get-Command rcedit -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$rcedit = if ($NoIcon) { $null } else { Resolve-Rcedit $RceditPath }
$iconFile = Join-Path $root 'installer\app.ico'
if ($rcedit -and (Test-Path $iconFile)) {
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $appExe = Join-Path $out '浏览器.exe'
  Write-Host '替换程序图标与版本信息…'
  & $rcedit $appExe `
    --set-icon $iconFile `
    --set-version-string 'ProductName' '浏览器' `
    --set-version-string 'FileDescription' '浏览器' `
    --set-version-string 'InternalName' '浏览器' `
    --set-version-string 'OriginalFilename' '浏览器.exe' `
    --set-version-string 'LegalCopyright' 'liulanqi-browser contributors (MIT License)' `
    --set-file-version ("{0}.0" -f $pkg.version) `
    --set-product-version ("{0}.0" -f $pkg.version) | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning "rcedit 替换图标失败（exit=$LASTEXITCODE）" }
} else {
  Write-Warning "未找到 rcedit 或 app.ico，跳过图标替换（不影响功能，仅图标/版本信息保持 Electron 默认）"
}

# Electron 自带的默认应用与本次无关，移除以免混淆
$defaultApp = Join-Path $out 'resources\default_app.asar'
if (Test-Path $defaultApp) { Remove-Item $defaultApp -Force }

# 应用代码放入 resources/app
$appDir = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item (Join-Path $root 'package.json') $appDir
Copy-Item (Join-Path $root 'src') $appDir -Recurse -Force
Copy-Item (Join-Path $root 'README.md') $appDir -Force
Copy-Item (Join-Path $root 'README.md') $out -Force

# README 中引用的截图放入包内，方便直接在文件夹里查看
$shotDir = Join-Path $out 'screenshots'
New-Item -ItemType Directory -Path $shotDir -Force | Out-Null
foreach ($shot in @('e2e-01-newtab.png', 'overview.png', 'playback-h264-aac.png')) {
  $shotSrc = Join-Path $root ('screenshots\' + $shot)
  if (Test-Path $shotSrc) { Copy-Item $shotSrc $shotDir -Force }
}

# 便携模式标记：数据保存在同目录 data\
Set-Content -Path (Join-Path $out 'portable.txt') -Value '便携模式标记：存在此文件时，浏览器数据保存在同目录 data 文件夹。' -Encoding UTF8

# 只保留中文与英文语言包，减小体积
$localeDir = Join-Path $out 'locales'
if (Test-Path $localeDir) {
  Get-ChildItem $localeDir -Filter '*.pak' |
    Where-Object { $_.Name -notin @('zh-CN.pak', 'en-US.pak', 'en-GB.pak') } |
    Remove-Item -Force
}

# 少数受限桌面环境下 Chromium 沙箱 / GPU 初始化会失败，提供兼容启动方式
$compat = @'
@echo off
cd /d "%~dp0"
start "" "浏览器.exe" --no-sandbox
'@
Set-Content -Path (Join-Path $out '兼容模式启动.cmd') -Value $compat -Encoding Default

$size = (Get-ChildItem $out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("完成：{0}" -f $out)
Write-Host ("体积：{0:N1} MB" -f ($size / 1MB))
Get-ChildItem $out | Select-Object Name, Length | Format-Table -AutoSize