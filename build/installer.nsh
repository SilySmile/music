; Older clients launch the installer from <install>/Data/Updates. Relocate
; before the installer mutex and old-uninstaller process checks can run.
; The player redirects TEMP/TMP into Data/Temp, so GetTempFileName without
; an explicit directory would simply relocate us back under the install tree.
!macro preInit
  !ifndef BUILD_UNINSTALLER
  ${StdUtils.GetAllParameters} $R0 "0"
  ClearErrors
  ${GetOptions} $R0 "/XQ_STAGED" $R1
  ${If} ${Errors}
    ClearErrors
    ; Resolve LocalAppData through Windows, independently of inherited TEMP.
    Push $0
    Push $1
    Push $2
    StrCpy $R2 ""
    StrCpy $2 0
    System::Call 'shell32::SHGetKnownFolderPath(g "{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}", i 0, p 0, *p .r2)i.r1'
    ${If} $1 == 0
      System::Call 'kernel32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'
      StrCpy $R2 "$0\Temp"
    ${EndIf}
    ${If} $2 != 0
      System::Call 'ole32::CoTaskMemFree(p r2)'
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
    ${If} $R2 == ""
      MessageBox MB_OK|MB_ICONSTOP "无法获取 Windows 安装临时目录，安装未开始。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    CreateDirectory "$R2"
    GetTempFileName $R3 "$R2"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "无法准备安装临时目录，请检查系统 TEMP 设置后重试。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    Delete "$R3"
    StrCpy $R2 "$R3"
    CreateDirectory "$R2"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "无法创建安装临时目录，请检查系统 TEMP 权限后重试。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    CopyFiles /SILENT "$EXEPATH" "$R2"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "无法准备安装临时副本，请检查临时目录空间与权限后重试。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    SetOutPath "$R2"
    ; The new installer AND its old-uninstaller child must inherit this path.
    ; Changing only the executable location leaves NSIS $PLUGINSDIR in Data.
    System::Call 'kernel32::SetEnvironmentVariable(t "TEMP", t "$R2")i.r3'
    ${If} $3 == 0
      MessageBox MB_OK|MB_ICONSTOP "无法设置安装临时环境，安装未开始。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariable(t "TMP", t "$R2")i.r3'
    ${If} $3 == 0
      MessageBox MB_OK|MB_ICONSTOP "无法设置安装临时环境，安装未开始。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    ClearErrors
    Exec '"$R2\$EXEFILE" /XQ_STAGED $R0'
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "无法启动安装临时副本，原安装包已保留，请重试。"
      SetErrorLevel 2
    ${Else}
      SetErrorLevel 0
    ${EndIf}
    Quit
  ${EndIf}
  !endif
!macroend

!macro customInit
  ; Legacy launchers quote the complete /D= argument when the path has spaces.
  ; The builder parser can leave the final quote attached to $INSTDIR.
  StrCpy $R2 $INSTDIR 1 -1
  ${If} $R2 == '"'
    StrCpy $INSTDIR $INSTDIR -1
  ${EndIf}
  ${If} $hasPerMachineInstallation == "0"
  ${AndIf} $hasPerUserInstallation == "0"
    ${GetParameters} $R0
    ${GetOptions} $R0 "/D=" $R1
    ${If} ${Errors}
      StrCpy $INSTDIR "E:\game\music"
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_DIRECTORY
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vulkan-1.dll"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  RMDir "$INSTDIR"
!macroend
