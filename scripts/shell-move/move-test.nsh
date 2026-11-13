; The test seams of scripts/shell-move (the dry run of the update from v0.127.0), built into the NEW setup of that run
; only. scripts/shell-move/build-setups.ts copies this file next to a copy of resources/installer.nsh and includes that
; copy from here; a release build never has OMP_MOVE_TEST defined (resources/installer.nsh says what it switches).

!define OMP_MOVE_TEST

; The dry run never puts a window on the person's screen: the updater starts the setup without /S (v0.127.0's "Restart &
; install" is quitAndInstall() with isSilent=false, which shows electron-builder's progress window), so the test setup
; turns itself silent as it starts (SetSilent works in .onInit only; `preInit` runs there first).
!macro preInit
  ReadEnvStr $R9 OMP_MOVE_SILENT
  StrCmp $R9 "1" 0 +2
  SetSilent silent
!macroend

; Before the new folder is checked: log what the setup saw of its environment (the old app's updater started it with its
; own environment: what it passed through is what the setup logs) and, with OMP_MOVE_FAIL=swap, make the unpack
; incomplete on purpose by deleting CEF's library, so the check fails and the old app must come back.
!macro ompMoveTestBeforeCheck
  ReadEnvStr $R9 OMP_MOVE_LOG
  ${if} $R9 != ""
    ReadEnvStr $R7 OMP_GUI_TEST_USER_DATA_DIR
    ReadEnvStr $R6 OMP_GUI_HEADLESS
    ReadEnvStr $R5 OMP_MOVE_FAIL
    FileOpen $R8 "$R9" a
    FileSeek $R8 0 END
    FileWrite $R8 "setup-env instdir=$INSTDIR backup=$ompBackupMode userData=$R7 headless=$R6 fail=$R5$\r$\n"
    FileClose $R8
  ${endif}
  ReadEnvStr $R5 OMP_MOVE_FAIL
  ${if} $R5 == "swap"
    Delete "$INSTDIR\libcef.dll"
  ${endif}
!macroend

; Before the new folder is checked, the launcher the setup starts the app through: StdUtils.ExecShellAsUser on a link goes
; through Explorer, which has none of the setup's environment, so the link is a launcher that sets the test profile and
; the isolated home first. Without both in the setup's environment the launcher starts nothing: the new app must never
; read the person's profile. It sits in %TEMP%, not in the install folder, because the same launcher starts the old app
; again when the move is undone, and the folder it lives in is then the old one. It also opens CEF's debugging port
; (OMP_MOVE_DEBUG_PORT) so the run can read the page's Local Storage, and with OMP_MOVE_FAIL=start it sets
; OMP_GUI_TEST_SHELL_FAIL_START=1, the shell's seam that exits 1 after CEF init (the new app never comes up).
!macro ompMoveTestAfterInstall
  ReadEnvStr $R9 OMP_GUI_TEST_USER_DATA_DIR
  ReadEnvStr $R7 OMP_MOVE_HOME
  ReadEnvStr $R6 OMP_MOVE_DEBUG_PORT
  ReadEnvStr $R5 OMP_MOVE_FAIL
  FileOpen $R8 "$TEMP\ompdesk-move-test.cmd" w
  ${if} $R9 == ""
  ${orIf} $R7 == ""
    FileWrite $R8 "@echo off$\r$\nexit /b 1$\r$\n"
  ${else}
    FileWrite $R8 "@echo off$\r$\nset $\"OMP_GUI_HEADLESS=1$\"$\r$\nset $\"OMP_GUI_TEST_USER_DATA_DIR=$R9$\"$\r$\nset $\"USERPROFILE=$R7$\"$\r$\nset $\"HOME=$R7$\"$\r$\nset $\"APPDATA=$R7\AppData\Roaming$\"$\r$\nset $\"LOCALAPPDATA=$R7\AppData\Local$\"$\r$\n"
    ${if} $R5 == "start"
      FileWrite $R8 "set $\"OMP_GUI_TEST_SHELL_FAIL_START=1$\"$\r$\n"
    ${endif}
    FileWrite $R8 "start $\"$\" $\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --remote-debugging-port=$R6 %*$\r$\n"
  ${endif}
  FileClose $R8
  StrCpy $launchLink "$TEMP\ompdesk-move-test.cmd"
!macroend

; The seams above come first, then the file a release builds (its copy sits beside this one).
!include "installer-under-test.nsh"
