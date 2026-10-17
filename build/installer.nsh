; Older clients launch the installer from <install>/Data/Updates. Relocate
; before the installer mutex and old-uninstaller process checks can run.
!macro preInit
  !ifndef BUILD_UNINSTALLER
  ${StdUtils.GetAllParameters} $R0 "0"
  ClearErrors
  ${GetOptions} $R0 "/XQ_STAGED" $R1
  ${If} ${Errors}
    ClearErrors
    GetTempFileName $R2
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "无法准备安装临时目录，请检查系统 TEMP 设置后重试。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    Delete "$R2"
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
