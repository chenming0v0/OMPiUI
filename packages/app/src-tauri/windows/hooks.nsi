; OMPiUI - NSIS Installer Hooks
; 安装时注册 Windows 资源管理器右键菜单，卸载时清理（含改名前的 PiUI 键）

!macro NSIS_HOOK_POSTINSTALL
  ; 右键文件夹 → "Open with OMPiUI"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OMPiUI" "" "Open with OMPiUI"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OMPiUI" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OMPiUI\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  ; 右键文件夹空白处 → "Open with OMPiUI"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OMPiUI" "" "Open with OMPiUI"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OMPiUI" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OMPiUI\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OMPiUI"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OMPiUI"
  ; 旧版本注册的 PiUI 键也一并清理
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PiUI"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\PiUI"
!macroend
