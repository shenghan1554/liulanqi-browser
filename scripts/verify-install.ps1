# 浏览器 安装/卸载 自动化验证（无需管理员权限）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-install.ps1
# 自动查找 dist\ 下最新的「浏览器-安装程序-*.exe」，验证安装、快捷方式、注册表、启动、卸载与数据清理。
# 注意：会静默安装/卸载应用并清理测试用浏览数据，请只在测试机上运行。

param(
  [string]$Installer = '',
  [string]$Target = '',
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'
# 清除可能导致 Electron 以纯 Node 模式运行的继承环境变量
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
if (-not $Installer) {
  # 依次在 dist\、仓库根、仓库上级目录里找最新的安装包
  $searchDirs = @(
    (Join-Path $root 'dist'),
    $root,
    (Split-Path -Parent $root)
  ) | Where-Object { Test-Path $_ }
  $Installer = $searchDirs |
    ForEach-Object { Get-ChildItem (Join-Path $_ '浏览器-安装程序-*.exe') -ErrorAction SilentlyContinue } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Installer -or -not (Test-Path $Installer)) {
  throw "找不到安装包（浏览器-安装程序-*.exe）。请先用 scripts\build-installer.ps1 生成，或传 -Installer。"
}
$version = (Get-Item $Installer).VersionInfo.ProductVersion
if (-not $version) { throw "无法读取安装包版本：$Installer" }

if (-not $Target) { $Target = Join-Path $env:TEMP 'liulanqi-verify\浏览器' }
if (-not $LogFile) { $LogFile = Join-Path $root 'verify-install.log' }

$appExe = Join-Path $Target '浏览器.exe'
$uninst = Join-Path $Target 'uninst.exe'
$uninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\浏览器'
$desktopLnk = Join-Path $env:USERPROFILE 'Desktop\浏览器.lnk'
$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\浏览器'
$dataRoaming = Join-Path $env:APPDATA '浏览器'

$script:pass = 0
$script:fail = 0
function Check([string]$name, $cond, [string]$detail = '') {
  if ($cond) {
    $script:pass++
    $line = 'PASS  ' + $name
  } else {
    $script:fail++
    $line = 'FAIL  ' + $name + ' | ' + $detail
  }
  Write-Output $line
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Wait-Gone([string]$path, [int]$timeoutSec = 40) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Test-Path $path) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 400 }
  return -not (Test-Path $path)
}

function Get-ShortcutInfo([string]$lnk) {
  if (-not (Test-Path $lnk)) { return $null }
  $sh = New-Object -ComObject WScript.Shell
  $sc = $sh.CreateShortcut($lnk)
  return [pscustomobject]@{ Target = $sc.TargetPath; Args = $sc.Arguments; Icon = $sc.IconLocation }
}

Remove-Item $LogFile -Force -ErrorAction SilentlyContinue
Add-Content -Path $LogFile -Value ('== 安装验证 ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  版本 ' + $version) -Encoding UTF8

Write-Output '== 0. 安装包 =='
Check '安装包存在' (Test-Path $Installer) $Installer
$vi = (Get-Item $Installer).VersionInfo
Check '安装包产品名 浏览器' ($vi.ProductName -eq '浏览器') $vi.ProductName
Check '安装包版本可读' ([bool]$version) $version
Check '安装包体积合理（>80MB）' (((Get-Item $Installer).Length / 1MB) -gt 80) ''
Check '安装包图标已替换为浏览器 logo' ($vi.ProductName -eq '浏览器') ''

Write-Output '== 1. 自定义目录静默安装 =='
Get-Process -Name '浏览器' -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
Remove-Item $desktopLnk -Force -ErrorAction SilentlyContinue
Remove-Item $startMenuDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $uninstKey -Recurse -Force -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $Installer -ArgumentList @('/S', ('/D=' + $Target)) -PassThru -Wait
Check '安装程序退出码 0' ($proc.ExitCode -eq 0) $proc.ExitCode
Check '安装目录已创建' (Test-Path $Target) $Target
Check '主程序已安装' (Test-Path $appExe) $appExe
Check '卸载程序已安装' (Test-Path $uninst) $uninst
Check '签名文件已安装' (Test-Path ($appExe + '.sig')) ''
Check '使用说明已安装' (Test-Path (Join-Path $Target 'README.md')) ''
Check '安装版无 portable.txt' (-not (Test-Path (Join-Path $Target 'portable.txt'))) ''
Check '无测试截图目录' (-not (Test-Path (Join-Path $Target 'screenshots'))) ''
if (Test-Path $appExe) {
  $avi = (Get-Item $appExe).VersionInfo
  Check '安装的浏览器版本一致' ($avi.ProductVersion -like ($version + '*')) $avi.ProductVersion
  Check '安装的浏览器产品名 浏览器' ($avi.ProductName -eq '浏览器') $avi.ProductName
  Check '存在 app.ico 图标源文件' (Test-Path (Join-Path $root 'installer\app.ico')) ''
}

$ds = Get-ShortcutInfo $desktopLnk
Check '桌面快捷方式存在' ($null -ne $ds) $desktopLnk
if ($ds) {
  Check '桌面快捷方式指向主程序' ($ds.Target -eq $appExe) $ds.Target
  Check '桌面快捷方式带 --no-sandbox' ($ds.Args -like '*--no-sandbox*') $ds.Args
  Check '桌面快捷方式图标来自主程序' ($ds.Icon -like '*浏览器.exe*') $ds.Icon
}

