; MOSS's additions to the NSIS installer electron-builder makes (apps/moss/electron-builder.yml, nsis.include); MOSS Code's are
; installer.nsh's, and the two apps share ONE engine and ONE login start (spec §3.1: removing one app leaves the other working).
;
; The uninstaller removes login start through the daemon's own command (never through schtasks) on a real uninstall, as
; installer.nsh does, but only when MOSS Code is not installed: it is the other app's engine too, and `autostart remove` stops
; the daemon and deletes its task. A per-user install of each app lives in its own folder under %LOCALAPPDATA%\Programs.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${FileExists} "$LOCALAPPDATA\Programs\MOSS Code\MOSS Code.exe"
      nsExec::ExecToLog '"$INSTDIR\resources\daemon\moss-core.exe" autostart remove'
      Pop $0
    ${endIf}
  ${endIf}
!macroend
