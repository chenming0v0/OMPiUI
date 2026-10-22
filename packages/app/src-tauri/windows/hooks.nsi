; OMPiUI maintenance and shortcut preservation for the pinned Tauri template.
; Whole .lnk files live only in NSIS's process-scoped plugin directory; no registry backup.
Var OmpiOldDir
Var OmpiOldBinary
Var OmpiStartFolder
Var OmpiStartPath
Var OmpiRootPath
Var OmpiDesktopPath
Var OmpiMaintenanceExe
Var OmpiMaintenanceTarget
Var OmpiMaintenancePid
Var OmpiPaused
Var OmpiReplacing
Var OmpiRestored
Var OmpiBackgroundPath

!macro OMPIUI_CAPTURE_LINK source backup
  !insertmacro IsShortcutTarget "${source}" "$OmpiOldDir\$OmpiOldBinary"
  Pop $0
  ${If} $0 = 1
    System::Call 'kernel32::CopyFileW(w "${source}", w "${backup}", i 0) i .r0'
    ${If} $0 = 0
      MessageBox MB_ICONSTOP "OMPiUI could not preserve an existing shortcut. Installation was cancelled without changing it."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro OMPIUI_RESTORE_LINK source destination
  IfFileExists "${source}" 0 +2
    StrCpy $OmpiRestored 1
  ${If} ${FileExists} "${source}"
    ; Never overwrite a shortcut which now points at a different application.
    ${If} ${FileExists} "${destination}"
      !insertmacro IsShortcutTarget "${destination}" "$OmpiOldDir\$OmpiOldBinary"
      Pop $0
      ${If} $0 != 1
        !insertmacro IsShortcutTarget "${destination}" "$INSTDIR\${MAINBINARYNAME}.exe"
        Pop $0
      ${EndIf}
    ${Else}
      StrCpy $0 1
    ${EndIf}
    ${If} $0 = 1
      System::Call 'kernel32::CopyFileW(w "${source}", w "${destination}", i 0) i .r0'
      ${If} $0 = 0
        Abort "OMPiUI could not restore an existing shortcut."
      ${EndIf}
      ${If} "$OmpiOldDir\$OmpiOldBinary" != "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetShortcutTarget "${destination}" "$INSTDIR\${MAINBINARYNAME}.exe"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro OMPIUI_PAUSE executable command snapshot
  StrCpy $OmpiMaintenanceTarget "${executable}"
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $OmpiMaintenancePid $0
  StrCpy $OmpiPaused 1
  ClearErrors
  ExecWait '"$OmpiMaintenanceExe" ${command} --installed-exe "$OmpiMaintenanceTarget" --maintenance-owner $OmpiMaintenancePid --maintenance-snapshot "${snapshot}"' $0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_INIT
  InitPluginsDir
  System::Call 'kernel32::GetEnvironmentVariableW(w "OMPIUI_BACKGROUND_DIR", w .r0, i ${NSIS_MAX_STRLEN}) i .r1'
  ${If} $1 > 0
    StrCpy $OmpiBackgroundPath "$0\background.json"
  ${Else}
    StrCpy $OmpiBackgroundPath "$PROFILE\.ompiui\background.json"
  ${EndIf}
  ReadRegStr $OmpiOldDir SHCTX "${MANUPRODUCTKEY}" ""
  ReadRegStr $OmpiOldBinary SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OmpiOldBinary == ""
    StrCpy $OmpiOldBinary "${MAINBINARYNAME}.exe"
  ${EndIf}
  !insertmacro MUI_STARTMENU_GETFOLDER Application $OmpiStartFolder
  StrCpy $OmpiStartPath "$SMPROGRAMS\$OmpiStartFolder\${PRODUCTNAME}.lnk"
  StrCpy $OmpiRootPath "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  StrCpy $OmpiDesktopPath "$DESKTOP\${PRODUCTNAME}.lnk"
  ${If} $OmpiOldDir != ""
    !insertmacro OMPIUI_CAPTURE_LINK "$OmpiStartPath" "$PLUGINSDIR\ompiui-start.lnk"
    ${If} $OmpiStartPath != $OmpiRootPath
      !insertmacro OMPIUI_CAPTURE_LINK "$OmpiRootPath" "$PLUGINSDIR\ompiui-root.lnk"
    ${EndIf}
    !insertmacro OMPIUI_CAPTURE_LINK "$OmpiDesktopPath" "$PLUGINSDIR\ompiui-desktop.lnk"
  ${EndIf}
  ; Run the new maintenance implementation even when upgrading 0.6.36.
  ; It resolves backend and login paths against --installed-exe, not this copy.
  File /oname=$PLUGINSDIR\ompiui-maintenance.exe "${MAINBINARYSRCPATH}"
  StrCpy $OmpiMaintenanceExe "$PLUGINSDIR\ompiui-maintenance.exe"
