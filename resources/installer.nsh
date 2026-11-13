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
    ${AndIfNot} ${isUpdated}
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
      ${AndIfNot} ${isUpdated}
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

; electron-builder includes these two only while it has no `customCheckAppRunning` to use (allowOnlyOneInstallerInstance.nsh
; asks `!ifmacrondef customCheckAppRunning`); the macro below keeps electron-builder's own check, so it needs them too.
!include "getProcessInfo.nsh"
Var pid

!ifndef BUILD_UNINSTALLER
  Var /GLOBAL ompBackup
  Var /GLOBAL ompBackupMode
  Var /GLOBAL ompOldName
  Var /GLOBAL ompOldVersion
  Var /GLOBAL ompOldUninstall
  Var /GLOBAL ompOldQuiet
  Var /GLOBAL ompOldIcon
  Var /GLOBAL ompOldSize
  Var /GLOBAL ompStart
  Var /GLOBAL ompUserData
  Var /GLOBAL ompMarker
  Var /GLOBAL ompArgs
  Var /GLOBAL ompSeen
  Var /GLOBAL ompWaited
  Var /GLOBAL ompScan
!endif

!macro ompKeepOldFolder
  !ifndef BUILD_UNINSTALLER
    StrCpy $ompBackup "$INSTDIR.move-backup"
    StrCpy $ompBackupMode ""
    ; A move cut off earlier left its backup beside a partial folder: the old app comes back first.
    ${if} ${FileExists} "$ompBackup\*.*"
      DetailPrint "Putting back the old app an earlier setup set aside"
      SetOutPath "$TEMP"
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
      SetOutPath "$TEMP"
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

; One line in %TEMP%\ompdesk-setup.log: what the setup did when it did not go the usual way.
!macro ompLog TEXT
  !ifndef BUILD_UNINSTALLER
    FileOpen $R8 "$TEMP\ompdesk-setup.log" a
    ${if} $R8 != ""
      FileSeek $R8 0 END
      FileWrite $R8 "${TEXT}$\r$\n"
      FileClose $R8
    ${endIf}
  !endif
!macroend

; REASON is `incomplete` (the unpack came out without what the app needs) or `start-failed` (the new app did not come up).
!macro ompRestoreOldFolder REASON
  !ifndef BUILD_UNINSTALLER
    DetailPrint "The new app did not come up (${REASON}): putting the old app back"
    !insertmacro ompLog "${REASON}: putting the old app back ($ompBackupMode)"
    ; The setup's own working folder is the install folder (SetOutPath): NSIS cannot delete the folder it stands in, and
    ; a rename onto a folder that is still there fails, so it steps out first.
    SetOutPath "$TEMP"
    ${if} $ompBackupMode == "renamed"
      RMDir /r "$INSTDIR"
      ClearErrors
      Rename "$ompBackup" "$INSTDIR"
      ${if} ${Errors}
        ; The folder is still there (a file in it is held): copy the old app over what is left, then drop the backup.
        ClearErrors
        CopyFiles /SILENT "$ompBackup\*.*" "$INSTDIR"
        ${if} ${Errors}
          !insertmacro ompLog "the old app could not be put back from $ompBackup"
        ${else}
          RMDir /r "$ompBackup"
        ${endIf}
      ${endIf}
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
    ; Only a setup a person started by hand says so, and only when the files were incomplete. An update's rollback
    ; shows nothing: the old app starts again and the next launch's `swap result … rolled back` line in its update log
    ; reports it (a dialog shown to a person whose update went wrong is a failed move). A new app that did not come up
    ; never gets a dialog either: it has nothing to ask the person.
    !if "${REASON}" == "incomplete"
      ${IfNot} ${Silent}
      ${AndIfNot} ${isUpdated}
        MessageBox MB_OK|MB_ICONSTOP "OMPdesk could not be updated: the new files were not complete. Your settings and sessions were not changed."
      ${endIf}
    !endif
    ; The old app comes back running: after an automatic update as it came back from every update before, and after a
    ; new app that did not start whoever began the setup.
    ${if} $ompBackupMode != ""
    !if "${REASON}" == "incomplete"
    ${andIf} ${isUpdated}
    !endif
      !ifdef OMP_MOVE_TEST
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
      !else
        ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
      !endif
    ${endIf}
    SetErrorLevel 2
    Quit
  !endif
!macroend

; Does the start marker (userData\app-started.json, one line {version, pid, at}, written by the main once the first window's page
; loaded) carry NEEDLE? Sets $ompSeen to 1 when it does.
!macro ompMarkerHas NEEDLE
  StrLen $R3 "${NEEDLE}"
  StrLen $R2 $R7
  IntOp $R2 $R2 - $R3
  ${For} $ompScan 0 $R2
    StrCpy $R5 $R7 $R3 $ompScan
    ${if} $R5 == "${NEEDLE}"
      StrCpy $ompSeen "1"
      ${ExitFor}
    ${endIf}
  ${Next}
!macroend

; The new app starts here, not after the setup: an update that left a shell which cannot start would leave nothing to
; use. The backup of the old folder stays until the new shell wrote app-started.json for this version (waiting up to
; 120 s); without it the new app's processes end, the old folder and its uninstall entry come back, the old app starts and
; the setup exits 2 with `start-failed` in %TEMP%\ompdesk-setup.log. A setup that does not start the app after it
; installs (silent, no --force-run) cannot ask it to prove anything, so it has nothing to wait for. The template's own
; start after this runs, when the proof came, reaches the running app: a second launch of the same profile only
; forwards its arguments.
!macro ompStartAndVerify
  !ifndef BUILD_UNINSTALLER
    StrCpy $ompStart "0"
    !ifdef RUN_AFTER_FINISH
      ${IfNot} ${Silent}
        StrCpy $ompStart "1"
      ${endIf}
    !endif
    ${if} ${isForceRun}
      StrCpy $ompStart "1"
    ${endIf}
    ${if} $ompBackupMode != ""
    ${andIf} $ompStart == "1"
      ReadEnvStr $ompUserData OMP_GUI_TEST_USER_DATA_DIR
      ${if} $ompUserData == ""
        StrCpy $ompUserData "$APPDATA\ompdesk"
      ${endIf}
      StrCpy $ompMarker "$ompUserData\app-started.json"
      Delete "$ompMarker"
      ${if} ${isUpdated}
        StrCpy $ompArgs "--updated"
      ${else}
        StrCpy $ompArgs ""
      ${endIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$ompArgs"
      StrCpy $ompSeen "0"
      ${For} $ompWaited 1 120
        ${if} ${FileExists} "$ompMarker"
          StrCpy $R7 ""
          FileOpen $R8 "$ompMarker" r
          ${if} $R8 != ""
            FileRead $R8 $R7 4096
            FileClose $R8
          ${endIf}
          !insertmacro ompMarkerHas '$\"version$\":$\"${VERSION}$\"'
          ${if} $ompSeen != "1"
            !insertmacro ompMarkerHas '$\"version$\": $\"${VERSION}$\"'
          ${endIf}
          ${if} $ompSeen == "1"
            ${ExitFor}
          ${endIf}
        ${endIf}
        Sleep 1000
        ; Nothing of the new app runs any more (a shell that exits at once does not need the whole wait): ten seconds are
        ; given for the start to show up, since it goes through Explorer.
        ${if} $ompWaited > 10
          !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R4
          ${if} $R4 != 0
            ${ExitFor}
          ${endIf}
        ${endIf}
      ${Next}
      ${if} $ompSeen == "1"
        RMDir /r "$ompBackup"
      ${else}
        !insertmacro ompLog "start-failed: no app-started.json for ${VERSION} in $ompUserData (waited $ompWaited s)"
        !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
        Sleep 3000
        !insertmacro ompRestoreOldFolder "start-failed"
      ${endIf}
    ${elseIf} $ompBackupMode != ""
      RMDir /r "$ompBackup"
    ${endIf}
  !endif
!macroend

; What the app needs from the new folder: the shell (OMPdesk.exe), CEF, Node and the main it runs.
!macro ompCheckNewFolder
  !ifndef BUILD_UNINSTALLER
    !ifdef OMP_MOVE_TEST
      !insertmacro ompMoveTestBeforeCheck
      !insertmacro ompMoveTestAfterInstall
    !endif
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${andIf} ${FileExists} "$INSTDIR\libcef.dll"
    ${andIf} ${FileExists} "$INSTDIR\resources\node\node.exe"
    ${andIf} ${FileExists} "$INSTDIR\resources\app\out\main\index.js"
      !insertmacro ompStartAndVerify
    ${else}
      !insertmacro ompRestoreOldFolder "incomplete"
    ${endIf}
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
