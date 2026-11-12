; OMPdesk's one-click, per-user setup (electron-builder.win.yml `nsis.include`).
;
; Builds before the switch to one click used electron-builder's assisted
; installer. Its default, "Only for me", is a per-user install that needs
; nothing here: the one-click template reads that install's folder from HKCU
; and runs its uninstaller itself. Its other choice, "Anyone who uses this
; computer", installed OMPdesk for all users under Program Files (HKLM). A
; per-user setup never touches that copy, so it would stay beside the new one
; with a second Start-menu shortcut and uninstall entry. Only then does
; customInit remove it first, through that copy's own uninstaller, elevated
; once (the only UAC prompt this setup can raise). A visible setup asks before
; that; a silent one (/S, the updater) goes ahead, as the assisted installer
; elevated its own silent updates. Settings, sessions and omp
; (%APPDATA%\ompdesk, %USERPROFILE%\.omp) are never touched.
;
; check64BitAndSetRegView has already run, so HKLM reads the 64-bit view the
; x64 assisted installer wrote.

!macro customInit
  ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R1 != ""
  ${AndIf} $R0 != ""
  ${AndIf} ${FileExists} "$R0\${UNINSTALL_FILENAME}"
    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "OMPdesk is installed for all users in $R0.$\r$\n$\r$\nThis setup installs OMPdesk for you only, so it first removes that copy with its own uninstaller. Windows asks for permission once.$\r$\n$\r$\nYour settings, sessions and omp stay as they are." IDOK +2
      Quit
    ${EndIf}
    ; A temp copy runs with _?= so it waits in place and can delete the original.
    InitPluginsDir
    CopyFiles /SILENT "$R0\${UNINSTALL_FILENAME}" "$PLUGINSDIR\all-users-uninstaller.exe"
    ${StdUtils.ExecShellWaitEx} $R2 $R3 "$PLUGINSDIR\all-users-uninstaller.exe" "runas" "/S /allusers /KEEP_APP_DATA _?=$R0"
    ${If} $R2 == "ok"
      ${StdUtils.WaitForProcEx} $R4 $R3
    ${EndIf}
    ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${If} $R1 != ""
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "The all-users OMPdesk in $R0 was not removed (Windows permission was declined, or its uninstaller failed).$\r$\n$\r$\nNothing was installed and your data was not changed. Remove OMPdesk in Settings > Apps, then run this setup again."
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------------------------------------------------
; The update keeps the old folder until the new one is complete (the move from the Electron app is this same setup run by
; that app's own updater, over the same folder; every update after it too).
;
; electron-builder's one-click setup runs the old uninstaller first and only then unpacks the new files, so an unpack
; that fails (a full disk, a file another program holds, a setup that is cut off) leaves nothing installed. Here
; `customCheckAppRunning` (the step right before the old uninstaller; it keeps electron-builder's own check) first sets
; the old folder aside as `<install>.move-backup` (a rename: instant and atomic; a copy when a handle keeps the folder
; from being renamed), and `customInstall` (the step after the files, registry entries and shortcuts) checks that the
; new folder holds what the app needs: the shell, CEF, Node and the main. Complete: the backup is deleted. Not: the
; partial folder is deleted, the old one comes back with its uninstall entry's values, the setup fails (exit code 2) and,
; for an automatic update, starts the old app again. A setup cut off before it could check leaves the backup beside a
; partial folder; the next run of the setup puts the backup back first and starts from the old app.
;
; With the folder renamed, the old uninstaller (found through the registry) is not there to run: electron-builder
; carries on (a warning, not an error) and the new files overwrite the entry, the shortcuts and the `InstallLocation`
; that name the same paths. Nothing but the folder and those values changes, so there is nothing else to restore.
;
; OMP_MOVE_TEST is defined only by scripts/shell-move (the dry run of the update from v0.127.0), which includes this file
; from its own: it logs the setup's environment, can make the unpack incomplete on purpose and starts the app through a
; launcher that carries the test profile, since the setup starts the app through Explorer, which has none of the
; setup's environment. It is not defined in a release build.
; ---------------------------------------------------------------------------------------------------------------------

!ifndef BUILD_UNINSTALLER
  Var /GLOBAL ompBackup
  Var /GLOBAL ompBackupMode
  Var /GLOBAL ompOldName
  Var /GLOBAL ompOldVersion
  Var /GLOBAL ompOldUninstall
  Var /GLOBAL ompOldQuiet
  Var /GLOBAL ompOldIcon
  Var /GLOBAL ompOldSize
!endif

!macro ompKeepOldFolder
  !ifndef BUILD_UNINSTALLER
    StrCpy $ompBackup "$INSTDIR.move-backup"
    StrCpy $ompBackupMode ""
    ; A move cut off earlier left its backup beside a partial folder: the old app comes back first.
    ${if} ${FileExists} "$ompBackup\*.*"
      DetailPrint "Putting back the old app an earlier setup set aside"
      RMDir /r "$INSTDIR"
      ClearErrors
      Rename "$ompBackup" "$INSTDIR"
    ${endIf}
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${andIf} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      ReadRegStr $ompOldName SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayName
      ReadRegStr $ompOldVersion SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
      ReadRegStr $ompOldUninstall SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ReadRegStr $ompOldQuiet SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
      ReadRegStr $ompOldIcon SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayIcon
      ReadRegDWORD $ompOldSize SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" EstimatedSize
      ClearErrors
      Rename "$INSTDIR" "$ompBackup"
      ${if} ${Errors}
        ; A handle keeps the folder from moving: copy it. The old uninstaller then runs and clears the folder as it did.
        ClearErrors
        RMDir /r "$ompBackup"
        CopyFiles /SILENT "$INSTDIR\*.*" "$ompBackup"
        ${if} ${Errors}
          RMDir /r "$ompBackup"
          DetailPrint "No copy of the old app could be made: this update cannot be undone"
        ${else}
          StrCpy $ompBackupMode "copied"
        ${endIf}
      ${else}
        StrCpy $ompBackupMode "renamed"
        CreateDirectory "$INSTDIR"
      ${endIf}
    ${endIf}
  !endif
!macroend

!macro ompRestoreOldFolder
  !ifndef BUILD_UNINSTALLER
    DetailPrint "The new files are not complete: putting the old app back"
    ${if} $ompBackupMode == "renamed"
      RMDir /r "$INSTDIR"
      ClearErrors
      Rename "$ompBackup" "$INSTDIR"
    ${elseIf} $ompBackupMode == "copied"
      RMDir /r "$INSTDIR"
      CopyFiles /SILENT "$ompBackup\*.*" "$INSTDIR"
      RMDir /r "$ompBackup"
    ${endIf}
    ${if} $ompBackupMode != ""
      WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayName "$ompOldName"
      WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "$ompOldVersion"
      WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString "$ompOldUninstall"
      WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString "$ompOldQuiet"
      WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayIcon "$ompOldIcon"
      ${if} $ompOldSize != ""
        WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" EstimatedSize $ompOldSize
      ${endIf}
    ${endIf}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "OMPdesk could not be updated: the new files were not complete. Your settings and sessions were not changed."
    ${endIf}
    ; An automatic update brings the old app back, as it came back from every update before.
    !ifndef OMP_MOVE_TEST
      ${if} $ompBackupMode != ""
      ${andIf} ${isUpdated}
        ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
      ${endIf}
    !endif
    SetErrorLevel 2
    Quit
  !endif
!macroend

; What the app needs from the new folder: the shell (OMPdesk.exe), CEF, Node and the main it runs.
!macro ompCheckNewFolder
  !ifndef BUILD_UNINSTALLER
    !ifdef OMP_MOVE_TEST
      !insertmacro ompMoveTestBeforeCheck
    !endif
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${andIf} ${FileExists} "$INSTDIR\libcef.dll"
    ${andIf} ${FileExists} "$INSTDIR\resources\node\node.exe"
    ${andIf} ${FileExists} "$INSTDIR\resources\app\out\main\index.js"
      ${if} $ompBackupMode != ""
        RMDir /r "$ompBackup"
      ${endIf}
    ${else}
      !insertmacro ompRestoreOldFolder
    ${endIf}
    !ifdef OMP_MOVE_TEST
      !insertmacro ompMoveTestAfterInstall
    !endif
  !endif
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !insertmacro ompKeepOldFolder
!macroend

!macro customInstall
  !insertmacro ompCheckNewFolder
!macroend
