!define SUGRID_SERVICE_HOST "$INSTDIR\inventory\sugrid-inventory-service.exe"

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "${SUGRID_SERVICE_HOST}" 0 nsis_preinstall_done
    ExecWait '"${SUGRID_SERVICE_HOST}" stop' $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "The SUGRID inventory service could not be stopped ($0). The existing installation was left in place."
      Abort
    ${EndIf}
  nsis_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"${SUGRID_SERVICE_HOST}" install "$APPDATA\cc.sugrid.servermanager\manager.json"' $0
  ${If} $0 != 0
    ReadEnvStr $1 "ProgramData"
    StrCpy $2 "$1\SUGRID\Inventory\install-diagnostics.txt"
    IfFileExists $2 0 nsis_install_diagnostic_missing
      MessageBox MB_ICONSTOP|MB_OK "The SUGRID inventory service could not be installed or verified (installer exit code $0). The database and its backups have been preserved. A sanitized diagnostic was written to:$\r$\n$2$\r$\nPlease provide that file when reporting the issue."
      Abort
    nsis_install_diagnostic_missing:
      MessageBox MB_ICONSTOP|MB_OK "The SUGRID inventory service could not be installed or verified (installer exit code $0). The database and its backups have been preserved. No diagnostic file could be written; check the Windows Service Control Manager event log."
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "${SUGRID_SERVICE_HOST}" nsis_service_host_found nsis_service_host_missing
  nsis_service_host_missing:
    MessageBox MB_ICONSTOP|MB_OK "The SUGRID service manager is missing. Uninstall was stopped so a Windows service is not left pointing to removed files."
    Abort
  nsis_service_host_found:
    ExecWait '"${SUGRID_SERVICE_HOST}" uninstall' $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "The SUGRID inventory service could not be removed ($0). The installed files and database were preserved."
      Abort
    ${EndIf}
!macroend
