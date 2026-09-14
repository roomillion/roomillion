!define ROOMILLION_ROOM_PROGID "Roomillion.room"
!define ROOMILLION_LEGACY_ZROOM_PROGID "Roomillion.zroom"

!macro customInstall
  WriteRegStr HKCU "Software\Classes\.room" "" "${ROOMILLION_ROOM_PROGID}"
  WriteRegStr HKCU "Software\Classes\${ROOMILLION_ROOM_PROGID}" "" "千万间 Roomillion 房间"
  WriteRegStr HKCU "Software\Classes\${ROOMILLION_ROOM_PROGID}" "FriendlyTypeName" "千万间 Roomillion 房间"
  WriteRegStr HKCU "Software\Classes\${ROOMILLION_ROOM_PROGID}\DefaultIcon" "" "$INSTDIR\resources\room.ico,0"
  WriteRegStr HKCU "Software\Classes\${ROOMILLION_ROOM_PROGID}\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\.zroom" "" "${ROOMILLION_LEGACY_ZROOM_PROGID}"
  WriteRegStr HKCU "Software\Classes\${ROOMILLION_LEGACY_ZROOM_PROGID}" "" "千万间旧版房间"
  WriteRegStr HKCU "Software\Classes\${ROOMILLION_LEGACY_ZROOM_PROGID}\DefaultIcon" "" "$INSTDIR\resources\room.ico,0"
  WriteRegStr HKCU "Software\Classes\${ROOMILLION_LEGACY_ZROOM_PROGID}\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Classes\.room" ""
  StrCmp $0 "${ROOMILLION_ROOM_PROGID}" 0 +2
    DeleteRegKey HKCU "Software\Classes\.room"
  DeleteRegKey HKCU "Software\Classes\${ROOMILLION_ROOM_PROGID}"
  ReadRegStr $0 HKCU "Software\Classes\.zroom" ""
  StrCmp $0 "${ROOMILLION_LEGACY_ZROOM_PROGID}" 0 +2
    DeleteRegKey HKCU "Software\Classes\.zroom"
  DeleteRegKey HKCU "Software\Classes\${ROOMILLION_LEGACY_ZROOM_PROGID}"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend
