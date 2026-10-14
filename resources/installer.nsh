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