!macroend

!macro NSIS_HOOK_BEFORE_OLD_UNINSTALL
  !insertmacro CheckIfAppIsRunning "$OmpiOldDir\$OmpiOldBinary" "${PRODUCTNAME}"
  ${If} ${FileExists} "$OmpiBackgroundPath"
  ${AndIf} ${FileExists} "$OmpiOldDir\$OmpiOldBinary"
    !insertmacro OMPIUI_PAUSE "$OmpiOldDir\$OmpiOldBinary" "--background-pause-update" "$PLUGINSDIR\ompiui-update.json"
    ${If} $0 != 0
      Call OmpiRollback
      MessageBox MB_ICONSTOP "OMPiUI could not stop its managed background service. Installation was cancelled to protect active sessions."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_OLD_UNINSTALL_CANCELLED
  Call OmpiRollback
!macroend

!macro NSIS_HOOK_OLD_UNINSTALL_COMPLETED
  StrCpy $OmpiReplacing 1
  ${If} $OmpiPaused = 1
    ClearErrors
    ExecWait '"$OmpiMaintenanceExe" --background-replacing-update --maintenance-owner $OmpiMaintenancePid --maintenance-snapshot "$PLUGINSDIR\ompiui-update.json"' $0
    ${If} ${Errors}
      StrCpy $0 1
    ${EndIf}
    ${If} $0 != 0
      Abort "OMPiUI could not preserve the update pause after removing the old installation."
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${If} ${FileExists} "$OmpiBackgroundPath"
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $0 0
    ${If} $OmpiPaused != 1
      !insertmacro OMPIUI_PAUSE "$INSTDIR\${MAINBINARYNAME}.exe" "--background-pause-update" "$PLUGINSDIR\ompiui-update.json"
    ${EndIf}
    ${If} $0 != 0
      Call OmpiRollback
      MessageBox MB_ICONSTOP "OMPiUI could not gracefully stop its background service. Installation was cancelled to protect active sessions."
      Abort
    ${EndIf}
  ${EndIf}
  ; The running-app cancellation prompt has already completed. From here onward
  ; an error must leave the service paused because installation files may change.
  StrCpy $OmpiReplacing 1
  ${If} $OmpiPaused = 1
    ClearErrors
    ExecWait '"$OmpiMaintenanceExe" --background-replacing-update --maintenance-owner $OmpiMaintenancePid --installed-exe "$OmpiMaintenanceTarget"' $0
    ${If} ${Errors}
      StrCpy $0 1
    ${EndIf}
    ${If} $0 != 0
      StrCpy $OmpiReplacing 0
      Call OmpiRollback
      Abort "OMPiUI could not mark the start of file replacement."
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --background-resume-update' $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "OMPiUI was installed, but its background settings could not be restored. Open Service Settings to inspect the error."
  ${EndIf}
  StrCpy $OmpiPaused 0
  WriteRegStr HKCU "Software\Classes\Directory\shell\OMPiUI" "" "Open with OMPiUI"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OMPiUI" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OMPiUI\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OMPiUI" "" "Open with OMPiUI"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OMPiUI" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OMPiUI\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\ompiui-maintenance.exe "${MAINBINARYSRCPATH}"
  StrCpy $OmpiMaintenanceExe "$PLUGINSDIR\ompiui-maintenance.exe"
  System::Call 'kernel32::GetEnvironmentVariableW(w "OMPIUI_BACKGROUND_DIR", w .r0, i ${NSIS_MAX_STRLEN}) i .r1'
  ${If} $1 > 0
    StrCpy $OmpiBackgroundPath "$0\background.json"
  ${Else}
    StrCpy $OmpiBackgroundPath "$PROFILE\.ompiui\background.json"
  ${EndIf}
  ${If} ${FileExists} "$OmpiBackgroundPath"
    ${If} $UpdateMode = 1
      !insertmacro OMPIUI_PAUSE "$INSTDIR\${MAINBINARYNAME}.exe" "--background-pause-update" "$PLUGINSDIR\ompiui-update.json"
    ${Else}
      !insertmacro OMPIUI_PAUSE "$INSTDIR\${MAINBINARYNAME}.exe" "--background-uninstall" "$PLUGINSDIR\ompiui-update.json"
    ${EndIf}
    ${If} $0 != 0
      Call un.OmpiRollback
      MessageBox MB_ICONSTOP "OMPiUI could not stop its managed background service. Uninstall was cancelled to protect active sessions."
      Abort
    ${EndIf}
    ClearErrors
    ExecWait '"$OmpiMaintenanceExe" --background-replacing-update --maintenance-owner $OmpiMaintenancePid' $0
    ${If} ${Errors}
      StrCpy $0 1
    ${EndIf}
    ${If} $0 != 0
      Call un.OmpiRollback
      Abort "OMPiUI could not mark the start of file removal."
    ${EndIf}
  ${EndIf}
  StrCpy $OmpiReplacing 1
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OMPiUI"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OMPiUI"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PiUI"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\PiUI"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode != 1
  ${AndIf} $OmpiPaused = 1
    ClearErrors
    ExecWait '"$OmpiMaintenanceExe" --background-complete-uninstall' $0
    ${If} ${Errors}
    ${OrIf} $0 != 0
      MessageBox MB_ICONEXCLAMATION "OMPiUI was removed, but its stopped background state could not be saved."
    ${EndIf}
  ${EndIf}
