!define SUGRID_SERVICE_HOST "$INSTDIR\service-host\sugrid-inventory-service.exe"
!define SUGRID_UPDATER "$INSTDIR\updater\sugrid-inventory-updater.exe"

!macro NSIS_HOOK_PREINSTALL
  ; Stop the updater before replacing its executable. install-host handles the
  ; inventory service and preserves its separately released runtime and data.
  IfFileExists "${SUGRID_UPDATER}" 0 nsis_preinstall_done
    ExecWait '"${SUGRID_UPDATER}" stop-service' $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "The SUGRID updater could not be stopped ($0). Existing files were preserved."
      Abort
    ${EndIf}
  nsis_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Existing operator SIDs are retained across manager upgrades.
  IfFileExists "$COMMONAPPDATA\SUGRID\Inventory\updater\operators.json" 0 nsis_new_operator
    nsExec::ExecToStack '"${SUGRID_UPDATER}" install-service'
    Pop $0
    Pop $1
    Goto nsis_operator_done
  nsis_new_operator:
    nsExec::ExecToStack '"${SUGRID_UPDATER}" install-service "$OperatorAccount"'
    Pop $0
    Pop $1
  nsis_operator_done:
  ${If} $0 != 0
    ; The preinstall hook already stopped both Windows services. Restore them
    ; before aborting so a failed manager upgrade does not take inventory offline.
    nsExec::ExecToStack '"${SUGRID_SERVICE_HOST}" start'
    Pop $2
    Pop $3
    DetailPrint "Inventory service recovery exit $2: $3"
    nsExec::ExecToStack '"${SUGRID_UPDATER}" start-service'
    Pop $4
    Pop $5
    DetailPrint "Updater service recovery exit $4: $5"
    ${If} $1 == ""
      StrCpy $1 "The updater returned no diagnostic text. Check Windows service permissions and the installer details."
    ${EndIf}
    DetailPrint "Updater installation failed (exit $0): $1"
    MessageBox MB_ICONSTOP|MB_OK "The SUGRID updater could not be installed (exit $0):$\r$\n$1$\r$\nInventory data was preserved."
    SetErrorLevel 1
    Abort
  ${EndIf}
  ExecWait '"${SUGRID_SERVICE_HOST}" install-host' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "The SUGRID inventory service host could not be installed ($0). Inventory files and the database were preserved. Check the service host diagnostic."
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "${SUGRID_UPDATER}" nsis_updater_exists 0
    MessageBox MB_ICONSTOP|MB_OK "The SUGRID updater executable is missing. Repair the manager installation before uninstalling it."
    Abort
  nsis_updater_exists:
  IfFileExists "${SUGRID_SERVICE_HOST}" nsis_host_exists 0
    MessageBox MB_ICONSTOP|MB_OK "The SUGRID service host executable is missing. Repair the manager installation before uninstalling it."
    Abort
  nsis_host_exists:
  ExecWait '"${SUGRID_UPDATER}" stop-service' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "The SUGRID updater is busy or could not be stopped ($0). Uninstall was stopped."
    Abort
  ${EndIf}
  ExecWait '"${SUGRID_SERVICE_HOST}" uninstall' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "The SUGRID inventory service could not be removed ($0). Uninstall was stopped."
    Abort
  ${EndIf}
  ExecWait '"${SUGRID_UPDATER}" uninstall-service' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "The SUGRID updater could not be removed ($0). Uninstall was stopped."
    Abort
  ${EndIf}
!macroend
