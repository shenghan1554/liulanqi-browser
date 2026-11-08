; 浏览器 安装 / 卸载脚本（NSIS 3.11 Unicode）
; 编译：makensis /D... browser.nsi
; 依赖传入的宏：OUT_FILE（输出 exe）、STAGE_DIR（待安装文件）、ICON_FILE（安装包图标）

Unicode true

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef OUT_FILE
  !define OUT_FILE "浏览器-安装程序.exe"
!endif
!ifndef STAGE_DIR
  !define STAGE_DIR "staging"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "app.ico"
!endif
; 版本号由 scripts\build-installer.ps1 从 package.json 读取后通过 /D 传入
!ifndef APP_VERSION
  !define APP_VERSION "1.0.5"
!endif
!ifndef APP_VERSION_FULL
  !define APP_VERSION_FULL "1.0.5.0"
!endif

!define APP_NAME "浏览器"
!define APP_EXE "浏览器.exe"
!define APP_PUBLISHER "liulanqi-browser contributors"
!define APP_COPYRIGHT "liulanqi-browser contributors (MIT License)"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\浏览器"
!define DATA_DIR_ROAMING "$APPDATA\浏览器"
!define DATA_DIR_LOCAL "$LOCALAPPDATA\浏览器"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\浏览器"
InstallDirRegKey HKCU "Software\浏览器" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
CRCCheck on
XPStyle on
ShowInstDetails show
ShowUninstDetails show
BrandingText "${APP_NAME} ${APP_VERSION} 安装程序"

VIProductVersion "${APP_VERSION_FULL}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${APP_COPYRIGHT}"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "安装程序会把 ${APP_NAME} 安装到你的电脑。$\r$\n$\r$\n${APP_NAME} 基于 Chromium，界面简洁，不需要登录账号，也不做云同步；浏览记录、书签、壁纸与设置只保存在本机。$\r$\n$\r$\n点击「下一步」继续。"
!define MUI_DIRECTORYPAGE_TEXT_TOP "请选择 ${APP_NAME} 的安装位置。$\r$\n$\r$\n可以使用默认位置，也可以点击「浏览」把浏览器安装到其他文件夹（例如 D:\浏览器）。"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APP_NAME}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看使用说明"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\README.md"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataPageCreate un.DataPageLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Var DeleteDataCheck
Var DeleteDataCheckbox

Function .onInit
  ; 结束正在运行的旧版本，避免文件被占用
  nsExec::Exec 'taskkill /F /IM "浏览器.exe"'
  Sleep 600
  ; 覆盖安装：先静默卸载旧版本（保留用户数据）
  ReadRegStr $0 HKCU "${UNINST_KEY}" "UninstallString"
  ${If} $0 != ""
    ReadRegStr $1 HKCU "${UNINST_KEY}" "InstallLocation"
    ${If} $1 == ""
      StrCpy $1 "$INSTDIR"
    ${EndIf}
    ${If} ${FileExists} "$1\uninst.exe"
      ; _?=$1 让卸载程序原地执行并等待完成，避免临时副本异步删除文件与覆盖安装竞争
      ExecWait '"$1\uninst.exe" /S _?=$1'
    ${EndIf}
    Delete "$1\uninst.exe"
    RMDir /r "$1"
  ${EndIf}
  StrCpy $DeleteDataCheck "0"
FunctionEnd

Function LaunchApp
  ExecShell "open" "$INSTDIR\${APP_EXE}" "--no-sandbox"
FunctionEnd

; ───────────────────────────── 安装 ─────────────────────────────

Section "浏览器程序文件（必需）" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"
  WriteUninstaller "$INSTDIR\uninst.exe"

  WriteRegStr HKCU "Software\浏览器" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninst.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninst.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

Section "桌面快捷方式" SEC_DESKTOP
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "--no-sandbox" "$INSTDIR\${APP_EXE}" 0
SectionEnd

Section "开始菜单快捷方式" SEC_STARTMENU
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "--no-sandbox" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\uninst.exe"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\使用说明.lnk" "$INSTDIR\README.md"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MAIN} "浏览器主程序与 Chromium 运行时（必需）。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "在桌面创建「${APP_NAME}」快捷方式。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_STARTMENU} "在开始菜单创建程序、卸载和使用说明快捷方式。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ───────────────────────────── 卸载 ─────────────────────────────

Function un.onInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/DELETEUSERDATA" $R1
  ${IfNot} ${Errors}
    StrCpy $DeleteDataCheck "1"
  ${EndIf}
FunctionEnd

Function un.DataPageCreate
  !insertmacro MUI_HEADER_TEXT "卸载选项" "是否同时删除本地浏览数据"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 30u "卸载会删除程序文件、开始菜单和桌面快捷方式。$\r$\n下面可以选择是否把本机保存的浏览数据一起删除。"
  Pop $0
  ${NSD_CreateCheckbox} 0 42u 100% 12u "同时删除我的浏览数据（书签、浏览记录、设置、壁纸）"
  Pop $DeleteDataCheckbox
  ${If} $DeleteDataCheck == "1"
    ${NSD_Check} $DeleteDataCheckbox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function un.DataPageLeave
  ${NSD_GetState} $DeleteDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $DeleteDataCheck "1"
  ${Else}
    StrCpy $DeleteDataCheck "0"
  ${EndIf}
FunctionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "浏览器.exe"'
  Sleep 800

  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\浏览器"
  RMDir /r "$INSTDIR"

  ${If} $DeleteDataCheck == "1"
    RMDir /r "${DATA_DIR_ROAMING}"
    RMDir /r "${DATA_DIR_LOCAL}"
  ${EndIf}
SectionEnd