!macroend

!macro OMPIUI_ROLLBACK_FUNCTION prefix
Function ${prefix}OmpiRollback
  ${If} $OmpiPaused = 1
  ${AndIf} $OmpiReplacing != 1
    ClearErrors
    ExecWait '"$OmpiMaintenanceExe" --background-rollback-update --installed-exe "$OmpiMaintenanceTarget" --maintenance-snapshot "$PLUGINSDIR\ompiui-update.json"' $0
    ${If} ${Errors}
      StrCpy $0 1
    ${EndIf}
    ${If} $0 = 0
      StrCpy $OmpiPaused 0
    ${Else}
      MessageBox MB_ICONEXCLAMATION "OMPiUI could not safely restore its background state. If the old installation is intact, use Start in Service Settings after closing the installer."
    ${EndIf}
  ${EndIf}
FunctionEnd
!macroend

!macro OMPIUI_INSTALLER_FUNCTIONS
  !insertmacro OMPIUI_ROLLBACK_FUNCTION ""
  !insertmacro OMPIUI_ROLLBACK_FUNCTION "un."
Function .onInstFailed
  Call OmpiRollback
FunctionEnd
Function .onGUIEnd
  Call OmpiRollback
FunctionEnd
Function un.onUninstFailed
  Call un.OmpiRollback
FunctionEnd
Function OmpiRestoreStartShortcuts
  StrCpy $OmpiRestored 0
  ${If} ${FileExists} "$PLUGINSDIR\ompiui-start.lnk"
  ${AndIf} $OmpiStartFolder != ""
    CreateDirectory "$SMPROGRAMS\$OmpiStartFolder"
  ${EndIf}
  !insertmacro OMPIUI_RESTORE_LINK "$PLUGINSDIR\ompiui-start.lnk" "$OmpiStartPath"
  !insertmacro OMPIUI_RESTORE_LINK "$PLUGINSDIR\ompiui-root.lnk" "$OmpiRootPath"
FunctionEnd
Function OmpiRestoreDesktopShortcut
  StrCpy $OmpiRestored 0
  !insertmacro OMPIUI_RESTORE_LINK "$PLUGINSDIR\ompiui-desktop.lnk" "$OmpiDesktopPath"
FunctionEnd
!macroend
