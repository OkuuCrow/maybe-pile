; Maybe Pile NSIS customizations (included by electron-builder).
; - A page after the directory page lets the user choose Desktop / Start Menu shortcuts.
; - Uninstall asks whether to delete the user's library data (default: keep).

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var MPDesktopCheckbox
  Var MPStartMenuCheckbox
  Var MPCreateDesktop
  Var MPCreateStartMenu

!endif

; Functions are defined here (not at the top) because MUI macros only exist once the
; page section is being expanded.
!macro customPageAfterChangeDir
  Page custom MPShortcutsPageCreate MPShortcutsPageLeave

  Function MPShortcutsPageCreate
    ; Defaults (both on) are set in customInit, so going Back keeps the user's choice.
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose which shortcuts to create for Maybe Pile."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateCheckbox} 0 10u 100% 12u "Create a &Desktop shortcut"
    Pop $MPDesktopCheckbox
    ${NSD_SetState} $MPDesktopCheckbox $MPCreateDesktop
    ${NSD_CreateCheckbox} 0 30u 100% 12u "Create a &Start Menu shortcut"
    Pop $MPStartMenuCheckbox
    ${NSD_SetState} $MPStartMenuCheckbox $MPCreateStartMenu
    nsDialogs::Show
  FunctionEnd

  Function MPShortcutsPageLeave
    ${NSD_GetState} $MPDesktopCheckbox $MPCreateDesktop
    ${NSD_GetState} $MPStartMenuCheckbox $MPCreateStartMenu
  FunctionEnd
!macroend

!macro customInit
  StrCpy $MPCreateDesktop ${BST_CHECKED}
  StrCpy $MPCreateStartMenu ${BST_CHECKED}
!macroend

!macro customInstall
  ${If} $MPCreateDesktop == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\Maybe Pile.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  ${EndIf}
  ${If} $MPCreateStartMenu == ${BST_CHECKED}
    CreateShortCut "$SMPROGRAMS\Maybe Pile.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Maybe Pile.lnk"
  Delete "$SMPROGRAMS\Maybe Pile.lnk"
  ; Never prompt during an update; only on a real uninstall. Default answer keeps the data.
  ${IfNot} ${isUpdated}
    IfSilent mp_keep_data
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Maybe Pile library (items, history, artwork and backups) from this user profile?$\r$\n$\r$\nChoose No to keep it (recommended) — reinstalling will pick it up again." IDYES mp_delete_data IDNO mp_keep_data
    mp_delete_data:
      RMDir /r "$APPDATA\MaybePile"
    mp_keep_data:
  ${EndIf}
!macroend
