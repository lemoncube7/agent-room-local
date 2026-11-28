# UI · 모바일 · 업데이트

- **키보드 스크롤 보정 (`syncPhoneHeight`):** `index.html`과 `remote-site/page.html` 모두 `visualViewport.height`가 줄어들고 입력창(`#draft`)에 포커스가 있을 때만 메시지 목록(`#messages` / `#history`)의 `scrollTop`을 `delta`만큼 올립니다.
- **스크롤 두 가지:** 키보드가 올라올 때는 보고 있던 위치를 화면 높이 변화만큼 보정하고, 새 원격 메시지가 오면 열려 있는 대화의 맨 아래로 이동한다. PC에서 검색 중이거나 폰에서 이전 기록을 더 불러오는 중에는 읽던 위치를 유지한다. 두 동작은 따로 검증한다.
- **인라인 `<script>`가 2개:** `index.html`에는 메인 스크립트 위에 독립된 크래시 복구·`uiStamp` 자동 새로고침 스크립트가 하나 더 있다. 검사할 때는 `matchAll`로 **모두** 검사한다.
- **모바일 채팅 한도 텍스트:** 모바일에서는 에이전트 카드 대신 채팅 메시지 보낸이 이름 옆에 해당 모델의 남은 한도 텍스트를 표시합니다.
- **업데이트 (`updater.cjs`, `update.ps1`):** `local/update.log`의 인코딩(UTF-8 / EUC-KR 폴백)과 마지막 상태 줄을 `readUpdateStatus()`가 판정해 진행 중·PC 재연결 대기·새 버전 실행 확인 완료·실패를 상단 배너와 설정 창에 표시합니다.
- **업데이트 흐름:** `shutdown_for_update`는 에이전트가 일하는 중이어도 바로 허브를 재시작한다(이미 재시작 중일 때만 409). 진행 중이던 턴은 재시작 뒤 `recoverWarmTurns`·`recoverDetachedTurns`가 다시 대기열에 넣고, 대기 중이던 순위 판정은 다시 돌며, 새 메시지는 outbox에서 기다린다. `update.ps1`은 SHA-256 검증 → 임시 폴더(`agent-room-update-*`)에 백업 → 파일 교체 → 새 허브 응답 확인 순으로 가고, 실패하면 백업으로 롤백한다.
- **업데이트 도중 전원 꺼짐 복구:** 파일을 바꾸기 직전 `update.ps1`이 `local/update-in-progress.json`(백업 위치·파일 목록·업데이터 PID)을 만들고, 성공 또는 롤백이 끝나면 지운다. 허브가 시작할 때 이 파일이 남아 있고 업데이터가 죽어 있으면 `recoverInterruptedUpdate()`가 백업에서 파일을 복원하고 허브를 다시 띄운다(`AGENT_ROOM_NO_UPDATE_RECOVERY`가 있으면 건너뜀). 백업이 이미 지워졌으면 표시 파일만 지운다.

> 상위 목차: [ARCHITECTURE.md](../../ARCHITECTURE.md)
