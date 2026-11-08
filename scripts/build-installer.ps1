<#
.SYNOPSIS
  用 NSIS 把便携版目录打包成 Windows 安装程序。

.DESCRIPTION
  需要 NSIS 3.11+（Unicode 版）。版本号取自 package.json，作为宏传给 browser.nsi，
  因此改版本只需要改 package.json。

.EXAMPLE
  .\scripts\build-installer.ps1 -SourceDir .\dist\浏览器 -OutDir .\dist

.EXAMPLE
  .\scripts\build-installer.ps1 -NsisDir "C:\Program Files (x86)\NSIS"
#>
param(
  # 便携版输出目录（含 浏览器.exe 与 resources\）。默认为仓库内 dist\浏览器
  [string]$SourceDir = '',

  # 安装包输出目录。默认为仓库内 dist
  [string]$OutDir = '',

  # NSIS 安装目录（含 makensis.exe）。留空则自动查找
  [string]$NsisDir = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$assetDir = Join-Path $projectRoot 'installer'

if (-not $SourceDir) { $SourceDir = Join-Path $projectRoot 'dist\浏览器' }
if (-not $OutDir) { $OutDir = Join-Path $projectRoot 'dist' }

$SourceDir = [System.IO.Path]::GetFullPath($SourceDir)
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

# ── 定位 makensis ─────────────────────────────────────────────────────────
function Resolve-Makensis([string]$Hint) {
  if ($Hint) {
    $candidate = Join-Path $Hint 'makensis.exe'
    if (Test-Path $candidate) { return $candidate }
    if (Test-Path $Hint) { return $Hint }  # 直接传了 exe 路径
    throw "在指定的 NSIS 目录里找不到 makensis.exe：$Hint"
  }
  $cmd = Get-Command makensis -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
      (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
      (Join-Path $env:ProgramFiles 'NSIS\makensis.exe')
    )) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  throw "找不到 makensis.exe。请安装 NSIS 3.11+（https://nsis.sourceforge.io/），或传 -NsisDir。"
}

$makensis = Resolve-Makensis $NsisDir
$nsi = Join-Path $assetDir 'browser.nsi'
$icon = Join-Path $assetDir 'app.ico'

if (-not (Test-Path $nsi)) { throw "未找到安装脚本：$nsi" }
if (-not (Test-Path $SourceDir)) {
  throw "未找到待安装文件目录：$SourceDir`n请先用 scripts\build-portable.ps1 生成便携版，或传 -SourceDir。"
}
if (-not (Test-Path (Join-Path $SourceDir '浏览器.exe'))) {
  throw "目录里没有 浏览器.exe，可能不是有效的便携版输出：$SourceDir"
}

# ── 版本与输出路径 ───────────────────────────────────────────────────────
$appPkg = Get-Content (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $appPkg.version
if (-not $version) { throw 'package.json 里没有 version 字段' }
$versionFull = if ($version -match '^\d+\.\d+\.\d+$') { "$version.0" } else { $version }

$staging = Join-Path $OutDir 'staging'
$outExe = Join-Path $OutDir ("浏览器-安装程序-$version.exe")

Write-Host "==> 准备安装文件（$SourceDir）"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force $OutDir | Out-Null

# 安装版不包含 portable.txt（数据改存 %APPDATA%\浏览器），也不带测试产物
$excludeDirs = @(
  (Join-Path $SourceDir 'data'),
  (Join-Path $SourceDir 'logs'),
  (Join-Path $SourceDir 'resources\app\logs'),
  (Join-Path $SourceDir 'screenshots'),
  (Join-Path $SourceDir 'resources\app\screenshots')
)
$robocopyArgs = @($SourceDir, $staging, '/E', '/XF', 'portable.txt', '/XD') + $excludeDirs + @('/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1')
& robocopy @robocopyArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制安装文件失败（robocopy 退出码 $LASTEXITCODE）" }

if (Test-Path (Join-Path $staging 'portable.txt')) { Remove-Item (Join-Path $staging 'portable.txt') -Force }

if (Test-Path $outExe) { Remove-Item $outExe -Force }

# 确保 NSIS 脚本带 UTF-8 BOM，否则中文在 ANSI 模式下会乱码
$nsiBytes = [System.IO.File]::ReadAllBytes($nsi)
if (-not ($nsiBytes.Length -ge 3 -and $nsiBytes[0] -eq 0xEF -and $nsiBytes[1] -eq 0xBB -and $nsiBytes[2] -eq 0xBF)) {
  [System.IO.File]::WriteAllBytes($nsi, [byte[]](@(0xEF, 0xBB, 0xBF) + $nsiBytes))
}

Write-Host "==> 编译安装程序（NSIS，LZMA 压缩，可能需要几分钟）"
# 某些受限环境里系统 TEMP 目录不可写，makensis 会静默失败；改用输出目录下的临时目录
$localTmp = Join-Path $OutDir 'tmp'
if (Test-Path $localTmp) { Remove-Item $localTmp -Recurse -Force }
New-Item -ItemType Directory -Force $localTmp | Out-Null
$oldTmp = $env:TMP
$oldTemp = $env:TEMP
$env:TMP = $localTmp
$env:TEMP = $localTmp
try {
  & $makensis /V2 `
    "/DOUT_FILE=$outExe" `
    "/DSTAGE_DIR=$staging" `
    "/DICON_FILE=$icon" `
    "/DAPP_VERSION=$version" `
    "/DAPP_VERSION_FULL=$versionFull" `
    $nsi
  $makensisExit = $LASTEXITCODE
} finally {
  $env:TMP = $oldTmp
  $env:TEMP = $oldTemp
  Remove-Item $localTmp -Recurse -Force -ErrorAction SilentlyContinue
}
if ($makensisExit -ne 0) { throw "makensis 编译失败（退出码 $makensisExit）" }
if (-not (Test-Path $outExe)) { throw "安装程序未生成：$outExe" }

$size = [math]::Round((Get-Item $outExe).Length / 1MB, 1)
Write-Host "==> 完成：$outExe（$size MB）"