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
    MessageBox MB_ICONSTOP|MB_OK "The SUGRID inventory service could not be installed or verified. The database and its backups have been preserved. See ProgramData\SUGRID\Inventory\logs for details."
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
