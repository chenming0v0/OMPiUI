; OMPiUI - NSIS Installer Hooks
; 安装时注册 Windows 资源管理器右键菜单，卸载时清理（含改名前的 PiUI 键）

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 ompiui_pause_done
  ; The marker is created only by versions that implement maintenance modes.
  IfFileExists "$PROFILE\.ompiui\background.json" 0 ompiui_pause_done
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --background-pause-update' $0
  StrCmp $0 0 ompiui_pause_done
  MessageBox MB_ICONSTOP "OMPiUI could not gracefully stop its background service. Installation is paused to protect active sessions."
  Abort
  ompiui_pause_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --background-resume-update' $0
  StrCmp $0 0 ompiui_resume_done
  MessageBox MB_ICONEXCLAMATION "OMPiUI was installed, but its background settings could not be restored. Open Service Settings to inspect the error."
  ompiui_resume_done:
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
  IfFileExists "$PROFILE\.ompiui\background.json" 0 ompiui_uninstall_done
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --background-uninstall' $0
  StrCmp $0 0 ompiui_uninstall_done
  MessageBox MB_ICONSTOP "OMPiUI could not stop its managed background service. Uninstall is paused to protect active sessions."
  Abort
  ompiui_uninstall_done:
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OMPiUI"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OMPiUI"
  ; 旧版本注册的 PiUI 键也一并清理
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PiUI"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\PiUI"
!macroend