$smApp = Get-ShortcutInfo (Join-Path $startMenuDir '浏览器.lnk')
$smUn = Get-ShortcutInfo (Join-Path $startMenuDir '卸载 浏览器.lnk')
$smRead = Get-ShortcutInfo (Join-Path $startMenuDir '使用说明.lnk')
Check '开始菜单-浏览器快捷方式' ($null -ne $smApp) ''
Check '开始菜单-卸载快捷方式' ($null -ne $smUn) ''
Check '开始菜单-使用说明快捷方式' ($null -ne $smRead) ''
if ($smApp) { Check '开始菜单快捷方式指向主程序' ($smApp.Target -eq $appExe) $smApp.Target }
if ($smUn) { Check '卸载快捷方式指向 uninst.exe' ($smUn.Target -eq $uninst) $smUn.Target }

if (Test-Path $uninstKey) {
  $k = Get-ItemProperty $uninstKey
  Check '卸载注册表项存在' $true ''
  Check '显示名称 浏览器' ($k.DisplayName -eq '浏览器') $k.DisplayName
  Check '显示版本与安装包一致' ($k.DisplayVersion -eq $version) $k.DisplayVersion
  Check '安装位置正确' ($k.InstallLocation -eq $Target) $k.InstallLocation
  Check '卸载命令正确' ($k.UninstallString -like ('*' + $uninst + '*')) $k.UninstallString
  Check '静默卸载命令正确' ($k.QuietUninstallString -like '*uninst.exe* /S*') $k.QuietUninstallString
  Check 'NoModify/NoRepair' (($k.NoModify -eq 1) -and ($k.NoRepair -eq 1)) ''
  Check 'EstimatedSize 合理' ($k.EstimatedSize -gt 300000) $k.EstimatedSize
  Check '显示图标指向主程序' ($k.DisplayIcon -like '*浏览器.exe*') $k.DisplayIcon
} else {
  Check '卸载注册表项存在' $false $uninstKey
}

Write-Output '== 2. 覆盖安装 =='
$readme = Join-Path $Target 'README.md'
if (Test-Path $readme) { Remove-Item $readme -Force }
$proc = Start-Process -FilePath $Installer -ArgumentList @('/S', ('/D=' + $Target)) -PassThru -Wait
Check '覆盖安装退出码 0' ($proc.ExitCode -eq 0) $proc.ExitCode
Check '覆盖后主程序存在' (Test-Path $appExe) ''
Check '覆盖后使用说明恢复' (Test-Path $readme) ''
Check '覆盖后卸载程序存在' (Test-Path $uninst) ''
Check '覆盖后注册表项存在' (Test-Path $uninstKey) ''

Write-Output '== 3. 启动应用 =='
Get-Process -Name '浏览器' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-Item $dataRoaming -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $appExe -ArgumentList '--no-sandbox' -WorkingDirectory $Target | Out-Null
$procs = @()
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $appExe })
  if ($procs.Count -ge 2) { break }
  Start-Sleep -Milliseconds 500
}
Check '应用已启动（多进程）' ($procs.Count -ge 2) $procs.Count
$title = ''
$titleDeadline = (Get-Date).AddSeconds(20)
while (((Get-Date) -lt $titleDeadline) -and -not $title) {
  foreach ($pp in @(Get-Process -Name '浏览器' -ErrorAction SilentlyContinue)) {
    if ($pp.MainWindowTitle) { $title = $pp.MainWindowTitle; break }
  }
  if (-not $title) { Start-Sleep -Milliseconds 400 }
}
Check '应用窗口标题正常' ($title -like '*浏览器*') $title
Check '用户数据目录已创建' (Test-Path $dataRoaming) $dataRoaming
Start-Sleep -Seconds 1
Get-Process -Name '浏览器' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Output '== 4. 卸载（保留数据） =='
$proc = Start-Process -FilePath $uninst -ArgumentList '/S' -PassThru -Wait
Check '卸载程序退出码 0' ($proc.ExitCode -eq 0) $proc.ExitCode
Check '安装目录已删除' (Wait-Gone $Target 40) $Target
Check '卸载注册表项已删除' (-not (Test-Path $uninstKey)) ''
Check '桌面快捷方式已删除' (-not (Test-Path $desktopLnk)) ''
Check '开始菜单目录已删除' (-not (Test-Path $startMenuDir)) ''
Check '浏览数据被保留' (Test-Path $dataRoaming) $dataRoaming

Write-Output '== 5. 重装并删除数据后卸载 =='
$proc = Start-Process -FilePath $Installer -ArgumentList @('/S', ('/D=' + $Target)) -PassThru -Wait
Check '重装成功' (Test-Path $appExe) $appExe
$proc = Start-Process -FilePath $uninst -ArgumentList @('/S', '/DELETEUSERDATA') -PassThru -Wait
Check '删除数据的卸载退出码 0' ($proc.ExitCode -eq 0) $proc.ExitCode
Check '安装目录已删除（第二次）' (Wait-Gone $Target 40) $Target
Check '浏览数据已删除' (-not (Test-Path $dataRoaming)) $dataRoaming

Write-Output ''
$summary = '全部通过'
if ($script:fail -gt 0) { $summary = ('失败 ' + $script:fail + ' 项') }
$line = ('== ' + $summary + '（通过 ' + $script:pass + ' / 共 ' + ($script:pass + $script:fail) + '）==')
Write-Output $line
Add-Content -Path $LogFile -Value $line -Encoding UTF8
if ($script:fail -gt 0) { exit 1 } else { exit 0 }